import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { access, lstat, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, isAbsolute, join, win32 } from 'node:path';

export const LOGIN_FLAG = '--autostart';

const appId = 'app.tokenstat.desktop';
const ownerKey = 'X-TokenStat-Owned';
const extractFlag = '--appimage-extract-and-run';
const desktopEscapes = { '\\': '\\\\', '\t': '\\t', '\n': '\\n', '\r': '\\r' };
const literalValues = { '\\': '\\', t: '\t', n: '\n', r: '\r', s: ' ' };

function escapeDesktopString(value) {
  return value.replace(/[\\\t\n\r]/g, (character) => desktopEscapes[character]);
}

function quoteExec(argument) {
  // Escape the Exec argument, then escape the resulting desktop-entry string.
  const quoted = argument.replaceAll('%', '%%').replace(/["`$\\]/g, (character) => '\\' + character);
  return '"' + escapeDesktopString(quoted) + '"';
}

async function canAccess(path, mode) {
  try {
    await access(path, mode);
    return true;
  } catch {
    return false;
  }
}

async function readEntry(path) {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.size > 32_768) return { owned: false };
    const content = await readFile(path, 'utf8');
    const fields = new Map();
    let desktopEntry = false;
    for (const line of content.split(/\r?\n/)) {
      if (line.startsWith('[')) desktopEntry = line.trim() === '[Desktop Entry]';
      const equals = line.indexOf('=');
      if (desktopEntry && equals > 0 && !line.startsWith('#')) {
        fields.set(line.slice(0, equals).trim(), line.slice(equals + 1));
      }
    }
    const enabled = fields.get('Type') === 'Application' && Boolean(fields.get('Exec'))
      && fields.get('Hidden')?.trim() !== 'true' && fields.get('X-GNOME-Autostart-enabled')?.trim() !== 'false';
    const tryExec = fields.get('TryExec')?.replace(/\\([\\tnrs])/g, (_match, key) => literalValues[key]);
    return { content, owned: fields.get(ownerKey) === 'true', enabled, tryExec };
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

function linuxAutostart(app, env, sourcePath) {
  const userHome = isAbsolute(env.HOME ?? '') ? env.HOME : homedir();
  const config = isAbsolute(env.XDG_CONFIG_HOME ?? '') ? env.XDG_CONFIG_HOME : join(userHome, '.config');
  const directory = join(config, 'autostart');
  const path = join(directory, appId);

  async function launcher() {
    const executable = env.APPIMAGE ?? process.execPath;
    if (!isAbsolute(executable) || !await canAccess(executable, constants.X_OK) || !(await stat(executable)).isFile()) {
      throw new Error('请从固定位置运行 TokenStat，然后开启开机自启。');
    }
    if (env.APPIMAGE != null) {
      const extracted = env.APPIMAGE_EXTRACT_AND_RUN != null
        || basename(env.APPDIR ?? '').startsWith('appimage_extracted_')
        || !await canAccess('/dev/fuse', constants.R_OK | constants.W_OK);
      const args = extracted ? [extractFlag, LOGIN_FLAG] : [LOGIN_FLAG];
      return { executable, args, keepExtraction: extracted };
    }
    if (app.isPackaged) return { executable, args: [LOGIN_FLAG] };
    const project = sourcePath ?? app.getAppPath();
    if (!isAbsolute(project) || !await canAccess(project, constants.R_OK)) {
      throw new Error('找不到 TokenStat 项目，请从固定目录启动后重试。');
    }
    return { executable, args: [project, LOGIN_FLAG] };
  }

  return {
    async getEnabled() {
      const entry = await readEntry(path);
      return Boolean(entry?.owned && entry.enabled && entry.tryExec && await canAccess(entry.tryExec, constants.X_OK));
    },
    async setEnabled(enabled) {
      const existing = await readEntry(path);
      if (!enabled) {
        if (existing?.owned) await rm(path, { force: true });
        return false;
      }
      if (existing && !existing.owned) throw new Error('已有同名的系统启动项，请在系统设置中检查后重试。');
      const { executable, args, keepExtraction } = await launcher();
      // Desktop entries forbid "=" in argv[0], and GLib checks argv[0] before expanding "%%".
      // Pass the path as a separate argument to a fixed shell command for either case.
      // Extract-and-run shares a cache with later launches. A second instance must not remove it.
      const command = keepExtraction || /[%=]/.test(executable)
        ? ['/bin/sh', '-c', keepExtraction ? 'export NO_CLEANUP=1; exec "$@"' : 'exec "$@"', 'tokenstat', executable, ...args]
        : [executable, ...args];
      const content = [
        '[Desktop Entry]', 'Type=Application', 'Name=TokenStat', 'Terminal=false',
        'Exec=' + command.map(quoteExec).join(' '), 'TryExec=' + escapeDesktopString(executable),
        'Hidden=false', 'X-GNOME-Autostart-enabled=true', ownerKey + '=true', '',
      ].join('\n');
      if (existing?.content === content) return true;
      await mkdir(directory, { mode: 0o700, recursive: true });
      const temporary = join(directory, '.' + appId + '.' + randomUUID());
      try {
        await writeFile(temporary, content, { mode: 0o600, flag: 'wx' });
        await rename(temporary, path);
      } finally {
        await rm(temporary, { force: true });
      }
      return true;
    },
  };
}

function windowsAutostart(app, sourcePath) {
  function options() {
    const path = process.execPath;
    if (app.isPackaged) return { path, args: [LOGIN_FLAG] };
    const project = sourcePath ?? app.getAppPath();
    if (!win32.isAbsolute(project)) throw new Error('找不到 TokenStat 项目，请从固定目录启动后重试。');
    // Electron quotes the executable and each argument when writing the Windows Run key.
    return { path, args: [project, LOGIN_FLAG] };
  }

  function getEnabled() {
    const status = app.getLoginItemSettings(options());
    const item = status.launchItems?.find(({ name, scope }) => name.toLowerCase() === appId && scope === 'user');
    return Boolean(status.openAtLogin && (item ? item.enabled : status.executableWillLaunchAtLogin !== false));
  }

  return {
    getEnabled,
    setEnabled(enabled) {
      app.setLoginItemSettings({ ...options(), name: appId, openAtLogin: enabled, enabled });
      if (getEnabled() !== enabled) throw new Error('系统未能更改开机自启，请检查 Windows 的启动应用设置。');
      return enabled;
    },
  };
}

function macAutostart(app) {
  const options = { type: 'mainAppService' };
  const status = () => app.getLoginItemSettings(options);
  return {
    getEnabled: () => Boolean(app.isPackaged && status().openAtLogin),
    setEnabled(enabled) {
      if (!app.isPackaged) {
        if (enabled) throw new Error('在 macOS 上，请使用已安装的 TokenStat 桌面版开启开机自启。');
        return false;
      }
      app.setLoginItemSettings({ ...options, openAtLogin: enabled });
      const result = status();
      if (enabled && result.status === 'requires-approval') {
        throw new Error('请在 macOS 系统设置的“登录项与扩展”中批准 TokenStat。');
      }
      if (Boolean(result.openAtLogin) !== enabled) throw new Error('系统未能更改开机自启，请检查应用签名和 macOS 登录项设置。');
      return enabled;
    },
    isLoginLaunch: () => app.isPackaged && status().wasOpenedAtLogin === true,
  };
}

export function createAutostart(app, { env = process.env, platform = process.platform, appPath } = {}) {
  const controller = platform === 'linux' ? linuxAutostart(app, env, appPath)
    : platform === 'win32' ? windowsAutostart(app, appPath)
      : platform === 'darwin' ? macAutostart(app) : null;
  let pending = Promise.resolve();
  return {
    supported: Boolean(controller && (platform !== 'darwin' || app.isPackaged)),
    async getEnabled() {
      await pending;
      return controller ? controller.getEnabled() : false;
    },
    async setEnabled(enabled) {
      if (typeof enabled !== 'boolean') throw new TypeError('开机自启的设置值应为布尔值。');
      if (!controller) {
        if (enabled) throw new Error('当前系统不支持开机自启设置。');
        return false;
      }
      const change = pending.then(() => controller.setEnabled(enabled));
      pending = change.catch(() => {});
      return change;
    },
    isLoginLaunch(argv = process.argv) {
      return argv.includes(LOGIN_FLAG) || controller?.isLoginLaunch?.() === true;
    },
  };
}

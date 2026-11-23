import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { access, lstat, mkdir, open, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, win32 } from 'node:path';

export const LOGIN_FLAG = '--autostart';

const appId = 'app.tokenstat.desktop';
const ownerKey = 'X-TokenStat-Owned';
const versionKey = 'X-TokenStat-Version';
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

function appImageArgs(keepExtraction) {
  return keepExtraction ? [extractFlag, LOGIN_FLAG] : [LOGIN_FLAG];
}

function executableLine(executable, args, keepExtraction) {
  // Keep the executable separate from the fixed shell script when escaping is needed.
  const command = keepExtraction || /[%=]/.test(executable)
    ? ['/bin/sh', '-c', keepExtraction ? 'export NO_CLEANUP=1; exec "$@"' : 'exec "$@"', 'tokenstat', executable, ...args]
    : [executable, ...args];
  return command.map(quoteExec).join(' ');
}

function stableVersion(value) {
  if (typeof value !== 'string' || !/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u.test(value)) return null;
  const parts = value.split('.').map(Number);
  return parts.every(Number.isSafeInteger) ? parts : null;
}

function compareVersions(a, b) {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

function versionFromFilename(path) {
  if (!path) return null;
  return stableVersion(/^TokenStat-(\d+\.\d+\.\d+)(?:-[A-Za-z0-9_]+)?\.AppImage$/u.exec(basename(path))?.[1]);
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
    let duplicateLaunchField = false;
    for (const line of content.split(/\r?\n/)) {
      if (line.startsWith('[')) desktopEntry = line.trim() === '[Desktop Entry]';
      const equals = line.indexOf('=');
      if (desktopEntry && equals > 0 && !line.startsWith('#')) {
        const key = line.slice(0, equals).trim();
        if (fields.has(key) && ['Exec', 'TryExec', versionKey, ownerKey].includes(key)) duplicateLaunchField = true;
        fields.set(key, line.slice(equals + 1));
      }
    }
    const enabled = fields.get('Type') === 'Application' && Boolean(fields.get('Exec'))
      && fields.get('Hidden')?.trim().toLowerCase() !== 'true'
      && fields.get('X-GNOME-Autostart-enabled')?.trim().toLowerCase() !== 'false';
    const tryExec = fields.get('TryExec')?.replace(/\\([\\tnrs])/g, (_match, key) => literalValues[key]);
    return { content, owned: !duplicateLaunchField && fields.get(ownerKey) === 'true', enabled, tryExec, exec: fields.get('Exec'), version: fields.get(versionKey) };
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

async function appImagePath(path) {
  if (typeof path !== 'string' || !isAbsolute(path)) return null;
  try {
    const absolute = await realpath(path);
    if (!(await canAccess(absolute, constants.X_OK)) || !(await stat(absolute)).isFile()) return null;
    const file = await open(absolute, 'r');
    try {
      const header = Buffer.alloc(11);
      const { bytesRead } = await file.read(header, 0, header.length, 0);
      if (bytesRead !== header.length || header.readUInt32BE(0) !== 0x7f454c46 || header.readUInt16BE(8) !== 0x4149
          || (header[10] !== 1 && header[10] !== 2)) return null;
      return absolute;
    } finally { await file.close(); }
  } catch {
    return null;
  }
}

async function chooseAppImageAlias(executable, previous) {
  const target = await realpath(executable);
  const aliases = [];
  if (previous && isAbsolute(previous)) {
    if (!versionFromFilename(previous)) aliases.push(previous);
    aliases.push(join(dirname(previous), 'TokenStat.AppImage'));
  }
  aliases.push(join(dirname(executable), 'TokenStat.AppImage'));
  for (const alias of new Set(aliases)) {
    if (await realpath(alias).catch(() => null) === target && await canAccess(alias, constants.X_OK)) return alias;
  }
  return executable;
}

function updateEntry(content, replacements) {
  const separator = content.includes('\r\n') ? '\r\n' : '\n';
  const lines = content.split(/\r?\n/);
  const updated = [];
  let desktopEntry = false;
  for (const line of lines) {
    if (line.startsWith('[')) {
      if (desktopEntry) {
        for (const [key, value] of replacements) updated.push(`${key}=${value}`);
        replacements.clear();
      }
      desktopEntry = line.trim() === '[Desktop Entry]';
    }
    const equals = line.indexOf('=');
    const key = equals > 0 && desktopEntry ? line.slice(0, equals).trim() : '';
    if (!replacements.has(key)) updated.push(line);
    else {
      updated.push(`${key}=${replacements.get(key)}`);
      replacements.delete(key);
    }
  }
  if (desktopEntry && replacements.size) {
    const entries = [...replacements].map(([key, value]) => `${key}=${value}`);
    if (updated.at(-1) === '') updated.splice(updated.length - 1, 0, ...entries);
    else updated.push(...entries, '');
  }
  return updated.join(separator);
}

function linuxAutostart(app, env, sourcePath) {
  const userHome = isAbsolute(env.HOME ?? '') ? env.HOME : homedir();
  const config = isAbsolute(env.XDG_CONFIG_HOME ?? '') ? env.XDG_CONFIG_HOME : join(userHome, '.config');
  const directory = join(config, 'autostart');
  const path = join(directory, appId);

  async function launcher(previous, verifiedPath) {
    const executable = verifiedPath ?? env.APPIMAGE ?? process.execPath;
    if (!isAbsolute(executable) || !await canAccess(executable, constants.X_OK) || !(await stat(executable)).isFile()) {
      throw new Error('请从固定位置运行 TokenStat，然后开启开机自启。');
    }
    if (env.APPIMAGE != null) {
      const extracted = env.APPIMAGE_EXTRACT_AND_RUN != null
        || basename(env.APPDIR ?? '').startsWith('appimage_extracted_')
        || !await canAccess('/dev/fuse', constants.R_OK | constants.W_OK);
      const selected = await chooseAppImageAlias(executable, previous);
      const version = app.getVersion?.();
      return { executable: selected, args: appImageArgs(extracted), keepExtraction: extracted, version: stableVersion(version) ? version : undefined };
    }
    if (app.isPackaged) return { executable, args: [LOGIN_FLAG] };
    const project = sourcePath ?? app.getAppPath();
    if (!isAbsolute(project) || !await canAccess(project, constants.R_OK)) {
      throw new Error('找不到 TokenStat 项目，请从固定目录启动后重试。');
    }
    return { executable, args: [project, LOGIN_FLAG] };
  }

  async function writeEntry(content, expected) {
    await mkdir(directory, { mode: 0o700, recursive: true });
    const temporary = join(directory, '.' + appId + '.' + randomUUID());
    try {
      await writeFile(temporary, content, { mode: 0o600, flag: 'wx' });
      const current = await readEntry(path);
      if (expected ? current?.content !== expected.content : current !== null) return false;
      await rename(temporary, path);
      return true;
    } finally {
      await rm(temporary, { force: true });
    }
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
      const { executable, args, keepExtraction, version } = await launcher(existing?.tryExec);
      const content = [
        '[Desktop Entry]', 'Type=Application', 'Name=TokenStat', 'Terminal=false',
        'Exec=' + executableLine(executable, args, keepExtraction), 'TryExec=' + escapeDesktopString(executable),
        'Hidden=false', 'X-GNOME-Autostart-enabled=true', ownerKey + '=true',
        ...(version ? [`${versionKey}=${version}`] : []), '',
      ].join('\n');
      if (existing?.content === content) return true;
      return writeEntry(content, existing);
    },
    async repairPath() {
      if (!app.isPackaged) return false;
      const version = app.getVersion?.();
      const currentVersion = stableVersion(version);
      if (!currentVersion) return false;
      const existing = await readEntry(path);
      if (!existing?.owned || !existing.enabled || !existing.tryExec || !isAbsolute(existing.tryExec)) return false;
      const ownCommand = [false, true].some((extracted) =>
        existing.exec === executableLine(existing.tryExec, appImageArgs(extracted), extracted));
      if (!ownCommand) return false;

      const current = await appImagePath(env.APPIMAGE);
      if (!current) return false;
      let previous;
      let previousMissing = false;
      try {
        previous = await realpath(existing.tryExec);
      } catch (error) {
        previousMissing = error.code === 'ENOENT' || error.code === 'ENOTDIR';
      }
      const known = [stableVersion(existing.version), versionFromFilename(existing.tryExec), versionFromFilename(previous)]
        .filter(Boolean).sort((a, b) => compareVersions(b, a));
      const order = known.length ? compareVersions(currentVersion, known[0]) : null;
      if (order !== null && order < 0) return false;
      if (previous === current) {
        if (existing.version === version) return false;
        return writeEntry(updateEntry(existing.content, new Map([[versionKey, version]])), existing);
      }
      if (order === null && !previousMissing) return false;
      if (order === 0 && await canAccess(existing.tryExec, constants.X_OK)) return false;

      const { executable, args, keepExtraction } = await launcher(existing.tryExec, current);
      return writeEntry(updateEntry(existing.content, new Map([
        ['Exec', executableLine(executable, args, keepExtraction)],
        ['TryExec', escapeDesktopString(executable)],
        [versionKey, version],
      ])), existing);
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
  function enqueue(work) {
    const change = pending.then(work);
    pending = change.catch(() => {});
    return change;
  }
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
      return enqueue(() => controller.setEnabled(enabled));
    },
    repairPath() {
      return controller?.repairPath ? enqueue(() => controller.repairPath()) : Promise.resolve(false);
    },
    isLoginLaunch(argv = process.argv) {
      return argv.includes(LOGIN_FLAG) || controller?.isLoginLaunch?.() === true;
    },
  };
}

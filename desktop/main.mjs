import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, Tray } from 'electron';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAutostart, LOGIN_FLAG } from './autostart.mjs';
import { startDesktopBackend } from './backend.mjs';

app.setName('TokenStat');
app.setAppUserModelId('app.tokenstat.desktop');

const iconPath = fileURLToPath(new URL('./icon.png', import.meta.url));
const preload = fileURLToPath(new URL('./preferences.cjs', import.meta.url));
const loginArgument = process.argv.includes(LOGIN_FLAG);
let mainWindow;
let backend;
let tray;
let autostart;
let autostartEnabled = null;
let savingAutostart = false;
let showRequested = false;
let lastPage = '#daily';
let quitting = false;
let draining = false;

function reveal(window) {
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
}

async function openWindow() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (!mainWindow.webContents.isLoadingMainFrame()) reveal(mainWindow);
    return;
  }

  const window = new BrowserWindow({
    title: 'TokenStat',
    width: 1440,
    height: 1000,
    minWidth: 365,
    minHeight: 580,
    backgroundColor: '#050506',
    icon: iconPath,
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      partition: 'tokenstat',
    },
  });

  mainWindow = window;
  const { webContents } = window;
  const origin = new URL(backend.url).origin;
  function limitNavigation(event) {
    if (URL.parse(event.url)?.origin !== origin) event.preventDefault();
  }

  webContents.on('will-frame-navigate', limitNavigation);
  webContents.on('will-redirect', limitNavigation);
  webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  webContents.session.setPermissionCheckHandler(() => false);
  webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));

  window.on('close', () => {
    const page = URL.parse(webContents.getURL());
    if (page?.origin === origin) lastPage = page.hash;
  });
  window.on('closed', () => { mainWindow = undefined; });
  window.on('session-end', shutdown);
  await window.loadURL(`${backend.url}/${lastPage}`);
  if (!quitting && !window.isDestroyed()) reveal(window);
}

function showWindow() {
  if (quitting) return;
  showRequested = true;
  if (backend) void openWindow().catch(showStartupError);
}

function updateTrayMenu() {
  if (!tray || tray.isDestroyed()) return;
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '打开 TokenStat', click: showWindow },
    {
      label: '开机自启动',
      type: 'checkbox',
      checked: autostartEnabled === true,
      enabled: autostart.supported && autostartEnabled !== null && !savingAutostart,
      click: ({ checked }) => {
        void setAutostart(checked).catch((error) => {
          dialog.showErrorBox('无法更新开机自启动', error.message);
        });
      },
    },
    { type: 'separator' },
    { label: '退出 TokenStat', click: () => app.quit() },
  ]));
}

async function getAutostart() {
  if (!savingAutostart) autostartEnabled = await autostart.getEnabled();
  updateTrayMenu();
  return autostartEnabled === true;
}

async function setAutostart(enabled) {
  if (typeof enabled !== 'boolean') throw new TypeError('开机自启动必须为开启或关闭。');
  if (savingAutostart) throw new Error('正在保存开机自启动设置。');
  savingAutostart = true;
  updateTrayMenu();
  try {
    autostartEnabled = await autostart.setEnabled(enabled);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('tokenstat:autostart-changed', autostartEnabled);
    }
    return autostartEnabled;
  } finally {
    savingAutostart = false;
    updateTrayMenu();
  }
}

function installPreferencesHandlers() {
  const matchWindow = (event) => {
    const contents = mainWindow?.webContents;
    if (!contents || event.sender !== contents || !event.senderFrame ||
        event.senderFrame !== contents.mainFrame || URL.parse(event.senderFrame.url)?.origin !== backend?.url) {
      throw new Error('此操作仅可通过 TokenStat 桌面窗口执行。');
    }
  };
  ipcMain.handle('tokenstat:autostart-get', (event) => {
    matchWindow(event);
    return getAutostart();
  });
  ipcMain.handle('tokenstat:autostart-set', (event, enabled) => {
    matchWindow(event);
    return setAutostart(enabled);
  });
  ipcMain.handle('tokenstat:sync-folder', async (event) => {
    matchWindow(event);
    const result = await dialog.showOpenDialog(mainWindow, {
      title: '选择 TokenStat 同步文件夹',
      properties: ['openDirectory', 'createDirectory'],
    });
    return result.canceled ? null : result.filePaths[0] ?? null;
  });
}

function installTray() {
  try {
    tray = new Tray(nativeImage.createFromPath(iconPath).resize({ width: 20, height: 20 }));
    tray.setToolTip('TokenStat');
    tray.on('click', showWindow);
    tray.on('double-click', showWindow);
    updateTrayMenu();
  } catch (error) {
    tray?.destroy();
    tray = undefined;
    console.error('[TokenStat] Tray unavailable:', error.message);
  }
}

function showStartupError(error) {
  dialog.showErrorBox('TokenStat 启动失败', error.message);
  app.quit();
}

function shutdown() {
  quitting = true;
  if (!backend || draining) return;
  draining = true;
  tray?.destroy();
  void backend.close().then(
    () => app.exit(0),
    (error) => {
      console.error('[TokenStat]', error);
      app.exit(1);
    },
  );
}

if (app.requestSingleInstanceLock({ loginArgument })) {
  app.on('second-instance', (_event, argv, _directory, metadata) => {
    if (!(metadata?.loginArgument ?? argv.includes(LOGIN_FLAG))) showWindow();
  });
  app.on('activate', () => { if (backend) showWindow(); });
  app.on('before-quit', () => { quitting = true; });
  app.on('window-all-closed', () => {
    if (!tray && process.platform !== 'darwin') app.quit();
  });
  app.on('will-quit', (event) => {
    if (!backend) return;
    event.preventDefault();
    shutdown();
  });
  process.once('SIGTERM', () => app.quit());
  process.once('SIGINT', () => app.quit());

  app.whenReady().then(async () => {
    autostart = createAutostart(app);
    const loginLaunch = autostart.isLoginLaunch();
    backend = await startDesktopBackend(join(app.getPath('userData'), 'data'));
    void backend.finished.catch((error) => { if (!quitting) showStartupError(error); });
    installPreferencesHandlers();
    installTray();
    void getAutostart().catch((error) => console.error('[TokenStat] Unable to read startup settings:', error.message));
    if (showRequested || !loginLaunch || !tray) await openWindow();
  }).catch(showStartupError);
} else {
  app.quit();
}

import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, Notification, safeStorage, screen, Tray } from 'electron';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAutostart, LOGIN_FLAG } from './autostart.mjs';
import { startDesktopBackend } from './backend.mjs';
import { createBudgetNotifier } from './notifications.mjs';
import { describeTray, watchTrayUsage } from './tray-usage.mjs';
import { createSyncVault } from './vault.mjs';
import { loadWindowState, restoreWindowBounds } from './window-state.mjs';

app.setName('TokenStat');
app.setAppUserModelId('app.tokenstat.desktop');

const iconPath = fileURLToPath(new URL('./icon.png', import.meta.url));
const preload = fileURLToPath(new URL('./preferences.cjs', import.meta.url));
const loginArgument = process.argv.includes(LOGIN_FLAG);
let mainWindow;
let windowState;
let backend;
let tray;
let trayMonitor;
let traySummary;
let syncingFromTray = false;
let traySyncFailed = false;
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

  const saved = windowState.state;
  const window = new BrowserWindow({
    title: 'TokenStat',
    ...restoreWindowBounds(saved, screen),
    backgroundColor: '#040508',
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
    rememberWindow(window);
  });
  window.on('closed', () => { mainWindow = undefined; });
  window.on('session-end', shutdown);
  try {
    await window.loadURL(`${backend.url}/${lastPage}`);
  } catch (error) {
    if (!quitting && !window.isDestroyed()) throw error;
  }
  if (!quitting && !window.isDestroyed()) {
    if (saved?.maximized) window.maximize();
    reveal(window);
  }
}

function rememberWindow(window) {
  if (window && !window.isDestroyed()) windowState?.remember(window.getNormalBounds(), window.isMaximized());
}

function showWindow() {
  if (quitting) return;
  showRequested = true;
  if (backend) void openWindow().catch(showStartupError);
}

function updateTrayMenu() {
  if (!tray || tray.isDestroyed()) return;
  const labels = describeTray(traySummary);
  tray.setToolTip(`TokenStat · ${labels.usageLine} · ${labels.costLine}`);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: labels.usageLine, enabled: false },
    { label: labels.costLine, enabled: false },
    { type: 'separator' },
    { label: labels.launch, click: showWindow },
    {
      label: syncingFromTray ? labels.syncing : traySyncFailed ? labels.syncError : labels.sync,
      enabled: traySummary?.syncEnabled === true && !syncingFromTray,
      click: () => { void syncFromTray(); },
    },
    {
      label: labels.autostart,
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
    { label: labels.quit, click: () => app.quit() },
  ]));
}

async function syncFromTray() {
  if (syncingFromTray || !traySummary?.syncEnabled || !trayMonitor) return;
  syncingFromTray = true;
  traySyncFailed = false;
  updateTrayMenu();
  try {
    traySyncFailed = !(await trayMonitor.syncNow());
  } finally {
    syncingFromTray = false;
    updateTrayMenu();
  }
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
    let image;
    if (process.platform === 'darwin') {
      image = nativeImage.createFromPath(fileURLToPath(new URL('./trayTemplate.png', import.meta.url)));
      image.setTemplateImage(true);
    } else {
      image = nativeImage.createFromPath(iconPath).resize({ width: 20, height: 20 });
    }
    tray = new Tray(image);
    tray.on('click', showWindow);
    tray.on('double-click', showWindow);
    updateTrayMenu();
    trayMonitor = watchTrayUsage(backend.url, (summary) => {
      if (JSON.stringify(summary) === JSON.stringify(traySummary)) return;
      traySummary = summary;
      updateTrayMenu();
    });
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
  rememberWindow(mainWindow);
  trayMonitor?.close();
  tray?.destroy();
  void Promise.allSettled([backend.close(), windowState?.flush()]).then(([closed]) => {
    if (closed.status === 'rejected') console.error('[TokenStat]', closed.reason);
    app.exit(closed.status === 'fulfilled' ? 0 : 1);
  });
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
    const userData = app.getPath('userData');
    windowState = await loadWindowState(userData);
    backend = await startDesktopBackend(join(userData, 'data'), {
      syncVault: createSyncVault(safeStorage),
      notifyBudget: createBudgetNotifier(Notification, { icon: iconPath, onClick: showWindow }),
    });
    void backend.finished.catch((error) => { if (!quitting) showStartupError(error); });
    installPreferencesHandlers();
    installTray();
    void getAutostart().catch((error) => console.error('[TokenStat] Unable to read startup settings:', error.message));
    if (showRequested || !loginLaunch || !tray) await openWindow();
  }).catch(showStartupError);
} else {
  app.quit();
}

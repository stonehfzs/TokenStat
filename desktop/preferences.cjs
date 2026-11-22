const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('tokenstatDesktop', {
  getAutostart: () => ipcRenderer.invoke('tokenstat:autostart-get'),
  setAutostart: (enabled) => ipcRenderer.invoke('tokenstat:autostart-set', enabled),
  chooseSyncFolder: () => ipcRenderer.invoke('tokenstat:sync-folder'),
  onAutostartChanged: (callback) => {
    const listener = (_event, enabled) => callback(enabled);
    ipcRenderer.on('tokenstat:autostart-changed', listener);
    return () => ipcRenderer.removeListener('tokenstat:autostart-changed', listener);
  },
});

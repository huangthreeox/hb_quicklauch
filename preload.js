const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  getConfig: () => ipcRenderer.invoke('get-config'),
  saveConfig: (config) => ipcRenderer.invoke('save-config', config),
  scanFolder: (folderPath) => ipcRenderer.invoke('scan-folder', folderPath),
  startApp: (appPath, args) => ipcRenderer.invoke('start-app', appPath, args),
  stopApp: (appPath) => ipcRenderer.invoke('stop-app', appPath),
  startAll: (config) => ipcRenderer.invoke('start-all', config),
  stopAll: () => ipcRenderer.invoke('stop-all'),
  openFolderDialog: () => ipcRenderer.invoke('open-folder-dialog'),
  openConfigFile: () => ipcRenderer.invoke('open-config-file'),
  exportConfigFile: (config) => ipcRenderer.invoke('export-config-file', config),
  getProfiles: () => ipcRenderer.invoke('get-profiles'),
  switchProfile: (name) => ipcRenderer.invoke('switch-profile', name),
  createProfile: (name, baseConfig) => ipcRenderer.invoke('create-profile', name, baseConfig),
  deleteProfile: (name) => ipcRenderer.invoke('delete-profile', name),
  renameProfile: (oldName, newName) => ipcRenderer.invoke('rename-profile', oldName, newName),
  cloneProfile: (sourceName, newName) => ipcRenderer.invoke('clone-profile', sourceName, newName),
  exportCsv: (records) => ipcRenderer.invoke('export-csv', records),
  getStatsHistory: () => ipcRenderer.invoke('get-stats-history'),
  clearStatsHistory: () => ipcRenderer.invoke('clear-stats-history'),
  toggleRecording: (enabled) => ipcRenderer.invoke('toggle-recording', enabled),
  openLogDir: () => ipcRenderer.invoke('open-log-dir'),
  getRecordingState: () => ipcRenderer.invoke('get-recording-state'),
  onAppStatusChanged: (callback) => {
    ipcRenderer.on('app-status-changed', (event, data) => callback(data));
  },
  onStatsUpdated: (callback) => {
    ipcRenderer.on('stats-updated', (event, data) => callback(data));
  }
});

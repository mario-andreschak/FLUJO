const { contextBridge, ipcRenderer } = require('electron');

// Expose protected methods that allow the renderer process to use
// the ipcRenderer without exposing the entire object
contextBridge.exposeInMainWorld(
  'electron',
  {
    // App info
    getAppPath: () => ipcRenderer.invoke('get-app-path'),
    getAppVersion: () => ipcRenderer.invoke('get-app-version'),
    
    // Network mode
    setNetworkMode: (enabled) => ipcRenderer.invoke('set-network-mode', enabled),
    
    // System information
    platform: process.platform,
    
    // Check if running in Electron
    isElectron: true
  }
);

'use strict';

const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('watermarkLab', {
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (settings) => ipcRenderer.invoke('settings:save', settings),
  getQueueRecords: () => ipcRenderer.invoke('queue:get'),
  saveQueueRecords: (records) => ipcRenderer.invoke('queue:save', records),
  openLogin: () => ipcRenderer.invoke('login:open'),
  logout: () => ipcRenderer.invoke('login:logout'),
  getLoginStatus: () => ipcRenderer.invoke('login:status'),
  selectImages: () => ipcRenderer.invoke('files:select'),
  validatePaths: (paths) => ipcRenderer.invoke('files:validate', paths),
  getImagePreview: (targetPath, maxSize) => ipcRenderer.invoke('image:preview', targetPath, maxSize),
  openAdvancedSettings: () => ipcRenderer.invoke('advanced:open'),
  onSettingsUpdated: (callback) => {
    const listener = (_event, value) => callback(value);
    ipcRenderer.on('settings:updated', listener);
    return () => ipcRenderer.removeListener('settings:updated', listener);
  },
  openPreviewWindow: (targetPath) => ipcRenderer.invoke('image:open-preview', targetPath),
  openManualWindow: (payload) => ipcRenderer.invoke('manual:open', payload),
  pathForFile: (file) => webUtils.getPathForFile(file),
  chooseOutput: (current) => ipcRenderer.invoke('output:select', current),
  startBatch: (payload) => ipcRenderer.invoke('batch:start', payload),
  startManualEdit: (payload) => ipcRenderer.invoke('manual:start', payload),
  cancelBatch: () => ipcRenderer.invoke('batch:cancel'),
  openPath: (targetPath) => ipcRenderer.invoke('path:open', targetPath),
  onLoginStatus: (callback) => {
    const listener = (_event, value) => callback(value);
    ipcRenderer.on('login:status', listener);
    return () => ipcRenderer.removeListener('login:status', listener);
  },
  onBatchEvent: (callback) => {
    const listener = (_event, value) => callback(value);
    ipcRenderer.on('batch:event', listener);
    return () => ipcRenderer.removeListener('batch:event', listener);
  },
  onManualSubmitted: (callback) => {
    const listener = (_event, value) => callback(value);
    ipcRenderer.on('manual:submitted', listener);
    return () => ipcRenderer.removeListener('manual:submitted', listener);
  },
  onAppEvent: (callback) => {
    const listener = (_event, value) => callback(value);
    ipcRenderer.on('app:event', listener);
    return () => ipcRenderer.removeListener('app:event', listener);
  }
});

'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('previewBridge', {
  getSettings: () => ipcRenderer.invoke('settings:get'),
  onLoad: (callback) => {
    const listener = (_event, value) => callback(value);
    ipcRenderer.on('preview:load', listener);
    return () => ipcRenderer.removeListener('preview:load', listener);
  }
});

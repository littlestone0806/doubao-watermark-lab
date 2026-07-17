'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('manualBridge', {
  onLoad: (callback) => {
    const listener = (_event, value) => callback(value);
    ipcRenderer.on('manual:load', listener);
    return () => ipcRenderer.removeListener('manual:load', listener);
  },
  getImagePreview: (targetPath) => ipcRenderer.invoke('image:preview', targetPath),
  submit: (payload) => ipcRenderer.send('manual:submit', payload),
  close: () => ipcRenderer.send('manual:close')
});

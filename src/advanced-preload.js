'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('advancedBridge', {
  getSettings: () => ipcRenderer.invoke('settings:get'),
  save: (value) => ipcRenderer.invoke('advanced:save', value),
  close: () => ipcRenderer.send('advanced:close')
});

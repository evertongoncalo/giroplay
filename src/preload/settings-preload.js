'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('giroSettings', {
  get: () => ipcRenderer.invoke('settings:get'),
  save: (patch) => ipcRenderer.invoke('settings:save', patch),
  pickFolder: () => ipcRenderer.invoke('settings:pick-folder'),
  action: (name) => ipcRenderer.invoke('settings:action', name),
});

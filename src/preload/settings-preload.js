'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('giroSettings', {
  get: () => ipcRenderer.invoke('settings:get'),
  save: (patch) => ipcRenderer.invoke('settings:save', patch),
  play: (patch) => ipcRenderer.invoke('settings:play', patch),
  stop: () => ipcRenderer.invoke('settings:stop'),
  pickFolder: () => ipcRenderer.invoke('settings:pick-folder'),
  action: (name) => ipcRenderer.invoke('settings:action', name),
});

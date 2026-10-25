'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('giro', {
  next: (afterId) => ipcRenderer.invoke('player:next', afterId),
  config: () => ipcRenderer.invoke('player:config'),
  inUse: (ids) => ipcRenderer.send('player:inuse', ids),
  started: (info) => ipcRenderer.send('player:started', info),
  played: (record) => ipcRenderer.send('player:played', record),
  error: (id, message) => ipcRenderer.send('player:error', id, message),
  log: (level, message) => ipcRenderer.send('player:log', level, message),
  onPlaylistChanged: (cb) => ipcRenderer.on('playlist:changed', () => cb()),
  onConfigChanged: (cb) => ipcRenderer.on('config:changed', (_event, cfg) => cb(cfg)),
});

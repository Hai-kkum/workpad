'use strict';
// 렌더러에 노출하는 안전한 API. contextIsolation + sandbox 환경에서 ipcRenderer만 사용.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // 카드
  getCard: (id) => ipcRenderer.invoke('card:get', id),
  updateCard: (id, patch) => ipcRenderer.invoke('card:update', id, patch),
  collapse: (id, collapsed) => ipcRenderer.invoke('card:collapse', id, collapsed),
  hideCard: (id) => ipcRenderer.invoke('card:hide', id),
  deleteCard: (id) => ipcRenderer.invoke('card:close', id),
  dragStart: (id) => ipcRenderer.send('card:dragStart', id),
  dragMove: (id, dx, dy) => ipcRenderer.send('card:dragMove', id, dx, dy),
  dragEnd: (id) => ipcRenderer.send('card:dragEnd', id),
  // 클립보드
  copyText: (text) => ipcRenderer.invoke('clipboard:write', text),
  readClipboard: () => ipcRenderer.invoke('clipboard:read'),
  // 설정 / 상태
  getSettings: () => ipcRenderer.invoke('settings:get'),
  updateSettings: (patch) => ipcRenderer.invoke('settings:update', patch),
  status: () => ipcRenderer.invoke('app:status'),
  getEnv: () => ipcRenderer.invoke('env:get'),
  search: (q) => ipcRenderer.invoke('search', q),
  // 패널
  listCards: () => ipcRenderer.invoke('panel:listCards'),
  createCard: (type) => ipcRenderer.invoke('panel:createCard', type),
  focusCard: (id) => ipcRenderer.invoke('panel:focusCard', id),
  showAll: () => ipcRenderer.invoke('panel:showAll'),
  hideAll: () => ipcRenderer.invoke('panel:hideAll'),
  toggleAll: () => ipcRenderer.invoke('panel:toggleAll'),
  // 프리셋
  listPresets: () => ipcRenderer.invoke('preset:list'),
  savePreset: (name) => ipcRenderer.invoke('preset:save', name),
  applyPreset: (name) => ipcRenderer.invoke('preset:apply', name),
});

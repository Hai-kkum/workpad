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
  readClipboardHTML: () => ipcRenderer.invoke('clipboard:readHTML'),
  // 설정 / 상태
  getSettings: () => ipcRenderer.invoke('settings:get'),
  updateSettings: (patch) => ipcRenderer.invoke('settings:update', patch),
  status: () => ipcRenderer.invoke('app:status'),
  getEnv: () => ipcRenderer.invoke('env:get'),
  exportData: (pass) => ipcRenderer.invoke('data:export', pass),
  importData: (pass) => ipcRenderer.invoke('data:import', pass),
  piiScan: () => ipcRenderer.invoke('data:piiScan'),
  onFlash: (cb) => ipcRenderer.on('card:flash', () => cb()), // 카드 렌더러: 패널 더블클릭 신호 수신
  search: (q) => ipcRenderer.invoke('search', q),
  // 패널 헤더 제어(프레임리스)
  panelPin: () => ipcRenderer.invoke('panel:pin'),
  panelCollapse: (collapsed) => ipcRenderer.invoke('panel:collapse', collapsed),
  panelDragStart: () => ipcRenderer.send('panel:dragStart'),
  panelDragMove: (dx, dy) => ipcRenderer.send('panel:dragMove', dx, dy),
  panelDragEnd: () => ipcRenderer.send('panel:dragEnd'),
  panelMinimize: () => ipcRenderer.invoke('panel:minimize'),
  panelClose: () => ipcRenderer.invoke('panel:close'),
  panelState: () => ipcRenderer.invoke('panel:getState'),
  // 패널
  listCards: () => ipcRenderer.invoke('panel:listCards'),
  createCard: (type, section) => ipcRenderer.invoke('panel:createCard', type, section),
  focusCard: (id) => ipcRenderer.invoke('panel:focusCard', id),
  flashCard: (id) => ipcRenderer.invoke('panel:flashCard', id),
  showAll: () => ipcRenderer.invoke('panel:showAll'),
  hideAll: () => ipcRenderer.invoke('panel:hideAll'),
  showSection: (name) => ipcRenderer.invoke('panel:showSection', name),
  onPanelRefresh: (cb) => ipcRenderer.on('panel:refresh', () => cb()),
  // 프리셋
  listPresets: () => ipcRenderer.invoke('preset:list'),
  savePreset: (name) => ipcRenderer.invoke('preset:save', name),
  applyPreset: (name) => ipcRenderer.invoke('preset:apply', name),
});

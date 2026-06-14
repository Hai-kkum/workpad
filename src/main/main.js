'use strict';
// 메인 프로세스: 앱 수명주기 · 카드 창 관리 · IPC · 전역 단축키.
// 카드 = 프레임 없는 독립 BrowserWindow. Alt-Tab/작업표시줄 숨김은 숨은 "소유 창(owner)"의
// 자식(parent)으로 만들어 처리(Windows에서 소유된 창은 Alt-Tab 목록에 안 나옴) — 네이티브 코드 불필요.

const { app, BrowserWindow, ipcMain, clipboard, globalShortcut } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const store = require('./store');

const COLLAPSED_H = 30;
const PRELOAD = path.join(__dirname, '..', 'preload', 'preload.js');
const CARD_HTML = path.join(__dirname, '..', 'renderer', 'card.html');
const PANEL_HTML = path.join(__dirname, '..', 'renderer', 'panel.html');
const isDev = process.argv.includes('--dev');

// GUI 앱은 stderr가 콘솔에 안 붙으므로 진단은 파일 로그로 남긴다.
function logf(msg) {
  try { fs.appendFileSync(path.join(app.getPath('userData'), 'workpad-debug.log'), `[${new Date().toISOString()}] ${msg}\n`); } catch (_) {}
}
process.on('uncaughtException', (e) => logf('uncaughtException: ' + (e && e.stack || e)));
process.on('unhandledRejection', (e) => logf('unhandledRejection: ' + (e && e.stack || e)));

let ownerWin = null;   // 숨은 소유 창 (Alt-Tab 숨김용)
let panelWin = null;   // 컨트롤 패널
const cards = new Map(); // id -> BrowserWindow

function debounce(fn, ms) {
  let t = null;
  return (...a) => { if (t) clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}
function newId() { return crypto.randomUUID(); }

// ready-to-show / did-finish-load / 타임아웃 중 먼저 오는 시점에 표시. 렌더러 진단 로그도 수집.
function wireWindow(win, shouldShow, label) {
  let shown = false;
  const doShow = (why) => {
    if (shown || win.isDestroyed()) return;
    shown = true;
    if (shouldShow) { win.show(); logf(`${label}: show (${why})`); }
  };
  win.once('ready-to-show', () => { logf(`${label}: ready-to-show`); doShow('ready-to-show'); });
  win.webContents.on('did-finish-load', () => { logf(`${label}: did-finish-load`); doShow('did-finish-load'); });
  win.webContents.on('did-fail-load', (_e, code, desc, url) => logf(`${label}: did-fail-load ${code} ${desc} ${url}`));
  win.webContents.on('preload-error', (_e, p, err) => logf(`${label}: preload-error ${p} ${err && err.stack || err}`));
  win.webContents.on('console-message', (_e, level, message, line, src) => logf(`${label}: console[${level}] ${message} (${src}:${line})`));
  setTimeout(() => doShow('timeout'), 1500);
}

function defaultCard(type) {
  const n = cards.size;
  const x = 90 + (n % 6) * 28;
  const y = 90 + (n % 6) * 28;
  const base = {
    id: newId(), type, alwaysOnTop: false, collapsed: false, visible: true,
    createdAt: Date.now(), updatedAt: Date.now(),
    format: { enabled: false, template: '[{날짜단축} {시간}] {내용}', timeBasis: 'now' },
  };
  if (type === 'memo') {
    return { ...base, title: '메모', bounds: { x, y, width: 260, height: 200 }, content: { text: '' } };
  }
  if (type === 'callmemo') {
    return {
      ...base, title: '콜 메모', ttlDays: 30,
      bounds: { x, y, width: 300, height: 260 },
      format: { enabled: true, template: '[{시간}] {내용}', timeBasis: 'now' },
      lines: [],
    };
  }
  return {
    ...base, title: '상용구', bounds: { x, y, width: 280, height: 220 },
    lines: [{ text: '본인 확인 감사합니다. 바로 확인해 드리겠습니다.' }, { text: '추가로 궁금하신 점은 없으실까요?' }],
  };
}

function createCardWindow(card, show) {
  const collapsed = !!card.collapsed;
  const win = new BrowserWindow({
    x: card.bounds.x, y: card.bounds.y,
    width: card.bounds.width,
    height: collapsed ? COLLAPSED_H : card.bounds.height,
    minWidth: 160, minHeight: COLLAPSED_H,
    frame: false, skipTaskbar: true, parent: ownerWin,
    alwaysOnTop: !!card.alwaysOnTop, show: false,
    backgroundColor: '#ffffff',
    webPreferences: { preload: PRELOAD, contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  win._collapsed = collapsed;
  if (collapsed) win._fullHeight = card.bounds.height;
  if (card.alwaysOnTop) win.setAlwaysOnTop(true);

  wireWindow(win, show && card.visible !== false, `card ${card.type}`);
  win.loadFile(CARD_HTML, { query: { id: card.id } });

  const persist = debounce(() => {
    if (win.isDestroyed() || win._collapsed) return;
    store.updateBounds(card.id, win.getBounds());
  }, 250);
  win.on('move', persist);
  win.on('resize', persist);
  win.on('closed', () => cards.delete(card.id));

  cards.set(card.id, win);
  return win;
}

function toggleAll() {
  const anyVisible = [...cards.values()].some((w) => !w.isDestroyed() && w.isVisible());
  for (const [id, win] of cards) {
    if (win.isDestroyed()) continue;
    if (anyVisible) { win.hide(); store.setVisible(id, false); }
    else { win.show(); store.setVisible(id, true); }
  }
}

function applyHotkey(accel) {
  globalShortcut.unregisterAll();
  if (!accel) return;
  try { globalShortcut.register(accel, toggleAll); } catch (_) {}
}

function createPanel() {
  panelWin = new BrowserWindow({
    width: 300, height: 440, title: 'Workpad', show: false,
    backgroundColor: '#ffffff',
    webPreferences: { preload: PRELOAD, contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  wireWindow(panelWin, true, 'panel');
  panelWin.loadFile(PANEL_HTML);
  if (isDev) panelWin.webContents.openDevTools({ mode: 'detach' });
  panelWin.on('closed', () => { panelWin = null; app.quit(); });
}

function registerIpc() {
  ipcMain.handle('card:get', (_e, id) => store.getCard(id));
  ipcMain.handle('card:update', (_e, id, patch) => {
    const c = store.updateCard(id, patch);
    const win = cards.get(id);
    if (win && !win.isDestroyed() && Object.prototype.hasOwnProperty.call(patch, 'alwaysOnTop')) win.setAlwaysOnTop(!!patch.alwaysOnTop);
    return c;
  });
  ipcMain.handle('card:collapse', (_e, id, collapsed) => {
    const win = cards.get(id);
    if (!win || win.isDestroyed()) return;
    if (collapsed) { win._collapsed = true; win._fullHeight = win.getBounds().height; win.setResizable(false); win.setBounds({ height: COLLAPSED_H }); }
    else { win._collapsed = false; win.setResizable(true); if (win._fullHeight) win.setBounds({ height: win._fullHeight }); }
    store.updateCard(id, { collapsed });
  });
  ipcMain.handle('card:close', (_e, id) => {
    const win = cards.get(id);
    store.removeCard(id);
    if (win && !win.isDestroyed()) win.close();
  });
  ipcMain.handle('clipboard:write', (_e, text) => { clipboard.writeText(String(text ?? '')); return true; });
  ipcMain.handle('clipboard:read', () => clipboard.readText());
  ipcMain.handle('settings:get', () => store.getSettings());
  ipcMain.handle('settings:update', (_e, patch) => {
    const s = store.updateSettings(patch);
    if (Object.prototype.hasOwnProperty.call(patch, 'hotkeyHideAll')) applyHotkey(s.hotkeyHideAll);
    return s;
  });
  ipcMain.handle('app:status', () => ({ keyProtected: store.isKeyProtected(), cardCount: cards.size }));
  ipcMain.handle('panel:listCards', () => store.listCards());
  ipcMain.handle('panel:createCard', (_e, type) => {
    const card = defaultCard(type === 'memo' || type === 'callmemo' ? type : 'snippet');
    store.addCard(card);
    createCardWindow(card, true);
    return card.id;
  });
  ipcMain.handle('panel:focusCard', (_e, id) => {
    const win = cards.get(id);
    if (win && !win.isDestroyed()) { store.setVisible(id, true); win.show(); win.focus(); }
  });
  ipcMain.handle('panel:showAll', () => { for (const [id, win] of cards) if (!win.isDestroyed()) { win.show(); store.setVisible(id, true); } });
  ipcMain.handle('panel:hideAll', () => { for (const [id, win] of cards) if (!win.isDestroyed()) { win.hide(); store.setVisible(id, false); } });
  ipcMain.handle('panel:toggleAll', () => toggleAll());
  ipcMain.handle('preset:list', () => store.listPresets());
  ipcMain.handle('preset:save', (_e, name) => {
    const snap = {};
    for (const [id, win] of cards) if (!win.isDestroyed()) snap[id] = { bounds: win.getBounds(), visible: win.isVisible() };
    store.savePreset(name, snap);
    return store.listPresets();
  });
  ipcMain.handle('preset:apply', (_e, name) => {
    const snap = store.getPreset(name);
    if (!snap) return false;
    for (const [id, conf] of Object.entries(snap)) {
      const win = cards.get(id);
      if (!win || win.isDestroyed()) continue;
      win.setBounds(conf.bounds);
      if (conf.visible) { win.show(); store.setVisible(id, true); } else { win.hide(); store.setVisible(id, false); }
    }
    return true;
  });
}

app.whenReady().then(() => {
  try {
    logf('app ready: start');
    store.init();
    logf('store init ok, keyProtected=' + store.isKeyProtected());

    app.on('web-contents-created', (_e, wc) => {
      wc.setWindowOpenHandler(() => ({ action: 'deny' }));
      wc.on('will-navigate', (e) => e.preventDefault());
    });

    ownerWin = new BrowserWindow({ width: 100, height: 100, show: false, skipTaskbar: true });
    registerIpc();
    createPanel();

    const saved = Object.values(store.getState().cards);
    logf('restoring cards: ' + saved.length);
    if (saved.length === 0) {
      const sample = defaultCard('snippet');
      store.addCard(sample);
      createCardWindow(sample, true);
    } else {
      for (const c of saved) createCardWindow(c, c.visible !== false);
    }

    applyHotkey(store.getSettings().hotkeyHideAll);
    logf('startup complete, windows=' + (cards.size + 1));
  } catch (e) {
    logf('whenReady ERROR: ' + (e && e.stack || e));
  }
});

app.on('will-quit', () => { globalShortcut.unregisterAll(); store.flush(); });
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });

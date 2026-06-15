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

// 단일 인스턴스 잠금: 아이콘/런처로 중복 실행 시 같은 암호화 파일에 두 인스턴스가 쓰는 손상 방지.
const isPrimary = app.requestSingleInstanceLock();
if (!isPrimary) app.quit();
else app.on('second-instance', () => { if (panelWin && !panelWin.isDestroyed()) { if (panelWin.isMinimized()) panelWin.restore(); panelWin.show(); panelWin.focus(); } });

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
  // 보안: 렌더러 콘솔 메시지에는 카드 내용(PII)이 섞일 수 있어 개발 모드에서만 파일 기록.
  if (isDev) win.webContents.on('console-message', (_e, level, message, line, src) => logf(`${label}: console[${level}] ${message} (${src}:${line})`));
  setTimeout(() => doShow('timeout'), 1500);
}

function defaultCard(type) {
  const n = cards.size;
  const x = 90 + (n % 6) * 28;
  const y = 90 + (n % 6) * 28;
  const base = {
    id: newId(), type, alwaysOnTop: false, collapsed: false, visible: true,
    createdAt: Date.now(), updatedAt: Date.now(),
    format: { enabled: false, template: '[{날짜단축} {시간}] {내용}' },
  };
  if (type === 'memo') {
    return { ...base, title: '메모', bounds: { x, y, width: 260, height: 200 }, content: { text: '' } };
  }
  if (type === 'callmemo') {
    return {
      ...base, title: '콜 메모', ttlDays: 30,
      bounds: { x, y, width: 300, height: 260 },
      format: { enabled: true, template: '[{시간}] {내용}' },
      lines: [],
    };
  }
  if (type === 'table') {
    return { ...base, title: '표', bounds: { x, y, width: 320, height: 240 }, rows: [['항목', '값'], ['', '']] };
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
    maximizable: false, fullscreenable: false,
    backgroundColor: '#ffffff',
    webPreferences: { preload: PRELOAD, contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  win._collapsed = collapsed;
  if (collapsed) win.setResizable(false); // 접힌 채 복원돼도 리사이즈 불가(H-2)
  if (card.alwaysOnTop) win.setAlwaysOnTop(true);

  wireWindow(win, show && card.visible !== false, `card ${card.type}`);
  win.loadFile(CARD_HTML, { query: { id: card.id } });

  // 위치는 접힘 여부와 무관하게 저장. 높이는 펼친 상태에서만 저장(접힘 높이 30이 펼침 높이를 덮어쓰지 않게).
  const persist = debounce(() => {
    if (win.isDestroyed()) return;
    const b = win.getBounds();
    const prev = store.getCard(card.id);
    const height = win._collapsed && prev && prev.bounds ? prev.bounds.height : b.height;
    store.updateBounds(card.id, { x: b.x, y: b.y, width: b.width, height });
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
    if (collapsed) {
      const b = win.getBounds(); // 현재(펼친) 높이를 즉시 저장 → debounce 경쟁 없이 확정
      store.updateBounds(id, { x: b.x, y: b.y, width: b.width, height: b.height });
      win._collapsed = true; win.setResizable(false); win.setBounds({ height: COLLAPSED_H });
    } else {
      win._collapsed = false; win.setResizable(true);
      const c = store.getCard(id);
      if (c && c.bounds && c.bounds.height) win.setBounds({ height: c.bounds.height });
    }
    store.updateCard(id, { collapsed });
  });
  ipcMain.handle('card:close', (_e, id) => { // 영구 삭제(패널의 휴지통에서 확인 후 호출)
    const win = cards.get(id);
    store.removeCard(id);
    if (win && !win.isDestroyed()) win.close();
  });
  ipcMain.handle('card:hide', (_e, id) => { // 카드 X = 숨김(데이터 유지, 복구 가능 — B-8)
    const win = cards.get(id);
    if (win && !win.isDestroyed()) { win.hide(); store.setVisible(id, false); }
  });
  // 헤더 수동 드래그(메인 측 기준 캡처). dragStart에서 크기·위치 1회 캡처 → dragMove는 그 기준에 델타만 적용
  // (크기 고정 → 창 커짐 방지, 렌더러 비동기 레이스 없음). 입력 검증 포함. dragEnd에서 최종 위치 즉시 저장.
  ipcMain.on('card:dragStart', (_e, id) => { const w = cards.get(id); if (w && !w.isDestroyed()) w._dragBase = w.getBounds(); });
  ipcMain.on('card:dragMove', (_e, id, dx, dy) => {
    const w = cards.get(id);
    if (!w || w.isDestroyed() || !w._dragBase) return;
    if (!Number.isFinite(dx) || !Number.isFinite(dy)) return;
    const b = w._dragBase;
    w.setBounds({ x: Math.round(b.x + dx), y: Math.round(b.y + dy), width: b.width, height: b.height });
  });
  ipcMain.on('card:dragEnd', (_e, id) => {
    const w = cards.get(id);
    if (!w || w.isDestroyed()) return;
    w._dragBase = null;
    const b = w.getBounds();
    const prev = store.getCard(id);
    const height = w._collapsed && prev && prev.bounds ? prev.bounds.height : b.height;
    store.updateBounds(id, { x: b.x, y: b.y, width: b.width, height });
  });
  ipcMain.handle('clipboard:write', (_e, text) => { clipboard.writeText(String(text ?? '')); return true; });
  ipcMain.handle('clipboard:read', () => clipboard.readText());
  ipcMain.handle('settings:get', () => store.getSettings());
  ipcMain.handle('settings:update', (_e, patch) => {
    const s = store.updateSettings(patch);
    if (Object.prototype.hasOwnProperty.call(patch, 'hotkeyHideAll')) applyHotkey(s.hotkeyHideAll);
    return s;
  });
  ipcMain.handle('app:status', () => ({ keyProtected: store.isKeyProtected(), cardCount: cards.size, loadError: store.getLoadError() }));
  ipcMain.handle('search', (_e, q) => {
    q = String(q || '').trim().toLowerCase();
    if (!q) return [];
    const ctx = (t) => {
      const i = t.toLowerCase().indexOf(q);
      if (i < 0) return null;
      const a = Math.max(0, i - 20);
      return (a > 0 ? '…' : '') + t.slice(a, i + q.length + 40).trim() + (i + q.length + 40 < t.length ? '…' : '');
    };
    const out = [];
    for (const c of Object.values(store.getState().cards)) {
      const fields = [];
      if (c.title) fields.push(c.title);
      if (c.content && c.content.text) fields.push(c.content.text);
      if (Array.isArray(c.lines)) c.lines.forEach((ln) => fields.push(ln.text || ''));
      if (Array.isArray(c.rows)) c.rows.forEach((r) => r.forEach((cell) => fields.push(cell || '')));
      const snips = [];
      for (const f of fields) { const s = ctx(f); if (s) { snips.push(s); if (snips.length >= 2) break; } }
      if (snips.length) out.push({ id: c.id, title: c.title || '(제목 없음)', type: c.type, snippet: snips.join('  ·  ') });
    }
    return out;
  });
  ipcMain.handle('panel:listCards', () => store.listCards());
  ipcMain.handle('panel:createCard', (_e, type) => {
    const card = defaultCard(['memo', 'callmemo', 'table'].includes(type) ? type : 'snippet');
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
    for (const [id, win] of cards) {
      if (win.isDestroyed()) continue;
      const b = win.getBounds();
      const c = store.getCard(id);
      const height = win._collapsed && c && c.bounds ? c.bounds.height : b.height; // 접힘이면 펼침 높이 사용
      snap[id] = { bounds: { x: b.x, y: b.y, width: b.width, height }, visible: win.isVisible(), collapsed: !!win._collapsed };
    }
    store.savePreset(name, snap);
    return store.listPresets();
  });
  ipcMain.handle('preset:apply', (_e, name) => {
    const snap = store.getPreset(name);
    if (!snap) return false;
    for (const [id, conf] of Object.entries(snap)) {
      const win = cards.get(id);
      if (!win || win.isDestroyed()) continue;
      // 접힌 창은 높이를 건드리지 않고 위치/너비만(렌더러 접힘 상태와 desync 방지). store엔 펼침 bounds 보존.
      const target = win._collapsed ? { x: conf.bounds.x, y: conf.bounds.y, width: conf.bounds.width } : conf.bounds;
      win.setBounds(target);
      store.updateBounds(id, conf.bounds);
      if (conf.visible) { win.show(); store.setVisible(id, true); } else { win.hide(); store.setVisible(id, false); }
    }
    return true;
  });
}

app.whenReady().then(() => {
  try {
    if (!isPrimary) return; // 2차 인스턴스는 창을 만들지 않고 종료
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

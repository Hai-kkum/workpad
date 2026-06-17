'use strict';
// 메인 프로세스: 앱 수명주기 · 카드 창 관리 · IPC · 전역 단축키.
// 카드 = 프레임 없는 독립 BrowserWindow. Alt-Tab/작업표시줄 숨김은 숨은 "소유 창(owner)"의
// 자식(parent)으로 만들어 처리(Windows에서 소유된 창은 Alt-Tab 목록에 안 나옴) — 네이티브 코드 불필요.

const { app, BrowserWindow, ipcMain, clipboard, globalShortcut, Menu, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const store = require('./store');
const { maskPII, hasPII } = require('../shared/pii'); // 검색 스니펫 마스킹(SE-6) + 백업 PII 검출

const COLLAPSED_H = 30;
const PANEL_HEAD_H = 34; // 패널 접힘 높이(커스텀 헤더만)
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

let panelWin = null;   // 컨트롤 패널
const cards = new Map(); // id -> BrowserWindow
const cardOwners = new Map(); // id -> 카드별 숨은 owner 창. 카드마다 개별 owner라야 클릭 시 그 카드만 앞으로 옴(공유 owner면 그룹 전체가 올라옴).

// 배포용 설정(보안팀 제어). 앱 폴더의 workpad.config.json. allowDataTransfer=false면 내보내기/가져오기 차단.
let appConfig = { allowDataTransfer: true };
function loadConfig() {
  try {
    const p = path.join(app.getAppPath(), 'workpad.config.json');
    if (fs.existsSync(p)) appConfig = Object.assign(appConfig, JSON.parse(fs.readFileSync(p, 'utf8')));
  } catch (e) { /* 설정 깨지면 기본값 유지 */ }
}

// ── 암호 보호 백업(PC 이전용) — scrypt KDF + AES-256-GCM. DPAPI와 무관해 다른 PC에서도 복원 가능. ──
const SCRYPT = { N: 16384, r: 8, p: 1 };
function exportBundle(stateObj, pass) {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(String(pass), salt, 32, SCRYPT);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(JSON.stringify(stateObj), 'utf8'), cipher.final()]);
  return JSON.stringify({
    magic: 'WORKPAD-BACKUP', v: 1, kdf: 'scrypt', N: SCRYPT.N,
    salt: salt.toString('base64'), iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'), data: enc.toString('base64'),
  });
}
function importBundle(text, pass) {
  const o = JSON.parse(text);
  if (!o || o.magic !== 'WORKPAD-BACKUP') throw new Error('형식 아님');
  const salt = Buffer.from(o.salt, 'base64');
  const key = crypto.scryptSync(String(pass), salt, 32, { N: o.N || SCRYPT.N, r: 8, p: 1 });
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(o.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(o.tag, 'base64'));
  const dec = Buffer.concat([decipher.update(Buffer.from(o.data, 'base64')), decipher.final()]).toString('utf8'); // 암호 틀리면 여기서 throw
  return JSON.parse(dec);
}
// 백업/이전 시 개인정보(주민·카드번호 추정) 검출 — 내보내기 전에 경고하기 위한 카운트.
function scanPII(state) {
  let count = 0; const hitCards = new Set();
  const check = (v, id) => { if (v != null && v !== '' && hasPII(String(v))) { count++; if (id) hitCards.add(id); } };
  for (const c of Object.values((state && state.cards) || {})) {
    check(c.title, c.id);
    check(c.content && c.content.text, c.id);
    if (Array.isArray(c.lines)) c.lines.forEach((ln) => check(ln && ln.text, c.id));
    if (Array.isArray(c.rows)) c.rows.forEach((r) => { if (Array.isArray(r)) r.forEach((cell) => check(cell, c.id)); });
  }
  return { count, cards: hitCards.size };
}

// 가져오기 후 카드 창 전체 재생성
function reloadAllCards() {
  for (const [, win] of cards) { if (!win.isDestroyed()) win.destroy(); }
  cards.clear();
  for (const c of Object.values(store.getState().cards)) createCardWindow(c, c.visible !== false);
}

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

function defaultCard(type, section) {
  const n = cards.size;
  const x = 90 + (n % 6) * 28;
  const y = 90 + (n % 6) * 28;
  const base = {
    id: newId(), type, alwaysOnTop: false, collapsed: false, visible: true,
    section: section || '공통', // 생성 시점의 탭 섹션(없으면 공통)
    createdAt: Date.now(), updatedAt: Date.now(),
    format: { enabled: false, template: '[{날짜단축} {시간}] {내용}' },
  };
  if (type === 'memo') {
    return { ...base, title: '메모', bounds: { x, y, width: 260, height: 200 }, content: { text: '' } };
  }
  if (type === 'callmemo') {
    return {
      ...base, title: '콜 메모', ttlDays: 30, timeDisplay: 'datetime',
      bounds: { x, y, width: 300, height: 260 },
      format: { enabled: true, template: '[{날짜단축} {시간}] {내용}' }, // 복사도 날짜+시간(화면 기본과 일치)
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
  // 카드 전용 숨은 owner: Alt-Tab/작업표시줄 숨김은 유지하되, 각 카드가 독립 z-order 그룹이라 클릭 시 그 카드만 앞으로 옴.
  const owner = new BrowserWindow({ width: 1, height: 1, show: false, skipTaskbar: true, focusable: false });
  cardOwners.set(card.id, owner);
  const win = new BrowserWindow({
    x: card.bounds.x, y: card.bounds.y,
    width: card.bounds.width,
    height: collapsed ? COLLAPSED_H : card.bounds.height,
    minWidth: 160, minHeight: COLLAPSED_H,
    frame: false, skipTaskbar: true, parent: owner,
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
  win.on('closed', () => {
    cards.delete(card.id);
    const o = cardOwners.get(card.id);
    if (o && !o.isDestroyed()) o.destroy(); // 카드와 함께 전용 owner도 파기(누수 방지)
    cardOwners.delete(card.id);
  });

  cards.set(card.id, win);
  return win;
}

// 패널 밖(카드 ✕·전역 단축키·섹션 전환)에서 표시상태가 바뀌면 패널 목록을 다시 그리도록 알림(동기화).
function notifyPanel() { if (panelWin && !panelWin.isDestroyed()) panelWin.webContents.send('panel:refresh'); }

function toggleAll() {
  const anyVisible = [...cards.values()].some((w) => !w.isDestroyed() && w.isVisible());
  for (const [id, win] of cards) {
    if (win.isDestroyed()) continue;
    if (anyVisible) { win.hide(); store.setVisible(id, false); }
    else { win.show(); store.setVisible(id, true); }
  }
  notifyPanel();
}

function applyHotkey(accel) {
  globalShortcut.unregisterAll();
  if (!accel) return;
  try { globalShortcut.register(accel, toggleAll); } catch (_) {}
}

function createPanel() {
  const aot = !!store.getSettings().panelAlwaysOnTop;
  panelWin = new BrowserWindow({
    width: 300, height: 440, minWidth: 240, minHeight: PANEL_HEAD_H,
    title: 'Workpad', show: false, frame: false, alwaysOnTop: aot, // 프레임리스 + 커스텀 헤더(item 5)
    maximizable: false, fullscreenable: false,
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
    if (win && !win.isDestroyed()) { win.hide(); store.setVisible(id, false); notifyPanel(); }
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
  // 패널 헤더 수동 드래그(카드와 동일 패턴). 프레임리스에서 -webkit-app-region:drag를 쓰면 헤더 더블클릭(접기)이
  // 안 잡혀 수동 처리. dragStart에서 현재 위치/크기 1회 캡처 → dragMove는 델타만 적용(크기 고정, 비동기 레이스 없음).
  ipcMain.on('panel:dragStart', () => { if (panelWin && !panelWin.isDestroyed()) panelWin._dragBase = panelWin.getBounds(); });
  ipcMain.on('panel:dragMove', (_e, dx, dy) => {
    if (!panelWin || panelWin.isDestroyed() || !panelWin._dragBase) return;
    if (!Number.isFinite(dx) || !Number.isFinite(dy)) return;
    const b = panelWin._dragBase;
    panelWin.setBounds({ x: Math.round(b.x + dx), y: Math.round(b.y + dy), width: b.width, height: b.height });
  });
  ipcMain.on('panel:dragEnd', () => { if (panelWin && !panelWin.isDestroyed()) panelWin._dragBase = null; });
  ipcMain.handle('clipboard:write', (_e, text) => { clipboard.writeText(String(text ?? '')); return true; });
  ipcMain.handle('clipboard:read', () => clipboard.readText());
  ipcMain.handle('clipboard:readHTML', () => clipboard.readHTML()); // 엑셀/CRM 표는 HTML(table)로도 올라옴 — 차원 정확

  ipcMain.handle('settings:get', () => store.getSettings());
  ipcMain.handle('settings:update', (_e, patch) => {
    const s = store.updateSettings(patch);
    if (Object.prototype.hasOwnProperty.call(patch, 'hotkeyHideAll')) applyHotkey(s.hotkeyHideAll);
    return s;
  });
  ipcMain.handle('app:status', () => ({ keyProtected: store.isKeyProtected(), cardCount: cards.size, loadError: store.getLoadError(), allowDataTransfer: appConfig.allowDataTransfer !== false }));
  // 암호 보호 내보내기(PC 이전/백업). 보안팀이 막아 배포하면(allowDataTransfer:false) 거부.
  ipcMain.handle('data:export', async (_e, pass) => {
    if (appConfig.allowDataTransfer === false) return { ok: false, reason: 'disabled' };
    if (!pass || String(pass).length < 4) return { ok: false, reason: 'weak' };
    const d = new Date();
    const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
    const res = await dialog.showSaveDialog(panelWin, { defaultPath: `workpad-backup-${stamp}.workpad`, filters: [{ name: 'Workpad Backup', extensions: ['workpad'] }] });
    if (res.canceled || !res.filePath) return { ok: false, reason: 'canceled' };
    try { fs.writeFileSync(res.filePath, exportBundle(store.getState(), pass), { mode: 0o600 }); return { ok: true, path: res.filePath }; }
    catch (e) { logf('export error: ' + (e && e.stack || e)); return { ok: false, reason: 'write' }; }
  });
  ipcMain.handle('data:piiScan', () => scanPII(store.getState())); // 내보내기 전 PII 검출(읽기 전용 카운트)
  ipcMain.handle('data:import', async (_e, pass) => {
    if (appConfig.allowDataTransfer === false) return { ok: false, reason: 'disabled' };
    const res = await dialog.showOpenDialog(panelWin, { properties: ['openFile'], filters: [{ name: 'Workpad Backup', extensions: ['workpad', 'json'] }] });
    if (res.canceled || !res.filePaths || !res.filePaths[0]) return { ok: false, reason: 'canceled' };
    let bundle;
    try { bundle = importBundle(fs.readFileSync(res.filePaths[0], 'utf8'), pass); }
    catch (e) { return { ok: false, reason: 'decrypt' }; } // 암호 틀림 또는 손상/형식 아님
    if (!bundle || typeof bundle !== 'object' || typeof bundle.cards !== 'object') return { ok: false, reason: 'format' };
    store.replaceState(bundle);
    reloadAllCards();
    notifyPanel();
    return { ok: true, count: Object.keys(store.getState().cards).length };
  });
  ipcMain.handle('env:get', () => ({ hostname: os.hostname() })); // 맥락 워터마크용 좌석/PC 식별(SE-7)
  ipcMain.handle('search', (_e, q) => {
    q = String(q || '').trim().toLowerCase();
    if (!q) return [];
    const maskOn = store.getSettings().maskPII !== false;
    const show = (t) => (maskOn ? maskPII(t) : t); // 스니펫 노출 전 화면 가림 규칙 적용(검색 결과로 PII 새지 않게)
    // 원문에서 매칭 위치를 잡되, 보여주는 스니펫은 마스킹본. malformed 데이터(비문자/비배열) 가드(P2).
    const ctx = (raw) => {
      const t = String(raw);
      const i = t.toLowerCase().indexOf(q);
      if (i < 0) return null;
      const a = Math.max(0, i - 20);
      const slice = t.slice(a, i + q.length + 40);
      return (a > 0 ? '…' : '') + show(slice).trim() + (i + q.length + 40 < t.length ? '…' : '');
    };
    const out = [];
    for (const c of Object.values(store.getState().cards)) {
      const fields = [];
      const push = (v) => { if (v != null && v !== '') fields.push(String(v)); };
      push(c.title);
      if (c.content && c.content.text) push(c.content.text);
      if (Array.isArray(c.lines)) c.lines.forEach((ln) => push(ln && ln.text));
      if (Array.isArray(c.rows)) c.rows.forEach((r) => { if (Array.isArray(r)) r.forEach((cell) => push(cell)); });
      const snips = [];
      for (const f of fields) { const s = ctx(f); if (s) { snips.push(s); if (snips.length >= 2) break; } }
      if (snips.length) out.push({ id: c.id, title: c.title || '(제목 없음)', type: c.type, snippet: snips.join('  ·  ') });
    }
    return out;
  });
  // 패널 커스텀 헤더(프레임리스) 제어 — item 5
  ipcMain.handle('panel:pin', () => {
    const aot = !store.getSettings().panelAlwaysOnTop;
    store.updateSettings({ panelAlwaysOnTop: aot });
    if (panelWin && !panelWin.isDestroyed()) panelWin.setAlwaysOnTop(aot);
    return aot;
  });
  ipcMain.handle('panel:collapse', (_e, collapsed) => {
    if (!panelWin || panelWin.isDestroyed()) return;
    if (collapsed) {
      panelWin._expandedHeight = panelWin.getBounds().height;
      panelWin.setResizable(false);
      panelWin.setBounds({ height: PANEL_HEAD_H });
    } else {
      panelWin.setResizable(true);
      panelWin.setBounds({ height: panelWin._expandedHeight || 440 });
    }
  });
  ipcMain.handle('panel:minimize', () => { if (panelWin && !panelWin.isDestroyed()) panelWin.minimize(); });
  ipcMain.handle('panel:close', () => { if (panelWin && !panelWin.isDestroyed()) panelWin.close(); });
  ipcMain.handle('panel:getState', () => ({ alwaysOnTop: !!store.getSettings().panelAlwaysOnTop }));
  ipcMain.handle('panel:listCards', () => store.listCards());
  ipcMain.handle('panel:createCard', (_e, type, section) => {
    const card = defaultCard(['memo', 'callmemo', 'table'].includes(type) ? type : 'snippet', section);
    store.addCard(card);
    const win = createCardWindow(card, true);
    win.once('show', () => { try { win.focus(); } catch (_) {} }); // 새로 만든 카드는 바로 포커스 → 생성 직후 붙여넣기/입력 즉시 가능
    return card.id;
  });
  ipcMain.handle('panel:focusCard', (_e, id) => {
    const win = cards.get(id);
    if (win && !win.isDestroyed()) { store.setVisible(id, true); win.show(); win.focus(); notifyPanel(); }
  });
  ipcMain.handle('panel:flashCard', (_e, id) => { // 패널 더블클릭 → 해당 카드 창 앞으로 + 흔들기/플래시 신호
    const win = cards.get(id);
    if (win && !win.isDestroyed()) { store.setVisible(id, true); win.show(); win.focus(); win.webContents.send('card:flash'); notifyPanel(); }
  });
  ipcMain.handle('panel:showAll', () => { for (const [id, win] of cards) if (!win.isDestroyed()) { win.show(); store.setVisible(id, true); } notifyPanel(); });
  ipcMain.handle('panel:hideAll', () => { for (const [id, win] of cards) if (!win.isDestroyed()) { win.hide(); store.setVisible(id, false); } notifyPanel(); });
  ipcMain.handle('panel:toggleAll', () => toggleAll());
  // 섹션 탭 전환: 해당 섹션 카드만 화면에 표시, 나머지 숨김(엄격 격리). 전체=모두. (item 3)
  ipcMain.handle('panel:showSection', (_e, name) => {
    for (const [id, win] of cards) {
      if (win.isDestroyed()) continue;
      const c = store.getCard(id);
      const sect = (c && c.section) || '공통';
      const show = name === '전체' || sect === name;
      if (show) { win.show(); store.setVisible(id, true); } else { win.hide(); store.setVisible(id, false); }
    }
    notifyPanel();
  });
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
    loadConfig();
    logf('config: allowDataTransfer=' + (appConfig.allowDataTransfer !== false));
    // 모든 창이 프레임리스라 메뉴바는 표시되지 않음. 단, 텍스트 단축키(Ctrl+C/V/X/A/Z)는 편집 역할 메뉴로 보장.
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      { role: 'editMenu' },
      ...(isDev ? [{ role: 'viewMenu' }] : []),
    ]));
    store.init();
    logf('store init ok, keyProtected=' + store.isKeyProtected());

    app.on('web-contents-created', (_e, wc) => {
      wc.setWindowOpenHandler(() => ({ action: 'deny' }));
      wc.on('will-navigate', (e) => e.preventDefault());
    });

    registerIpc(); // owner 창은 카드 생성 시 카드별로 만든다(createCardWindow)
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

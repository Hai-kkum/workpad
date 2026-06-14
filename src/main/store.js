'use strict';
// 로컬 암호화 저장소.
// - 모든 상태(카드/프리셋/설정)를 단일 JSON으로 직렬화 → AES-256-GCM 암호화 → userData에 파일로 저장.
// - 데이터 암호화 키(DEK)는 32바이트 난수. Electron safeStorage(Windows에서 DPAPI 백엔드)로 래핑해 저장.
//   => 같은 PC·같은 로그온 계정에서만 복호 가능. 외부로 새어도 다른 환경에서 못 연다.
// - 네이티브 모듈 의존 0 (better-sqlite3/SQLCipher 빌드 회피). 추후 SQLCipher로 이관 가능.

const { app, safeStorage } = require('electron');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_FILE = () => path.join(app.getPath('userData'), 'workpad-data.enc');
const KEY_FILE = () => path.join(app.getPath('userData'), 'workpad-key.bin');

let dek = null;          // Buffer(32) 데이터 암호화 키
let state = null;        // 메모리 상태
let saveTimer = null;
let keyProtected = false; // safeStorage로 보호됐는지(감사/표시용)

function defaultState() {
  return {
    version: 1,
    settings: { agentId: '', hotkeyHideAll: 'Control+Alt+H' },
    cards: {},      // id -> card
    presets: {},    // name -> { [cardId]: {bounds, visible} }
  };
}

function loadOrCreateKey() {
  const keyPath = KEY_FILE();
  if (fs.existsSync(keyPath)) {
    const raw = fs.readFileSync(keyPath);
    // 첫 바이트로 보호 방식 구분: 0x01 = safeStorage 래핑, 0x00 = 평문 폴백
    const mode = raw[0];
    const body = raw.subarray(1);
    if (mode === 0x01 && safeStorage.isEncryptionAvailable()) {
      keyProtected = true;
      const hex = safeStorage.decryptString(body);
      return Buffer.from(hex, 'hex');
    }
    keyProtected = false;
    return Buffer.from(body.toString('utf8'), 'hex');
  }
  // 신규 키 생성
  const key = crypto.randomBytes(32);
  const hex = key.toString('hex');
  if (safeStorage.isEncryptionAvailable()) {
    const wrapped = safeStorage.encryptString(hex); // Buffer
    fs.writeFileSync(keyPath, Buffer.concat([Buffer.from([0x01]), wrapped]), { mode: 0o600 });
    keyProtected = true;
  } else {
    // OS 키체인/ DPAPI 불가 환경 폴백: 평문 저장(여전히 로컬, 단 보호 약함)
    fs.writeFileSync(keyPath, Buffer.concat([Buffer.from([0x00]), Buffer.from(hex, 'utf8')]), { mode: 0o600 });
    keyProtected = false;
  }
  return key;
}

function encrypt(jsonStr) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', dek, iv);
  const enc = Buffer.concat([cipher.update(jsonStr, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]); // [12 iv][16 tag][...data]
}

function decrypt(buf) {
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const data = buf.subarray(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', dek, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
}

// TTL 경과한 콜 메모 줄 파기
function purgeExpired(s) {
  const now = Date.now();
  for (const id of Object.keys(s.cards)) {
    const c = s.cards[id];
    if (c.type === 'callmemo' && c.ttlDays > 0 && Array.isArray(c.lines)) {
      const cutoff = now - c.ttlDays * 86400000;
      c.lines = c.lines.filter((ln) => !ln.t || ln.t >= cutoff);
    }
  }
}

function init() {
  dek = loadOrCreateKey();
  try {
    const f = DATA_FILE();
    if (fs.existsSync(f)) {
      state = JSON.parse(decrypt(fs.readFileSync(f)));
    } else {
      state = defaultState();
    }
  } catch (e) {
    // 복호 실패(키 불일치/손상) 시 데이터 손실 방지를 위해 백업 후 초기화
    try { fs.renameSync(DATA_FILE(), DATA_FILE() + '.corrupt-' + Date.now()); } catch (_) {}
    state = defaultState();
  }
  // 누락 필드 보정
  state = Object.assign(defaultState(), state);
  purgeExpired(state);
  scheduleSave();
  return state;
}

function flush() {
  if (!state) return;
  try {
    const tmp = DATA_FILE() + '.tmp';
    fs.writeFileSync(tmp, encrypt(JSON.stringify(state)), { mode: 0o600 });
    fs.renameSync(tmp, DATA_FILE()); // 원자적 교체
  } catch (e) { /* 다음 저장에서 재시도 */ }
}

function scheduleSave() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(flush, 300);
}

// ---- 접근자 ----
const api = {
  init,
  flush,
  isKeyProtected: () => keyProtected,
  getState: () => state,
  getSettings: () => state.settings,
  updateSettings: (patch) => { Object.assign(state.settings, patch); scheduleSave(); return state.settings; },

  listCards: () => Object.values(state.cards).map((c) => ({ id: c.id, title: c.title, type: c.type, visible: c.visible !== false })),
  getCard: (id) => state.cards[id] || null,
  addCard: (card) => { state.cards[card.id] = card; scheduleSave(); return card; },
  updateCard: (id, patch) => { const c = state.cards[id]; if (!c) return null; Object.assign(c, patch); c.updatedAt = Date.now(); scheduleSave(); return c; },
  updateBounds: (id, bounds) => { const c = state.cards[id]; if (!c) return; c.bounds = bounds; scheduleSave(); },
  setVisible: (id, visible) => { const c = state.cards[id]; if (c) { c.visible = visible; scheduleSave(); } },
  removeCard: (id) => { delete state.cards[id]; scheduleSave(); },

  listPresets: () => Object.keys(state.presets),
  savePreset: (name, snapshot) => { state.presets[name] = snapshot; scheduleSave(); },
  getPreset: (name) => state.presets[name] || null,
};

module.exports = api;

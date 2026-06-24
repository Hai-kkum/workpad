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
const SCRYPT = { N: 16384, r: 8, p: 1 }; // 비밀번호 잠금(SE-9) KDF — data:export와 동일 파라미터

let dek = null;          // Buffer(32) 데이터 암호화 키
let state = null;        // 메모리 상태
let saveTimer = null;
let keyMode = 'new';      // 'dpapi' | 'plain' | 'passphrase' | 'new' (상태 표시·분기용)
let keyProtected = false; // 키가 보호됐는지(평문 폴백이 아님) — 감사/표시용
let lastLoadError = null;  // 복호 실패로 백업·초기화됐는지(B-11)

function defaultState() {
  return {
    version: 1,
    settings: { agentId: '', hotkeyHideAll: 'Control+Alt+H', maskPII: true, sections: ['공통', '기타'], panelAlwaysOnTop: false, headers: [] },
    cards: {},      // id -> card
    presets: {},    // name -> { [cardId]: {bounds, visible} }
  };
}

// 키 파일을 원자적으로 교체. fsync로 디스크 반영 보장 + 기존 키는 .bak으로 보존(새 키 검증 실패 시 복구). 검증 성공 후 clearKeyBak (Codex P3).
function writeKeyFileAtomic(buf) {
  const keyPath = KEY_FILE();
  const tmp = keyPath + '.tmp';
  const fd = fs.openSync(tmp, 'w', 0o600);
  try { fs.writeSync(fd, buf); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  if (fs.existsSync(keyPath)) { try { fs.copyFileSync(keyPath, keyPath + '.bak'); } catch (_) {} } // 교체 전 백업
  fs.renameSync(tmp, keyPath);
}
function clearKeyBak() { try { fs.rmSync(KEY_FILE() + '.bak', { force: true }); } catch (_) {} }
function restoreKeyBak() { try { const b = KEY_FILE() + '.bak'; if (fs.existsSync(b)) fs.renameSync(b, KEY_FILE()); } catch (_) {} }

// 비밀번호 모드가 아닌 키(0x01 DPAPI / 0x00 평문)를 DEK로 언래핑(읽기 전용 — 재래핑 readback 검증용). 부적합 시 throw.
function unwrapNonPassphrase(raw) {
  const mode = raw[0], body = raw.subarray(1);
  let dekBuf;
  if (mode === 0x01) {
    if (!safeStorage.isEncryptionAvailable()) throw new Error('DPAPI-protected but safeStorage unavailable');
    dekBuf = Buffer.from(safeStorage.decryptString(body), 'hex');
  } else if (mode === 0x00) {
    dekBuf = Buffer.from(body.toString('utf8'), 'hex');
  } else throw new Error('unexpected key mode: ' + mode);
  if (dekBuf.length !== 32) throw new Error('invalid DEK length');
  return dekBuf;
}

// 키 파일 첫 바이트로 보호 방식만 판별(언래핑 없이). 시작 분기용. 빈/알수없음/읽기오류 = invalid(평문 오인 금지, Codex P1).
function probeKeyMode() {
  const keyPath = KEY_FILE();
  if (!fs.existsSync(keyPath)) return 'new';
  try {
    const raw = fs.readFileSync(keyPath);
    if (!raw.length) return 'invalid';
    const b0 = raw[0];
    return b0 === 0x02 ? 'passphrase' : b0 === 0x01 ? 'dpapi' : b0 === 0x00 ? 'plain' : 'invalid';
  } catch (_) { return 'invalid'; }
}

// DEK를 비밀번호로 래핑(SE-9): [0x02][salt16][iv12][tag16][enc]. scrypt(pass)→KEK로 AES-256-GCM.
function wrapWithPassphrase(key, pass) {
  const salt = crypto.randomBytes(16);
  const kek = crypto.scryptSync(String(pass), salt, 32, SCRYPT);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', kek, iv);
  const enc = Buffer.concat([cipher.update(key), cipher.final()]);
  return Buffer.concat([Buffer.from([0x02]), salt, iv, cipher.getAuthTag(), enc]);
}
// 비밀번호로 DEK 언래핑. 길이/포맷 검증 후, 틀리면 GCM 인증 실패로 throw (Codex P3).
function unwrapWithPassphrase(raw, pass) {
  if (raw.length !== 77) throw new Error('invalid key record length'); // 1+16(salt)+12(iv)+16(tag)+32(DEK)
  const salt = raw.subarray(1, 17), iv = raw.subarray(17, 29), tag = raw.subarray(29, 45), enc = raw.subarray(45);
  const kek = crypto.scryptSync(String(pass), salt, 32, SCRYPT);
  const decipher = crypto.createDecipheriv('aes-256-gcm', kek, iv);
  decipher.setAuthTag(tag);
  const dekBuf = Buffer.concat([decipher.update(enc), decipher.final()]);
  if (dekBuf.length !== 32) throw new Error('invalid DEK length');
  return dekBuf;
}
// DEK를 safeStorage(DPAPI) 래핑 또는 평문 폴백. 반환 {buf, protected}.
function wrapWithSafeStorage(key) {
  const hex = key.toString('hex');
  if (safeStorage.isEncryptionAvailable()) {
    return { buf: Buffer.concat([Buffer.from([0x01]), safeStorage.encryptString(hex)]), protected: true };
  }
  // OS 키체인/DPAPI 불가 폴백: 평문(여전히 로컬, 보호 약함 — SE-9 비밀번호 잠금 권장). GAP B-9.
  return { buf: Buffer.concat([Buffer.from([0x00]), Buffer.from(hex, 'utf8')]), protected: false };
}

// 비밀번호 모드가 아닐 때의 키 로드/생성(기존 동작 유지). 비밀번호 모드(0x02)는 거부 → unlockWithPassphrase 사용.
function loadOrCreateKey() {
  const keyPath = KEY_FILE();
  if (fs.existsSync(keyPath)) {
    const raw = fs.readFileSync(keyPath);
    const mode = raw[0];
    const body = raw.subarray(1);
    if (mode === 0x02) throw new Error('passphrase-protected key: use unlockWithPassphrase'); // 안전장치: 평문 경로로 잘못 읽어 데이터 손상 방지
    let dekBuf;
    if (mode === 0x01) {
      // DPAPI 보호 키는 반드시 safeStorage로 복호 — 불가 시 평문 오인하지 말고 fail-closed(데이터 리셋 방지, Codex P1).
      if (!safeStorage.isEncryptionAvailable()) throw new Error('DPAPI-protected but safeStorage unavailable');
      keyMode = 'dpapi'; keyProtected = true;
      dekBuf = Buffer.from(safeStorage.decryptString(body), 'hex');
    } else if (mode === 0x00) {
      keyMode = 'plain'; keyProtected = false;
      dekBuf = Buffer.from(body.toString('utf8'), 'hex');
    } else throw new Error('unknown key mode: ' + mode); // 알 수 없는 모드 = fail-closed
    if (dekBuf.length !== 32) throw new Error('invalid DEK length'); // 손상 키가 잘못된 DEK로 흘러 데이터 리셋되는 것 방지
    return dekBuf;
  }
  // 신규 키 생성
  const key = crypto.randomBytes(32);
  const { buf, protected: prot } = wrapWithSafeStorage(key);
  writeKeyFileAtomic(buf);
  keyMode = prot ? 'dpapi' : 'plain'; keyProtected = prot;
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

// 상용구(snippet)·기록 메모(callmemo)를 통합 카드 '노트'(note)로 1회 마이그레이션. 동작 보존(화면 표시·복사 결과 동일):
//  - snippet → note: 화면 말머리 끔, 자동삭제 없음, 시각 기준은 기존 fmtBasis 유지(없으면 복사시점 now).
//  - callmemo → note: 화면 말머리 기존값(없으면 날짜+시간), 자동삭제 기존값(없으면 30일), 시각 기준 줄 작성시각(lineTime — 기존 동작).
// idempotent: 이미 note면 건드리지 않음(타입이 snippet/callmemo가 아니므로).
function migrateCardTypes(s) {
  for (const id of Object.keys((s && s.cards) || {})) {
    const c = s.cards[id];
    if (!c) continue;
    if (c.type === 'snippet') {
      c.type = 'note';
      if (c.timeDisplay == null) c.timeDisplay = 'off';
      if (c.ttlDays == null) c.ttlDays = 0;
      c.format = c.format || {};
      if (c.format.timeBasis == null) c.format.timeBasis = 'now'; // 기존 fmtBasis 있으면 유지(now/callStart)
    } else if (c.type === 'callmemo') {
      c.type = 'note';
      if (c.timeDisplay == null) c.timeDisplay = 'datetime';
      if (c.ttlDays == null) c.ttlDays = 30;
      c.format = c.format || {};
      if (c.format.timeBasis == null) c.format.timeBasis = 'lineTime'; // 기존엔 항상 줄 시각 사용 → 동작 보존
    }
    // 노트 복사 서식은 '내용 앞 접두'만 보관 — {내용} 토큰 및 그 뒤를 잘라 접두만 남긴다(복사 시 내용은 자동으로 뒤에 붙음). idempotent.
    if (c.type === 'note' && c.format && typeof c.format.template === 'string' && c.format.template.includes('{내용}')) {
      c.format.template = c.format.template.split('{내용}')[0];
    }
  }
}

// TTL 경과한 노트(구 콜 메모) 줄 파기
function purgeExpired(s) {
  const now = Date.now();
  for (const id of Object.keys(s.cards)) {
    const c = s.cards[id];
    if ((c.type === 'note' || c.type === 'callmemo') && c.ttlDays > 0 && Array.isArray(c.lines)) {
      const cutoff = now - c.ttlDays * 86400000;
      // fail-closed: 타임스탬프 없는 줄은 카드 생성시각으로 폴백(그것도 없으면 만료 처리) → TTL 우회 차단
      c.lines = c.lines.filter((ln) => (ln.t || c.createdAt || 0) >= cutoff);
    }
  }
}

// 암호화 데이터 파일 로드(키는 이미 dek에 세팅된 상태). 복호 실패 시 백업 후 초기화(B-11).
function loadData() {
  try {
    const f = DATA_FILE();
    state = fs.existsSync(f) ? JSON.parse(decrypt(fs.readFileSync(f))) : defaultState();
  } catch (e) {
    // 복호 실패(키 불일치/손상) 시 데이터 손실 방지를 위해 백업 후 초기화. 사용자에게 알리도록 기록(B-11).
    try { const bak = DATA_FILE() + '.corrupt-' + Date.now(); fs.renameSync(DATA_FILE(), bak); lastLoadError = { backup: bak }; } catch (_) { lastLoadError = { backup: null }; }
    state = defaultState();
  }
  state = Object.assign(defaultState(), state);                                  // 누락 필드 보정
  state.settings = Object.assign(defaultState().settings, state.settings || {}); // 설정 누락 키 보정(maskPII 등)
  migrateCardTypes(state); // 상용구·기록 메모 → 노트 통합(동작 보존)
  purgeExpired(state);
  scheduleSave();
  return state;
}

// 비밀번호 모드가 아닌 시작 경로. (비밀번호 모드는 main이 probeKeyMode로 감지 후 unlockWithPassphrase 호출)
function init() {
  dek = loadOrCreateKey();
  return loadData();
}

// 비밀번호로 잠금 해제(SE-9). 성공 시 dek 세팅 + 데이터 로드. 실패(틀린 비번/손상) 시 false, 데이터 무손상.
function unlockWithPassphrase(pass) {
  try {
    const raw = fs.readFileSync(KEY_FILE());
    if (raw[0] !== 0x02) return false;
    dek = unwrapWithPassphrase(raw, pass); // 틀리면 throw
  } catch (_) { dek = null; return false; }
  keyMode = 'passphrase'; keyProtected = true;
  loadData();
  return true;
}

// SE-9 켜기: 현재 DEK를 비밀번호로 재래핑(데이터 재암호화 불필요 — 같은 DEK 유지).
function setPassphrase(pass) {
  if (!dek) return false;
  writeKeyFileAtomic(wrapWithPassphrase(dek, pass));
  try { if (!unwrapWithPassphrase(fs.readFileSync(KEY_FILE()), pass).equals(dek)) throw new Error('verify'); } // readback 검증(Codex P3)
  catch (_) { restoreKeyBak(); return false; } // 실패 시 이전 키 복구(데이터 손실 방지)
  clearKeyBak();
  keyMode = 'passphrase'; keyProtected = true;
  return true;
}
// 현재 비밀번호 검증(파일을 실제로 언래핑해 DEK 일치 확인).
function verifyPassphrase(pass) {
  try {
    const raw = fs.readFileSync(KEY_FILE());
    if (raw[0] !== 0x02 || !dek) return false;
    return unwrapWithPassphrase(raw, pass).equals(dek);
  } catch (_) { return false; }
}
// SE-9 비밀번호 변경: 현재 비번 검증 후 새 비번으로 재래핑.
function changePassphrase(oldPass, newPass) {
  if (!verifyPassphrase(oldPass)) return false;
  return setPassphrase(newPass);
}
// SE-9 끄기: 현재 비번 검증 후 DPAPI(또는 평문 폴백)로 재래핑.
function removePassphrase(curPass) {
  if (!verifyPassphrase(curPass)) return false;
  const { buf, protected: prot } = wrapWithSafeStorage(dek);
  writeKeyFileAtomic(buf);
  try { if (!unwrapNonPassphrase(fs.readFileSync(KEY_FILE())).equals(dek)) throw new Error('verify'); } // readback 검증(Codex P3)
  catch (_) { restoreKeyBak(); return false; } // 실패 시 이전(비밀번호) 키 복구
  clearKeyBak();
  keyMode = prot ? 'dpapi' : 'plain'; keyProtected = prot;
  return true;
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
  probeKeyMode,
  unlockWithPassphrase,
  setPassphrase,
  changePassphrase,
  removePassphrase,
  getKeyMode: () => keyMode,
  isKeyProtected: () => keyProtected,
  getLoadError: () => lastLoadError,
  getState: () => state,
  // 가져오기(백업 복원): 전체 상태 교체. 누락 필드/설정 보정 후 즉시 저장.
  replaceState: (incoming) => {
    const next = Object.assign(defaultState(), incoming || {});
    next.settings = Object.assign(defaultState().settings, (incoming && incoming.settings) || {});
    if (!next.cards || typeof next.cards !== 'object') next.cards = {};
    if (!next.presets || typeof next.presets !== 'object') next.presets = {};
    state = next;
    migrateCardTypes(state); // 옛 백업(상용구·기록 메모)도 노트로 통합
    purgeExpired(state);
    flush();
    return state;
  },
  getSettings: () => state.settings,
  updateSettings: (patch) => { Object.assign(state.settings, patch); scheduleSave(); return state.settings; },

  listCards: () => Object.values(state.cards).map((c) => ({ id: c.id, title: c.title, type: c.type, visible: c.visible !== false, section: c.section || '공통' })),
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

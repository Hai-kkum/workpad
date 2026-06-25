'use strict';
// 카드 렌더러. 줄 클릭=복사 / 더블클릭=수정 / 드래그=텍스트 선택이 충돌하지 않도록 구현.

const COPY_SVG = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg>';
const CHECK_SVG = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M5 13l5 5L19 7"/></svg>';
const PENCIL_SVG = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 20h4L18 10l-4-4L4 16v4z"/><path d="M13.5 6.5l4 4"/></svg>';
const SEARCH_SVG = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg>';
const BELL_SVG = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9"/><path d="M10 21h4"/></svg>';
// 헤더 아이콘: 얇은 글리프(위·—)를 또렷한 SVG로 — 핀(항상위) + 접기/펼치기 셰브론(상태별 ∧/∨).
const PIN_SVG = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 17v5"/><path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z"/></svg>';
const CHEVRON_UP_SVG = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 14l6-6 6 6"/></svg>';
const CHEVRON_DOWN_SVG = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 10l6 6 6-6"/></svg>';

const ID = new URLSearchParams(location.search).get('id');
let card = null;
let settings = { agentId: '' };
let appStatus = {};
let fmtOpen = false; // 복사 서식(#) 박스 열림 상태(재렌더에도 유지)
let setCardCollapsed = null; // 접기 상태 제어(setupBar에서 설정) — 패널 더블클릭 신호로 펼치기에 사용
let findOpen = false;
let findTerm = '';
let findIndex = 0;
let reminderOpen = false;
let renderCardBody = null;
let selectedLine = null;
let flashTimer = null;
const DEFAULT_FORMAT = { enabled: false, template: '[{날짜단축} {시간}] ', timeBasis: 'now' };

const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
const saveCard = debounce((patch) => window.api.updateCard(ID, patch), 300);
const persistLines = () => saveCard({ lines: card.lines });

function updateFormatBarControls() {
  document.querySelectorAll('[data-line-style]').forEach((btn) => {
    const key = btn.dataset.lineStyle;
    btn.disabled = !selectedLine;
    btn.classList.toggle('active', !!selectedLine && !!selectedLine[key]);
  });
  document.querySelectorAll('[data-line-check]').forEach((btn) => {
    btn.disabled = !selectedLine;
    btn.classList.toggle('active', !!selectedLine && !!selectedLine.checkable);
  });
}
function setSelectedLine(line) {
  selectedLine = line || null;
  document.querySelectorAll('.row.selected').forEach((el) => el.classList.remove('selected'));
  document.querySelectorAll('.row').forEach((el) => {
    if (el._line === selectedLine) el.classList.add('selected');
  });
  updateFormatBarControls();
}
function supportsLineFormatting() {
  return card && (card.type === 'note' || card.type === 'todo');
}
function supportsChecklistMode() {
  return card && (card.type === 'note' || card.type === 'todo');
}
function normalizeCardForRender() {
  const patch = {};
  let formatChanged = false;
  if (!card.format || typeof card.format !== 'object' || Array.isArray(card.format)) {
    card.format = {};
    formatChanged = true;
  }
  if (card.format.enabled == null) { card.format.enabled = DEFAULT_FORMAT.enabled; formatChanged = true; }
  if (typeof card.format.template !== 'string') { card.format.template = DEFAULT_FORMAT.template; formatChanged = true; }
  if (card.format.timeBasis == null) { card.format.timeBasis = DEFAULT_FORMAT.timeBasis; formatChanged = true; }
  if (formatChanged) patch.format = card.format;

  if ((card.type === 'note' || card.type === 'todo' || card.type === 'callmemo') && !Array.isArray(card.lines)) {
    card.lines = [];
    patch.lines = card.lines;
  }
  if (card.type === 'memo' && (!card.content || typeof card.content !== 'object')) {
    card.content = { text: '' };
    patch.content = card.content;
  }
  if (card.type === 'table' && !Array.isArray(card.rows)) {
    card.rows = [['항목', '값'], ['', '']];
    patch.rows = card.rows;
  }

  if (Object.keys(patch).length) window.api.updateCard(ID, patch);
}

function pad(n) { return String(n).padStart(2, '0'); }
// 기록메모 줄 화면 말머리(시각). 복사 서식과 독립적으로 컴팩트하게 — time=시간만 / 그 외=날짜+시간(기본).
// 사용자ID·전체날짜 등은 화면 말머리에 넣지 않고 복사 스탬프(card.format.template)에만 → 내용 가로폭 확보.
function fmtLineTime(t) {
  const d = new Date(t);
  const date = `${pad(d.getMonth() + 1)}/${pad(d.getDate())}`;
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return (card.timeDisplay === 'time') ? time : `${date} ${time}`;
}

// 복사 스탬프에 들어갈 시각 결정 — 시각 기준(fmt.timeBasis): now=복사 시점 / lineTime=줄 작성시각(line.t) / callStart=통화 시작(card.createdAt).
function stampTime(fmt, lineT) {
  const basis = (fmt && fmt.timeBasis) || 'now';
  if (basis === 'lineTime') return lineT != null ? lineT : ((card && card.createdAt) || Date.now());
  if (basis === 'callStart') return (card && card.createdAt) || Date.now();
  return Date.now(); // now = 복사하는 순간
}
function applyStamp(text, fmt, raw, lineT) {
  if (raw || !fmt || !fmt.enabled) return text;
  const d = new Date(stampTime(fmt, lineT));
  const map = {
    '{날짜}': `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
    '{날짜단축}': `${pad(d.getMonth() + 1)}/${pad(d.getDate())}`,
    '{시간}': `${pad(d.getHours())}:${pad(d.getMinutes())}`,
    '{사용자ID}': fmt.agentId || settings.agentId || '',
    '{상담사ID}': fmt.agentId || settings.agentId || '', // 옛 서식 호환(기존 카드의 {상담사ID}도 계속 치환)
    '{말머리}': fmt.header || '', // 패널에 등록해 둔 말머리(머리말) 중 이 노트가 고른 값
  };
  // 복사 서식(template)은 '내용 앞 접두'만 보관 — {내용}은 항상 맨 뒤에 자동으로 붙인다(사용자가 위치·누락을 건드리지 못하게).
  let s = fmt.template || '';
  for (const k of Object.keys(map)) s = s.split(k).join(map[k]);
  if (s.includes('{내용}')) return s.split('{내용}').join(text); // 옛 템플릿에 {내용} 남아 있으면 그 자리(하위호환)
  // 사용자ID·말머리가 비면 감싼 대괄호([])가 빈 채로 남는다 → 빈 대괄호 제거 후 중복 공백 정리.
  const pre = s.replace(/\[\s*\]/g, '').replace(/\s{2,}/g, ' ').trim();
  return pre ? pre + ' ' + text : text;       // 접두 + 한 칸 + 원문
}

// ── 비파괴 공개형 마스킹(SE-6) ─────────────────────────────────────────────
// 원문은 그대로 저장하고 화면에만 마스킹 표시. 클릭 복사는 항상 원문. 👁로 잠시 공개 후 자동 재마스킹.
const REVEAL_MS = 6000;            // 공개 지속(노출 최소화)
let revealed = false;              // 현재 카드 전체 공개 상태
let revealTimer = null;
let env = { hostname: '' };
const maskEls = [];                // 표시 요소 레지스트리: { el, getRaw }

// 설정이 켜져 있을 때만 화면 가림. 원문(getRaw)은 손대지 않음.
function display(raw) {
  if (raw == null) raw = '';
  return (settings.maskPII !== false && window.PII) ? window.PII.maskPII(raw) : raw;
}
function hasPII(raw) {
  return settings.maskPII !== false && window.PII ? window.PII.hasPII(raw) : false;
}
// 표시 요소 등록(편집 비활성 상태에서만 마스킹 갱신). 목록/표 재렌더 시 호출 전 maskEls.length=0 으로 초기화.
function registerMask(el, getRaw) { maskEls.push({ el, getRaw }); paintMask(el, getRaw()); }
function paintMask(el, raw) {
  if (el.getAttribute('contenteditable') === 'true') return; // 편집 중엔 원문 그대로
  const pii = hasPII(raw);
  el.textContent = revealed ? raw : display(raw);
  el.classList.toggle('masked', pii);
  el.classList.toggle('revealed', pii && revealed);
}
function refreshMask() { for (const m of maskEls) { if (!m.el.isConnected) continue; if (m.repaint) m.repaint(); else paintMask(m.el, m.getRaw()); } }

function setReveal(on) {
  revealed = !!on;
  const btn = document.getElementById('reveal');
  if (btn) btn.classList.toggle('active', revealed);
  clearTimeout(revealTimer);
  if (revealed) { showWatermark(); revealTimer = setTimeout(() => setReveal(false), REVEAL_MS); }
  else hideWatermark();
  refreshMask();
}
// SE-7 맥락 워터마크: 공개하는 순간에만 사용자ID·PC명·시각을 옅게 타일링. 재마스킹 시 제거.
function showWatermark() {
  hideWatermark();
  const who = settings.agentId || '미지정';
  const host = env.hostname || '';
  const now = new Date();
  const label = `${who} · ${host} · ${pad(now.getHours())}:${pad(now.getMinutes())}`;
  const wm = document.createElement('div');
  wm.id = 'watermark';
  for (let i = 0; i < 60; i++) { const s = document.createElement('span'); s.textContent = label; wm.appendChild(s); }
  document.body.appendChild(wm);
}
function hideWatermark() { const wm = document.getElementById('watermark'); if (wm) wm.remove(); }

function caretEnd(el) {
  const r = document.createRange(); r.selectNodeContents(el); r.collapse(false);
  const s = getSelection(); s.removeAllRanges(); s.addRange(r);
}

async function copyRow(text, raw, row, btn, when) {
  const out = applyStamp(text, card.format, raw, when);
  await window.api.copyText(out);
  row.classList.add('copied'); btn.innerHTML = CHECK_SVG;
  setTimeout(() => { row.classList.remove('copied'); btn.innerHTML = COPY_SVG; }, 1000);
}

function makeRow(line) {
  const row = document.createElement('div');
  row.className = 'row';
  row._line = line;
  row.classList.toggle('selected', selectedLine === line);
  row.classList.toggle('bold', !!line.bold);
  row.classList.toggle('strike', !!line.strike);
  row.classList.toggle('done', !!line.checkable && !!line.done);

  if (line.checkable) { // 체크리스트: 완료 토글은 복사/편집과 분리.
    const chk = document.createElement('input');
    chk.type = 'checkbox'; chk.className = 'todochk'; chk.checked = !!line.done;
    ['pointerdown', 'pointerup', 'click', 'dblclick'].forEach((ev) => chk.addEventListener(ev, (e) => e.stopPropagation()));
    chk.addEventListener('change', () => { line.done = chk.checked; row.classList.toggle('done', chk.checked); persistLines(); });
    row.appendChild(chk);
  }

  if (line.t && card.timeDisplay && card.timeDisplay !== 'off') { // 화면 말머리(줄 앞 시각): 끔이 아니고 줄에 시각이 있을 때만
    const time = document.createElement('span');
    time.className = 'time'; time.textContent = fmtLineTime(line.t);
    row.appendChild(time);
  }

  const canFoldDetails = card.type === 'note' && ((Array.isArray(line.details) && line.details.length > 1) || String(line.text || '').includes('\n'));
  if (canFoldDetails) {
    row.classList.add('has-details');
    const toggle = document.createElement('button');
    toggle.className = 'detailtoggle';
    toggle.type = 'button';
    toggle.title = line.expanded || !card.detailsHidden ? '상세 접기' : '상세 보기';
    toggle.textContent = line.expanded || !card.detailsHidden ? '▾' : '▸';
    ['pointerdown', 'pointerup', 'click', 'dblclick'].forEach((ev) => toggle.addEventListener(ev, (e) => e.stopPropagation()));
    toggle.addEventListener('click', () => { line.expanded = !line.expanded; persistLines(); if (renderCardBody) renderCardBody(); });
    row.appendChild(toggle);
  }

  const content = document.createElement('span');
  content.className = 'linecontent';
  const text = document.createElement('span');
  text.className = 'text'; text.setAttribute('contenteditable', 'false');
  registerMask(text, () => lineDisplayText(line)); // 화면=마스킹, 원문은 line.text 유지(SE-6)
  content.appendChild(text);
  if (canFoldDetails && (!card.detailsHidden || line.expanded)) {
    const detail = document.createElement('span');
    detail.className = 'linedetails';
    registerMask(detail, () => lineDetailsText(line));
    content.appendChild(detail);
  }
  row.appendChild(content);

  const copyOn = card.copyMode !== false; // ④a 카드별 복사 토글(기본 on)
  let copy = null;
  if (copyOn) {
    copy = document.createElement('button');
    copy.className = 'copy'; copy.title = '복사 (원문 그대로 · Shift+클릭=서식무시)'; copy.innerHTML = COPY_SVG;
    row.appendChild(copy);
    copy.addEventListener('click', (e) => { e.stopPropagation(); copyRow(line.text, e.shiftKey, row, copy, line.t); }); // 원문 복사(줄 시각 기준)
  }

  let downX = 0, downY = 0;
  row.addEventListener('pointerdown', (e) => {
    if (e.target.closest('.copy') || e.target.closest('.detailtoggle')) return;
    setSelectedLine(line);
    downX = e.clientX; downY = e.clientY;
  });
  if (copyOn) row.addEventListener('pointerup', (e) => {
    if (e.target.closest('.copy') || e.target.closest('.detailtoggle')) return;
    if (text.getAttribute('contenteditable') === 'true') return;     // 편집 중엔 복사 안 함
    const dist = Math.hypot(e.clientX - downX, e.clientY - downY);
    if (dist >= 4) return;                                            // 드래그면 선택만
    if (!getSelection().isCollapsed) return;                          // 선택 영역 있으면 복사 안 함
    const raw = e.shiftKey;
    row._copyTimer = setTimeout(() => copyRow(line.text, raw, row, copy, line.t), 180); // 원문 복사(더블클릭이면 취소됨)
  });
  row.addEventListener('dblclick', (e) => {
    if (e.target.closest('.copy') || e.target.closest('.detailtoggle')) return;
    clearTimeout(row._copyTimer);
    enterEdit(text, line, row);
  });
  row.addEventListener('contextmenu', (e) => {
    if (e.target.closest('.copy') || e.target.closest('.detailtoggle')) return;
    if (text.getAttribute('contenteditable') === 'true') return; // 편집 중엔 OS 기본 메뉴(붙여넣기 등)
    e.preventDefault();
    clearTimeout(row._copyTimer);
    showRowMenu(e.clientX, e.clientY, line, row);
  });

  return row;
}

function enterEdit(text, line, row) {
  text.setAttribute('contenteditable', 'true');
  text.textContent = line.text; // 편집은 원문 대상(마스킹 해제하고 진짜 값을 고침)
  text.focus(); caretEnd(text);
  const commit = () => {
    text.setAttribute('contenteditable', 'false');
    const v = text.textContent.trim();
    if (v === '') {
      const i = card.lines.indexOf(line);
      if (i >= 0) card.lines.splice(i, 1);
      if (selectedLine === line) setSelectedLine(null);
      row.remove();
    }
    else {
      line.text = v;
      delete line.header; delete line.details; delete line.expanded;
      paintMask(text, v);
    } // 저장 후 다시 마스킹 표시
    persistLines();
    if (renderCardBody) renderCardBody();
  };
  text.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); text.blur(); }
    if (e.key === 'Escape') { e.preventDefault(); text.blur(); }
  });
  text.addEventListener('blur', commit, { once: true });
}

function closeRowMenu() {
  const m = document.getElementById('rowmenu');
  if (m) m.remove();
}

// 줄 우클릭 메뉴(줄 삭제). 줄이 쌓이는 콜메모·할일 등에서 더블클릭→전체삭제 없이 한 번에 지우기.
function showRowMenu(x, y, line, row) {
  closeRowMenu();
  const menu = document.createElement('div');
  menu.className = 'ctxmenu'; menu.id = 'rowmenu';
  const del = document.createElement('button');
  del.type = 'button'; del.textContent = '줄 삭제';
  del.addEventListener('click', () => {
    const i = card.lines.indexOf(line);
    if (i >= 0) card.lines.splice(i, 1);
    if (selectedLine === line) setSelectedLine(null);
    row.remove();
    persistLines();
    closeRowMenu();
  });
  menu.appendChild(del);
  document.body.appendChild(menu);

  // 화면 밖으로 넘치지 않게 위치 보정
  const r = menu.getBoundingClientRect();
  menu.style.left = Math.max(2, Math.min(x, window.innerWidth - r.width - 4)) + 'px';
  menu.style.top = Math.max(2, Math.min(y, window.innerHeight - r.height - 4)) + 'px';

  // 바깥 클릭 · Esc · 창 포커스 해제 시 닫기(메뉴 연 클릭이 곧장 닫지 않게 다음 틱에 등록)
  setTimeout(() => {
    const cleanup = () => {
      document.removeEventListener('pointerdown', onDoc, true);
      document.removeEventListener('keydown', onKey, true);
      window.removeEventListener('blur', onBlur);
    };
    const onDoc = (ev) => { if (!ev.target.closest('#rowmenu')) { closeRowMenu(); cleanup(); } };
    const onKey = (ev) => { if (ev.key === 'Escape') { closeRowMenu(); cleanup(); } };
    const onBlur = () => { closeRowMenu(); cleanup(); };
    document.addEventListener('pointerdown', onDoc, true);
    document.addEventListener('keydown', onKey, true);
    window.addEventListener('blur', onBlur);
  }, 0);
}

// 말머리 드롭다운 채우기 — 패널 등록 목록(settings.headers) + 이 노트가 고른 값. 패널에서 목록이 바뀌면 다시 호출해 갱신.
function fillHeaderSelect(sel) {
  if (!sel || !card) return;
  const headers = Array.isArray(settings.headers) ? settings.headers : [];
  const cur = (card.format && card.format.header) || '';
  const opts = [''].concat(headers);
  if (cur && !headers.includes(cur)) opts.push(cur); // 목록에서 지워진 값도 이 노트에선 보존
  sel.innerHTML = '';
  for (const h of opts) { const o = document.createElement('option'); o.value = h; o.textContent = (h === '') ? '(없음)' : h; sel.appendChild(o); }
  sel.value = cur;
}

function supportsFind() { return card && (card.type === 'memo' || card.type === 'note' || card.type === 'callmemo'); }
function supportsReminder() { return card && (card.type === 'memo' || card.type === 'note' || card.type === 'callmemo'); }

function toLocalInputValue(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function fromLocalInputValue(v) {
  if (!v) return null;
  const t = new Date(v).getTime();
  return Number.isFinite(t) ? t : null;
}
function reminderLabel(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  return `${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function updateReminderButton() {
  const btn = document.getElementById('reminder');
  if (!btn) return;
  btn.classList.toggle('active', !!card.reminderAt);
  btn.title = card.reminderAt ? `알림: ${reminderLabel(card.reminderAt)}` : '알림 시간 설정';
}

function appendReminderBar(body) {
  if (!reminderOpen || !supportsReminder()) return;
  const bar = document.createElement('div');
  bar.className = 'rembar';
  const input = document.createElement('input');
  input.type = 'datetime-local';
  input.value = toLocalInputValue(card.reminderAt);
  const set = document.createElement('button');
  set.type = 'button'; set.textContent = '설정';
  const clear = document.createElement('button');
  clear.type = 'button'; clear.textContent = '해제';
  const msg = document.createElement('span');
  msg.className = 'remmsg';
  msg.textContent = card.reminderAt ? `${reminderLabel(card.reminderAt)} 예정` : '';
  set.addEventListener('click', async () => {
    const at = fromLocalInputValue(input.value);
    if (!at || at <= Date.now()) { msg.textContent = '미래 시간을 선택하세요.'; msg.classList.add('bad'); return; }
    const r = await window.api.setReminder(ID, at);
    if (r.ok) {
      card.reminderAt = r.reminderAt;
      msg.textContent = `${reminderLabel(card.reminderAt)} 예정`;
      msg.classList.remove('bad');
      updateReminderButton();
    } else {
      msg.textContent = '설정 실패';
      msg.classList.add('bad');
    }
  });
  clear.addEventListener('click', async () => {
    const r = await window.api.setReminder(ID, null);
    if (r.ok) {
      card.reminderAt = null;
      input.value = '';
      msg.textContent = '';
      msg.classList.remove('bad');
      updateReminderButton();
    }
  });
  bar.appendChild(input);
  bar.appendChild(set);
  bar.appendChild(clear);
  bar.appendChild(msg);
  body.appendChild(bar);
}

function createFindBar(body) {
  if (!findOpen || !supportsFind()) return null;
  const bar = document.createElement('div');
  bar.className = 'findbar';
  const input = document.createElement('input');
  input.type = 'search';
  input.placeholder = '검색';
  input.value = findTerm;
  const prev = document.createElement('button');
  prev.type = 'button'; prev.textContent = '‹'; prev.title = '이전';
  const next = document.createElement('button');
  next.type = 'button'; next.textContent = '›'; next.title = '다음';
  const status = document.createElement('span');
  status.className = 'findstatus';
  const close = document.createElement('button');
  close.type = 'button'; close.textContent = '×'; close.title = '닫기';
  close.addEventListener('click', () => {
    findOpen = false; findTerm = ''; findIndex = 0;
    const btn = document.getElementById('find'); if (btn) btn.classList.remove('active');
    if (renderCardBody) renderCardBody();
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); close.click(); }
    if (e.key === 'Enter') { e.preventDefault(); (e.shiftKey ? prev : next).click(); }
  });
  bar.appendChild(input);
  bar.appendChild(prev);
  bar.appendChild(next);
  bar.appendChild(status);
  bar.appendChild(close);
  body.appendChild(bar);
  setTimeout(() => { input.focus(); input.select(); }, 0);
  return { input, prev, next, status };
}

function lineHeader(line) {
  return (line && line.header) || String((line && line.text) || '').split(/\r?\n/)[0] || '';
}
function lineDetailsText(line) {
  if (!line) return '';
  if (Array.isArray(line.details) && line.details.length) {
    return line.details.map((d) => `${d.label || ''}${d.label ? ': ' : ''}${d.value || ''}`).join('\n');
  }
  return String(line.text || '').split(/\r?\n/).slice(1).join('\n');
}
function lineDisplayText(line) {
  const hasDetails = line && ((Array.isArray(line.details) && line.details.length > 1) || String(line.text || '').includes('\n'));
  return hasDetails ? lineHeader(line) : (line.text || '');
}

function renderList(body) {
  body.innerHTML = '';
  maskEls.length = 0; // 재렌더 시 표시 요소 레지스트리 초기화
  document.getElementById('fmt').style.display = card.type === 'todo' ? 'none' : ''; // 할일은 복사 서식 불필요
  appendReminderBar(body);
  const findCtl = createFindBar(body);

  // 복사 서식 편집 박스 (목록형 카드만). 재렌더(옵션 변경 등) 후에도 열림 상태 유지(fmtOpen).
  const fmtbox = document.createElement('div');
  fmtbox.className = 'fmtbox'; fmtbox.hidden = !fmtOpen || card.type === 'todo';
  // 노트 통합 서식: 화면 말머리 + 시각 기준 + 자동 삭제를 한 패널에(상용구·기록 메모 기능 합침). 복사 서식(fmtTpl)은 모든 토큰 자유 편집.
  fmtbox.innerHTML =
    '<label><input type="checkbox" id="copyOn"> 줄 클릭으로 복사</label>' +
    '<label><input type="checkbox" id="fmtOn"> 복사 시 서식 적용 (내용 앞에 붙음)</label>' +
    '<input class="tpl" id="fmtTpl" placeholder="예: [{날짜단축} {시간}] ">' +
    '<div class="tokens" id="tokchips"></div>' +
    '<div class="fmtgrid">' +
      '<label class="tb">말머리 <select id="hdrSel"></select></label>' +
      '<label class="tb">화면 말머리 <select id="timeDisp"><option value="off">끔</option><option value="time">시간만</option><option value="datetime">날짜+시간</option></select></label>' +
      '<label class="tb" title="복사 스탬프의 {시간}/{날짜}가 가리키는 시각. 복사 시점=복사하는 지금, 줄 작성시각=그 줄을 적은 때, 통화 시작=카드 생성 시각.">시각 기준 <select id="fmtBasis"><option value="now">복사 시점</option><option value="lineTime">줄 작성시각</option><option value="callStart">통화 시작</option></select></label>' +
      '<label class="tb" title="설정한 기간이 지난 줄은 다음 실행 시 자동으로 삭제됩니다(개인정보 보호). \'안 함\'이면 삭제하지 않습니다.">자동 삭제 <select id="ttlSel"><option value="0">안 함</option><option value="7">7일 후</option><option value="14">14일 후</option><option value="30">30일 후</option><option value="60">60일 후</option><option value="90">90일 후</option></select></label>' +
    '</div>' +
    '<div class="fmtfoot"><label class="tb" id="detailsFoldWrap"><input type="checkbox" id="detailsHidden"> 상세는 헤더만 보기</label><button type="button" id="noteImportBtn" class="fmtimport">파일 추가</button></div>';
  body.appendChild(fmtbox);
  const copyOnBox = fmtbox.querySelector('#copyOn');
  const fmtOn = fmtbox.querySelector('#fmtOn');
  const fmtTpl = fmtbox.querySelector('#fmtTpl');
  const timeDisp = fmtbox.querySelector('#timeDisp');
  copyOnBox.checked = card.copyMode !== false;
  fmtOn.checked = !!card.format.enabled;
  fmtTpl.value = card.format.template || '';
  copyOnBox.addEventListener('change', () => { card.copyMode = copyOnBox.checked; saveCard({ copyMode: card.copyMode }); renderList(body); });
  fmtOn.addEventListener('change', () => { card.format.enabled = fmtOn.checked; saveCard({ format: card.format }); });
  fmtTpl.addEventListener('input', () => { card.format.template = fmtTpl.value; saveCard({ format: card.format }); }); // 복사 서식 직접 편집(화면 말머리와 독립)
  const fmtBasis = fmtbox.querySelector('#fmtBasis');
  if (fmtBasis) { fmtBasis.value = card.format.timeBasis || 'now'; fmtBasis.addEventListener('change', () => { card.format.timeBasis = fmtBasis.value; saveCard({ format: card.format }); }); }

  // 토큰 칩: 클릭으로 복사 서식(fmtTpl)에 삽입 — '{ }' 직접 입력 부담 제거. 화면 말머리는 아래 select로 별도(독립).
  const tokchips = fmtbox.querySelector('#tokchips');
  const insertToken = (tok) => {
    fmtTpl.focus();
    const s = fmtTpl.selectionStart != null ? fmtTpl.selectionStart : fmtTpl.value.length;
    const e = fmtTpl.selectionEnd != null ? fmtTpl.selectionEnd : fmtTpl.value.length;
    fmtTpl.value = fmtTpl.value.slice(0, s) + tok + fmtTpl.value.slice(e);
    const pos = s + tok.length; try { fmtTpl.setSelectionRange(pos, pos); } catch (_) {}
    fmtTpl.dispatchEvent(new Event('input', { bubbles: true })); // 저장 핸들러 재사용
  };
  const tlbl = document.createElement('span'); tlbl.className = 'tklbl'; tlbl.textContent = '넣기'; tokchips.appendChild(tlbl);
  ['{날짜단축}', '{시간}', '{날짜}', '[{사용자ID}]', '[{말머리}]'].forEach((t) => { // 사용자ID·말머리는 기본 []로 감싸 삽입(불필요하면 템플릿에서 대괄호 삭제). {내용}은 자동으로 뒤에 붙음
    const b = document.createElement('button'); b.type = 'button'; b.className = 'tok'; b.textContent = t;
    b.addEventListener('click', (ev) => { ev.preventDefault(); insertToken(t); });
    tokchips.appendChild(b);
  });

  if (timeDisp) { // 화면 말머리(.time): 끔/시간/날짜+시간. 끔이면 줄 앞 시각 미표시(상용구처럼).
    timeDisp.value = ['off', 'time', 'datetime'].includes(card.timeDisplay) ? card.timeDisplay : 'off';
    timeDisp.addEventListener('change', () => { card.timeDisplay = timeDisp.value; saveCard({ timeDisplay: card.timeDisplay }); renderList(body); });
  }
  // 자동 삭제(보관기간) — 카드별. 0/미설정 = 삭제 안 함(purgeExpired 동작과 일치 → 기존 카드를 자동으로 삭제 켜지 않음). 변경은 다음 실행 시 반영.
  const ttlSel = fmtbox.querySelector('#ttlSel');
  if (ttlSel) {
    const cur = String(card.ttlDays > 0 ? card.ttlDays : 0);
    if (!Array.from(ttlSel.options).some((o) => o.value === cur)) { // 옵션에 없는 기존 커스텀 값 보존
      const o = document.createElement('option'); o.value = cur; o.textContent = cur + '일 후'; ttlSel.appendChild(o);
    }
    ttlSel.value = cur;
    ttlSel.addEventListener('change', () => { card.ttlDays = parseInt(ttlSel.value, 10) || 0; saveCard({ ttlDays: card.ttlDays }); });
  }
  // 말머리 드롭다운: 패널에 등록해 둔 말머리 목록(settings.headers)을 불러와 선택. 선택값은 {말머리} 토큰에 치환됨.
  const hdrSel = fmtbox.querySelector('#hdrSel');
  if (hdrSel) {
    fillHeaderSelect(hdrSel);
    hdrSel.addEventListener('change', () => { card.format.header = hdrSel.value; saveCard({ format: card.format }); });
  }
  const detailsHidden = fmtbox.querySelector('#detailsHidden');
  const detailsFoldWrap = fmtbox.querySelector('#detailsFoldWrap');
  if (detailsHidden && detailsFoldWrap) {
    detailsFoldWrap.style.display = card.type === 'note' ? '' : 'none';
    detailsHidden.checked = !!card.detailsHidden;
    detailsHidden.addEventListener('change', () => {
      card.detailsHidden = detailsHidden.checked;
      saveCard({ detailsHidden: card.detailsHidden, lines: card.lines });
      renderList(body);
    });
  }
  const noteImportBtn = fmtbox.querySelector('#noteImportBtn');
  if (noteImportBtn) {
    noteImportBtn.style.display = card.type === 'note' && appStatus.allowNoteFileUpload !== false ? '' : 'none';
    noteImportBtn.addEventListener('click', async () => {
      const r = await window.api.pickNoteUpload();
      if (!r.ok) {
        noteImportBtn.textContent = r.reason === 'canceled' ? '취소됨' : (r.reason === 'tooManyColumns' ? '1열만 가능' : (r.reason === 'protected' ? '보안문서 차단' : (r.reason === 'disabled' ? '비활성화됨' : '업로드 실패')));
        setTimeout(() => { noteImportBtn.textContent = '파일 추가'; }, 1200);
        return;
      }
      card.lines = (card.lines || []).concat(r.lines);
      if (r.hasDetails) card.detailsHidden = true;
      saveCard({ lines: card.lines, detailsHidden: card.detailsHidden });
      renderList(body);
    });
  }
  document.getElementById('fmt').onclick = () => { fmtOpen = !fmtOpen; fmtbox.hidden = !fmtOpen; };

  const list = document.createElement('div');
  list.className = 'list';
  card.lines = card.lines || [];
  const rowEntries = [];
  for (const line of card.lines) {
    const row = makeRow(line);
    rowEntries.push({ row, line });
    list.appendChild(row);
  }

  // 유령 빈 줄: 입력 후 Enter=새 줄. 멀티라인 붙여넣기는 Ctrl+클릭 또는 전용 버튼(더블클릭은 '수정' 전용이라 충돌 제거).
  const ghost = document.createElement('div');
  ghost.className = 'row ghost';
  const gtext = document.createElement('span');
  gtext.className = 'text'; gtext.setAttribute('contenteditable', 'true');
  gtext.setAttribute('data-ph', '입력 후 Enter · Ctrl+클릭 또는 ⎘ = 붙여넣기');
  ghost.appendChild(gtext);
  const gpaste = document.createElement('button');
  gpaste.className = 'gpaste'; gpaste.title = '클립보드 붙여넣기(여러 줄=여러 칸)'; gpaste.textContent = '⎘';
  ghost.appendChild(gpaste);
  list.appendChild(ghost);

  const addLine = (txt) => {
    const ln = { text: txt };
    if (card.type === 'callmemo' || card.type === 'note') ln.t = Date.now(); // 노트: 줄 작성 시각 기록(화면 말머리·줄 시각 기준용)
    if (card.type === 'todo') { ln.checkable = true; ln.done = false; }
    card.lines.push(ln);
    list.insertBefore(makeRow(ln), ghost);
    setSelectedLine(ln);
    persistLines();
  };
  // 클립보드를 줄 단위로 분할해 각 줄을 새 칸으로 추가(줄 trim·빈 줄 제거; PII는 마스킹 안 한 원문 저장 — 화면만 makeRow가 마스킹).
  const pasteMulti = async () => {
    const t = await window.api.readClipboard();
    if (!t) return;
    const parts = t.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    for (const p of parts) addLine(p);
    gtext.textContent = '';
  };
  gtext.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      const v = gtext.textContent.trim();
      if (v) { addLine(v); gtext.textContent = ''; }
    }
  });
  gpaste.addEventListener('click', (e) => { e.stopPropagation(); e.preventDefault(); pasteMulti(); });
  ghost.addEventListener('click', (e) => { if ((e.ctrlKey || e.metaKey) && !e.target.closest('.gpaste')) { e.preventDefault(); pasteMulti(); } }); // Ctrl+클릭=붙여넣기

  body.appendChild(list);
  if (findCtl) {
    const applyListFind = () => {
      const q = findTerm.trim().toLowerCase();
      const hits = [];
      for (const item of rowEntries) {
        const hit = q && String(item.line.text || '').toLowerCase().includes(q);
        item.row.hidden = !!q && !hit;
        item.row.classList.toggle('search-hit', !!hit);
        item.row.classList.remove('search-active');
        if (hit) hits.push(item.row);
      }
      ghost.hidden = !!q;
      if (!q) { findCtl.status.textContent = ''; return; }
      if (!hits.length) { findCtl.status.textContent = '0/0'; return; }
      if (findIndex >= hits.length) findIndex = 0;
      if (findIndex < 0) findIndex = hits.length - 1;
      const active = hits[findIndex];
      active.classList.add('search-active');
      active.scrollIntoView({ block: 'nearest' });
      findCtl.status.textContent = `${findIndex + 1}/${hits.length}`;
    };
    findCtl.input.addEventListener('input', () => { findTerm = findCtl.input.value; findIndex = 0; applyListFind(); });
    findCtl.next.addEventListener('click', () => { findIndex += 1; applyListFind(); });
    findCtl.prev.addEventListener('click', () => { findIndex -= 1; applyListFind(); });
    applyListFind();
  }

  if (card.type === 'callmemo' || card.type === 'note') { // ④b 전체(양식) 복사 — 줄 누적 노트
    const actions = document.createElement('div');
    actions.className = 'listactions';
    const allBtn = document.createElement('button');
    allBtn.className = 'allcopy'; allBtn.textContent = '전체복사';
    allBtn.addEventListener('click', () => {
      const out = card.lines.map((l) => applyStamp(l.text, card.format, false, l.t)).join('\n');
      window.api.copyText(out);
      allBtn.textContent = '복사됨 ✓'; setTimeout(() => { allBtn.textContent = '전체복사'; }, 1000);
    });
    actions.appendChild(allBtn);
    body.appendChild(actions);
  }

  const hint = document.createElement('div');
  hint.className = 'hint'; hint.textContent = '줄 클릭=복사 · 더블클릭=수정 · 드래그=선택';
  body.appendChild(hint);
  updateFormatBarControls();
}

function renderMemo(body) {
  document.getElementById('fmt').style.display = 'none'; // 메모는 줄복사 없음
  body.innerHTML = '';
  maskEls.length = 0; // 재렌더 시 표시 요소 레지스트리 초기화
  appendReminderBar(body);
  const findCtl = createFindBar(body);
  const wrap = document.createElement('div');
  wrap.className = 'memowrap';
  const toolRows = (reminderOpen && supportsReminder() ? 1 : 0) + (findOpen && supportsFind() ? 1 : 0);
  if (toolRows) wrap.style.height = `calc(100% - ${toolRows * 36}px)`;
  const ta = document.createElement('textarea');
  ta.className = 'memo'; ta.value = (card.content && card.content.text) || '';
  ta.placeholder = '메모…'; ta.spellcheck = false;
  // PII 마스킹 오버레이(SE-6): 미포커스 + PII 있음 + 비공개일 때 textarea 위에 가린 텍스트 표시.
  // 원문은 항상 textarea가 보유(비파괴) — 포커스하면 오버레이를 숨겨 원문을 그대로 편집/복사.
  const overlay = document.createElement('div');
  overlay.className = 'memomask'; overlay.setAttribute('aria-hidden', 'true');
  const syncOverlay = () => {
    const masked = document.activeElement !== ta && !revealed && hasPII(ta.value);
    overlay.textContent = masked ? display(ta.value) : '';
    overlay.style.display = masked ? '' : 'none';
    if (masked) overlay.scrollTop = ta.scrollTop; // 긴 메모: 가린 오버레이를 textarea 스크롤 위치에 맞춤
  };
  ta.addEventListener('input', () => {
    card.content = { text: ta.value };
    saveCard({ content: card.content });
  });
  ta.addEventListener('focus', syncOverlay);
  ta.addEventListener('blur', syncOverlay);
  ta.addEventListener('scroll', () => { if (overlay.style.display !== 'none') overlay.scrollTop = ta.scrollTop; }); // 가린 상태 휠 스크롤 동기화(원문 노출 없이 아래 내용 확인)
  wrap.appendChild(ta); wrap.appendChild(overlay);
  body.appendChild(wrap);
  if (findCtl) {
    const ranges = () => {
      const q = findTerm.trim().toLowerCase();
      if (!q) return [];
      const text = ta.value.toLowerCase();
      const out = [];
      let i = text.indexOf(q);
      while (i >= 0 && out.length < 500) {
        out.push([i, i + q.length]);
        i = text.indexOf(q, i + Math.max(q.length, 1));
      }
      return out;
    };
    const applyMemoFind = (jump) => {
      const hits = ranges();
      if (!findTerm.trim()) { findCtl.status.textContent = ''; return; }
      if (!hits.length) { findCtl.status.textContent = '0/0'; return; }
      if (findIndex >= hits.length) findIndex = 0;
      if (findIndex < 0) findIndex = hits.length - 1;
      const [s, e] = hits[findIndex];
      if (jump) ta.focus();
      ta.setSelectionRange(s, e);
      findCtl.status.textContent = `${findIndex + 1}/${hits.length}`;
    };
    findCtl.input.addEventListener('input', () => { findTerm = findCtl.input.value; findIndex = 0; applyMemoFind(false); });
    findCtl.next.addEventListener('click', () => { findIndex += 1; applyMemoFind(true); });
    findCtl.prev.addEventListener('click', () => { findIndex -= 1; applyMemoFind(true); });
    applyMemoFind(false);
  }
  maskEls.push({ el: overlay, getRaw: () => ta.value, repaint: syncOverlay }); // 👁 토글·설정 변경 시 refreshMask가 호출
  syncOverlay();
}

function renderTable(body) {
  document.getElementById('fmt').style.display = 'none'; // 표는 줄 스탬프 없음
  body.innerHTML = '';
  maskEls.length = 0; // 재렌더 시 표시 요소 레지스트리 초기화
  if (!Array.isArray(card.rows) || !card.rows.length) card.rows = [['항목', '값'], ['', '']];
  const saveRows = () => saveCard({ rows: card.rows });
  const cols = () => card.rows.reduce((m, r) => Math.max(m, r.length), 1);

  let editMode = false; // 보기(기본)=클릭 복사 / 편집=클릭 수정. 한 모드에 한 동작만 → 예측 가능.

  const mkBtn = (label, fn, title) => { const b = document.createElement('button'); b.textContent = label; if (title) b.title = title; b.addEventListener('click', fn); return b; };
  const ctrl = document.createElement('div'); ctrl.className = 'tctrl';
  const wrap = document.createElement('div'); wrap.className = 'twrap';

  // 행/열 추가·삭제
  const addRow = () => { card.rows.push(new Array(cols()).fill('')); saveRows(); draw(); };
  const addCol = () => { const c = cols(); card.rows.forEach((r) => { while (r.length < c) r.push(''); r.push(''); }); saveRows(); draw(); };
  const delRow = (ri) => { if (card.rows.length <= 1) return tip('행이 하나뿐입니다.'); card.rows.splice(ri, 1); saveRows(); draw(); };
  const delCol = (ci) => { if (cols() <= 1) return tip('열이 하나뿐입니다.'); card.rows.forEach((r) => { if (ci < r.length) r.splice(ci, 1); }); saveRows(); draw(); };

  // 편집 모드 셀 이동(Tab=다음 칸, Enter=아래 칸; 끝에서 새 행 자동 추가)
  const focusCell = (r, c) => { const el = wrap.querySelector('td[data-r="' + r + '"][data-c="' + c + '"]'); if (el) { el.focus(); caretEnd(el); } };
  const navKey = (e, ri, ci) => {
    const n = cols();
    if (e.key === 'Tab') {
      e.preventDefault();
      let r = ri, c = ci + (e.shiftKey ? -1 : 1);
      if (c >= n) { c = 0; r++; if (r >= card.rows.length) addRow(); }
      else if (c < 0) { c = n - 1; r = Math.max(0, ri - 1); }
      focusCell(r, c);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      let r = ri + (e.shiftKey ? -1 : 1);
      if (r >= card.rows.length) addRow();
      if (r < 0) r = 0;
      focusCell(r, ci);
    } else if (e.key === 'Escape') { e.preventDefault(); e.target.blur(); }
  };

  // ── 보기 모드 셀 범위 선택(드래그=셀 단위, 텍스트 커서 위치와 무관). Ctrl+C로 TSV 복사 ──
  let selecting = false, dragged = false, selAnchor = null, selFocus = null;
  const selRange = () => (!selAnchor || !selFocus) ? null : {
    r0: Math.min(selAnchor.r, selFocus.r), r1: Math.max(selAnchor.r, selFocus.r),
    c0: Math.min(selAnchor.c, selFocus.c), c1: Math.max(selAnchor.c, selFocus.c),
  };
  const paintSel = () => {
    const s = selRange();
    wrap.querySelectorAll('td[data-r]').forEach((td) => {
      const r = +td.dataset.r, c = +td.dataset.c;
      td.classList.toggle('selected', !!s && r >= s.r0 && r <= s.r1 && c >= s.c0 && c <= s.c1);
    });
  };
  const clearSel = () => { selAnchor = selFocus = null; selecting = false; dragged = false; paintSel(); };
  const cellVal = (r, c) => (card.rows[r] && card.rows[r][c] != null ? String(card.rows[r][c]) : '');
  const copySel = () => {
    const s = selRange(); if (!s) return false;
    // 범위 복사는 화면 그대로(마스킹 반영) — 대량 PII 유출 방지(Codex P1-1, 사용자 결정). 👁 공개(revealed) 중이면 원문.
    const out = [];
    for (let r = s.r0; r <= s.r1; r++) {
      const row = [];
      for (let c = s.c0; c <= s.c1; c++) { const raw = cellVal(r, c); row.push(revealed ? raw : display(raw)); }
      out.push(row.join('\t'));
    }
    window.api.copyText(out.join('\n'));
    return true;
  };

  const draw = () => {
    wrap.innerHTML = '';
    selAnchor = selFocus = null; selecting = false; dragged = false; // 재렌더 시 선택 초기화
    maskEls.length = 0; // 표 전체 재구성 — 셀 레지스트리 초기화(누수 방지)
    const n = cols();
    const table = document.createElement('table'); table.className = 'tbl';

    if (editMode) { // 편집 모드에서만 열 삭제 핸들 행(모서리 빈칸 + 열마다 ✕)
      const headtr = document.createElement('tr'); headtr.className = 'ctrlrow';
      headtr.appendChild(Object.assign(document.createElement('td'), { className: 'corner' }));
      for (let ci = 0; ci < n; ci++) {
        const ch = document.createElement('td'); ch.className = 'coldel'; const cc = ci;
        const b = document.createElement('button'); b.className = 'delbtn'; b.textContent = '✕'; b.title = '이 열 삭제';
        b.addEventListener('click', () => delCol(cc));
        ch.appendChild(b); headtr.appendChild(ch);
      }
      table.appendChild(headtr);
    }

    card.rows.forEach((row, ri) => {
      const tr = document.createElement('tr');
      if (editMode) { // 행 삭제 핸들(왼쪽 ✕)
        const gut = document.createElement('td'); gut.className = 'rowdel'; const rr = ri;
        const rb = document.createElement('button'); rb.className = 'delbtn'; rb.textContent = '✕'; rb.title = '이 행 삭제';
        rb.addEventListener('click', () => delRow(rr));
        gut.appendChild(rb); tr.appendChild(gut);
      }
      for (let ci = 0; ci < n; ci++) {
        const td = document.createElement('td');
        const cr = ri, cc = ci;
        if (editMode) {
          // 편집: 셀=수정 전용(원문 표시, 포커스된 칸만 강조). 복사/마스킹 없음.
          td.setAttribute('contenteditable', 'true');
          td.dataset.r = ri; td.dataset.c = ci;
          td.textContent = card.rows[cr][cc] != null ? card.rows[cr][cc] : '';
          td.addEventListener('input', () => { while (card.rows[ri].length <= ci) card.rows[ri].push(''); card.rows[ri][ci] = td.textContent; saveRows(); });
          td.addEventListener('keydown', (e) => navKey(e, ri, ci));
        } else {
          // 보기: 셀=복사 전용. 클릭=한 칸 원문 복사 / 드래그=셀 범위 선택(엑셀 호환 TSV). 셀 단위로 쉽게 선택.
          td.setAttribute('contenteditable', 'false');
          td.dataset.r = ri; td.dataset.c = ci;
          registerMask(td, () => (card.rows[cr] && card.rows[cr][cc] != null ? card.rows[cr][cc] : ''));
          td.addEventListener('pointerdown', (e) => {
            if (e.button !== 0) return;
            if (selAnchor) clearSel();                          // 이전 범위 해제
            selecting = true; dragged = false;
            selAnchor = { r: cr, c: cc }; selFocus = { r: cr, c: cc };
          });
          td.addEventListener('pointerenter', () => { if (selecting) { dragged = true; selFocus = { r: cr, c: cc }; paintSel(); } });
        }
        tr.appendChild(td);
      }
      table.appendChild(tr);
    });
    wrap.appendChild(table);
  };

  const hint = document.createElement('div');
  hint.className = 'hint';
  const VIEW_HINT = '보기: 셀 클릭=복사 · 드래그=범위 선택(엑셀) · 수정하려면 ✏ 편집';
  const EDIT_HINT = '편집: 셀 클릭=수정 · Tab=다음 칸 · Enter=아래 칸 · 행 왼쪽·열 위 ✕=삭제';
  let HINT = VIEW_HINT;
  hint.textContent = HINT;
  let undoRows = null;
  const tip = (msg, ms) => { hint.textContent = msg; setTimeout(() => { if (!undoRows) hint.textContent = HINT; }, ms || 3000); };
  const dims = (rows) => rows.length + '×' + rows.reduce((m, r) => Math.max(m, r.length), 1);

  // 클립보드 TSV 파싱(크기 상한으로 거대 붙여넣기 프리즈 방지 P2).
  const parseTSV = (t) => {
    let lines = t.replace(/\r/g, '').split('\n');
    if (lines.length && lines[lines.length - 1] === '') lines.pop();
    return lines.slice(0, 500).map((l) => l.split('\t').slice(0, 50));
  };
  // 엑셀/CRM은 표를 HTML(table)로도 클립보드에 올림 — 차원이 가장 정확하므로 우선 사용, 실패 시 TSV 텍스트 폴백.
  const parseHTMLTable = (html) => {
    if (!html || !/<table[\s>]/i.test(html)) return null;
    let doc; try { doc = new DOMParser().parseFromString(html, 'text/html'); } catch (_) { return null; }
    const table = doc.querySelector('table'); if (!table) return null;
    const rows = [];
    table.querySelectorAll('tr').forEach((tr) => {
      const cells = [];
      tr.querySelectorAll('th,td').forEach((c) => cells.push((c.textContent || '').replace(/ /g, ' ').trim()));
      if (cells.length) rows.push(cells);
    });
    return rows.length ? rows.slice(0, 500).map((r) => r.slice(0, 50)) : null;
  };
  let lastDiag = '';
  const getClipTable = async () => {
    const hasHtml = typeof window.api.readClipboardHTML === 'function';
    let html = '', text = '';
    if (hasHtml) { try { html = (await window.api.readClipboardHTML()) || ''; } catch (_) { html = ''; } }
    try { text = (await window.api.readClipboard()) || ''; } catch (_) { text = ''; }
    lastDiag = `API:${hasHtml ? 'ok' : '없음(재시작필요)'} · HTML ${html.length}자(table:${/<table/i.test(html) ? 'O' : 'X'}) · 텍스트 ${text.length}자(탭${/\t/.test(text) ? 'O' : 'X'}·줄${/\n/.test(text) ? 'O' : 'X'})`;
    const r = parseHTMLTable(html); if (r && r.length) return r;
    if (text && /[\t\n]/.test(text)) { const p = parseTSV(text); if (p.length) return p; }
    return null;
  };

  const isEmpty = () => card.rows.every((r) => r.every((c) => c == null || String(c).trim() === ''));
  const showResult = (msg) => {
    hint.textContent = msg;
    const undo = document.createElement('button');
    undo.className = 'tundo'; undo.textContent = '되돌리기';
    undo.addEventListener('click', () => { if (!undoRows) return; card.rows = undoRows; undoRows = null; saveRows(); draw(); hint.textContent = HINT; });
    hint.appendChild(undo);
  };
  // mode: 'replace'=전체 교체(확인) / 'append'=맨 아래 이어붙이기. 둘 다 1단계 되돌리기 제공.
  const doPaste = async (mode) => {
    try { window.focus(); } catch (_) {}
    hint.textContent = '클립보드 읽는 중…'; // 즉시 피드백(버튼이 눌렸음을 보장 — 무반응/못읽음 구분)
    const rows = await getClipTable();
    if (!rows) return tip('표 못읽음 · ' + lastDiag, 9000); // 진단: 클립보드에 실제로 무엇이 들어왔는지 표시
    if (mode === 'append') {
      undoRows = card.rows.map((r) => r.slice());
      if (isEmpty()) card.rows = []; // 빈 기본표면 교체처럼
      rows.forEach((r) => card.rows.push(r.slice()));
      const c = cols(); card.rows.forEach((r) => { while (r.length < c) r.push(''); }); // 열 수 정렬
      saveRows(); draw(); showResult('표를 아래에 ' + dims(rows) + ' 이어붙였습니다 · ');
    } else {
      if (!isEmpty() && !window.confirm('현재 표를 붙여넣은 내용으로 바꿉니다.\n(되돌리기로 한 번 복구 가능)\n\n계속할까요?')) return;
      undoRows = card.rows.map((r) => r.slice());
      card.rows = rows.map((r) => r.slice()); saveRows(); draw();
      showResult('표를 ' + dims(rows) + '로 바꿨습니다 · ');
    }
  };

  // 컨트롤 바: 모드 토글 + (편집일 때만 +행/+열) + 붙여넣기. 모드에 따라 다시 그림.
  const editBtn = document.createElement('button'); editBtn.className = 'modetoggle';
  const renderCtrl = () => {
    ctrl.innerHTML = '';
    editBtn.textContent = editMode ? '✓ 편집 중 — 끝내기' : '✏ 편집';
    editBtn.title = editMode ? '편집을 끝내고 보기 모드로' : '셀을 수정하려면 켜세요';
    editBtn.classList.toggle('active', editMode);
    ctrl.appendChild(editBtn);
    if (editMode) { // 붙여넣기/추가/삭제는 전부 편집 동작 → 편집 모드에서만. 보기 모드는 복사 전용.
      ctrl.appendChild(mkBtn('+행', addRow, '맨 아래 빈 행'));
      ctrl.appendChild(mkBtn('+열', addCol, '오른쪽 빈 열'));
      ctrl.appendChild(mkBtn('표 붙여넣기', () => doPaste('replace'), '클립보드의 표로 전체 교체 · Ctrl+V'));
      ctrl.appendChild(mkBtn('표 아래 추가', () => doPaste('append'), '클립보드의 표를 맨 아래에 이어붙이기'));
    }
  };
  const setMode = (on) => {
    editMode = on; HINT = on ? EDIT_HINT : VIEW_HINT;
    document.body.classList.toggle('tedit', on);
    renderCtrl(); draw();
    hint.textContent = HINT;
  };
  editBtn.addEventListener('click', () => setMode(!editMode));

  body.appendChild(ctrl);
  body.appendChild(wrap);
  body.appendChild(hint);
  // 새 표(헤더만 있거나 빈 표)는 편집 모드로 시작, 데이터가 있으면 보기 모드로 시작.
  const fresh = card.rows.slice(1).every((r) => r.every((c) => c == null || String(c).trim() === ''));
  setMode(fresh);

  // 드래그 종료: 단일 셀이면 그 칸 복사, 범위면 선택 유지(Ctrl+C로 TSV 복사).
  document.addEventListener('pointerup', () => {
    if (!selecting) return;
    selecting = false;
    const s = selRange();
    if (!dragged && selAnchor) { // 단일 클릭 = 그 칸 원문 복사
      const td = wrap.querySelector('td[data-r="' + selAnchor.r + '"][data-c="' + selAnchor.c + '"]');
      window.api.copyText(cellVal(selAnchor.r, selAnchor.c));
      if (td) { td.classList.add('copied'); setTimeout(() => td.classList.remove('copied'), 800); }
      clearSel();
    } else if (s && (s.r0 !== s.r1 || s.c0 !== s.c1)) { // 범위 선택 완료
      tip('범위 선택됨 · Ctrl+C로 복사', 3000);
    }
  });
  // 보기 모드: Ctrl+C=선택 범위 TSV 복사, Esc=선택 해제.
  document.addEventListener('keydown', (e) => {
    if (editMode) return;
    if ((e.ctrlKey || e.metaKey) && (e.key || '').toLowerCase() === 'c') { if (copySel()) { e.preventDefault(); tip('범위 복사됨', 1500); } }
    else if (e.key === 'Escape') clearSel();
  });

  // Ctrl+V: 편집 칸 포커스면 기본(셀 안 붙여넣기), 아니면 표 전체 교체. (paste 이벤트가 안 떠서 keydown으로 처리)
  document.addEventListener('keydown', (e) => {
    if (!(e.ctrlKey || e.metaKey) || (e.key || '').toLowerCase() !== 'v') return;
    if (!editMode) return; // 붙여넣기는 편집 모드에서만(보기 = 복사 전용)
    const ae = document.activeElement;
    if (ae && ae.getAttribute && ae.getAttribute('contenteditable') === 'true') return;
    e.preventDefault();
    doPaste('replace');
  });
}

function setupBar() {
  const title = document.getElementById('title');
  title.textContent = card.title || '';
  // 제목 영역도 창 이동(drag) 영역. 이름 변경은 연필 버튼으로만 진입(드래그 영역은 클릭 편집이 불안정).
  const rename = document.getElementById('rename');
  rename.innerHTML = PENCIL_SVG;
  const startRename = () => { title.classList.add('editing'); title.contentEditable = 'true'; title.focus(); caretEnd(title); };
  rename.addEventListener('click', startRename);
  title.addEventListener('blur', () => {
    title.classList.remove('editing'); title.contentEditable = 'false';
    card.title = title.textContent.trim() || ({ note: '노트', snippet: '상용구', callmemo: '기록 메모', memo: '메모', table: '표', todo: '할일' }[card.type] || '메모');
    title.textContent = card.title;
    saveCard({ title: card.title });
  });
  title.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === 'Escape') { e.preventDefault(); title.blur(); } });

  const findBtn = document.getElementById('find');
  findBtn.innerHTML = SEARCH_SVG;
  findBtn.style.display = supportsFind() ? '' : 'none';
  findBtn.onclick = () => {
    findOpen = !findOpen;
    findBtn.classList.toggle('active', findOpen);
    if (findOpen) findIndex = 0;
    if (renderCardBody) renderCardBody();
  };
  document.addEventListener('keydown', (e) => {
    if (!(e.ctrlKey || e.metaKey) || (e.key || '').toLowerCase() !== 'f' || !supportsFind()) return;
    e.preventDefault();
    findOpen = true;
    findBtn.classList.add('active');
    if (renderCardBody) renderCardBody();
  });

  const reminder = document.getElementById('reminder');
  reminder.innerHTML = BELL_SVG;
  reminder.style.display = supportsReminder() ? '' : 'none';
  reminder.onclick = () => {
    reminderOpen = !reminderOpen;
    if (renderCardBody) renderCardBody();
  };
  updateReminderButton();

  const pin = document.getElementById('pin');
  pin.innerHTML = PIN_SVG;
  if (card.alwaysOnTop) pin.classList.add('active');
  pin.onclick = () => {
    card.alwaysOnTop = !card.alwaysOnTop;
    pin.classList.toggle('active', card.alwaysOnTop);
    window.api.updateCard(ID, { alwaysOnTop: card.alwaysOnTop });
  };

  const fold = document.getElementById('fold');
  const setFoldIcon = () => { fold.innerHTML = card.collapsed ? CHEVRON_DOWN_SVG : CHEVRON_UP_SVG; }; // 접힘=펼치기(∨) / 펼침=접기(∧)
  if (card.collapsed) document.documentElement.classList.add('collapsed');
  setFoldIcon();
  const setCollapsed = (val) => {
    if (!!card.collapsed === !!val) return;
    card.collapsed = !!val;
    document.documentElement.classList.toggle('collapsed', card.collapsed);
    setFoldIcon();
    window.api.collapse(ID, card.collapsed);
  };
  setCardCollapsed = setCollapsed; // 패널 더블클릭 신호에서 펼치기 호출(item 1)
  fold.onclick = () => setCollapsed(!card.collapsed);
  // 헤더 더블클릭으로도 접기/펼치기 (이름 편집 중 단어 선택과 겹치지 않게 제외)
  title.addEventListener('dblclick', () => { if (!title.classList.contains('editing')) setCollapsed(!card.collapsed); });

  // 헤더 수동 드래그: pointer capture로 창 밖 pointerup·리스너 누수 방지(H-1/H-3). 4px 임계값으로 클릭/더블클릭과 분리(H-6).
  // 기준 크기·위치는 메인이 dragStart에서 캡처(렌더러 비동기 레이스 없음 H-4). 델타만 전송.
  let drag = null;
  const onPointerMove = (e) => {
    if (!drag) return;
    const dx = e.screenX - drag.sx, dy = e.screenY - drag.sy;
    if (!drag.moved && Math.hypot(dx, dy) < 4) return;
    drag.moved = true; drag.dx = dx; drag.dy = dy;
    if (!drag.raf) drag.raf = requestAnimationFrame(() => { drag.raf = 0; if (drag && drag.moved) window.api.dragMove(ID, drag.dx, drag.dy); });
  };
  const endDrag = () => {
    if (!drag) return;
    if (drag.raf) cancelAnimationFrame(drag.raf);
    if (drag.moved) window.api.dragMove(ID, drag.dx, drag.dy); // 마지막 위치 확정
    window.api.dragEnd(ID);
    title.removeEventListener('pointermove', onPointerMove);
    title.removeEventListener('pointerup', endDrag);
    title.removeEventListener('pointercancel', endDrag);
    drag = null;
  };
  title.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || title.classList.contains('editing')) return;
    drag = { sx: e.screenX, sy: e.screenY, dx: 0, dy: 0, moved: false, raf: 0 };
    try { title.setPointerCapture(e.pointerId); } catch (_) {}
    window.api.dragStart(ID);
    title.addEventListener('pointermove', onPointerMove);
    title.addEventListener('pointerup', endDrag);
    title.addEventListener('pointercancel', endDrag);
  });

  document.getElementById('close').onclick = () => window.api.hideCard(ID); // X = 숨김(삭제는 패널에서 확인 후)

  const reveal = document.getElementById('reveal'); // 👁 PII 잠시 공개(자동 재마스킹 + 워터마크)
  reveal.onclick = () => setReveal(!revealed);
  // 메모 카드도 PII 마스킹(SE-6, 오버레이) 적용 → 👁 공개 버튼 유지
}

// 붙여넣기는 항상 평문(text/plain)으로 삽입 — 리치 텍스트(예: 링크 앵커 'NAVER')가 아니라 원본 문자열(URL 등)이 들어가게.
// 더블클릭/Ctrl+클립보드 수집 경로(readClipboard=평문)와 Ctrl+V 경로의 결과를 일치시킨다.
function forcePlainPaste(e) {
  const t = e.target;
  if (!t || !t.getAttribute || t.getAttribute('contenteditable') !== 'true') return; // textarea/기타는 기본(이미 평문)
  const cd = e.clipboardData || window.clipboardData;
  if (!cd) return;
  e.preventDefault();
  document.execCommand('insertText', false, cd.getData('text/plain'));
}

function playFlash(count = 1) {
  if (setCardCollapsed) setCardCollapsed(false);
  const el = document.documentElement;
  const flashes = Math.max(1, Math.min(5, Math.floor(Number(count) || 1)));
  let done = 0;
  if (flashTimer) clearTimeout(flashTimer);
  const run = () => {
    el.classList.remove('flash');
    void el.offsetWidth;
    el.classList.add('flash');
    done += 1;
    flashTimer = setTimeout(() => {
      if (done < flashes) run();
      else {
        el.classList.remove('flash');
        flashTimer = null;
      }
    }, 700);
  };
  run();
}

// ── 하단 서식 툴바 ──────────────────────────────────────────────────────
// 배경은 스와치별 본문/헤더 색쌍으로 고정한다. 기존 card.bg(hex)도 같은 본문색이면 자동 매칭.
const BG_PRESETS = [
  { key: '', body: '#ffffff', header: '#f3f4f6', border: '#e3e5e8', label: '배경 없음' },
  { key: 'yellow', body: '#fffbe6', header: '#f2d46b', border: '#ddb94b', label: '노랑' },
  { key: 'blue', body: '#eef4ff', header: '#c8dcff', border: '#9dbcf4', label: '파랑' },
  { key: 'green', body: '#eafaf0', header: '#bfe8cc', border: '#91d1a9', label: '초록' },
  { key: 'rose', body: '#fdeef2', header: '#f4c3d0', border: '#e69caf', label: '분홍' },
  { key: 'purple', body: '#f1ecfb', header: '#d9cbf3', border: '#bba6e5', label: '보라' },
  { key: 'gray', body: '#eef0f3', header: '#d3d8df', border: '#bac2cd', label: '회색' },
];
function bgPreset() {
  return BG_PRESETS.find((p) => p.key === (card.bgKey || '')) ||
    BG_PRESETS.find((p) => p.body.toLowerCase() === String(card.bg || '').toLowerCase()) ||
    BG_PRESETS[0];
}
function applyCardBg() {
  const p = bgPreset();
  document.body.style.background = p.body;
  const bar = document.querySelector('.bar');
  if (bar) {
    bar.style.background = p.header;
    bar.style.borderBottomColor = p.border;
  }
  document.querySelectorAll('.memo, .memomask').forEach((el) => { el.style.background = p.body; });
}
function renderFormatBar() {
  const bar = document.getElementById('wmbar');
  if (!bar) return;
  bar.innerHTML = '';
  bar.hidden = false;
  const curBg = bgPreset();

  const bgGroup = document.createElement('div'); bgGroup.className = 'wmgroup';
  const lbl = document.createElement('span'); lbl.className = 'wmlbl'; lbl.textContent = '배경'; bgGroup.appendChild(lbl);
  BG_PRESETS.forEach((p) => {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'sw' + (p.key ? '' : ' none');
    if (p.key) b.style.background = `linear-gradient(135deg, ${p.header} 0 48%, ${p.body} 52% 100%)`;
    b.title = p.label;
    if (curBg.key === p.key) b.classList.add('active');
    b.addEventListener('click', () => {
      card.bgKey = p.key || undefined;
      card.bg = p.key ? p.body : undefined;
      saveCard({ bgKey: card.bgKey, bg: card.bg });
      applyCardBg();
      bgGroup.querySelectorAll('.sw').forEach((s) => s.classList.remove('active')); b.classList.add('active');
    });
    bgGroup.appendChild(b);
  });
  bar.appendChild(bgGroup);

  if (supportsLineFormatting()) {
    const textGroup = document.createElement('div'); textGroup.className = 'wmgroup';
    const textLbl = document.createElement('span'); textLbl.className = 'wmlbl'; textLbl.textContent = '글자'; textGroup.appendChild(textLbl);
    [
      { key: 'bold', label: 'B', title: '선택한 줄 굵게' },
      { key: 'strike', label: 'S', title: '선택한 줄 취소선' },
    ].forEach((item) => {
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'toolbtn'; b.textContent = item.label; b.title = item.title;
      b.dataset.lineStyle = item.key;
      b.addEventListener('click', () => {
        if (!selectedLine) return;
        selectedLine[item.key] = !selectedLine[item.key];
        persistLines();
        updateFormatBarControls();
        if (renderCardBody) renderCardBody();
      });
      textGroup.appendChild(b);
    });
    bar.appendChild(textGroup);
  }

  if (supportsChecklistMode()) {
    const checkGroup = document.createElement('div'); checkGroup.className = 'wmgroup';
    const checkLbl = document.createElement('span'); checkLbl.className = 'wmlbl'; checkLbl.textContent = '체크리스트'; checkGroup.appendChild(checkLbl);
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'toolbtn wide'; b.textContent = '☑'; b.title = '선택한 줄 체크리스트';
    b.dataset.lineCheck = 'true';
    b.addEventListener('click', () => {
      if (!selectedLine) return;
      selectedLine.checkable = !selectedLine.checkable;
      if (!selectedLine.checkable) selectedLine.done = false;
      else if (selectedLine.done == null) selectedLine.done = false;
      persistLines();
      updateFormatBarControls();
      if (renderCardBody) renderCardBody();
    });
    checkGroup.appendChild(b);
    bar.appendChild(checkGroup);
  }
  updateFormatBarControls();
}

async function init() {
  card = await window.api.getCard(ID);
  settings = await window.api.getSettings();
  try { appStatus = await window.api.status(); } catch (_) {}
  try { env = await window.api.getEnv(); } catch (_) {} // 워터마크용 PC명
  if (!card) { document.body.innerHTML = '<div class="hint">카드를 찾을 수 없습니다.</div>'; return; }
  normalizeCardForRender();
  if ((card.type === 'todo' || card.checklistMode) && Array.isArray(card.lines)) {
    let changed = false;
    card.lines.forEach((line) => {
      if (line && !line.checkable) { line.checkable = true; changed = true; }
    });
    if (card.checklistMode) { card.checklistMode = false; changed = true; }
    if (changed) window.api.updateCard(ID, { checklistMode: false, lines: card.lines });
  }
  // 레거시 콜메모 마이그레이션: timeDisplay 없는 카드의 화면/복사 시각 불일치 방지.
  if (card.type === 'callmemo' && !card.timeDisplay) {
    const tpl = (card.format && card.format.template) || '';
    if (tpl === '[{시간}] {내용}') { // 옛 기본(시간만) → 날짜+시간으로 승격(사용자 요청 방향)
      card.timeDisplay = 'datetime'; card.format.template = '[{날짜단축} {시간}] {내용}';
    } else { // 사용자 커스텀 템플릿은 보존하되, 화면 표시를 템플릿 기준으로 맞춤(불일치 제거)
      card.timeDisplay = /\{날짜/.test(tpl) ? 'datetime' : 'time';
    }
    window.api.updateCard(ID, { timeDisplay: card.timeDisplay, format: card.format });
  }
  // 토큰 명칭 변경: 저장된 서식의 {상담사ID} → {사용자ID}로 정리. format.template + 콜메모 커스텀 timeTemplate 둘 다(Codex P2-3). 치환은 양쪽 다 지원.
  {
    const patch = {};
    if (card.format && typeof card.format.template === 'string' && card.format.template.includes('{상담사ID}')) {
      card.format.template = card.format.template.split('{상담사ID}').join('{사용자ID}'); patch.format = card.format;
    }
    if (typeof card.timeTemplate === 'string' && card.timeTemplate.includes('{상담사ID}')) {
      card.timeTemplate = card.timeTemplate.split('{상담사ID}').join('{사용자ID}'); patch.timeTemplate = card.timeTemplate;
    }
    if (Object.keys(patch).length) window.api.updateCard(ID, patch);
  }
  document.addEventListener('paste', forcePlainPaste, true); // 붙여넣기 평문 통일(링크 앵커 텍스트가 아닌 URL 원본)
  if (window.api.onFlash) window.api.onFlash((count) => playFlash(count)); // 패널/알림 신호: 접힌 카드도 펼치고 흔들기
  if (window.api.onReminderFired) window.api.onReminderFired(() => {
    card.reminderAt = null;
    updateReminderButton();
    if (reminderOpen && renderCardBody) renderCardBody();
  });
  // 패널에서 설정이 바뀌면(사용자ID 적용·개인정보 가리기 토글) 캐시를 갱신해 복사 서식/마스킹에 즉시 반영.
  if (window.api.onSettingsChanged) window.api.onSettingsChanged((s) => {
    if (s && typeof s === 'object') {
      settings = s; refreshMask();
      const sel = document.getElementById('hdrSel'); if (sel) fillHeaderSelect(sel); // 패널에서 말머리 추가/삭제 시 열린 노트 서식 드롭다운도 즉시 갱신
    }
  });
  setupBar();
  renderCardBody = () => {
    const body = document.getElementById('body');
    if (card.type === 'memo') renderMemo(body);
    else if (card.type === 'table') renderTable(body);
    else renderList(body);
    applyCardBg();
  };
  renderCardBody();
  renderFormatBar(); // 하단 배경색 바 — #body 재렌더와 무관하게 유지
  applyCardBg();     // 저장된 배경색 적용(메모 textarea/오버레이 포함)
}

init();

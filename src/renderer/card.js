'use strict';
// 카드 렌더러. 줄 클릭=복사 / 더블클릭=수정 / 드래그=텍스트 선택이 충돌하지 않도록 구현.

const COPY_SVG = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg>';
const CHECK_SVG = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M5 13l5 5L19 7"/></svg>';
const PENCIL_SVG = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 20h4L18 10l-4-4L4 16v4z"/><path d="M13.5 6.5l4 4"/></svg>';

const ID = new URLSearchParams(location.search).get('id');
let card = null;
let settings = { agentId: '' };
let fmtOpen = false; // 복사 서식(#) 박스 열림 상태(재렌더에도 유지)
let setCardCollapsed = null; // 접기 상태 제어(setupBar에서 설정) — 패널 더블클릭 신호로 펼치기에 사용

const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
const saveCard = debounce((patch) => window.api.updateCard(ID, patch), 300);
const persistLines = () => saveCard({ lines: card.lines });

function pad(n) { return String(n).padStart(2, '0'); }
// 기록메모 줄 화면 말머리(시각). 복사 서식과 독립적으로 컴팩트하게 — time=시간만 / 그 외=날짜+시간(기본).
// 사용자ID·전체날짜 등은 화면 말머리에 넣지 않고 복사 스탬프(card.format.template)에만 → 내용 가로폭 확보.
function fmtLineTime(t) {
  const d = new Date(t);
  const date = `${pad(d.getMonth() + 1)}/${pad(d.getDate())}`;
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return (card.timeDisplay === 'time') ? time : `${date} ${time}`;
}

// when: 이 줄의 기준 시각(콜메모는 line.t — 줄이 적힌 실제 시각). 없으면 시각기준(통화시작/복사시점) 폴백(상용구).
function applyStamp(text, fmt, raw, when) {
  if (raw || !fmt || !fmt.enabled) return text;
  const base = when != null ? when : ((fmt.timeBasis === 'callStart' && card && card.createdAt) ? card.createdAt : Date.now());
  const d = new Date(base);
  const map = {
    '{날짜}': `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
    '{날짜단축}': `${pad(d.getMonth() + 1)}/${pad(d.getDate())}`,
    '{시간}': `${pad(d.getHours())}:${pad(d.getMinutes())}`,
    '{사용자ID}': fmt.agentId || settings.agentId || '',
    '{상담사ID}': fmt.agentId || settings.agentId || '', // 옛 서식 호환(기존 카드의 {상담사ID}도 계속 치환)
    '{내용}': text,
  };
  let s = fmt.template || '{내용}';
  for (const k of Object.keys(map)) s = s.split(k).join(map[k]);
  return s;
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

  if (card.type === 'todo') { // 할일: 줄마다 체크박스(완료 토글). 행 클릭/복사와 분리되도록 이벤트 차단.
    const chk = document.createElement('input');
    chk.type = 'checkbox'; chk.className = 'todochk'; chk.checked = !!line.done;
    if (line.done) row.classList.add('done');
    ['pointerdown', 'pointerup', 'click', 'dblclick'].forEach((ev) => chk.addEventListener(ev, (e) => e.stopPropagation()));
    chk.addEventListener('change', () => { line.done = chk.checked; row.classList.toggle('done', chk.checked); persistLines(); });
    row.appendChild(chk);
  }

  if (card.type === 'callmemo' && line.t) {
    const time = document.createElement('span');
    time.className = 'time'; time.textContent = fmtLineTime(line.t);
    row.appendChild(time);
  }

  const text = document.createElement('span');
  text.className = 'text'; text.setAttribute('contenteditable', 'false');
  registerMask(text, () => line.text); // 화면=마스킹, 원문은 line.text 유지(SE-6)
  row.appendChild(text);

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
    if (e.target.closest('.copy')) return;
    downX = e.clientX; downY = e.clientY;
  });
  if (copyOn) row.addEventListener('pointerup', (e) => {
    if (e.target.closest('.copy')) return;
    if (text.getAttribute('contenteditable') === 'true') return;     // 편집 중엔 복사 안 함
    const dist = Math.hypot(e.clientX - downX, e.clientY - downY);
    if (dist >= 4) return;                                            // 드래그면 선택만
    if (!getSelection().isCollapsed) return;                          // 선택 영역 있으면 복사 안 함
    const raw = e.shiftKey;
    row._copyTimer = setTimeout(() => copyRow(line.text, raw, row, copy, line.t), 180); // 원문 복사(더블클릭이면 취소됨)
  });
  row.addEventListener('dblclick', (e) => {
    if (e.target.closest('.copy')) return;
    clearTimeout(row._copyTimer);
    enterEdit(text, line, row);
  });
  row.addEventListener('contextmenu', (e) => {
    if (e.target.closest('.copy')) return;
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
    if (v === '') { const i = card.lines.indexOf(line); if (i >= 0) card.lines.splice(i, 1); row.remove(); }
    else { line.text = v; paintMask(text, v); } // 저장 후 다시 마스킹 표시
    persistLines();
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

function renderList(body) {
  body.innerHTML = '';
  maskEls.length = 0; // 재렌더 시 표시 요소 레지스트리 초기화
  document.getElementById('fmt').style.display = card.type === 'todo' ? 'none' : ''; // 할일은 복사 서식 불필요

  // 복사 서식 편집 박스 (목록형 카드만). 재렌더(옵션 변경 등) 후에도 열림 상태 유지(fmtOpen).
  const fmtbox = document.createElement('div');
  fmtbox.className = 'fmtbox'; fmtbox.hidden = !fmtOpen || card.type === 'todo';
  const isCall = card.type === 'callmemo';
  // 화면 말머리(.time)와 복사 서식을 분리: 복사 서식(fmtTpl)은 모든 토큰 자유 편집, 화면 말머리는 컴팩트(시간/날짜+시간)만.
  fmtbox.innerHTML =
    '<label><input type="checkbox" id="copyOn"> 줄 클릭으로 복사</label>' +
    '<label><input type="checkbox" id="fmtOn"> 복사 시 서식 적용</label>' +
    '<input class="tpl" id="fmtTpl" placeholder="[{날짜단축} {시간}] {내용}">' +
    '<div class="tokens" id="tokchips"></div>' +
    (isCall ?
      '<label class="tb">화면 말머리 <select id="timeDisp"><option value="time">시간만</option><option value="datetime">날짜+시간</option></select></label>'
      + '<label class="tb" title="설정한 기간이 지난 줄은 다음 실행 시 자동으로 삭제됩니다(개인정보 보호). \'안 함\'이면 삭제하지 않습니다.">자동 삭제 <select id="ttlSel"><option value="0">안 함</option><option value="7">7일 후</option><option value="14">14일 후</option><option value="30">30일 후</option><option value="60">60일 후</option><option value="90">90일 후</option></select></label>'
      : '<label class="tb">시각 기준 <select id="fmtBasis"><option value="now">복사 시점</option><option value="callStart">통화 시작</option></select></label>');
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
  ['{날짜단축}', '{시간}', '{날짜}', '{사용자ID}', '{내용}'].forEach((t) => {
    const b = document.createElement('button'); b.type = 'button'; b.className = 'tok'; b.textContent = t;
    b.addEventListener('click', (ev) => { ev.preventDefault(); insertToken(t); });
    tokchips.appendChild(b);
  });

  if (timeDisp) { // 화면 말머리(.time)만 제어 — 복사 서식과 독립. 컴팩트하게 시간/날짜+시간만(기존 custom은 날짜+시간으로 표시).
    timeDisp.value = (card.timeDisplay === 'time') ? 'time' : 'datetime';
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
  document.getElementById('fmt').onclick = () => { fmtOpen = !fmtOpen; fmtbox.hidden = !fmtOpen; };

  const list = document.createElement('div');
  list.className = 'list';
  card.lines = card.lines || [];
  for (const line of card.lines) list.appendChild(makeRow(line));

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
    if (card.type === 'callmemo') ln.t = Date.now();
    if (card.type === 'todo') ln.done = false;
    card.lines.push(ln);
    list.insertBefore(makeRow(ln), ghost);
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

  if (card.type === 'callmemo') { // ④b 콜메모 전체(양식) 복사
    const allBtn = document.createElement('button');
    allBtn.className = 'allcopy'; allBtn.textContent = '전체 복사(양식)';
    allBtn.addEventListener('click', () => {
      const out = card.lines.map((l) => applyStamp(l.text, card.format, false, l.t)).join('\n');
      window.api.copyText(out);
      allBtn.textContent = '복사됨 ✓'; setTimeout(() => { allBtn.textContent = '전체 복사(양식)'; }, 1000);
    });
    body.appendChild(allBtn);
  }

  const hint = document.createElement('div');
  hint.className = 'hint'; hint.textContent = '줄 클릭=복사 · 더블클릭=수정 · 드래그=선택';
  body.appendChild(hint);
}

function renderMemo(body) {
  document.getElementById('fmt').style.display = 'none'; // 메모는 줄복사 없음
  body.innerHTML = '';
  maskEls.length = 0; // 재렌더 시 표시 요소 레지스트리 초기화
  const wrap = document.createElement('div');
  wrap.className = 'memowrap';
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
  };
  ta.addEventListener('input', () => saveCard({ content: { text: ta.value } }));
  ta.addEventListener('focus', syncOverlay);
  ta.addEventListener('blur', syncOverlay);
  wrap.appendChild(ta); wrap.appendChild(overlay);
  body.appendChild(wrap);
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
    card.title = title.textContent.trim() || ({ snippet: '상용구', callmemo: '기록 메모', memo: '메모', table: '표', todo: '할일' }[card.type] || '메모');
    title.textContent = card.title;
    saveCard({ title: card.title });
  });
  title.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === 'Escape') { e.preventDefault(); title.blur(); } });

  const pin = document.getElementById('pin');
  if (card.alwaysOnTop) pin.classList.add('active');
  pin.onclick = () => {
    card.alwaysOnTop = !card.alwaysOnTop;
    pin.classList.toggle('active', card.alwaysOnTop);
    window.api.updateCard(ID, { alwaysOnTop: card.alwaysOnTop });
  };

  const fold = document.getElementById('fold');
  if (card.collapsed) document.documentElement.classList.add('collapsed');
  const setCollapsed = (val) => {
    if (!!card.collapsed === !!val) return;
    card.collapsed = !!val;
    document.documentElement.classList.toggle('collapsed', card.collapsed);
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

async function init() {
  card = await window.api.getCard(ID);
  settings = await window.api.getSettings();
  try { env = await window.api.getEnv(); } catch (_) {} // 워터마크용 PC명
  if (!card) { document.body.innerHTML = '<div class="hint">카드를 찾을 수 없습니다.</div>'; return; }
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
  if (window.api.onFlash) window.api.onFlash(() => { // 패널 더블클릭 신호: 접혀있으면 펼치기 + 흔들기/테두리 플래시
    if (setCardCollapsed) setCardCollapsed(false); // item 1: 접힌 카드도 펼쳐서 바로 보이게
    const el = document.documentElement;
    el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash'); // 리플로우로 애니메이션 재시작
    setTimeout(() => el.classList.remove('flash'), 700);
  });
  setupBar();
  const body = document.getElementById('body');
  if (card.type === 'memo') renderMemo(body);
  else if (card.type === 'table') renderTable(body);
  else renderList(body);
}

init();

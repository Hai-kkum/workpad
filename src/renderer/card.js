'use strict';
// 카드 렌더러. 줄 클릭=복사 / 더블클릭=수정 / 드래그=텍스트 선택이 충돌하지 않도록 구현.

const COPY_SVG = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg>';
const CHECK_SVG = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M5 13l5 5L19 7"/></svg>';
const PENCIL_SVG = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 20h4L18 10l-4-4L4 16v4z"/><path d="M13.5 6.5l4 4"/></svg>';

const ID = new URLSearchParams(location.search).get('id');
let card = null;
let settings = { agentId: '' };
let fmtOpen = false; // 복사 서식(#) 박스 열림 상태(재렌더에도 유지)

const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
const saveCard = debounce((patch) => window.api.updateCard(ID, patch), 300);
const persistLines = () => saveCard({ lines: card.lines });

function pad(n) { return String(n).padStart(2, '0'); }
// 콜메모 줄 시각 표기. 카드별 옵션(time=시간만 / datetime=날짜+시간 / custom=토큰 서식). 기본 datetime.
function fmtLineTime(t) {
  const d = new Date(t);
  const mode = card.timeDisplay || 'datetime';
  const date = `${pad(d.getMonth() + 1)}/${pad(d.getDate())}`;
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  if (mode === 'time') return time;
  if (mode === 'custom') {
    const map = { '{날짜}': `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`, '{날짜단축}': date, '{시간}': time };
    let s = card.timeTemplate || '{날짜단축} {시간}';
    for (const k of Object.keys(map)) s = s.split(k).join(map[k]);
    return s;
  }
  return `${date} ${time}`; // datetime
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
    '{상담사ID}': fmt.agentId || settings.agentId || '',
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
function refreshMask() { for (const m of maskEls) { if (m.el.isConnected) paintMask(m.el, m.getRaw()); } }

function setReveal(on) {
  revealed = !!on;
  const btn = document.getElementById('reveal');
  if (btn) btn.classList.toggle('active', revealed);
  clearTimeout(revealTimer);
  if (revealed) { showWatermark(); revealTimer = setTimeout(() => setReveal(false), REVEAL_MS); }
  else hideWatermark();
  refreshMask();
}
// SE-7 맥락 워터마크: 공개하는 순간에만 상담사ID·PC명·시각을 옅게 타일링. 재마스킹 시 제거.
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

function renderList(body) {
  body.innerHTML = '';
  maskEls.length = 0; // 재렌더 시 표시 요소 레지스트리 초기화

  // 복사 서식 편집 박스 (목록형 카드만). 재렌더(옵션 변경 등) 후에도 열림 상태 유지(fmtOpen).
  const fmtbox = document.createElement('div');
  fmtbox.className = 'fmtbox'; fmtbox.hidden = !fmtOpen;
  const isCall = card.type === 'callmemo';
  fmtbox.innerHTML =
    '<label><input type="checkbox" id="copyOn"> 줄 클릭으로 복사</label>' +
    '<label><input type="checkbox" id="fmtOn"> 복사 시 서식 적용</label>' +
    '<input class="tpl" id="fmtTpl" placeholder="[{날짜단축} {시간}] {내용}">' +
    (isCall ?
      '<label class="tb">시각 표시 <select id="timeDisp"><option value="time">시간만</option><option value="datetime">날짜+시간</option><option value="custom">커스텀</option></select></label>' +
      '<input class="tpl" id="timeTpl" placeholder="{날짜단축} {시간}">'
      : '<label class="tb">시각 기준 <select id="fmtBasis"><option value="now">복사 시점</option><option value="callStart">통화 시작</option></select></label>') +
    '<div class="tokens">토큰: {날짜} {날짜단축} {시간} {상담사ID} {내용} · Shift+클릭=원문</div>';
  body.appendChild(fmtbox);
  const copyOnBox = fmtbox.querySelector('#copyOn');
  const fmtOn = fmtbox.querySelector('#fmtOn');
  const fmtTpl = fmtbox.querySelector('#fmtTpl');
  copyOnBox.checked = card.copyMode !== false;
  fmtOn.checked = !!card.format.enabled;
  fmtTpl.value = card.format.template || '';
  copyOnBox.addEventListener('change', () => { card.copyMode = copyOnBox.checked; saveCard({ copyMode: card.copyMode }); renderList(body); }); // 토글 시 목록 재구성
  fmtOn.addEventListener('change', () => { card.format.enabled = fmtOn.checked; saveCard({ format: card.format }); });
  fmtTpl.addEventListener('input', () => { card.format.template = fmtTpl.value; saveCard({ format: card.format }); }); // 수동 템플릿 직접 편집(고급)
  const fmtBasis = fmtbox.querySelector('#fmtBasis');
  if (fmtBasis) { fmtBasis.value = card.format.timeBasis || 'now'; fmtBasis.addEventListener('change', () => { card.format.timeBasis = fmtBasis.value; saveCard({ format: card.format }); }); }
  const timeDisp = fmtbox.querySelector('#timeDisp'); // 콜메모 시각 표시 옵션(item 3) — 복사 템플릿의 시각 부분과 동기화해 화면=복사 일치
  if (timeDisp) {
    const timeTpl = fmtbox.querySelector('#timeTpl');
    const timePart = (mode) => mode === 'time' ? '{시간}' : (mode === 'custom' ? (card.timeTemplate || '{날짜단축} {시간}') : '{날짜단축} {시간}');
    const syncTemplate = (mode) => { card.format.template = '[' + timePart(mode) + '] {내용}'; card.format.enabled = true; fmtTpl.value = card.format.template; fmtOn.checked = true; };
    timeDisp.value = card.timeDisplay || 'datetime';
    timeTpl.value = card.timeTemplate || '';
    timeTpl.style.display = timeDisp.value === 'custom' ? '' : 'none';
    timeDisp.addEventListener('change', () => {
      card.timeDisplay = timeDisp.value;
      timeTpl.style.display = timeDisp.value === 'custom' ? '' : 'none';
      syncTemplate(timeDisp.value);
      saveCard({ timeDisplay: card.timeDisplay, format: card.format });
      renderList(body); // 표시 갱신
    });
    timeTpl.addEventListener('input', () => { card.timeTemplate = timeTpl.value; if (timeDisp.value === 'custom') syncTemplate('custom'); saveCard({ timeTemplate: card.timeTemplate, format: card.format }); }); // 저장만
    timeTpl.addEventListener('change', () => renderList(body)); // 입력 완료 시 표시 갱신
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
  const ta = document.createElement('textarea');
  ta.className = 'memo'; ta.value = (card.content && card.content.text) || '';
  ta.placeholder = '메모…';
  ta.addEventListener('input', () => saveCard({ content: { text: ta.value } }));
  body.appendChild(ta);
}

function renderTable(body) {
  document.getElementById('fmt').style.display = 'none'; // 표는 줄 스탬프 없음
  body.innerHTML = '';
  maskEls.length = 0; // 재렌더 시 표시 요소 레지스트리 초기화
  if (!Array.isArray(card.rows) || !card.rows.length) card.rows = [['항목', '값'], ['', '']];
  const saveRows = () => saveCard({ rows: card.rows });
  const cols = () => card.rows.reduce((m, r) => Math.max(m, r.length), 1);

  const ctrl = document.createElement('div');
  ctrl.className = 'tctrl';
  const mkBtn = (label, fn) => { const b = document.createElement('button'); b.textContent = label; b.addEventListener('click', fn); return b; };
  const wrap = document.createElement('div'); wrap.className = 'twrap';

  const editCell = (td, ri, ci) => {
    td.setAttribute('contenteditable', 'true');
    td.textContent = card.rows[ri][ci] != null ? card.rows[ri][ci] : ''; // 편집은 원문 대상
    td.focus(); caretEnd(td);
    const commit = () => {
      td.setAttribute('contenteditable', 'false');
      while (card.rows[ri].length <= ci) card.rows[ri].push('');
      card.rows[ri][ci] = td.textContent; saveRows();
      paintMask(td, td.textContent); // 저장 후 다시 마스킹 표시
    };
    td.addEventListener('keydown', (e) => { if ((e.key === 'Enter' && !e.shiftKey) || e.key === 'Escape') { e.preventDefault(); td.blur(); } });
    td.addEventListener('blur', commit, { once: true });
  };

  const draw = () => {
    wrap.innerHTML = '';
    maskEls.length = 0; // 표 전체 재구성 — 셀 레지스트리 초기화(누수 방지)
    const n = cols();
    const table = document.createElement('table'); table.className = 'tbl';
    card.rows.forEach((row, ri) => {
      const tr = document.createElement('tr');
      for (let ci = 0; ci < n; ci++) {
        const td = document.createElement('td');
        td.setAttribute('contenteditable', 'false');
        const cr = ri, cc = ci;
        registerMask(td, () => (card.rows[cr] && card.rows[cr][cc] != null ? card.rows[cr][cc] : '')); // 화면=마스킹, 원문은 card.rows 유지
        let px = 0, py = 0;
        td.addEventListener('pointerdown', (e) => { px = e.clientX; py = e.clientY; });
        td.addEventListener('pointerup', (e) => {
          if (td.getAttribute('contenteditable') === 'true') return;       // 편집 중 제외
          if (Math.hypot(e.clientX - px, e.clientY - py) >= 4) return;     // 드래그면 범위 선택
          if (!getSelection().isCollapsed) return;
          window.api.copyText(card.rows[cr] && card.rows[cr][cc] != null ? card.rows[cr][cc] : ''); // 원문 복사
          td.classList.add('copied'); setTimeout(() => td.classList.remove('copied'), 800);
        });
        td.addEventListener('dblclick', () => editCell(td, ri, ci));
        td.addEventListener('input', () => { while (card.rows[ri].length <= ci) card.rows[ri].push(''); card.rows[ri][ci] = td.textContent; saveRows(); }); // 입력 즉시 저장(편집 중 원문)
        tr.appendChild(td);
      }
      table.appendChild(tr);
    });
    wrap.appendChild(table);
  };

  ctrl.appendChild(mkBtn('+행', () => { card.rows.push(new Array(cols()).fill('')); saveRows(); draw(); }));
  ctrl.appendChild(mkBtn('+열', () => { const c = cols(); card.rows.forEach((r) => { while (r.length < c) r.push(''); r.push(''); }); saveRows(); draw(); }));
  ctrl.appendChild(mkBtn('표 붙여넣기', async () => {
    const t = await window.api.readClipboard();
    if (!t) return;
    const MAX_ROWS = 500, MAX_COLS = 50; // 크기 상한(P2: 거대 클립보드로 인한 프리즈 방지)
    let lines = t.replace(/\r/g, '').split('\n'); // 원문 저장(비파괴) — 화면은 셀이 마스킹
    if (lines.length && lines[lines.length - 1] === '') lines.pop();
    let truncated = lines.length > MAX_ROWS;
    if (truncated) lines = lines.slice(0, MAX_ROWS);
    const parsed = lines.map((l) => { const cells = l.split('\t'); if (cells.length > MAX_COLS) { truncated = true; return cells.slice(0, MAX_COLS); } return cells; });
    if (parsed.length) {
      card.rows = parsed; saveRows(); draw();
      if (truncated) { const h = document.querySelector('.hint'); if (h) h.textContent = `※ 표가 커서 ${MAX_ROWS}행·${MAX_COLS}열로 잘렸습니다`; }
    }
  }));

  body.appendChild(ctrl);
  body.appendChild(wrap);
  draw();

  const hint = document.createElement('div');
  hint.className = 'hint'; hint.textContent = '셀 클릭=복사 · 더블클릭=수정 · 드래그+Ctrl+C=범위(엑셀 호환)';
  body.appendChild(hint);
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
    card.title = title.textContent.trim() || ({ snippet: '상용구', callmemo: '콜 메모', memo: '메모' }[card.type] || '메모');
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
  const toggleFold = () => {
    card.collapsed = !card.collapsed;
    document.documentElement.classList.toggle('collapsed', card.collapsed);
    window.api.collapse(ID, card.collapsed);
  };
  fold.onclick = toggleFold;
  // 헤더 더블클릭으로도 접기/펼치기 (이름 편집 중 단어 선택과 겹치지 않게 제외)
  title.addEventListener('dblclick', () => { if (!title.classList.contains('editing')) toggleFold(); });

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
  if (card.type === 'memo') reveal.style.display = 'none'; // 메모는 자유 텍스트(마스킹 비적용)
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
  document.addEventListener('paste', forcePlainPaste, true); // 붙여넣기 평문 통일(링크 앵커 텍스트가 아닌 URL 원본)
  if (window.api.onFlash) window.api.onFlash(() => { // 패널 더블클릭 신호: 흔들기+테두리 플래시
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

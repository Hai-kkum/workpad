'use strict';
// 카드 렌더러. 줄 클릭=복사 / 더블클릭=수정 / 드래그=텍스트 선택이 충돌하지 않도록 구현.

const COPY_SVG = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg>';
const CHECK_SVG = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M5 13l5 5L19 7"/></svg>';

const ID = new URLSearchParams(location.search).get('id');
let card = null;
let settings = { agentId: '' };

const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
const saveCard = debounce((patch) => window.api.updateCard(ID, patch), 300);
const persistLines = () => saveCard({ lines: card.lines });

function pad(n) { return String(n).padStart(2, '0'); }
function fmtTime(t) { const d = new Date(t); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; }

function applyStamp(text, fmt, raw) {
  if (raw || !fmt || !fmt.enabled) return text;
  const d = new Date();
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

function caretEnd(el) {
  const r = document.createRange(); r.selectNodeContents(el); r.collapse(false);
  const s = getSelection(); s.removeAllRanges(); s.addRange(r);
}

async function copyRow(text, raw, row, btn) {
  const out = applyStamp(text, card.format, raw);
  await window.api.copyText(out);
  row.classList.add('copied'); btn.innerHTML = CHECK_SVG;
  setTimeout(() => { row.classList.remove('copied'); btn.innerHTML = COPY_SVG; }, 900);
}

function makeRow(line) {
  const row = document.createElement('div');
  row.className = 'row';

  if (card.type === 'callmemo' && line.t) {
    const time = document.createElement('span');
    time.className = 'time'; time.textContent = fmtTime(line.t);
    row.appendChild(time);
  }

  const text = document.createElement('span');
  text.className = 'text'; text.setAttribute('contenteditable', 'false'); text.textContent = line.text;
  row.appendChild(text);

  const copy = document.createElement('button');
  copy.className = 'copy'; copy.title = '복사 (Shift+클릭=원문)'; copy.innerHTML = COPY_SVG;
  row.appendChild(copy);

  let downX = 0, downY = 0;
  row.addEventListener('pointerdown', (e) => {
    if (e.target.closest('.copy')) return;
    downX = e.clientX; downY = e.clientY;
  });
  row.addEventListener('pointerup', (e) => {
    if (e.target.closest('.copy')) return;
    if (text.getAttribute('contenteditable') === 'true') return;     // 편집 중엔 복사 안 함
    const dist = Math.hypot(e.clientX - downX, e.clientY - downY);
    if (dist >= 4) return;                                            // 드래그면 선택만
    if (!getSelection().isCollapsed) return;                          // 선택 영역 있으면 복사 안 함
    const raw = e.shiftKey;
    row._copyTimer = setTimeout(() => copyRow(text.textContent, raw, row, copy), 180); // 더블클릭이면 취소됨
  });
  row.addEventListener('dblclick', (e) => {
    if (e.target.closest('.copy')) return;
    clearTimeout(row._copyTimer);
    enterEdit(text, line, row);
  });
  copy.addEventListener('click', (e) => { e.stopPropagation(); copyRow(text.textContent, e.shiftKey, row, copy); });

  return row;
}

function enterEdit(text, line, row) {
  text.setAttribute('contenteditable', 'true');
  text.focus(); caretEnd(text);
  const commit = () => {
    text.setAttribute('contenteditable', 'false');
    const v = text.textContent.trim();
    if (v === '') { const i = card.lines.indexOf(line); if (i >= 0) card.lines.splice(i, 1); row.remove(); }
    else { line.text = v; }
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

  // 복사 서식 편집 박스 (목록형 카드만)
  const fmtbox = document.createElement('div');
  fmtbox.className = 'fmtbox'; fmtbox.hidden = true;
  fmtbox.innerHTML =
    '<label><input type="checkbox" id="fmtOn"> 복사 시 서식 적용</label>' +
    '<input class="tpl" id="fmtTpl" placeholder="[{날짜단축} {시간}] {내용}">' +
    '<div class="tokens">토큰: {날짜} {날짜단축} {시간} {상담사ID} {내용}</div>';
  body.appendChild(fmtbox);
  const fmtOn = fmtbox.querySelector('#fmtOn');
  const fmtTpl = fmtbox.querySelector('#fmtTpl');
  fmtOn.checked = !!card.format.enabled;
  fmtTpl.value = card.format.template || '';
  fmtOn.addEventListener('change', () => { card.format.enabled = fmtOn.checked; saveCard({ format: card.format }); });
  fmtTpl.addEventListener('input', () => { card.format.template = fmtTpl.value; saveCard({ format: card.format }); });
  document.getElementById('fmt').onclick = () => { fmtbox.hidden = !fmtbox.hidden; };

  const list = document.createElement('div');
  list.className = 'list';
  card.lines = card.lines || [];
  for (const line of card.lines) list.appendChild(makeRow(line));

  // 유령 빈 줄: 더블클릭=클립보드 붙여넣기, 입력 후 Enter=새 줄
  const ghost = document.createElement('div');
  ghost.className = 'row ghost';
  const gtext = document.createElement('span');
  gtext.className = 'text'; gtext.setAttribute('contenteditable', 'true');
  gtext.setAttribute('data-ph', '더블클릭—붙여넣기 · 입력 후 Enter');
  ghost.appendChild(gtext);
  list.appendChild(ghost);

  const addLine = (txt) => {
    const ln = { text: txt };
    if (card.type === 'callmemo') ln.t = Date.now();
    card.lines.push(ln);
    list.insertBefore(makeRow(ln), ghost);
    persistLines();
  };
  gtext.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      const v = gtext.textContent.trim();
      if (v) { addLine(v); gtext.textContent = ''; }
    }
  });
  ghost.addEventListener('dblclick', async (e) => {
    e.preventDefault();
    const t = await window.api.readClipboard();
    if (!t) return;
    const parts = t.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    for (const p of parts) addLine(p);
    gtext.textContent = '';
  });

  body.appendChild(list);

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

function setupBar() {
  const title = document.getElementById('title');
  title.textContent = card.title || '';
  title.addEventListener('input', () => { card.title = title.textContent; saveCard({ title: card.title }); });
  title.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); title.blur(); } });

  const pin = document.getElementById('pin');
  if (card.alwaysOnTop) pin.classList.add('active');
  pin.onclick = () => {
    card.alwaysOnTop = !card.alwaysOnTop;
    pin.classList.toggle('active', card.alwaysOnTop);
    window.api.updateCard(ID, { alwaysOnTop: card.alwaysOnTop });
  };

  const fold = document.getElementById('fold');
  if (card.collapsed) document.documentElement.classList.add('collapsed');
  fold.onclick = () => {
    card.collapsed = !card.collapsed;
    document.documentElement.classList.toggle('collapsed', card.collapsed);
    window.api.collapse(ID, card.collapsed);
  };

  document.getElementById('close').onclick = () => window.api.closeCard(ID);
}

async function init() {
  card = await window.api.getCard(ID);
  settings = await window.api.getSettings();
  if (!card) { document.body.innerHTML = '<div class="hint">카드를 찾을 수 없습니다.</div>'; return; }
  setupBar();
  const body = document.getElementById('body');
  if (card.type === 'memo') renderMemo(body); else renderList(body);
}

init();

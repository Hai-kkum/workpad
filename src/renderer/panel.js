'use strict';
// 컨트롤 패널: 카드 생성 · 전체 표시/숨김 · 배치 프리셋 · 설정 · 보안 상태 · 섹션 탭 필터 · 커스텀 헤더.

const $ = (s) => document.querySelector(s);
const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
const escapeHtml = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const typeLabel = (t) => ({ snippet: '상용구', callmemo: '기록', memo: '메모', table: '표', todo: '할일' }[t] || t);

// 헤더 아이콘: 얇은 글리프(📌·—·▁)를 또렷한 SVG로 — 핀(항상위) + 접기/펼치기 셰브론 + 최소화 바.
const PIN_SVG = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 17v5"/><path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z"/></svg>';
const CHEVRON_UP_SVG = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 14l6-6 6 6"/></svg>';
const CHEVRON_DOWN_SVG = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 10l6 6 6-6"/></svg>';
const MIN_SVG = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M6 12h12"/></svg>';

let sections = ['공통', '요금제', '부가서비스', '기타'];
let activeTab = '전체';        // '전체' 또는 섹션명
let allCards = [];             // 마지막 listCards 결과(탭 필터용)
let panelCollapsed = false;
let sectionDeleteMode = false;
const FALLBACK_SECTION = '공통';
const FIXED_SECTIONS = new Set([FALLBACK_SECTION]);

// ── 카드 목록 + 섹션 필터 ───────────────────────────────────────────────
// 검색 중에 패널 갱신(카드 focus·표시상태 변경 등)이 와도 검색 결과를 유지한다.
// (검색 결과 클릭 → focusCard → notifyPanel → 여기로 들어와 목록으로 덮어쓰던 리셋 버그 방지)
async function refreshCards() {
  allCards = await window.api.listCards();
  const search = document.querySelector('#search');
  const q = search ? search.value.trim() : '';
  if (q) await doSearch(q); else renderCardList();
}

// 화면에 뜨는 집합과 동일한 필터(엄격 격리): 전체=모두, 그 외=해당 섹션만.
function inTab(c) {
  const s = c.section || '공통';
  return activeTab === '전체' || s === activeTab;
}

function renderCardList() {
  const el = $('#cards');
  el.innerHTML = '';
  const list = allCards.filter(inTab);
  if (!list.length) { el.innerHTML = `<div class="empty">'${activeTab}' 탭에 카드가 없습니다. 위 + 버튼으로 추가하세요.</div>`; return; }
  for (const c of list) {
    const d = document.createElement('div');
    d.className = 'cardrow';
    const sect = c.section || '공통';
    const opts = sections.map((s) => `<option ${s === sect ? 'selected' : ''}>${escapeHtml(s)}</option>`).join('');
    d.innerHTML = `<span class="badge ${c.type}">${typeLabel(c.type)}</span>` +
      `<span class="ct">${escapeHtml(c.title || '(제목 없음)')}</span>` +
      (c.visible ? '' : '<span class="hidden-tag">숨김</span>') +
      `<select class="sectsel" title="섹션 이동">${opts}</select>` +
      `<button class="del" title="삭제(되돌릴 수 없음)">✕</button>`;
    d.addEventListener('click', (e) => { if (e.target.closest('.del') || e.target.closest('.sectsel')) return; window.api.focusCard(c.id); });
    d.addEventListener('dblclick', (e) => { if (e.target.closest('.del') || e.target.closest('.sectsel')) return; window.api.flashCard(c.id); }); // 더블클릭=해당 카드 흔들기/플래시 신호
    const sel = d.querySelector('.sectsel');
    sel.addEventListener('click', (e) => e.stopPropagation());
    sel.addEventListener('change', async (e) => { e.stopPropagation(); await window.api.updateCard(c.id, { section: e.target.value }); await window.api.showSection(activeTab); await refreshCards(); }); // 재배정 후 현재 탭 기준 표시 갱신
    d.querySelector('.del').addEventListener('click', async (e) => {
      e.stopPropagation();
      if (window.confirm(`'${c.title || '제목 없음'}' 카드를 삭제할까요? 되돌릴 수 없습니다.`)) {
        await window.api.deleteCard(c.id); refreshCards(); refreshStatus();
      }
    });
    el.appendChild(d);
  }
}

function refreshTabs() {
  const el = $('#tabs');
  el.innerHTML = '';
  const mk = (name, label, removable = false) => {
    const b = document.createElement('span');
    b.className = 'tab' + (activeTab === name ? ' active' : '');
    const nameEl = document.createElement('span');
    nameEl.textContent = label || name;
    b.appendChild(nameEl);
    if (removable) {
      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'tabdel';
      del.title = `${name} 섹션 삭제`;
      del.setAttribute('aria-label', `${name} 섹션 삭제`);
      del.textContent = '✕';
      del.onclick = async (e) => {
        e.stopPropagation();
        await deleteSection(name);
      };
      b.appendChild(del);
    }
    b.onclick = async () => { activeTab = name; sectionDeleteMode = false; refreshTabs(); await window.api.showSection(name); await refreshCards(); }; // 탭 전환=섹션 카드 표시 + 삭제모드 해제(item 1)
    return b;
  };
  el.appendChild(mk('전체'));
  for (const s of sections) el.appendChild(mk(s, s, sectionDeleteMode && !FIXED_SECTIONS.has(s)));
  const add = document.createElement('span');
  add.className = 'tab addtab'; add.textContent = '+'; add.title = '섹션 추가';
  add.onclick = () => startAddTab(el, add);
  el.appendChild(add);
  const remove = document.createElement('span');
  remove.className = 'tab modetab' + (sectionDeleteMode ? ' active' : '');
  remove.textContent = '-';
  remove.title = sectionDeleteMode ? '섹션 삭제 표시 끄기' : '섹션 삭제 표시';
  remove.onclick = () => { sectionDeleteMode = !sectionDeleteMode; refreshTabs(); };
  el.appendChild(remove);
}

async function deleteSection(name) {
  if (FIXED_SECTIONS.has(name)) return;
  const affected = (await window.api.listCards()).filter((c) => (c.section || FALLBACK_SECTION) === name);
  const msg = affected.length
    ? `'${name}' 섹션을 삭제하고 카드 ${affected.length}개를 '${FALLBACK_SECTION}'으로 옮길까요?`
    : `'${name}' 섹션을 삭제할까요?`;
  if (!window.confirm(msg)) return;

  sections = sections.filter((s) => s !== name);
  if (!sections.includes(FALLBACK_SECTION)) sections.unshift(FALLBACK_SECTION);
  for (const c of affected) await window.api.updateCard(c.id, { section: FALLBACK_SECTION });
  await window.api.updateSettings({ sections });
  if (activeTab === name) activeTab = FALLBACK_SECTION;
  refreshTabs();
  await window.api.showSection(activeTab);
  await refreshCards();
}

// Electron은 window.prompt 미지원 → 인라인 입력으로 섹션 추가.
function startAddTab(el, addBtn) {
  sectionDeleteMode = false;
  addBtn.style.display = 'none';
  const inp = document.createElement('input');
  inp.className = 'tabadd'; inp.placeholder = '새 섹션'; inp.style.cssText = 'width:72px;font-size:11px;padding:2px 6px;';
  el.appendChild(inp); inp.focus();
  let closed = false;
  const done = async (commit) => {
    if (closed) return; closed = true;
    const v = inp.value.trim();
    inp.remove();
    if (commit && v && !sections.includes(v)) { sections.push(v); await window.api.updateSettings({ sections }); }
    refreshTabs(); renderCardList();
  };
  inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); done(true); } if (e.key === 'Escape') { done(false); } });
  inp.addEventListener('blur', () => done(true));
}

async function doSearch(q) {
  const res = await window.api.search(q);
  const el = $('#cards');
  el.innerHTML = '';
  if (!res.length) { el.innerHTML = '<div class="empty">검색 결과 없음</div>'; return; }
  for (const r of res) {
    const d = document.createElement('div');
    d.className = 'resrow';
    d.innerHTML = `<div class="resline"><span class="badge ${r.type}">${typeLabel(r.type)}</span>` +
      `<span class="ct">${escapeHtml(r.title)}</span></div>` +
      `<div class="snip">${escapeHtml(r.snippet)}</div>`;
    d.addEventListener('click', () => window.api.focusCard(r.id));
    el.appendChild(d);
  }
}

async function refreshPresets() {
  const names = await window.api.listPresets();
  const el = $('#presets');
  el.innerHTML = '';
  for (const name of names) {
    const b = document.createElement('span');
    b.className = 'preset'; b.textContent = name;
    b.title = '이 배치로 복원';
    b.onclick = () => window.api.applyPreset(name);
    el.appendChild(b);
  }
}

async function refreshStatus() {
  const s = await window.api.status();
  const set = await window.api.getSettings();
  const st = $('#status');
  st.textContent = (s.keyProtected ? '로컬 암호화 적용(키 보호됨)' : '주의: 키가 보호되지 않음(DPAPI 불가) — 이 PC에서 데이터 보호가 약합니다') + ` · 카드 ${s.cardCount}개`;
  st.className = s.keyProtected ? 'status' : 'status warn';
  $('#hotkeyHint').textContent = `전체 표시/숨김 단축키: ${set.hotkeyHideAll || '(없음)'}`;
  $('#agentId').value = set.agentId || '';
  $('#maskPII').checked = set.maskPII !== false;
  // 데이터 이전 기능 게이팅(보안팀 배포 설정)
  if (s.allowDataTransfer === false) {
    $('#xferBtns').style.display = 'none';
    $('#xferForm').innerHTML = '';
    xferMsg('데이터 이전 기능은 관리자(보안)에 의해 비활성화되어 있습니다.', null);
  } else {
    $('#xferBtns').style.display = '';
  }
  const note = $('#loadnote');
  if (s.loadError) {
    note.textContent = '이전 데이터를 열지 못해 백업하고 새로 시작했습니다' + (s.loadError.backup ? ` (백업: ${s.loadError.backup})` : '') + '.';
    note.style.display = 'block';
  } else { note.style.display = 'none'; }
}

function setPanelFoldIcon() {
  const f = $('#pFold');
  if (f) f.innerHTML = panelCollapsed ? CHEVRON_DOWN_SVG : CHEVRON_UP_SVG; // 접힘=펼치기(∨) / 펼침=접기(∧)
}
function toggleFold() {
  panelCollapsed = !panelCollapsed;
  document.body.classList.toggle('collapsed', panelCollapsed);
  setPanelFoldIcon();
  window.api.panelCollapse(panelCollapsed);
}

// ── 데이터 백업/이전(암호 보호) ──
function xferMsg(text, ok) {
  const h = $('#xferHint'); h.textContent = text;
  h.style.color = ok === false ? '#c0392b' : (ok === true ? '#15803d' : '#9aa1ab');
}
function exportForm() {
  const f = $('#xferForm');
  f.innerHTML = '<div class="row"><input type="password" id="xpass" placeholder="백업 암호(4자 이상)" /></div>' +
                '<div class="row"><input type="password" id="xpass2" placeholder="암호 확인" /><button id="xgo">내보내기 실행</button></div>';
  $('#xgo').onclick = async () => {
    const p = $('#xpass').value, p2 = $('#xpass2').value;
    if (p.length < 4) return xferMsg('암호는 4자 이상이어야 합니다.', false);
    if (p !== p2) return xferMsg('암호가 일치하지 않습니다.', false);
    const scan = await window.api.piiScan(); // 내보내기 전 개인정보 검출 경고
    if (scan && scan.count > 0 && !window.confirm(`이 백업에 개인정보(주민·카드번호 추정) ${scan.count}건이 카드 ${scan.cards}개에 포함됩니다.\n파일은 암호로 보호되지만, 외부 반출에 유의하세요. 계속할까요?`)) return;
    const r = await window.api.exportData(p);
    f.innerHTML = '';
    if (r.ok) xferMsg('내보내기 완료 → ' + r.path, true);
    else if (r.reason === 'canceled') xferMsg('취소됨.', null);
    else if (r.reason === 'disabled') xferMsg('관리자(보안)에 의해 비활성화되어 있습니다.', false);
    else if (r.reason === 'weak') xferMsg('암호가 너무 짧습니다.', false);
    else xferMsg('내보내기 실패.', false);
  };
}
function importForm() {
  const f = $('#xferForm');
  f.innerHTML = '<div class="row"><input type="password" id="ipass" placeholder="백업 암호" /><button id="igo">파일 선택 후 가져오기</button></div>';
  $('#igo').onclick = async () => {
    const p = $('#ipass').value;
    if (!p) return xferMsg('암호를 입력하세요.', false);
    if (!window.confirm('가져오면 현재 데이터를 백업 내용으로 덮어씁니다. 진행할까요?')) return;
    const r = await window.api.importData(p);
    if (r.ok) { xferMsg(`가져오기 완료: 카드 ${r.count}개. 새로고침합니다…`, true); setTimeout(() => location.reload(), 800); return; }
    f.innerHTML = '';
    if (r.reason === 'canceled') xferMsg('취소됨.', null);
    else if (r.reason === 'decrypt') xferMsg('암호가 틀리거나 파일이 손상되었습니다.', false);
    else if (r.reason === 'format') xferMsg('워크패드 백업 파일이 아닙니다.', false);
    else if (r.reason === 'disabled') xferMsg('관리자(보안)에 의해 비활성화되어 있습니다.', false);
    else xferMsg('가져오기 실패.', false);
  };
}

function wire() {
  document.querySelectorAll('[data-type]').forEach((b) => {
    // 새 카드는 현재 탭 섹션에 생성(전체 탭이면 공통). 그래야 섹션 탭이 실제로 의미를 가짐.
    b.onclick = async () => {
      const sect = (activeTab === '전체') ? '공통' : activeTab;
      await window.api.createCard(b.dataset.type, sect);
      await refreshCards(); await refreshStatus();
    };
  });
  $('#showAll').onclick = async () => { activeTab = '전체'; refreshTabs(); await window.api.showAll(); refreshCards(); }; // 전체 표시는 전체 탭으로(목록/화면 일치)
  $('#hideAll').onclick = async () => { await window.api.hideAll(); refreshCards(); };

  $('#savePreset').onclick = async () => {
    const name = $('#presetName').value.trim();
    if (!name) return;
    await window.api.savePreset(name);
    $('#presetName').value = '';
    refreshPresets();
  };

  $('#agentId').addEventListener('input', debounce((e) => window.api.updateSettings({ agentId: e.target.value }), 400));
  $('#maskPII').addEventListener('change', (e) => window.api.updateSettings({ maskPII: e.target.checked }));

  const search = $('#search');
  const searchClear = $('#searchClear');
  const updateClear = () => { searchClear.hidden = !search.value; };
  search.addEventListener('input', updateClear); // 입력 즉시 ✕ 표시/숨김
  search.addEventListener('input', debounce(() => { const q = search.value.trim(); if (q) doSearch(q); else renderCardList(); }, 200));
  // ✕ 한 번에 지우기: click 대신 mousedown + preventDefault 로 처리.
  // 한글 IME 조합 중에는 click 시 입력 포커스가 풀리며 조합 확정이 첫 클릭을 삼켜 여러 번 눌러야 지워지던 문제 해결.
  searchClear.addEventListener('mousedown', (e) => { e.preventDefault(); search.value = ''; updateClear(); renderCardList(); search.focus(); });
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); search.focus(); search.select(); }
    if (e.key === 'Escape' && document.activeElement === search) { search.value = ''; updateClear(); renderCardList(); search.blur(); }
  });

  // 커스텀 헤더(프레임리스) — 핀/접기/최소화/닫기 + 헤더 더블클릭 접기
  $('#pPin').onclick = async () => { const aot = await window.api.panelPin(); $('#pPin').classList.toggle('active', aot); };
  $('#pFold').onclick = toggleFold;
  const phead = $('#phead');
  phead.addEventListener('dblclick', (e) => { if (e.target.closest('.pbtn')) return; toggleFold(); });
  $('#pMin').onclick = () => window.api.panelMinimize();
  $('#pClose').onclick = () => window.api.panelClose();
  // 헤더 아이콘 주입(핀/최소화/접기) — 얇은 글리프 대신 또렷한 SVG
  $('#pPin').innerHTML = PIN_SVG;
  $('#pMin').innerHTML = MIN_SVG;
  setPanelFoldIcon();

  // 섹션 삭제 모드(− 마이너스): 삭제 ✕/토글 밖(빈 곳·다른 영역)을 클릭하면 모드 해제(item 1).
  document.addEventListener('click', (e) => {
    if (!sectionDeleteMode) return;
    if (e.target.closest('.tabdel') || e.target.closest('.modetab')) return; // 삭제 ✕·토글은 유지(여러 개 삭제)
    sectionDeleteMode = false;
    refreshTabs();
  });

  // 헤더 수동 드래그(카드와 동일): pointer capture + 4px 임계값으로 더블클릭(접기)과 분리.
  let pdrag = null;
  const onHeadMove = (e) => {
    if (!pdrag) return;
    const dx = e.screenX - pdrag.sx, dy = e.screenY - pdrag.sy;
    if (!pdrag.moved && Math.hypot(dx, dy) < 4) return;
    pdrag.moved = true; pdrag.dx = dx; pdrag.dy = dy;
    if (!pdrag.raf) pdrag.raf = requestAnimationFrame(() => { pdrag.raf = 0; if (pdrag && pdrag.moved) window.api.panelDragMove(pdrag.dx, pdrag.dy); });
  };
  const endHeadDrag = () => {
    if (!pdrag) return;
    if (pdrag.raf) cancelAnimationFrame(pdrag.raf);
    if (pdrag.moved) window.api.panelDragMove(pdrag.dx, pdrag.dy); // 마지막 위치 확정
    window.api.panelDragEnd();
    phead.removeEventListener('pointermove', onHeadMove);
    phead.removeEventListener('pointerup', endHeadDrag);
    phead.removeEventListener('pointercancel', endHeadDrag);
    pdrag = null;
  };
  phead.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || e.target.closest('.pbtn')) return; // 좌클릭만, 버튼 제외
    pdrag = { sx: e.screenX, sy: e.screenY, dx: 0, dy: 0, moved: false, raf: 0 };
    try { phead.setPointerCapture(e.pointerId); } catch (_) {}
    window.api.panelDragStart();
    phead.addEventListener('pointermove', onHeadMove);
    phead.addEventListener('pointerup', endHeadDrag);
    phead.addEventListener('pointercancel', endHeadDrag);
  });

  // 설정·백업 접기(기본 닫힘)
  const moreT = $('#moreToggle'), moreB = $('#moreBody');
  const toggleMore = () => { const open = moreB.hidden; moreB.hidden = !open; moreT.classList.toggle('open', open); };
  moreT.addEventListener('click', toggleMore);
  moreT.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleMore(); } });

  $('#exportBtn').onclick = exportForm;
  $('#importBtn').onclick = importForm;
}

(async function init() {
  wire();
  window.api.onPanelRefresh(() => refreshCards()); // 카드 ✕·전역 단축키·섹션 전환 시 목록 동기화(item 2)
  const set = await window.api.getSettings();
  if (Array.isArray(set.sections) && set.sections.length) sections = set.sections;
  try { const ps = await window.api.panelState(); $('#pPin').classList.toggle('active', !!ps.alwaysOnTop); } catch (_) {}
  refreshTabs();
  await refreshCards();
  await refreshPresets();
  await refreshStatus();
})();

'use strict';
// 컨트롤 패널: 카드 생성 · 전체 표시/숨김 · 배치 프리셋 · 설정 · 보안 상태.

const $ = (s) => document.querySelector(s);
const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
const escapeHtml = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const typeLabel = (t) => ({ snippet: '상용구', callmemo: '콜', memo: '메모' }[t] || t);

async function refreshCards() {
  const list = await window.api.listCards();
  const el = $('#cards');
  el.innerHTML = '';
  if (!list.length) { el.innerHTML = '<div class="empty">아직 카드가 없습니다. 위에서 추가하세요.</div>'; return; }
  for (const c of list) {
    const d = document.createElement('div');
    d.className = 'cardrow';
    d.innerHTML = `<span class="badge ${c.type}">${typeLabel(c.type)}</span>` +
      `<span class="ct">${escapeHtml(c.title || '(제목 없음)')}</span>` +
      (c.visible ? '' : '<span class="hidden-tag">숨김</span>');
    d.onclick = () => window.api.focusCard(c.id);
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
  $('#status').textContent = (s.keyProtected ? '로컬 암호화 적용(키 보호됨)' : '주의: 키 평문 폴백(DPAPI 불가)') + ` · 카드 ${s.cardCount}개`;
  $('#hotkeyHint').textContent = `전체 숨김 단축키: ${set.hotkeyHideAll || '(없음)'}`;
  $('#agentId').value = set.agentId || '';
}

function wire() {
  document.querySelectorAll('[data-type]').forEach((b) => {
    b.onclick = async () => { await window.api.createCard(b.dataset.type); await refreshCards(); await refreshStatus(); };
  });
  $('#showAll').onclick = async () => { await window.api.showAll(); refreshCards(); };
  $('#hideAll').onclick = async () => { await window.api.hideAll(); refreshCards(); };
  $('#toggleAll').onclick = async () => { await window.api.toggleAll(); refreshCards(); };

  $('#savePreset').onclick = async () => {
    const name = $('#presetName').value.trim();
    if (!name) return;
    await window.api.savePreset(name);
    $('#presetName').value = '';
    refreshPresets();
  };

  $('#agentId').addEventListener('input', debounce((e) => window.api.updateSettings({ agentId: e.target.value }), 400));
}

(async function init() {
  wire();
  await refreshCards();
  await refreshPresets();
  await refreshStatus();
})();

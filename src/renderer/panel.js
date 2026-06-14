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
      (c.visible ? '' : '<span class="hidden-tag">숨김</span>') +
      `<button class="del" title="삭제(되돌릴 수 없음)">✕</button>`;
    d.addEventListener('click', (e) => { if (e.target.closest('.del')) return; window.api.focusCard(c.id); });
    d.querySelector('.del').addEventListener('click', async (e) => {
      e.stopPropagation();
      if (window.confirm(`'${c.title || '제목 없음'}' 카드를 삭제할까요? 되돌릴 수 없습니다.`)) {
        await window.api.deleteCard(c.id); refreshCards(); refreshStatus();
      }
    });
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
  $('#hotkeyHint').textContent = `전체 숨김 단축키: ${set.hotkeyHideAll || '(없음)'}`;
  $('#agentId').value = set.agentId || '';
  const note = $('#loadnote');
  if (s.loadError) {
    note.textContent = '이전 데이터를 열지 못해 백업하고 새로 시작했습니다' + (s.loadError.backup ? ` (백업: ${s.loadError.backup})` : '') + '.';
    note.style.display = 'block';
  } else { note.style.display = 'none'; }
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

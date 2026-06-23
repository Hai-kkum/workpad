'use strict';
// 비밀번호 잠금(SE-9) 해제 창. 성공하면 메인이 이 창을 닫고 패널을 띄운다.
const pass = document.getElementById('pass');
const err = document.getElementById('err');
const go = document.getElementById('go');
pass.addEventListener('input', () => { pass.value = pass.value.replace(/\D/g, '').slice(0, 6); }); // 숫자 6자리만

async function tryUnlock() {
  const v = pass.value;
  if (!v) { pass.focus(); return; }
  go.disabled = true; err.textContent = '';
  const ok = await window.api.unlockTry(v);
  if (!ok) {
    err.textContent = '비밀번호가 올바르지 않습니다.';
    pass.value = ''; pass.focus(); go.disabled = false;
  }
  // 성공 시 메인(unlock:try)이 boot() 후 이 창을 닫음 — 추가 처리 불필요.
}

go.addEventListener('click', tryUnlock);
pass.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); tryUnlock(); } });
document.getElementById('quit').addEventListener('click', () => window.api.unlockQuit());
pass.focus();

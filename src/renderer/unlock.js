'use strict';
// 비밀번호 잠금(SE-9) 해제 창. 성공하면 메인이 이 창을 닫고 패널을 띄운다.
const pass = document.getElementById('pass');
const err = document.getElementById('err');
const go = document.getElementById('go');
const resetBox = document.getElementById('resetBox');
const resetText = document.getElementById('resetText');
const resetBtn = document.getElementById('resetBtn');
let failures = 0;
pass.addEventListener('input', () => { pass.value = pass.value.replace(/\D/g, '').slice(0, 6); }); // 숫자 6자리만
resetText.addEventListener('input', () => {
  resetBtn.disabled = resetText.value.trim() !== '초기화';
});

function showReset(result) {
  resetBox.hidden = false;
  const forceAt = (result && result.forceAt) || 15;
  resetBox.querySelector('.sub').textContent = `비밀번호는 복구할 수 없습니다. ${forceAt}회 실패 시 자동 초기화됩니다.`;
}

async function tryUnlock() {
  if (go.disabled) return;
  const v = pass.value;
  if (!v) { pass.focus(); return; }
  go.disabled = true; err.textContent = '';
  const result = await window.api.unlockTry(v);
  const ok = result === true || (result && result.ok);
  if (!ok) {
    failures = (result && result.failures) || (failures + 1);
    if (result && result.forceReset) {
      err.textContent = '15회 실패로 초기화합니다. 앱을 다시 시작합니다.';
      return;
    }
    err.textContent = `비밀번호가 올바르지 않습니다. (${failures}회 실패)`;
    if ((result && result.canReset) || failures >= 3) showReset(result);
    pass.value = '';
    pass.focus();
    go.disabled = false;
  }
  // 성공 시 메인(unlock:try)이 boot() 후 이 창을 닫음 — 추가 처리 불필요.
}

async function resetAllData() {
  if (resetText.value.trim() !== '초기화') {
    err.textContent = "'초기화'를 정확히 입력하세요.";
    resetText.focus();
    return;
  }
  if (resetBtn.disabled) return;
  resetBtn.disabled = true;
  go.disabled = true;
  err.textContent = '데이터를 초기화하고 앱을 다시 시작합니다.';
  const result = await window.api.unlockReset(resetText.value);
  if (!result || !result.ok) {
    const reason = result && result.reason;
    err.textContent = reason === 'locked'
      ? '비밀번호를 3회 이상 틀린 뒤 초기화할 수 있습니다.'
      : (reason === 'confirm' ? "'초기화'를 정확히 입력하세요." : '초기화할 수 없습니다.');
    resetBtn.disabled = resetText.value.trim() !== '초기화';
    go.disabled = false;
  }
}

go.addEventListener('click', tryUnlock);
pass.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); tryUnlock(); } });
resetText.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); resetAllData(); } });
resetBtn.addEventListener('click', resetAllData);
document.getElementById('quit').addEventListener('click', () => window.api.unlockQuit());
pass.focus();

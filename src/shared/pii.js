'use strict';
// PII 마스킹 로직 (main·renderer 공유). 중복 구현으로 인한 정합성 붕괴 방지(Codex 리뷰 §8 후속).
// 비파괴: 원문은 그대로 보관하고, "표시용 마스킹 문자열"만 만들어 반환한다(SE-6).
//  - 카드번호 16자리: Luhn 통과 시에만 마스킹(합법 숫자표 보존)
//  - 주민번호 13자리: 날짜/성별 검증 시에만 마스킹
//  - 전각 숫자·구분자(. - 공백/탭/개행)·임베드 포맷 대응(Codex P1 수정 유지)
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.PII = api;
})(typeof window !== 'undefined' ? window : null, function () {
  function luhn(num) {
    let sum = 0, alt = false;
    for (let i = num.length - 1; i >= 0; i--) {
      let d = num.charCodeAt(i) - 48;
      if (alt) { d *= 2; if (d > 9) d -= 9; }
      sum += d; alt = !alt;
    }
    return sum % 10 === 0;
  }
  function validRRN(d) {
    const mm = +d.slice(2, 4), dd = +d.slice(4, 6), g = +d[6];
    return mm >= 1 && mm <= 12 && dd >= 1 && dd <= 31 && g >= 1 && g <= 8;
  }
  // 텍스트에 PII가 있으면 마스킹된 사본을 반환(원문 불변). 없으면 입력 그대로.
  function maskPII(text) {
    if (text == null || text === '') return text;
    // 전각 숫자 → ASCII 정규화(전각 우회 차단)
    let s = String(text).replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0));
    // 카드번호 16자리: 구분자 허용·임베드 포함, Luhn 통과 시에만 마스킹
    s = s.replace(/\d(?:[\s.\-]?\d){15}/g, (m) => {
      const d = m.replace(/\D/g, '');
      return (d.length === 16 && luhn(d)) ? d.slice(0, 4) + '-****-****-' + d.slice(12) : m;
    });
    // 주민번호 13자리: 날짜/성별 검증 시에만 마스킹(생년월일+성별1자리만 노출)
    s = s.replace(/\d(?:[\s.\-]?\d){12}/g, (m) => {
      const d = m.replace(/\D/g, '');
      return (d.length === 13 && validRRN(d)) ? d.slice(0, 6) + '-' + d[6] + '******' : m;
    });
    // 휴대폰 번호(010/011/016~019, 10~11자리): 앞 3 + 뒤 4만 남기고 가운데 가림.
    // 앞뒤 숫자 경계(lookbehind/ahead)로 카드·주민 등 더 긴 숫자열의 일부를 오탐하지 않게.
    s = s.replace(/(?<!\d)01[016789](?:[\s.\-]?\d){7,8}(?!\d)/g, (m) => {
      const d = m.replace(/\D/g, '');
      return (d.length === 10 || d.length === 11) ? d.slice(0, 3) + '-****-' + d.slice(-4) : m;
    });
    return s;
  }
  // PII 포함 여부(표시용 마스킹과 원문이 다른가).
  function hasPII(text) { return maskPII(text) !== text; }
  return { maskPII, hasPII, luhn, validRRN };
});

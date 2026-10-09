// 부문별 "추천 배정" 계산 — AI 없이 규칙으로만 한다 (기준서 5.2: 필요 등급을 채우는 자원 중 가장 싼 것, 무료 우선).
// 모델 이름은 공식 자료로 확인된 것만 넣는다(기준서 12장). 이 목록에 없는 공급자(직접 추가한 것, Ollama 등)는
// 자동 추천 대상이 아니며, 사용자가 "직접 선택"으로 고른다.
const CATALOG = {
  anthropic: { strong: 'claude-opus-5-5', standard: 'claude-sonnet-5-5', light: 'claude-haiku-4-5-20251001' },
  gemini:    { standard: 'gemini-3.8-flash', light: 'gemini-3.5-flash-lite' },   // Google 공식 가격 페이지(2026-10-09): 무료 등급 있음
  typesafe:  { decide: 'jev-latest' }
};

// 부문이 필요로 하는 등급. 앞 등급부터 찾고, 그 등급을 가진 공급자(키 있음)가 없으면 다음 등급으로 내려간다.
const NEED = {
  chat: ['standard'],
  agent: ['standard'],
  agentStrong: ['strong', 'standard'],
  summarize: ['light', 'standard'],
  decide: ['decide']
};
const GRADE_LABEL = { strong: '고성능', standard: '표준', light: '경량', decide: '판단 전용' };
const ORDER = Object.keys(CATALOG);

const isLocal = p => /127\.0\.0\.1|localhost/.test((p && p.baseUrl) || '');
const usable = p => !!p && !p.disabled && !!p.apiKey && p.apiKey !== 'ollama';

// cfg: 설정 원본(키 포함). 반환: { provider, model, tier, grade, reason } 또는 null(추천 불가)
function recommendFor(cfg, role) {
  const needs = NEED[role];
  if (!needs) return null;
  for (let i = 0; i < needs.length; i++) {
    const grade = needs[i];
    const cands = [];
    for (const [id, p] of Object.entries(cfg.providers || {})) {
      const model = CATALOG[id] && CATALOG[id][grade];
      if (model && usable(p)) cands.push({ provider: id, model, tier: p.tier === 'free' ? 'free' : 'paid', local: isLocal(p) });
    }
    if (!cands.length) continue;
    // 무료 먼저, 같은 유형이면 목록 순서
    cands.sort((a, b) => (a.tier === b.tier ? 0 : a.tier === 'free' ? -1 : 1) || ORDER.indexOf(a.provider) - ORDER.indexOf(b.provider));
    const c = cands[0];
    const parts = [`${c.tier === 'free' ? '무료' : '유료'} · ${GRADE_LABEL[grade]} 등급`];
    if (i > 0) parts.push(`${GRADE_LABEL[needs[0]]} 등급을 쓸 수 있는 공급자 키가 없어 ${GRADE_LABEL[grade]} 등급으로 대신함`);
    parts.push(c.tier === 'free' ? '필요 등급을 채우는 것 중 무료 우선' : '필요 등급을 채우는 것 중 가장 저렴');
    return { provider: c.provider, model: c.model, tier: c.tier, grade, reason: parts.join(' · ') };
  }
  return null;
}

function recommendAll(cfg) {
  const out = {};
  for (const role of Object.keys(cfg.roles || {})) out[role] = recommendFor(cfg, role);
  return out;
}

module.exports = { CATALOG, NEED, recommendFor, recommendAll };

// 부문별 "추천 배정" 계산 — AI 없이 규칙으로만 한다 (기준서 5.2: 필요 등급을 채우는 자원 중 가장 싼 것, 무료 우선).
// 모델 이름은 공식 자료로 확인된 것만 넣는다(기준서 12장). 이 목록에 없는 공급자(직접 추가한 것, Ollama 등)는
// 자동 추천 대상이 아니며, 사용자가 "직접 선택"으로 고른다.
const CATALOG = {
  anthropic: { strong: 'claude-opus-5-5', standard: 'claude-sonnet-5-5', light: 'claude-haiku-4-5-20251001' },
  gemini:    { standard: 'gemini-3.8-flash', light: 'gemini-3.5-flash-lite' },   // Google 공식 가격 페이지(2026-10-09): 무료 등급 있음
  typesafe:  { decide: 'jev-latest' },
  // OpenAI 공식 모델·가격 페이지 2종에서 확인(2026-10-09): astra=최고성능, sol=균형, luna=최저가
  xai:       { standard: 'grok-4.7' },   // xAI 공식 문서(2026-10-09): $2/$6, 500k 컨텍스트. 지능 지수 순위 23위
  openai:    { strong: 'gpt-6-astra', standard: 'gpt-6.1-sol', light: 'gpt-6-luna' }
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

const { priceOf } = require('./pricing');
const cheapness = model => { const pr = priceOf(model); return pr ? pr.in + pr.out : Infinity; };   // 입력+출력 단가 합(작을수록 저렴)
const isLocal = p => /127\.0\.0\.1|localhost/.test((p && p.baseUrl) || '');
// 정보 등급(낮은 민감도 → 높은 민감도): P 공개 < I 내부 < C 기밀(대외비) < S 비밀.
// 공급자마다 "다룰 수 있는 가장 높은 등급"이 있고, 작업의 정보 등급이 그보다 높으면 그 공급자는 쓰지 않는다.
// 자동 기본값: 내 PC 로컬 = S / 유료 = I / 무료 = P (무료 등급은 입력이 학습에 쓰일 수 있음). 사용자가 공급자별로 바꿀 수 있다.
const GRADES = ['P', 'I', 'C', 'S'];
const GRADE_INFO = {
  P: { name: '공개', desc: '공개돼도 되는 정보. 무료 등급·외국계 서비스까지 모두 허용' },
  I: { name: '내부', desc: '일반 업무 정보. 입력을 학습에 쓰지 않는 유료 서비스까지 허용' },
  C: { name: '기밀(대외비)', desc: '거래처·계약·견적 등. 직접 \"C 허용\"으로 올려 둔 공급자와 내 PC 로컬만 허용' },
  S: { name: '비밀', desc: '계정·키·미공개 기술·개인정보 등. 내 PC 로컬 모델만 허용' }
};
const gradeRank = g => Math.max(0, GRADES.indexOf(g));
function effectiveMaxGrade(p) {
  if (p && GRADES.includes(p.maxGrade)) return p.maxGrade;
  if (isLocal(p)) return 'S';
  return p && p.tier === 'free' ? 'P' : 'I';
}
const gradeOk = (p, grade) => gradeRank(effectiveMaxGrade(p)) >= gradeRank(grade);

// 작업 엔진(구독 Claude Code)이 다룰 수 있는 최고 등급. 기본 I(내부). S(비밀)는 설정과 무관하게 항상 막는다(로컬 전용).
// 구독 엔진은 입력이 학습에 쓰이는지 사용자가 직접 확인해야 하므로, C(기밀)는 사용자가 명시적으로 올린 경우에만 허용한다.
function engineMaxGrade(cfg) {
  const g = cfg && cfg.engine && cfg.engine.maxGrade;
  return g === 'P' || g === 'I' || g === 'C' ? g : 'I';
}
const engineGradeOk = (cfg, grade) => grade !== 'S' && gradeRank(engineMaxGrade(cfg)) >= gradeRank(grade);

// 입력 글에 기밀·비밀로 볼 만한 말이 있는지 단순 규칙으로 살핀다(AI 아님, 정확하지 않음 — 실수 방지용 경고만).
// 반환: 제안 등급('C' 또는 'S') 또는 null. 등급을 자동으로 바꾸지는 않는다.
const SUSPECT_S = /(비밀번호|패스워드|password|api[\s_-]?key|시크릿|secret|토큰|token|주민(등록)?번호|계좌\s?번호|카드\s?번호|인증서|미공개\s?(기술|특허)|\b\d{6}-?[1-4]\d{6}\b|sk-[\w-]{20,})/i;
const SUSPECT_C = /(01[016789]-?\d{3,4}-?\d{4}|[\w.+-]+@[\w-]+\.[\w.]+|전화번호|연락처|대외비|기밀|confidential|계약서?|견적|단가|납품|거래처|고객(명|사)|급여|연봉|투자\s?(유치|계약)|NDA|비공개)/i;
function suspectGrade(text) {
  const t = String(text || '');
  if (SUSPECT_S.test(t)) return 'S';
  if (SUSPECT_C.test(t)) return 'C';
  return null;
}
// 경고 창에 보여 줄 근거까지: { grade: 'C'|'S'|null, hits: [걸린 단어(최대 5개, 비밀값은 가림)] }
function suspectDetail(text) {
  const t = String(text || '');
  const grade = suspectGrade(t);
  const hits = [];
  if (grade) {
    for (const re of [SUSPECT_S, SUSPECT_C]) {
      const g = new RegExp(re.source, 'gi');
      let m;
      while ((m = g.exec(t)) && hits.length < 5) {
        const w = /^01[016789]/.test(m[0]) ? '(전화번호 형태)' : /@/.test(m[0]) ? '(이메일 주소)' : /^(sk-|\d{6})/.test(m[0]) ? '(키·번호 형태의 값)' : m[0];
        if (!hits.includes(w)) hits.push(w);
        if (m[0].length === 0) g.lastIndex++;
      }
    }
  }
  return { grade, hits };
}
const usable = (p, grade) => !!p && !p.disabled && !p.off && gradeOk(p, grade || 'P') && !!p.apiKey && p.apiKey !== 'ollama';

// cfg: 설정 원본(키 포함). 반환: { provider, model, tier, grade, reason } 또는 null(추천 불가)
function recommendFor(cfg, role, infoGradeArg) {
  const infoGrade = GRADES.includes(infoGradeArg) ? infoGradeArg : (GRADES.includes(cfg.infoGrade) ? cfg.infoGrade : 'P');
  const needs = NEED[role];
  if (!needs) return null;
  for (let i = 0; i < needs.length; i++) {
    const grade = needs[i];
    const cands = [];
    for (const [id, p] of Object.entries(cfg.providers || {})) {
      const model = CATALOG[id] && CATALOG[id][grade];
      if (model && usable(p, infoGrade)) cands.push({ provider: id, model, tier: p.tier === 'free' ? 'free' : 'paid', local: isLocal(p) });
    }
    if (!cands.length) continue;
    // 무료 먼저, 같은 유형이면 단가가 싼 것, 단가가 같으면 목록 순서
    cands.sort((a, b) => (a.tier === b.tier ? 0 : a.tier === 'free' ? -1 : 1) || cheapness(a.model) - cheapness(b.model) || ORDER.indexOf(a.provider) - ORDER.indexOf(b.provider));
    const c = cands[0];
    const parts = [`${c.tier === 'free' ? '무료' : '유료'} · ${GRADE_LABEL[grade]} 등급`];
    if (i > 0) parts.push(`${GRADE_LABEL[needs[0]]} 등급을 쓸 수 있는 공급자 키가 없어 ${GRADE_LABEL[grade]} 등급으로 대신함`);
    if (infoGrade !== 'P') parts.push(`정보 등급 ${infoGrade}(${GRADE_INFO[infoGrade].name})에 허용된 공급자만 고려`);
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

// 작업 엔진 추천: 구독(Claude Code)은 한도 안에서 추가 비용이 없으므로, 설치돼 있으면 구독을 먼저 권한다.
// (구독은 API 키가 아니라 정품 Claude Code 프로그램으로만 쓸 수 있어 부문별 배정과는 따로 정한다 — 기준서 3장)
function recommendEngine(claudeFound) {
  return claudeFound
    ? { type: 'claude-code', reason: '구독 한도 안에서는 추가 비용이 없고, 막히는 어려운 작업을 맡기기에 적합함' }
    : { type: 'api', reason: 'Claude Code가 설치돼 있지 않아 API 키 방식으로 동작함' };
}

module.exports = { CATALOG, NEED, GRADES, GRADE_INFO, gradeRank, effectiveMaxGrade, gradeOk, engineMaxGrade, engineGradeOk, suspectGrade, suspectDetail, recommendFor, recommendAll, recommendEngine };

// 개발 모드의 두뇌: "작업이 얼마나 어려운지" 판정하고, 쓸 수 있는 개발 AI 중에서 알맞은 것을 고른다.
// AI 가 아니라 규칙(코드)으로 판정한다 → 비용이 들지 않고, 결과가 늘 같고, 시험할 수 있다.
//
// 난이도 등급(L)   1 간단: 오타·문구·색 바꾸기, 작은 수정·설명
//                  2 보통: 기능 하나·스크립트 하나·버그 하나
//                  3 어려움: 여러 파일로 된 앱 만들기, 기능 여러 개 추가
//                  4 매우 어려움: 설계 변경·대규모 정리·보안·결제·데이터베이스
// 고르는 순서: ① 정보 등급·사용 가능 여부 통과 → ② 비용 낮은 순(무료 < 구독 < API) → ③ 난이도를 겨우 채우는 "가장 약한" 엔진 → ④ 사용자가 정한 우선순위 → ⑤ 이번에 덜 쓴 쪽
const { gradeRank } = require('../models/recommend');
const { headroomPenalty } = require('./dev-capacity');

const COST_RANK = { free: 0, subscription: 1, api: 2 };
const LEVEL_LABEL = { 1: '간단', 2: '보통', 3: '어려움', 4: '매우 어려움' };

const has = (s, re) => re.test(s);

// 작업 문장으로 난이도 점수를 매긴다. 이유 목록도 함께 돌려줘서 화면에 "왜 L3인지" 보여 준다.
function analyzeDifficulty(goal, opts = {}) {
  const s = String(goal || '');
  const reasons = [];
  let score = 1;
  const build = has(s, /(만들어|만들고|만들자|개발|구현|제작|build|create|implement|develop)/i);
  const bigThing = has(s, /(앱|어플|애플리케이션|프로그램|시스템|서비스|사이트|웹사이트|웹페이지|플랫폼|대시보드|서버|백엔드|프론트|\bapp\b|application|dashboard|platform|backend|frontend|website)/i);
  if (build && bigThing) { score += 2; reasons.push('새 프로그램(앱·사이트 등)을 처음부터 만드는 일'); }
  else if (build) { score += 1; reasons.push('새로 만들거나 구현하는 일'); }
  const hard = [
    [/(설계|아키텍처|구조\s*(개편|변경)|architecture)/i, '구조 설계·변경'],
    [/(리팩터|리팩토링|refactor|마이그레이션|migrat|전면\s*(수정|개편))/i, '대규모 정리·이전'],
    [/(보안|암호|인증|로그인\s*기능|권한|security|auth|encrypt)/i, '보안·인증'],
    [/(결제|정산|payment|billing)/i, '결제'],
    [/(데이터베이스|\bdb\b|sql|database|동기화|sync|실시간|websocket|동시성|concurren)/i, '데이터베이스·실시간·동시성'],
    [/(성능\s*(개선|최적화)|최적화|optimi[sz]e|performance)/i, '성능 최적화']
  ];
  let hardHits = 0;
  for (const [re, why] of hard) if (hardHits < 2 && has(s, re)) { hardHits++; score += 1; reasons.push(why); }
  const items = (s.match(/^\s*(?:[-*•·]|\d+[.)]|[①-⑩])\s+/gm) || []).length;
  if (items >= 4) { score += 1; reasons.push(`요구 항목이 ${items}개로 많음`); }
  if (s.length > 800) { score += 1; reasons.push('설명이 매우 김'); }
  else if (s.length > 300) { score += 0.5; reasons.push('설명이 긴 편'); }
  if (opts.hasImages) { score += 0.5; reasons.push('화면 시안(사진) 첨부'); }
  if (opts.fileCount > 300) { score += 1; reasons.push('기존 프로젝트 파일이 많음'); }
  const easy = has(s, /(오타|문구|색상|색깔|글자|주석|이름\s*바꾸|한\s*줄|간단히|typo|rename|comment|tweak)/i);
  if (easy && !(build && bigThing)) { score -= 1; reasons.push('작은 수정으로 보임'); }
  if (opts.min && score < opts.min) score = opts.min;
  const level = score >= 5 ? 4 : score >= 3 ? 3 : score >= 2 ? 2 : 1;
  if (!reasons.length) reasons.push('특별히 어려운 요소가 보이지 않음');
  return { level, label: LEVEL_LABEL[level], score, reasons };
}

// 주니어(무료·로컬 AI)에게 통째로 맡겨도 품질에 영향이 작은 일인지 규칙으로 판정한다.
// 원칙: 품질에 영향이 클 수 있으면 맡기지 않는다(애매하면 안 맡김). 난이도 L2 이하이면서 아래 위험 요소가 하나도 없을 때만 통과.
const RISK = [
  [/(설계|아키텍처|구조|architecture)/i, '구조·설계'], [/(보안|암호|인증|로그인|권한|토큰|security|auth|encrypt|token)/i, '보안·인증'],
  [/(결제|정산|payment|billing)/i, '결제'], [/(데이터베이스|\bdb\b|sql|database|동기화|sync|실시간|websocket|동시성|concurren|트랜잭션)/i, '데이터·동기화'],
  [/(알고리즘|algorithm|파싱|parser|성능|최적화|optimi)/i, '알고리즘·성능'], [/(리팩|refactor|마이그레이션|migrat)/i, '대규모 정리'],
  [/(버그|오류|에러|디버그|안\s*됨|안돼|안 돼|bug|fix|error|crash)/i, '원인 추적이 필요한 수정'], [/(연동|외부\s*서비스|통합|integrat|api\s*키)/i, '외부 연동']
];
function juniorSafe(goal, diff) {
  const s = String(goal || '');
  if (diff && diff.level > 2) return { ok: false, why: `난이도 L${diff.level} — 주니어 한도(L2) 초과` };
  const hit = RISK.filter(([re]) => re.test(s)).map(([, w]) => w);
  if (hit.length) return { ok: false, why: '품질에 영향이 클 수 있는 영역(' + hit.slice(0, 3).join('·') + ')이라 시니어가 직접 처리' };
  return { ok: true, why: '' };
}

// 엔진 목록 만들기. cfg = 설정의 dev 부분, avail = { claude:bool, codex:bool, <custom id>:bool }
function buildEngines(cfg = {}, avail = {}, extra = []) {
  const dev = cfg.dev || {};
  const out = [];
  const cc = dev.claude || {};
  if (cc.enabled !== false) {
    const models = cc.models || { haiku: [1, 2], sonnet: [1, 3], opus: [1, 4] };
    for (const [m, range] of Object.entries(models)) {
      if (!range) continue;
      out.push({ id: 'claude-' + m, kind: 'claude', model: m, label: 'Claude Code · ' + m, cost: 'subscription', maxLevel: range[1], minLevel: range[0], maxGrade: dev.claudeMaxGrade || 'I', available: !!avail.claude, family: 'claude' });
    }
  }
  const cx = dev.codex || {};
  if (cx.enabled === 'auto' ? avail.codex : cx.enabled) out.push({ id: 'codex', kind: 'codex', label: 'Codex (ChatGPT 구독)', cost: 'subscription', maxLevel: clampLevel(cx.maxLevel, 3), minLevel: 1, maxGrade: cx.maxGrade || 'I', available: !!avail.codex, family: 'codex', args: cx.args, bin: cx.path });
  for (const c of dev.custom || []) {
    if (!c || !c.enabled || !c.id || !c.bin) continue;
    out.push({ id: 'cli-' + c.id, kind: 'cli', label: c.label || c.id, cost: ['free', 'subscription', 'api'].includes(c.cost) ? c.cost : 'subscription', maxLevel: clampLevel(c.maxLevel, 2), minLevel: 1, maxGrade: c.local ? (c.maxGrade || 'S') : (['P', 'I', 'C'].includes(c.maxGrade) ? c.maxGrade : 'I'), local: !!c.local, available: avail['cli-' + c.id] !== undefined ? !!avail['cli-' + c.id] : true, family: 'cli', args: c.args, bin: c.bin });
  }
  for (const e of extra || []) out.push(e);   // 주니어 엔진(지브스 직접 코딩 에이전트: 로컬 AI·무료 API) 등
  return out;
}
const clampLevel = (v, d) => { const n = Number(v); return Number.isFinite(n) ? Math.min(4, Math.max(1, Math.round(n))) : d; };

// 정보 등급 검문: S 는 로컬 모델(local 표시된 사용자 지정 엔진)만 받는다. 나머지는 엔진별 허용 등급 이하만.
function gradeOkFor(engine, grade) {
  if (grade === 'S') return !!engine.local && gradeRank(engine.maxGrade) >= gradeRank('S');
  return gradeRank(engine.maxGrade) >= gradeRank(grade);
}

class DevRouter {
  constructor(clock = Date.now) { this.clock = clock; this.cool = new Map(); this.runs = new Map(); }
  rest(id, ms, kind) { this.cool.set(id, { until: this.clock() + ms, kind }); }
  clear() { this.cool.clear(); }
  resting(id) { const c = this.cool.get(id); if (!c) return null; if (c.until <= this.clock()) { this.cool.delete(id); return null; } return c; }
  used(id) { this.runs.set(id, (this.runs.get(id) || 0) + 1); }

  // 계획: 난이도에 맞는 순서의 엔진 목록을 만든다.
  // opts: { grade, level, engines, prefer:[family...], exclude:Set, capacity:{family:{state,until,note}}, need:'small'|'medium'|'large' }
  // capacity: 한도에 닿은 계열은 제외(풀리는 시각 표시), 여유가 빠듯한 계열은 같은 비용이면 뒤로 민다(큰 일일수록 더)
  plan({ grade, level, engines, prefer = [], exclude = new Set(), first = '', capacity = {}, need = 'medium' }) {
    const skipped = [];
    const ok = [];
    for (const e of engines) {
      if (exclude.has(e.id)) { skipped.push({ id: e.id, label: e.label, why: '이번 작업에서 이미 실패해 제외' }); continue; }
      if (!e.available) { skipped.push({ id: e.id, label: e.label, why: '이 PC에서 찾지 못함(설치·경로 확인)' }); continue; }
      if (!gradeOkFor(e, grade)) { skipped.push({ id: e.id, label: e.label, why: `정보 등급 ${grade}는 허용 범위 밖(허용 ${e.maxGrade}까지${grade === 'S' ? ', S는 로컬 모델만' : ''})` }); continue; }
      const r = this.resting(e.id);
      if (r) { skipped.push({ id: e.id, label: e.label, why: `쉬는 중(${r.kind}, 약 ${Math.ceil((r.until - this.clock()) / 60000)}분)` }); continue; }
      const cap = capacity[e.family];
      if (cap && cap.state === 'out') { skipped.push({ id: e.id, label: e.label, why: cap.note, out: true, until: cap.until }); continue; }
      ok.push(e);
    }
    const pen = e => { const c = capacity[e.family]; return c ? headroomPenalty(c.state, need) : 0; };
    const pref = f => { const i = prefer.indexOf(f); return i < 0 ? 99 : i; };
    const sorter = (a, b) => (COST_RANK[a.cost] - COST_RANK[b.cost]) || ((a.family === first ? 0 : 1) - (b.family === first ? 0 : 1)) || (pen(a) - pen(b)) || (!!b.local - !!a.local) || (a.maxLevel - b.maxLevel) || (pref(a.family) - pref(b.family)) || ((this.runs.get(a.id) || 0) - (this.runs.get(b.id) || 0)) || a.id.localeCompare(b.id);
    const enough = ok.filter(e => e.maxLevel >= level && e.minLevel <= level).sort(sorter);
    // 난이도를 못 채우는 약한 엔진은 맨 끝에 "마지막 수단"으로만 둔다(경고 표시)
    const weak = ok.filter(e => e.maxLevel < level).sort((a, b) => b.maxLevel - a.maxLevel || sorter(a, b)).map(e => ({ ...e, weak: true }));
    // 하한(minLevel)보다 쉬운 일에 굳이 큰 엔진을 쓰지 않도록 minLevel 필터를 썼지만, 후보가 없으면 풀어 준다
    const loose = enough.length ? [] : ok.filter(e => e.maxLevel >= level).sort(sorter);
    const chain = [...enough, ...loose, ...weak];
    return { chain, skipped, level, grade };
  }

  // 실패 뒤 다음 엔진: 한도·로그인·실행 불가는 순서대로 다음, 일을 못 끝낸 실패는 더 강한 엔진으로 올린다
  next(chain, failedId, kind) {
    const i = chain.findIndex(e => e.id === failedId);
    const rest = chain.slice(i + 1);
    if (kind === 'task') {
      const cur = chain[i];
      const stronger = rest.filter(e => !e.weak && cur && e.maxLevel > cur.maxLevel);
      return stronger[0] || null;
    }
    return rest[0] || null;
  }
}

const REST_MS = { limit: 30 * 60 * 1000, login: 60 * 60 * 1000, missing: 60 * 60 * 1000, error: 2 * 60 * 1000 };

// 작업(Work) 통합 입력: 지시가 "프로젝트 폴더에서 개발하는 일"인지 "브라우저로 사이트를 조작하는 일"인지 규칙으로 가린다(AI 호출 없음, 토큰 0).
// 한쪽 신호만 있으면 그쪽, 둘 다 있거나 둘 다 없으면 'ask'(사용자에게 한 번 묻는다). 규칙이라 놓칠 수 있어 개발 계획 카드에서도 바꿀 수 있다.
const DEV_RES = [
  /(앱|어플|애플리케이션|프로그램|사이트|웹사이트|웹페이지|홈페이지|스크립트|플러그인|챗봇|봇|서버|api|대시보드|게임|기능|화면|페이지)\s*(을|를|도)?\s*(새로\s*)?(만들|개발|구현|제작|추가|수정|고쳐|고치|변경|개선)/i,
  /(코드|코딩|함수|클래스|버그|리팩터|리팩토링|소스|빌드|컴파일|테스트\s*(코드|작성)|npm|pip|git|깃허브|폴더|\.js|\.py|\.html|\.css|\.ts|\.bat)/i,
  /(개발|구현|프로그래밍)/, /[A-Za-z]:\\/
];
const WEB_RES = [
  /(검색|찾아|조회|접속|들어가|열어|클릭|로그인|다운로드|내려받|예약|신청|가격\s*비교|뉴스|공고|스크랩|수집|캡처)/,
  /(네이버|구글|유튜브|쿠팡|기업마당|인터넷에서|웹에서)/
];
function classifyRoute(goal) {
  const g = String(goal || '');
  const dev = DEV_RES.filter(r => r.test(g)).length, web = WEB_RES.filter(r => r.test(g)).length;
  const route = dev && !web ? 'dev' : web && !dev ? 'browser' : 'ask';
  return { route, devHits: dev, webHits: web };
}

module.exports = { classifyRoute, juniorSafe, analyzeDifficulty, buildEngines, DevRouter, gradeOkFor, LEVEL_LABEL, COST_RANK, REST_MS };

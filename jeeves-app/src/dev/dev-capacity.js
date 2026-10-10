// 개발 AI 자동 선정의 재료 두 가지를 규칙(코드)으로 만든다 — AI 호출·토큰 0.
//  ① 분량(volume): 일의 "넓이". 난이도(어려움)와 별개로 항목·화면·파일이 많으면 한 번에 오래·많이 쓴다.
//  ② 여유(headroom): 엔진 계열(Claude Code·Codex)별로 지금 쓸 수 있는 여유. 읽을 수 있는 신호만 쓴다.
//     - 한도에 실제로 닿은 기록(풀리는 시각 포함)  ← 가장 믿을 수 있음, 자동
//     - 최근 24시간 한도 도달 횟수               ← 자동
//     - 사용자가 입력한 "사용량 %"(Claude 앱·ChatGPT 사용량 화면 기준) ← 수동, 48시간이 지나면 무시
//     구독 잔여량을 프로그램이 읽을 방법은 확인되지 않았다(기준서 12장) → 잔여량을 지어내지 않고, 모르면 'unknown'(=보통)으로 둔다.
const fs = require('fs');
const path = require('path');

const KO_NUM = { 한: 1, 하나: 1, 두: 2, 둘: 2, 세: 3, 셋: 3, 네: 4, 넷: 4, 다섯: 5, 여섯: 6, 일곱: 7, 여덟: 8, 아홉: 9, 열: 10 };
const VOL_LABEL = { 1: '작음', 2: '보통', 3: '큼', 4: '매우 큼' };
const HOUR = 3600 * 1000;

// 분량 판정: 요구 항목 수, "N개 화면·기능" 같은 수량 표현, "전체·모든" 같은 넓은 말, 설명 길이, 첨부, 기존 프로젝트 크기
function estimateVolume(goal, opts = {}) {
  const s = String(goal || '');
  const reasons = [];
  let score = 1;
  const items = (s.match(/^\s*(?:[-*•·]|\d+[.)]|[①-⑩])\s+/gm) || []).length;
  if (items >= 6) { score += 2; reasons.push(`요구 항목 ${items}개`); } else if (items >= 3) { score += 1; reasons.push(`요구 항목 ${items}개`); }
  let maxCount = 0;
  const re = /(\d+|한|하나|두|둘|세|셋|네|넷|다섯|여섯|일곱|여덟|아홉|열)\s*(?:개|가지|종|건)\s*(?:의\s*)?(화면|페이지|기능|파일|모듈|메뉴|탭|api|컴포넌트|보고서|문서|단계)/ig;
  let m; while ((m = re.exec(s))) { const n = /^\d+$/.test(m[1]) ? Number(m[1]) : (KO_NUM[m[1]] || 0); if (n > maxCount) maxCount = n; }
  const re2 = /(화면|페이지|기능|파일|모듈|메뉴|탭|api|컴포넌트|보고서|문서|단계)\s*(\d+)\s*(?:개|가지|종|건)/ig;
  while ((m = re2.exec(s))) { const n = Number(m[2]); if (n > maxCount) maxCount = n; }
  if (maxCount >= 6) { score += 2; reasons.push(`${maxCount}개 단위의 작업`); } else if (maxCount >= 3) { score += 1; reasons.push(`${maxCount}개 단위의 작업`); }
  if (/(전체|모든|전부|각각|일괄|전면|통째)/.test(s)) { score += 1; reasons.push('"전체·모든" 같은 넓은 범위'); }
  if ((s.match(/(그리고|및|또한|추가로|아울러)/g) || []).length >= 3) { score += 1; reasons.push('요구가 여러 갈래'); }
  if (s.length > 800) { score += 1; reasons.push('설명이 매우 김'); } else if (s.length > 300) { score += 0.5; reasons.push('설명이 긴 편'); }
  if ((opts.attCount || 0) >= 3) { score += 1; reasons.push(`첨부 ${opts.attCount}개`); }
  if (opts.hasImages) { score += 0.5; reasons.push('화면 시안 첨부'); }
  if (opts.fileCount > 1000) { score += 1; reasons.push('기존 프로젝트가 큼(파일 1000개 이상)'); } else if (opts.fileCount > 300) { score += 0.5; reasons.push('기존 프로젝트 파일이 많음'); }
  if (/(오타|문구|색상|색깔|글자|주석|이름\s*바꾸|한\s*줄|간단히|typo|rename|tweak)/i.test(s)) { score -= 1; reasons.push('좁은 범위의 수정으로 보임'); }
  const volume = score >= 5 ? 4 : score >= 3 ? 3 : score >= 2 ? 2 : 1;
  if (!reasons.length) reasons.push('범위가 좁아 보임');
  return { volume, label: VOL_LABEL[volume], score, reasons };
}

// 일의 무게(난이도 × 분량) → 여유가 얼마나 필요한지
function needOf(level, volume) {
  const u = Math.max(1, level) * Math.max(1, volume);
  return u <= 3 ? 'small' : u <= 8 ? 'medium' : 'large';
}
// 분량이 크면 난이도가 낮아도 약한 엔진(작은 모델)에 통째로 맡기지 않는다: 분량 큼 이상 → 최소 L3 급으로 본다
function effectiveLevel(level, volume) { return Math.min(4, Math.max(level, volume >= 3 ? 3 : 1)); }

const STATE_RANK = { unknown: 0, ok: 0, tight: 1, low: 2, out: 9 };
// 여유가 부족한 엔진을 순서상 뒤로 미는 정도(0 = 영향 없음). 작은 일은 조금 빠듯해도 그대로, 큰 일일수록 여유 있는 쪽을 먼저 쓴다.
function headroomPenalty(state, need) {
  const r = STATE_RANK[state] || 0;
  if (!r) return 0;
  if (r >= 9) return 9;
  const adj = need === 'large' ? 1 : need === 'medium' ? 0 : -1;
  return Math.max(0, r + adj);
}

class DevCapacity {
  constructor(file, clock = Date.now) {
    this.file = file; this.clock = clock; this.events = [];
    if (file) { try { const j = JSON.parse(fs.readFileSync(file, 'utf8')); if (Array.isArray(j.events)) this.events = j.events; } catch (_) {} }
  }
  _save() { if (!this.file) return; try { fs.mkdirSync(path.dirname(this.file), { recursive: true }); fs.writeFileSync(this.file, JSON.stringify({ events: this.events.slice(-300) }), 'utf8'); } catch (_) {} }
  // ev: { family, engineId, kind: 'ok'|'limit'|'fail'|'login'|'missing', resumeAt?, level?, volume?, ms? }
  record(ev) {
    if (!ev || !ev.family) return;
    this.events.push({ at: this.clock(), family: ev.family, engineId: ev.engineId || '', kind: ev.kind, resumeAt: ev.resumeAt || 0, level: ev.level || 0, volume: ev.volume || 0, ms: ev.ms || 0 });
    if (this.events.length > 300) this.events = this.events.slice(-300);
    this._save();
  }
  // 이 계열이 한도에 걸려 아직 못 쓰는 시각(없으면 0). 풀리는 시각을 모르는 기록은 30분으로 본다.
  limitUntil(family) {
    const now = this.clock(); let until = 0;
    for (const e of this.events) {
      if (e.family !== family || e.kind !== 'limit') continue;
      const u = e.resumeAt && e.resumeAt > e.at ? e.resumeAt : e.at + 30 * 60000;
      if (u > now && u > until) until = u;
    }
    return until;
  }
  recentLimits(family, hours = 24) { const from = this.clock() - hours * HOUR; return this.events.filter(e => e.family === family && e.kind === 'limit' && e.at >= from).length; }
  // 지브스가 최근에 이 계열로 시킨 작업 수(참고 표시용)
  recentRuns(family, hours = 24) { const from = this.clock() - hours * HOUR; return this.events.filter(e => e.family === family && e.at >= from && e.kind !== 'missing').length; }
  // 한 계열의 여유 상태. cap = 설정의 { usedPct, at }(사용자 입력, 없을 수 있음)
  state(family, cap) {
    const now = this.clock();
    const until = this.limitUntil(family);
    if (until) return { state: 'out', until, note: `한도 도달 — ${fmt(until)}에 풀림` };
    let st = 'unknown', note = '';
    const used = cap && Number(cap.usedPct), at = cap && Number(cap.at);
    if (Number.isFinite(used) && cap.usedPct !== null && cap.usedPct !== '' && at && now - at <= 48 * HOUR) {
      st = used >= 90 ? 'low' : used >= 75 ? 'tight' : 'ok';
      note = `사용 ${Math.round(used)}% 입력(${ageText(now - at)} 전)`;
    } else if (cap && cap.usedPct !== null && cap.usedPct !== '' && at) note = '입력한 사용량이 오래돼 무시';
    const lim = this.recentLimits(family);
    if (lim >= 2 && STATE_RANK[st] < STATE_RANK.low) { st = 'low'; note = (note ? note + ' · ' : '') + `최근 24시간 한도 ${lim}회`; }
    else if (lim >= 1 && STATE_RANK[st] < STATE_RANK.tight) { st = 'tight'; note = (note ? note + ' · ' : '') + '최근 24시간 한도 1회'; }
    return { state: st, until: 0, note: note || '정보 없음(보통으로 봄)' };
  }
}
const fmt = t => { try { return new Date(t).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }); } catch (_) { return ''; } };
const ageText = ms => ms < HOUR ? Math.max(1, Math.round(ms / 60000)) + '분' : ms < 24 * HOUR ? Math.round(ms / HOUR) + '시간' : Math.round(ms / (24 * HOUR)) + '일';

module.exports = { estimateVolume, needOf, effectiveLevel, headroomPenalty, DevCapacity, VOL_LABEL, STATE_RANK };

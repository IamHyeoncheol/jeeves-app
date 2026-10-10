// 개발 AI 자동 선정의 재료 두 가지를 규칙(코드)으로 만든다 — AI 호출·토큰 0.
//  ① 분량(volume): 일의 "넓이". 난이도(어려움)와 별개로 항목·화면·파일이 많으면 한 번에 오래·많이 쓴다.
//  ② 여유(headroom): 엔진 계열(Claude Code·Codex)별로 지금 쓸 수 있는 여유. 읽을 수 있는 신호만 쓴다.
//     - 한도에 실제로 닿은 기록(풀리는 시각 포함)  ← 가장 믿을 수 있음, 자동
//     - 최근 24시간 한도 도달 횟수               ← 자동
//     - Claude Code 출력의 rate_limit_event(5시간·7일 사용률, 초기화 시각) ← 자동, 초기화 시각이 지나면 그 창은 무시 (사양서 04)
//     - 사용자가 입력한 "사용량 %"(Claude 앱·ChatGPT 사용량 화면 기준) ← 수동, 48시간이 지나면 무시
//     우선순위: 유효한 자동 값 → 48시간 이내 수동 값 → 정보 없음. Codex 출력 형식은 확인 필요 → 지어내지 않고, 모르면 'unknown'(=보통)으로 둔다.
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

// 구독 사용률 창(사양서 04 0장). 표시 이름은 화면용
const WINDOW_LABEL = { five_hour: '5시간', seven_day: '7일' };
const FAMILY_RE = /^[a-z0-9-]{1,24}$/;
const WIN_RE = /^[a-z0-9_]{1,24}$/;
const CHOICES = ['switch', 'continue'];   // 물어보기 카드: A = 다른 엔진으로 넘기기, B = 한도까지 계속
const posNum = v => typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0;
const toMs = v => { const n = posNum(v); return n > 1e12 ? Math.round(n) : Math.round(n * 1000); };   // 초 단위 유닉스 시각 → ms(이미 ms면 그대로)
const idText = (v, d) => typeof v === 'string' && v.trim() ? v.trim().slice(0, 64) : d;

// 창 목록 정제: { 창이름: { pct 0~100, resetsAt ms } } — 이상한 값은 그 창만 버린다
function cleanWindows(w) {
  const out = {};
  if (!w || typeof w !== 'object' || Array.isArray(w)) return out;
  for (const [k, x] of Object.entries(w).slice(0, 8)) {
    if (!WIN_RE.test(k) || k === '__proto__' || !x || typeof x !== 'object' || Array.isArray(x)) continue;
    if (typeof x.pct !== 'number') continue;
    const pct = x.pct, resetsAt = posNum(x.resetsAt);
    if (!Number.isFinite(pct) || pct < 0 || !resetsAt) continue;
    out[k] = { pct: Math.min(100, Math.round(pct * 10) / 10), resetsAt: Math.round(resetsAt) };
  }
  return out;
}

// Claude Code stream-json 의 rate_limit_event 한 줄 → recordUsage 입력. 형식이 다르거나 값이 이상하면 null (지어내지 않음)
function usageFromEvent(m, at = Date.now(), family = 'claude') {
  if (!m || typeof m !== 'object' || m.type !== 'rate_limit_event') return null;
  const info = m.rate_limit_info;
  if (!info || typeof info !== 'object') return null;
  const conv = x => {
    if (!x || typeof x !== 'object' || typeof x.utilization !== 'number') return null;
    const u = x.utilization, r = toMs(x.resetsAt);
    return Number.isFinite(u) && u >= 0 && r ? { pct: u * 100, resetsAt: r } : null;
  };
  const raw = {};
  const uw = info.unifiedWindows && typeof info.unifiedWindows === 'object' ? info.unifiedWindows : {};
  for (const k of Object.keys(uw)) { const v = conv(uw[k]); if (v) raw[k] = v; }
  if (typeof info.rateLimitType === 'string' && !raw[info.rateLimitType]) { const v = conv(info); if (v) raw[info.rateLimitType] = v; }   // 창 목록이 없을 때는 대표 값 하나
  const windows = cleanWindows(raw);
  return Object.keys(windows).length ? { family, windows, at } : null;
}

class DevCapacity {
  // opts: { org, user } — 상품화 대비 기록 칸(기본 default/owner)
  constructor(file, clock = Date.now, opts = {}) {
    this.file = file; this.clock = clock; this.events = []; this.usage = {}; this.choices = {};
    this.org = idText(opts.org, 'default'); this.user = idText(opts.user, 'owner');
    if (file) {
      try {
        const j = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (Array.isArray(j.events)) this.events = j.events.filter(e => e && typeof e === 'object' && !Array.isArray(e));
        if (j.usage && typeof j.usage === 'object') for (const [f, u] of Object.entries(j.usage)) {
          const w = u && cleanWindows(u.windows);
          if (FAMILY_RE.test(f) && w && Object.keys(w).length) this.usage[f] = { windows: w, at: posNum(u.at), org: idText(u.org, this.org), user: idText(u.user, this.user) };
        }
        if (j.choices && typeof j.choices === 'object') for (const [f, c] of Object.entries(j.choices)) {
          if (FAMILY_RE.test(f) && c && CHOICES.includes(c.choice) && posNum(c.resetsAt)) this.choices[f] = { choice: c.choice, resetsAt: posNum(c.resetsAt), at: posNum(c.at), org: idText(c.org, this.org), user: idText(c.user, this.user) };
        }
      } catch (_) {}
    }
  }
  _save() { if (!this.file) return; try { fs.mkdirSync(path.dirname(this.file), { recursive: true }); fs.writeFileSync(this.file, JSON.stringify({ events: this.events.slice(-300), usage: this.usage, choices: this.choices }), 'utf8'); } catch (_) {} }
  // 자동 사용률 기록(계열별 최신 1건). u: { family, windows: { five_hour: { pct, resetsAt(ms) }, ... }, at, org?, user? }. 저장하면 true
  recordUsage(u) {
    if (!u || typeof u !== 'object' || typeof u.family !== 'string' || !FAMILY_RE.test(u.family)) return false;
    const windows = cleanWindows(u.windows);
    if (!Object.keys(windows).length) return false;
    const at = posNum(u.at) || this.clock();
    const prev = Object.hasOwn(this.usage, u.family) ? this.usage[u.family] : null;
    if (prev && prev.at > at) return false;   // 늦게 도착한 옛 값으로 덮지 않는다
    this.usage[u.family] = { windows, at, org: idText(u.org, this.org), user: idText(u.user, this.user) };
    this._save();
    return true;
  }
  // 물어보기 카드 선택을 "이번 초기화까지" 기억. choice: 'switch'(A)|'continue'(B), resetsAt: 그 창의 초기화 시각(ms). 저장하면 true
  setChoice(family, choice, resetsAt, who = {}) {
    const r = posNum(resetsAt);
    if (typeof family !== 'string' || !FAMILY_RE.test(family) || !CHOICES.includes(choice) || r <= this.clock()) return false;
    this.choices[family] = { choice, resetsAt: r, at: this.clock(), org: idText(who.org, this.org), user: idText(who.user, this.user) };
    this._save();
    return true;
  }
  // 기억한 선택(초기화 시각이 지났으면 지우고 null)
  getChoice(family) {
    const c = Object.hasOwn(this.choices, family) ? this.choices[family] : null;
    if (!c) return null;
    if (c.resetsAt <= this.clock()) { delete this.choices[family]; this._save(); return null; }
    return c.choice;
  }
  clearChoice(family) { if (Object.hasOwn(this.choices, family)) { delete this.choices[family]; this._save(); } }
  // 사용률 한 가지로 정리: 유효한 자동 창 중 큰 값 → 48시간 이내 수동 값 → 정보 없음
  usageOf(family, cap) {
    const now = this.clock();
    const u = Object.hasOwn(this.usage, family) ? this.usage[family] : null;
    let best = null;
    if (u) for (const [k, w] of Object.entries(u.windows)) if (w.resetsAt > now && (!best || w.pct > best.pct)) best = { pct: w.pct, window: k, resetsAt: w.resetsAt };
    if (best) return { usedPct: best.pct, window: best.window, resetsAt: best.resetsAt, source: 'auto', at: u.at };
    const used = cap && cap.usedPct !== null && cap.usedPct !== '' && typeof cap.usedPct !== 'boolean' ? Number(cap.usedPct) : NaN, at = cap ? posNum(cap.at) : 0;
    if (Number.isFinite(used) && used >= 0 && at && at <= now && now - at <= 48 * HOUR) return { usedPct: Math.min(100, used), window: null, resetsAt: 0, source: 'manual', at };
    return { usedPct: null, window: null, resetsAt: 0, source: 'none', at: 0, stale: !!(cap && cap.usedPct !== null && cap.usedPct !== '' && cap.usedPct !== undefined && at) };
  }
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
  // 반환: { state, until, note, usedPct, window, resetsAt, source:'auto'|'manual'|'none' }
  state(family, cap) {
    const now = this.clock();
    const u = this.usageOf(family, cap);
    const use = { usedPct: u.usedPct, window: u.window, resetsAt: u.resetsAt, source: u.source };
    const until = this.limitUntil(family);
    if (until) return { state: 'out', until, note: `한도 도달 — ${fmt(until)}에 풀림`, ...use };
    let st = 'unknown', note = '';
    if (u.source !== 'none') {
      st = u.usedPct >= 90 ? 'low' : u.usedPct >= 75 ? 'tight' : 'ok';
      note = u.source === 'auto' ? `${WINDOW_LABEL[u.window] || u.window} 사용 ${Math.round(u.usedPct)}% 자동(${fmt(u.resetsAt)} 초기화)`
        : `사용 ${Math.round(u.usedPct)}% 입력(${ageText(now - u.at)} 전)`;
    } else if (u.stale) note = '입력한 사용량이 오래돼 무시';
    const lim = this.recentLimits(family);
    if (lim >= 2 && STATE_RANK[st] < STATE_RANK.low) { st = 'low'; note = (note ? note + ' · ' : '') + `최근 24시간 한도 ${lim}회`; }
    else if (lim >= 1 && STATE_RANK[st] < STATE_RANK.tight) { st = 'tight'; note = (note ? note + ' · ' : '') + '최근 24시간 한도 1회'; }
    return { state: st, until: 0, note: note || '정보 없음(보통으로 봄)', ...use };
  }
}
const fmt = t => { try { return new Date(t).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }); } catch (_) { return ''; } };
const ageText = ms => ms < HOUR ? Math.max(1, Math.round(ms / 60000)) + '분' : ms < 24 * HOUR ? Math.round(ms / HOUR) + '시간' : Math.round(ms / (24 * HOUR)) + '일';

module.exports = { estimateVolume, needOf, effectiveLevel, headroomPenalty, DevCapacity, VOL_LABEL, STATE_RANK, WINDOW_LABEL, usageFromEvent, cleanWindows };

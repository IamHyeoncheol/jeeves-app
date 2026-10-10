// 감사 기록: 행동 1회 = 1줄(JSON). 일별 파일(audit-YYYY-MM-DD.jsonl)에 추가만 한다.
// 비밀은 저장 전에 가린다(redact): 입력값은 길이만, 주소는 쿼리·조각 제거, 번호·키·이메일은 [가림].
// 보관 기간: 자동 삭제 없음(사양서 01 결정 2 — A안).
const fs = require('fs');
const path = require('path');
const { localIso, readJsonl } = require('./ledger');

const KINDS = ['action', 'halt', 'resume', 'task-start', 'task-end', 'shortcut-fail', 'rule-add', 'rule-change', 'rule-remove'];
const MASK = [
  /\b\d{6}-?[1-4]\d{6}\b/g,                    // 주민등록번호
  /(?:\d[ -]?){13,19}/g,                       // 카드번호 등 긴 숫자
  /\bsk-[A-Za-z0-9_-]{6,}/g,                   // API 키
  /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi,          // 인증 토큰
  /[\w.+-]+@[\w-]+(\.[\w-]+)+/g                // 이메일
];
const pad = n => String(n).padStart(2, '0');

function mask(s, n = 200) {
  let t = String(s == null ? '' : s);
  for (const re of MASK) t = t.replace(re, '[가림]');
  return t.slice(0, n);
}
function safeUrl(url) {
  if (!url) return '';
  try { const u = new URL(url); return mask(`${u.protocol}//${u.host}${u.pathname}`, 200); } catch (_) { return '(주소 해석 불가)'; }
}

// 허용 필드만 골라 가린다
function redact(ev = {}) {
  const out = { v: 1 };
  out.kind = KINDS.includes(ev.kind) ? ev.kind : 'action';
  for (const k of ['taskId', 'source', 'action', 'level', 'rule', 'aiLevel', 'decision', 'ruleId', 'shadowRuleId', 'ok', 'org', 'user', 'engine', 'count']) {
    if (ev[k] !== undefined && ev[k] !== null) out[k] = typeof ev[k] === 'string' ? mask(ev[k], 80) : ev[k];
  }
  out.org = out.org || 'default'; out.user = out.user || 'owner';
  if (ev.target) {
    const t = {};
    if (ev.target.url) t.url = safeUrl(ev.target.url);
    if (ev.target.label) t.label = mask(ev.target.label);
    if (ev.target.kind) t.kind = mask(ev.target.kind, 40);
    if (ev.target.folder) t.folder = mask(ev.target.folder, 120);   // 메일 폴더 이름
    if (ev.target.uid != null) t.uid = ev.target.uid;
    out.target = t;
  }
  if (ev.input && typeof ev.input.text === 'string') out.input = { length: ev.input.text.length };   // 입력값 자체는 절대 저장 안 함
  if (ev.message) out.message = mask(ev.message);
  if (ev.why) out.why = mask(ev.why);
  if (ev.goal) out.goal = mask(ev.goal, 60);
  return out;
}

class AuditLog {
  constructor({ dir, now = () => new Date() } = {}) { this.dir = dir; this.now = now; this.onError = null; }
  fileFor(d) { return path.join(this.dir, `audit-${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}.jsonl`); }
  write(ev) {
    const d = this.now();
    const rec = { ts: localIso(d), ...redact(ev) };
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      fs.appendFileSync(this.fileFor(d), JSON.stringify(rec) + '\n', 'utf8');
      return rec;
    } catch (e) { if (this.onError) this.onError(e); return null; }
  }
  readDay(dateStr) {
    const [y, m, dd] = String(dateStr).split('-').map(Number);
    return readJsonl(this.fileFor(new Date(y, m - 1, dd)));
  }
}

module.exports = { AuditLog, redact, safeUrl, mask };

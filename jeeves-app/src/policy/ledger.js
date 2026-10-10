// 비용 장부: AI 호출 1회 = 1줄(JSON). 월별 파일(cost-YYYY-MM.jsonl)에 추가만 한다(수정·삭제 없음).
// 숫자와 이름만 저장한다(프롬프트·답변·키 금지 → 허용 필드만 골라 저장).
// 상품화 대비: 모든 줄에 org(조직·사업자)·user 칸.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const FIELDS = ['kind', 'taskId', 'source', 'role', 'provider', 'model', 'input', 'output', 'cacheRead', 'cacheWrite', 'usd', 'billed', 'engine', 'ticket', 'org', 'user'];
const pad = n => String(n).padStart(2, '0');
function localIso(d) {
  const off = -d.getTimezoneOffset(), s = off >= 0 ? '+' : '-', a = Math.abs(off);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${String(d.getMilliseconds()).padStart(3, '0')}${s}${pad(Math.floor(a / 60))}:${pad(a % 60)}`;
}
function readJsonl(file) {
  let txt;
  try { txt = fs.readFileSync(file, 'utf8'); } catch (_) { return []; }
  const out = [];
  for (const line of txt.split('\n')) { if (!line.trim()) continue; try { out.push(JSON.parse(line)); } catch (_) {} }   // 깨진 줄은 건너뜀
  return out;
}

class CostLedger {
  constructor({ dir, now = () => new Date(), krwPerUsd = () => 1400 } = {}) {
    this.dir = dir; this.now = now; this.krwPerUsd = krwPerUsd;
    this.onError = null;
  }
  fileFor(d) { return path.join(this.dir, `cost-${d.getFullYear()}-${pad(d.getMonth() + 1)}.jsonl`); }

  append(entry = {}) {
    const d = this.now();
    const rec = { v: 1, id: `c_${d.getTime()}_${crypto.randomBytes(2).toString('hex')}`, ts: localIso(d) };
    for (const k of FIELDS) if (entry[k] !== undefined) rec[k] = entry[k];
    rec.kind = rec.kind || 'api';
    rec.org = rec.org || 'default'; rec.user = rec.user || 'owner';
    if (typeof rec.usd !== 'number' || !isFinite(rec.usd)) rec.usd = null;
    let rate = 1400; try { rate = Number(this.krwPerUsd()) || 1400; } catch (_) {}
    rec.krw = rec.usd === null ? null : Math.round(rec.usd * rate);
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      fs.appendFileSync(this.fileFor(d), JSON.stringify(rec) + '\n', 'utf8');
      return rec;
    } catch (e) { if (this.onError) this.onError(e); return null; }   // 장부 오류로 작업을 멈추지 않는다
  }

  list({ from, to } = {}) {
    const end = to || this.now(), start = from || new Date(end.getFullYear(), end.getMonth(), 1);
    const out = [];
    for (let m = new Date(start.getFullYear(), start.getMonth(), 1); m <= end; m = new Date(m.getFullYear(), m.getMonth() + 1, 1)) {
      for (const r of readJsonl(this.fileFor(m))) { const t = new Date(r.ts); if (t >= start && t <= end) out.push(r); }
    }
    return out;
  }

  // period: 'today' | 'month'. org 를 주면 그 조직만.
  summary({ period = 'today', org } = {}) {
    const n = this.now();
    const from = period === 'month' ? new Date(n.getFullYear(), n.getMonth(), 1) : new Date(n.getFullYear(), n.getMonth(), n.getDate());
    const s = { period, usd: 0, krw: 0, calls: 0, unknownCost: 0, subscriptionUsd: 0, byModel: {}, byRole: {} };
    for (const r of this.list({ from, to: n })) {
      if (org && (r.org || 'default') !== org) continue;
      s.calls++;
      if (r.kind === 'subscription') { if (typeof r.usd === 'number') s.subscriptionUsd += r.usd; continue; }   // 구독 추정치는 실과금과 따로
      if (r.usd === null || r.usd === undefined) { s.unknownCost++; continue; }
      s.usd += r.usd; s.krw += r.krw || 0;
      const m = (s.byModel[r.model || '?'] = s.byModel[r.model || '?'] || { calls: 0, usd: 0 }); m.calls++; m.usd += r.usd;
      const ro = (s.byRole[r.role || '?'] = s.byRole[r.role || '?'] || { calls: 0, usd: 0 }); ro.calls++; ro.usd += r.usd;
    }
    s.usd = Math.round(s.usd * 1e6) / 1e6; s.subscriptionUsd = Math.round(s.subscriptionUsd * 1e6) / 1e6;
    return s;
  }
}

module.exports = { CostLedger, localIso, readJsonl, FIELDS };

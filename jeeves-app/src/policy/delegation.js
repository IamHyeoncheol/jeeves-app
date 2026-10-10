// 위임 규칙(사전 승인) 저장소 — 기준서 3장 2026-10-10 "R3 = C안".
// 사용자가 PC 화면에서 "이 사이트에서 이 행동은 이 횟수·기간 안에서 묻지 말고 하라"고 정해 두면,
// 그 범위의 R2·R3 행동을 자동 실행한다. 규칙은 코드가 아니라 데이터(policy-rules.json)다.
// 안전 원칙
//  - 규칙을 만들거나 넓히는 것(add/update)은 PC 화면(source 'ui')에서만. AI·MCP·외부 내용은 불가.
//  - 끄기·삭제(범위 축소)는 어디서나 가능.
//  - R3 규칙은 사이트 지정과 유효기간(최대 90일)이 필수.
//  - mode 'shadow'(그림자 실행): 일치해도 자동 실행하지 않고 "자동이었다면 실행됐을 것"만 기록 → 정확도 확인 후 'auto'로 승격.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { LEVELS, rank } = require('./risk');

const PERIODS = ['day', 'month', 'total'];
const MAX_R3_DAYS = 90;
const DAY = 24 * 3600 * 1000;

function hostOf(url) {
  try { return new URL(/^[a-z]+:\/\//i.test(url) ? url : 'https://' + url).hostname.toLowerCase(); } catch (_) { return ''; }
}
function siteOk(sites, host) {
  if (!sites || !sites.length) return true;
  if (!host) return false;
  return sites.some(s => { const d = String(s).toLowerCase().replace(/^\*?\./, ''); return host === d || host.endsWith('.' + d); });
}
const clip = (s, n) => String(s == null ? '' : s).slice(0, n);

class DelegationStore {
  constructor({ file, now = () => new Date() } = {}) {
    this.file = file || null;
    this.now = now;
    this.data = { v: 1, rules: [], usage: {} };
    this.onError = null;
    this.load();
  }

  load() {
    if (!this.file) return;
    try {
      const d = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (d && Array.isArray(d.rules)) {
        // 파일을 손으로 고쳤을 수 있으므로 규칙마다 다시 검증하고, 맞지 않는 규칙은 버린다(검증 없이 R3 규칙이 들어오는 것 방지)
        const rules = [];
        for (const r of d.rules) {
          if (!r || typeof r !== 'object') continue;
          const n = this.normalize(r, {}, { loading: true });
          if (n.rule) rules.push(n.rule); else if (this.onError) this.onError(new Error(`위임 규칙 ${r.id || ''} 무시: ${n.error}`));
        }
        this.data = { v: 1, rules, usage: d.usage && typeof d.usage === 'object' ? d.usage : {} };
      }
    } catch (e) {
      if (e.code !== 'ENOENT') {
        // 깨진 파일은 따로 보관하고 빈 규칙으로 시작한다(규칙이 없으면 = 가장 안전한 상태)
        try { fs.renameSync(this.file, this.file + '.broken-' + Date.now()); } catch (_) {}
        if (this.onError) this.onError(e);
      }
    }
  }
  save() {
    if (!this.file) return true;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = this.file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf8');
      fs.renameSync(tmp, this.file);
      return true;
    } catch (e) { if (this.onError) this.onError(e); return false; }
  }

  list() { return this.data.rules.map(r => ({ ...r, used: this.usedCount(r) })); }
  get(id) { return this.data.rules.find(r => r.id === id) || null; }

  // 입력 검증 → 정돈된 규칙 또는 오류 문장
  normalize(spec, base = {}, { loading = false, checkPast = !loading } = {}) {
    const r = { ...base, ...spec };
    const actions = (Array.isArray(r.actions) ? r.actions : String(r.actions || '').split(','))
      .map(s => String(s).trim()).filter(Boolean).slice(0, 20);
    if (!actions.length) return { error: '행동 종류를 하나 이상 정해 주세요.' };
    const maxLevel = r.maxLevel === 'R3' ? 'R3' : 'R2';
    const sites = (Array.isArray(r.sites) ? r.sites : String(r.sites || '').split(','))
      .map(s => hostOf(String(s).trim()) || String(s).trim().toLowerCase()).filter(Boolean).slice(0, 20);
    const labels = (Array.isArray(r.labels) ? r.labels : String(r.labels || '').split(','))
      .map(s => clip(String(s).trim(), 40)).filter(Boolean).slice(0, 20);
    const mc = parseInt(r.maxCount, 10);
    const maxCount = mc > 0 ? Math.min(10000, mc) : null;
    const period = PERIODS.includes(r.period) ? r.period : 'day';
    let expiresAt = r.expiresAt ? new Date(r.expiresAt) : null;
    if (expiresAt && isNaN(expiresAt)) return { error: '유효기간 날짜 형식이 올바르지 않습니다.' };
    const now = this.now();
    if (checkPast && expiresAt && expiresAt <= now) return { error: '유효기간이 이미 지났습니다.' };
    if (maxLevel === 'R3') {
      if (!sites.length) return { error: 'R3(금전·계정) 위임은 사이트를 꼭 지정해야 합니다.' };
      if (actions.includes('*')) return { error: 'R3(금전·계정) 위임은 행동 종류를 구체적으로 정해야 합니다("*" 불가).' };
      if (!maxCount) return { error: 'R3(금전·계정) 위임은 횟수 한도를 꼭 정해야 합니다.' };
      let created = r.createdAt ? new Date(r.createdAt) : now;
      if (isNaN(created) || created > now) created = now;   // 미래로 적힌 작성일은 인정하지 않는다
      const cap = new Date((r.createdAt ? created : now).getTime() + MAX_R3_DAYS * DAY);   // 만든 날 기준 90일(읽기·수정 공통)
      if (!expiresAt) return { error: `R3(금전·계정) 위임은 유효기간(최대 ${MAX_R3_DAYS}일)을 꼭 정해야 합니다.` };
      if (expiresAt > cap) return { error: `R3(금전·계정) 위임의 유효기간은 최대 ${MAX_R3_DAYS}일입니다.` };
    }
    return {
      rule: {
        id: r.id || 'dg_' + crypto.randomBytes(5).toString('hex'),
        org: clip(r.org || 'default', 40), user: clip(r.user || 'owner', 40),
        enabled: r.enabled !== false, mode: r.mode === 'shadow' ? 'shadow' : 'auto',
        actions, maxLevel, sites, labels, maxCount, period,
        expiresAt: expiresAt ? expiresAt.toISOString() : null,
        note: clip(r.note, 200),
        createdAt: r.createdAt && new Date(r.createdAt) <= now ? new Date(r.createdAt).toISOString() : now.toISOString(), createdBy: r.createdBy || 'ui'
      }
    };
  }

  add(spec, { source } = {}) {
    if (source !== 'ui') return { ok: false, error: '위임 규칙은 PC 화면에서 사용자만 만들 수 있습니다.' };
    const { id: _ignored, createdAt: _c, createdBy: _b, ...clean } = spec || {};   // id·작성 정보는 저장소가 정한다
    const n = this.normalize({ ...clean, createdBy: 'ui' });
    if (n.error) return { ok: false, error: n.error };
    const rule = n.rule;
    this.data.rules.push(rule);
    return this.save() ? { ok: true, rule } : { ok: false, error: '규칙 파일을 저장하지 못했습니다.' };
  }
  update(id, patch, { source } = {}) {
    const cur = this.get(id);
    if (!cur) return { ok: false, error: '규칙을 찾을 수 없습니다.' };
    const narrowing = patch && Object.keys(patch).every(k => k === 'enabled' && patch.enabled === false);
    if (source !== 'ui' && !narrowing) return { ok: false, error: '위임 규칙을 바꾸는 것은 PC 화면에서만 할 수 있습니다(끄기는 가능).' };
    // 이미 지난 규칙도 끄기·그림자 전환은 되어야 하므로, 날짜를 새로 넣을 때만 "이미 지남"을 검사한다
    const n = this.normalize({ ...patch, id, createdAt: cur.createdAt, createdBy: cur.createdBy }, cur, { checkPast: patch && patch.expiresAt !== undefined });
    if (n.error) return { ok: false, error: n.error };
    Object.assign(cur, n.rule);
    return this.save() ? { ok: true, rule: cur } : { ok: false, error: '규칙 파일을 저장하지 못했습니다.' };
  }
  remove(id) {
    const before = this.data.rules.length;
    this.data.rules = this.data.rules.filter(r => r.id !== id);
    delete this.data.usage[id];
    if (this.data.rules.length === before) return { ok: false, error: '규칙을 찾을 수 없습니다.' };
    return { ok: this.save() };
  }

  periodKey(period, d = this.now()) {
    const p = n => String(n).padStart(2, '0');
    if (period === 'total') return 'total';
    if (period === 'month') return `${d.getFullYear()}-${p(d.getMonth() + 1)}`;
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  }
  usedCount(rule) { const u = this.data.usage[rule.id]; return (u && u[this.periodKey(rule.period)]) || 0; }

  // ctx: { name, level, url, label, org }
  // 반환: { rule, reason } — rule 이 null 이면 reason 에 왜 안 맞는지(가장 그럴듯한 것)
  match(ctx = {}) {
    const host = hostOf(ctx.url || '');
    const lv = ctx.level;
    if (!LEVELS.includes(lv) || rank(lv) < 2) return { rule: null, reason: 'R2 미만은 위임이 필요 없음' };
    const now = this.now();
    let reason = '맞는 위임 규칙 없음';
    for (const r of this.data.rules) {
      if (!r.enabled) continue;
      if ((r.org || 'default') !== (ctx.org || 'default')) continue;
      if (rank(lv) > rank(r.maxLevel)) continue;
      if (!(r.actions.includes('*') || r.actions.includes(ctx.name))) continue;
      if (!siteOk(r.sites, host)) continue;
      if (r.labels && r.labels.length && !r.labels.some(l => String(ctx.label || '').toLowerCase().includes(l.toLowerCase()))) continue;
      if (r.expiresAt && new Date(r.expiresAt) <= now) { reason = `위임 규칙 "${r.note || r.id}" 유효기간 지남`; continue; }
      if (r.maxCount && this.usedCount(r) >= r.maxCount) { reason = `위임 규칙 "${r.note || r.id}" 횟수 한도(${r.maxCount}) 소진`; continue; }
      return { rule: r, reason: '' };
    }
    return { rule: null, reason };
  }
  consume(id) {
    const r = this.get(id); if (!r) return false;
    const k = this.periodKey(r.period);
    const u = (this.data.usage[id] = this.data.usage[id] || {});
    // 지난 기간 기록은 정리(파일이 끝없이 커지지 않게)
    for (const key of Object.keys(u)) if (key !== k) delete u[key];
    u[k] = (u[k] || 0) + 1;
    this.save();
    return true;
  }
}

module.exports = { DelegationStore, hostOf, siteOk, MAX_R3_DAYS };

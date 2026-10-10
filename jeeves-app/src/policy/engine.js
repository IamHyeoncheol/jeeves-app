// 정책 엔진: 위험 판정(risk) + 위임 규칙(delegation) + 비상 정지(kill-switch) + 감사 기록(audit)을 한 곳에서 결합한다.
// 브라우저 에이전트·외부 에이전트(MCP)·메일 실행기 등 "행동"을 하는 모든 곳이 이 판정 하나를 쓴다.
// 판정 순서(사양서 01 개정 2026-10-10):
//   비상 정지 → 하드 차단(규칙으로도 못 풂) → R3(위임 규칙 있으면 자동, 없으면 차단) → R2(규칙 있으면 자동, 없으면 확인)
//   → "모든 행동 확인" 모드 → R0·R1 자동
const { classify, BROWSER_WRITE } = require('./risk');

const NO_RULE_R3 = ' — 위임 규칙이 없어 실행하지 않았습니다. 사용자가 PC에서 직접 하거나, 설정 → "자동 위임 규칙"에 이 사이트·행동을 추가하면 다음부터 자동으로 처리합니다.';

class PolicyEngine {
  // deps: { audit, ledger, killSwitch, delegation, opts: () => ({ trashLevel }) | object }
  constructor({ audit = null, ledger = null, killSwitch = null, delegation = null, opts = {} } = {}) {
    this.audit = audit; this.ledger = ledger; this.killSwitch = killSwitch; this.delegation = delegation;
    this.opts = typeof opts === 'function' ? opts : () => opts;
  }
  get halted() { return !!(this.killSwitch && this.killSwitch.halted); }

  // ctx: { name, input, snap, url, source, confirmMode, aiLevel, taskId, org, user }
  evaluate(ctx = {}) {
    const { name, input = {}, snap = null, confirmMode = 'risky', aiLevel = null, org = 'default' } = ctx;
    const el = snap && input.id != null && Array.isArray(snap.elements) ? snap.elements.find(e => e.id === input.id) : null;
    const label = el ? String(el.name || '') : String(ctx.label || '');
    const url = name === 'navigate' ? String(input.url || '') : String(ctx.url || (snap && snap.url) || '');
    const base = { label, url, kind: el ? el.kind : '' };
    if (this.halted) return { ...base, level: 'R0', rule: 'halted', why: '비상 정지 중입니다. PC 화면에서 재개해야 합니다.', hard: false, decision: 'halted' };

    let c;
    try { c = classify({ name, input, snap, aiLevel, opts: this.opts() || {} }); }
    catch (e) { c = { level: 'R3', block: true, hard: false, rule: 'classify-error', why: '위험 판정 오류로 안전하게 멈춥니다: ' + e.message }; }
    const r = { ...base, level: c.level, rule: c.rule, why: c.why, hard: !!c.hard, decision: 'auto', ruleId: null, shadowRuleId: null };
    if (c.hard) { r.decision = 'block'; return r; }

    if (c.level === 'R2' || c.level === 'R3') {
      let m = { rule: null, reason: '' };
      try { if (this.delegation) m = this.delegation.match({ name, level: c.level, url, label, org }); } catch (_) { m = { rule: null, reason: '위임 규칙 확인 오류' }; }   // 규칙 오류는 "규칙 없음"(안전 쪽)
      if (m.rule && m.rule.mode !== 'shadow') {
        this.delegation.consume(m.rule.id);
        r.decision = 'delegated'; r.ruleId = m.rule.id;
        r.why = `${c.why} → 위임 규칙 "${m.rule.note || m.rule.id}"에 따라 자동 실행`;
        return r;
      }
      if (m.rule) r.shadowRuleId = m.rule.id;   // 그림자 실행: 자동이었다면 실행됐을 것만 기록
      if (c.level === 'R3') { r.decision = 'block'; r.why = c.why + NO_RULE_R3; return r; }
      r.decision = 'confirm';
      return r;
    }
    if (confirmMode === 'always' && BROWSER_WRITE.has(name)) { r.decision = 'confirm'; r.why = '모든 행동 확인 모드'; }
    return r;
  }

  // 결과를 감사 기록에 남긴다. outcome: { decision?(approved|refused|timeout|cancelled|halted 등 최종), ok, message }
  record(ctx = {}, res = {}, outcome = {}) {
    if (!this.audit) return null;
    // 결과 문장에 입력값·전체 주소가 들어갈 수 있는 행동은 문장을 남기지 않는다(성공 여부와 대상만)
    const quiet = ['type_text', 'select_option', 'navigate'].includes(ctx.name);
    return this.audit.write({
      kind: 'action', taskId: ctx.taskId, source: ctx.source, action: ctx.name, level: res.level, rule: res.rule,
      aiLevel: ctx.aiLevel || undefined, decision: outcome.decision || res.decision, ruleId: res.ruleId || undefined,
      shadowRuleId: res.shadowRuleId || undefined, ok: outcome.ok, org: ctx.org, user: ctx.user,
      target: { url: res.url, label: res.label, kind: res.kind }, input: ctx.input, message: quiet ? undefined : outcome.message, why: res.why
    });
  }
  event(ev) { return this.audit ? this.audit.write(ev) : null; }
  cost(entry) { return this.ledger ? this.ledger.append(entry) : null; }
}

module.exports = { PolicyEngine, NO_RULE_R3 };

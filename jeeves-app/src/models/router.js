// 모델 라우터: "부문(role)" 이름만 받으면 설정에 배정된 공급자·모델로 연결하고,
// 호출마다 토큰 사용량과 비용(달러)을 계산해 돌려준다.
const { ADAPTERS, ProviderError } = require('./providers');
const { costUsd } = require('./pricing');
const { recommendFor, GRADES, GRADE_INFO, gradeOk } = require('./recommend');

class ModelRouter {
  constructor(getConfig, fetchImpl) {
    this.getConfig = getConfig;
    this.fetch = fetchImpl || globalThis.fetch;
    this.usage = {}; // 부문별 누적: { calls, input, output, cacheRead, cacheWrite, usd, unknownCost }
  }

  resolve(role, gradeOverride) {
    const cfg = this.getConfig();
    const grade = GRADES.includes(gradeOverride) ? gradeOverride : (GRADES.includes(cfg.infoGrade) ? cfg.infoGrade : 'P');
    let r = cfg.roles[role];
    if (!r) throw new ProviderError(`'${role}' 부문 설정이 없습니다.`);
    // 추천 모드: 키가 있는 공급자 중 필요 등급을 채우는 가장 싼 것(무료 우선)을 그때그때 고른다. 추천할 게 없으면 저장된 배정을 쓴다.
    if (r.mode === 'auto') {
      const rec = recommendFor(cfg, role, grade);
      if (rec) r = { ...r, provider: rec.provider, model: rec.model, effort: rec.provider === 'anthropic' ? r.effort : '' };
    }
    const p = cfg.providers[r.provider];
    if (!p) throw new ProviderError(`'${r.label}' 부문에 배정된 공급자(${r.provider})를 찾을 수 없습니다.`);
    if (p.disabled) throw new ProviderError(`'${p.label}' 공급자는 아직 사용할 수 없습니다.`);
    // 정보 등급 관문: 이 공급자가 다룰 수 없는 등급이면 자동·직접 배정 모두 막는다(코드가 판정)
    if (!gradeOk(p, grade)) throw new ProviderError(`정보 등급 ${grade}(${GRADE_INFO[grade].name})에는 '${p.label}'을(를) 쓸 수 없습니다. 설정에서 이 공급자의 허용 등급을 바꾸거나, 허용된 공급자를 배정해 주세요.`);
    const local = /127\.0\.0\.1|localhost/.test(p.baseUrl);
    if (!p.apiKey && !local) throw new ProviderError(`${p.label} API 키가 없습니다. 설정(⚙)에서 입력해 주세요.`);
    const adapter = ADAPTERS[p.type];
    if (!adapter) throw new ProviderError(`지원하지 않는 공급자 방식: ${p.type}`);
    return { roleCfg: r, provider: p, adapter };
  }

  // 이 부문을 지금 쓸 수 있는지(키가 있는지) 미리 확인
  available(role, grade) {
    try { this.resolve(role, grade); return true; } catch (_) { return false; }
  }

  record(role, model, usage, provider) {
    // 무료로 표시한 공급자는 0원으로 계산한다(유료 계정이면 설정에서 '유료'로 바꿀 것)
    const usd = provider && provider.tier === 'free' ? 0 : costUsd(model, usage);
    const u = (this.usage[role] = this.usage[role] || { calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, usd: 0, unknownCost: false });
    u.calls += 1; u.input += usage.input || 0; u.output += usage.output || 0;
    u.cacheRead += usage.cacheRead || 0; u.cacheWrite += usage.cacheWrite || 0;
    if (usd === null) u.unknownCost = true; else u.usd += usd;
    return usd;
  }

  async call(role, req) {
    const { roleCfg, provider, adapter } = this.resolve(role, req && req.infoGrade);
    const full = { effort: roleCfg.effort || undefined, ...req };
    let lastErr;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await adapter(provider, roleCfg.model, full, this.fetch);
        res.costUsd = this.record(role, roleCfg.model, res.usage, provider);
        res.model = `${provider.label} · ${roleCfg.model}`;
        res.modelId = roleCfg.model;
        return res;
      } catch (e) {
        lastErr = e;
        if (e.name === 'AbortError' || !e.retryable) throw e;
        await new Promise(r => setTimeout(r, 1500 * (attempt + 1)));
      }
    }
    throw lastErr;
  }

  async testRole(role) {
    const { provider } = this.resolve(role);
    if (provider.type === 'jev') {
      const res = await this.call(role, { state: '사용자가 "연결 테스트"라고 입력함', questions: { ok: { type: 'choice', instructions: '연결 테스트입니다. ok 를 고르세요.', criteria: { ok: '정상', no: '비정상' } } } });
      const a = res.answers.ok || {};
      return { ok: true, model: res.model, text: `${a.choice} (신뢰도 ${Math.round((a.confidence || 0) * 100)}%)` };
    }
    const res = await this.call(role, { system: '짧게 답하세요.', messages: [{ role: 'user', content: [{ type: 'text', text: '연결 테스트입니다. "OK"라고만 답하세요.' }] }], maxTokens: 512 });
    return { ok: true, model: res.model, text: res.content.filter(b => b.type === 'text').map(b => b.text).join('').slice(0, 100) };
  }
}

module.exports = { ModelRouter };

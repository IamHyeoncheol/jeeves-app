// 모델 라우터: "부문(role)" 이름만 받으면 설정에 배정된 공급자·모델로 연결하고,
// 호출마다 토큰 사용량과 비용(달러)을 계산해 돌려준다.
const { ADAPTERS, ProviderError } = require('./providers');
const { costUsd } = require('./pricing');
const { recommendFor, GRADES, GRADE_INFO, gradeOk } = require('./recommend');

// 자동 전환: 한도·잔액·키 오류·서버 장애로 막힌 공급자는 잠시 "쉬는 중"으로 두고 다음 공급자(무료 → 저렴한 순)로 넘긴다.
// 쉬는 시간은 오류 종류별: 잔액 부족·키 오류 30분, 사용량 한도 10분, 서버 오류 2분, 연결 실패 1분 (시간이 지나면 다시 시도)
const COOL_MS = { credit: 30 * 60e3, auth: 30 * 60e3, limit: 10 * 60e3, server: 2 * 60e3, network: 60e3 };
const KIND_TXT = { credit: '잔액·한도 소진', auth: '키 오류', limit: '사용량 한도', server: '서버 오류', network: '연결 실패' };

class ModelRouter {
  constructor(getConfig, fetchImpl, clock) {
    this.getConfig = getConfig;
    this.fetch = fetchImpl || globalThis.fetch;
    this.now = clock || Date.now;
    this.usage = {}; // 부문별 누적: { calls, input, output, cacheRead, cacheWrite, usd, unknownCost }
    this.cool = {};  // 공급자별 쉬는 중: { id: { until, kind, msg } }
    this.stats = {}; // 공급자별 누적: { calls, fails, usd, lastError }
    this.onNotice = null;   // 자동 전환했을 때 알림을 받는 함수(화면 안내용)
  }

  // 지금 쉬는 중인 공급자 id 집합
  coolSet() {
    const t = this.now(), s = new Set();
    for (const [id, c] of Object.entries(this.cool)) { if (c.until > t) s.add(id); else delete this.cool[id]; }
    return s;
  }
  clearCooldown(id) { if (id) delete this.cool[id]; else this.cool = {}; }
  markCool(id, e) {
    const ms = COOL_MS[e.kind] || 60e3;
    this.cool[id] = { until: this.now() + ms, kind: e.kind, msg: String(e.message || '').slice(0, 200) };
    const st = (this.stats[id] = this.stats[id] || { calls: 0, fails: 0, usd: 0, lastError: '' });
    st.fails++; st.lastError = e.message;
  }
  // 화면용 현황: 공급자별 호출·비용·쉬는 중 여부
  status() {
    const cfg = this.getConfig(), t = this.now(), out = [];
    for (const [id, p] of Object.entries(cfg.providers || {})) {
      const st = this.stats[id] || { calls: 0, fails: 0, usd: 0, lastError: '' };
      const c = this.cool[id] && this.cool[id].until > t ? this.cool[id] : null;
      out.push({ id, label: p.label, tier: p.tier, hasKey: !!p.apiKey, calls: st.calls, fails: st.fails, usd: Math.round(st.usd * 10000) / 10000, resting: !!c, restKind: c ? KIND_TXT[c.kind] : '', restMin: c ? Math.ceil((c.until - t) / 60000) : 0, lastError: st.lastError });
    }
    return out;
  }

  // opts.exclude: 건너뛸 공급자 id 집합 / opts.fallback: 저장된 배정 대신 추천 순서로 고름(자동 전환) / opts.tier: 'free' 면 무료만
  resolve(role, gradeOverride, opts) {
    opts = opts || {};
    const cfg = this.getConfig();
    const grade = GRADES.includes(gradeOverride) ? gradeOverride : (GRADES.includes(cfg.infoGrade) ? cfg.infoGrade : 'P');
    let r = cfg.roles[role];
    if (!r) throw new ProviderError(`'${role}' 부문 설정이 없습니다.`);
    // 추천 모드: 키가 있는 공급자 중 필요 등급을 채우는 가장 싼 것(무료 우선)을 그때그때 고른다. 추천할 게 없으면 저장된 배정을 쓴다.
    const skip = new Set([...this.coolSet(), ...(opts.exclude || [])]);
    if (r.mode === 'auto' || opts.fallback || opts.tier) {
      const rec = recommendFor(cfg, role, grade, { exclude: skip, tier: opts.tier });
      if (rec) r = { ...r, provider: rec.provider, model: rec.model, effort: rec.provider === 'anthropic' ? r.effort : '' };
      else {
        // 추천할 곳이 없을 때 저장된 배정으로 대신하되, 사용자가 "추천에서 제외"한 공급자(잔액 없음 등)로는 가지 않는다
        const sp = cfg.providers[r.provider];
        if (opts.fallback || skip.has(r.provider)) { const e = new ProviderError(`지금 쓸 수 있는 공급자가 없습니다(정보 등급 ${grade} 기준). 한도·잔액이 소진되어 쉬는 중이거나 키가 없는 공급자뿐입니다.`); e.kind = 'none'; throw e; }
        if (sp && sp.off) throw new ProviderError(`지금 쓸 수 있는 공급자가 없습니다. 정보 등급 ${grade}(${GRADE_INFO[grade].name})를 처리할 수 있고 키가 있는 공급자가 없고, '${sp.label}'은(는) 추천에서 제외돼 있습니다. 해결: ① 공개 정보라면 설정의 시작 등급을 P로(무료 Gemini 사용 가능) ② Gemini가 유료 계정이면 설정에서 Gemini 허용 등급을 I로 ③ OpenAI 등 유료 키 추가 ④ '${sp.label}' 충전 후 "추천에서 제외" 해제`);
      }
    }
    if (opts.tier === 'free' && (cfg.providers[r.provider] || {}).tier !== 'free') { const e = new ProviderError('무료 공급자가 없습니다.'); e.kind = 'none'; throw e; }
    if (skip.has(r.provider)) { const e = new ProviderError(`'${(cfg.providers[r.provider] || {}).label || r.provider}' 은(는) 지금 쉬는 중입니다.`); e.kind = 'resting'; e.providerId = r.provider; throw e; }
    const p = cfg.providers[r.provider];
    if (!p) throw new ProviderError(`'${r.label}' 부문에 배정된 공급자(${r.provider})를 찾을 수 없습니다.`);
    if (p.disabled) throw new ProviderError(`'${p.label}' 공급자는 아직 사용할 수 없습니다.`);
    // 정보 등급 관문: 이 공급자가 다룰 수 없는 등급이면 자동·직접 배정 모두 막는다(코드가 판정)
    if (!gradeOk(p, grade)) throw new ProviderError(`정보 등급 ${grade}(${GRADE_INFO[grade].name})에는 '${p.label}'을(를) 쓸 수 없습니다. 설정에서 이 공급자의 허용 등급을 바꾸거나, 허용된 공급자를 배정해 주세요.`);
    const local = /127\.0\.0\.1|localhost/.test(p.baseUrl);
    if (!p.apiKey && !local) throw new ProviderError(`${p.label} API 키가 없습니다. 설정(⚙)에서 입력해 주세요.`);
    const adapter = ADAPTERS[p.type];
    if (!adapter) throw new ProviderError(`지원하지 않는 공급자 방식: ${p.type}`);
    return { roleCfg: r, provider: p, adapter, id: r.provider };
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
    if (provider && provider.id) { const st = (this.stats[provider.id] = this.stats[provider.id] || { calls: 0, fails: 0, usd: 0, lastError: '' }); st.calls++; if (usd) st.usd += usd; }
    u.cacheRead += usage.cacheRead || 0; u.cacheWrite += usage.cacheWrite || 0;
    if (usd === null) u.unknownCost = true; else u.usd += usd;
    return usd;
  }

  // 한 번 호출. 공급자가 한도·잔액·키·서버 문제로 막히면(설정에서 자동 전환이 켜져 있을 때) 다음 공급자로 자동 전환해 같은 요청을 다시 보낸다.
  // req.freeOnly: 무료 공급자만 시도. 결과에 failover(전환 기록 문장 배열)가 붙는다.
  async call(role, req) {
    const grade = req && req.infoGrade;
    const on = this.getConfig().failover !== false;
    const tried = new Set(), notices = [];
    let fallback = false, firstErr = null;
    for (let hop = 0; hop < 8; hop++) {
      let r;
      try { r = this.resolve(role, grade, { exclude: tried, fallback, tier: req && req.freeOnly ? 'free' : undefined }); }
      catch (e) {
        if (e.kind === 'resting' && on && !fallback) { tried.add(e.providerId); fallback = true; continue; }   // 저장된 배정이 쉬는 중이면 추천 순서로
        if (firstErr) throw this.exhausted(notices, firstErr, e);
        throw e;
      }
      try {
        const res = await this.callOne(role, r, req);
        if (notices.length) res.failover = notices;
        return res;
      } catch (e) {
        if (e.name === 'AbortError' || !on || !KIND_TXT[e.kind]) throw e;   // 형식 오류 등은 전환해도 소용없으므로 그대로 알림
        if (!firstErr) firstErr = e;
        this.markCool(r.id, e);
        tried.add(r.id); fallback = true;
        const note = `${r.provider.label} ${KIND_TXT[e.kind]} → 다음 공급자로 자동 전환`;
        notices.push(note);
        if (this.onNotice) { try { this.onNotice(note); } catch (_) {} }
      }
    }
    throw this.exhausted(notices, firstErr, null);
  }

  exhausted(notices, firstErr, lastErr) {
    // 바꿔 쓸 다른 공급자가 아예 없었으면 원래 오류(해결 방법이 적힌 문장)를 그대로 보여 준다
    if (notices.length <= 1 && lastErr && lastErr.kind === 'none') { firstErr.message += '  (바꿔 쓸 다른 공급자가 없어 자동 전환하지 못했습니다. 설정에서 다른 공급자 키를 추가하면 자동 전환됩니다.)'; return firstErr; }
    const e = new ProviderError(`쓸 수 있는 AI 공급자가 모두 막혔습니다. ${notices.join(' / ')}. 마지막 오류: ${(lastErr || firstErr).message}  해결: ① 잠시 뒤 다시 시도(쉬는 시간 후 자동 재시도) ② 한도·잔액이 소진된 공급자 충전 ③ 다른 공급자 키 추가 ④ 설정에서 정보 등급이 너무 높지 않은지 확인`);
    e.kind = 'exhausted';
    return e;
  }

  async callOne(role, r, req) {
    const { roleCfg, provider, adapter } = r;
    provider.id = r.id;
    const full = { effort: roleCfg.effort || undefined, ...req };
    delete full.freeOnly;
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
        // 한도(429)는 같은 곳에 오래 매달리지 않고 한 번만 짧게 다시 해 본 뒤 전환한다
        if (e.kind === 'limit' && attempt >= 1) throw e;
        await new Promise(r => setTimeout(r, this.now === Date.now ? 1500 * (attempt + 1) : 0));
      }
    }
    throw lastErr;
  }

  // 지정한 공급자·모델로 직접 한 번 호출한다(개발 모드 주니어 엔진용). 부문 배정과 무관하게 정보 등급·키·쉬는 중 여부는 그대로 검문한다.
  // providerOrId: 설정의 공급자 id(문자열) 또는 인라인 공급자 객체({type,label,baseUrl,apiKey,tier}) — 로컬 AI 자동 탐지용
  async callProvider(providerOrId, model, req) {
    const cfg = this.getConfig();
    const inline = typeof providerOrId === 'object' && providerOrId;
    const p = inline ? { ...providerOrId } : cfg.providers[providerOrId];
    if (!p) throw new ProviderError(`공급자(${providerOrId})를 찾을 수 없습니다.`);
    const id = inline ? 'inline:' + p.label + ':' + p.baseUrl : providerOrId;
    p.id = id;
    const grade = GRADES.includes(req && req.infoGrade) ? req.infoGrade : (GRADES.includes(cfg.infoGrade) ? cfg.infoGrade : 'P');
    if (p.disabled || p.off) { const e = new ProviderError(`'${p.label}' 은(는) 지금 쓸 수 없습니다.`); e.kind = 'none'; throw e; }
    if (!gradeOk(p, grade)) { const e = new ProviderError(`정보 등급 ${grade}(${GRADE_INFO[grade].name})에는 '${p.label}'을(를) 쓸 수 없습니다.`); e.kind = 'none'; throw e; }
    const local = /127\.0\.0\.1|localhost/.test(p.baseUrl || '');
    if (!p.apiKey && !local) { const e = new ProviderError(`${p.label} API 키가 없습니다.`); e.kind = 'auth'; throw e; }
    if (this.coolSet().has(id)) { const e = new ProviderError(`'${p.label}' 은(는) 지금 쉬는 중입니다.`); e.kind = 'resting'; e.providerId = id; throw e; }
    const adapter = ADAPTERS[p.type];
    if (!adapter) throw new ProviderError(`지원하지 않는 공급자 방식: ${p.type}`);
    const full = { ...req }; delete full.freeOnly;
    let lastErr;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await adapter(p, model, full, this.fetch);
        res.costUsd = this.record('dev', model, res.usage || {}, p);
        res.model = `${p.label} · ${model}`; res.modelId = model;
        return res;
      } catch (e) {
        lastErr = e;
        if (e.name === 'AbortError' || !e.retryable) { if (KIND_TXT[e.kind]) this.markCool(id, e); throw e; }
        if (e.kind === 'limit' && attempt >= 1) break;
        await new Promise(r => setTimeout(r, this.now === Date.now ? 1500 * (attempt + 1) : 0));
      }
    }
    if (KIND_TXT[lastErr.kind]) this.markCool(id, lastErr);
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

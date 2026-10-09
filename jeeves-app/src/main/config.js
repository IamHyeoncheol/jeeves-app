// 설정 저장소: 역할별 모델 배정, 공급자(API) 정보, 안전 설정
// API 키는 Windows 자격 증명 보호(DPAPI) 기반 safeStorage 로 암호화해 저장한다.
const fs = require('fs');
const path = require('path');
const { recommendAll, GRADES, effectiveMaxGrade } = require('../models/recommend');
const ENGINE_GRADES = ['P', 'I', 'C'];   // 구독 엔진 허용 등급 후보(S는 항상 차단)

// ── 기본값 ────────────────────────────────────────────────
// providers: AI 회사(접속 창구). type 이 같으면 같은 통신 방식을 쓴다.
// roles: 앱 안의 "부문". 부문마다 다른 모델을 배정할 수 있다.
const ROLE_DEFAULTS = {
  chat:        { label: '대화 (질문·답변)',             provider: 'anthropic', model: 'claude-sonnet-5-5', effort: 'medium' },
  agent:       { label: '작업 (브라우저 조작) 기본',     provider: 'anthropic', model: 'claude-sonnet-5-5', effort: 'medium' },
  agentStrong: { label: '작업 승격 (막혔을 때)',         provider: 'anthropic', model: 'claude-opus-5-5',   effort: 'medium' },
  summarize:   { label: '요약·정리 (페이지 요약)',        provider: 'anthropic', model: 'claude-haiku-4-5-20251001', effort: '' },
  decide:      { label: '빠른 판단 (다음 클릭 고르기)',   provider: 'typesafe',  model: 'jev-latest',        effort: '' }
};

// 부문 배정 방식: 'auto' = 추천(키가 있는 공급자 중 필요 등급을 채우는 가장 싼 것, 무료 우선) / 'manual' = 직접 고른 공급자·모델
for (const r of Object.values(ROLE_DEFAULTS)) r.mode = 'auto';

// tier: 'free' = 무료(비용 0원으로 계산) / 'paid' = 유료(단가표로 계산). 사용자가 공급자마다 바꿀 수 있다.
//  (Gemini는 공식 가격 페이지상 무료 등급이 있어 기본 '무료', 요금을 내는 계정이면 '유료'로 바꿀 것. 나머지는 보수적으로 '유료')
const DEFAULTS = {
  version: 3,
  providers: {
    anthropic: { type: 'anthropic', label: 'Anthropic (Claude)', baseUrl: 'https://api.anthropic.com', apiKey: '', tier: 'paid' },
    gemini: { type: 'openai', label: 'Google Gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', apiKey: '', tier: 'free' },
    typesafe: { type: 'jev', label: 'TypeSafe Jev (판단 전용)', baseUrl: 'https://api.typesafe.ai', apiKey: '', tier: 'paid' },
    openrouter: { type: 'openai', label: 'OpenRouter (여러 모델)', baseUrl: 'https://openrouter.ai/api/v1', apiKey: '', tier: 'paid' },
    openai: { type: 'openai', label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', apiKey: '', tier: 'paid' },
    // xAI Grok: 공식 문서에서 주소·모델명 확인(2026-10-09). 채팅 호환 경로는 "Legacy"로 표기돼 있어 연결 테스트로 확인 필요
    xai: { type: 'openai', label: 'xAI Grok', baseUrl: 'https://api.x.ai/v1', apiKey: '', tier: 'paid', maxGrade: 'P' },   // 학습 사용 여부 미확인 → 확인 전까지 공개(P)만
    // Zhipu GLM(Z.ai, 중국): 데이터 처리 정책 미확인 → 자동 추천에서는 제외하고 "직접" 선택으로만 쓴다
    zai: { type: 'openai', label: 'Zhipu GLM (Z.ai)', baseUrl: 'https://api.z.ai/api/paas/v4', apiKey: '', tier: 'paid', maxGrade: 'P' },
    // Kimi(Moonshot)·DeepSeek(중국): 공개(P) 정보 전용, 추천 대상 아님(직접 선택만). 주소·모델명은 일반 지식 기준이라 연결 테스트로 확인 필요(공식 문서 미확인)
    moonshot: { type: 'openai', label: 'Kimi (Moonshot AI)', baseUrl: 'https://api.moonshot.ai/v1', apiKey: '', tier: 'paid', maxGrade: 'P' },
    deepseek: { type: 'openai', label: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', apiKey: '', tier: 'paid', maxGrade: 'P' },
    // ExoLobe(magnumatics.com): API 가 아니라 웹 로그인 후 대화창으로 쓰는 AI. 로그인은 지브스 브라우저에서 직접. 공유 계정이라 공개(P) 정보만, 답은 근거 미검증(활용안 A 규칙)
    // id 를 exolobe-web 으로 둔 이유: 예전에 사용자가 직접 추가한 'exolobe'(API 방식, 키 없음)와 겹치지 않게
    'exolobe-web': { type: 'webchat', label: 'ExoLobe 웹 로그인 (키 필요 없음)', baseUrl: 'https://www.magnumatics.com/chat', apiKey: '', tier: 'free', maxGrade: 'P' },
    ollama: { type: 'openai', label: 'Ollama (내 PC 로컬 모델)', baseUrl: 'http://127.0.0.1:11434/v1', apiKey: 'ollama', tier: 'free' }
  },
  removedProviders: [],   // 사용자가 지운 기본 공급자 id (다시 살아나지 않게 기록)
  roles: ROLE_DEFAULTS,
  agent: {
    mode: 'auto',              // 'auto' = Jev 키가 있으면 혼합, 'hybrid' = Jev+Claude 혼합, 'llm' = Claude만
    jevConfidence: 0.7,        // Jev 신뢰도가 이보다 낮으면 Claude에게 넘긴다
    maxSteps: 30,
    confirmMode: 'risky',      // 'risky' = 위험 동작만 확인, 'always' = 모든 행동 확인
    screenshotMode: 'auto',    // 'auto' = 첫 화면·실패·요청 때만, 'always' = 매 단계, 'never' = 안 보냄
    escalate: true,            // 2번 연속 실패하면 상위 모델로 넘김
    budgetKrw: 500,            // 작업 1건 예산(원). 넘으면 계속할지 묻는다
    viewport: { width: 1440, height: 900 }
  },
  failover: true,   // 한도·잔액 소진·장애 시 다음 공급자로 자동 전환
  infoGrade: 'I',   // 새 대화·작업의 시작 등급(P 공개/I 내부/C 기밀/S 비밀). 대화·작업마다 입력창 옆 선택칸으로 바꿀 수 있다
  ui: { homepage: 'https://www.google.com', krwPerUsd: 1400, layout: 'chat', previewWidth: 400, panelWidth: 420 }, // layout: 'chat' = 작업 화면 중심, 'web' = 웹 크게
  // 작업 엔진: 'api' = API 키(Claude·Jev 등, 사용량만큼 과금) / 'claude-code' = 내 PC 의 정품 Claude Code(내 구독)
  engine: { type: 'api', claudePath: '', claudeModel: 'sonnet', maxGrade: 'I', useForChat: true },   // maxGrade: 구독 엔진이 받을 수 있는 최고 정보 등급(S는 항상 차단)
  // 외부 에이전트(Claude Code·Codex)가 Jeeves 브라우저를 쓰게 하는 창구 (내 PC 안에서만)
  mcp: { enabled: true, port: 47840, token: '', allowExternal: false },
  // 개발 모드: 지브스가 개발 AI(Claude Code·Codex·기타 명령줄 AI)를 고른 프로젝트 폴더 안에서만 실행. 난이도(L1~L4)에 따라 엔진을 고른다.
  dev: {
    folder: '', prefer: ['claude', 'codex'], preferMode: 'auto', claudeMaxGrade: 'I',
    junior: { enabled: true, local: true, free: true, paid: false, maxLevel: 2, team: true, confirm: true },   // 주니어 엔진: 지브스가 직접 굴리는 코딩 에이전트(로컬 AI·무료 API 자동 탐지)
    claude: { enabled: true, models: { haiku: [1, 2], sonnet: [1, 3], opus: [1, 4] } },
    codex: { enabled: 'auto', path: '', args: 'exec --sandbox workspace-write --skip-git-repo-check -', maxLevel: 3, maxGrade: 'I' },
    custom: []   // 기타 개발 AI: { id, label, bin, args('{prompt}' 또는 표준입력, '{cwd}'), enabled, maxLevel(1~4), maxGrade(P|I|C|S는 local만), cost(free|subscription|api), local }
  }   // allowExternal: 외부 에이전트(Codex 등)가 지브스를 직접 부리는 길(기본 꺼짐: 지브스가 최상위여야 함)
};

const str = (v, n) => typeof v === 'string' ? v.trim().slice(0, n) : undefined;
const lvl = v => { const n = Math.round(Number(v)); return n >= 1 && n <= 4 ? n : undefined; };
function sanitizeDev(d) {
  const out = {};
  if (typeof d.folder === 'string') out.folder = d.folder.trim().slice(0, 500);
  if (Array.isArray(d.prefer)) out.prefer = d.prefer.filter(x => ['claude', 'codex', 'cli'].includes(x));
  if (['P', 'I', 'C'].includes(d.claudeMaxGrade)) out.claudeMaxGrade = d.claudeMaxGrade;
  if (['auto', 'codex', 'claude'].includes(d.preferMode)) out.preferMode = d.preferMode;
  if (d.junior) {
    const j = {};
    for (const k of ['enabled', 'local', 'free', 'paid', 'team', 'confirm']) if (typeof d.junior[k] === 'boolean') j[k] = d.junior[k];
    if (lvl(d.junior.maxLevel)) j.maxLevel = Math.min(3, lvl(d.junior.maxLevel));
    out.junior = j;
  }
  if (d.claude && typeof d.claude.enabled === 'boolean') out.claude = { enabled: d.claude.enabled };   // 모델별 난이도 범위는 화면에서 바꾸지 않는다
  if (d.codex) {
    const c = {};
    if (typeof d.codex.enabled === 'boolean' || d.codex.enabled === 'auto') c.enabled = d.codex.enabled;
    const p = str(d.codex.path, 500); if (p !== undefined) c.path = p;
    const a = str(d.codex.args, 300); if (a !== undefined && a) c.args = a;
    if (lvl(d.codex.maxLevel)) c.maxLevel = lvl(d.codex.maxLevel);
    if (['P', 'I', 'C'].includes(d.codex.maxGrade)) c.maxGrade = d.codex.maxGrade;
    out.codex = c;
  }
  if (Array.isArray(d.custom)) {
    out.custom = d.custom.slice(0, 6).map(c => {
      const id = String((c && c.id) || '').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24);
      const bin = str(c && c.bin, 500);
      if (!id || !bin) return null;
      const local = c.local === true;
      return { id, label: str(c.label, 40) || id, bin, args: str(c.args, 300) || '', enabled: c.enabled !== false, maxLevel: lvl(c.maxLevel) || 2,
        maxGrade: ['P', 'I', 'C'].includes(c.maxGrade) || (local && c.maxGrade === 'S') ? c.maxGrade : 'I', cost: ['free', 'subscription', 'api'].includes(c.cost) ? c.cost : 'subscription', local };
    }).filter(Boolean);
  }
  return out;
}

function deepMerge(base, extra) {
  if (Array.isArray(base) || typeof base !== 'object' || base === null) return extra === undefined ? base : extra;
  const out = { ...base };
  for (const k of Object.keys(extra || {})) {
    out[k] = (k in base) ? deepMerge(base[k], extra[k]) : extra[k];
  }
  return out;
}

class ConfigStore {
  constructor(dir, safeStorage) {
    this.file = path.join(dir, 'jeeves-config.json');
    this.safe = safeStorage && safeStorage.isEncryptionAvailable() ? safeStorage : null;
    this.data = this._load();
    if (this._dirty) { try { this.save(); } catch (_) {} this._dirty = false; }
  }

  _load() {
    let raw = {};
    try { raw = JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch (_) { /* 첫 실행 */ }
    // 0.1 → 0.2 설정 옮기기: 키는 그대로 두고 부문 배정·안전 설정은 새 기본값으로
    if (raw.version >= 2 && raw.version < DEFAULTS.version) {
      raw.version = DEFAULTS.version;   // 2 → 3: 기존 키·배정·안전 설정을 그대로 두고 새 항목만 기본값으로 채운다
      this._dirty = true;
    } else if (raw.version !== DEFAULTS.version) {
      const keepProviders = raw.providers || {};
      if (keepProviders.typesafe) delete keepProviders.typesafe.disabled;
      raw = { version: DEFAULTS.version, providers: keepProviders, ui: raw.ui ? { homepage: raw.ui.homepage } : undefined };
    }
    // 정보 등급 기본값을 P → I 로 올림(0.24): 예전에 저장된 기본값 P 는 한 번만 I 로 바꾼다(사용자가 이후 고른 값은 유지)
    if (raw.infoGradeV !== 1) { if (raw.infoGrade === 'P') raw.infoGrade = 'I'; raw.infoGradeV = 1; this._dirty = true; }
    const merged = deepMerge(DEFAULTS, raw);
    // 사용자가 지운 기본 공급자는 기본값에서 되살아나지 않게 한다
    for (const id of merged.removedProviders || []) delete merged.providers[id];
    // 지워진 공급자를 '직접 선택'으로 가리키던 부문은 추천 배정으로 돌린다
    for (const r of Object.values(merged.roles)) if (r.mode === 'manual' && !merged.providers[r.provider]) r.mode = 'auto';
    // 없어진 부문(예: 0.1 의 '제목 짓기')은 지운다
    for (const k of Object.keys(merged.roles)) if (!ROLE_DEFAULTS[k]) delete merged.roles[k];
    if (merged.providers.typesafe) delete merged.providers.typesafe.disabled;
    if (!merged.mcp.token) { merged.mcp.token = require('crypto').randomBytes(24).toString('base64url'); this._dirty = true; }
    for (const p of Object.values(merged.providers)) {
      if (p.apiKeyEnc) {
        try { p.apiKey = this.safe ? this.safe.decryptString(Buffer.from(p.apiKeyEnc, 'base64')) : ''; }
        catch (_) { p.apiKey = ''; }
        delete p.apiKeyEnc;
      }
    }
    return merged;
  }

  save() {
    const copy = JSON.parse(JSON.stringify(this.data));
    for (const p of Object.values(copy.providers)) {
      if (p.apiKey && p.apiKey !== 'ollama') {
        if (this.safe) p.apiKeyEnc = this.safe.encryptString(p.apiKey).toString('base64');
        delete p.apiKey; // 암호화가 불가능한 환경에서는 키를 디스크에 남기지 않는다
      }
    }
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(copy, null, 2), 'utf8');
  }

  get() { return this.data; }

  // 화면(렌더러)에 보낼 때는 키를 가린다
  getPublic() {
    const c = JSON.parse(JSON.stringify(this.data));
    for (const p of Object.values(c.providers)) {
      p.hasKey = !!p.apiKey;
      p.effectiveGrade = effectiveMaxGrade(p);
      p.apiKey = p.apiKey ? '••••••••' : '';   // 끝자리도 화면으로 보내지 않는다 (키 길이·일부 노출 방지)
    }
    c.recommend = recommendAll(this.data);     // 부문별 추천 배정 (화면 표시용)
    c.encryptionAvailable = !!this.safe;
    return c;
  }

  update(patch) {
    // 공급자: 이미 있는 것만, 바꿀 수 있는 항목(키·주소·유형)만 받는다. 새 공급자는 addProvider() 로만 만든다.
    if (patch.providers) {
      for (const [id, p] of Object.entries(patch.providers)) {
        if (!p || !this.data.providers[id]) { delete patch.providers[id]; continue; }
        const ok = {};
        if (typeof p.apiKey === 'string' && !(p.apiKey.startsWith('••••') || p.apiKey.startsWith('●'))) ok.apiKey = p.apiKey;   // 가린 값 그대로면 기존 키 유지
        if (typeof p.baseUrl === 'string') ok.baseUrl = p.baseUrl;
        if (p.tier === 'free' || p.tier === 'paid') ok.tier = p.tier;
        if (p.maxGrade === 'auto' || p.maxGrade === '') ok.maxGrade = '';   // 자동(유형·로컬 여부로 계산)
        else if (GRADES.includes(p.maxGrade)) ok.maxGrade = p.maxGrade;
        if (typeof p.off === 'boolean') ok.off = p.off;   // 추천에서 제외(잔액 없는 유료 공급자 등)
        patch.providers[id] = ok;
      }
    }
    // 부문: 이미 있는 것만, 배정(provider·model·effort·mode)만 받는다
    if (patch.roles) {
      for (const [id, r] of Object.entries(patch.roles)) {
        if (!r || !this.data.roles[id]) { delete patch.roles[id]; continue; }
        const ok = {};
        for (const k of ['provider', 'model', 'effort']) if (typeof r[k] === 'string') ok[k] = r[k];
        if (r.mode === 'auto' || r.mode === 'manual') ok.mode = r.mode;
        patch.roles[id] = ok;
      }
    }
    if (patch.infoGrade !== undefined && !GRADES.includes(patch.infoGrade)) delete patch.infoGrade;
    if (patch.engine) {
      if (patch.engine.maxGrade !== undefined && !ENGINE_GRADES.includes(patch.engine.maxGrade)) delete patch.engine.maxGrade;
    }
    if (patch.mcp && patch.mcp.allowExternal !== undefined) patch.mcp.allowExternal = patch.mcp.allowExternal === true;
    if (patch.failover !== undefined) patch.failover = !!patch.failover;
    if (patch.dev) patch.dev = sanitizeDev(patch.dev);
    delete patch.infoGradeV;
    delete patch.removedProviders;   // 삭제 기록은 removeProvider() 로만 바꾼다
    this.data = deepMerge(this.data, patch);
    this.save();
    return this.getPublic();
  }

  // 공급자 추가. 통신 방식은 OpenAI 호환 / Anthropic 방식 중에서 고른다. 오류는 한국어 문장으로 던진다.
  addProvider(spec) {
    spec = spec || {};
    const label = String(spec.label || '').trim().slice(0, 40);
    if (!label) throw new Error('이름을 입력해 주세요.');
    if (spec.type !== 'openai' && spec.type !== 'anthropic' && spec.type !== 'webchat') throw new Error('통신 방식은 "OpenAI 호환", "Anthropic 방식", "웹 로그인형" 중에서 골라 주세요.');
    const baseUrl = String(spec.baseUrl || '').trim().replace(/\/+$/, '');
    // 키가 평문으로 외부에 나가지 않도록 https 만 허용한다(내 PC 로컬만 http 허용)
    const httpsOk = /^https:\/\/[^\s\/]+(\/\S*)?$/.test(baseUrl);
    const localOk = /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?(\/\S*)?$/.test(baseUrl);
    if (!httpsOk && !localOk) throw new Error('주소는 https:// 로 시작해야 합니다. (내 PC 안의 로컬 모델만 http://127.0.0.1 또는 http://localhost 가능)');
    const base = label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24) || 'custom';
    let id = base, n = 2;
    while (this.data.providers[id] || DEFAULTS.providers[id]) id = `${base}-${n++}`;
    this.data.providers[id] = { type: spec.type, label, baseUrl, apiKey: String(spec.apiKey || '').trim(), tier: spec.tier === 'free' ? 'free' : 'paid', custom: true, ...(spec.type === 'webchat' ? { maxGrade: 'P' } : {}) };   // 웹 로그인형은 공개(P)만
    this.save();
    return { id, config: this.getPublic() };
  }

  // 공급자 삭제. 저장된 키도 함께 지워진다. 기본 공급자는 삭제 기록을 남겨 다시 살아나지 않게 한다.
  removeProvider(id) {
    if (!this.data.providers[id]) throw new Error('없는 공급자입니다.');
    delete this.data.providers[id];
    if (DEFAULTS.providers[id]) this.data.removedProviders = [...new Set([...(this.data.removedProviders || []), id])];
    for (const r of Object.values(this.data.roles)) if (r.provider === id) r.mode = 'auto';
    this.save();
    return this.getPublic();
  }

  // 삭제했던 기본 공급자를 모두 되살린다(키는 비어 있는 상태)
  restoreProviders() {
    for (const [id, d] of Object.entries(DEFAULTS.providers)) if (!this.data.providers[id]) this.data.providers[id] = { ...d };
    this.data.removedProviders = [];
    this.save();
    return this.getPublic();
  }
}

// 키 파일(txt)에서 키 찾아내기. 형식이 자유로워도 키 모양으로 구분한다.
function parseKeyFile(text) {
  const found = {};
  const words = String(text || '').split(/\s+/).map(w => w.trim()).filter(Boolean);
  for (const w of words) {
    if (/^sk-ant-[\w-]{20,}$/.test(w)) found.anthropic = found.anthropic || w;
    else if (/^sk-or-[\w-]{20,}$/.test(w)) found.openrouter = found.openrouter || w;
    else if (/^apikey_[\w-]{16,}$/.test(w)) found.typesafe = found.typesafe || w;
    else if (/^(AIza[\w-]{30,}|AQ\.[\w.-]{30,})$/.test(w)) found.gemini = found.gemini || w;
    else if (/^sk-(proj-)?[\w-]{30,}$/.test(w)) found.openai = found.openai || w;
  }
  return found;
}

module.exports = { ConfigStore, DEFAULTS, ROLE_DEFAULTS, parseKeyFile };

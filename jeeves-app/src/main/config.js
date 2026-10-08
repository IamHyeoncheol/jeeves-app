// 설정 저장소: 역할별 모델 배정, 공급자(API) 정보, 안전 설정
// API 키는 Windows 자격 증명 보호(DPAPI) 기반 safeStorage 로 암호화해 저장한다.
const fs = require('fs');
const path = require('path');

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

const DEFAULTS = {
  version: 2,
  providers: {
    anthropic: { type: 'anthropic', label: 'Anthropic (Claude)', baseUrl: 'https://api.anthropic.com', apiKey: '' },
    gemini: { type: 'openai', label: 'Google Gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', apiKey: '' },
    typesafe: { type: 'jev', label: 'TypeSafe Jev (판단 전용)', baseUrl: 'https://api.typesafe.ai', apiKey: '' },
    openrouter: { type: 'openai', label: 'OpenRouter (여러 모델)', baseUrl: 'https://openrouter.ai/api/v1', apiKey: '' },
    openai: { type: 'openai', label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', apiKey: '' },
    ollama: { type: 'openai', label: 'Ollama (내 PC 로컬 모델)', baseUrl: 'http://127.0.0.1:11434/v1', apiKey: 'ollama' }
  },
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
  ui: { homepage: 'https://www.google.com', krwPerUsd: 1400, layout: 'chat', previewWidth: 400, panelWidth: 420 }, // layout: 'chat' = 작업 화면 중심, 'web' = 웹 크게
  // 작업 엔진: 'api' = API 키(Claude·Jev 등, 사용량만큼 과금) / 'claude-code' = 내 PC 의 정품 Claude Code(내 구독)
  engine: { type: 'api', claudePath: '', claudeModel: 'sonnet' },
  // 외부 에이전트(Claude Code·Codex)가 Jeeves 브라우저를 쓰게 하는 창구 (내 PC 안에서만)
  mcp: { enabled: true, port: 47840, token: '' }
};

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
    if (raw.version !== DEFAULTS.version) {
      const keepProviders = raw.providers || {};
      if (keepProviders.typesafe) delete keepProviders.typesafe.disabled;
      raw = { version: DEFAULTS.version, providers: keepProviders, ui: raw.ui ? { homepage: raw.ui.homepage } : undefined };
    }
    const merged = deepMerge(DEFAULTS, raw);
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
      p.apiKey = p.apiKey ? '••••••••' : '';   // 끝자리도 화면으로 보내지 않는다 (키 길이·일부 노출 방지)
    }
    c.encryptionAvailable = !!this.safe;
    return c;
  }

  update(patch) {
    // 키가 '••••' 또는 '●'로 시작하면(가린 값 그대로) 기존 키 유지
    if (patch.providers) {
      for (const [id, p] of Object.entries(patch.providers)) {
        if (p && typeof p.apiKey === 'string' && (p.apiKey.startsWith('••••') || p.apiKey.startsWith('●'))) delete p.apiKey;
        if (!this.data.providers[id] && p) this.data.providers[id] = { type: 'openai', label: id, baseUrl: '', apiKey: '' };
      }
    }
    this.data = deepMerge(this.data, patch);
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

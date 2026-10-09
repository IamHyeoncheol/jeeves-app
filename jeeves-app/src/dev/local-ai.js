// 주니어 엔진 후보 자동 탐지: 내 PC에 설치된 로컬 AI(Ollama·LM Studio)와, 키가 있는 무료 API(Gemini 등)를 찾는다.
// 모두 규칙 코드이며 AI 를 쓰지 않는다. 찾는 데 실패해도 조용히 빈 목록을 돌려준다(없는 것으로 취급).
const { CATALOG } = require('../models/recommend');

const SERVERS = [
  { key: 'ollama', label: 'Ollama', tags: 'http://127.0.0.1:11434/api/tags', baseUrl: 'http://127.0.0.1:11434/v1', apiKey: 'ollama' },
  { key: 'lmstudio', label: 'LM Studio', models: 'http://127.0.0.1:1234/v1/models', baseUrl: 'http://127.0.0.1:1234/v1', apiKey: 'lm-studio' }
];
const CODE_RE = /(coder|codestral|deepseek-coder|starcoder|qwen.*code|code)/i;
const SKIP_RE = /(embed|rerank|whisper|bge|nomic|clip|tts|vision-only)/i;

async function getJson(url, ms, f) {
  const ac = new AbortController(); const t = setTimeout(() => ac.abort(), ms);
  try { const r = await f(url, { signal: ac.signal }); if (!r.ok) return null; return await r.json(); }
  catch (_) { return null; } finally { clearTimeout(t); }
}
// 모델 이름의 "숫자b"(파라미터 수, 십억 단위)를 읽는다. 못 읽으면 0.
const sizeB = name => { const m = /(\d+(?:\.\d+)?)\s*b\b/i.exec(String(name)); return m ? Number(m[1]) : 0; };

// 설치된 로컬 모델 목록: [{ server, label, baseUrl, apiKey, model, code:boolean, sizeB }]
async function detectLocalModels(fetchImpl) {
  const f = fetchImpl || globalThis.fetch, out = [];
  for (const s of SERVERS) {
    let names = [];
    if (s.tags) { const j = await getJson(s.tags, 1500, f); names = j && Array.isArray(j.models) ? j.models.map(m => m.name || m.model) : []; }
    else { const j = await getJson(s.models, 1500, f); names = j && Array.isArray(j.data) ? j.data.map(m => m.id) : []; }
    for (const n of names.filter(Boolean)) {
      if (SKIP_RE.test(n)) continue;
      out.push({ server: s.key, label: s.label, baseUrl: s.baseUrl, apiKey: s.apiKey, model: n, code: CODE_RE.test(n), sizeB: sizeB(n) });
    }
  }
  return out;
}

// 로컬 모델이 맡을 수 있는 최고 난이도(대략): 코딩 전용이고 큰 모델일수록 높게. 보수적으로 1~2.
function localMaxLevel(m, cap) {
  let lv = 1;
  if (m.code && m.sizeB >= 7) lv = 2; else if (m.sizeB >= 20) lv = 2;
  return Math.min(lv, cap || 2);
}

// 주니어 엔진 목록 만들기. cfg = 전체 설정, localModels = detectLocalModels 결과
// 반환 엔진: { id, kind:'api-coder', family:'api', label, cost, maxLevel, minLevel, maxGrade, local, available, provider(인라인 공급자), model }
function buildJuniorEngines(cfg, localModels = []) {
  const jr = (cfg.dev && cfg.dev.junior) || {};
  if (jr.enabled === false) return [];
  const cap = Number(jr.maxLevel) >= 1 && Number(jr.maxLevel) <= 4 ? Number(jr.maxLevel) : 2;
  const out = [];
  if (jr.local !== false) {
    // 같은 서버에서는 코딩 모델 우선, 그다음 큰 모델 순으로 최대 3개만
    const sorted = [...localModels].sort((a, b) => (b.code - a.code) || (b.sizeB - a.sizeB) || a.model.localeCompare(b.model)).slice(0, 3);
    for (const m of sorted) {
      out.push({ id: `jr-${m.server}-${m.model}`, kind: 'api-coder', family: 'api', label: `주니어 · ${m.label} ${m.model}`, cost: 'free', maxLevel: localMaxLevel(m, cap), minLevel: 1, maxGrade: 'S', local: true, available: true, junior: true,
        provider: { type: 'openai', label: m.label, baseUrl: m.baseUrl, apiKey: m.apiKey, tier: 'free' }, model: m.model });
    }
  }
  const providers = cfg.providers || {};
  if (jr.free !== false) {
    for (const [pid, p] of Object.entries(providers)) {
      if (!p || p.tier !== 'free' || !p.apiKey || p.apiKey === 'ollama' || p.disabled || p.off || p.type !== 'openai') continue;
      if (/127\.0\.0\.1|localhost/.test(p.baseUrl || '')) continue;
      const cat = CATALOG[pid]; const model = cat && (cat.light || cat.standard); if (!model) continue;
      out.push({ id: `jr-${pid}-${model}`, kind: 'api-coder', family: 'api', label: `주니어 · ${p.label} ${model} (무료)`, cost: 'free', maxLevel: Math.min(cap, 2), minLevel: 1, maxGrade: p.maxGrade || 'P', local: false, available: true, junior: true, providerId: pid, model });
    }
  }
  if (jr.paid === true) {
    for (const [pid, p] of Object.entries(providers)) {
      if (!p || p.tier === 'free' || !p.apiKey || p.disabled || p.off || p.type !== 'openai' || pid === 'typesafe') continue;
      const cat = CATALOG[pid]; const model = cat && cat.light; if (!model) continue;
      out.push({ id: `jr-${pid}-${model}`, kind: 'api-coder', family: 'api', label: `주니어 · ${p.label} ${model} (유료 API)`, cost: 'api', maxLevel: Math.min(cap, 2), minLevel: 1, maxGrade: p.maxGrade || 'I', local: false, available: true, junior: true, providerId: pid, model });
    }
  }
  return out;
}

module.exports = { detectLocalModels, buildJuniorEngines, localMaxLevel, sizeB, SERVERS };

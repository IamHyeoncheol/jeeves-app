// AI 공급자별 통신 어댑터
// 앱 내부에서는 메시지를 하나의 공통 형식(Anthropic 형식)으로 다루고,
// 공급자에 보낼 때만 각 회사 형식으로 바꾼다. 그래서 모델을 바꿔도 에이전트 코드는 그대로다.
//
// 공통 블록: {type:'text',text} | {type:'image',source:{type:'base64',media_type,data}}
//          | {type:'tool_use',id,name,input} | {type:'tool_result',tool_use_id,content:[블록],is_error}
//          | {type:'thinking'...}/{type:'redacted_thinking'...} (Anthropic 전용, 그대로 돌려보냄)

class ProviderError extends Error {
  constructor(message, { status, provider, retryable } = {}) {
    super(message);
    this.status = status; this.provider = provider; this.retryable = !!retryable;
  }
}

function friendlyHttpError(status, bodyText, providerLabel) {
  let detail = '';
  try { const j = JSON.parse(bodyText); detail = (j.error && (j.error.message || j.error.type)) || j.message || ''; } catch (_) { detail = (bodyText || '').slice(0, 300); }
  const map = {
    400: '요청 형식 오류', 401: 'API 키가 틀렸거나 만료됨', 403: '권한 없음(키 권한·지역 제한 확인)',
    404: '모델 이름 또는 주소가 틀림', 413: '보낸 내용이 너무 큼', 429: '사용량 한도 초과(잠시 후 재시도)',
    500: '공급자 서버 오류', 529: '공급자 서버 과부하'
  };
  if (/credit balance|insufficient_quota|billing/i.test(detail)) {
    return new ProviderError(`[${providerLabel}] 크레딧(선불 잔액) 부족 — 공급자 콘솔의 결제(Billing) 페이지에서 충전해 주세요. (${detail})`, { status, retryable: false });
  }
  const retryable = status === 429 || status >= 500;
  return new ProviderError(`[${providerLabel}] ${map[status] || 'HTTP ' + status}${detail ? ' — ' + detail : ''}`, { status, retryable });
}

async function postJson(fetchImpl, url, headers, body, signal, label) {
  let res;
  try {
    res = await fetchImpl(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body), signal });
  } catch (e) {
    if (e.name === 'AbortError') throw e;
    throw new ProviderError(`[${label}] 네트워크 연결 실패 — ${e.message}`, { retryable: true });
  }
  const text = await res.text();
  if (!res.ok) throw friendlyHttpError(res.status, text, label);
  try { return JSON.parse(text); } catch (_) { throw new ProviderError(`[${label}] 응답을 해석할 수 없음`); }
}

// ── Anthropic ───────────────────────────────────────────
// effort(생각 깊이)를 지원하는 모델: Claude 5 계열 (Haiku 4.5 는 미지원)
const EFFORT_MODELS = /claude-(opus|sonnet|fable|mythos)-5/;

async function callAnthropic(p, model, req, fetchImpl) {
  const body = {
    model,
    max_tokens: req.maxTokens || 8192,
    // 고정 문구(시스템 지시)는 캐시해서 다음 호출부터 할인 단가로 읽게 한다
    system: req.system ? [{ type: 'text', text: req.system, cache_control: { type: 'ephemeral' } }] : undefined,
    messages: req.messages
  };
  if (req.tools && req.tools.length) {
    body.tools = req.tools.map((t, i) => i === req.tools.length - 1 ? { ...t, cache_control: { type: 'ephemeral' } } : t);
  }
  if (req.effort && EFFORT_MODELS.test(model)) body.output_config = { effort: req.effort };
  const data = await postJson(fetchImpl, p.baseUrl.replace(/\/$/, '') + '/v1/messages', {
    'x-api-key': p.apiKey,
    'anthropic-version': '2023-06-01'
  }, body, req.signal, p.label);
  const u = data.usage || {};
  return {
    content: data.content || [],
    stopReason: data.stop_reason === 'tool_use' ? 'tool_use' : (data.stop_reason || 'end_turn'),
    usage: { input: u.input_tokens || 0, output: u.output_tokens || 0, cacheWrite: u.cache_creation_input_tokens || 0, cacheRead: u.cache_read_input_tokens || 0 }
  };
}

// ── OpenAI 호환(OpenRouter·OpenAI·Gemini·Ollama 등) ─────────
function toOpenAIMessages(system, messages) {
  const out = [];
  if (system) out.push({ role: 'system', content: system });
  for (const m of messages) {
    const blocks = typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : m.content;
    if (m.role === 'assistant') {
      const text = blocks.filter(b => b.type === 'text').map(b => b.text).join('\n');
      const calls = blocks.filter(b => b.type === 'tool_use').map(b => ({
        id: b.id, type: 'function', function: { name: b.name, arguments: JSON.stringify(b.input || {}) }
      }));
      const msg = { role: 'assistant', content: text || null };
      if (calls.length) msg.tool_calls = calls;
      out.push(msg);
    } else {
      const parts = [];
      const pendingImages = [];
      for (const b of blocks) {
        if (b.type === 'tool_result') {
          const inner = Array.isArray(b.content) ? b.content : [{ type: 'text', text: String(b.content || '') }];
          out.push({ role: 'tool', tool_call_id: b.tool_use_id, content: inner.filter(x => x.type === 'text').map(x => x.text).join('\n') || '(결과 없음)' });
          for (const x of inner) if (x.type === 'image') pendingImages.push(x);
        } else if (b.type === 'text') parts.push({ type: 'text', text: b.text });
        else if (b.type === 'image') parts.push({ type: 'image_url', image_url: { url: `data:${b.source.media_type};base64,${b.source.data}` } });
      }
      for (const img of pendingImages) parts.push({ type: 'image_url', image_url: { url: `data:${img.source.media_type};base64,${img.source.data}` } });
      if (parts.length) out.push({ role: 'user', content: parts });
    }
  }
  return out;
}

async function callOpenAI(p, model, req, fetchImpl) {
  const body = { model, messages: toOpenAIMessages(req.system, req.messages), max_tokens: req.maxTokens || 8192 };
  if (req.tools && req.tools.length) {
    body.tools = req.tools.map(t => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.input_schema } }));
  }
  const headers = {};
  if (p.apiKey) headers.authorization = 'Bearer ' + p.apiKey;
  if (/openrouter\.ai/.test(p.baseUrl)) { headers['HTTP-Referer'] = 'https://jeeves.local'; headers['X-Title'] = 'Jeeves Browser'; }
  const data = await postJson(fetchImpl, p.baseUrl.replace(/\/$/, '') + '/chat/completions', headers, body, req.signal, p.label);
  const msg = data.choices?.[0]?.message || {};
  const content = [];
  if (msg.content) content.push({ type: 'text', text: msg.content });
  for (const c of msg.tool_calls || []) {
    let input = {};
    try { input = JSON.parse(c.function.arguments || '{}'); } catch (_) { input = { _raw: c.function.arguments }; }
    content.push({ type: 'tool_use', id: c.id, name: c.function.name, input });
  }
  return {
    content,
    stopReason: content.some(b => b.type === 'tool_use') ? 'tool_use' : 'end_turn',
    usage: (() => {
      const u = data.usage || {}; const cached = u.prompt_tokens_details?.cached_tokens || 0;
      return { input: (u.prompt_tokens || 0) - cached, output: u.completion_tokens || 0, cacheRead: cached, cacheWrite: 0 };
    })()
  };
}

// ── TypeSafe Jev (판단 전용 모델) ─────────────────────────
// 글을 쓰지 않고, 정해 둔 선택지 중 하나를 확률·신뢰도와 함께 고른다.
// req: { state, questions }  →  { answers, usage }
async function callJev(p, model, req, fetchImpl) {
  if (!req.questions) throw new ProviderError('Jev는 판단(선택지 고르기) 전용이라 대화·작업 부문에는 배정할 수 없습니다.');
  const data = await postJson(fetchImpl, p.baseUrl.replace(/\/$/, '') + '/v1/systemone', {
    authorization: 'Bearer ' + p.apiKey
  }, { model: model || 'jev-latest', state: req.state, questions: req.questions }, req.signal, p.label);
  return {
    answers: data.answers || {},
    content: [],
    stopReason: 'decision',
    usage: { input: data.usage?.input_tokens || 0, output: 0, cacheWrite: 0, cacheRead: 0 }
  };
}

const ADAPTERS = { anthropic: callAnthropic, openai: callOpenAI, jev: callJev };

module.exports = { ADAPTERS, ProviderError, toOpenAIMessages, EFFORT_MODELS };

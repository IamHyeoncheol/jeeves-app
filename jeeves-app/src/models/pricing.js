// 모델 단가표 (달러 / 100만 토큰). 2026-10-05 공식 가격 페이지 기준.
// 가격이 바뀌면 이 표만 고치면 된다. 표에 없는 모델은 비용을 "?"로 표시한다.
const TABLE = [
  // Anthropic: 입력, 출력, 캐시 쓰기(5분), 캐시 읽기
  { match: /claude-fable-5/,  in: 10,   out: 50,   cacheWrite: 12.5, cacheRead: 0.25 },
  { match: /claude-opus-5/,   in: 4,    out: 20,   cacheWrite: 5,    cacheRead: 0.20 },
  { match: /claude-sonnet-5/, in: 2,    out: 10,   cacheWrite: 2.5,  cacheRead: 0.20 },
  { match: /claude-haiku-4-5/, in: 1,   out: 5,    cacheWrite: 1.25, cacheRead: 0.10 },
  // OpenAI
  { match: /gpt-5\.6-sol/i,   in: 5,    out: 30,   cacheRead: 0.50 },
  { match: /gpt-5\.6-terra/i, in: 2,    out: 12,   cacheRead: 0.20 },
  { match: /gpt-5\.6-luna/i,  in: 0.20, out: 1.20, cacheRead: 0.02 },
  // Google Gemini (프롬프트 20만 토큰 이하 기준)
  { match: /gemini-3\.1-pro/,        in: 2,    out: 12 },
  { match: /gemini-3\.[678]-flash(?!-lite)/, in: 0.75, out: 3.75 },
  { match: /gemini-3\.5-flash-lite/, in: 0.30, out: 2.50 },
  { match: /gemini-3\.1-flash-lite/, in: 0.25, out: 1.50 },
  { match: /gemini-3\.5-flash(?!-lite)/, in: 1.50, out: 9 },
  // DeepSeek (최고가 시간대 기준으로 보수적으로 계산)
  { match: /deepseek.*flash/i, in: 0.30, out: 1.20 },
  { match: /deepseek.*v4/i,    in: 1.32, out: 3.96 },
  // TypeSafe Jev: 입력만 과금, 출력 무료
  { match: /^jev/,            in: 0.042, out: 0 },
  // 내 PC 로컬 모델(Ollama)은 무료
  { match: /^(llama|qwen|gemma|mistral|phi|exaone)/i, in: 0, out: 0 }
];

function priceOf(model) {
  return TABLE.find(p => p.match.test(model || '')) || null;
}

// usage: { input, output, cacheWrite, cacheRead } (토큰 수)
function costUsd(model, usage) {
  const p = priceOf(model);
  if (!p) return null;
  const w = p.cacheWrite ?? p.in, r = p.cacheRead ?? p.in;
  return ((usage.input || 0) * p.in + (usage.output || 0) * p.out + (usage.cacheWrite || 0) * w + (usage.cacheRead || 0) * r) / 1e6;
}

module.exports = { priceOf, costUsd, TABLE };

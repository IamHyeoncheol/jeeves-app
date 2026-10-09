// 💡 아이디어 모드 규칙(AI 아님): 보내기 전 공개 정보인지 검사하고, 질문을 활용안 A 틀로 감싸고, 답변에 "미검증" 안내를 붙인다.
// ExoLobe 는 공유 계정이라 공개(P) 정보만 보낸다. 규칙 검사는 완벽하지 않으므로 화면에서 사용자가 한 번 더 확인한다.
const { suspectDetail } = require('../models/recommend');

const NAME_RE = /(이엘피|\bELP\b|아쿠아\s?케이|aquak|해원\s?바이오|녹색삶|퍼스트\s?에그|first\s?egg|지브스|jeeves)/i;
const MONEY_RE = /(\d[\d,.]*\s*(원|만원|천원|억|백만|천만|달러|USD|KRW)|\$\s?\d)/i;
const MODEL_RE = /(claude|클로드|\bgpt|chatgpt|gemini|제미나이|exolobe|엑소로브|codex|grok|llama|qwen|deepseek)/i;
const MAX_LEN = 2000;

// 반환: { ok, reasons:[문장], hits:[걸린 말] }
function ideaCheck(text) {
  const t = String(text || '').trim();
  const reasons = [], hits = [];
  if (!t) return { ok: false, reasons: ['질문이 비어 있습니다.'], hits };
  if (t.length > MAX_LEN) reasons.push(`질문이 너무 깁니다(${t.length}자). ${MAX_LEN}자 안으로 줄여 주세요. 아이디어 모드는 짧은 공개용 질문만 받습니다.`);
  const d = suspectDetail(t);
  if (d.grade) { reasons.push(`기밀·비밀로 보이는 말이 있습니다(${d.grade} 의심).`); hits.push(...d.hits); }
  const n = NAME_RE.exec(t); if (n) { reasons.push('회사·내부 프로젝트 이름이 있습니다. 일반적인 말로 바꿔 주세요.'); hits.push(n[0]); }
  const m = MONEY_RE.exec(t); if (m) { reasons.push('금액 숫자가 있습니다. 빼거나 "높다/낮다"로 바꿔 주세요.'); hits.push(m[0]); }
  const k = MODEL_RE.exec(t); if (k) { reasons.push('AI 모델·서비스 이름이 있습니다. 빼 주세요.'); hits.push(k[0]); }
  return { ok: reasons.length === 0, reasons, hits };
}

// 활용안 A: 다른 분야의 원리를 가져오는 "아이디어 후보" 요청 틀. 근거를 못 대면 "확인 불가"라고 쓰게 한다.
function frame(question) {
  return `다음 주제에 대해, 서로 다른 분야에서 쓰이는 원리를 가져와 적용할 수 있는 접근을 5~10가지 제안해 주세요.
각 접근마다 이 항목을 쓰세요: 원래 분야 / 핵심 원리 / 적용 방법 / 한계 / 확인용 영어 검색어 2~3개.
형식: 각 접근은 "1. 접근 이름"으로 시작하고, 항목은 "라벨: 내용"을 한 줄씩 쓰고, 마지막에 "결론" 한 줄 제목 뒤에 2~3문장으로 정리하세요.\n논문 제목·저자·DOI·수치는 쓰지 마세요. 모르는 것은 지어내지 말고 "확인 불가"라고 쓰세요. 한국어로 쉽게 설명해 주세요.

[주제]
${String(question || '').trim()}`;
}

// 웹 화면에서 읽어 온 답은 굵은 글씨·목록 표시가 사라진 "글자만"이다. 규칙(AI 아님)으로 제목·소제목·개조식 목록으로 다시 세운다.
// 이미 마크다운 표시(#, -, *, |)가 있으면 손대지 않는다. 패턴: "1. 제목" → 소제목 / "라벨: 내용" → 굵은 라벨 항목 / "라벨:" 만 있는 줄 → 아래 줄들을 하위 항목으로 / 짧은 한 줄(예: 결론) → 큰 제목
function structure(text, question) {
  const src = String(text || '').replace(/\r/g, '').trim();
  if (!src || /^\s*(#{1,4}\s|[-*]\s|\|)/m.test(src)) return src;
  const topic = String(question || '').replace(/\s+/g, ' ').trim().slice(0, 50);
  const out = ['## 💡 아이디어 후보' + (topic ? ' — ' + topic : '')];
  let sec = false, sub = false;
  for (const raw of src.split('\n')) {
    const ln = raw.trim();
    if (!ln) { out.push(''); continue; }
    let m;
    if ((m = ln.match(/^(\d{1,2})[.)]\s+(.+)/))) { sec = true; sub = false; out.push('', `### ${m[1]}. ${m[2]}`); continue; }
    if (sec && ln.length <= 14 && !/[.:：。!?]$/.test(ln) && !/\s.*\s.*\s/.test(ln)) { sec = false; sub = false; out.push('', `## ${ln}`); continue; }   // "결론" 같은 짧은 제목 줄
    if (sec && (m = ln.match(/^([^:：.]{1,40})[:：]\s*$/))) { sub = true; out.push(`- **${m[1].trim()}**`); continue; }
    if (sec && (m = ln.match(/^([^:：.]{1,40})[:：]\s+(\S.*)/))) { out.push(`${sub ? '  ' : ''}- **${m[1].trim()}:** ${m[2]}`); continue; }
    if (sec && sub) { out.push('  - ' + ln); continue; }
    out.push(ln);
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n');
}

const BANNER = '⚠️ ExoLobe 답변 — 아이디어 후보입니다. 사실·수치는 검증되지 않았으니 영어 검색어로 확인한 뒤 사용하세요.';
const withBanner = answer => `${BANNER}\n\n${String(answer || '').trim()}`;

module.exports = { structure, ideaCheck, frame, withBanner, BANNER, MAX_LEN };

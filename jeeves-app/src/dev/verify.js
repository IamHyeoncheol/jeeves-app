// 작업 결과 검증: "엔진이 끝났다고 말했다"가 아니라 "실제로 그런 흔적이 있는가"를 본다.
// 규칙(코드)으로만 판정한다 → AI 호출·토큰 0, 결과가 늘 같고, 시험할 수 있다.
//  1) 도구 호출 문장: 작은 로컬 모델은 도구를 실제로 부르지 않고 {"name":"write_file",...} 같은 호출 "문장"만
//     글로 출력할 때가 있다. 그 문장은 실행된 것이 아니므로 성공으로 치면 안 된다.
//  2) 변경 없음: 만들기·고치기·옮기기 지시인데 프로젝트 폴더에 바뀐 파일이 하나도 없으면 완료로 보기 어렵다.

const TOOL_TEXT_RES = [
  /[{[]\s*["']name["']\s*:\s*["'][A-Za-z_][\w.\-]*["']\s*,\s*["'](?:parameters|arguments|args|input)["']\s*:/,
  /["']tool_calls?["']\s*:\s*\[/i,
  /<tool_call>|<function=|\[TOOL_CALLS\]|<\|python_tag\|>/i
];

// 글로 쓴 도구 호출 문장인지 본다. 아주 긴 글(정상 보고서)은 검사하지 않는다.
function looksLikeToolCallText(text) {
  const s = String(text || '').trim();
  if (!s || s.length > 3000) return false;
  return TOOL_TEXT_RES.some(re => re.test(s));
}

const CHANGE_RE = /(만들|생성|추가|수정|고쳐|고치|바꿔|바꾸|변경|구현|개발|작성|저장|이동|옮겨|옮기|삭제|지워|지우|정리|이름\s*바|\bcreate\b|\badd\b|\bfix\b|\bimplement\b|\bwrite\b|\bmove\b|\brename\b|\bdelete\b|\brefactor\b)/i;
const READONLY_RE = /(설명해|알려\s*(줘|주세요)|분석해|요약|읽어|보여\s*(줘|주세요)|뭐야|무엇|왜\s|차이)/;
const IMPERATIVE_RE = /(만들어|만들고|만들자|고쳐|수정해|구현해|개발해|추가해|옮겨|이동해|삭제해|지워|바꿔|작성해|생성해)/;

// 지시가 파일·폴더를 바꾸는 일인지(설명·분석만 시키는 말은 제외)
function expectsChanges(goal) {
  const s = String(goal || '');
  if (!s) return false;
  if (READONLY_RE.test(s) && !IMPERATIVE_RE.test(s)) return false;
  return CHANGE_RE.test(s);
}

// changes = diffSnap 결과 { added, modified, removed }
const hasChanges = c => !!c && ((c.added || []).length + (c.modified || []).length + (c.removed || []).length) > 0;

// 한 번의 시도 결과를 검증한다. 반환 level: 'pass' | 'warn'(성공은 인정하되 미검증 표시) | 'fail'(성공 취소)
// result = { success, summary, changes }, engine = { kind }
function verifyResult({ goal, result, engine } = {}) {
  const r = result || {};
  if (!r.success) return { level: 'pass', ok: true, reasons: [] };   // 실패 보고는 그대로 둔다
  if (looksLikeToolCallText(r.summary)) {
    return { level: 'fail', ok: false, reasons: ['보고가 실제로 실행되지 않은 도구 호출 문장입니다(도구가 호출되지 않음)'] };
  }
  if (r.changes == null) return { level: 'pass', ok: true, reasons: [] };   // 변경 비교를 못 했으면 판단하지 않음
  if (expectsChanges(goal) && !hasChanges(r.changes)) {
    const why = '지시는 파일·폴더를 바꾸는 일인데 프로젝트 폴더 안에서 바뀐 파일이 하나도 확인되지 않았습니다';
    // 주니어(지브스 직접 코딩 에이전트)는 폴더 밖을 건드릴 수 없으니 변경이 없으면 한 일이 없는 것 → 실패.
    // 시니어(Claude Code·Codex)는 폴더 밖에서 일했을 수 있으니 성공은 두되 "미검증"으로 표시한다.
    if (engine && engine.kind === 'api-coder') return { level: 'fail', ok: false, reasons: [why] };
    return { level: 'warn', ok: true, reasons: [why + ' (폴더 밖에서 한 일이면 직접 확인해 주세요)'] };
  }
  return { level: 'pass', ok: true, reasons: [] };
}

module.exports = { looksLikeToolCallText, expectsChanges, hasChanges, verifyResult };

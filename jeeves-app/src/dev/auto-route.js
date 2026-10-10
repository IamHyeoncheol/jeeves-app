// 입력 자동 분류("기본(자동)" 탭): 지시를 보고 대화 / 작업(개발·브라우저)을 규칙으로 가른다. AI 호출 없음, 토큰 0.
// 안전 원칙: 확실할 때만 작업으로 보낸다. 애매하면 대화로 답하고(파일·실행 없음) "작업으로 실행" 단추를 보여 준다.
//   · 작업으로 보내기 = 시키는 말투(…해줘/…하자) + 만들기·고치기·검색 같은 행동 낱말 + 개발·브라우저 중 어느 쪽인지 규칙으로 가려짐
//   · 사용자가 탭을 직접 고르면 그 선택이 우선(이 모듈은 "기본(자동)" 탭일 때만 쓴다)
const { classifyRoute } = require('./dev-router');

const ACTION_RE = /(만들어|만들고|만들자|개발해|구현해|수정해|고쳐|바꿔|추가해|옮겨|이동해|삭제해|지워|정리해|생성해|작성해|실행해|설치해|검색해|찾아\s*(줘|주세요|서)|접속해|들어가|열어\s*(줘|주세요)|클릭해|로그인해|다운로드해|내려받아|비교해|캡처해|수집해|조회해|신청해|예약해)/;
const IMPERATIVE_RE = /(줘|주세요|해라|하자|해봐|해주|부탁|해 줄래|해줄래)/;
const QUESTION_RE = /(\?|？|뭐야|무엇|왜\s|어떻게|어떤|설명해|알려\s*(줘|주세요)|차이|가능해|인가요|일까|할까|어때|이유|의미)/;
const DEV_VERBS = /(만들|개발|구현|수정|고쳐|고치|추가|코딩|작성|빌드|옮겨|이동|삭제|지워|정리)/g;
const WEB_VERBS = /(검색|찾아|조회|접속|클릭|다운로드|내려받|비교|수집|캡처|예약|신청|열어|들어가)/g;

// 개발·브라우저 신호가 둘 다 있을 때: 마지막으로 나온 행동 낱말 쪽을 고른다("구글에서 검색해서 앱 만들어줘" → 개발). 끝내 못 가리면 'ask'
function resolveRoute(goal) {
  const rc = classifyRoute(goal);
  if (rc.route !== 'ask' || rc.devHits + rc.webHits === 0) return rc;
  const g = String(goal || '');
  const last = re => { let m, i = -1; const r = new RegExp(re.source, 'g'); while ((m = r.exec(g))) i = m.index; return i; };
  const d = last(DEV_VERBS), w = last(WEB_VERBS);
  if (d < 0 && w < 0) return rc;
  if (d === w) return rc;
  return { ...rc, route: d > w ? 'dev' : 'browser', tiebreak: '마지막 행동 낱말 기준' };
}

// 반환: { mode:'chat'|'work', route:'dev'|'browser'|undefined, confidence:'high'|'low', reasons:[...] }
function classifyInput(text) {
  const s = String(text || '').trim();
  if (!s) return { mode: 'chat', confidence: 'high', reasons: ['내용 없음'] };
  if (/^\//.test(s)) return { mode: 'chat', confidence: 'high', reasons: ['스킬(/이름) 호출'] };
  const action = ACTION_RE.test(s), imperative = IMPERATIVE_RE.test(s), question = QUESTION_RE.test(s);
  const rc = resolveRoute(s);
  const signal = rc.devHits + rc.webHits > 0 || /[A-Za-z]:\\/.test(s);
  if (question && !imperative) return { mode: 'chat', confidence: 'high', reasons: ['질문·설명 요청으로 보임'] };
  if (action && (imperative || !question)) {
    if (rc.route === 'dev') return { mode: 'work', route: 'dev', confidence: 'high', reasons: [rc.tiebreak ? `개발 지시로 판단(${rc.tiebreak})` : '파일·코드를 만들거나 고치는 지시'] };
    if (rc.route === 'browser') return { mode: 'work', route: 'browser', confidence: 'high', reasons: [rc.tiebreak ? `사이트 조작 지시로 판단(${rc.tiebreak})` : '사이트에서 찾거나 조작하는 지시'] };
    return { mode: 'chat', confidence: 'low', reasons: ['행동 지시로 보이지만 개발인지 브라우저 조작인지 가리지 못함'] };
  }
  if (signal) return { mode: 'chat', confidence: 'low', reasons: ['작업 관련 낱말은 있으나 시키는 말투가 아님'] };
  if (imperative && !question) return { mode: 'chat', confidence: 'low', reasons: ['시키는 말투지만 무엇을 할지 분명하지 않음'] };
  return { mode: 'chat', confidence: 'high', reasons: ['일반 대화로 보임'] };
}

// 브라우저 작업을 어느 탭에서 할지 규칙으로 정한다(AI 없음). 기본은 사용자를 방해하지 않는 새 백그라운드 탭.
// '지금 보는 탭'은 글에서 지금 화면·이 페이지를 가리키거나, 현재 페이지 내용 포함을 켠 때만.
const HERE_RE = /(이|현재|지금|여기|열려\s*있는|보고\s*있는|열어\s*둔|보는|열린)\s*(보는|보고\s*있는|열려\s*있는|열린)?\s*(페이지|화면|탭|사이트|창|웹)|여기서|이\s*(글|내용|표|목록)/;
function pickTab(text, opts = {}) {
  const s = String(text || '');
  if (HERE_RE.test(s)) return { where: 'current', reason: '지금 보는 화면을 가리키는 말이 있음' };
  if (opts.includePage) return { where: 'current', reason: '"현재 페이지 내용 포함"이 켜져 있음' };
  return { where: 'background', reason: '기본값(보고 있는 탭을 건드리지 않음)' };
}

module.exports = { classifyInput, resolveRoute, pickTab };

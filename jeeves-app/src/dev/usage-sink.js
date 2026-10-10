// 구독 사용률 수집 통로: Claude Code 출력의 rate_limit_event 를 읽은 곳(대화·작업·개발 엔진)이 여기로 넘기면,
// main.js 가 등록한 받는 쪽(DevCapacity.recordUsage)에 전달한다. AI 호출 0.
const { usageFromEvent } = require('./dev-capacity');
let sink = null;
function setUsageSink(fn) { sink = typeof fn === 'function' ? fn : null; }
// stream-json 한 줄(객체)을 넣으면 사용률 이벤트일 때만 전달. 오류는 삼킨다(작업을 멈추지 않음)
function feed(m, family = 'claude') {
  if (!sink || !m || m.type !== 'rate_limit_event') return false;
  try { const u = usageFromEvent(m, Date.now(), family); if (u) { sink(u); return true; } } catch (_) {}
  return false;
}
module.exports = { setUsageSink, feed };

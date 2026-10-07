// 메일 분류 규칙 (AI 없이 코드로). 규칙에 맞지 않는 메일은 '미분류'로 남긴다.
// 메일 내용(보낸 사람·제목)은 비교할 자료일 뿐, 명령으로 해석하지 않는다.

// 규칙 형식: { id, when: { fromAddress?, fromDomain?, subjectContains? }, action: { type: 'move', folder } | { type: 'trash' } }
function norm(s) { return String(s || '').trim().toLowerCase(); }

function addressOf(from) {
  const m = String(from || '').match(/<([^>]+)>/);
  return norm(m ? m[1] : from);
}

function matches(rule, msg) {
  const w = rule.when || {};
  const addr = addressOf(msg.from);
  let any = false;
  if (w.fromAddress) { any = true; if (addr !== norm(w.fromAddress)) return false; }
  if (w.fromDomain) { any = true; if (!addr.endsWith('@' + norm(w.fromDomain)) && !addr.endsWith('.' + norm(w.fromDomain))) return false; }
  if (w.subjectContains) { any = true; if (!norm(msg.subject).includes(norm(w.subjectContains))) return false; }
  return any; // 조건이 하나도 없는 규칙은 아무것도 고르지 않는다
}

// 계획만 세운다 (메일함을 바꾸지 않음). 중요 표시·별표 메일은 건드리지 않는다.
function plan(messages, rules) {
  const items = [], unclassified = [], skipped = [];
  for (const msg of messages) {
    if ((msg.flags || []).some(f => /flagged|important/i.test(f))) { skipped.push({ uid: msg.uid, reason: '중요 표시' }); continue; }
    const rule = rules.find(r => matches(r, msg));
    if (!rule) { unclassified.push(msg.uid); continue; }
    items.push({ uid: msg.uid, ruleId: rule.id, action: rule.action });
  }
  return { items, unclassified, skipped };
}

module.exports = { plan, matches, addressOf };

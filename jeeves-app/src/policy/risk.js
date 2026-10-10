// 위험 등급 판정 (R0~R3) — 순수 함수, Electron·파일·AI 를 쓰지 않는다.
// 기준서 7장: R0 조회 / R1 되돌릴 수 있는 쓰기 / R2 외부 영향 / R3 금전·법적·보안.
// 코드가 판정하고, AI 는 등급을 올릴 수만 있다(내릴 수 없음). 페이지 글이 판정을 낮추지 못한다(헌장 6조).
// hard = 위임 규칙으로도 풀 수 없는 차단(민감정보 칸·주민/카드번호·잘못된 주소).

const LEVELS = ['R0', 'R1', 'R2', 'R3'];
const rank = l => { const i = LEVELS.indexOf(l); return i < 0 ? 3 : i; };   // 모르는 값은 가장 위험한 쪽으로

const R3_WORDS = /(결제|구매하기|구매 완료|바로\s?구매|주문하기|주문 완료|송금|이체|인증서|탈퇴|해지|영구\s?삭제|비밀번호\s?변경|계정\s?삭제|pay\b|pay now|purchase|buy now|place order|checkout|transfer|permanently delete|delete account|close account)/i;
const R2_WORDS = /(구매|주문|전송|보내기|발송|제출|신청 완료|삭제|확정|게시|등록하기|올리기|동의|send|submit|delete|remove|confirm|publish|post|unsubscribe)/i;
const SEND_FIELD = /comment|message|post|reply|댓글|메시지|답장/i;
const SEND_TITLE = /(댓글|메시지|채팅|comment|message|chat)/i;
const READ_ONLY = new Set(['scroll', 'read_page_text', 'view_screen', 'go_back', 'wait', 'ask_user', 'done', 'observe']);
const BROWSER_WRITE = new Set(['navigate', 'click', 'type_text', 'select_option', 'press_key']);
const RRN = /\b\d{6}-?[1-4]\d{6}\b/;
const CARD = /(?:\d[ -]?){13,19}/;

function maxLevel(a, b) {
  if (!b) return LEVELS.includes(a) ? a : 'R3';
  if (!a) return LEVELS.includes(b) ? b : 'R3';
  return LEVELS[Math.max(rank(a), rank(b))];
}

function cardLike(text) {
  const m = String(text || '').match(CARD);
  if (!m) return false;
  const digits = m[0].replace(/\D/g, '');
  if (digits.length < 13 || digits.length > 19) return false;
  // 룬 검사(카드번호 체크섬)로 전화번호 같은 긴 숫자의 오탐을 줄인다
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = +digits[digits.length - 1 - i];
    if (i % 2 === 1) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
  }
  return sum % 10 === 0;
}

// action: { name, input = {}, snap = null, aiLevel = null, opts = { trashLevel } }
// 반환: { level, block, hard, why, rule }
function classify(action = {}) {
  const { name, input = {}, snap = null, aiLevel = null, opts = {} } = action;
  const el = snap && input && input.id != null && Array.isArray(snap.elements) ? snap.elements.find(e => e.id === input.id) : null;
  const label = el ? `${el.name || ''} ${el.kind || ''}` : '';
  const out = (level, rule, why, hard = false) => {
    const lv = hard ? 'R3' : maxLevel(level, LEVELS.includes(aiLevel) ? aiLevel : null);
    const raisedByAi = !hard && lv !== level;
    return { level: lv, block: hard || lv === 'R3', hard, rule: raisedByAi ? rule + '+ai' : rule, why: raisedByAi ? `${why} (AI가 위험 등급을 ${lv}로 올림)` : why };
  };

  if (name === 'type_text' && el && el.sensitive) return out('R3', 'sensitive-field', '비밀번호·카드 등 민감정보 칸에는 입력할 수 없습니다. 사용자가 직접 입력해야 합니다.', true);
  if (name === 'type_text' && RRN.test(input.text || '')) return out('R3', 'rrn-value', '주민등록번호 형태의 값은 입력하지 않습니다.', true);
  if (name === 'type_text' && cardLike(input.text)) return out('R3', 'card-value', '카드번호 형태의 값은 입력하지 않습니다.', true);
  if (name === 'navigate' && !/^(https?:\/\/|[\w-]+(\.[\w-]+)+)/i.test(String(input.url || '').trim())) return out('R3', 'bad-url', 'http/https 주소만 열 수 있습니다.', true);

  if (name === 'click' && el) {
    if (R3_WORDS.test(label)) return out('R3', 'r3-word', `"${el.name}" 은(는) 금전·계정에 영향을 주는 동작입니다.`);
    if (R2_WORDS.test(label)) return out('R2', 'r2-word', `"${el.name}" 버튼은 되돌릴 수 없는 동작일 수 있습니다.`);
    if (/submit/.test(el.kind || '') && snap.hasPassword) return out('R2', 'login-submit', '로그인/인증 양식 제출');
  }
  if (name === 'type_text' && input.press_enter && el && SEND_FIELD.test((el.name || '') + (el.placeholder || ''))) return out('R2', 'enter-send', '입력 후 Enter 가 메시지 전송·게시가 될 수 있습니다.');
  if (name === 'press_key' && input.key === 'Enter' && snap && SEND_TITLE.test(snap.title || '')) return out('R2', 'enter-send', 'Enter 가 메시지 전송이 될 수 있습니다.');
  if (name === 'download') return out('R2', 'download', '파일 다운로드');
  if (name === 'mail_trash') return out(opts.trashLevel === 'R1' ? 'R1' : 'R2', 'mail-trash', '메일 휴지통 이동');
  if (name === 'mail_move') return out('R1', 'mail-move', '메일 폴더 이동');
  if (BROWSER_WRITE.has(name)) return out('R1', 'default-r1', '되돌릴 수 있는 화면 조작');
  if (READ_ONLY.has(name)) return out('R0', 'read-only', '조회');
  return out('R2', 'unknown-action', `알 수 없는 행동(${name})은 확인이 필요합니다.`);
}

module.exports = { LEVELS, classify, maxLevel, rank, cardLike, R3_WORDS, R2_WORDS, BROWSER_WRITE };

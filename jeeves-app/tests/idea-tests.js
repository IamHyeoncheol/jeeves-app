// 💡 아이디어 모드 시험: 공개 정보 검사, 질문 틀, 안내 문구, 부문 규칙(웹 로그인형은 아이디어 부문 전용·자동 전환 없음)
const assert = require('assert');
const { ideaCheck, frame, withBanner, MAX_LEN } = require('../src/main/idea');
const { ModelRouter } = require('../src/models/router');
const results = [];
const t = async (name, fn) => { try { await fn(); results.push([true, name]); } catch (e) { results.push([false, name, e.message]); } };

const cfgOf = (over = {}) => ({
  infoGrade: 'I', failover: true,
  providers: {
    anthropic: { type: 'anthropic', label: 'Anthropic', baseUrl: 'https://api.anthropic.com', apiKey: 'k', tier: 'paid' },
    'exolobe-web': { type: 'webchat', label: 'ExoLobe', baseUrl: 'https://x.com/chat', apiKey: '', tier: 'free', maxGrade: 'P' }
  },
  roles: {
    chat: { label: '대화', provider: 'exolobe-web', model: 'web', mode: 'manual' },
    idea: { label: '아이디어', provider: 'exolobe-web', model: 'web', mode: 'manual' }
  }, ...over
});

(async () => {
  await t('공개용 질문은 통과', () => assert.ok(ideaCheck('건조식품의 수분을 빨리 빼는 다른 분야의 원리를 알려줘').ok));
  await t('빈 질문·너무 긴 질문은 막음', () => { assert.ok(!ideaCheck('  ').ok); assert.ok(!ideaCheck('가'.repeat(MAX_LEN + 1)).ok); });
  await t('회사 이름은 막음', () => { for (const w of ['이엘피 누설전류', '아쿠아케이 매출', '퍼스트에그 데이터', '해원바이오 제품']) assert.ok(!ideaCheck(w).ok, w); });
  await t('금액 숫자는 막음', () => { for (const w of ['단가 5만원', '매출 3억 목표', '비용 $200']) assert.ok(!ideaCheck(w).ok, w); });
  await t('기밀·비밀 의심어는 막음', () => { for (const w of ['계약서 초안 아이디어', '비밀번호 관리', '거래처 연락처 정리']) assert.ok(!ideaCheck(w).ok, w); });
  await t('AI 모델 이름은 막음', () => assert.ok(!ideaCheck('Claude 보다 나은 방법').ok));
  await t('질문 틀: 주제 포함, 논문 지어내기 금지 문구', () => { const f = frame('열 전달 개선'); assert.ok(f.includes('열 전달 개선') && f.includes('확인 불가') && f.includes('근거 논문')); });
  await t('답변 앞에 미검증 안내', () => assert.ok(withBanner('답').startsWith('⚠️ ExoLobe 답변')));
  await t('웹 로그인형은 대화 부문으로 쓸 수 없음', () => {
    const r = new ModelRouter(() => cfgOf(), async () => { throw new Error('no'); });
    assert.throws(() => r.resolve('chat', 'P'), /아이디어 모드 전용/);
  });
  await t('아이디어 부문은 웹 로그인형을 P 등급에서 사용', () => {
    const r = new ModelRouter(() => cfgOf(), async () => { throw new Error('no'); });
    assert.strictEqual(r.resolve('idea', 'P').id, 'exolobe-web');
  });
  await t('아이디어 부문은 I 등급이면 막힘(등급 관문)', () => {
    const r = new ModelRouter(() => cfgOf(), async () => { throw new Error('no'); });
    assert.throws(() => r.resolve('idea', 'I'), /쓸 수 없습니다/);
  });
  await t('아이디어 부문이 추천 모드여도 다른 공급자로 바뀌지 않음', () => {
    const c = cfgOf(); c.roles.idea.mode = 'auto';
    const r = new ModelRouter(() => c, async () => { throw new Error('no'); });
    assert.strictEqual(r.resolve('idea', 'P').id, 'exolobe-web');
  });
  const bad = results.filter(r => !r[0]);
  results.forEach(r => console.log((r[0] ? 'PASS ' : 'FAIL ') + r[1] + (r[2] ? ' — ' + r[2] : '')));
  console.log(`idea-tests: ${results.length - bad.length}/${results.length}`);
  process.exit(bad.length ? 1 : 0);
})();

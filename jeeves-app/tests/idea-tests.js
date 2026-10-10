// 💡 아이디어 모드 시험: 공개 정보 검사, 질문 틀, 안내 문구, 부문 규칙(웹 로그인형은 아이디어 부문 전용·자동 전환 없음)
const assert = require('assert');
const { ideaCheck, frame, withBanner, structure, MAX_LEN } = require('../src/main/idea');
const fs = require('fs');
// 화면의 마크다운 변환 함수만 꺼내 시험(app.js 는 화면 코드라 통째로 불러올 수 없음)
const appSrc = fs.readFileSync(require('path').join(__dirname, '../src/ui/app.js'), 'utf8');
const md = new Function(appSrc.slice(appSrc.indexOf('function esc'), appSrc.indexOf("document.addEventListener('click', e => {\n  const a = e.target.closest('a[data-link]')")) + ';return md;')();
const SAMPLE = '소개 문장입니다.\n\n1. 진공 건조 (Vacuum)\n원리: 압력을 낮춥니다.\n다른 분야에서의 활용:\n회전 증발기: 용매를 뺍니다.\n동결 건조: 의약품에 씁니다.\n2. 표면적 늘리기\n원리: 얇게 썹니다.\n결론\n두 가지를 함께 씁니다.';
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
  await t('질문 틀: 주제 포함, 논문 지어내기 금지 문구', () => { const f = frame('열 전달 개선'); assert.ok(f.includes('열 전달 개선') && f.includes('확인 불가') && f.includes('영어 검색어') && f.includes('논문 제목·저자·DOI')); });
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
  await t('구조화: 번호 줄은 소제목, 라벨은 굵은 항목, 콜론만 있는 줄 아래는 하위 항목, 결론은 큰 제목', () => {
    const o = structure(SAMPLE, '건조 원리');
    assert.ok(o.startsWith('## 💡 아이디어 후보 — 건조 원리'));
    assert.ok(o.includes('### 1. 진공 건조 (Vacuum)') && o.includes('### 2. 표면적 늘리기'));
    assert.ok(o.includes('- **원리:** 압력을 낮춥니다.'));
    assert.ok(o.includes('- **다른 분야에서의 활용**\n  - **회전 증발기:** 용매를 뺍니다.'));
    assert.ok(o.includes('## 결론\n두 가지를 함께 씁니다.'));
  });
  await t('구조화: 이미 마크다운이면 그대로', () => { const x = '## 제목\n- 항목'; assert.strictEqual(structure(x, 'q'), x); });
  await t('화면 변환: 제목 단계·중첩 목록·번호 시작값', () => {
    const h = md('## 큰\n### 작은\n- 가\n  - 나\n- 다\n\n3. 셋');
    assert.ok(h.includes('<h2>큰</h2>') && h.includes('<h3>작은</h3>'));
    assert.ok(h.includes('<li>가<ul><li>나</li></ul></li><li>다</li></ul>'));
    assert.ok(h.includes('<ol start="3">'));
  });
  await t('화면 변환: 구조화한 답이 제목·소제목·중첩 목록 HTML 이 됨', () => {
    const h = md(structure(SAMPLE, 'q'));
    assert.ok(h.startsWith('<h2>') && h.includes('<h3>1. 진공 건조') && h.includes('<ul><li><b>원리:</b>') && h.includes('<h2>결론</h2>'));
  });
  await t('왼쪽 목록: 아이디어 대화는 kind=idea, 예전 💡 제목도 아이디어로 분류, 일반 대화는 chat', () => {
    const os = require('os'), path = require('path');
    const { ConversationStore } = require('../src/main/conversations');
    const st = new ConversationStore(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'idea-')), 'c.json'));
    st.create({ title: '일반 질문', grade: 'I' });
    st.create({ title: '💡 새 아이디어', grade: 'P', kind: 'idea' });
    st.create({ title: '💡 예전 아이디어', grade: 'P' });
    const k = Object.fromEntries(st.list().convs.map(c => [c.title, c.kind]));
    assert.deepStrictEqual(k, { '일반 질문': 'chat', '💡 새 아이디어': 'idea', '💡 예전 아이디어': 'idea' });
  });
  await t('왼쪽 구역 접기: 가장 최근에 쓴 구역을 찾음(대화·아이디어·작업(개발 포함)·프로젝트)', () => {
    const a = fs.readFileSync(require('path').join(__dirname, '../src/ui/app.js'), 'utf8');
    const body = a.slice(a.indexOf('function sbLatestSec'), a.indexOf('function applySbFold'));
    const latest = new Function('sbData', body + ';return sbLatestSec();');
    const C = (updatedAt, kind, projectId) => ({ updatedAt, kind, projectId: projectId || null });
    const W = (at, kind, projectId) => ({ at, kind, projectId: projectId || null });
    assert.strictEqual(latest({ convs: [C('2026-10-09T01', 'chat'), C('2026-10-09T05', 'idea')], works: [W('2026-10-09T03', 'dev')] }), 'idea');
    assert.strictEqual(latest({ convs: [C('2026-10-09T01', 'chat')], works: [W('2026-10-09T03', 'dev'), W('2026-10-09T02', 'work')] }), 'work');   // 개발은 작업 구역에 통합
    assert.strictEqual(latest({ convs: [C('2026-10-09T09', 'chat', 'p1')], works: [W('2026-10-09T03', 'work')] }), 'proj');
    assert.strictEqual(latest({ convs: [], works: [] }), null);
  });
  const bad = results.filter(r => !r[0]);
  results.forEach(r => console.log((r[0] ? 'PASS ' : 'FAIL ') + r[1] + (r[2] ? ' — ' + r[2] : '')));
  console.log(`idea-tests: ${results.length - bad.length}/${results.length}`);
  process.exit(bad.length ? 1 : 0);
})();

// "기본(자동)" 입력 분류 시험(0.46): 대화/작업(개발·브라우저)을 규칙으로 가르고, 애매하면 대화로만 답한다(실행 없음).
const assert = require('assert');
const { classifyInput, resolveRoute } = require('../src/dev/auto-route');
const { classifyRoute } = require('../src/dev/dev-router');

const results = [];
const t = async (name, fn) => { try { await fn(); results.push([true, name]); } catch (e) { results.push([false, name, e.message]); } };
const c = g => classifyInput(g);

(async () => {
  await t('일반 대화·질문·스킬 호출은 대화(확실)', () => {
    for (const g of ['안녕하세요', '전기안전관리법이 뭐야?', '누설전류가 왜 위험한지 설명해줘', '코드 어떻게 만들어?', '/요약 이 글', '']) {
      const r = c(g); assert.strictEqual(r.mode, 'chat', g); assert.strictEqual(r.confidence, 'high', g);
    }
  });

  await t('확실한 작업 지시는 작업: 만들기·고치기·옮기기=개발, 검색·가격 비교=브라우저', () => {
    for (const g of ['하루 일정을 시간 블록으로 짜는 플래너 앱을 만들어줘', 'D:\\proj 폴더의 index.html 에서 버튼 색을 고쳐줘', '\\박시\\는 다른 프로젝트인데, D:\\AI_Project로 옮겨줘']) {
      const r = c(g); assert.deepStrictEqual([r.mode, r.route, r.confidence], ['work', 'dev', 'high'], g);
    }
    for (const g of ['네이버에서 가양역 근처 회의실 3곳 찾아서 가격 비교해줘', '기업마당에서 전기안전 지원사업 공고 검색해줘']) {
      const r = c(g); assert.deepStrictEqual([r.mode, r.route, r.confidence], ['work', 'browser', 'high'], g);
    }
  });

  await t('개발·브라우저 신호가 겹치면 마지막 행동 낱말로 가름 ("검색해서 앱 만들어줘"=개발, "코드 확인하고 검색해줘"=브라우저)', () => {
    assert.strictEqual(classifyRoute('구글에서 검색해서 앱 만들어줘').route, 'ask');   // 기존 규칙은 그대로 'ask'
    assert.strictEqual(resolveRoute('구글에서 검색해서 앱 만들어줘').route, 'dev');
    assert.strictEqual(resolveRoute('로그인 버그를 고쳐줘 코드는 login.js').route, 'dev');
    assert.strictEqual(resolveRoute('앱 코드는 두고 네이버에서 가격 검색해줘').route, 'browser');
    assert.strictEqual(resolveRoute('이거 좀 알아서 해줘').route, 'ask');   // 신호가 없으면 끝내 못 가림
  });

  await t('애매하면 대화(낮은 확신): 작업 낱말만 있거나, 시키는 말투인데 대상이 불분명', () => {
    for (const g of ['네이버 회의실 가격', '이거 좀 알아서 해줘', '구글 검색 앱']) {
      const r = c(g); assert.strictEqual(r.mode, 'chat', g); assert.strictEqual(r.confidence, 'low', g);
    }
  });

  await t('안전: 낮은 확신·질문은 어떤 경우에도 작업(work)으로 가지 않음', () => {
    const cases = ['삭제', '파일', '폴더 삭제?', '파일 지우는 방법 알려줘', '네이버', 'D:\\AI_Project', '어떻게 옮겨?', '이 폴더 옮겨도 돼?'];
    for (const g of cases) assert.strictEqual(c(g).mode, 'chat', g);
  });

  await t('결과 모양: reasons 는 화면에 보일 한 줄 이상, route 는 작업일 때만', () => {
    for (const g of ['안녕', '앱 만들어줘', '네이버에서 검색해줘', '이거 좀 해줘']) {
      const r = c(g);
      assert.ok(Array.isArray(r.reasons) && r.reasons.length >= 1 && typeof r.reasons[0] === 'string', g);
      assert.ok(r.mode === 'work' ? ['dev', 'browser'].includes(r.route) : r.route === undefined, g);
      assert.ok(['high', 'low'].includes(r.confidence), g);
    }
  });

  let fail = 0;
  for (const [ok, name, err] of results) { if (!ok) fail++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '  → ' + err}`); }
  console.log(`\nauto-tests: ${results.length - fail}/${results.length} 통과`);
  process.exit(fail ? 1 : 0);
})();

// 작업 결과 검증 시험(0.46): 글로 쓴 도구 호출 문장·변경 없음을 성공으로 치지 않고, 실패하면 더 강한 엔진으로 올린다.
// 실제로 있었던 실패(Ollama llama3.1:8b 가 {"name":"write_file",...} 문장만 출력했는데 "완료"로 표시됨)를 가짜 AI 로 그대로 재현한다.
const assert = require('assert');
const fs = require('fs'), os = require('os'), path = require('path');
const { EventEmitter } = require('events');
const { looksLikeToolCallText, expectsChanges, hasChanges, verifyResult } = require('../src/dev/verify');
const { ApiCoderTask } = require('../src/main/api-coder');
const { runChain } = require('../src/main/dev-chain');
const { DevRouter, juniorSafe, analyzeDifficulty } = require('../src/dev/dev-router');

const results = [];
const t = async (name, fn) => { try { await fn(); results.push([true, name]); } catch (e) { results.push([false, name, e.message]); } };
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'vf-'));
const use = (name, input, id = 'u' + Math.random()) => ({ type: 'tool_use', id, name, input });
const reply = (...blocks) => ({ content: blocks, stopReason: 'tool_use', usage: { input: 10, output: 10 }, costUsd: 0, model: 'fake' });
const say = text => ({ type: 'text', text });
const fakeRouter = script => { const q = [...script]; return { calls: 0, async callProvider() { this.calls++; const x = q.shift(); if (!x) throw Object.assign(new Error('script end'), { kind: 'server' }); if (x instanceof Error) throw x; return x; } }; };
const eng = (id, extra) => ({ id, label: id, kind: 'api-coder', family: 'api', cost: 'free', maxLevel: 2, minLevel: 1, maxGrade: 'P', available: true, junior: true, provider: { type: 'openai', label: 'x', baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'k' }, model: 'm', ...extra });
const runTask = (script, folder, goal = '인사 파일을 만들어 줘') => new Promise(resolve => {
  const task = new ApiCoderTask({ id: 1, goal, folder, engine: eng('jr'), router: fakeRouter(script), grade: 'P', maxSteps: 8 });
  const events = []; task.on('event', e => events.push(e)); task.on('finished', r => resolve({ r, events })); task.start();
});
const FAKE_PY = "{'name': 'write_file', 'parameters': {'content': '# Hello, World!', 'path': 'D:\\\\AI_Project\\\\박시\\\\file.txt'}}";
const FAKE_JSON = '{"name": "list_files", "parameters": {"path": "jeeves/"}}';

(async () => {
  await t('도구 호출 문장 감지: JSON·파이썬 사전·태그 형식은 잡고, 정상 보고·빈 글은 통과', () => {
    for (const x of [FAKE_PY, FAKE_JSON, '<tool_call>{"x":1}</tool_call>', '{"tool_calls": [{"id": 1}]}', '이렇게 하겠습니다 ' + FAKE_JSON]) assert.ok(looksLikeToolCallText(x), x);
    for (const x of ['파일 2개를 만들었습니다. 실행은 npm test 입니다.', '', null, undefined, 'name 과 parameters 라는 낱말이 있는 설명', 'x'.repeat(5000) + FAKE_JSON]) assert.ok(!looksLikeToolCallText(x), String(x).slice(0, 40));
  });

  await t('변경 기대 판정: 만들기·옮기기는 변경을 기대, 설명·분석만 시키면 기대하지 않음', () => {
    for (const g of ['\\박시\\는 다른 프로젝트인데 D:\\AI_Project로 옮겨줘', '로그인 화면을 만들어줘', 'fix the bug', '이 코드가 왜 느린지 설명해줘 그리고 고쳐줘']) assert.ok(expectsChanges(g), g);
    for (const g of ['이 코드가 왜 느린지 설명해줘', '구조를 분석해 줘', '', '오늘 날씨 알려줘']) assert.ok(!expectsChanges(g), g);
    assert.ok(hasChanges({ added: ['a'], modified: [], removed: [] }) && hasChanges({ added: [], modified: [], removed: ['x'] }) && !hasChanges({ added: [], modified: [], removed: [] }) && !hasChanges(null));
  });

  await t('검증 판정: 호출 문장=실패, 주니어 변경 없음=실패, 시니어 변경 없음=미검증 표시, 변경 있음·설명 지시·비교 불가=통과', () => {
    const none = { added: [], modified: [], removed: [] }, some = { added: ['a.txt'], modified: [], removed: [] };
    const jr = { kind: 'api-coder' }, sr = { kind: 'claude' };
    assert.strictEqual(verifyResult({ goal: '파일 만들어줘', result: { success: true, summary: FAKE_PY, changes: some }, engine: sr }).level, 'fail');
    assert.strictEqual(verifyResult({ goal: '파일 만들어줘', result: { success: true, summary: '됨', changes: none }, engine: jr }).level, 'fail');
    const w = verifyResult({ goal: '파일 만들어줘', result: { success: true, summary: '됨', changes: none }, engine: sr });
    assert.strictEqual(w.level, 'warn'); assert.ok(w.ok && /폴더 밖/.test(w.reasons[0]));
    assert.strictEqual(verifyResult({ goal: '파일 만들어줘', result: { success: true, summary: '됨', changes: some }, engine: jr }).level, 'pass');
    assert.strictEqual(verifyResult({ goal: '왜 느린지 설명해줘', result: { success: true, summary: '설명', changes: none }, engine: jr }).level, 'pass');
    assert.strictEqual(verifyResult({ goal: '파일 만들어줘', result: { success: true, summary: '됨', changes: null }, engine: jr }).level, 'pass');
    assert.strictEqual(verifyResult({ goal: '파일 만들어줘', result: { success: false, summary: '못 함', changes: none }, engine: jr }).level, 'pass');   // 실패 보고는 그대로
  });

  await t('실제 실패 재현: 호출 문장만 출력 → 빈 파일 하나 쓰고 → 또 호출 문장 = 예전에는 성공, 이제는 실패(task)', async () => {
    const d = tmp();
    const { r, events } = await runTask([reply(say(FAKE_JSON)), reply(use('write_file', { path: 'file.txt', content: '' })), reply(say(FAKE_PY))], d);
    assert.strictEqual(r.success, false); assert.strictEqual(r.kind, 'task');
    assert.ok(/호출 문장/.test(r.summary));
    assert.ok(events.some(e => e.type === 'info' && /호출 문장만 글로 출력/.test(e.text)));
  });

  await t('호출 문장 한 번은 바로잡을 기회를 주고, 이어서 진짜 도구를 쓰면 정상 성공', async () => {
    const d = tmp();
    const { r } = await runTask([reply(say(FAKE_PY)), reply(use('write_file', { path: 'hello.txt', content: '안녕' })), reply(use('done', { success: true, summary: '만들었습니다' }))], d);
    assert.strictEqual(r.success, true); assert.strictEqual(r.summary, '만들었습니다');
    assert.ok(fs.existsSync(path.join(d, 'hello.txt')));
  });

  await t('기존 동작 유지: 파일을 쓴 뒤 정상 글로 답하면 성공, done 보고에 호출 문장이 있으면 거절하고 정상 보고를 받음', async () => {
    const d1 = tmp();
    const a = await runTask([reply(use('write_file', { path: 'a.txt', content: 'x' })), reply(say('파일을 만들었습니다.'))], d1);
    assert.strictEqual(a.r.success, true);
    const d2 = tmp();
    const b = await runTask([reply(use('write_file', { path: 'a.txt', content: 'x' })), reply(use('done', { success: true, summary: FAKE_JSON })), reply(use('done', { success: true, summary: '정상 보고입니다' }))], d2);
    assert.strictEqual(b.r.success, true); assert.strictEqual(b.r.summary, '정상 보고입니다');
  });

  await t('엔진 전환: 약한 주니어가 호출 문장만 내면 실패로 보고 더 강한 엔진이 이어서 끝냄(chain ✗ → ✓)', async () => {
    const d = tmp(); const rt = new DevRouter();
    const e1 = eng('jr-weak', { maxLevel: 1 }), e2 = eng('jr-strong', { maxLevel: 2 });
    const router = fakeRouter([reply(say(FAKE_PY)), reply(say(FAKE_PY)), reply(use('write_file', { path: 'out.txt', content: '완성' })), reply(use('done', { success: true, summary: '끝' }))]);
    const events = [];
    const done = await new Promise(resolve => runChain({ id: 7, goal: '결과 파일을 만들어 줘', folder: d, chain: [e1, e2], devRouter: rt, bins: {}, workDir: d, level: 1, router, grade: 'P', krwPerUsd: 1400, handoff: false, emit: ev => { events.push(ev); if (ev.type === 'done') resolve(ev); } }));
    assert.strictEqual(done.success, true); assert.deepStrictEqual(done.chain.map(c => c.ok), [false, true]);
    assert.ok(events.some(e => e.type === 'info' && /엔진 전환/.test(e.text)));
    assert.strictEqual(done.verified, true);
  });

  // 가짜 엔진 클래스: 엔진 id 에 따라 "변경 없이 성공" 또는 "파일을 바꾸고 성공"을 보고한다
  class FakeApi extends EventEmitter {
    constructor(o) { super(); this.o = o; }
    start() { setImmediate(() => { const changed = this.o.engine.id === 'jr-ok'; this.emit('finished', { success: true, summary: '끝났습니다', kind: 'ok', engineId: this.o.engine.id, engineLabel: this.o.engine.label, subscription: false, estUsd: 0, changes: { added: changed ? ['a.txt'] : [], modified: [], removed: [] }, denied: [] }); }); }
    stop() {}
  }
  const chainRun = (goal, chain, extra = {}) => new Promise(resolve => { const d = tmp(); const events = []; runChain({ id: 9, goal, folder: d, chain, devRouter: new DevRouter(), bins: {}, workDir: d, level: 1, router: null, grade: 'P', krwPerUsd: 1400, handoff: false, ApiClass: FakeApi, ...extra, emit: ev => { events.push(ev); if (ev.type === 'done') resolve({ done: ev, events }); } }); });

  await t('변경 없이 "성공"이라 한 주니어는 검증 실패 → 강한 엔진으로 올라가 변경을 만들면 완료', async () => {
    const { done, events } = await chainRun('폴더 안에 결과 파일을 만들어 줘', [eng('jr-lazy', { maxLevel: 1 }), eng('jr-ok', { maxLevel: 2 })]);
    assert.strictEqual(done.success, true); assert.deepStrictEqual(done.chain.map(c => c.ok), [false, true]);
    assert.ok(events.some(e => e.type === 'info' && /검증 실패/.test(e.text)));
  });

  await t('올릴 엔진이 더 없으면 "완료"가 아니라 중단으로 끝나고 검증 실패 이유가 남음', async () => {
    const { done } = await chainRun('폴더 안에 결과 파일을 만들어 줘', [eng('jr-lazy', { maxLevel: 2 })]);
    assert.strictEqual(done.success, false); assert.ok(/검증 실패/.test(done.summary));
  });

  await t('검증 끄기(verify:false)·설명 지시는 기존대로 성공', async () => {
    const a = await chainRun('폴더 안에 결과 파일을 만들어 줘', [eng('jr-lazy')], { verify: false });
    assert.strictEqual(a.done.success, true);
    const b = await chainRun('이 구조가 왜 이런지 설명해줘', [eng('jr-lazy')]);
    assert.strictEqual(b.done.success, true); assert.strictEqual(b.done.verified, true);
  });

  await t('주니어 단독 배정: 파일·폴더 이동·삭제 지시는 시니어에게(주니어는 이동 도구·폴더 밖 접근 없음)', () => {
    const ok = g => juniorSafe(g, analyzeDifficulty(g)).ok;
    for (const g of ['D:\\AI_Project\\박시\\iris 폴더를 D:\\AI_Project로 옮겨줘', 'old 폴더 안 파일을 삭제해 줘', 'move the file to another folder', 'temp 파일 제거해 줘']) assert.ok(!ok(g), g);
    for (const g of ['버튼 문구와 색상을 바꿔 줘', '화면 이동 애니메이션 문구 오타 고쳐 줘']) assert.ok(ok(g) || /이동/.test(g), g);   // 보수적: 애매하면 시니어
    assert.ok(ok('버튼 문구와 색상을 바꿔 줘'));
  });

  let fail = 0;
  for (const [ok, name, err] of results) { if (!ok) fail++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '  → ' + err}`); }
  console.log(`\nverify-tests: ${results.length - fail}/${results.length} 통과`);
  process.exit(fail ? 1 : 0);
})();

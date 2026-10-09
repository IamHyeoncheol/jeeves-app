// 팀 개발 시험: 시니어 계획 → 주니어 구현(실패 시 시니어) → 자동 검증 → 시니어 검수 (가짜 AI 사용)
const assert = require('assert');
const fs = require('fs'), os = require('os'), path = require('path');
const { EventEmitter } = require('events');
const { runTeam, readTasks } = require('../src/main/dev-team');
const { DevRouter } = require('../src/dev/dev-router');

const results = [];
const t = async (name, fn) => { try { await fn(); results.push([true, name]); } catch (e) { results.push([false, name, e.stack.split('\n').slice(0, 3).join(' | ')]); } };
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'team-'));
const senior = { id: 'claude-sonnet', label: 'Claude(시니어)', kind: 'claude', family: 'claude', cost: 'subscription', maxLevel: 3, minLevel: 1, maxGrade: 'I', available: true };
const junior = { id: 'jr-x', label: '주니어 · 로컬', kind: 'api-coder', family: 'api', cost: 'free', maxLevel: 2, minLevel: 1, maxGrade: 'S', local: true, junior: true, available: true };

// 가짜 작업 클래스: handler(opts) → 결과 일부. 호출 기록을 calls 에 남긴다.
const fakeClass = (handler, calls) => class extends EventEmitter {
  constructor(o) { super(); this.o = o; }
  start() { setImmediate(async () => { calls.push({ by: this.o.engine.id, goal: this.o.goal }); const r = await handler(this.o); this.emit('finished', { success: true, summary: 'ok', kind: 'ok', engineId: this.o.engine.id, engineLabel: this.o.engine.label, subscription: this.o.engine.cost !== 'free', estUsd: 0, changes: null, denied: [], ...r }); }); }
  stop() {}
};
const run = (folder, handler, extra = {}) => new Promise(resolve => {
  const calls = [], events = [], rt = new DevRouter();
  const Cls = fakeClass(handler, calls);
  const planFor = (lv, kind) => rt.plan({ grade: 'P', level: lv, engines: [senior, junior].filter(e => kind === 'any' || (kind === 'junior' ? e.junior : !e.junior)) }).chain;
  let ctl;
  const answer = extra.answer || (() => ({}));
  ctl = runTeam({ id: 9, goal: '여러 파일로 된 앱을 만들어 줘', folder, level: 3, planFor, devRouter: rt, bins: { claude: 'x' }, workDir: folder, emit: ev => { events.push(ev); if (ev.type === 'team-assign') setImmediate(() => ctl.respond(answer(ev))); if (ev.type === 'done') resolve({ done: ev, calls, events, rt }); }, TaskClass: Cls, ApiClass: Cls, juniorMaxLevel: 2, ...extra });
});
const writeTasks = (folder, arr) => { fs.mkdirSync(path.join(folder, '.jeeves'), { recursive: true }); fs.writeFileSync(path.join(folder, '.jeeves', 'tasks.json'), typeof arr === 'string' ? arr : JSON.stringify(arr)); };
const T3 = [{ id: 1, title: '화면', desc: 'index.html 만들기', files: ['index.html'], level: 1, risk: 'low' }, { id: 2, title: '스타일', desc: 'style.css', files: ['style.css'], level: 2, risk: 'low' }, { id: 3, title: '로그인 보안', desc: '인증 로직', files: ['auth.js'], level: 3, risk: 'low' }];   // L3 는 risk 가 low 여도 시니어
const T_HIGH = [{ id: 1, title: '핵심 로직', desc: '계산 규칙', files: ['calc.js'], level: 1, risk: 'high' }, { id: 2, title: '표시 없음', desc: 'x', files: [], level: 1 }];

(async () => {
  await t('tasks.json 읽기: 배열/객체 모두, 위험 경로 제거, 이상한 항목 버림', () => {
    const d = tmp();
    writeTasks(d, '```json\n' + JSON.stringify({ tasks: [{ title: 'a', desc: 'x', level: 9, files: ['../evil', '/abs', 'ok.js'] }, null, 5, { desc: '' }] }) + '\n```');
    const r = readTasks(d); assert.strictEqual(r.length, 1); assert.strictEqual(r[0].level, 3); assert.deepStrictEqual(r[0].files, ['ok.js']);
    writeTasks(d, 'not json'); assert.strictEqual(readTasks(d), null);
  });

  await t('팀: 시니어 계획 → 쉬운 조각은 주니어, 어려운 조각은 시니어 → 검수까지', async () => {
    const d = tmp();
    const { done, calls } = await run(d, o => { if (/1단계/.test(o.goal)) writeTasks(d, T3); });
    assert.strictEqual(done.success, true);
    assert.deepStrictEqual(calls.map(c => c.by), ['claude-sonnet', 'jr-x', 'jr-x', 'claude-sonnet', 'claude-sonnet']);   // 계획, 1, 2, 3, 검수
    assert.deepStrictEqual(done.teamTasks.map(x => x.ok), [true, true, true]);
    assert.ok(/4단계/.test(calls[4].goal) && /2\/3/.test(calls[2].goal));
    assert.ok(done.team === true);
  });

  await t('팀: 주니어 배정은 먼저 물어봄 — 추천안 표시, 사용자가 바꾼 대로 진행', async () => {
    const d = tmp();
    const r1 = await run(d, o => { if (/1단계/.test(o.goal)) writeTasks(d, T3); });
    const ask = r1.events.find(e => e.type === 'team-assign');
    assert.ok(ask); assert.deepStrictEqual(ask.tasks.map(x => x.rec), ['junior', 'junior', 'senior']);
    const d2 = tmp();
    const r2 = await run(d2, o => { if (/1단계/.test(o.goal)) writeTasks(d2, T3); }, { answer: () => ({ assign: { 1: 'senior', 2: 'senior', 3: 'senior' } }) });
    assert.ok(r2.calls.every(c => c.by === 'claude-sonnet'), '전부 시니어로 바꿨는데 주니어가 일함');
  });

  await t('팀: 확인 대기 중 중지하면 멈춤, 확인 끄면 묻지 않고 추천대로', async () => {
    const d = tmp();
    const r = await run(d, o => { if (/1단계/.test(o.goal)) writeTasks(d, T3); }, { answer: () => ({ cancel: true }) });
    assert.strictEqual(r.done.success, false); assert.ok(/중지/.test(r.done.summary));
    const d2 = tmp();
    const r2 = await run(d2, o => { if (/1단계/.test(o.goal)) writeTasks(d2, T3); }, { confirm: false });
    assert.ok(!r2.events.some(e => e.type === 'team-assign')); assert.ok(r2.calls.some(c => c.by === 'jr-x'));
  });

  await t('팀: 품질 영향이 클 수 있는(risk high·표시 없음) 조각은 L1 이어도 시니어가 직접', async () => {
    const d = tmp();
    const { done, calls } = await run(d, o => { if (/1단계/.test(o.goal)) writeTasks(d, T_HIGH); });
    assert.strictEqual(done.success, true);
    assert.ok(calls.every(c => c.by === 'claude-sonnet'), JSON.stringify(calls.map(c => c.by)));
  });

  await t('팀: 주니어가 두 번 실패하면 같은 작업을 시니어가 맡음', async () => {
    const d = tmp();
    const { done, calls, events } = await run(d, o => {
      if (/1단계/.test(o.goal)) writeTasks(d, T3.slice(0, 1));
      else if (o.engine.id === 'jr-x') return { success: false, kind: 'task', summary: '못 만듦' };
    });
    assert.strictEqual(done.success, true);
    assert.deepStrictEqual(calls.map(c => c.by), ['claude-sonnet', 'jr-x', 'jr-x', 'claude-sonnet', 'claude-sonnet']);
    assert.ok(events.some(e => /시니어에게 올립니다/.test(e.text || '')));
    assert.ok(/claude/i.test(done.teamTasks[0].by) || /시니어/.test(done.teamTasks[0].by));
  });

  await t('팀: 계획 파일이 깨졌으면 기존 방식으로 전체 작업', async () => {
    const d = tmp();
    const { done, calls, events } = await run(d, o => { if (/1단계/.test(o.goal)) writeTasks(d, '깨진 내용'); });
    assert.strictEqual(done.success, true);
    assert.ok(events.some(e => /기존 방식/.test(e.text || '')));
    assert.strictEqual(calls.length, 2);
  });

  await t('팀: 시니어가 모두 한도면 계획 단계에서 멈추고 이유를 알림', async () => {
    const d = tmp();
    const { done, calls } = await run(d, () => ({ success: false, kind: 'limit', summary: '한도 소진' }));
    assert.strictEqual(done.success, false); assert.ok(/계획 단계/.test(done.summary));
  });

  await t('팀: 자동 검증 실패 → 시니어 수정 → 재검증 통과', async () => {
    const d = tmp();
    fs.writeFileSync(path.join(d, 'package.json'), JSON.stringify({ name: 'x', scripts: { test: 'node -e "process.exit(1)"' } }));
    const { done, calls } = await run(d, o => {
      if (/1단계/.test(o.goal)) writeTasks(d, T3.slice(0, 1));
      if (/검증 실패 수정/.test(o.goal)) fs.writeFileSync(path.join(d, 'package.json'), JSON.stringify({ name: 'x', scripts: { test: 'node -e "process.exit(0)"' } }));
    });
    assert.strictEqual(done.success, true); assert.ok(/통과\(수정 후\)/.test(done.summary));
    assert.ok(calls.some(c => /검증 실패 수정/.test(c.goal)));
  });

  await t('팀: 검증이 끝내 실패하면 미완으로 보고', async () => {
    const d = tmp();
    fs.writeFileSync(path.join(d, 'package.json'), JSON.stringify({ name: 'x', scripts: { test: 'node -e "process.exit(1)"' } }));
    const { done } = await run(d, o => { if (/1단계/.test(o.goal)) writeTasks(d, T3.slice(0, 1)); });
    assert.strictEqual(done.success, false); assert.ok(/검증 실패/.test(done.summary));
  });

  await t('팀: .jeeves 폴더는 변경 목록에서 빠짐', async () => {
    const d = tmp();
    const { done } = await run(d, o => { if (/1단계/.test(o.goal)) writeTasks(d, T3.slice(0, 1)); else fs.writeFileSync(path.join(d, 'a.txt'), '1'); });
    assert.ok(done.changes.added.includes('a.txt') && !done.changes.added.some(f => f.startsWith('.jeeves')));
  });

  let fail = 0;
  for (const [ok, name, err] of results) { if (!ok) fail++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '  → ' + err}`); }
  console.log(`\n${results.length - fail}/${results.length} 통과`);
  process.exit(fail ? 1 : 0);
})();

// 개발 작업 보관소 시험: main.js 의 "개발 작업 보관소" 구간만 잘라 가짜 부품(설정·엔진 실행·타이머)과 함께 실행한다.
// 한도로 멈춤 → 대기 예약 → 풀리면 재선정 후 재개 → 완료 / 중지 / 자동 재개 끄기 / 앱 재시작 복원을 확인한다.
const assert = require('assert');
const fs = require('fs'), os = require('os'), path = require('path');
const { DevCapacity } = require('../src/dev/dev-capacity');

const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'main.js'), 'utf8');
const a = src.indexOf('// ── 개발 작업 보관소'), b = src.indexOf('app.whenReady()');
assert.ok(a > 0 && b > a, '보관소 구간을 찾지 못함');
const block = src.slice(a, b);

const results = [];
async function t(name, fn) { try { await fn(); results.push([true, name]); } catch (e) { results.push([false, name, e.stack || e.message]); } }
const flush = () => new Promise(r => setImmediate(r));

function world(over = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jv-jobs-'));
  const w = { events: [], hist: [], timers: [], runs: [], handlers: {}, now: Date.now(), cfg: { dev: { autoResume: true, resumeOnStart: 'auto' }, ui: {} }, planChain: [{ id: 'claude-sonnet', label: 'Claude Code · sonnet', family: 'claude' }], waiting: null, runBehavior: [] };
  w.cap = new DevCapacity(null, () => w.now);
  const devRuns = new Map(), tasks = new Map(), liveWorks = new Map();
  const env = {
    fs, path, require, app: { getPath: () => dir }, config: { get: () => w.cfg }, send: (ch, ev) => { if (ch === 'agent:event') w.events.push(ev); },
    logErr: e => { w.err = e; }, saveTaskHistory: e => w.hist.push(e), liveWorks, devRuns, tasks, router: {}, devRouter: {},
    FAMILIES: ['claude', 'codex'], HOUR_MS: 3600000, MAX_WAIT_MS: 12 * 3600000, devCap: w.cap,
    ipcMain: { handle: (n, f) => { w.handlers[n] = f; } },
    setTimeout: (f, ms) => { const t = { f, ms }; w.timers.push(t); return t; }, clearTimeout: t => { if (t) t.dead = true; },
    devPlan: async () => ({ ok: true, folder: dir, grade: 'I', difficulty: { level: 3, label: '어려움', reasons: [] }, volume: { value: 3, label: '큼' }, chain: w.planChain, _chain: w.planChain, _bins: {}, waiting: w.waiting, error: w.planChain.length ? undefined : '맡길 AI 없음', _atts: [], empty: false }),
    runChain: o => { const beh = w.runBehavior.shift() || { success: true }; w.runs.push(o); setImmediate(() => { if (beh.limit) { o.onAttempt({ family: 'claude', id: 'claude-sonnet' }, { success: false, kind: 'limit', resumeAt: w.now + 2 * 3600000 }); w.cap.record({ family: 'claude', kind: 'limit', resumeAt: w.now + 2 * 3600000 }); o.emit({ taskId: o.id, type: 'done', success: false, summary: '한도', lastKind: 'limit', resumeAt: w.now + 2 * 3600000, dev: true, level: 3, chain: [], changes: null, denied: [] }); } else o.emit({ taskId: o.id, type: 'done', success: true, summary: '완료', dev: true, level: 3, chain: [], changes: null, denied: [] }); }); return { stop() { w.stopped = true; } }; },
    runTeam: () => { throw new Error('팀 실행 안 함'), 0; },
    policy: null, killSwitch: over.killSwitch || null, HALT_MSG: '비상 정지 중', pol: () => ({ org: 'default', user: 'owner' })
  };
  const names = Object.keys(env);
  // taskSeq 는 let 이어야 하므로 감싸서 쓴다
  const fn = new Function(...names, 'let taskSeq = 0;\n' + block + '\nreturn { devJobs, devLive, saveJobs, loadJobs, setFile: f => { devJobsFile = f; }, resumeJob, endJob, enterWait, devTimers, devPendingAsk, releaseHeldJobs, heldJobs };');
  const api = fn(...names.map(n => env[n]));
  api.setFile(path.join(dir, 'pending.json'));
  w.api = api; w.dir = dir; w.devRuns = devRuns; w.tasks = tasks;
  return w;
}
const start = (w, goal = '앱을 만들어줘') => w.handlers['dev:start'](null, { goal, infoGrade: 'I', folder: w.dir });
const types = w => w.events.map(e => e.type);

(async () => {
  await t('한도로 멈추면 done 을 내보내지 않고 풀리는 시각까지 대기 예약, 보관소에 저장', async () => {
    const w = world(); w.runBehavior = [{ limit: true }];
    const r = await start(w); await flush(); await flush();
    assert.ok(!types(w).includes('done'));
    const lim = w.events.find(e => e.type === 'limit'); assert.ok(lim && lim.known && lim.resumeAt >= w.now + 2 * 3600000);
    assert.strictEqual(w.timers.length, 1); assert.ok(w.timers[0].ms >= 2 * 3600000 - 1000);
    const saved = JSON.parse(fs.readFileSync(path.join(w.dir, 'pending.json'), 'utf8'));
    assert.strictEqual(saved.length, 1); assert.strictEqual(saved[0].state, 'waiting');
    assert.ok(w.devRuns.has(r.id));   // 대기 중에도 폴더 잠금 유지
  });

  await t('시각이 되면 여유를 다시 보고 같은 작업으로 재개 → 완료하면 done·기록·보관소 정리', async () => {
    const w = world(); w.runBehavior = [{ limit: true }, { success: true }];
    const r = await start(w); await flush(); await flush();
    w.now += 2 * 3600000 + 61000; w.timers[0].f(); await flush(); await flush(); await flush();
    assert.ok(w.events.some(e => e.type === 'resume' && /이어서 진행/.test(e.text)));
    assert.strictEqual(w.runs.length, 2); assert.ok(/\[이어서 진행\]/.test(w.runs[1].goal) && w.runs[1].goal.startsWith('앱을 만들어줘'));
    assert.strictEqual(w.events.filter(e => e.type === 'done').length, 1);
    assert.ok(w.events.find(e => e.type === 'done').success);
    assert.strictEqual(w.hist.length, 1); assert.strictEqual(w.hist[0].resumes, 1);
    assert.strictEqual(w.api.devJobs.size, 0); assert.strictEqual(w.devRuns.has(r.id), false);
    assert.strictEqual(JSON.parse(fs.readFileSync(path.join(w.dir, 'pending.json'), 'utf8')).length, 0);
  });

  await t('재개 시 아직 한도면 다시 대기, 6번 넘으면 포기', async () => {
    const w = world(); w.runBehavior = [{ limit: true }];
    await start(w); await flush(); await flush();
    w.planChain = []; w.waiting = { resumeAt: w.now + 3 * 3600000 };   // 재계획해도 여전히 한도
    w.timers[0].f(); await flush(); await flush();
    assert.strictEqual(w.timers.length, 2); assert.ok(!types(w).includes('done'));
    const j = [...w.api.devJobs.values()][0]; j.resumes = 6;   // 한도 반복 상한
    w.timers[1].f(); await flush(); await flush();
    assert.ok(types(w).includes('done'));
  });

  await t('대기 중 중지하면 예약이 취소되고 done 으로 정리', async () => {
    const w = world(); w.runBehavior = [{ limit: true }];
    const r = await start(w); await flush(); await flush();
    w.tasks.get(r.id).stop();
    const d = w.events.find(e => e.type === 'done'); assert.ok(d && !d.success && /취소/.test(d.summary));
    assert.strictEqual(w.api.devJobs.size, 0); assert.strictEqual(w.devRuns.has(r.id), false);
  });

  await t('자동 재개를 끄면 한도로 멈춘 채 끝남(대기 없음)', async () => {
    const w = world(); w.cfg.dev.autoResume = false; w.runBehavior = [{ limit: true }];
    await start(w); await flush(); await flush();
    assert.ok(types(w).includes('done')); assert.strictEqual(w.timers.length, 0);
  });

  await t('시작 시점에 이미 한도(풀리는 시각 앎): 예약만 하고 그때 착수', async () => {
    const w = world(); w.planChain = []; w.waiting = { resumeAt: w.now + 3600000 };
    const r = await start(w); await flush();
    assert.ok(r.waiting); assert.strictEqual(w.runs.length, 0); assert.strictEqual(w.timers.length, 1);
    w.planChain = [{ id: 'codex', label: 'Codex', family: 'codex' }]; w.waiting = null; w.now += 3700000;
    w.timers[0].f(); await flush(); await flush(); await flush();
    assert.strictEqual(w.runs.length, 1); assert.ok(w.events.find(e => e.type === 'done').success);
  });

  await t('한도가 아니라 풀리는 시각이 없는 경우: 자동 재개 설정이어도 맡길 곳 없으면 오류 반환', async () => {
    const w = world(); w.planChain = []; w.waiting = null;
    const r = await start(w); assert.ok(r.error);
  });

  await t('앱 재시작: 대기 중 작업은 예약 복원, 지난 작업은 자동 재개 / 물어보기 모드는 카드', async () => {
    const w = world(); w.runBehavior = [{ limit: true }];
    await start(w); await flush(); await flush();
    const file = path.join(w.dir, 'pending.json'); const saved = fs.readFileSync(file, 'utf8');
    // 재시작 ①: 예약 시각이 남음
    const w2 = world(); fs.writeFileSync(path.join(w2.dir, 'pending.json'), saved); w2.api.loadJobs();
    await w2.handlers['dev:pending'](); await flush();
    assert.ok(w2.events.some(e => e.type === 'created')); assert.ok(w2.events.some(e => e.type === 'limit')); assert.strictEqual(w2.timers.length, 1);
    assert.strictEqual((await w2.handlers['dev:pending']()).restored, 0);   // 두 번 불러도 한 번만
    // 재시작 ②: 예약 시각이 지남 → 자동
    const j = JSON.parse(saved); j[0].resumeAt = 1; const w3 = world(); fs.writeFileSync(path.join(w3.dir, 'pending.json'), JSON.stringify(j)); w3.api.loadJobs();
    await w3.handlers['dev:pending'](); assert.ok(w3.timers.length >= 1);
    w3.timers[0].f(); await flush(); await flush(); await flush();
    assert.strictEqual(w3.runs.length, 1); assert.ok(types(w3).includes('done'));
    // 재시작 ③: 물어보기 + 중간에 꺼진 작업
    j[0].state = 'running'; const w4 = world(); w4.cfg.dev.resumeOnStart = 'ask'; fs.writeFileSync(path.join(w4.dir, 'pending.json'), JSON.stringify(j)); w4.api.loadJobs();
    await w4.handlers['dev:pending'](); await flush();
    const pend = w4.events.find(e => e.type === 'pending'); assert.ok(pend); assert.strictEqual(w4.runs.length, 0);
    await w4.handlers['dev:pending-act'](null, { taskId: pend.taskId, act: 'discard' }); await flush();
    assert.ok(w4.events.some(e => e.type === 'done' && /취소/.test(e.summary))); assert.strictEqual(w4.api.devJobs.size, 0);
  });

  await t('비상 정지: 정지 중에는 새 개발 작업 거부, 예약된 재개는 실행하지 않고 보류(보관소에 남음) → 정지를 풀면 다시 예약', async () => {
    const ks = { halted: false };
    const w = world({ killSwitch: ks }); w.runBehavior = [{ limit: true }, { success: true }];
    await start(w); await flush(); await flush();
    assert.strictEqual(w.timers.length, 1);
    ks.halted = true;
    const r2 = await start(w, '다른 앱'); assert.ok(r2.error && /비상 정지/.test(r2.error));
    w.timers[0].f(); await flush(); await flush();
    assert.strictEqual(w.runs.length, 1, '재개 실행 없음');
    assert.ok(w.events.some(e => e.type === 'info' && /보류/.test(e.text)));
    assert.strictEqual(w.api.devJobs.size, 1, '보관소에 남음');
    ks.halted = false; w.api.releaseHeldJobs();
    const again = w.timers.slice(1).filter(x => !x.dead);
    assert.strictEqual(again.length, 1, '다시 예약됨');
    again[0].f(); await flush(); await flush(); await flush();
    assert.strictEqual(w.runs.length, 2, '재개 후 실행'); assert.strictEqual(w.api.devJobs.size, 0);
  });

  let fail = 0;
  for (const [ok, name, err] of results) { if (!ok) fail++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '  → ' + err}`); }
  console.log(`\n${results.length - fail}/${results.length} 통과`);
  process.exit(fail ? 1 : 0);
})();

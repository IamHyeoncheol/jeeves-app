// AI별 작업 내역·헛완료 방지·사용률 기준 넘김 제외·Codex 대화·시험 폴더 찾기 시험 (0.50)
const assert = require('assert');
const fs = require('fs'), os = require('os'), path = require('path');
const { EventEmitter } = require('events');
const { execFileSync } = require('child_process');
const A = require('../src/dev/attribution');
const H = require('../src/main/handoff');
const { runChain } = require('../src/main/dev-chain');
const { DevRouter } = require('../src/dev/dev-router');
const { codexChat } = require('../src/main/codex-chat');

const results = [];
const t = async (name, fn) => { try { await fn(); results.push([true, name]); } catch (e) { results.push([false, name, e.stack || e.message]); } };
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'attr-'));
const hasGit = (() => { try { execFileSync('git', ['--version']); return true; } catch (_) { return false; } })();
const gitRepo = () => {
  const d = tmp(); const g = (...a) => execFileSync('git', a, { cwd: d });
  g('init', '-q'); g('config', 'user.email', 't@t'); g('config', 'user.name', 't');
  fs.writeFileSync(path.join(d, 'keep.js'), 'function a() {\n  return 1;\n}\n'); g('add', '-A'); g('commit', '-qm', 'init');
  return d;
};
const eng = (id, extra) => ({ id, label: id, kind: 'api-coder', family: 'api', cost: 'free', maxLevel: 4, minLevel: 1, maxGrade: 'S', available: true, provider: { type: 'openai', label: 'x', baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'k' }, model: 'm', ...extra });
// 가짜 엔진: 엔진 id 별로 폴더에 무엇을 쓰는지 정해 둔다
const WRITES = {
  'lazy': () => {},
  'writer': d => { fs.writeFileSync(path.join(d, 'b.js'), 'const x = 1;\nconst y = 2;\n'); fs.writeFileSync(path.join(d, 'keep.js'), 'function a() {\n  return 2;\n}\n'); },
  'claude-x': d => { fs.writeFileSync(path.join(d, 'c.js'), 'x'); }
};
class FakeApi extends EventEmitter {
  constructor(o) { super(); this.o = o; }
  start() { setImmediate(() => { (WRITES[this.o.engine.id] || (() => {}))(this.o.folder); this.emit('finished', { success: true, summary: '끝났습니다', kind: 'ok', engineId: this.o.engine.id, engineLabel: this.o.engine.label, subscription: true, estUsd: 0, changes: null, denied: [] }); }); }
  stop() {}
}
const run = (folder, chain, extra = {}) => new Promise(resolve => { const events = []; runChain({ id: 5, goal: 'b.js 파일을 만들어 줘', folder, chain, devRouter: new DevRouter(), bins: {}, workDir: folder, level: 2, router: null, grade: 'P', krwPerUsd: 1400, ApiClass: FakeApi, ...extra, emit: ev => { events.push(ev); if (ev.type === 'done') resolve({ done: ev, events }); } }); });

(async () => {
  await t('diff 해석: 파일별 줄 범위·함수 영역, numstat·상태(추가/수정/삭제), 요약 문장', () => {
    const diff = 'diff --git a/x.js b/x.js\n--- a/x.js\n+++ b/x.js\n@@ -10,2 +10,5 @@ function load()\n+a\n@@ -40 +43,0 @@\n-b\ndiff --git a/n.js b/n.js\n--- /dev/null\n+++ b/n.js\n@@ -0,0 +1,3 @@\n+1\n';
    const h = A.parseHunks(diff);
    assert.deepStrictEqual(h['x.js'][0], { from: 10, to: 14, added: 5, removed: 2, where: 'function load()' });
    assert.strictEqual(h['x.js'][1].removed, 1); assert.strictEqual(h['n.js'][0].to, 3);
    assert.deepStrictEqual(A.parseNumstat('5\t2\tx.js\n-\t-\timg.png\n'), { 'x.js': { plus: 5, minus: 2 }, 'img.png': { plus: null, minus: null } });
    assert.deepStrictEqual(A.parseNameStatus('M\tx.js\nA\tn.js\nD\told.js\nR100\ta.js\tb.js\n'), { 'x.js': 'modified', 'n.js': 'added', 'old.js': 'removed', 'b.js': 'modified' });
    const s = A.summarize([{ engine: 'Codex', detail: 'lines', files: [{ path: 'x.js', change: 'modified', plus: 5, minus: 2, regions: h['x.js'] }] }, { engine: 'Claude', files: [] }]);
    assert.ok(/Codex: 추가 0·수정 1·삭제 0개 파일 \(\+5\/−2줄\)/.test(s) && /x\.js \[수정\] \+5\/−2 — 10~14줄 function load\(\)/.test(s) && /Claude: 변경 없음/.test(s), s);
  });

  await t('헛완료 방지: 바꿔야 하는 단계(requireChange)에서 변경 없이 "성공"하면 실패 → 다음 엔진이 실제로 바꾸면 완료', async () => {
    const d = tmp();
    const { done, events } = await run(d, [eng('lazy', { maxLevel: 2 }), eng('writer')], { requireChange: true, handoff: true });
    assert.strictEqual(done.success, true); assert.deepStrictEqual(done.chain.map(c => c.ok), [false, true]);
    assert.ok(events.some(e => e.type === 'info' && /변경 없음/.test(e.text)));
    assert.strictEqual(done.attribution.length, 2); assert.strictEqual(done.attribution[0].files.length, 0);
    assert.ok(done.attribution[1].files.some(f => f.path === 'b.js' && f.change === 'added'));
  });

  await t('헛완료 방지: 올릴 엔진이 없으면 완료가 아니라 실패로 끝남', async () => {
    const { done } = await run(tmp(), [eng('lazy')], { requireChange: true, handoff: true });
    assert.strictEqual(done.success, false); assert.ok(/변경 없음/.test(done.summary));
  });

  await t('사용률 기준: 넘김 대상(Claude 계열)이 avoid 에 걸리면 그 엔진으로 올리지 않고 사유와 함께 멈춤(추가 소모 0)', async () => {
    const d = tmp();
    const { done, events } = await run(d, [eng('lazy', { maxLevel: 2 }), eng('claude-x', { family: 'claude' })], { requireChange: true, handoff: true, avoid: e => e.family === 'claude' ? '사용률 95% ≥ 기준 90%' : null });
    assert.strictEqual(done.success, false); assert.ok(!fs.existsSync(path.join(d, 'c.js')), 'Claude 엔진은 실행되지 않음');
    assert.ok(/사용률 95%/.test(done.summary)); assert.ok(events.some(e => /넘김 대상에서 제외/.test(e.text || '')));
  });

  await t('Git 폴더: AI별 줄 단위 내역(체크포인트 사이 diff) + .jeeves/ATTRIBUTION.jsonl 기록, 작업 폴더·브랜치는 그대로', async () => {
    if (!hasGit) return;
    const d = gitRepo();
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: d }).toString().trim();
    const { done } = await run(d, [eng('writer')], { requireChange: true, handoff: true });
    assert.strictEqual(done.success, true);
    const a = done.attribution[0];
    assert.strictEqual(a.detail, 'lines');
    const keep = a.files.find(f => f.path === "keep.js"); const b = a.files.find(f => f.path === "b.js");
    assert.ok(keep && keep.change === 'modified' && keep.plus === 1 && keep.minus === 1 && keep.regions[0].from === 2, JSON.stringify(keep));
    assert.ok(b && b.change === 'added' && b.plus === 2);
    assert.ok(!a.files.some(f => f.path.startsWith('.jeeves')));
    const log = fs.readFileSync(path.join(d, '.jeeves', 'ATTRIBUTION.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    assert.strictEqual(log[0].engine, 'writer');
    assert.strictEqual(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: d }).toString().trim(), head, 'HEAD 그대로');
  });

  await t('시험 폴더 찾기: 프로젝트 폴더에 package.json(test)이 없으면 바로 아래 하위 폴더(예: jeeves-app)', () => {
    const d = tmp(); fs.mkdirSync(path.join(d, 'app')); fs.mkdirSync(path.join(d, 'node_modules'));
    assert.strictEqual(H.testDir(d), null);
    fs.writeFileSync(path.join(d, 'app', 'package.json'), JSON.stringify({ scripts: { test: 'node t.js' } }));
    assert.strictEqual(H.testDir(d), path.join(d, 'app')); assert.strictEqual(H.testCommand(d), 'npm test');
    fs.writeFileSync(path.join(d, 'package.json'), JSON.stringify({ scripts: { test: 'echo "Error: no test specified"' } }));
    assert.strictEqual(H.testDir(d), path.join(d, 'app'), '루트의 빈 test 는 무시');
  });

  const fakeSpawn = (behave) => (bin, args, opts) => {
    const c = new EventEmitter(); c.stdout = new EventEmitter(); c.stderr = new EventEmitter();
    c.stdout.setEncoding = c.stderr.setEncoding = () => {};
    c.stdin = { end: input => setImmediate(() => behave(c, args, opts, input)) }; c.kill = () => {};
    c.args = args; return c;
  };
  await t('Codex 대화: 읽기 전용·기록 안 남김 옵션으로 실행, 마지막 답 파일을 돌려줌 / 한도·로그인 구분', async () => {
    const w = tmp(); let seen = null;
    const ok = await codexChat({ bin: 'codex', prompt: '안녕', workDir: w, spawnImpl: fakeSpawn((c, args, opts, input) => {
      seen = { args, input }; fs.writeFileSync(args[args.indexOf('-o') + 1], '반갑습니다'); c.emit('close', 0); }) });
    assert.strictEqual(ok.text, '반갑습니다');
    assert.ok(seen.args.includes('read-only') && seen.args.includes('--ephemeral') && seen.args[seen.args.length - 1] === '-' && seen.input === '안녕');
    assert.strictEqual(fs.readdirSync(w).length, 0, '답 파일은 지움');
    await assert.rejects(codexChat({ bin: 'codex', prompt: 'x', workDir: w, spawnImpl: fakeSpawn(c => { c.stderr.emit('data', 'You have hit your usage limit'); c.emit('close', 1); }) }), e => e.kind === 'limit');
    await assert.rejects(codexChat({ bin: 'codex', prompt: 'x', workDir: w, spawnImpl: fakeSpawn(c => { c.stderr.emit('data', 'Not logged in. Run codex login'); c.emit('close', 1); }) }), e => e.kind === 'login');
  });

  let fail = 0;
  for (const [ok, name, err] of results) { if (!ok) fail++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '  → ' + err}`); }
  console.log(`\nattribution-tests: ${results.length - fail}/${results.length} 통과`);
  process.exit(fail ? 1 : 0);
})();

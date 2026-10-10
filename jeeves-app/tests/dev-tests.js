// 개발 모드 시험: 난이도 판정, 엔진 선택, 폴더 검사, 명령 만들기, 한도 시 엔진 전환(가짜 AI 사용)
const assert = require('assert');
const fs = require('fs'), os = require('os'), path = require('path');
const { analyzeDifficulty, buildEngines, DevRouter, classifyRoute } = require('../src/dev/dev-router');
const { checkFolder, buildCommand, CLAUDE_ALLOW, CLAUDE_DENY } = require('../src/main/dev-engine');
const { runChain } = require('../src/main/dev-chain');
const { DEFAULTS } = require('../src/main/config');

const results = [];
async function t(name, fn) { try { await fn(); results.push([true, name]); } catch (e) { results.push([false, name, e.stack || e.message]); } }
const clone = o => JSON.parse(JSON.stringify(o));
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'jv-dev-'));

(async () => {
  await t('난이도: 작은 수정 L1 / 앱 만들기 L3 / 결제·DB·설계 포함 L4', () => {
    assert.strictEqual(analyzeDifficulty('버튼 문구 오타 수정해줘').level, 1);
    assert.strictEqual(analyzeDifficulty('데일리 타임박싱 플래너 앱을 만들어줘').level, 3);
    assert.strictEqual(analyzeDifficulty('결제와 로그인 인증이 있는 쇼핑몰 서비스를 만들고 데이터베이스 설계도 해줘').level, 4);
    assert.strictEqual(analyzeDifficulty('로그 함수 하나 추가해줘').level, 1);
    assert.ok(analyzeDifficulty('스크립트 만들어줘').level >= 2);
    assert.ok(analyzeDifficulty('앱 만들어줘', { hasImages: true }).reasons.some(r => /시안/.test(r)));
  });

  await t('작업 통합 라우팅: 개발 신호만 → dev, 사이트 조작 신호만 → browser, 둘 다·둘 다 없음 → ask', () => {
    const r = g => classifyRoute(g).route;
    assert.strictEqual(r('하루 일정을 시간 블록으로 짜는 플래너 앱을 만들어줘'), 'dev');
    assert.strictEqual(r('D:\\proj 폴더의 index.html 에서 버튼 색을 고쳐줘'), 'dev');
    assert.strictEqual(r('네이버에서 가양역 근처 회의실 대여 3곳 찾아서 가격 비교'), 'browser');
    assert.strictEqual(r('기업마당에서 전기안전 지원사업 공고 정리해 줘'), 'browser');
    assert.strictEqual(r('구글에서 검색해서 앱 만들어줘'), 'ask');
    assert.strictEqual(r('로그인 버그를 고쳐줘 코드는 login.js'), 'ask');
    assert.strictEqual(r('이거 좀 알아서 해줘'), 'ask');
    assert.strictEqual(r(''), 'ask');
  });

  const cfgWith = (over) => { const c = clone(DEFAULTS); Object.assign(c.dev, over || {}); return c; };
  const allAvail = { claude: true, codex: true };

  await t('엔진 선택: L1=haiku, L3=sonnet, L4=opus(코덱스는 L4에서 약함 표시)', () => {
    const c = cfgWith({ codex: { ...DEFAULTS.dev.codex, enabled: true } });
    const engines = buildEngines(c, allAvail);
    const r = new DevRouter();
    const ids = lv => r.plan({ grade: 'I', level: lv, engines, prefer: ['claude', 'codex'] }).chain.map(e => e.id + (e.weak ? '!' : ''));
    assert.deepStrictEqual(ids(1)[0], 'claude-haiku');
    assert.deepStrictEqual(ids(3).slice(0, 2), ['claude-sonnet', 'codex']);
    const l4 = ids(4); assert.strictEqual(l4[0], 'claude-opus'); assert.ok(l4.includes('codex!'));
    // 코덱스 우선 설정
    assert.strictEqual(r.plan({ grade: 'I', level: 3, engines, prefer: ['codex', 'claude'] }).chain[0].id, 'codex');
  });

  await t('정보 등급: S 차단, C 는 허용 등급 올린 엔진만, 로컬 사용자 지정은 S 가능', () => {
    const c = cfgWith({ codex: { ...DEFAULTS.dev.codex, enabled: true }, custom: [{ id: 'ollama', label: '로컬 코더', bin: 'x', enabled: true, maxLevel: 2, maxGrade: 'S', local: true, cost: 'free' }] });
    const engines = buildEngines(c, { ...allAvail, 'cli-ollama': true });
    const r = new DevRouter();
    assert.deepStrictEqual(r.plan({ grade: 'S', level: 1, engines }).chain.map(e => e.id), ['cli-ollama']);
    assert.strictEqual(r.plan({ grade: 'C', level: 1, engines }).chain.map(e => e.id).includes('claude-haiku'), false);   // 기본 허용은 I
    const c2 = cfgWith({ claudeMaxGrade: 'C' });
    assert.ok(new DevRouter().plan({ grade: 'C', level: 1, engines: buildEngines(c2, allAvail) }).chain.length > 0);
    assert.strictEqual(new DevRouter().plan({ grade: 'S', level: 1, engines: buildEngines(c2, allAvail) }).chain.length, 0);
  });

  await t('무료 엔진이 구독보다 먼저, 쉬는 중·미설치 엔진은 제외 사유 표시', () => {
    const c = cfgWith({ custom: [{ id: 'free1', label: '무료 코더', bin: 'x', enabled: true, maxLevel: 3, maxGrade: 'P', cost: 'free' }] });
    const engines = buildEngines(c, { claude: true, codex: false, 'cli-free1': true });
    const r = new DevRouter();
    assert.strictEqual(r.plan({ grade: 'P', level: 2, engines }).chain[0].id, 'cli-free1');
    assert.strictEqual(r.plan({ grade: 'I', level: 2, engines }).chain[0].id, 'claude-haiku');   // 무료는 P 까지만(L2는 haiku가 맡음)
    r.rest('claude-sonnet', 60000, 'limit');
    const p = r.plan({ grade: 'I', level: 3, engines });
    assert.ok(p.skipped.some(s => s.id === 'claude-sonnet' && /쉬는 중/.test(s.why)));
    assert.strictEqual(p.chain[0].id, 'claude-opus');
    const c2 = cfgWith({ codex: { ...DEFAULTS.dev.codex, enabled: true } });
    const p2 = new DevRouter().plan({ grade: 'I', level: 1, engines: buildEngines(c2, { claude: true, codex: false }) });
    assert.ok(p2.skipped.some(s => s.id === 'codex' && /찾지 못함/.test(s.why)));
  });

  await t('폴더 검사: 루트·홈·없는 폴더·파일 거부, 일반 폴더 허용', () => {
    const d = tmp();
    assert.ok(checkFolder(d).ok);
    assert.ok(!checkFolder('/').ok);
    assert.ok(!checkFolder(os.homedir()).ok);
    assert.ok(!checkFolder(path.join(d, '없음')).ok);
    fs.writeFileSync(path.join(d, 'a.txt'), 'x'); assert.ok(!checkFolder(path.join(d, 'a.txt')).ok);
    assert.ok(!checkFolder('상대/경로').ok);
    assert.ok(!checkFolder(d, { userData: d }).ok);
  });

  await t('명령 만들기: Claude 허용/금지 목록, Codex 옵션, 기타 {prompt}·{cwd}', () => {
    const cl = buildCommand({ kind: 'claude', model: 'sonnet' }, { folder: '/p', rulesFile: '/r.txt', prompt: 'P' });
    const allow = cl.args[cl.args.indexOf('--allowedTools') + 1], deny = cl.args[cl.args.indexOf('--disallowedTools') + 1];
    assert.ok(/Edit/.test(allow) && /Write/.test(allow) && !/Bash\(rm/.test(allow) && !/mcp__jeeves/.test(allow));
    assert.ok(/Bash\(rm:\*\)/.test(deny) && /Bash\(git push:\*\)/.test(deny) && /Read\(\.\/\.env\)/.test(deny));
    assert.strictEqual(cl.args[cl.args.indexOf('--permission-mode') + 1], 'dontAsk');
    assert.strictEqual(cl.args[cl.args.indexOf('--model') + 1], 'sonnet');
    assert.strictEqual(cl.stdin, 'P');
    const cx = buildCommand({ kind: 'codex', args: 'exec --sandbox workspace-write -' }, { folder: '/p', prompt: 'P' });
    assert.deepStrictEqual(cx.args, ['exec', '--sandbox', 'workspace-write', '-']); assert.strictEqual(cx.stdin, 'P');
    const cu = buildCommand({ kind: 'cli', args: '--dir {cwd} --msg {prompt}' }, { folder: '/p', prompt: 'hello' });
    assert.deepStrictEqual(cu.args, ['--dir', '/p', '--msg', 'hello']); assert.strictEqual(cu.stdin, null);
    assert.ok(CLAUDE_ALLOW.length > 5 && CLAUDE_DENY.length > 5);
  });

  const fake = path.join(__dirname, 'fixtures', 'fake-dev.js');
  const run = (chain, env, folder, router) => new Promise(resolve => {
    Object.assign(process.env, { FAKE_LOG: path.join(folder, '..', path.basename(folder) + '.log') }, env);
    const events = [];
    runChain({ id: 1, goal: '앱을 만들어줘', folder, chain, devRouter: router, bins: { claude: fake, codex: fake }, workDir: path.join(folder, '..', path.basename(folder) + '-work'), level: 3,
      emit: ev => { events.push(ev); if (ev.type === 'done') resolve({ events, done: ev, log: fs.existsSync(process.env.FAKE_LOG) ? fs.readFileSync(process.env.FAKE_LOG, 'utf8').trim().split('\n').map(JSON.parse) : [] }); } });
  });
  const engines = () => buildEngines(cfgWith({ codex: { ...DEFAULTS.dev.codex, enabled: true } }), allAvail);

  await t('진행: Claude 성공 → 폴더 변경 보고, 막힌 요청 표시, 폴더에서 실행', async () => {
    const d = tmp(); const r = new DevRouter();
    const chain = r.plan({ grade: 'I', level: 3, engines: engines(), prefer: ['claude', 'codex'] }).chain;
    const { done, log } = await run(chain, { FAKE_CLAUDE_MODE: 'ok', FAKE_CODEX_MODE: 'ok' }, d, r);
    assert.ok(done.success && /Claude가 완료/.test(done.summary));
    assert.deepStrictEqual(done.changes.added, ['made-by-claude.txt']);
    assert.ok(done.denied.some(x => /rm -rf/.test(x)));
    assert.strictEqual(fs.realpathSync(log[0].cwd), fs.realpathSync(d));
    assert.strictEqual(log.length, 1);
  });

  await t('진행: Claude 한도 → Codex 로 전환하고 이어서 진행 지시를 전달, Claude 는 쉬는 중 표시', async () => {
    const d = tmp(); const r = new DevRouter();
    const chain = r.plan({ grade: 'I', level: 3, engines: engines(), prefer: ['claude', 'codex'] }).chain;
    const { done, events, log } = await run(chain, { FAKE_CLAUDE_MODE: 'limit', FAKE_CODEX_MODE: 'ok' }, d, r);
    assert.ok(done.success && /코덱스가 완료/.test(done.summary));
    assert.ok(events.some(e => e.type === 'info' && /엔진 전환: Claude Code · sonnet → Codex/.test(e.text)));
    assert.ok(log[1].who === 'codex' && /\[이어서 진행\]/.test(log[1].stdin) && /앱을 만들어줘/.test(log[1].stdin));
    assert.ok(r.resting('claude-sonnet'));
    assert.deepStrictEqual(done.chain.map(c => c.ok), [false, true]);
    assert.ok(fs.existsSync(path.join(d, 'made-by-codex.txt')));
  });

  await t('진행: 일을 못 끝낸 실패는 더 강한 엔진(opus)으로 한 번 올림', async () => {
    const d = tmp(); const r = new DevRouter();
    const chain = r.plan({ grade: 'I', level: 2, engines: engines(), prefer: ['claude', 'codex'] }).chain;   // haiku → sonnet → …
    const { done, events } = await run(chain, { FAKE_CLAUDE_MODE: 'taskfail', FAKE_CODEX_MODE: 'ok' }, d, r);
    assert.ok(events.some(e => /더 강한 엔진/.test(e.text || '')));
    assert.strictEqual(done.success, false);   // 가짜 Claude 는 계속 실패 → 한 번만 올리고 멈춤
    assert.strictEqual(done.chain.length, 2);
  });

  await t('진행: 모든 엔진이 막히면 이유와 다음 행동을 알리며 멈춤', async () => {
    const d = tmp(); const r = new DevRouter();
    const chain = r.plan({ grade: 'I', level: 3, engines: engines(), prefer: ['claude', 'codex'] }).chain.filter(e => e.id !== 'claude-opus');
    const { done } = await run(chain, { FAKE_CLAUDE_MODE: 'limit', FAKE_CODEX_MODE: 'limit' }, d, r);
    assert.strictEqual(done.success, false);
    assert.ok(/다른 개발 AI가 없어/.test(done.summary) && /한도/.test(done.summary));
    assert.ok(r.resting('codex'));
  });

  await t('진행: 중지하면 실행 중인 AI 를 끝냄', async () => {
    const d = tmp(); const r = new DevRouter();
    const chain = r.plan({ grade: 'I', level: 1, engines: engines() }).chain;
    Object.assign(process.env, { FAKE_LOG: path.join(d, '..', path.basename(d) + '.log'), FAKE_CLAUDE_MODE: 'ok' });
    const res = await new Promise(resolve => {
      const ctl = runChain({ id: 2, goal: 'x', folder: d, chain, devRouter: r, bins: { claude: fake, codex: fake }, workDir: path.join(d, '..', path.basename(d) + '-w'), level: 1, emit: ev => { if (ev.type === 'done') resolve(ev); } });
      ctl.stop();
    });
    assert.strictEqual(res.success, false);
    assert.ok(/중지/.test(res.summary));
  });

  let fail = 0;
  for (const [ok, name, err] of results) { if (!ok) fail++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '  → ' + err}`); }
  console.log(`\n${results.length - fail}/${results.length} 통과`);
  process.exit(fail ? 1 : 0);
})();

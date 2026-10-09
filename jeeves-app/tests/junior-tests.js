// 주니어 엔진 시험: 안전 검문(명령·경로), 코딩 루프(가짜 AI), 엔진 전환, 로컬 AI 탐지·배치, 정보 등급 관문
const assert = require('assert');
const fs = require('fs'), os = require('os'), path = require('path');
const { checkCommand, safePath, ApiCoderTask } = require('../src/main/api-coder');
const { runChain } = require('../src/main/dev-chain');
const { buildEngines, DevRouter, juniorSafe, analyzeDifficulty } = require('../src/dev/dev-router');
const { detectLocalModels, buildJuniorEngines } = require('../src/dev/local-ai');
const { ModelRouter } = require('../src/models/router');

const results = [];
const cmdOk = c => { try { checkCommand(c); return true; } catch (_) { return false; } };
const t = async (name, fn) => { try { await fn(); results.push([true, name]); } catch (e) { results.push([false, name, e.message]); } };
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'jr-'));
const use = (name, input, id = 'u' + Math.random()) => ({ type: 'tool_use', id, name, input });
const reply = (...blocks) => ({ content: blocks, stopReason: 'tool_use', usage: { input: 10, output: 10 }, costUsd: 0, model: 'fake' });
// 가짜 라우터: 미리 정한 답을 차례로 돌려준다. 값이 Error 면 던진다.
const fakeRouter = script => { const q = [...script]; return { calls: 0, async callProvider() { this.calls++; const x = q.shift(); if (!x) throw Object.assign(new Error('script end'), { kind: 'server' }); if (x instanceof Error) throw x; return x; } }; };
const eng = (id, extra) => ({ id, label: id, kind: 'api-coder', family: 'api', cost: 'free', maxLevel: 2, minLevel: 1, maxGrade: 'P', available: true, junior: true, provider: { type: 'openai', label: 'x', baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'k' }, model: 'm', ...extra });
const runTask = (script, folder, engine = eng('jr')) => new Promise(resolve => {
  const task = new ApiCoderTask({ id: 1, goal: '인사 파일을 만들어 줘', folder, engine, router: fakeRouter(script), grade: 'P', maxSteps: 8 });
  const events = []; task.on('event', e => events.push(e)); task.on('finished', r => resolve({ r, events })); task.start();
});

(async () => {
  await t('명령 검문: 허용 목록만 통과', () => {
    for (const c of ['npm install', 'npm test', 'npm run build', 'node app.js', 'python main.py', 'python -m unittest', 'pip install requests', 'git status', 'git add .', 'ls', 'dir']) assert.ok(cmdOk(c), c);
    for (const c of ['rm -rf /', 'curl http://x', 'node app.js; rm x', 'npm test && del x', 'python -c "print(1)"', 'git push', 'powershell -c x', 'node app.js > out.txt', 'echo `id`', 'pip install git+https://x/y.git', 'npm install -g x && y']) assert.ok(!cmdOk(c), c);
  });

  await t('경로 검문: 폴더 밖·비밀 파일 차단', () => {
    const d = tmp();
    assert.ok(safePath(d, 'a/b.txt', { write: true }).abs.startsWith(fs.realpathSync(d)));
    for (const p of ['../x.txt', '/etc/passwd', ...(process.platform === 'win32' ? ['C:\\Windows\\x'] : []), '.env', 'sub/.env.local', '.git/config', 'secrets/a.txt', 'id_rsa']) assert.throws(() => safePath(d, p, { write: true }), undefined, p);
  });

  await t('주니어: 파일을 만들고 done → 성공, 변경 목록·비용 0', async () => {
    const d = tmp();
    const { r, events } = await runTask([reply(use('write_file', { path: 'hello.txt', content: '안녕' })), reply(use('done', { success: true, summary: '만들었습니다' }))], d);
    assert.strictEqual(r.success, true); assert.ok(fs.existsSync(path.join(d, 'hello.txt')));
    assert.ok(r.changes.added.includes('hello.txt')); assert.ok(events.some(e => e.type === 'cost'));
  });

  await t('주니어: 아무것도 안 만들고 done 하면 거절 → 끝내 실패(task)', async () => {
    const d = tmp();
    const { r } = await runTask([reply(use('done', { success: true, summary: '됐음' })), reply(use('done', { success: true, summary: '됐음' })), reply(use('done', { success: false, summary: '못 함' }))], d);
    assert.strictEqual(r.success, false); assert.strictEqual(r.kind, 'task');
  });

  await t('주니어: 비밀 파일·폴더 밖 쓰기 시도는 거부되고 기록됨', async () => {
    const d = tmp();
    const { r } = await runTask([reply(use('write_file', { path: '.env', content: 'K=1' })), reply(use('write_file', { path: '../out.txt', content: 'x' })), reply(use('write_file', { path: 'ok.txt', content: 'y' })), reply(use('done', { success: true, summary: 'ok' }))], d);
    assert.strictEqual(r.success, true); assert.ok(!fs.existsSync(path.join(d, '.env'))); assert.ok(r.denied.length >= 2);
  });

  await t('주니어: 한도 오류는 limit, 키 오류는 login 으로 분류', async () => {
    const d = tmp();
    const a = await runTask([Object.assign(new Error('429'), { kind: 'limit' })], d); assert.strictEqual(a.r.kind, 'limit');
    const b = await runTask([Object.assign(new Error('401'), { kind: 'auth' })], d); assert.strictEqual(b.r.kind, 'login');
    const c = await runTask([Object.assign(new Error('does not support tools'), { kind: 'none' })], d); assert.strictEqual(c.r.kind, 'missing');
  });

  await t('진행: 주니어가 한도에 걸리면 다음 엔진으로 넘겨 끝냄', async () => {
    const d = tmp(), rt = new DevRouter();
    const e1 = eng('jr-a'), e2 = eng('jr-b');
    const routerA = { n: 0, async callProvider(p, m) { this.n++; if (this.n === 1) throw Object.assign(new Error('한도'), { kind: 'limit' }); return this.n === 2 ? reply(use('write_file', { path: 'x.txt', content: '1' })) : reply(use('done', { success: true, summary: '끝' })); } };
    const done = await new Promise(resolve => runChain({ id: 3, goal: 'g', folder: d, chain: [e1, e2], devRouter: rt, bins: {}, workDir: d, level: 1, router: routerA, grade: 'P', krwPerUsd: 1400, emit: ev => { if (ev.type === 'done') resolve(ev); } }));
    assert.strictEqual(done.success, true); assert.deepStrictEqual(done.chain.map(c => c.ok), [false, true]); assert.ok(rt.resting('jr-a'));
  });

  await t('탐지: Ollama·LM Studio 모델 목록, 임베딩 제외, 코딩 모델 우선', async () => {
    const f = async url => {
      if (/11434\/api\/tags/.test(url)) return { ok: true, json: async () => ({ models: [{ name: 'llama3.1:8b' }, { name: 'qwen2.5-coder:7b' }, { name: 'nomic-embed-text' }] }) };
      if (/1234\/v1\/models/.test(url)) return { ok: true, json: async () => ({ data: [{ id: 'deepseek-coder-6.7b' }] }) };
      throw new Error('x');
    };
    const ms = await detectLocalModels(f);
    assert.deepStrictEqual(ms.map(m => m.model).sort(), ['deepseek-coder-6.7b', 'llama3.1:8b', 'qwen2.5-coder:7b']);
    const none = await detectLocalModels(async () => { throw new Error('refused'); }); assert.deepStrictEqual(none, []);
    const js = buildJuniorEngines({ dev: { junior: { enabled: true } }, providers: {} }, ms);
    assert.ok(js.length === 3 && js[0].model.includes('coder') && js.every(e => e.local && e.cost === 'free' && e.maxGrade === 'S'));
    assert.deepStrictEqual(buildJuniorEngines({ dev: { junior: { enabled: false } }, providers: {} }, ms), []);
  });

  await t('배치: 쉬운 일(L1~2)은 무료 로컬 주니어 먼저, 어려운 일(L3)은 Claude 먼저, S 등급은 로컬만', () => {
    const cfg = { dev: { claude: { enabled: true }, codex: { enabled: 'auto', maxLevel: 3, maxGrade: 'I' }, junior: { enabled: true }, prefer: ['claude', 'codex'] }, providers: { gemini: { type: 'openai', label: 'Gemini', baseUrl: 'https://g/v1', apiKey: 'AIza', tier: 'free' } } };
    const local = [{ server: 'ollama', label: 'Ollama', baseUrl: 'http://127.0.0.1:11434/v1', apiKey: 'ollama', model: 'qwen2.5-coder:7b', code: true, sizeB: 7 }];
    const engines = buildEngines(cfg, { claude: true, codex: true }, buildJuniorEngines(cfg, local));
    const r = new DevRouter();
    assert.ok(engines.some(e => e.id === 'codex'));   // 'auto' + 설치됨 → 포함
    const c2 = r.plan({ grade: 'P', level: 2, engines }).chain; assert.ok(c2[0].junior && c2[0].local);
    const c3 = r.plan({ grade: 'P', level: 3, engines }).chain; assert.ok(!c3[0].junior);
    const cs = r.plan({ grade: 'S', level: 2, engines }).chain; assert.ok(cs.length >= 1 && cs.every(e => e.local));
    assert.ok(!buildEngines(cfg, { claude: true, codex: false }, []).some(e => e.id === 'codex'));   // 'auto' + 없음 → 제외
    const cc = r.plan({ grade: 'I', level: 3, engines, first: 'codex' }).chain; assert.strictEqual(cc[0].id, 'codex');   // Claude 한도 아끼기
  });

  await t('관문: 무료 Gemini 는 I 등급 거부, 로컬은 S 허용(콜러가 모델 호출 전에 막음)', async () => {
    const cfg = { providers: { gemini: { type: 'openai', label: 'Gemini', baseUrl: 'https://g/v1', apiKey: 'AIza', tier: 'free' } }, roles: {}, infoGrade: 'P' };
    let hit = 0;
    const router = new ModelRouter(() => cfg, async () => { hit++; return { ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message: { content: 'hi' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } }) }; });
    await assert.rejects(() => router.callProvider('gemini', 'gemini-3.5-flash-lite', { messages: [], infoGrade: 'I' }), /정보 등급/);
    assert.strictEqual(hit, 0);
    const res = await router.callProvider({ type: 'openai', label: 'Ollama', baseUrl: 'http://127.0.0.1:11434/v1', apiKey: 'ollama', tier: 'free' }, 'm', { system: 's', messages: [{ role: 'user', content: [{ type: 'text', text: 'x' }] }], infoGrade: 'S' });
    assert.ok(res.content.length && hit === 1);
  });

  await t('주니어 단독 배정: 품질에 영향이 클 수 있는 일(보안·버그·결제·연동 등)은 제외, 단순 문구·스타일만 통과', () => {
    const ok = g => juniorSafe(g, analyzeDifficulty(g)).ok;
    assert.ok(ok('버튼 문구와 색상을 바꿔 줘'));
    for (const g of ['로그인 기능 만들어줘', '결제 오류 고쳐줘', '이 버그 원인을 찾아줘', '외부 API 연동해줘', '데이터베이스 동기화', '여러 파일로 된 앱을 만들어줘']) assert.ok(!ok(g), g);
  });

  let fail = 0;
  for (const [ok, name, err] of results) { if (!ok) fail++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '  → ' + err}`); }
  console.log(`\n${results.length - fail}/${results.length} 통과`);
  process.exit(fail ? 1 : 0);
})();

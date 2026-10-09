// 모델 계층 단위 테스트 (네트워크 없이 가짜 fetch 사용)
const assert = require('assert');
const { ModelRouter } = require('../src/models/router');
const { toOpenAIMessages } = require('../src/models/providers');
const { DEFAULTS, ConfigStore, parseKeyFile } = require('../src/main/config');
const { costUsd } = require('../src/models/pricing');
const { needsLiveInfo, recommendFor, recommendAll, recommendEngine, effectiveMaxGrade, gradeOk, engineGradeOk, engineMaxGrade, suspectGrade, suspectDetail } = require('../src/models/recommend');
const fs = require('fs'), os = require('os'), path = require('path');
const { formatObservation, TOOLS } = require('../src/agent/agent');

const results = [];
async function t(name, fn) { try { await fn(); results.push([true, name]); } catch (e) { results.push([false, name, e.message]); } }
const clone = o => JSON.parse(JSON.stringify(o));

function fakeFetch(handler) {
  const calls = [];
  const f = async (url, opts) => {
    calls.push({ url, opts, body: JSON.parse(opts.body) });
    const r = await handler(url, JSON.parse(opts.body), calls.length);
    return { ok: r.status === 200, status: r.status, text: async () => JSON.stringify(r.body) };
  };
  f.calls = calls;
  return f;
}

(async () => {
  await t('Anthropic 요청 형식(헤더·모델·도구)', async () => {
    const cfg = clone(DEFAULTS); cfg.providers.anthropic.apiKey = 'sk-test';
    const f = fakeFetch(() => ({ status: 200, body: { content: [{ type: 'text', text: 'OK' }], stop_reason: 'end_turn', usage: { input_tokens: 5, output_tokens: 1 } } }));
    const r = new ModelRouter(() => cfg, f);
    const res = await r.call('agent', { system: 's', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }], tools: TOOLS });
    const c = f.calls[0];
    assert.strictEqual(c.url, 'https://api.anthropic.com/v1/messages');
    assert.strictEqual(c.opts.headers['x-api-key'], 'sk-test');
    assert.strictEqual(c.opts.headers['anthropic-version'], '2023-06-01');
    assert.strictEqual(c.body.model, 'claude-sonnet-5-5');      // 0.2 기본값
    assert.strictEqual(c.body.tools.length, TOOLS.length);
    assert.ok(!('temperature' in c.body));
    assert.deepStrictEqual(c.body.output_config, { effort: 'medium' });
    assert.deepStrictEqual(c.body.system[0].cache_control, { type: 'ephemeral' });
    assert.deepStrictEqual(c.body.tools[TOOLS.length - 1].cache_control, { type: 'ephemeral' });
    assert.ok(!c.body.tools[0].cache_control);
    assert.strictEqual(res.content[0].text, 'OK');
    assert.strictEqual(r.usage.agent.calls, 1);
    assert.strictEqual(res.costUsd, (5 * 2 + 1 * 10) / 1e6);
  });

  await t('부문별로 다른 공급자로 라우팅', async () => {
    const cfg = clone(DEFAULTS);
    cfg.providers.anthropic.apiKey = 'a'; cfg.providers.openrouter.apiKey = 'or';
    cfg.roles.summarize = { label: '요약', provider: 'openrouter', model: 'google/gemini-2.5-flash' };
    const f = fakeFetch(url => url.includes('openrouter')
      ? { status: 200, body: { choices: [{ message: { content: '요약' } }], usage: { prompt_tokens: 3, completion_tokens: 2 } } }
      : { status: 200, body: { content: [{ type: 'text', text: '대화' }], stop_reason: 'end_turn', usage: {} } });
    const r = new ModelRouter(() => cfg, f);
    const a = await r.call('summarize', { system: 's', messages: [{ role: 'user', content: [{ type: 'text', text: 'x' }] }] });
    const b = await r.call('chat', { system: 's', messages: [{ role: 'user', content: [{ type: 'text', text: 'x' }] }] });
    assert.strictEqual(a.content[0].text, '요약');
    assert.strictEqual(b.content[0].text, '대화');
    assert.strictEqual(f.calls[0].url, 'https://openrouter.ai/api/v1/chat/completions');
    assert.strictEqual(f.calls[0].opts.headers.authorization, 'Bearer or');
  });

  await t('OpenAI 형식 변환(도구 호출·결과·이미지)', async () => {
    const msgs = toOpenAIMessages('SYS', [
      { role: 'user', content: [{ type: 'text', text: '목표' }, { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'AAA' } }] },
      { role: 'assistant', content: [{ type: 'thinking', thinking: '…' }, { type: 'text', text: '누를게요' }, { type: 'tool_use', id: 'c1', name: 'click', input: { id: 3 } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'c1', content: [{ type: 'text', text: '결과' }, { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'BBB' } }] }] }
    ]);
    assert.strictEqual(msgs[0].role, 'system');
    assert.strictEqual(msgs[1].content[1].image_url.url, 'data:image/jpeg;base64,AAA');
    assert.strictEqual(msgs[2].tool_calls[0].function.arguments, '{"id":3}');
    assert.ok(!JSON.stringify(msgs[2]).includes('thinking'));
    assert.strictEqual(msgs[3].role, 'tool');
    assert.strictEqual(msgs[3].content, '결과');
    assert.strictEqual(msgs[4].role, 'user'); // 도구 결과 이미지는 다음 user 메시지로
  });

  await t('OpenAI 응답의 도구 호출 해석', async () => {
    const cfg = clone(DEFAULTS); cfg.providers.openai.apiKey = 'k';
    cfg.roles.agent = { label: '작업', provider: 'openai', model: 'gpt-x' };
    const f = fakeFetch(() => ({ status: 200, body: { choices: [{ message: { content: null, tool_calls: [{ id: 'z', function: { name: 'navigate', arguments: '{"url":"naver.com"}' } }] } }] } }));
    const res = await new ModelRouter(() => cfg, f).call('agent', { system: 's', messages: [{ role: 'user', content: 'x' }], tools: TOOLS });
    assert.strictEqual(res.stopReason, 'tool_use');
    assert.deepStrictEqual(res.content[0], { type: 'tool_use', id: 'z', name: 'navigate', input: { url: 'naver.com' } });
    assert.strictEqual(f.calls[0].body.tools[0].type, 'function');
  });

  await t('키 없으면 한국어 안내', async () => {
    const r = new ModelRouter(() => clone(DEFAULTS), fakeFetch(() => ({ status: 200, body: {} })));
    await assert.rejects(r.call('chat', { messages: [] }), /API 키가 없습니다/);
  });

  await t('401 오류 → 이해하기 쉬운 메시지, 재시도 안 함', async () => {
    const cfg = clone(DEFAULTS); cfg.providers.anthropic.apiKey = 'bad';
    const f = fakeFetch(() => ({ status: 401, body: { error: { type: 'authentication_error', message: 'invalid x-api-key' } } }));
    await assert.rejects(new ModelRouter(() => cfg, f).call('chat', { messages: [] }), /API 키가 틀렸거나 만료/);
    assert.strictEqual(f.calls.length, 1);
  });

  await t('429/529 과부하는 자동 재시도 후 성공', async () => {
    const cfg = clone(DEFAULTS); cfg.providers.anthropic.apiKey = 'k';
    const f = fakeFetch((u, b, n) => n < 2 ? { status: 529, body: { error: { message: 'overloaded' } } } : { status: 200, body: { content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', usage: {} } });
    const res = await new ModelRouter(() => cfg, f).call('chat', { messages: [] });
    assert.strictEqual(res.content[0].text, 'ok');
    assert.strictEqual(f.calls.length, 2);
  });

  await t('Jev 를 대화 부문에 배정하면 안내', async () => {
    const cfg = clone(DEFAULTS); cfg.providers.typesafe.apiKey = 'x';
    cfg.roles.chat = { label: '대화', provider: 'typesafe', model: 'jev-latest' };
    await assert.rejects(new ModelRouter(() => cfg, fakeFetch(() => ({}))).call('chat', { messages: [] }), /판단/);
  });

  await t('Jev 판단 요청 형식·응답 해석·비용', async () => {
    const cfg = clone(DEFAULTS); cfg.providers.typesafe.apiKey = 'apikey_test';
    const f = fakeFetch(() => ({ status: 200, body: { model: 'jev-1.13.0', answers: { op: { type: 'choice', choice: 'click', confidence: 0.92, probabilities: { click: 0.92 } } }, usage: { input_tokens: 3000, output_tokens: 20 } } }));
    const r = new ModelRouter(() => cfg, f);
    const res = await r.call('decide', { state: 'S', questions: { op: { type: 'choice', instructions: 'q', criteria: { click: 'a', unsure: 'b' } } } });
    assert.strictEqual(f.calls[0].url, 'https://api.typesafe.ai/v1/systemone');
    assert.strictEqual(f.calls[0].opts.headers.authorization, 'Bearer apikey_test');
    assert.strictEqual(f.calls[0].body.model, 'jev-latest');
    assert.strictEqual(res.answers.op.choice, 'click');
    assert.ok(Math.abs(res.costUsd - 3000 * 0.042 / 1e6) < 1e-12);
    assert.ok(r.available('decide'));
  });

  await t('Haiku 4.5 에는 effort 를 보내지 않음, 캐시 사용량 해석', async () => {
    const cfg = clone(DEFAULTS); cfg.providers.anthropic.apiKey = 'k';
    const f = fakeFetch(() => ({ status: 200, body: { content: [{ type: 'text', text: '요약' }], stop_reason: 'end_turn', usage: { input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 2000, cache_read_input_tokens: 0 } } }));
    const res = await new ModelRouter(() => cfg, f).call('summarize', { system: 's', messages: [{ role: 'user', content: 'x' }] });
    assert.ok(!f.calls[0].body.output_config);
    assert.strictEqual(f.calls[0].body.model, 'claude-haiku-4-5-20251001');
    assert.strictEqual(res.usage.cacheWrite, 2000);
    assert.ok(Math.abs(res.costUsd - (100 * 1 + 50 * 5 + 2000 * 1.25) / 1e6) < 1e-12);
  });

  await t('단가표: Opus 캐시 읽기·모르는 모델', () => {
    assert.ok(Math.abs(costUsd('claude-opus-5-5', { input: 1e6, output: 0, cacheRead: 1e6 }) - 4.2) < 1e-9);
    assert.strictEqual(costUsd('mystery-model', { input: 10 }), null);
    assert.strictEqual(costUsd('gemini-3.8-flash', { input: 1e6, output: 1e6 }), 4.5);
    assert.strictEqual(costUsd('gemini-3.5-flash-lite', { input: 1e6 }), 0.3);
  });

  await t('키 파일 해석 (섹션 제목·빈 줄 섞여도)', () => {
    const txt = '** Anthropic **\n\nsk-ant-api03-' + 'a'.repeat(90) + '\n\n** Gemini **\nAQ.Ab8RN' + 'b'.repeat(40) + '\n** TypeSafe **\n\napikey_' + 'c'.repeat(40) + '\n';
    const k = parseKeyFile(txt);
    assert.deepStrictEqual(Object.keys(k).sort(), ['anthropic', 'gemini', 'typesafe']);
    assert.deepStrictEqual(parseKeyFile('hello world'), {});
  });

  await t('0.1 설정 → 0.2 자동 이전 (키 유지, 배정은 새 기본값)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cfg-'));
    fs.writeFileSync(path.join(dir, 'jeeves-config.json'), JSON.stringify({ version: 1,
      providers: { anthropic: { apiKey: 'sk-ant-keep' }, typesafe: { disabled: true } },
      roles: { chat: { provider: 'anthropic', model: 'claude-opus-5-5' }, title: { provider: 'anthropic', model: 'claude-opus-5-5' } },
      agent: { useScreenshots: true }, ui: { homepage: 'https://naver.com' } }));
    const c = new ConfigStore(dir, null).get();
    assert.strictEqual(c.providers.anthropic.apiKey, 'sk-ant-keep');
    assert.strictEqual(c.roles.chat.model, 'claude-sonnet-5-5');
    assert.ok(!c.roles.title);
    assert.ok(!c.providers.typesafe.disabled);
    assert.strictEqual(c.ui.homepage, 'https://naver.com');
    assert.strictEqual(c.version, DEFAULTS.version);
  });

  await t('설정 화면의 가린 키(●●●●…끝4자리)를 그대로 저장해도 기존 키 유지', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cfg-'));
    const store = new ConfigStore(dir, null);
    store.update({ providers: { anthropic: { apiKey: 'sk-ant-secret-1234' } } });
    assert.strictEqual(store.get().providers.anthropic.apiKey, 'sk-ant-secret-1234');
    store.update({ providers: { anthropic: { apiKey: '●●●●●●●●●●●●●●' } } });   // 새 표시 형식
    assert.strictEqual(store.get().providers.anthropic.apiKey, 'sk-ant-secret-1234');
    store.update({ providers: { anthropic: { apiKey: '••••1234' } } });         // 기존 형식
    assert.strictEqual(store.get().providers.anthropic.apiKey, 'sk-ant-secret-1234');
    const pub = store.getPublic().providers.anthropic;
    assert.strictEqual(pub.hasKey, true);
    assert.ok(!pub.apiKey.includes('secret'));
    assert.ok(!pub.apiKey.includes('1234'), '끝자리도 화면으로 보내면 안 됨');
  });

  await t('Ollama(로컬)는 키 없이 허용', async () => {
    const cfg = clone(DEFAULTS); cfg.providers.ollama.apiKey = '';
    cfg.roles.chat = { label: '대화', provider: 'ollama', model: 'llama3.1' };
    const f = fakeFetch(() => ({ status: 200, body: { choices: [{ message: { content: 'hi' } }] } }));
    const res = await new ModelRouter(() => cfg, f).call('chat', { messages: [{ role: 'user', content: 'x' }] });
    assert.strictEqual(res.content[0].text, 'hi');
    assert.ok(!f.calls[0].opts.headers.authorization);
  });

  await t('관찰 정보 서식(민감칸·항목·자료 구분 태그)', () => {
    const txt = formatObservation({ title: 'T', url: 'https://x', scroll: { y: 0, max: 100 }, frames: 1, hasPassword: true, textLength: 10, text: '본문',
      elements: [{ id: 1, kind: 'input:password', name: '비밀번호', sensitive: true, value: '' }, { id: 2, kind: 'select', name: '지역', options: ['서울', '부산'], value: '서울' }] });
    assert.ok(txt.includes('⚠민감정보칸'));
    assert.ok(txt.includes('항목:[서울 | 부산]'));
    assert.ok(txt.includes('<page_text>'));
    assert.ok(txt.includes('비밀번호 칸 있음'));
  });

  await t('구독 엔진: 한도 문구·로그인 문구·재개 시각 해석', () => {
    const { parseReset, isLimitText, isLoginText } = require('../src/main/cc-engine');
    const now = new Date('2026-10-05T10:00:00');
    assert.strictEqual(parseReset('Claude AI usage limit reached|1791195600').getTime(), 1791195600 * 1000);
    const d = parseReset("You've hit your limit · resets 3pm", now);
    assert.strictEqual(d.getHours(), 15); assert.strictEqual(d.getDate(), 5);
    const d2 = parseReset('limit reached, resets at 9:30am', now);
    assert.strictEqual(d2.getHours(), 9); assert.strictEqual(d2.getMinutes(), 30); assert.strictEqual(d2.getDate(), 6);
    assert.strictEqual(parseReset('알 수 없는 오류'), null);
    assert.ok(isLimitText('Claude AI usage limit reached|123'));
    assert.ok(isLimitText("You've hit your limit"));
    assert.ok(!isLimitText('Your credit balance is too low'));
    assert.ok(isLoginText('Not logged in · Please run /login'));
  });

  await t('구독 엔진: 한도에 걸리면 기다리지 않고 onLimit 로 자동 전환(가짜 claude)', async () => {
    const { ClaudeCodeTask } = require('../src/main/cc-engine');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-'));
    process.env.FAKE_LOG = path.join(dir, 'calls.log'); delete process.env.FAKE_MODE;
    let asked = 0;
    const task = new ClaudeCodeTask({ id: 2, goal: '공고 찾기', bin: path.join(__dirname, 'fixtures', 'fake-claude.js'), mcpUrl: 'http://127.0.0.1:1/mcp', mcpToken: 'tok', model: 'sonnet', workDir: dir, onLimit: () => { asked++; return true; } });
    const done = new Promise(r => task.on('finished', r));
    task.start();
    const res = await done;
    assert.strictEqual(asked, 1);
    assert.ok(res.switched && !res.success && /자동 전환/.test(res.summary), JSON.stringify(res));
    assert.strictEqual(fs.readFileSync(process.env.FAKE_LOG, 'utf8').trim().split('\n').length, 1);   // 대기·재개 없이 끝남
  });

  await t('구독 엔진: 한도 대기 → 자동 재개 → 완료 (가짜 claude)', async () => {
    const { ClaudeCodeTask } = require('../src/main/cc-engine');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-'));
    const logf = path.join(dir, 'calls.log');
    process.env.FAKE_LOG = logf; delete process.env.FAKE_MODE;
    const task = new ClaudeCodeTask({ id: 1, goal: '공고 찾기', bin: path.join(__dirname, 'fixtures', 'fake-claude.js'), mcpUrl: 'http://127.0.0.1:1/mcp', mcpToken: 'tok', model: 'sonnet', workDir: dir, resetBufferMs: 0, minWaitMs: 200 });
    const ev = [];
    task.on('event', e => ev.push(e));
    const done = new Promise(r => task.on('finished', r));
    task.start();
    const res = await done;
    const calls = fs.readFileSync(logf, 'utf8').trim().split('\n').map(JSON.parse);
    assert.ok(res.success, JSON.stringify(res));
    assert.strictEqual(res.retries, 1);
    assert.ok(ev.some(e => e.type === 'limit') && ev.some(e => e.type === 'resume'));
    assert.strictEqual(calls.length, 2);
    assert.strictEqual(calls[0].stdin, '공고 찾기');
    const a0 = calls[0].args;
    assert.ok(a0.includes('-p') && a0.includes('stream-json') && a0.includes('--verbose'));
    assert.strictEqual(a0[a0.indexOf('--allowedTools') + 1], 'mcp__jeeves__*,ToolSearch');
    assert.ok(fs.readdirSync(path.join(dir, 'logs')).length >= 2, '진단 기록 파일');
    assert.strictEqual(a0[a0.indexOf('--permission-mode') + 1], 'dontAsk');
    assert.strictEqual(a0[a0.indexOf('--model') + 1], 'sonnet');
    assert.ok(!a0.includes('--resume'));
    assert.strictEqual(calls[1].args[calls[1].args.indexOf('--resume') + 1], 'sess-123');
    const mcpCfg = JSON.parse(fs.readFileSync(a0[a0.indexOf('--mcp-config') + 1], 'utf8'));
    assert.deepStrictEqual(mcpCfg.mcpServers.jeeves, { type: 'http', url: 'http://127.0.0.1:1/mcp', headers: { Authorization: 'Bearer tok' } });
    // Jeeves 은 Claude 로그인 정보를 넘기지 않는다
    assert.ok(!JSON.stringify(calls).match(/oauth|session_token|credentials/i));
  });

  await t('구독 엔진: 로그인 안 됨 → 안내 후 종료', async () => {
    const { ClaudeCodeTask } = require('../src/main/cc-engine');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-'));
    process.env.FAKE_LOG = path.join(dir, 'c.log'); process.env.FAKE_MODE = 'login';
    const task = new ClaudeCodeTask({ id: 2, goal: 'x', bin: path.join(__dirname, 'fixtures', 'fake-claude.js'), mcpUrl: 'u', mcpToken: 't', workDir: dir });
    const done = new Promise(r => task.on('finished', r));
    task.start();
    const res = await done;
    delete process.env.FAKE_MODE;
    assert.ok(!res.success && /로그인/.test(res.summary), res.summary);
  });

  await t('크레딧 부족은 정확한 안내', async () => {
    const cfg = clone(DEFAULTS); cfg.providers.anthropic.apiKey = 'k';
    const f = fakeFetch(() => ({ status: 400, body: { error: { type: 'invalid_request_error', message: 'Your credit balance is too low to access the Anthropic API.' } } }));
    await assert.rejects(new ModelRouter(() => cfg, f).call('chat', { messages: [] }), /크레딧\(선불 잔액\) 부족/);
  });

  await t('도구 창구: 지브스가 띄운 일꾼 토큰은 항상 통과, 외부 에이전트 토큰은 "직접 접속 허용"을 켠 때만 통과', async () => {
    const http = require('http');
    const { JeevesMcpServer } = require('../src/main/mcp-server');
    const cfg = { mcp: { allowExternal: false } };
    const server = new JeevesMcpServer({ tabs: { list: () => [], get: () => null, active: () => null }, getConfig: () => cfg, router: { available: () => false }, approve: async () => ({ ok: false }), ask: async () => ({ text: '' }), activity: () => {} });
    const port = await server.start({ port: 0, token: 'external-token-abcdef', internalToken: 'internal-token-123456' });
    const status = tok => new Promise(res => {
      const r = http.request({ host: '127.0.0.1', port, path: '/mcp', method: 'GET', headers: { authorization: 'Bearer ' + tok } }, x => { x.resume(); res(x.statusCode); });
      r.end();
    });
    try {
      assert.notStrictEqual(await status('internal-token-123456'), 401);   // 405(GET 불가)는 인증 통과를 뜻함
      assert.strictEqual(await status('external-token-abcdef'), 401);       // 기본: 외부 직접 접속 차단
      cfg.mcp.allowExternal = true;
      assert.notStrictEqual(await status('external-token-abcdef'), 401);   // 사용자가 허용하면 통과
      assert.strictEqual(await status('wrong-token-xxxxxxxxxxx'), 401);
    } finally { server.stop(); }
  });

  // ── 자동 전환(한도·잔액 소진 시 다음 공급자로) ─────────────────
  const okOpenAI = { status: 200, body: { choices: [{ message: { content: '전환 성공' } }], usage: { prompt_tokens: 3, completion_tokens: 2 } } };
  const creditErr = { status: 400, body: { error: { message: 'Your credit balance is too low to access the Anthropic API.' } } };
  const msg1 = { system: 's', messages: [{ role: 'user', content: [{ type: 'text', text: 'x' }] }], infoGrade: 'I' };

  await t('자동 전환: 잔액 부족 공급자는 쉬게 하고 다음 공급자로 같은 요청을 보냄(다음 호출은 쉬는 곳을 건너뜀)', async () => {
    const c = clone(DEFAULTS); c.infoGrade = 'I'; c.providers.anthropic.apiKey = 'k'; c.providers.openai.apiKey = 'k2';
    c.providers.anthropic.maxGrade = 'I'; c.providers.openai.maxGrade = 'I';
    const f = fakeFetch(url => url.includes('anthropic') ? creditErr : okOpenAI);
    const notes = [];
    const r = new ModelRouter(() => c, f, () => 1000); r.onNotice = m => notes.push(m);
    const res1 = await r.call('chat', msg1);
    assert.strictEqual(res1.content[0].text, '전환 성공');
    assert.ok(res1.failover && /Anthropic.*잔액·한도 소진/.test(res1.failover[0]) && notes.length === 1);
    assert.ok(r.status().find(x => x.id === 'anthropic').resting);
    const before = f.calls.filter(x => x.url.includes('anthropic')).length;
    await r.call('chat', msg1);
    assert.strictEqual(f.calls.filter(x => x.url.includes('anthropic')).length, before);   // 쉬는 동안 다시 두드리지 않음
  });

  await t('자동 전환: 쉬는 시간이 지나면 다시 시도하고, 설정을 저장하면(충전 후) 바로 풀림', async () => {
    const c = clone(DEFAULTS); c.infoGrade = 'I'; c.providers.anthropic.apiKey = 'k'; c.providers.openai.apiKey = 'k2';
    c.providers.anthropic.maxGrade = 'I'; c.providers.openai.maxGrade = 'I';
    let now = 1000, fail = true;
    const f = fakeFetch(url => url.includes('anthropic') ? (fail ? creditErr : { status: 200, body: { content: [{ type: 'text', text: '복귀' }], stop_reason: 'end_turn', usage: {} } }) : okOpenAI);
    const r = new ModelRouter(() => c, f, () => now);
    await r.call('chat', msg1);
    fail = false;
    assert.strictEqual((await r.call('chat', msg1)).content[0].text, '전환 성공');   // 아직 쉬는 중
    now += 31 * 60e3;
    assert.strictEqual((await r.call('chat', msg1)).content[0].text, '복귀');         // 30분 뒤 복귀
    r.markCool('anthropic', Object.assign(new Error('x'), { kind: 'limit' }));
    r.clearCooldown();
    assert.ok(!r.status().find(x => x.id === 'anthropic').resting);
  });

  await t('자동 전환: 429 한도 초과도 전환, 형식 오류(400)는 전환하지 않고 그대로 알림, 끄면 전환 안 함', async () => {
    const c = clone(DEFAULTS); c.infoGrade = 'I'; c.providers.anthropic.apiKey = 'k'; c.providers.openai.apiKey = 'k2';
    c.providers.anthropic.maxGrade = 'I'; c.providers.openai.maxGrade = 'I';
    const f429 = fakeFetch(url => url.includes('anthropic') ? { status: 429, body: { error: { message: 'rate' } } } : okOpenAI);
    const r1 = new ModelRouter(() => c, f429, () => 1000);
    assert.strictEqual((await r1.call('chat', msg1)).content[0].text, '전환 성공');
    const f400 = fakeFetch(url => url.includes('anthropic') ? { status: 400, body: { error: { message: 'bad request shape' } } } : okOpenAI);
    await assert.rejects(new ModelRouter(() => c, f400, () => 1000).call('chat', msg1), /요청 형식 오류/);
    assert.ok(!f400.calls.some(x => x.url.includes('openai')));
    c.failover = false;
    await assert.rejects(new ModelRouter(() => c, fakeFetch(url => url.includes('anthropic') ? creditErr : okOpenAI), () => 1000).call('chat', msg1), /크레딧\(선불 잔액\) 부족/);
  });

  await t('자동 전환: 정보 등급 관문은 전환 중에도 유지(C 등급은 허용 안 된 공급자로 넘어가지 않음) / 전부 막히면 해결 안내', async () => {
    const c = clone(DEFAULTS); c.infoGrade = 'I'; c.providers.anthropic.apiKey = 'k'; c.providers.openai.apiKey = 'k2';
    c.providers.anthropic.maxGrade = 'C'; c.providers.openai.maxGrade = 'I';
    const f = fakeFetch(url => url.includes('anthropic') ? creditErr : okOpenAI);
    await assert.rejects(new ModelRouter(() => c, f, () => 1000).call('chat', { ...msg1, infoGrade: 'C' }), /크레딧\(선불 잔액\) 부족.*다른 공급자가 없어/);
    assert.ok(!f.calls.some(x => x.url.includes('openai')));
    const both = fakeFetch(() => creditErr);
    await assert.rejects(new ModelRouter(() => c, both, () => 1000).call('chat', msg1), /모두 막혔습니다/);
  });

  await t('자동 전환: freeOnly 는 무료 공급자만 시도', async () => {
    const c = clone(DEFAULTS); c.infoGrade = 'P'; c.providers.gemini.apiKey = 'k'; c.providers.openai.apiKey = 'k2';
    const f = fakeFetch(() => ({ status: 429, body: { error: { message: 'free quota' } } }));
    await assert.rejects(new ModelRouter(() => c, f, () => 1000).call('chat', { ...msg1, infoGrade: 'P', freeOnly: true }));
    assert.ok(!f.calls.some(x => x.url.includes('api.openai.com')));   // 무료가 막혀도 freeOnly 단계에서는 유료로 넘어가지 않음(구독 단계를 먼저 거치도록)
  });

  // ── 추천 배정 · 공급자 추가/삭제 · 유료/무료 ─────────────────
  const withKeys = (keys, tiers = {}) => { const c = clone(DEFAULTS); c.infoGrade = 'P'; /* 등급과 무관한 시험은 P(제한 없음)에서 시작 — 기본값은 I */ for (const [id, k] of Object.entries(keys)) c.providers[id].apiKey = k; for (const [id, tr] of Object.entries(tiers)) c.providers[id].tier = tr; return c; };

  await t('추천: 키가 없으면 추천 불가(null)', () => {
    const rec = recommendAll(withKeys({}));
    for (const v of Object.values(rec)) assert.strictEqual(v, null);
  });

  await t('추천: 무료(Gemini) 키가 있으면 대화·요약은 무료 모델, 고성능은 유료 공급자', () => {
    const c = withKeys({ anthropic: 'k1', gemini: 'k2', typesafe: 'k3' });
    assert.deepStrictEqual([recommendFor(c, 'chat').provider, recommendFor(c, 'chat').model, recommendFor(c, 'chat').tier], ['gemini', 'gemini-3.8-flash', 'free']);
    assert.strictEqual(recommendFor(c, 'summarize').model, 'gemini-3.5-flash-lite');
    assert.strictEqual(recommendFor(c, 'agentStrong').model, 'claude-opus-5-5');
    assert.strictEqual(recommendFor(c, 'decide').provider, 'typesafe');
  });

  await t('추천: "추천에서 제외"(off)한 공급자는 키가 있어도 추천되지 않고 다른 공급자로 대신함', () => {
    const c = withKeys({ anthropic: 'k1', gemini: 'k2' });
    c.providers.anthropic.off = true;
    const r = recommendFor(c, 'agentStrong');
    assert.strictEqual(r.provider, 'gemini');
    assert.ok(r.reason.includes('대신함'));
  });

  await t('추천: Gemini를 유료로 바꾸면 무료 우선이 사라지고 단가가 싼 쪽(Gemini 3.8 Flash $0.75/$3.75 < Sonnet $2/$10)이 선택됨', () => {
    const c = withKeys({ anthropic: 'k1', gemini: 'k2' }, { gemini: 'paid' });
    assert.strictEqual(recommendFor(c, 'chat').provider, 'gemini');
    assert.ok(recommendFor(c, 'chat').reason.includes('가장 저렴'));
  });

  await t('추천: OpenAI 키만 있으면 고성능=gpt-6-astra, 표준=gpt-6.1-sol, 경량=gpt-6-luna', () => {
    const c = withKeys({ openai: 'k' });
    assert.strictEqual(recommendFor(c, 'agentStrong').model, 'gpt-6-astra');
    assert.strictEqual(recommendFor(c, 'chat').model, 'gpt-6.1-sol');
    assert.strictEqual(recommendFor(c, 'summarize').model, 'gpt-6-luna');
    assert.strictEqual(recommendFor(c, 'decide'), null);
  });

  await t('추천: 같은 유료 등급이면 단가가 싼 공급자 선택(고성능은 Opus 5.5가 Astra보다 저렴, 경량은 Luna가 Haiku 4.5보다 저렴)', () => {
    const c = withKeys({ anthropic: 'k1', openai: 'k2' });
    assert.strictEqual(recommendFor(c, 'agentStrong').provider, 'anthropic');
    assert.strictEqual(recommendFor(c, 'summarize').provider, 'openai');
  });

  await t('추천: 제외(off)한 Anthropic 대신 OpenAI가 고성능 등급을 채움', () => {
    const c = withKeys({ anthropic: 'k1', openai: 'k2' });
    c.providers.anthropic.off = true;
    assert.strictEqual(recommendFor(c, 'agentStrong').model, 'gpt-6-astra');
  });

  await t('공급자: xAI Grok·Zhipu GLM 기본 등록(주소 확인값), Grok만 추천 후보, GLM은 직접 선택 전용', () => {
    assert.strictEqual(DEFAULTS.providers.xai.baseUrl, 'https://api.x.ai/v1');
    assert.strictEqual(DEFAULTS.providers.zai.baseUrl, 'https://api.z.ai/api/paas/v4');
    const c = withKeys({ xai: 'k', zai: 'k' });
    assert.strictEqual(recommendFor(c, 'chat').provider, 'xai');   // GLM은 카탈로그에 없어 자동 추천 안 됨
    assert.strictEqual(recommendFor(withKeys({ zai: 'k' }), 'chat'), null);
  });

  await t('단가표: grok-4.7·glm 비용 계산, GLM 무료 모델은 0원', () => {
    assert.ok(Math.abs(costUsd('grok-4.7', { input: 1e6, output: 1e6 }) - 8) < 1e-9);
    assert.ok(Math.abs(costUsd('glm-5.3', { input: 1e6, output: 1e6 }) - 5.8) < 1e-9);
    assert.strictEqual(costUsd('glm-4.7-flash', { input: 1e6, output: 1e6 }), 0);
  });

  await t('정보 등급: 공급자 자동 허용 등급(로컬 S / 유료 I / 무료 P), 직접 지정 우선', () => {
    const c = withKeys({ anthropic: 'k', gemini: 'k' });
    assert.strictEqual(effectiveMaxGrade(c.providers.ollama), 'S');
    assert.strictEqual(effectiveMaxGrade(c.providers.anthropic), 'I');
    assert.strictEqual(effectiveMaxGrade(c.providers.gemini), 'P');
    assert.strictEqual(effectiveMaxGrade(c.providers.zai), 'P');   // 중국계: 확인 전까지 공개만
    c.providers.anthropic.maxGrade = 'C';
    assert.strictEqual(effectiveMaxGrade(c.providers.anthropic), 'C');
    assert.ok(gradeOk(c.providers.anthropic, 'C') && !gradeOk(c.providers.anthropic, 'S'));
  });

  await t('정보 등급: I 이상이면 무료 Gemini는 추천에서 빠지고 유료로 넘어감, S면 키 있는 외부 공급자 모두 제외', () => {
    const c = withKeys({ anthropic: 'k', gemini: 'k' });
    c.infoGrade = 'P';
    assert.strictEqual(recommendFor(c, 'chat').provider, 'gemini');                 // P: 제한 없음(무료 우선)
    c.infoGrade = 'I';
    const r = recommendFor(c, 'chat');
    assert.strictEqual(r.provider, 'anthropic');
    assert.ok(r.reason.includes('정보 등급 I'));
    c.infoGrade = 'S';
    assert.strictEqual(recommendFor(c, 'chat'), null);
  });

  await t('정보 등급: 라우터가 등급에 맞지 않는 공급자(자동·직접)를 막고 한국어 오류를 냄', () => {
    const c = withKeys({ gemini: 'k' });
    c.infoGrade = 'I';
    const router = new ModelRouter(() => c, async () => { throw new Error('호출되면 안 됨'); });
    c.roles.chat.provider = 'gemini'; c.roles.chat.model = 'gemini-3.8-flash';   // 추천할 공급자가 없을 때의 저장 배정
    assert.throws(() => router.resolve('chat'), /정보 등급 I.*쓸 수 없습니다/);
    c.roles.chat.mode = 'manual'; c.roles.chat.provider = 'gemini'; c.roles.chat.model = 'gemini-3.8-flash';
    assert.throws(() => router.resolve('chat'), /정보 등급 I/);
    assert.doesNotThrow(() => router.resolve('chat', 'P'));   // 호출별로 등급을 낮춰 지정하면 허용
  });

  await t('정보 등급: 설정 저장은 올바른 등급 값만 받음', () => {
    const cs = new ConfigStore(fs.mkdtempSync(path.join(os.tmpdir(), 'cfg-')), null);
    cs.update({ infoGrade: 'C', providers: { gemini: { maxGrade: 'I' } } });
    assert.strictEqual(cs.data.infoGrade, 'C');
    assert.strictEqual(cs.data.providers.gemini.maxGrade, 'I');
    cs.update({ infoGrade: 'X', providers: { gemini: { maxGrade: 'auto' } } });
    assert.strictEqual(cs.data.infoGrade, 'C');
    assert.ok(!cs.data.providers.gemini.maxGrade);
  });

  await t('엔진 추천: Claude Code 설치 시 구독, 아니면 API', () => {
    assert.strictEqual(recommendEngine(true).type, 'claude-code');
    assert.strictEqual(recommendEngine(false).type, 'api');
  });

  await t('단가표: gpt-6 계열 비용 계산', () => {
    assert.ok(Math.abs(costUsd('gpt-6-astra', { input: 1e6, output: 1e6 }) - 60) < 1e-9);
    assert.ok(Math.abs(costUsd('gpt-6-luna', { input: 1e6, output: 1e6 }) - 0.6) < 1e-9);
  });

  await t('추천: 고성능 등급 공급자 키가 없으면 표준 등급으로 대신하고 이유를 알림', () => {
    const r = recommendFor(withKeys({ gemini: 'k' }), 'agentStrong');
    assert.strictEqual(r.model, 'gemini-3.8-flash');
    assert.ok(/대신함/.test(r.reason));
  });

  await t('라우터: 추천 모드는 무료 Gemini로 보내고 비용 0원, 직접 모드는 저장된 배정을 씀', async () => {
    const cfg = withKeys({ anthropic: 'ka', gemini: 'kg' });
    const f = fakeFetch(() => ({ status: 200, body: { choices: [{ message: { content: 'hi' } }], usage: { prompt_tokens: 1000, completion_tokens: 500 } } }));
    const r = new ModelRouter(() => cfg, f);
    const res = await r.call('chat', { messages: [{ role: 'user', content: [{ type: 'text', text: 'x' }] }] });
    assert.ok(/generativelanguage\.googleapis\.com/.test(f.calls[0].url));
    assert.strictEqual(f.calls[0].body.model, 'gemini-3.8-flash');
    assert.strictEqual(res.costUsd, 0);                       // 무료 공급자는 0원
    cfg.roles.chat = { ...cfg.roles.chat, mode: 'manual', provider: 'anthropic', model: 'claude-sonnet-5-5' };
    const f2 = fakeFetch(() => ({ status: 200, body: { content: [{ type: 'text', text: 'OK' }], stop_reason: 'end_turn', usage: { input_tokens: 5, output_tokens: 1 } } }));
    await new ModelRouter(() => cfg, f2).call('chat', { messages: [{ role: 'user', content: [{ type: 'text', text: 'x' }] }] });
    assert.strictEqual(f2.calls[0].url, 'https://api.anthropic.com/v1/messages');
  });

  await t('라우터: 유료로 표시하면 단가표로 비용 계산', async () => {
    const cfg = withKeys({ gemini: 'kg' }, { gemini: 'paid' });
    const f = fakeFetch(() => ({ status: 200, body: { choices: [{ message: { content: 'hi' } }], usage: { prompt_tokens: 1000000, completion_tokens: 0 } } }));
    const res = await new ModelRouter(() => cfg, f).call('chat', { messages: [{ role: 'user', content: [{ type: 'text', text: 'x' }] }] });
    assert.strictEqual(res.costUsd, 0.75);                    // gemini-3.8-flash 입력 0.75달러/100만 토큰
  });

  await t('공급자 추가: 검증(https 필수·로컬만 http)과 고유 id', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cfg-'));
    const s = new ConfigStore(dir, null);
    assert.throws(() => s.addProvider({ label: '', type: 'openai', baseUrl: 'https://x.example/v1' }), /이름/);
    assert.throws(() => s.addProvider({ label: 'A', type: 'jev', baseUrl: 'https://x.example/v1' }), /통신 방식/);
    assert.throws(() => s.addProvider({ label: 'A', type: 'openai', baseUrl: 'http://evil.example/v1' }), /https/);
    const a = s.addProvider({ label: 'My AI', type: 'openai', baseUrl: 'https://ai.example.com/v1/', tier: 'free', apiKey: 'k-123' });
    const b = s.addProvider({ label: 'My AI', type: 'openai', baseUrl: 'http://localhost:1234/v1' });
    assert.notStrictEqual(a.id, b.id);
    const p = s.get().providers[a.id];
    assert.deepStrictEqual([p.tier, p.baseUrl, p.apiKey, p.custom], ['free', 'https://ai.example.com/v1', 'k-123', true]);
    assert.strictEqual(s.get().providers[b.id].tier, 'paid');         // 기본은 유료(보수적)
    assert.ok(!JSON.stringify(a.config).includes('k-123'));           // 화면 값에 키 없음
  });

  await t('공급자 삭제: 다시 불러와도 되살아나지 않음, 부문은 추천으로, 복원 가능', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cfg-'));
    const s = new ConfigStore(dir, null);
    s.update({ roles: { chat: { mode: 'manual', provider: 'openai', model: 'x' } } });
    s.removeProvider('openai'); s.removeProvider('openrouter');
    assert.ok(!s.get().providers.openai);
    assert.strictEqual(s.get().roles.chat.mode, 'auto');
    const s2 = new ConfigStore(dir, null);                            // 다시 불러오기
    assert.ok(!s2.get().providers.openai && !s2.get().providers.openrouter);
    assert.ok(s2.get().providers.gemini);
    s2.restoreProviders();
    assert.ok(s2.get().providers.openai && s2.get().providers.openrouter);
    assert.deepStrictEqual(s2.get().removedProviders, []);
    assert.throws(() => s2.removeProvider('nope'), /없는 공급자/);
  });

  await t('설정 갱신: 모르는 공급자·부문은 무시하고 유형·모드만 바뀜', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cfg-'));
    const s = new ConfigStore(dir, null);
    s.update({ providers: { hacker: { type: 'openai', baseUrl: 'http://evil', apiKey: 'x' }, gemini: { tier: 'paid', type: 'jev', label: 'X' } }, roles: { ghost: { provider: 'gemini' }, chat: { mode: 'manual', label: 'Z' } } });
    assert.ok(!s.get().providers.hacker && !s.get().roles.ghost);
    assert.strictEqual(s.get().providers.gemini.tier, 'paid');
    assert.strictEqual(s.get().providers.gemini.type, 'openai');       // type·label 은 화면에서 못 바꿈
    assert.strictEqual(s.get().roles.chat.mode, 'manual');
    assert.notStrictEqual(s.get().roles.chat.label, 'Z');
    s.update({ providers: { gemini: { tier: 'bogus' } } });
    assert.strictEqual(s.get().providers.gemini.tier, 'paid');         // 잘못된 값은 무시
  });

  await t('설정 2 → 3 이전: 키·직접 배정·안전 설정을 그대로 유지하고 추천 모드/유형은 기본값 추가', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cfg-'));
    fs.writeFileSync(path.join(dir, 'jeeves-config.json'), JSON.stringify({ version: 2,
      providers: { anthropic: { apiKey: 'sk-ant-keep' } },
      roles: { chat: { provider: 'anthropic', model: 'claude-opus-5-5', mode: 'manual' } },
      agent: { maxSteps: 12 } }));
    const c = new ConfigStore(dir, null).get();
    assert.strictEqual(c.version, 3);
    assert.strictEqual(c.agent.maxSteps, 12);
    assert.strictEqual(c.roles.chat.model, 'claude-opus-5-5');
    assert.strictEqual(c.roles.chat.mode, 'manual');
    assert.strictEqual(c.roles.agent.mode, 'auto');
    assert.strictEqual(c.providers.anthropic.apiKey, 'sk-ant-keep');
    assert.strictEqual(c.providers.gemini.tier, 'free');
  });

  await t('정보 등급 0.24: 새 설정의 시작 등급은 I, 예전에 저장된 P 는 한 번만 I 로 올리고 이후 사용자가 고른 값은 유지', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cfg-'));
    assert.strictEqual(new ConfigStore(dir, null).get().infoGrade, 'I');
    const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'cfg-'));
    fs.writeFileSync(path.join(dir2, 'jeeves-config.json'), JSON.stringify({ version: 3, infoGrade: 'P' }));
    const cs = new ConfigStore(dir2, null);
    assert.strictEqual(cs.get().infoGrade, 'I');
    cs.update({ infoGrade: 'P' });                                   // 사용자가 직접 P 를 고름
    assert.strictEqual(new ConfigStore(dir2, null).get().infoGrade, 'P');
  });

  await t('구독 엔진 검문소: 기본 I 까지 허용, C 는 허용 등급을 올린 때만, S 는 항상 차단', () => {
    const cfg = clone(DEFAULTS);
    assert.strictEqual(engineMaxGrade(cfg), 'I');
    assert.ok(engineGradeOk(cfg, 'P') && engineGradeOk(cfg, 'I'));
    assert.ok(!engineGradeOk(cfg, 'C') && !engineGradeOk(cfg, 'S'));
    cfg.engine.maxGrade = 'C';
    assert.ok(engineGradeOk(cfg, 'C') && !engineGradeOk(cfg, 'S'));
    cfg.engine.maxGrade = 'S';                                      // 잘못된 값은 기본 I 로 취급
    assert.strictEqual(engineMaxGrade(cfg), 'I');
    const cs = new ConfigStore(fs.mkdtempSync(path.join(os.tmpdir(), 'cfg-')), null);
    cs.update({ engine: { maxGrade: 'S' } });
    assert.strictEqual(cs.data.engine.maxGrade, 'I');               // 저장 단계에서 S 는 거부
    cs.update({ engine: { maxGrade: 'C' } });
    assert.strictEqual(cs.data.engine.maxGrade, 'C');
  });

  await t('민감어 경고: 비밀·기밀로 보이는 글은 상위 등급을 제안만 함(자동 변경 없음)', () => {
    assert.strictEqual(suspectGrade('로그인 비밀번호 알려줘'), 'S');
    assert.strictEqual(suspectGrade('주민번호 900101-1234567'), 'S');
    assert.strictEqual(suspectGrade('이 계약서 단가 검토해 줘'), 'C');
    assert.strictEqual(suspectGrade('대외비 자료 요약'), 'C');
    assert.strictEqual(suspectGrade('오늘 날씨 알려줘'), null);
  });

  await t('Kimi·DeepSeek: 기본 공급자로 존재, P 전용, 추천 대상 아님(직접 선택만)', () => {
    const c = withKeys({ moonshot: 'k', deepseek: 'k', anthropic: 'k' });
    assert.strictEqual(effectiveMaxGrade(c.providers.moonshot), 'P');
    assert.strictEqual(effectiveMaxGrade(c.providers.deepseek), 'P');
    c.infoGrade = 'P';
    for (const role of Object.keys(c.roles)) {
      const r = recommendFor(c, role);
      assert.ok(!r || (r.provider !== 'moonshot' && r.provider !== 'deepseek'));
    }
    const router = new ModelRouter(() => c, async () => { throw new Error('호출되면 안 됨'); });
    c.roles.chat.mode = 'manual'; c.roles.chat.provider = 'deepseek'; c.roles.chat.model = 'deepseek-v4.1-flash';
    assert.doesNotThrow(() => router.resolve('chat', 'P'));
    assert.throws(() => router.resolve('chat', 'I'), /정보 등급 I.*쓸 수 없습니다/);
  });

  await t('호출별 등급: 라우터 call 이 req.infoGrade 로 관문을 적용(작업·대화 단위)', async () => {
    const c = withKeys({ gemini: 'k' });
    c.infoGrade = 'P';
    c.roles.chat.mode = 'manual'; c.roles.chat.provider = 'gemini'; c.roles.chat.model = 'gemini-3.8-flash';
    const f = fakeFetch(() => ({ status: 200, body: { choices: [{ message: { content: 'OK' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } } }));
    const router = new ModelRouter(() => c, f);
    await router.call('chat', { system: 's', messages: [{ role: 'user', content: [{ type: 'text', text: 'x' }] }], maxTokens: 10, infoGrade: 'P' });
    await assert.rejects(() => router.call('chat', { system: 's', messages: [{ role: 'user', content: [{ type: 'text', text: 'x' }] }], maxTokens: 10, infoGrade: 'C' }), /정보 등급 C/);
    assert.strictEqual(f.calls.length, 1);                          // 막힌 호출은 외부로 나가지 않음
  });

  await t('경고 근거: 걸린 단어를 알려 주고 키·번호 형태의 값은 가려서 보여 줌', () => {
    const d = suspectDetail('이 계약서 단가와 비밀번호, sk-abcdefghijklmnopqrstuvwx 검토');
    assert.strictEqual(d.grade, 'S');
    assert.ok(d.hits.includes('계약서') && d.hits.includes('단가') && d.hits.includes('비밀번호'));
    assert.ok(!d.hits.some(h => h.startsWith('sk-')));
    assert.deepStrictEqual(suspectDetail('오늘 날씨'), { grade: null, hits: [] });
  });

  await t('실시간 질문 감지: 날씨·시세·검색 요청은 작업 모드 안내, 일반 질문은 그대로', () => {
    for (const q of ['오늘 하루 날씨가 어때?', '지금 환율 얼마야', '최신 뉴스 알려줘', '삼성전자 주가', '이거 검색해 줘']) assert.ok(needsLiveInfo(q), q);
    for (const q of ['이 글을 요약해 줘', '누설전류가 뭐야?', '메일 초안 써 줘']) assert.ok(!needsLiveInfo(q), q);
  });

  await t('자동 배정: 추천할 공급자가 없을 때 "추천에서 제외"한 공급자로는 가지 않고 해결 방법을 안내', () => {
    const c = withKeys({ anthropic: 'k', gemini: 'k' });
    c.infoGrade = 'I'; c.providers.anthropic.off = true;           // 잔액 없는 Anthropic 제외 + Gemini 무료는 P까지
    const router = new ModelRouter(() => c, async () => { throw new Error('호출되면 안 됨'); });
    assert.throws(() => router.resolve('chat'), /지금 쓸 수 있는 공급자가 없습니다.*시작 등급을 P/);
    assert.doesNotThrow(() => router.resolve('chat', 'P'));        // P 로 낮추면 무료 Gemini 사용
  });

  await t('민감어: 전화번호·이메일은 C 로 경고', () => {
    assert.strictEqual(suspectGrade('01027561900'), 'C');
    assert.strictEqual(suspectGrade('010-1234-5678 누구야'), 'C');
    assert.strictEqual(suspectGrade('a.b@example.com 확인'), 'C');
  });

  await t('구독으로 질문·요약: 도구 없이 글만 주고받음(성공 / 한도 / 로그인 안 됨 안내)', async () => {
    const { runClaudeChat } = require('../src/main/cc-engine');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-'));
    const bin = path.join(__dirname, 'fixtures', 'fake-claude.js');
    process.env.FAKE_LOG = path.join(dir, 'c.log');
    process.env.FAKE_MODE = 'chat';
    const ok = await runClaudeChat({ bin, model: 'haiku', system: '규칙', prompt: '질문입니다', workDir: dir });
    assert.strictEqual(ok.text, '구독으로 답했습니다');
    const call = JSON.parse(fs.readFileSync(process.env.FAKE_LOG, 'utf8').trim().split('\n')[0]);
    assert.strictEqual(call.stdin, '질문입니다');
    assert.strictEqual(call.args[call.args.indexOf('--allowedTools') + 1], 'ToolSearch');   // 웹 조작(MCP)·파일·명령 도구 없음
    assert.ok(!call.args.includes('--mcp-config'));
    assert.strictEqual(call.args[call.args.indexOf('--permission-mode') + 1], 'dontAsk');
    assert.strictEqual(call.args[call.args.indexOf('--model') + 1], 'haiku');
    await runClaudeChat({ bin, system: '규칙', prompt: '날씨', workDir: dir, web: true });
    const call2 = JSON.parse(fs.readFileSync(process.env.FAKE_LOG, 'utf8').trim().split('\n').pop());
    assert.strictEqual(call2.args[call2.args.indexOf('--allowedTools') + 1], 'ToolSearch,WebSearch,WebFetch');   // 대화 모드: 읽기 전용 웹 검색·읽기만 추가
    assert.ok(!/Bash|Edit|Write|mcp__/.test(call2.args[call2.args.indexOf('--allowedTools') + 1]));
    await runClaudeChat({ bin, system: '규칙', prompt: '사진', workDir: dir, web: true, readScope: 'jeeves-attach' });
    const call3 = JSON.parse(fs.readFileSync(process.env.FAKE_LOG, 'utf8').trim().split('\n').pop());
    assert.strictEqual(call3.args[call3.args.indexOf('--allowedTools') + 1], 'ToolSearch,WebSearch,WebFetch,Read(./jeeves-attach/**)');   // 사진 첨부: 첨부 폴더만 읽기 허용
    process.env.FAKE_MODE = 'limit';
    await assert.rejects(() => runClaudeChat({ bin, system: '', prompt: 'x', workDir: dir }), e => e.kind === 'limit' && /한도/.test(e.message));
    process.env.FAKE_MODE = 'login';
    await assert.rejects(() => runClaudeChat({ bin, system: '', prompt: 'x', workDir: dir }), e => e.kind === 'login' && /로그인/.test(e.message));
    delete process.env.FAKE_MODE;
  });

  let fail = 0;
  for (const [ok, name, err] of results) { if (!ok) fail++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '  → ' + err}`); }
  console.log(`\n${results.length - fail}/${results.length} 통과`);
  process.exit(fail ? 1 : 0);
})();

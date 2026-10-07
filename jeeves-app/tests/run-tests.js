// 모델 계층 단위 테스트 (네트워크 없이 가짜 fetch 사용)
const assert = require('assert');
const { ModelRouter } = require('../src/models/router');
const { toOpenAIMessages } = require('../src/models/providers');
const { DEFAULTS, ConfigStore, parseKeyFile } = require('../src/main/config');
const { costUsd } = require('../src/models/pricing');
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
    assert.strictEqual(c.version, 2);
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
  let fail = 0;
  for (const [ok, name, err] of results) { if (!ok) fail++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '  → ' + err}`); }
  console.log(`\n${results.length - fail}/${results.length} 통과`);
  process.exit(fail ? 1 : 0);
})();

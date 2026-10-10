// 정책 엔진 통합 시험: 브라우저 에이전트(AgentTask)·외부 에이전트(MCP)·모델 라우터에 정책이 실제로 걸리는지.
// 가짜 조작기·가짜 라우터만 쓴다(Electron·네트워크 없음).
const assert = require('assert');
const fs = require('fs'), os = require('os'), path = require('path');
const { AgentTask } = require('../src/agent/agent');
const { JeevesMcpServer } = require('../src/main/mcp-server');
const { ModelRouter } = require('../src/models/router');
const { DEFAULTS } = require('../src/main/config');
const { PolicyEngine } = require('../src/policy/engine');
const { AuditLog } = require('../src/policy/audit');
const { CostLedger } = require('../src/policy/ledger');
const { KillSwitch } = require('../src/policy/kill-switch');
const { DelegationStore } = require('../src/policy/delegation');

const results = [];
const t = async (name, fn) => { try { await fn(); results.push([true, name]); } catch (e) { results.push([false, name, e.message]); } };
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'poli-'));
const NAMES = ['다음', '보내기', '결제하기', '비밀번호'];
const snap = () => ({ url: 'https://shop.example.com/cart', title: '장바구니', hasPassword: false,
  elements: NAMES.map((n, i) => ({ id: i + 1, name: n, kind: n === '비밀번호' ? 'input:password' : 'button', sensitive: n === '비밀번호' })) });
const fakeDriver = () => { const d = { clicks: [], lastSnapshot: snap(), click: async id => { d.clicks.push(id); return { ok: true, message: '클릭함' }; }, typeText: async () => ({ ok: true, message: '입력함' }) }; return d; };
const mkPolicy = () => {
  const dir = tmp();
  const audit = new AuditLog({ dir: path.join(dir, 'audit') });
  const delegation = new DelegationStore({ file: path.join(dir, 'rules.json') });
  const killSwitch = new KillSwitch();
  return { audit, delegation, killSwitch, policy: new PolicyEngine({ audit, delegation, killSwitch }) };
};
const today = () => { const d = new Date(), p = n => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; };
const mkTask = (policy, driver) => { const task = new AgentTask({ id: 7, goal: 'g', driver, router: {}, policy, settings: { confirmMode: 'risky' } }); const evs = []; task.on('event', e => evs.push(e)); return { task, evs }; };

(async () => {
  await t('에이전트: R1 클릭은 바로 실행 + 감사 기록 auto', async () => {
    const { policy, audit } = mkPolicy(); const drv = fakeDriver(); const { task } = mkTask(policy, drv);
    const r = await task.guardedAction('click', { id: 1 }, 'agent');
    assert.ok(r.ok); assert.deepStrictEqual(drv.clicks, [1]);
    const a = audit.readDay(today()); assert.strictEqual(a.length, 1); assert.strictEqual(a[0].decision, 'auto'); assert.strictEqual(a[0].level, 'R1');
  });
  await t('에이전트: R2 는 확인(level 표시) → 허용하면 실행·approved / 거절하면 실행 0회·refused', async () => {
    const { policy, audit } = mkPolicy(); const drv = fakeDriver(); const { task, evs } = mkTask(policy, drv);
    const p1 = task.guardedAction('click', { id: 2 }, 'agent');
    await new Promise(r => setImmediate(r));
    const c = evs.find(e => e.type === 'confirm'); assert.ok(c && c.level === 'R2');
    task.respond({ ok: true }); assert.ok((await p1).ok);
    const p2 = task.guardedAction('click', { id: 2 }, 'agent'); await new Promise(r => setImmediate(r));
    task.respond({ ok: false }); const r2 = await p2;
    assert.ok(r2.refused); assert.deepStrictEqual(drv.clicks, [2]);
    assert.deepStrictEqual(audit.readDay(today()).map(x => x.decision), ['approved', 'refused']);
  });
  await t('에이전트: R3 결제는 규칙 없으면 차단(실행 0회, ask_user 안내) / 위임 규칙 있으면 자동 실행', async () => {
    const { policy, delegation } = mkPolicy(); const drv = fakeDriver(); const { task } = mkTask(policy, drv);
    const r = await task.guardedAction('click', { id: 3 }, 'agent');
    assert.ok(r.blocked && /ask_user/.test(r.message)); assert.strictEqual(drv.clicks.length, 0);
    const exp = new Date(Date.now() + 7 * 864e5).toISOString();
    delegation.add({ actions: ['click'], maxLevel: 'R3', sites: ['example.com'], maxCount: 1, expiresAt: exp, note: '시험 결제' }, { source: 'ui' });
    const r2 = await task.guardedAction('click', { id: 3 }, 'agent');
    assert.ok(r2.ok); assert.deepStrictEqual(drv.clicks, [3]);
    assert.ok((await task.guardedAction('click', { id: 3 }, 'agent')).blocked, '횟수 한도 소진 후 다시 차단');
  });
  await t('에이전트: 민감정보 칸 입력은 위임 규칙이 있어도 차단, 입력값은 감사 기록에 없음', async () => {
    const { policy, delegation, audit } = mkPolicy(); const drv = fakeDriver(); const { task } = mkTask(policy, drv);
    delegation.add({ actions: ['type_text'], maxLevel: 'R3', sites: ['example.com'], maxCount: 9, expiresAt: new Date(Date.now() + 864e5).toISOString() }, { source: 'ui' });
    const r = await task.guardedAction('type_text', { id: 4, text: 'TopSecret!9' }, 'agent');
    assert.ok(r.blocked);
    assert.ok(!fs.readFileSync(audit.fileFor(new Date()), 'utf8').includes('TopSecret'));
  });
  await t('에이전트: 비상 정지 후에는 실행 0회, 확인 대기 중 정지되면 허용해도 실행 안 함', async () => {
    const { policy, killSwitch } = mkPolicy(); const drv = fakeDriver(); const { task } = mkTask(policy, drv);
    const p = task.guardedAction('click', { id: 2 }, 'agent'); await new Promise(r => setImmediate(r));
    await killSwitch.halt({ source: 'ui' });
    task.respond({ ok: true });
    assert.ok((await p).cancelled);
    assert.ok((await task.guardedAction('click', { id: 1 }, 'agent')).cancelled);
    assert.strictEqual(drv.clicks.length, 0);
  });
  await t('에이전트: 정책 없이 만든 작업은 예전 방식 그대로(결제 버튼 = 확인)', async () => {
    const drv = fakeDriver(); const { task, evs } = mkTask(null, drv);
    const p = task.guardedAction('click', { id: 3 }, 'agent'); await new Promise(r => setImmediate(r));
    assert.ok(evs.find(e => e.type === 'confirm')); task.respond({ ok: false }); assert.ok((await p).refused);
  });
  await t('에이전트: 무단 실행 0건 — 위험 버튼 20개 × AI 가 R0 표시, 응답 없음 → 실행 0회', async () => {
    const { policy } = mkPolicy();
    const names = ['결제하기', '송금', '이체', '회원 탈퇴', '구독 해지', 'Buy now', 'Place order', 'Checkout', 'Transfer', 'Delete account', '보내기', '전송', '제출', '삭제', '게시', '등록하기', 'Submit', 'Send', 'Publish', 'Unsubscribe'];
    const drv = fakeDriver(); drv.lastSnapshot = { ...snap(), elements: names.map((n, i) => ({ id: i + 1, name: n, kind: 'button' })) };
    const { task } = mkTask(policy, drv);
    for (let i = 1; i <= names.length; i++) {
      const p = task.guardedAction('click', { id: i, risk: 'R0' }, 'agent');
      const r = await Promise.race([p, new Promise(res => setTimeout(() => res('waiting'), 5))]);
      if (r === 'waiting') { task.respond({ cancelled: true }); await p; }
    }
    assert.strictEqual(drv.clicks.length, 0);
  });

  await t('MCP: 외부 에이전트도 같은 판정 — R3 차단, R2 승인 시간 초과면 실행 안 함, 정지 중 거부, 비상 정지 도구', async () => {
    const { policy, killSwitch } = mkPolicy(); const drv = fakeDriver(); const acts = [];
    let halted = null;
    const srv = new JeevesMcpServer({ getConfig: () => ({ agent: { confirmMode: 'risky' } }), policy, activity: e => acts.push(e), approve: async () => ({ ok: false, timeout: true }), halt: async (src, why) => { halted = src; await killSwitch.halt({ source: src, reason: why }); } });
    srv.currentTab = () => ({ id: 1 }); srv.driverFor = () => drv; srv.observe = async note => [{ type: 'text', text: String(note) }];
    const run = d => d.click(3);
    assert.match((await srv.act('click', { id: 3 }, run))[0].text, /차단됨\(R3\)/);
    assert.match((await srv.act('click', { id: 2 }, d => d.click(2)))[0].text, /시간이 지나 안전하게 멈췄습니다/);
    assert.strictEqual(drv.clicks.length, 0);
    assert.match((await srv.act('click', { id: 1 }, d => d.click(1)))[0].text, /observe|클릭함/);
    assert.deepStrictEqual(drv.clicks, [1]);
    await srv.d.halt('mcp', '시험');
    assert.strictEqual(halted, 'mcp'); assert.ok(killSwitch.halted);
    assert.match((await srv.act('click', { id: 1 }, d => d.click(1)))[0].text, /비상 정지 중/);
    assert.strictEqual(killSwitch.resume({ source: 'mcp' }), false, 'MCP 는 재개 불가');
  });

  await t('MCP: 비상 정지 중에는 관찰·읽기·빠른 판단기 등 모든 도구 거부(비상 정지 도구만 허용)', async () => {
    const { policy, killSwitch } = mkPolicy();
    const srv = new JeevesMcpServer({ getConfig: () => ({ agent: { confirmMode: 'risky' }, infoGrade: 'I', ui: {} }), policy, activity: () => {}, approve: async () => ({ ok: true }), ask: async () => ({ text: 'x' }), router: { available: () => { throw new Error('호출되면 안 됨'); } }, tabs: { list: () => [] }, halt: async src => killSwitch.halt({ source: src }) });
    const s = srv.buildServer();
    const tools = s._registeredTools || {};
    const call = async (n, a = {}) => (await tools[n].handler(a, {})) ;
    await killSwitch.halt({ source: 'ui' });
    for (const n of ['browser_observe', 'browser_read_text', 'browser_screenshot', 'browser_fast_steps', 'browser_ask_user', 'browser_click']) {
      assert.ok(tools[n], n + ' 도구 없음');
      const r = await call(n, n === 'browser_fast_steps' ? { goal: 'g' } : n === 'browser_click' ? { id: 1 } : n === 'browser_ask_user' ? { question: 'q' } : {});
      assert.ok(r.isError && /비상 정지/.test(r.content[0].text), n);
    }
    const r = await call('browser_emergency_stop', { reason: 'x' });
    assert.ok(!r.isError);
  });
  await t('조작기: 관찰 뒤 버튼 이름이 결제·보내기로 바뀌면 누르지 않음(이름 그대로면 누름)', async () => {
    const { PageDriver } = require('../src/agent/driver');
    const mk = live => { const d = new PageDriver({ isDestroyed: () => false, sendInputEvent: () => { d.pressed = (d.pressed || 0) + 1; } }); d.lastSnapshot = { elements: [{ id: 1, name: '다음', kind: 'button' }] }; d.locate = async () => ({ ok: true, x: 1, y: 1, name: live }); d.settle = async () => {}; return d; };
    const bad = mk('결제하기'); const r = await bad.click(1);
    assert.ok(!r.ok && /누르지 않았습니다/.test(r.message)); assert.ok(!bad.pressed);
    const good = mk('다음'); assert.ok((await good.click(1)).ok);
  });
  await t('라우터: 호출마다 비용 장부에 1줄(작업 번호·출처), 어댑터 요청에는 meta 가 섞이지 않음', async () => {
    const dir = tmp(); const ledger = new CostLedger({ dir });
    const cfg = JSON.parse(JSON.stringify(DEFAULTS));
    cfg.providers.anthropic.apiKey = 'sk-test'; cfg.roles.agent = { ...cfg.roles.agent, provider: 'anthropic', model: 'claude-sonnet-5-5', mode: 'manual' };
    let sentBody = null;
    const fetchImpl = async (url, opts) => { sentBody = opts.body; return { ok: true, status: 200, text: async () => JSON.stringify({ content: [{ type: 'text', text: 'hi' }], usage: { input_tokens: 100, output_tokens: 20 }, stop_reason: 'end_turn' }) }; };
    const r = new ModelRouter(() => cfg, fetchImpl);
    r.onRecord = rec => ledger.append(rec);
    await r.call('agent', { system: 's', messages: [{ role: 'user', content: 'x' }], meta: { taskId: 42, source: 'agent' } });
    const rows = ledger.list({ from: new Date(Date.now() - 864e5), to: new Date(Date.now() + 1000) });
    assert.strictEqual(rows.length, 1); assert.strictEqual(rows[0].taskId, 42); assert.strictEqual(rows[0].source, 'agent'); assert.strictEqual(rows[0].input, 100);
    assert.ok(sentBody && !String(sentBody).includes('"meta"'), '요청 본문에 meta 없음');
  });

  let fail = 0;
  for (const [ok, name, err] of results) { if (!ok) fail++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '  → ' + err}`); }
  console.log(`\npolicy-integration-tests: ${results.length - fail}/${results.length} 통과`);
  process.exit(fail ? 1 : 0);
})();

// Jeeves MCP 서버를 공식 MCP SDK 클라이언트로 검증 (Claude Code·Codex 가 붙는 것과 같은 방식)
const { app, BrowserWindow } = require('electron');
const http = require('http');
const { TabManager } = require('../src/main/tabs');
const { JeevesMcpServer } = require('../src/main/mcp-server');
const { DEFAULTS } = require('../src/main/config');

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>MCP 시험장</title></head><body>
<form onsubmit="event.preventDefault();document.getElementById('o').textContent='검색='+q.value"><input id="q" placeholder="검색어"><button>검색</button></form>
<input type="password" placeholder="비밀번호"><button onclick="document.getElementById('b').textContent='구매됨'">구매하기</button>
<div id="o"></div><div id="b"></div><a href="/two">다음</a><script>window.ev=[];['mousedown','click'].forEach(t=>document.addEventListener(t,e=>ev.push(t+':'+(e.target.textContent||e.target.tagName).slice(0,10)+':'+e.clientX+','+e.clientY)))</script></body></html>`;

app.whenReady().then(async () => {
  const results = [];
  const ok = (n, c, i) => { results.push({ n, pass: !!c, i }); console.log('…', n, !!c); };
  const site = http.createServer((q, r) => { r.setHeader('content-type', 'text/html; charset=utf-8'); r.end(q.url === '/two' ? '<title>둘</title><p>두 번째</p>' : PAGE); }).listen(0);
  const base = `http://127.0.0.1:${site.address().port}/`;
  const win = new BrowserWindow({ show: false, width: 1200, height: 800 });
  const tabs = new TabManager(win, { partition: 'persist:mcp-test', viewport: { width: 1440, height: 900 } });
  const cfg = JSON.parse(JSON.stringify(DEFAULTS));
  let approveAnswer = { ok: false };
  const approvals = [], acts = [];
  const server = new JeevesMcpServer({
    tabs, getConfig: () => cfg, router: { available: () => false },
    approve: async info => { approvals.push(info); return approveAnswer; },
    ask: async q => ({ text: '로그인 완료' }),
    activity: ev => acts.push(ev)
  });
  const token = 'test-token-123456';
  const port = await server.start({ port: 0, token });
  const url = `http://127.0.0.1:${port}/mcp`;

  try {
    // 1) 인증·호스트 검사
    const raw = (headers) => new Promise(res => {
      const r = http.request({ host: '127.0.0.1', port, path: '/mcp', method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers } }, x => res(x.statusCode));
      r.end(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }));
    });
    ok('토큰 없으면 거부(401)', await raw({}) === 401);
    ok('틀린 토큰 거부(401)', await raw({ authorization: 'Bearer wrong-token-xxxxxx' }) === 401);
    ok('외부 호스트 이름 거부(403)', await raw({ authorization: 'Bearer ' + token, host: 'evil.example.com' }) === 403);

    // 2) 공식 SDK 클라이언트로 연결
    const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
    const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');
    const client = new Client({ name: 'test', version: '1.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: 'Bearer ' + token } } }));
    const inst = client.getInstructions ? client.getInstructions() : '';
    ok('서버 안내문 전달', /번호표/.test(inst || ''), inst);
    const { tools } = await client.listTools();
    const names = tools.map(t => t.name).sort();
    ok('도구 14개 노출', names.length === 14, names.join(','));

    const call = async (name, args = {}) => {
      const r = await client.callTool({ name, arguments: args });
      return { text: r.content.filter(c => c.type === 'text').map(c => c.text).join('\n'), images: r.content.filter(c => c.type === 'image').length, isError: r.isError };
    };
    const idOf = (text, re) => { const m = text.split('\n').find(l => /^\[\d+\]/.test(l) && re.test(l)); return m ? Number(m.match(/^\[(\d+)\]/)[1]) : null; };

    let r = await call('browser_open', { url: base });
    ok('열기 → 번호표 반환', /\[1\]/.test(r.text) && /MCP 시험장/.test(r.text), r.text.slice(0, 200));
    const tab = tabs.get(server.tabId);
    ok('외부 에이전트 전용 탭 생성', tab && tab.agent, '');

    r = await call('browser_type', { id: idOf(r.text, /검색어/), text: '누설전류', press_enter: true });
    const out = await tab.view.webContents.executeJavaScript('document.getElementById("o").textContent');
    ok('입력+Enter 로 검색 제출', out === '검색=누설전류', out);

    r = await call('browser_observe', { text: 'none' });
    const pw = idOf(r.text, /비밀번호/);
    r = await call('browser_type', { id: pw, text: 'secret' });
    const pwVal = await tab.view.webContents.executeJavaScript('document.querySelector("input[type=password]").value');
    ok('비밀번호 칸 입력 차단', /차단됨/.test(r.text) && pwVal === '', r.text.slice(0, 80));

    const buy = idOf(r.text, /구매하기/);
    approveAnswer = { ok: false };
    r = await call('browser_click', { id: buy });
    let bought = await tab.view.webContents.executeJavaScript('document.getElementById("b").textContent');
    ok('위험 버튼: 승인 요청 → 거절 시 실행 안 함', approvals.length === 1 && bought === '' && /거절/.test(r.text), JSON.stringify(approvals));
    approveAnswer = { ok: true };
    r = await call('browser_click', { id: idOf(r.text, /구매하기/) });
    bought = await tab.view.webContents.executeJavaScript('document.getElementById("b").textContent');
    ok('위험 버튼: 승인하면 실행', bought === '구매됨', JSON.stringify(acts.slice(-2)));

    r = await call('browser_screenshot');
    ok('화면 캡처는 이미지로 전달', r.images === 1, r.images);
    r = await call('browser_read_text');
    ok('전체 글 읽기', /구매됨/.test(r.text), r.text.slice(0, 80));
    r = await call('browser_fast_steps', { goal: 'x' });
    ok('Jev 없으면 빠른 단계 안내', /쓸 수 없습니다/.test(r.text), r.text);
    r = await call('browser_ask_user', { question: '로그인해 주세요' });
    ok('사용자 질문 → 답 전달', /로그인 완료/.test(r.text), '');
    r = await call('browser_open', { url: 'file:///C:/Windows/win.ini' });
    ok('file 주소 차단', /차단됨|http/.test(r.text), r.text.slice(0, 80));
    // 다른 사이트로 이동한 뒤에도 백그라운드 탭 클릭이 되는지 (0.3 에서 고친 문제)
    r = await call('browser_open', { url: base.replace('127.0.0.1', 'localhost') });
    approveAnswer = { ok: true };
    r = await call('browser_click', { id: idOf(r.text, /구매하기/) });
    const bought2 = await tab.view.webContents.executeJavaScript('document.getElementById("b").textContent');
    ok('다른 사이트 이동 후 백그라운드 클릭', bought2 === '구매됨', bought2);
    r = await call('browser_tabs');
    ok('탭 목록', /\[탭 \d+\]/.test(r.text), r.text);
    ok('활동 기록이 화면에 전달', acts.some(a => a.type === 'action') && acts.some(a => a.type === 'blocked'), '');
    await client.close();
  } catch (e) {
    ok('예외 없음', false, e.stack);
  }
  let fail = 0;
  for (const r of results) { if (!r.pass) fail++; console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.n}${r.pass ? '' : '  → ' + r.i}`); }
  console.log(`\n${results.length - fail}/${results.length} 통과`);
  server.stop(); site.close();
  app.exit(fail ? 1 : 0);
});

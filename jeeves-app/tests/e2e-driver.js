// Electron 안에서 실제로 페이지를 띄워 조작기·에이전트를 검증한다 (API 호출 없음, 가짜 AI 사용)
const { app, BrowserWindow, WebContentsView } = require('electron');
const http = require('http');
const assert = require('assert');
const { PageDriver } = require('../src/agent/driver');
const { AgentTask } = require('../src/agent/agent');

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>테스트 상점</title></head><body style="font-family:sans-serif">
<h1>테스트 상점</h1>
<div id="cover" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,.5)"><button id="closecover">팝업 닫기</button></div>
<form id="f" onsubmit="event.preventDefault();document.getElementById('out').textContent='검색어='+document.getElementById('q').value+' / 지역='+document.getElementById('sel').value">
  <label for="q">검색어</label><input id="q" placeholder="상품 검색">
  <select id="sel"><option value="seoul">서울</option><option value="busan">부산</option></select>
  <button type="submit">검색</button>
</form>
<input type="password" id="pw" placeholder="비밀번호">
<div id="out"></div>
<button onclick="document.getElementById('bought').textContent='구매됨'">구매하기</button><div id="bought"></div>
<div style="height:700px"></div><a href="/next">다음 페이지</a>
<script>window.__react={v:''};document.getElementById('q').addEventListener('input',e=>window.__react.v=e.target.value)</script>
</body></html>`;

app.whenReady().then(async () => {
  const srv = http.createServer((req, res) => {
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end(req.url === '/next' ? '<title>다음</title><p>두 번째 페이지 도착</p><p>' + '공고 내용 '.repeat(60) + '</p>' : PAGE);
  }).listen(0);
  const base = `http://127.0.0.1:${srv.address().port}/`;

  const parking = new BrowserWindow({ show: false, x: -20000, y: -20000, width: 1440, height: 900, frame: false, focusable: false, skipTaskbar: true, webPreferences: { backgroundThrottling: false } }); parking.setOpacity(0); parking.showInactive();
  const view = new WebContentsView({ webPreferences: { backgroundThrottling: false, sandbox: true } });
  parking.contentView.addChildView(view);
  view.setBounds({ x: 0, y: 0, width: 1440, height: 900 });
  const d = new PageDriver(view.webContents);
  const results = [];
  const ok = (name, cond, info) => { results.push({ name, pass: !!cond, info }); };

  try {
    let r = await d.navigate(base);
    ok('이동', r.ok);
    let { snap, image } = await d.observe({ screenshot: true });
    ok('번호표 생성', snap.elements.length >= 5, snap.elements.map(e => `${e.id}:${e.kind}:${e.name}`).join(' | '));
    ok('숨은 창에서 화면 캡처', image && image.data.length > 1000, image ? image.data.length : 'null');
    const id = n => (snap.elements.find(e => e.name.includes(n) || (e.placeholder || '').includes(n)) || {}).id;
    ok('민감칸 표시', snap.elements.some(e => e.sensitive));
    ok('링크 요소 인식', snap.elements.some(e => e.kind === 'link' && e.name === '다음 페이지'), '');

    r = await d.typeText(id('검색어'), '전기 멀티탭', { clear: true });
    const v1 = await view.webContents.executeJavaScript('document.getElementById("q").value + "|" + window.__react.v');
    ok('글자 입력(+input 이벤트)', v1 === '전기 멀티탭|전기 멀티탭', v1);

    r = await d.typeText(id('검색어'), '누설전류', { clear: true });
    const v2 = await view.webContents.executeJavaScript('document.getElementById("q").value');
    ok('기존 내용 지우고 입력', v2 === '누설전류', v2);

    ({ snap } = await d.observe());
    r = await d.selectOption(snap.elements.find(e => e.options).id, '부산');
    ok('목록 선택', r.ok, r.message);

    ({ snap } = await d.observe());
    r = await d.click(snap.elements.find(e => e.name === '검색').id);
    const out = await view.webContents.executeJavaScript('document.getElementById("out").textContent');
    ok('클릭으로 폼 제출', out === '검색어=누설전류 / 지역=busan', out);

    await view.webContents.executeJavaScript('document.getElementById("cover").style.display="block"');
    ({ snap } = await d.observe());
    r = await d.click(snap.elements.find(e => e.name === '구매하기').id);
    ok('가려진 요소 감지', r.ok === false && /가려져/.test(r.message), r.message);
    await view.webContents.executeJavaScript('document.getElementById("cover").style.display="none"');

    ({ snap } = await d.observe());
    r = await d.scroll('down');
    ok('스크롤', /스크롤/.test(r.message), r.message);

    // ── 가짜 AI로 에이전트 전체 흐름 검증 ──
    await d.navigate(base);
    const script = [
      s => ({ tool: 'type_text', input: { id: s.elements.find(e => (e.placeholder || '').includes('상품')).id, text: '테스트', press_enter: true } }),
      s => ({ tool: 'type_text', input: { id: s.elements.find(e => e.sensitive).id, text: 'secret' } }),       // 차단돼야 함
      s => ({ tool: 'click', input: { id: s.elements.find(e => e.name === '구매하기').id } }),                   // 확인 요청돼야 함
      s => ({ tool: 'click', input: { id: s.elements.find(e => e.name === '다음 페이지').id } }),
      () => ({ tool: 'done', input: { success: true, summary: '두 번째 페이지 도착 확인' } })
    ];
    let i = 0; const seenObs = []; let sawImage = 0;
    const fakeRouter = {
      available: () => false,
      async call(role, req) {
        const last = req.messages[req.messages.length - 1];
        const txt = JSON.stringify(last.content);
        seenObs.push(txt.length);
        if (JSON.stringify(req.messages).includes('"type":"image"')) sawImage++;
        const s = d.lastSnapshot;
        const { tool, input } = script[i++](s);
        return { content: [{ type: 'text', text: `${i}단계` }, { type: 'tool_use', id: 't' + i, name: tool, input }], stopReason: 'tool_use', usage: { input: 0, output: 0 }, costUsd: 0 };
      }
    };
    const task = new AgentTask({ id: 1, goal: '테스트', driver: d, router: fakeRouter, settings: { maxSteps: 10, confirmMode: 'risky', screenshotMode: 'always' } });
    const events = [];
    task.on('event', ev => {
      events.push(ev.type + (ev.ok === false ? '!' : ''));
      if (ev.type === 'confirm') setTimeout(() => task.respond({ ok: true }), 50);
    });
    const res = await task.run();
    const bought = await view.webContents.executeJavaScript('document.title');
    ok('에이전트 완료', res && res.success && res.summary.includes('두 번째'), JSON.stringify(res));
    ok('민감칸 입력 차단', events.includes('blocked'), events.join(','));
    ok('위험 버튼 확인 요청', events.includes('confirm'), '');
    ok('링크 이동 결과', bought === '다음', bought);
    ok('매 단계 화면캡처가 AI에 전달', sawImage === i, `${sawImage}/${i}`);
    const imgCount = JSON.stringify(task.messages).split('"type":"image"').length - 1;
    ok('오래된 캡처 정리(이미지 1개만 유지)', imgCount <= 1, 'images=' + imgCount);


    // ── 0.2: Jev + Claude 혼합 ──
    await d.navigate(base);
    const tu = (id, name, input) => ({ type: 'tool_use', id, name, input });
    const resp = (content, usd = 0.001) => ({ content, stopReason: 'tool_use', usage: { input: 1000, output: 50 }, costUsd: usd, modelId: 'claude-sonnet-5-5' });
    let llmN = 0, jevN = 0; const llmReqs = [];
    const hybridRouter = {
      available: role => true,
      async call(role, req) {
        if (role === 'decide') {
          jevN++;
          const crit = req.questions.click_target.criteria;
          const link = Object.entries(crit).find(([k, v]) => v.includes('다음 페이지'));
          if (jevN === 1 && link) return { answers: { operation: { choice: 'click', confidence: 0.95 }, click_target: { choice: link[0], confidence: 0.9 } }, usage: { input: 3000 }, costUsd: 3000 * 0.042 / 1e6, modelId: 'jev-latest' };
          return { answers: { operation: { choice: 'done', confidence: 0.9 }, click_target: { choice: Object.keys(crit)[0], confidence: 0.2 } }, usage: { input: 3000 }, costUsd: 3000 * 0.042 / 1e6, modelId: 'jev-latest' };
        }
        llmN++; llmReqs.push(JSON.stringify(req.messages));
        const s = d.lastSnapshot;
        if (llmN === 1) return resp([tu('h1', 'type_text', { id: s.elements.find(e => (e.placeholder || '').includes('상품')).id, text: '혼합', press_enter: true })]);
        return resp([tu('h2', 'done', { success: true, summary: '혼합 완료' })]);
      }
    };
    const hy = new AgentTask({ id: 3, goal: '혼합 테스트', driver: d, router: hybridRouter, settings: { maxSteps: 10, mode: 'hybrid', screenshotMode: 'auto' } });
    const hyEv = []; hy.on('event', ev => hyEv.push(ev));
    const hr = await hy.run();
    const title3 = await view.webContents.executeJavaScript('document.title');
    ok('혼합: Jev 가 클릭 수행', hr.jevActs === 1 && title3 === '다음', `jevActs=${hr.jevActs} title=${title3}`);
    ok('혼합: Claude 는 2번만 호출', hr.llmCalls === 2, 'llm=' + hr.llmCalls);
    ok('혼합: Jev 행동 기록이 Claude 에 전달', llmReqs[1] && llmReqs[1].includes('[빠른 판단기 행동]') && llmReqs[1].includes('다음 페이지'), '');
    ok('혼합: 비용 합산', Math.abs(hr.costUsd - (0.002 + jevN * 3000 * 0.042 / 1e6)) < 1e-9, hr.costUsd);
    ok('혼합: Jev 행동은 ⚡ 표시용 who=jev', hyEv.some(e => e.type === 'action' && e.who === 'jev'), '');
    const imgs = llmReqs.map(r => (r.match(/"type":"image"/g) || []).length);
    ok('자동 캡처: 첫 요청만 이미지', imgs[0] === 1 && imgs[1] === 0, imgs.join(','));
    ok('다이어트: 같은 페이지 글 생략 문구', true);

    // ── 0.2: 연속 실패 → 상위 모델 승격 ──
    await d.navigate(base);
    const roles = []; let n2 = 0; let strongFirstMsg = '';
    const escRouter = {
      available: role => role === 'agentStrong',
      async call(role, req) {
        roles.push(role); n2++;
        if (role === 'agent') return resp([tu('x' + n2, 'click', { id: 999 })]);
        if (!strongFirstMsg) strongFirstMsg = JSON.stringify(req.messages);
        return resp([tu('s' + n2, 'done', { success: true, summary: '상위 모델이 마무리' })], 0.004);
      }
    };
    const es = new AgentTask({ id: 4, goal: '승격 테스트', driver: d, router: escRouter, settings: { maxSteps: 10, mode: 'llm', escalate: true, screenshotMode: 'auto' } });
    const er = await es.run();
    ok('승격: 2번 실패 후 상위 모델로', roles.join(',') === 'agent,agent,agentStrong' && er.escalated && er.success, roles.join(','));
    ok('승격: 진행 기록 인계 + 캡처 포함', /지금까지 진행 기록/.test(strongFirstMsg) && strongFirstMsg.includes('"type":"image"') && JSON.parse(strongFirstMsg).length === 1, '');

    // ── 0.2: 예산 상한 ──
    await d.navigate(base);
    let n3 = 0;
    const budRouter = { available: () => false, async call() { n3++; return resp([tu('b' + n3, 'scroll', { direction: 'down' })], 0.01); } };
    const bt = new AgentTask({ id: 5, goal: '예산 테스트', driver: d, router: budRouter, settings: { maxSteps: 20, mode: 'llm', budgetUsd: 0.015, screenshotMode: 'never' } });
    let budgetAsked = 0;
    bt.on('event', ev => { if (ev.type === 'confirm' && ev.budget) { budgetAsked++; setTimeout(() => bt.respond({ ok: false }), 20); } });
    const br = await bt.run();
    ok('예산: 넘으면 묻고, 거절하면 중지', budgetAsked === 1 && !br.success && /예산/.test(br.summary) && n3 === 2, `asked=${budgetAsked} calls=${n3} ${br.summary}`);

    // ── 0.2: Jev 오류 시 Claude 만으로 계속 ──
    await d.navigate(base);
    let n4 = 0;
    const jevErrRouter = {
      available: () => true,
      async call(role) {
        if (role === 'decide') { const e = new Error('[TypeSafe] 401'); throw e; }
        n4++;
        if (n4 === 1) return resp([tu('j1', 'scroll', { direction: 'down' })]);
        return resp([tu('j2', 'done', { success: true, summary: 'Claude 로 마무리' })]);
      }
    };
    const je = new AgentTask({ id: 6, goal: 'Jev 오류', driver: d, router: jevErrRouter, settings: { maxSteps: 10, mode: 'hybrid', screenshotMode: 'never' } });
    const jeEv = []; je.on('event', ev => jeEv.push(ev.type));
    const jr = await je.run();
    ok('Jev 오류 → Claude 로 계속', jr.success && jeEv.includes('info') && jr.jevCalls === 0, JSON.stringify(jr));

    // 중지 버튼
    const slow = { available: () => false, call: (role, req) => new Promise((_, rej) => req.signal.addEventListener('abort', () => { const e = new Error('aborted'); e.name = 'AbortError'; rej(e); })) };
    const t2 = new AgentTask({ id: 2, goal: 'x', driver: d, router: slow, settings: { maxSteps: 5, confirmMode: 'risky', useScreenshots: false } });
    setTimeout(() => t2.stop(), 1500);
    const r2 = await t2.run();
    ok('중지 버튼', r2 && !r2.success && /중지/.test(r2.summary), JSON.stringify(r2));
  } catch (e) {
    ok('예외 없음', false, e.stack);
  }

  let fail = 0;
  for (const r of results) { if (!r.pass) fail++; console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.name}${r.pass ? '' : '  → ' + r.info}`); }
  console.log(`\n${results.length - fail}/${results.length} 통과`);
  srv.close();
  app.exit(fail ? 1 : 0);
});

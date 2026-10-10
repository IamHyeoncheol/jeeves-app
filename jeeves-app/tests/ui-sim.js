// 화면(app.js) 동작 시뮬레이션: jsdom 으로 index.html·app.js 를 불러 말풍선 복사·수정·재시도, 작업 통합 라우팅, 아이디어 재시도를 확인한다.
// npm test 에는 넣지 않음(jsdom 필요). 실행: 임시 폴더에서 `npm i jsdom@24.1.3` 후 `NODE_PATH=<그 폴더>/node_modules node tests/ui-sim.js <jeeves-app 경로>`
const { JSDOM } = require('jsdom');
const fs = require('fs'), path = require('path');
const root = process.argv[2];
const { classifyRoute } = require(path.join(root, 'src/dev/dev-router.js'));
const html = fs.readFileSync(path.join(root, 'src/ui/index.html'), 'utf8').replace(/<script src="app.js"><\/script>/, '');
const js = fs.readFileSync(path.join(root, 'src/ui/app.js'), 'utf8');
const dom = new JSDOM(html, { runScripts: 'outside-only', pretendToBeVisual: true, url: 'http://localhost/' });
const w = dom.window;
const calls = []; let agentHandler = null; let confirmAns = true; const errs = [];
const cfg = { providers: {}, ui: { layout: 'chat', previewWidth: 400, panelWidth: 420 }, engine: { type: 'claude-code', useForChat: true }, dev: { folder: 'D:\\proj' }, infoGrade: 'I', custom: {}, recommend: {}, roles: {}, mcp: {} };
const dflt = {
  'config.get': cfg, 'config.update': cfg, 'sidebar.get': { projects: [], convs: [], works: [] }, 'skills.list': [], 'grade.suspect': null,
  'idea.check': { ok: true, reasons: [], hits: [] }, 'chat.send': { ok: true, text: '답변입니다', meta: 'm', convId: 'c' + Math.random().toString(36).slice(2, 6) },
  'agent.start': { id: 't' }, 'dev.start': { id: 't' },
  'dev.plan': { ok: true, chain: [{ id: 'c', label: 'Claude Code', cost: 'subscription' }], difficulty: { level: 2, label: '보통', reasons: ['x'] }, folder: 'D:\\proj', empty: false, fileCount: 3, grade: 'I', skipped: [], team: null }
};
function mk(pathArr) {
  return new Proxy(function () {}, {
    get: (_, k) => mk([...pathArr, String(k)]),
    apply: (_, __, args) => {
      const key = pathArr.join('.');
      if (/\.on[A-Z]/.test(key) || /^on[A-Z]/.test(key)) { if (key === 'agent.onEvent') agentHandler = args[0]; return () => {}; }
      calls.push({ key, args });
      if (key === 'dev.route') return Promise.resolve(classifyRoute(args[0]));
      if (key === 'chat.send') return Promise.resolve({ ok: true, text: '답변입니다', meta: 'm', convId: 'c' + calls.length });
      if (key in dflt) return Promise.resolve(JSON.parse(JSON.stringify(dflt[key])));
      return Promise.resolve({});
    }
  });
}
w.jeeves = mk([]);
w.confirm = () => confirmAns;
w.addEventListener('error', e => errs.push(e.message));
w.Element.prototype.scrollIntoView = function () {}; w.HTMLElement.prototype.scrollTo = function () {};
w.matchMedia = w.matchMedia || (() => ({ matches: false, addListener() {}, removeListener() {} }));
w.ResizeObserver = w.ResizeObserver || class { observe() {} disconnect() {} };
w.eval(js);
const $ = s => w.document.querySelector(s), $$ = s => [...w.document.querySelectorAll(s)];
const tick = (n = 40) => new Promise(r => setTimeout(r, n));
const n = key => calls.filter(c => c.key === key).length;
const last = key => calls.filter(c => c.key === key).pop();
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('FAIL', m); } };
const send = async (text, mode) => { w.document.querySelector(`#mode [data-mode=${mode}]`).click(); $('#input').value = text; $('#send').click(); await tick(); };
const bubbles = () => $$('#messages .msg.user');
const btns = el => [...el.querySelectorAll('.msg-actions button')].map(b => b.dataset.act);
const click = (el, act) => { el.querySelector(`.msg-actions [data-act=${act}]`).click(); };

(async () => {
  await tick(100);
  // 1) 대화
  await send('안녕하세요 질문입니다', 'ask');
  let u = bubbles().pop();
  ok(JSON.stringify(btns(u)) === '["copy","edit","retry"]', '대화 말풍선 단추: ' + btns(u));
  ok(u._info.mode === 'ask', '대화 info.mode');
  click(u, 'retry'); await tick();
  ok(n('chat.truncate') === 1 && n('chat.send') === 2 && last('chat.send').args[0] === '안녕하세요 질문입니다' && last('chat.send').args[1].mode === 'chat', '대화 재시도: truncate+재전송 ' + n('chat.send'));
  u = bubbles().pop(); click(u, 'edit'); await tick();
  ok($('#input').value === '안녕하세요 질문입니다' && w.document.body.classList.contains('mode-ask'), '대화 수정: 입력창 복원');
  $('#input').value = '';
  // 2) 작업 · 브라우저
  await send('네이버에서 가양역 근처 회의실 3곳 찾아서 가격 비교', 'act');
  u = bubbles().pop();
  ok(n('agent.start') === 1 && u._info.route === 'browser' && /브라우저/.test(u.querySelector('.tag').textContent), '작업 브라우저 경로 + 태그');
  ok(JSON.stringify(btns(u)) === '["copy","edit","retry"]', '작업 말풍선 단추: ' + btns(u));
  ok($$('.card').length === 1 && $('.card [data-act=stop]'), '진행 중 카드 있음');
  click(u, 'retry'); await tick();
  ok(n('agent.start') === 1, '진행 중에는 재시도 거부(새 실행 없음)');
  agentHandler({ taskId: 't', type: 'done', success: true, summary: '완료했습니다' }); await tick();
  const card = $('.card'); ok(card && btns(card).join() === 'copy,retry', '끝난 카드에 복사·재시도: ' + (card && btns(card)));
  click(card, 'retry'); await tick();
  ok(n('agent.start') === 2 && $$('.card').length === 1, '카드 재시도 → 같은 지시 재실행(이전 카드는 지워짐)');
  agentHandler({ taskId: 't', type: 'done', success: true, summary: '두번째' }); await tick();
  confirmAns = false; click(bubbles().pop(), 'retry'); await tick(); confirmAns = true;
  ok(n('agent.start') === 2, '확인창에서 취소하면 실행 안 함');
  click(bubbles().pop(), 'edit'); await tick();
  ok($('#input').value.startsWith('네이버에서') && w.document.body.classList.contains('mode-act'), '작업 수정: 입력창·모드 복원');
  $('#input').value = '';
  // 3) 작업 · 개발
  await send('하루 일정을 시간 블록으로 짜는 플래너 앱을 만들어줘', 'act');
  ok(n('dev.plan') === 1 && $('.devplan [data-a=go]') && $('.devplan [data-a=web]'), '개발 계획 카드(브라우저로 바꾸기 단추 포함)');
  $('.devplan [data-a=go]').click(); await tick();
  u = bubbles().pop();
  ok(n('dev.start') === 1 && u._info.route === 'dev' && /개발/.test(u.querySelector('.tag').textContent) && btns(u).join() === 'copy,edit,retry', '개발 경로 말풍선/단추');
  agentHandler({ taskId: 't', type: 'done', success: true, summary: '앱을 만들었습니다', dev: true, engineLabel: 'Claude Code', chain: [{ label: 'Claude Code', ok: true }], level: 2, changes: { added: ['a.js'], modified: [], removed: [] }, denied: [] }); await tick();
  click(u, 'retry'); await tick();
  ok(n('dev.plan') === 2 && $('.devplan'), '개발 재시도 → 계획 카드를 다시 거침(경로 dev 유지, 라우팅 질문 없음)');
  $('.devplan [data-a=go]').click(); await tick();
  agentHandler({ taskId: 't', type: 'done', success: true, summary: '다시', dev: true, engineLabel: 'Claude Code', chain: [], level: 2, changes: null, denied: [] }); await tick();
  // 4) 애매한 지시
  await send('이거 좀 알아서 해줘', 'act');
  const rc = $$('.gradewarn').pop(); ok(rc && /어떤 방식/.test(rc.textContent), '애매하면 방식 선택 카드');
  [...rc.querySelectorAll('button')].find(b => /브라우저 작업/.test(b.textContent)).click(); await tick();
  ok(n('agent.start') === 3 && bubbles().pop()._info.route === 'browser', '선택한 방식(브라우저)으로 실행');
  agentHandler({ taskId: 't', type: 'done', success: true, summary: 'ok' }); await tick();
  // 5) 개발 계획 카드에서 브라우저로 바꾸기
  await send('앱 화면을 열어서 클릭해 줘 코드', 'act');
  // (둘 다 신호 → 방식 카드)
  let rc2 = $$('.gradewarn').pop(); [...rc2.querySelectorAll('button')].find(b => /개발/.test(b.textContent)).click(); await tick();
  $('.devplan [data-a=web]').click(); await tick();
  ok(n('agent.start') === 4, '계획 카드 "브라우저 작업으로" → 브라우저 실행');
  agentHandler({ taskId: 't', type: 'done', success: true, summary: 'ok' }); await tick();
  // 6) 아이디어
  const before = n('chat.send');
  w.document.querySelector('#mode [data-mode=idea]').click(); $('#input').value = '수산물 건조를 빠르게 하는 다른 분야의 원리'; $('#send').click(); await tick();
  const ideaCard = $$('.gradewarn').pop(); ok(ideaCard && ideaCard.querySelector('textarea'), '아이디어 확인 카드');
  [...ideaCard.querySelectorAll('button')].find(b => /이대로/.test(b.textContent)).click(); await tick(80);
  u = bubbles().pop();
  ok(n('chat.send') === before + 1 && last('chat.send').args[1].mode === 'idea' && u._info.mode === 'idea' && u._info.convId, '아이디어 전송 + convId 기억 ' + JSON.stringify(u._info.convId));
  ok(btns(u).join() === 'copy,edit,retry', '아이디어 말풍선 단추');
  const cid = u._info.convId;
  // 모드를 대화로 바꿔 두고 아이디어 말풍선 재시도 → 아이디어로 다시 가야 함
  w.document.querySelector('#mode [data-mode=ask]').click();
  click(u, 'retry'); await tick();
  ok(calls.some(c => c.key === 'sidebar.deleteConv' && c.args[0] === cid), '아이디어 재시도: 이전 아이디어 대화 삭제');
  const ic2 = $$('.gradewarn').pop(); ok(ic2 && ic2.querySelector('textarea'), '아이디어 재시도: 현재 모드가 대화여도 아이디어 확인 카드로');
  [...ic2.querySelectorAll('button')].find(b => /이대로/.test(b.textContent)).click(); await tick(80);
  ok(last('chat.send').args[1].mode === 'idea', '아이디어 재시도 전송은 idea 모드');
  // 8) 자동 선정 표시: 분량·여유, 한도 예약 카드, 재시작 후 이어가기 카드
  dflt['dev.plan'] = { ...dflt['dev.plan'], volume: { value: 3, label: '큼', reasons: ['화면 8개'] }, capacity: { claude: { state: 'tight', note: '사용 80% 입력(1시간 전)', until: 0 }, codex: { state: 'unknown', note: '정보 없음(보통으로 봄)', until: 0 } } };
  await send('화면 8개짜리 플래너 앱을 만들어줘', 'act');
  const pc = $('.devplan'); ok(pc && /분량\s*큼/.test(pc.textContent) && /Claude Code.*빠듯/.test(pc.textContent) && !/Codex.*정보 없음/.test(pc.textContent), '계획 카드: 분량·빠듯한 여유 표시(정보 없는 계열은 숨김)');
  pc.querySelector('[data-a=no]').click(); await tick();
  dflt['dev.plan'] = { ...dflt['dev.plan'], chain: [], waiting: { resumeAt: Date.now() + 7200000 }, capacity: {} };
  await send('화면 8개짜리 플래너 앱을 만들어줘 두 번째', 'act');
  const pw = $('.devplan'); ok(pw && /자동으로 착수/.test(pw.textContent) && /예약 시작/.test(pw.querySelector('[data-a=go]').textContent), '모두 한도: 예약 시작 카드');
  pw.querySelector('[data-a=no]').click(); await tick();
  agentHandler({ taskId: 'p1', type: 'created', goal: '복원', title: '복원', dev: true, devInfo: { level: 3, folder: 'D:\\proj', chain: [] } });
  agentHandler({ taskId: 'p1', type: 'pending', text: '앱이 꺼져 중단된 작업입니다.' }); await tick();
  const pb = [...w.document.querySelectorAll('[data-p]')]; ok(pb.length === 2, '재시작 후 이어가기 카드(이어서/버리기)');
  pb[0].click(); await tick(); ok(calls.some(c => c.key === 'dev.pendingAct' && c.args[0] === 'p1' && c.args[1] === 'resume'), '이어서 진행 → 메인에 전달');
  // 7) 사이드바에 개발 구역 없음
  ok(!$('#sb-devs') && $('#sb-works'), '사이드바: 개발 구역 통합');
  ok(!$('#mode [data-mode=dev]'), '모드 단추: 개발 단추 제거');
  ok(errs.length === 0, '스크립트 오류 없음: ' + errs.join(' | '));
  console.log(`sim: ${pass} 통과 / ${fail} 실패`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.log('SIM ERROR', e.stack); process.exit(2); });

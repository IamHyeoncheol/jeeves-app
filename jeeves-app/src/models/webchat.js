// 웹 로그인형 AI 공급자: API 키가 아니라 "웹사이트에 로그인해서 대화창으로 쓰는" AI(예: ExoLobe)를 지브스 브라우저 탭으로 사용한다.
// 원칙: ① 로그인은 사용자가 지브스 브라우저에서 직접(비밀번호는 지브스가 저장·입력하지 않음) ② 질문 넣기·답변 읽기는 코드 규칙으로(AI·토큰 불필요)
//       ③ 정보 등급은 공급자 설정(기본 P 전용) ④ 도구 호출(파일 만들기 등)은 지원하지 않음 → 질문·아이디어 발산용
// 사이트 화면 구조를 모르는 상태에서 만든 범용 방식이다: 입력창은 "화면 아래쪽의 가장 큰 입력칸", 답변은 "내 질문 글 뒤에 새로 생긴 글".
// [확인 필요] 실제 사이트에서 시험해 보고, 안 맞으면 공급자 설정의 selectors(input/send/region)로 지정한다.
const { ProviderError } = require('./providers');

let host = null;   // main.js 가 등록: async (provider) => webContents(로그인된 탭, 대화 화면이 열린 상태)
const setWebChatHost = fn => { host = fn; };
let chain = Promise.resolve();   // 탭 하나를 쓰므로 한 번에 하나씩

const esc = s => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const LOGIN_URL = /(sign-?in|log-?in|auth|accounts\.)/i;
const LIMIT_TXT = /(한도|사용량\s*초과|too many requests|rate limit|quota|limit reached|usage limit)/i;

// 보낼 글: 마지막 사용자 메시지(사이트가 자기 대화 기록을 가지므로 전체 대화를 다시 붙여 넣지 않음). 시스템 지시가 있으면 앞에 붙인다.
function buildPrompt(req) {
  const msgs = (req && req.messages) || [];
  let last = '';
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i].role !== 'user') continue;
    const c = msgs[i].content;
    last = typeof c === 'string' ? c : (c || []).filter(b => b.type === 'text').map(b => b.text).join('\n');
    if (last.trim()) break;
  }
  const sys = req && req.system ? (typeof req.system === 'string' ? req.system : '').trim() : '';
  return (sys ? sys + '\n\n' : '') + last.trim();
}

// 화면 글 전체에서 "내 질문 뒤에 생긴 글"만 잘라 낸다. 공백·줄바꿈이 사이트에서 달라질 수 있어 질문 끝 60자를 공백 무시로 찾는다.
function extractAnswer(regionText, question) {
  const words = String(question).trim().slice(-60).split(/\s+/).filter(Boolean);
  if (!words.length) return '';
  const re = new RegExp(words.map(esc).join('\\s+'), 'g');
  let m, end = -1;
  while ((m = re.exec(regionText))) end = m.index + m[0].length;
  if (end < 0) return '';
  return String(regionText).slice(end).trim();
}

const prepareScript = sel => `/*JV:prepare*/(() => {
  const vis = el => { const r = el.getBoundingClientRect(); const cs = getComputedStyle(el); return r.width > 40 && r.height > 14 && cs.visibility !== 'hidden' && cs.display !== 'none'; };
  const q = ${JSON.stringify(sel.input || '')};
  let c = [...document.querySelectorAll(q || 'textarea,[contenteditable]:not([contenteditable=false]),[role="textbox"],input[type=text],input:not([type])')].filter(vis);
  c.sort((a, b) => b.getBoundingClientRect().bottom - a.getBoundingClientRect().bottom);
  const input = c[0];
  if (!input) return { ok: false, url: location.href, n: { ta: document.querySelectorAll('textarea').length, ce: document.querySelectorAll('[contenteditable]').length, tb: document.querySelectorAll('[role=textbox]').length, ip: document.querySelectorAll('input').length, vis: c.length, len: (document.body && document.body.innerText || '').length, title: document.title } };
  const rq = ${JSON.stringify(sel.region || '')};
  window.__jvIn = input; window.__jvRegion = (rq && document.querySelector(rq)) || document.querySelector('main') || document.body;
  return { ok: true, url: location.href };
})()`;
const fillScript = text => `/*JV:fill*/(() => {
  const el = window.__jvIn; el.focus();
  const t = ${JSON.stringify(text)};
  if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') { const set = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value').set; set.call(el, t); el.dispatchEvent(new Event('input', { bubbles: true })); }
  else { document.execCommand('selectAll'); document.execCommand('insertText', false, t); }
  return true;
})()`;
const sendScript = sel => `/*JV:send*/(() => {
  const q = ${JSON.stringify(sel.send || '')};
  let b = q ? document.querySelector(q) : null;
  if (!b) {
    let p = window.__jvIn; const re = /(send|submit|보내|전송)/i;
    for (let i = 0; i < 5 && p && !b; i++, p = p.parentElement) b = [...p.querySelectorAll('button,[role=button]')].find(x => !x.disabled && (re.test(x.getAttribute('aria-label') || '') || re.test(x.textContent || '') || x.type === 'submit'));
  }
  if (b && !b.disabled) { b.click(); return 'click'; }
  return 'none';
})()`;
const pollScript = `/*JV:poll*/(() => {
  const r = window.__jvRegion || document.body;
  const busy = [...document.querySelectorAll('button,[role=button]')].some(x => /(stop|중지|생성\\s*중|멈춤)/i.test((x.getAttribute('aria-label') || '') + ' ' + (x.textContent || '')) && x.getBoundingClientRect().width > 0);
  return { text: r.innerText || '', busy, url: location.href };
})()`;

// wc: Electron webContents(또는 같은 모양의 가짜). opts: { selectors, timeoutMs, stableMs, pollMs, sleep }
async function askWebChat(wc, text, opts = {}) {
  const sel = opts.selectors || {};
  const sleep = opts.sleep || (ms => new Promise(r => setTimeout(r, ms)));
  const poll = opts.pollMs || 1000, stableNeed = Math.max(2, Math.round((opts.stableMs || 4000) / poll));
  const maxPolls = Math.ceil((opts.timeoutMs || 180000) / poll);
  const run = s => wc.executeJavaScript(s, true);
  const need = msg => Object.assign(new ProviderError(msg, { retryable: false }), { kind: 'auth' });
  if (LOGIN_URL.test(wc.getURL())) throw need('로그인이 필요합니다. 지브스 브라우저에서 해당 사이트에 직접 로그인한 뒤 다시 시도하세요.');
  // 화면이 아직 그려지지 않았을 수 있어(요즘 사이트는 열린 뒤에 입력칸을 그림) 입력칸이 나타날 때까지 최대 20초 기다린다
  let prep = await run(prepareScript(sel));
  for (let i = 0; i < Math.ceil((opts.prepareWaitMs == null ? 20000 : opts.prepareWaitMs) / 1000) && (!prep || !prep.ok) && !LOGIN_URL.test((prep && prep.url) || ''); i++) { await sleep(1000); prep = await run(prepareScript(sel)); }
  if (!prep || !prep.ok) throw need(LOGIN_URL.test((prep && prep.url) || '') ? '로그인이 필요합니다. 지브스 브라우저에서 직접 로그인해 주세요.' : `대화 입력창을 찾지 못했습니다(주소 ${(prep && prep.url) || '?'}, 입력칸 후보: textarea ${prep && prep.n ? prep.n.ta : '?'}개·편집영역 ${prep && prep.n ? prep.n.ce : '?'}개·textbox ${prep && prep.n ? prep.n.tb : '?'}개·input ${prep && prep.n ? prep.n.ip : '?'}개, 화면 글자 수 ${prep && prep.n ? prep.n.len : '?'}, 그중 보이는 것 ${prep && prep.n ? prep.n.vis : '?'}개). 로그인 상태와 화면을 확인하세요.`);
  await run(fillScript(text));
  const how = await run(sendScript(sel));
  if (how === 'none') {
    // 보내기 버튼을 못 찾으면 실제 Enter 키를 보낸다
    try { wc.focus && wc.focus(); wc.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' }); wc.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' }); } catch (_) {}
  }
  let last = '', same = 0;
  for (let i = 0; i < maxPolls; i++) {
    await sleep(poll);
    const s = await run(pollScript);
    const ans = extractAnswer(s.text, text);
    if (ans && ans === last && !s.busy) { if (++same >= stableNeed) return ans; }
    else { same = 0; last = ans; }
  }
  if (last) return last;   // 시간이 다 됐어도 받은 부분이 있으면 돌려준다
  throw Object.assign(new ProviderError('답변이 시간 안에 오지 않았습니다(질문이 보내졌는지 화면을 확인하세요).', { retryable: false }), { kind: 'server' });
}

// providers.js 의 ADAPTERS 에 등록되는 함수: 다른 공급자와 같은 모양으로 답을 돌려준다.
async function callWebChat(p, model, req) {
  if (req && req.tools && req.tools.length) { const e = new ProviderError(`'${p.label}'은(는) 웹 대화창 방식이라 도구 호출(파일 만들기 등)을 지원하지 않습니다.`); e.kind = 'none'; throw e; }
  if (!host) { const e = new ProviderError('웹 로그인형 공급자는 지브스 앱 안에서만 쓸 수 있습니다.'); e.kind = 'none'; throw e; }
  const prompt = buildPrompt(req);
  if (!prompt) throw new ProviderError('보낼 질문이 비어 있습니다.');
  const job = chain.then(async () => {
    const wc = await host(p);
    const ans = await askWebChat(wc, prompt, { selectors: p.selectors, timeoutMs: p.timeoutMs, pollMs: p.pollMs, stableMs: p.stableMs });
    if (ans.length < 200 && LIMIT_TXT.test(ans)) { const e = new ProviderError(`${p.label}: 사용 한도에 걸린 것으로 보입니다 — ${ans.slice(0, 80)}`); e.kind = 'limit'; throw e; }
    return ans;
  });
  chain = job.catch(() => {});
  const text = await job;
  return { content: [{ type: 'text', text }], stopReason: 'end_turn', usage: { input: 0, output: 0 } };
}

module.exports = { callWebChat, askWebChat, setWebChatHost, buildPrompt, extractAnswer };

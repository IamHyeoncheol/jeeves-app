// Jeeves 화면 동작
const $ = s => document.querySelector(s);
const $$ = s => Array.from(document.querySelectorAll(s));
const api = window.jeeves;

let tabList = [];
let cfg = null;
let mode = 'ask';
const cards = new Map(); // taskId → 작업 카드 상태

// ── 안전한 마크다운 표시(간단 버전) ─────────────────────
function esc(s) { return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function inline(s) {
  return s.replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" data-link="$2">$1</a>');
}
function md(text) {
  const lines = esc(text || '').split('\n');
  let html = '', list = null, table = [];
  const flushTable = () => {
    if (!table.length) return;
    const rows = table.filter(r => !/^\|?\s*:?-{2,}/.test(r));
    html += '<table>' + rows.map((r, i) => '<tr>' + r.replace(/^\||\|$/g, '').split('|').map(c => i === 0 ? `<th>${inline(c.trim())}</th>` : `<td>${inline(c.trim())}</td>`).join('') + '</tr>').join('') + '</table>';
    table = [];
  };
  const closeList = () => { if (list) { html += `</${list}>`; list = null; } };
  for (const ln of lines) {
    if (/^\s*\|.*\|\s*$/.test(ln)) { closeList(); table.push(ln.trim()); continue; }
    flushTable();
    let m;
    if ((m = ln.match(/^#{1,4}\s+(.*)/))) { closeList(); html += `<h3>${inline(m[1])}</h3>`; }
    else if ((m = ln.match(/^\s*[-*•]\s+(.*)/))) { if (list !== 'ul') { closeList(); html += '<ul>'; list = 'ul'; } html += `<li>${inline(m[1])}</li>`; }
    else if ((m = ln.match(/^\s*\d+[.)]\s+(.*)/))) { if (list !== 'ol') { closeList(); html += '<ol>'; list = 'ol'; } html += `<li>${inline(m[1])}</li>`; }
    else if (!ln.trim()) { closeList(); }
    else { closeList(); html += `<p>${inline(ln)}</p>`; }
  }
  flushTable(); closeList();
  return html;
}
document.addEventListener('click', e => {
  const a = e.target.closest('a[data-link]');
  if (a) { e.preventDefault(); api.tabs.create(a.dataset.link); }
});

// ── 탭 ───────────────────────────────────────────────
function renderTabs() {
  const box = $('#tabs');
  box.innerHTML = '';
  for (const t of tabList) {
    const el = document.createElement('div');
    el.className = 'tab' + (t.active ? ' active' : '') + (t.agent ? ' agent' : '');
    el.title = `${t.title}\n${t.url}`;
    const ic = t.loading ? '<span class="dot spin"></span>' : (t.favicon ? `<img src="${esc(t.favicon)}" alt="">` : '<span class="dot"></span>');
    el.innerHTML = `${ic}<span class="t">${esc(t.title || t.url || '새 탭')}</span><button class="x" title="닫기">✕</button>`;
    el.addEventListener('mousedown', e => { if (e.button === 1) { api.tabs.close(t.id); e.preventDefault(); } });
    el.addEventListener('click', e => { if (e.target.classList.contains('x')) api.tabs.close(t.id); else api.tabs.activate(t.id); });
    box.appendChild(el);
  }
  const a = tabList.find(t => t.active);
  if (a && document.activeElement !== $('#address')) $('#address').value = a.url === 'about:blank' ? '' : a.url;
  $('#back').disabled = !(a && a.canGoBack);
  $('#forward').disabled = !(a && a.canGoForward);
  $('#reload').textContent = a && a.loading ? '✕' : '↻';
  $('#web-placeholder').style.display = tabList.length ? 'none' : 'grid';
}
api.tabs.onUpdate(list => { tabList = list; renderTabs(); });
const activeId = () => (tabList.find(t => t.active) || {}).id;
$('#newtab').onclick = () => api.tabs.create();
$('#back').onclick = () => api.tabs.nav(activeId(), 'back');
$('#forward').onclick = () => api.tabs.nav(activeId(), 'forward');
$('#reload').onclick = () => { const a = tabList.find(t => t.active); api.tabs.nav(activeId(), a && a.loading ? 'stop' : 'reload'); };
$('#addr-form').onsubmit = e => { e.preventDefault(); const v = $('#address').value.trim(); if (v) { api.tabs.navigate(activeId(), v); $('#address').blur(); } };
$('#address').addEventListener('focus', e => e.target.select());
api.ui.onFocusAddress(() => $('#address').focus());
api.ui.onFocusChat(() => { setLayout(layout === 'chat' ? 'web' : 'chat'); if (layout === 'chat') $('#input').focus(); });

// 웹 화면 영역의 위치·크기를 메인 프로세스에 알려 준다
const web = $('#web-area');
function pushBounds() { const r = web.getBoundingClientRect(); api.layout.setBounds({ x: r.left, y: r.top, width: r.width, height: r.height }); }
new ResizeObserver(pushBounds).observe(web);
window.addEventListener('resize', pushBounds);

// ── 화면 배치: 'chat' = 작업 화면 중심(웹은 오른쪽 미리보기), 'web' = 웹 크게 ──
let layout = 'chat';
let settingsOpen = false;
function setLayout(next, { save = true } = {}) {
  layout = next === 'web' ? 'web' : 'chat';
  document.body.classList.toggle('layout-chat', layout === 'chat');
  document.body.classList.toggle('layout-web', layout === 'web');
  const b = $('#toggle-layout');
  b.textContent = layout === 'chat' ? '⤢ 웹 크게 보기' : '⤡ 작업 화면으로';
  b.classList.toggle('on', layout === 'web');
  api.layout.hideWeb(layout === 'chat' || settingsOpen);
  requestAnimationFrame(pushBounds);
  if (save && cfg && cfg.ui && cfg.ui.layout !== layout) api.config.update({ ui: { layout } }).then(c => { cfg = c; });
  refreshPreview(true);
}
$('#toggle-layout').onclick = () => setLayout(layout === 'chat' ? 'web' : 'chat');
function openTabBig(id) { if (id) api.tabs.activate(id); setLayout('web'); }

// 오른쪽 미리보기: 보고 있는 탭 + 에이전트 탭들을 축소 캡처로 보여 준다 (작업 화면일 때만, 1.5초마다)
let pvBusy = false, pvTick = 0;
async function refreshPreview(force) {
  if (pvBusy || (document.hidden && !force)) return;
  pvBusy = true;
  try {
    if (layout !== 'chat') { // 웹 크게 보기 중에는 열린 카드 화면만 갱신
      for (const [, c] of cards) if (c.shotOpen && c.tabId) { const src = await api.tabs.thumb(c.tabId, 1100); if (src) c.shotImg.src = src; }
      return;
    }
    const a = tabList.find(t => t.active);
    $('#pv-tabtitle').textContent = a ? (a.title || '새 탭') : '';
    $('#pv-url').textContent = a ? a.url : '';
    if (a) {
      const src = await api.tabs.thumb(a.id, thumbW($('#pv-main')));
      if (src) { $('#pv-img').src = src; $('#pv-empty').style.display = 'none'; }
      else { $('#pv-img').removeAttribute('src'); $('#pv-empty').style.display = 'grid'; $('#pv-empty').textContent = a.loading ? '불러오는 중…' : '빈 페이지'; }
    }
    pvTick++;
    const agents = tabList.filter(t => t.agent && !t.active);
    $('#pv-agents-head').style.display = agents.length ? 'block' : 'none';
    const box = $('#pv-agents');
    // 목록 갱신
    const want = agents.map(t => String(t.id)).join(',');
    if (box.dataset.ids !== want) {
      box.dataset.ids = want;
      box.innerHTML = agents.map(t => `<button class="pv-agent" data-tab="${t.id}" title="${esc(t.title)}"><span class="thumb"><img alt=""></span><span class="cap">${t.loading ? '⏳ ' : ''}${esc(t.title || '에이전트 탭')}</span></button>`).join('');
    }
    for (const t of agents) { const cap = box.querySelector(`[data-tab="${t.id}"] .cap`); if (cap) cap.textContent = (t.loading ? '⏳ ' : '') + (t.title || '에이전트 탭'); }
    if (force || pvTick % 2 === 0) {
      for (const t of agents) {
        const el = box.querySelector(`[data-tab="${t.id}"] img`);
        const src = el && await api.tabs.thumb(t.id, thumbW(el.parentElement));
        if (el && src) el.src = src;
      }
    }
    // 열려 있는 작업 카드 화면도 갱신
    for (const [, c] of cards) if (c.shotOpen && c.tabId) { const src = await api.tabs.thumb(c.tabId, 1100); if (src) c.shotImg.src = src; }
  } finally { pvBusy = false; }
}
setInterval(refreshPreview, 1500);
$('#pv-main').onclick = () => openTabBig(activeId());

// ── 구분선 끌어서 크기 조절 ──
// 작업 화면 중심: 오른쪽 미리보기 폭 / 웹 크게 보기: 오른쪽 작업창 폭
const SIZE = { preview: { def: 400, min: 260, keepOther: 420 }, panel: { def: 420, min: 340, keepOther: 420 } };
const sizes = { preview: 400, panel: 420 };
function thumbW(el) { return Math.min(1440, Math.max(200, Math.round((el ? el.clientWidth : 400) * (window.devicePixelRatio || 1)))); }
function applySizes() {
  const total = $('#body').clientWidth;
  for (const k of ['preview', 'panel']) sizes[k] = Math.round(Math.min(Math.max(sizes[k], SIZE[k].min), Math.max(SIZE[k].min, total - SIZE[k].keepOther)));
  document.body.style.setProperty('--preview-w', sizes.preview + 'px');
  document.body.style.setProperty('--panel-w', sizes.panel + 'px');
  requestAnimationFrame(pushBounds);
}
function saveSizes() { if (cfg && cfg.ui) api.config.update({ ui: { previewWidth: sizes.preview, panelWidth: sizes.panel } }).then(c => { cfg = c; }); }
let pvResizeTimer = null;
function afterResize() { clearTimeout(pvResizeTimer); pvResizeTimer = setTimeout(() => refreshPreview(true), 250); } // 커진 크기에 맞는 선명한 미리보기로 다시 캡처
(() => {
  const sp = $('#splitter');
  const key = () => (layout === 'chat' ? 'preview' : 'panel');
  sp.addEventListener('pointerdown', e => {
    if (e.button !== 0) return;
    e.preventDefault();
    document.body.classList.add('resizing');
    if (layout === 'web') api.layout.hideWeb(true); // 웹 화면 위로 끌 때 마우스가 웹 화면에 빼앗기지 않도록 잠시 숨김
    const right = $('#body').getBoundingClientRect().right;
    const k = key();
    const move = ev => { sizes[k] = right - ev.clientX; applySizes(); };
    const up = () => {
      window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); window.removeEventListener('blur', up);
      document.body.classList.remove('resizing');
      if (layout === 'web' && !settingsOpen) api.layout.hideWeb(false);
      applySizes(); saveSizes(); afterResize();
    };
    // 창 전체에서 받는다 (웹 화면을 잠시 숨기는 순간 끌기가 끊기지 않게)
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up); window.addEventListener('blur', up);
  });
  sp.addEventListener('dblclick', () => { sizes[key()] = SIZE[key()].def; applySizes(); saveSizes(); afterResize(); });
  sp.addEventListener('keydown', e => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    sizes[key()] += (e.key === 'ArrowLeft' ? 1 : -1) * (e.shiftKey ? 80 : 20);
    applySizes(); saveSizes(); afterResize();
  });
  window.addEventListener('resize', () => applySizes());
})();
$('#pv-open').onclick = () => openTabBig(activeId());
$('#pv-agents').addEventListener('click', e => { const b = e.target.closest('[data-tab]'); if (b) openTabBig(Number(b.dataset.tab)); });
setLayout('chat', { save: false });

// ── 패널 보기 전환 ─────────────────────────────────────
$$('#panel-tabs button').forEach(b => b.onclick = () => {
  $$('#panel-tabs button').forEach(x => x.classList.toggle('on', x === b));
  $$('.view').forEach(v => v.classList.toggle('on', v.id === 'view-' + b.dataset.view));
  if (b.dataset.view === 'history') renderHistory();
});

function setMode(m) {
  mode = m;
  document.body.classList.toggle('mode-ask', m === 'ask');
  document.body.classList.toggle('mode-act', m === 'act');
  $$('#mode button').forEach(b => b.classList.toggle('on', b.dataset.mode === m));
  $('#input').placeholder = m === 'ask' ? '질문을 입력하세요 (Enter 보내기, Shift+Enter 줄바꿈)' : '시킬 일을 구체적으로 적어 주세요. 예) 네이버에서 가양역 근처 회의실 대여 3곳 찾아서 가격 비교';
}
$$('#mode button').forEach(b => b.onclick = () => setMode(b.dataset.mode));
setMode('ask');

// ── 메시지 ────────────────────────────────────────────
const box = $('#messages');
function scrollDown() { box.scrollTop = box.scrollHeight; }
function addUser(text, tag) {
  const d = document.createElement('div');
  d.className = 'msg user';
  d.innerHTML = (tag ? `<span class="tag">${esc(tag)}</span>` : '') + esc(text);
  box.appendChild(d); scrollDown();
}
function addAI(text, meta) {
  const d = document.createElement('div');
  d.className = 'msg ai md';
  d.innerHTML = md(text) + (meta ? `<div class="meta">${esc(meta)}</div>` : '');
  box.appendChild(d); scrollDown();
  return d;
}
function addErr(text) {
  const d = document.createElement('div');
  d.className = 'msg err';
  d.innerHTML = '⚠ ' + esc(text) + (/API 키/.test(text) ? ' <button class="link" data-open-settings>설정 열기</button>' : '');
  box.appendChild(d); scrollDown();
}
box.addEventListener('click', e => { if (e.target.matches('[data-open-settings]')) openSettings(); });

async function sendMessage(textOverride, opts = {}) {
  const text = (textOverride !== undefined ? textOverride : $('#input').value).trim();
  const isSummary = opts.summarize;
  if (!text && !isSummary) return;
  $('#input').value = '';
  const welcome = box.querySelector('.welcome');
  if (welcome) welcome.remove();

  if (mode === 'act' && !isSummary) {
    const where = $('#where').value;
    addUser(text, where === 'current' ? '🤖 작업 · 지금 탭' : '🤖 작업 · 백그라운드 탭');
    const r = await api.agent.start(text, where);
    if (r.error) { addErr(r.error); return; }
    ensureCard(r.id, { goal: text });
    return;
  }
  addUser(isSummary ? '이 페이지를 요약해 주세요.' : text, isSummary ? '📄 요약' : ($('#include-page').checked ? '💬 질문 · 페이지 포함' : '💬 질문'));
  const wait = document.createElement('div');
  wait.className = 'msg ai typing';
  box.appendChild(wait); scrollDown();
  $('#send').disabled = true;
  const res = await api.chat.send(text, { includePage: $('#include-page').checked, mode: isSummary ? 'summarize' : 'chat' });
  wait.remove();
  $('#send').disabled = false;
  if (res.ok) addAI(res.text, res.model + (res.costKrw != null ? ` · 약 ${res.costKrw}원` : '')); else addErr(res.error);
}
$('#send').onclick = () => sendMessage();
$('#input').addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); sendMessage(); }
});
$('#reset-chat').onclick = async () => { await api.chat.reset(); box.innerHTML = ''; addAI('새 대화를 시작합니다. 이전 대화 내용은 AI가 더 이상 참고하지 않습니다.'); };
box.addEventListener('click', e => {
  const q = e.target.closest('[data-quick]');
  if (!q) return;
  if (q.dataset.quick === 'summarize') sendMessage('', { summarize: true });
  if (q.dataset.quick === 'example') { setMode('act'); $('#input').value = '구글에서 "전기안전관리법 시행규칙 개정" 최신 뉴스를 검색해서 상위 3개 기사의 제목, 언론사, 날짜, 핵심 내용을 정리해 줘'; $('#input').focus(); }
});

// ── 작업 카드 ───────────────────────────────────────────
const ICON = { start: '▶', thinking: '…', observe: '👁', say: '💭', action: '✓', blocked: '⛔', confirm: '❓', ask: '❓', error: '⚠', done: '■' };
function ensureCard(id, { goal } = {}) {
  if (cards.has(id)) return cards.get(id);
  const el = document.createElement('div');
  el.className = 'card';
  el.innerHTML = `<div class="card-head"><span class="badge run">진행 중</span><span class="ttl">${esc(goal || '작업 #' + id)}</span><span class="cost" title="이 작업의 AI 사용 비용(추정)">0원</span>
    <button data-act="shot" title="작업 화면을 이 카드 안에서 원래 비율로 보기">📷 화면</button><button data-act="show" title="웹 화면 크게 보기">⤢ 크게</button><button data-act="stop">중지</button></div>
    <div class="card-shot hidden"><div class="cs-bar"><span>실시간 화면 (1.5초마다 갱신) · 클릭하면 크게</span><span class="cs-close" style="cursor:pointer">닫기 ✕</span></div><img alt=""></div>
    <div class="steps"></div><div class="slot"></div><div class="result hidden md"></div>`;
  el.querySelector('[data-act=show]').onclick = async () => { await api.agent.showTab(id); setLayout('web'); };
  el.querySelector('[data-act=stop]').onclick = () => api.agent.stop(id);
  if (String(id).startsWith('ext')) { el.querySelector('[data-act=stop]').remove(); el.querySelector('.badge').textContent = '연결됨'; el.querySelector('.cost').textContent = '구독'; }
  box.appendChild(el); scrollDown();
  const c = { el, steps: el.querySelector('.steps'), slot: el.querySelector('.slot'), lastThinking: null, shotOpen: false, shotImg: el.querySelector('.card-shot img'), tabId: null };
  const shotBox = el.querySelector('.card-shot');
  const toggleShot = open => { c.shotOpen = open; shotBox.classList.toggle('hidden', !open); if (open) refreshPreview(true); };
  el.querySelector('[data-act=shot]').onclick = () => toggleShot(!c.shotOpen);
  el.querySelector('.cs-close').onclick = () => toggleShot(false);
  c.shotImg.onclick = async () => { await api.agent.showTab(id); setLayout('web'); };
  cards.set(id, c);
  return c;
}
function addStep(c, cls, icon, text) {
  const d = document.createElement('div');
  d.className = 'step ' + cls;
  d.innerHTML = `<span class="i">${icon}</span><span>${esc(text)}</span>`;
  c.steps.appendChild(d);
  c.steps.scrollTop = c.steps.scrollHeight;
  return d;
}
api.agent.onEvent(ev => {
  const c = ensureCard(ev.taskId, { goal: ev.goal });
  if (ev.tabId) c.tabId = ev.tabId;
  switch (ev.type) {
    case 'created': if (ev.title) c.el.querySelector('.ttl').textContent = ev.title; break;
    case 'engine': addStep(c, 'info', '🔗', ev.text); break;
    case 'limit': {
      const at = new Date(ev.resumeAt);
      c.el.querySelector('.badge').className = 'badge fail'; c.el.querySelector('.badge').textContent = '한도 대기';
      addStep(c, 'limit', '⏳', `구독 사용 한도에 도달 — ${at.toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}에 자동 재개${ev.known ? '' : ' (풀리는 시각을 못 읽어 30분 뒤 다시 시도)'}`);
      notify('Jeeves: 사용 한도 대기', '한도가 풀리면 자동으로 이어서 진행합니다.');
      break;
    }
    case 'resume': c.el.querySelector('.badge').className = 'badge run'; c.el.querySelector('.badge').textContent = '진행 중'; addStep(c, 'esc', '▶', ev.text); break;
    case 'title': c.el.querySelector('.ttl').textContent = ev.title; break;
    case 'start': addStep(c, '', ICON.start, `시작 (${ev.engine === 'claude-code' ? '🔗 구독: Claude Code' : ev.mode === 'hybrid' ? '⚡ Jev + Claude 혼합' : 'Claude만'}): ` + ev.goal); break;
    case 'cost': c.el.querySelector('.cost').textContent = ev.subscription ? '구독' : `${ev.unknown ? '≥' : ''}${ev.krw.toLocaleString()}원`; break;
    case 'escalate': addStep(c, 'esc', '⬆', `상위 모델로 넘김 — ${ev.reason}`); break;
    case 'info': addStep(c, 'info', 'ℹ', ev.text); break;
    case 'handoff': break;
    case 'thinking': if (c.lastThinking) c.lastThinking.remove(); c.lastThinking = addStep(c, 'thinking', ICON.thinking, `${ev.role === 'agentStrong' ? '상위 모델' : 'Claude'} 판단 중…`); break;
    case 'observe': break;
    case 'say': if (c.lastThinking) { c.lastThinking.remove(); c.lastThinking = null; } c.lastSay = { el: addStep(c, 'say', ICON.say, ev.text.slice(0, 300)), text: ev.text.trim() }; break;
    case 'action': if (c.lastThinking) { c.lastThinking.remove(); c.lastThinking = null; } addStep(c, (ev.ok ? '' : 'bad') + (ev.who === 'jev' ? ' jev' : ''), ev.who === 'jev' ? '⚡' : (ev.ok ? ICON.action : '✗'), `${ev.desc}${ev.ok ? '' : ' — ' + ev.message}`); break;
    case 'blocked': addStep(c, 'bad', ICON.blocked, `${ev.desc} — ${ev.why}`); break;
    case 'error': addStep(c, 'bad', ICON.error, ev.message); break;
    case 'confirm': {
      if (c.lastThinking) { c.lastThinking.remove(); c.lastThinking = null; }
      c.slot.innerHTML = `<div class="prompt"><div class="q">이 동작을 실행할까요?</div><div>${esc(ev.desc)}</div><div class="why">이유: ${esc(ev.why)}</div>
        <div class="acts"><button class="primary" data-a="ok">허용</button><button class="ghost" data-a="no">거절</button><button class="ghost" data-a="view">탭 보고 판단</button></div></div>`;
      c.slot.querySelector('[data-a=ok]').onclick = () => { c.slot.innerHTML = ''; addStep(c, '', '👍', '사용자 허용'); api.agent.respond(ev.taskId, { ok: true }); };
      c.slot.querySelector('[data-a=no]').onclick = () => { c.slot.innerHTML = ''; addStep(c, 'bad', '✋', '사용자 거절'); api.agent.respond(ev.taskId, { ok: false }); };
      c.slot.querySelector('[data-a=view]').onclick = async () => { await api.agent.showTab(ev.taskId); setLayout('web'); };
      scrollDown(); notify('Jeeves: 확인이 필요합니다', ev.desc);
      break;
    }
    case 'ask': {
      if (c.lastThinking) { c.lastThinking.remove(); c.lastThinking = null; }
      c.slot.innerHTML = `<div class="prompt ask"><div class="q">${esc(ev.question)}</div><div class="why">직접 처리할 일(로그인 등)이 있으면 "탭 보기"로 해당 탭에서 처리한 뒤 답해 주세요.</div>
        <div class="acts"><input placeholder="답변 입력 (예: 로그인 완료)"><button class="primary">답변</button></div></div>`;
      const inp = c.slot.querySelector('input');
      const go = () => { const v = inp.value.trim() || '확인했습니다. 계속 진행하세요.'; c.slot.innerHTML = ''; addStep(c, '', '💬', '답변: ' + v); api.agent.respond(ev.taskId, { text: v }); };
      c.slot.querySelector('button').onclick = go;
      inp.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.isComposing) go(); });
      inp.focus(); scrollDown(); notify('Jeeves: 질문이 있습니다', ev.question);
      break;
    }
    case 'done': {
      if (c.lastThinking) { c.lastThinking.remove(); c.lastThinking = null; }
      c.slot.innerHTML = '';
      const b = c.el.querySelector('.badge');
      b.className = 'badge ' + (ev.success ? 'ok' : 'fail');
      b.textContent = ev.success ? '완료' : '중단';
      const sb = c.el.querySelector('[data-act=stop]'); if (sb) sb.remove();
      // 마지막 생각 메모가 최종 결과와 같으면 한 번만 보여 준다
      if (c.lastSay && c.lastSay.text && (ev.summary || '').trim() === c.lastSay.text) c.lastSay.el.remove();
      const r = c.el.querySelector('.result');
      r.classList.remove('hidden');
      r.innerHTML = md(ev.summary) + (ev.engine === 'claude-code' ? `<div class="stats">구독 사용(Claude Code)${ev.retries ? ` · 한도 대기 후 재개 ${ev.retries}회` : ''}${ev.estUsd ? ` · 참고용 추정 $${ev.estUsd.toFixed(3)} (구독이라 실제 청구 아님)` : ''}</div>` : `<div class="stats">비용 약 ${(ev.costKrw || 0).toLocaleString()}원${ev.costUnknown ? ' 이상(단가 모르는 모델 포함)' : ''} · Claude ${ev.llmCalls || 0}회 · Jev ${ev.jevCalls || 0}회(행동 ${ev.jevActs || 0}) · 행동 ${ev.actions || 0}${ev.escalated ? ' · 상위 모델 사용' : ''}</div>`);
      scrollDown(); notify(ev.success ? 'Jeeves: 작업 완료' : 'Jeeves: 작업 중단', ev.summary.slice(0, 100));
      break;
    }
  }
});

function notify(title, body) {
  if (document.hasFocus()) return;
  try { new Notification(title, { body }); } catch (_) {}
}

// ── 작업 기록 ───────────────────────────────────────────
async function renderHistory() {
  const list = await api.history();
  const el = $('#history-list');
  if (!list.length) { el.innerHTML = '<p class="muted">아직 작업 기록이 없습니다.</p>'; return; }
  el.innerHTML = list.map(h => `<div class="hist"><div class="h1"><span class="badge ${h.success ? 'ok' : 'fail'}">${h.success ? '완료' : '중단'}</span>${esc(h.title)}<span class="when">${new Date(h.at).toLocaleString('ko-KR')}</span></div>
    <div class="muted" style="font-size:12px;margin-top:2px">${esc(h.goal)}</div><div class="sum">${esc(h.summary || '')}</div>${h.costKrw != null ? `<div class="stats">약 ${h.costKrw.toLocaleString()}원 · Claude ${h.llmCalls || 0}회 · Jev ${h.jevCalls || 0}회</div>` : ''}</div>`).join('');
}

// ── 설정 ───────────────────────────────────────────────
function syncEngineBadge() {
  const b = $('#engine-badge'); if (!b || !cfg) return;
  const sub = cfg.engine && cfg.engine.type === 'claude-code';
  b.textContent = sub ? '구독' : 'API'; b.title = sub ? '작업 엔진: 내 구독(Claude Code)' : '작업 엔진: API 키 (사용량만큼 과금)';
  b.classList.toggle('sub', sub);
}
api.config.onUpdate(c => { cfg = c; syncEngineBadge(); });
async function openSettings(msg) {
  cfg = await api.config.get();
  settingsOpen = true;
  api.layout.hideWeb(true);
  $('#settings').classList.remove('hidden');
  const pv = $('#providers');
  pv.innerHTML = Object.entries(cfg.providers).map(([id, p]) => `
    <div class="prov ${p.disabled ? 'disabled' : ''}" data-id="${id}">
      <div class="nm">${esc(p.label)}${p.hasKey && id !== 'ollama' ? ' <span class="badge ok">키 있음</span>' : ''}</div>
      <input data-k="apiKey" type="password" placeholder="${p.disabled ? '고도화 단계에서 연결' : 'API 키'}" value="${esc(p.apiKey)}" ${p.disabled ? 'disabled' : ''}>
      <input data-k="baseUrl" placeholder="주소" value="${esc(p.baseUrl)}" title="접속 주소(보통 바꿀 필요 없음)" ${p.disabled ? 'disabled' : ''}>
    </div>`).join('');
  const provOpts = Object.entries(cfg.providers).map(([id, p]) => `<option value="${id}">${esc(p.label)}</option>`).join('');
  $('#roles').innerHTML = Object.entries(cfg.roles).map(([id, r]) => `
    <div class="role" data-id="${id}">
      <div class="nm">${esc(r.label)}</div>
      <select data-k="provider">${provOpts}</select>
      <input data-k="model" list="model-suggestions" value="${esc(r.model)}" placeholder="모델 이름">
      <select data-k="effort" title="생각 깊이(effort)"><option value="">기본</option><option value="low">낮음</option><option value="medium">중간</option><option value="high">높음</option></select>
      <button class="ghost" data-test="${id}">연결 테스트</button>
      <div class="res muted"></div>
    </div>`).join('');
  $$('#roles .role').forEach(row => { const r = cfg.roles[row.dataset.id]; row.querySelector('[data-k=provider]').value = r.provider; row.querySelector('[data-k=effort]').value = r.effort || ''; });
  $$('#roles [data-test]').forEach(b => b.onclick = async () => {
    await saveSettings(true);
    const res = b.parentElement.querySelector('.res');
    res.textContent = '테스트 중…';
    const r = await api.config.test(b.dataset.test);
    res.textContent = r.ok ? `✅ 연결됨 — ${r.model} (응답: ${r.text})` : `❌ ${r.error}`;
  });
  const a = cfg.agent;
  $('#agent-mode').value = a.mode; $('#jev-conf').value = a.jevConfidence; $('#shot-mode').value = a.screenshotMode;
  $('#escalate').checked = a.escalate; $('#budget').value = a.budgetKrw; $('#krw-rate').value = cfg.ui.krwPerUsd;
  $('#confirm-mode').value = a.confirmMode;
  $('#max-steps').value = a.maxSteps;
  $('#homepage').value = cfg.ui.homepage;
  $('#engine-type').value = cfg.engine.type; $('#cc-path').value = cfg.engine.claudePath || ''; $('#cc-model').value = cfg.engine.claudeModel || '';
  refreshMcp(); checkClaude(false);
  const u = await api.usage();
  const rows = Object.entries(u.byRole);
  const total = rows.reduce((t, [, v]) => t + v.usd, 0);
  $('#usage').innerHTML = rows.length
    ? rows.map(([k, v]) => `${esc((cfg.roles[k] || {}).label || k)}: ${v.calls}회 · 입력 ${v.input.toLocaleString()} / 캐시읽기 ${v.cacheRead.toLocaleString()} / 출력 ${v.output.toLocaleString()} 토큰 · 약 ${Math.round(v.usd * u.krwPerUsd).toLocaleString()}원${v.unknownCost ? '+' : ''}`).join('<br>') + `<br><b>합계 약 ${Math.round(total * u.krwPerUsd).toLocaleString()}원</b> ($${total.toFixed(4)})`
    : '아직 사용 기록이 없습니다.';
  $('#save-msg').textContent = cfg.encryptionAvailable ? '' : '⚠ 이 PC에서는 키 암호화 저장 불가 — 앱을 끄면 키가 지워집니다.';
  if (typeof msg === 'string') $('#save-msg').textContent = msg;
}
function closeSettings() { settingsOpen = false; $('#settings').classList.add('hidden'); api.layout.hideWeb(layout === 'chat'); }
async function saveSettings(quiet) {
  const patch = { providers: {}, roles: {}, agent: {}, ui: {} };
  $$('#providers .prov').forEach(row => {
    const id = row.dataset.id;
    patch.providers[id] = { apiKey: row.querySelector('[data-k=apiKey]').value.trim(), baseUrl: row.querySelector('[data-k=baseUrl]').value.trim() };
  });
  $$('#roles .role').forEach(row => {
    patch.roles[row.dataset.id] = { provider: row.querySelector('[data-k=provider]').value, model: row.querySelector('[data-k=model]').value.trim(), effort: row.querySelector('[data-k=effort]').value };
  });
  const num = (v, lo, hi, d) => { const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; };
  patch.agent = {
    mode: $('#agent-mode').value, jevConfidence: num($('#jev-conf').value, 0.3, 0.99, 0.7), screenshotMode: $('#shot-mode').value,
    escalate: $('#escalate').checked, budgetKrw: num($('#budget').value, 0, 1e7, 500),
    confirmMode: $('#confirm-mode').value, maxSteps: num($('#max-steps').value, 5, 100, 30)
  };
  patch.engine = { type: $('#engine-type').value, claudePath: $('#cc-path').value.trim(), claudeModel: $('#cc-model').value };
  patch.ui = { homepage: $('#homepage').value.trim() || 'https://www.google.com', krwPerUsd: num($('#krw-rate').value, 500, 5000, 1400) };
  cfg = await api.config.update(patch);
  if (!quiet) { $('#save-msg').textContent = '저장했습니다.'; setTimeout(() => { $('#save-msg').textContent = ''; }, 2000); }
}
$('#open-settings').onclick = () => openSettings();
async function refreshMcp() {
  const st = await api.mcp.status();
  $('#mcp-status').textContent = st.running ? `✅ 열림 — ${st.url} (외부 호출 ${st.calls}회)` : `❌ 닫힘${st.error ? ' — ' + st.error : ''}`;
  $('#cmd-claude').textContent = `claude mcp add --transport http --scope user jeeves ${st.url} --header "Authorization: Bearer ${st.token}"`;
  $('#cmd-codex').textContent = `[mcp_servers.jeeves]\nurl = "${st.url}"\nhttp_headers = { "Authorization" = "Bearer ${st.token}" }`;
}
async function checkClaude(show) {
  $('#cc-status').textContent = '찾는 중…';
  const r = await api.cc.check($('#cc-path').value.trim());
  $('#cc-status').textContent = r.ok ? `✅ 찾음 — ${r.path}${r.version ? ' (' + r.version + ')' : ''}` : '❌ 설치되지 않음 — 아래 설치 방법 참고';
}
$('#cc-check').onclick = () => checkClaude(true);
$('#mcp-regen').onclick = async () => {
  if (!confirm('토큰을 새로 만들면 Claude Code·Codex에 등록한 연결을 다시 등록해야 합니다. 계속할까요?')) return;
  await api.mcp.restart(true); refreshMcp();
};
document.addEventListener('click', async e => {
  const t = e.target.closest('[data-copy-target],[data-copy]');
  if (!t) return;
  const text = t.dataset.copy || $('#' + t.dataset.copyTarget).textContent;
  try { api.copy(text); const o = t.textContent; t.textContent = '복사됨 ✓'; setTimeout(() => { t.textContent = o; }, 1200); } catch (_) {}
});
$('#import-keys').onclick = async () => {
  const r = await api.config.importKeys();
  if (r.cancelled) return;
  $('#import-msg').textContent = r.ok ? `✅ 불러옴: ${r.found.join(', ')} — 이제 원본 txt 파일은 지우는 것을 권합니다.` : '❌ ' + r.error;
  if (r.ok) openSettings('');
};
$('#close-settings').onclick = closeSettings;
$('#save-settings').onclick = () => saveSettings(false);
$('#settings').addEventListener('click', e => { if (e.target.id === 'settings') closeSettings(); });
document.addEventListener('keydown', e => { if (e.key === 'Escape' && !$('#settings').classList.contains('hidden')) closeSettings(); });

// 첫 실행: Anthropic 키가 없으면 설정을 연다
api.config.get().then(c => { cfg = c; sizes.preview = c.ui.previewWidth || 400; sizes.panel = c.ui.panelWidth || 420; applySizes(); setLayout(c.ui.layout || 'chat', { save: false }); syncEngineBadge(); if (!c.providers.anthropic.hasKey && c.engine.type !== 'claude-code') setTimeout(() => openSettings('먼저 Anthropic API 키를 입력하고 저장해 주세요.'), 600); });

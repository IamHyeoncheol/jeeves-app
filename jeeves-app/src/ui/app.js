// Jeeves 화면 동작
const $ = s => document.querySelector(s);
const $$ = s => Array.from(document.querySelectorAll(s));
const api = window.jeeves;

let tabList = [];
let cfg = null;
// 대화·작업별 정보 등급 (P 공개 < I 내부 < C 기밀 < S 비밀). 시작값은 설정의 기본 등급.
const GRADE_ORDER = ['P', 'I', 'C', 'S'];
const gradeRank = g => Math.max(0, GRADE_ORDER.indexOf(g));
let chatGrade = 'I';
function setChatGrade(g) {
  if (!GRADE_ORDER.includes(g)) return;
  chatGrade = g;
}
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
  $('#input').placeholder = m === 'ask' ? '무엇이든 물어보세요 (Enter 보내기, Shift+Enter 줄바꿈)' : '시킬 일을 구체적으로 적어 주세요. 예) 네이버에서 가양역 근처 회의실 대여 3곳 찾아서 가격 비교';
}
$$('#mode button').forEach(b => b.onclick = () => setMode(b.dataset.mode));
setMode('ask');

// ── 메시지 ────────────────────────────────────────────
const box = $('#messages');
function scrollDown() { box.scrollTop = box.scrollHeight; }
// 메시지 아래 작은 동작 단추 줄
function actBar(buttons) {
  const bar = document.createElement('div');
  bar.className = 'msg-actions';
  for (const [key, label, title] of buttons) { const b = document.createElement('button'); b.dataset.act = key; b.textContent = label; b.title = title; bar.appendChild(b); }
  return bar;
}
// info: { kind: 'chat' | 'sum' | 'act', page: 지금 페이지 포함 여부 }
function addUser(text, tag, info) {
  const d = document.createElement('div');
  d.className = 'msg user';
  d.innerHTML = (tag ? `<span class="tag">${esc(tag)}</span>` : '') + `<span class="body">${esc(text)}</span>`;
  d._raw = text; d._info = info || { kind: 'chat' };
  const k = d._info.kind;
  d.appendChild(actBar(k === 'chat' ? [['copy', '복사', '복사'], ['edit', '수정', '고쳐서 다시 보내기'], ['retry', '재시도', '같은 질문 다시 보내기']] : k === 'sum' ? [['copy', '복사', '복사'], ['retry', '재시도', '다시 요약']] : [['copy', '복사', '복사']]));
  box.appendChild(d); scrollDown();
}
// 답변(대화·요약): 복사·내보내기·공유·소리내어 읽기·좋은/나쁜 답변·재시도
function addAI(text, meta, chat) {
  const d = document.createElement('div');
  d.className = 'msg ai md';
  d.innerHTML = md(text) + (meta ? `<div class="meta">${esc(meta)}</div>` : '');
  if (chat) {
    d.dataset.chat = '1'; d._raw = text; d._meta = meta || '';
    d.appendChild(actBar([['copy', '복사', '답변 복사'], ['export', '내보내기', '파일로 저장'], ['share', '공유', '다른 앱으로 공유'], ['speak', '🔊 읽기', '소리내어 읽기'], ['good', '👍', '좋은 답변'], ['bad', '👎', '나쁜 답변'], ['retry', '재시도', '다시 답변 받기']]));
  }
  box.appendChild(d); scrollDown();
  return d;
}
function toastIn(el, t) {
  let n = el.querySelector('.msg-toast'); if (!n) { n = document.createElement('div'); n.className = 'msg-toast muted small'; el.appendChild(n); }
  n.textContent = t; clearTimeout(n._t); n._t = setTimeout(() => n.remove(), 2500);
}
function plainText(t) { return String(t || '').replace(/```[\s\S]*?```/g, ' ').replace(/[*_`#>|]/g, '').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1'); }
// 이 메시지(질문)부터 아래 메시지를 화면에서 지우고, 대화 기록도 그 앞까지만 남긴다
async function cutFrom(userEl) {
  const k = [...box.querySelectorAll('.msg.ai[data-chat]')].filter(a => userEl.compareDocumentPosition(a) & Node.DOCUMENT_POSITION_PRECEDING).length;
  let n = userEl;
  while (n) { const nx = n.nextElementSibling; if (n.classList.contains('msg')) n.remove(); n = nx; }
  await api.chat.truncate(k);
}
function userBefore(aiEl) { let n = aiEl.previousElementSibling; while (n && !n.classList.contains('user')) n = n.previousElementSibling; return n; }
box.addEventListener('click', async e => {
  const btn = e.target.closest('.msg-actions button'); if (!btn) return;
  const msg = btn.closest('.msg'); const act = btn.dataset.act; const raw = msg._raw || '';
  if (act === 'copy') { try { await api.copy(raw); toastIn(msg, '복사했습니다'); } catch (_) {} return; }
  if (msg.classList.contains('user')) {
    if (act === 'edit') { await cutFrom(msg); $('#input').value = raw; setMode('ask'); $('#input').focus(); return; }
    if (act === 'retry') { const info = msg._info; await cutFrom(msg); sendMessage(info.kind === 'sum' ? '' : raw, info.kind === 'sum' ? { summarize: true } : { includePage: info.page }); return; }
    return;
  }
  const u = userBefore(msg);
  if (act === 'retry') { if (!u) return; const info = u._info, rawQ = u._raw; await cutFrom(u); sendMessage(info.kind === 'sum' ? '' : rawQ, info.kind === 'sum' ? { summarize: true } : { includePage: info.page }); return; }
  if (act === 'export') {
    const q = u ? u._raw : '';
    const r = await api.chat.exportText(`Jeeves_답변_${new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '')}.md`, `# 질문\n\n${q}\n\n# 답변\n\n${raw}\n\n---\n${msg._meta || ''}\n`);
    toastIn(msg, r.ok ? '저장했습니다: ' + r.path : (r.canceled ? '취소했습니다' : '저장 실패: ' + (r.error || ''))); return;
  }
  if (act === 'share') {
    try { if (navigator.share) { await navigator.share({ title: 'Jeeves 답변', text: raw }); return; } } catch (er) { if (er && er.name === 'AbortError') return; }
    try { await api.copy(raw); toastIn(msg, '이 PC에서는 공유창을 열 수 없어 복사했습니다. 메신저·메일에 붙여넣어 공유하세요'); } catch (_) {} return;
  }
  if (act === 'speak') {
    const ss = window.speechSynthesis; if (!ss) { toastIn(msg, '이 PC에서는 소리내어 읽기를 쓸 수 없습니다'); return; }
    if (btn.dataset.on) { ss.cancel(); return; }
    ss.cancel();
    const ut = new SpeechSynthesisUtterance(plainText(raw)); ut.lang = 'ko-KR';
    const v = ss.getVoices().find(x => /^ko/i.test(x.lang)); if (v) ut.voice = v; else toastIn(msg, '한국어 음성이 없어 기본 음성으로 읽습니다(Windows 설정 → 음성에서 추가)');
    btn.dataset.on = '1'; btn.textContent = '■ 멈춤';
    const done = () => { delete btn.dataset.on; btn.textContent = '🔊 읽기'; };
    ut.onend = done; ut.onerror = done; ss.speak(ut); return;
  }
  if (act === 'good' || act === 'bad') {
    const was = btn.classList.contains('on');
    msg.querySelectorAll('[data-act="good"],[data-act="bad"]').forEach(b => b.classList.remove('on'));
    if (!was) btn.classList.add('on');
    await api.chat.feedback({ rating: was ? 'none' : act, model: msg._meta, grade: chatGrade, q: u ? u._raw : '', a: raw });
    toastIn(msg, was ? '표시를 취소했습니다' : (act === 'good' ? '좋은 답변으로 표시했습니다(이 PC에만 저장)' : '나쁜 답변으로 표시했습니다(이 PC에만 저장)'));
  }
});
function addErr(text) {
  const d = document.createElement('div');
  d.className = 'msg err';
  d.innerHTML = '⚠ ' + esc(text) + (/API 키/.test(text) ? ' <button class="link" data-open-settings>설정 열기</button>' : '');
  box.appendChild(d); scrollDown();
}
box.addEventListener('click', e => { if (e.target.matches('[data-open-settings]')) openSettings(); });

// 안내 카드: 실시간 정보가 필요한 질문. 반환: 'act'(작업 모드로 검색) | 'ask'(질문 모드 그대로) | 'cancel'
function askLive() {
  return new Promise(resolve => {
    const card = document.createElement('div');
    card.className = 'msg ai gradewarn';
    card.innerHTML = '<b>🌐 인터넷 검색이 필요한 질문입니다</b><br>지금 대화 방식(API 키)에서는 인터넷을 볼 수 없어 날씨·시세·최신 뉴스는 답하지 못합니다. <b>작업 모드</b>(구글 검색)로 보내면 직접 찾아 드립니다.<div class="gw-btns"></div>';
    const row = card.querySelector('.gw-btns');
    const mk = (label, cls, val) => { const b = document.createElement('button'); b.textContent = label; b.className = cls; b.onclick = () => { card.querySelectorAll('button').forEach(x => x.disabled = true); card.insertAdjacentHTML('beforeend', `<div class="muted small">선택: ${esc(label)}</div>`); resolve(val); }; row.appendChild(b); };
    mk('작업 모드로 검색 (추천)', 'primary', 'act');
    mk('그래도 대화로', 'ghost', 'ask');
    mk('취소', 'ghost', 'cancel');
    box.appendChild(card); scrollDown();
  });
}

// 경고 카드: 기밀·비밀로 보이는 말이 있을 때 대화창에 띄운다. 반환: 'raise'(추천 등급으로 진행) | 'keep'(현재 등급 그대로) | 'cancel'
function askGrade(d, where) {
  return new Promise(resolve => {
    const card = document.createElement('div');
    card.className = 'msg ai gradewarn';
    const words = (d.hits || []).map(h => `<code>${esc(h)}</code>`).join(' ');
    card.innerHTML = `<b>🔒 조심할 내용이 있습니다</b><br>${esc(where)}에 ${words || '민감해 보이는 말'}이(가) 있어, <b>${d.suggest || d.grade} (${GRADE_TXT[d.suggest || d.grade]})</b> 등급을 권합니다.<br><small class="muted">${GRADE_DESC[d.suggest || d.grade]}</small><div class="gw-btns"></div>`;
    const g = d.suggest || d.grade;
    const row = card.querySelector('.gw-btns');
    const mk = (label, cls, val) => { const b = document.createElement('button'); b.textContent = label; b.className = cls; b.onclick = () => { card.querySelectorAll('button').forEach(x => x.disabled = true); card.insertAdjacentHTML('beforeend', `<div class="muted small">선택: ${esc(label)}</div>`); resolve(val); }; row.appendChild(b); };
    mk(`${g} ${GRADE_TXT[g]}(으)로 진행 (추천)`, 'primary', 'raise');
    mk(`지금 등급 ${chatGrade} 그대로 진행`, 'ghost', 'keep');
    mk('취소', 'ghost', 'cancel');
    box.appendChild(card); scrollDown();
  });
}

async function sendMessage(textOverride, opts = {}) {
  const text = (textOverride !== undefined ? textOverride : $('#input').value).trim();
  const isSummary = opts.summarize;
  if (!text && !isSummary) return;
  $('#input').value = '';
  const welcome = box.querySelector('.welcome');
  if (welcome) welcome.remove();

  // 기밀·비밀로 보이는 말이 있는데 등급이 낮으면 보내기 전에 경고하고, 추천 등급을 고르면 그대로 진행한다(규칙 검사, 정확하지 않음)
  let gradeAck = false;
  if (text) {
    const d = await api.grade.suspect(text);
    if (d && d.grade && gradeRank(d.grade) > gradeRank(chatGrade)) {
      const ch = await askGrade(d, '입력한 내용');
      if (ch === 'cancel') { $('#input').value = text; return; }
      if (ch === 'raise') setChatGrade(d.grade);
      gradeAck = true;
    }
  }
  if (mode === 'act' && !isSummary) {
    const where = $('#where').value;
    addUser(text, (where === 'current' ? '🤖 작업(Work) · 지금 탭' : '🤖 작업(Work) · 백그라운드 탭') + ` · 🔒${chatGrade}`, { kind: 'act' });
    const r = await api.agent.start(text, where, chatGrade);
    if (r.error) { addErr(r.error); return; }
    ensureCard(r.id, { goal: text });
    return;
  }
  const usePage = opts.includePage !== undefined ? !!opts.includePage : $('#include-page').checked;
  addUser(isSummary ? '이 페이지를 요약해 주세요.' : text, (isSummary ? '📄 요약' : (usePage ? '💬 대화 · 페이지 포함' : '💬 대화')) + ` · 🔒${chatGrade}`, { kind: isSummary ? 'sum' : 'chat', page: usePage });
  const wait = document.createElement('div');
  wait.className = 'msg ai typing';
  box.appendChild(wait); scrollDown();
  $('#send').disabled = true;
  const chatOpts = { includePage: usePage, mode: isSummary ? 'summarize' : 'chat', infoGrade: chatGrade, gradeAck };
  let res = await api.chat.send(text, chatOpts);
  if (res.needLive) {
    // 실시간 정보 질문: 질문 모드는 인터넷을 못 보므로 작업 모드(검색 가능)로 보낼지 묻는다
    const ch = await askLive();
    wait.remove(); $('#send').disabled = false;
    if (ch === 'act') {
      const goal = `구글에서 검색해서 확인하고 결과를 쉽게 정리해 줘: ${text}`;
      const where = $('#where').value;
      addUser(goal, (where === 'current' ? '🤖 작업(Work) · 지금 탭' : '🤖 작업(Work) · 백그라운드 탭') + ` · 🔒${chatGrade}`, { kind: 'act' });
      const r = await api.agent.start(goal, where, chatGrade);
      if (r.error) addErr(r.error); else ensureCard(r.id, { goal });
      return;
    }
    if (ch === 'cancel') { $('#input').value = text; return; }
    // 'ask': 그래도 질문 모드로 → 아는 범위에서만 답함
    addUser(text, '💬 대화 · 🔒' + chatGrade, { kind: 'chat', page: false });
    const w2 = document.createElement('div'); w2.className = 'msg ai typing'; box.appendChild(w2); scrollDown();
    $('#send').disabled = true;
    const r2 = await api.chat.send(text, { ...chatOpts, liveAck: true });
    w2.remove(); $('#send').disabled = false;
    if (r2.ok) addAI(r2.text, r2.model + (r2.costKrw != null ? ` · 약 ${r2.costKrw}원` : '') + (r2.notice ? ` · ↪ ${r2.notice}` : ''), true); else addErr(r2.error || '답변을 받지 못했습니다.');
    return;
  }
  if (res.needGrade) {
    // 보려는 페이지 내용 속에 기밀·비밀로 보이는 말이 있음 → 경고 후 선택
    const ch = await askGrade(res, '현재 페이지 내용');
    if (ch === 'cancel') { wait.remove(); $('#send').disabled = false; addErr('페이지에 기밀로 보이는 내용이 있어 보내지 않았습니다. 다시 보내려면 보내기를 눌러 주세요.'); return; }
    if (ch === 'raise') setChatGrade(res.suggest);
    chatOpts.infoGrade = chatGrade; chatOpts.gradeAck = true;
    res = await api.chat.send(text, chatOpts);
  }
  if (res.needConfirmLower) {
    // 등급을 낮추면 지금까지의 높은 등급 대화가 낮은 등급 서비스로 넘어갈 수 있다 → 확인 후 대화를 비우고 새로 시작
    if (confirm(`이 대화는 ${res.from}(${GRADE_TXT[res.from]}) 등급 내용을 다뤘습니다.\n${res.to}(${GRADE_TXT[res.to]})로 낮추면 이전 대화를 지우고 새 대화로 시작합니다.\n\n계속할까요?`)) {
      res = await api.chat.send(text, { ...chatOpts, lowerOk: true });
      if (res.ok) addAI(`(정보 등급을 ${chatOpts.infoGrade}로 낮춰 이전 대화는 지우고 새 대화로 시작했습니다. 위쪽 메시지는 AI가 더 이상 참고하지 않습니다.)`);
    } else { setChatGrade(res.from); res = { ok: false, error: `등급을 ${res.from}(${GRADE_TXT[res.from]}) 그대로 두어 보내지 않았습니다. 다시 보내려면 보내기를 눌러 주세요.` }; }
  }
  wait.remove();
  $('#send').disabled = false;
  if (res.ok) addAI(res.text, res.model + (res.costKrw != null ? ` · 약 ${res.costKrw}원` : '') + (res.notice ? ` · ↪ ${res.notice}` : ''), true); else addErr(res.error);
}
$('#send').onclick = () => sendMessage();
$('#input').addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); sendMessage(); }
});
$('#reset-chat').onclick = async () => { await api.chat.reset(); setChatGrade((cfg && cfg.infoGrade) || 'I'); box.innerHTML = ''; addAI('새 대화를 시작합니다. 이전 대화 내용은 AI가 더 이상 참고하지 않습니다.'); };
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
// ── 설정 화면: 공급자 목록 / 부문 배정 ───────────────────────────
const isLocalUrl = u => /127\.0\.0\.1|localhost/.test(u || '');
const GRADE_TXT = { P: '공개', I: '내부', C: '기밀(대외비)', S: '비밀' };
const GRADE_DESC = { P: '공개돼도 되는 정보 — 무료·외국계 서비스까지 모두 사용', I: '일반 업무 정보 — 입력을 학습에 쓰지 않는 유료 서비스까지 사용', C: '거래처·계약·견적 — 직접 "C 허용"으로 올린 공급자와 내 PC 로컬만 사용', S: '계정·키·미공개 기술·개인정보 — 내 PC 로컬 모델만 사용' };
function gradeOpts(p) {
  const cur = ['P', 'I', 'C', 'S'].includes(p.maxGrade) ? p.maxGrade : 'auto';
  const opt = (v, t) => `<option value="${v}" ${cur === v ? 'selected' : ''}>${t}</option>`;
  return opt('auto', `허용 자동(${p.effectiveGrade || '?'})`) + ['P', 'I', 'C', 'S'].map(g => opt(g, `허용 ${g}`)).join('');
}
function renderProviders() {
  const entries = Object.entries(cfg.providers);
  $('#providers').innerHTML = entries.map(([id, p]) => {
    // 저장된 키는 ●●●●(일정한 길이, 끝자리 없음)로 눈에 띄게 보여 주고, 비어 있으면 '미입력'으로 구분한다 (키는 화면에 오지 않음)
    const saved = !!p.hasKey && id !== 'ollama' && !p.disabled;
    const shown = saved ? '●●●●●●●●●●●●●●' : '';
    const keyBadge = id === 'ollama' ? '' : saved ? ' <span class="badge ok">✔ 저장됨</span>' : (p.disabled ? '' : ' <span class="badge">미입력</span>');
    const tier = p.tier === 'free' ? 'free' : 'paid';
    const tierBadge = ` <span class="badge ${tier === 'free' ? 'ok' : 'paid'}">${tier === 'free' ? '무료' : '유료'}</span>`;
    const keyInput = saved
      ? `<input data-k="apiKey" class="saved" type="text" autocomplete="off" spellcheck="false" value="${esc(shown)}" data-shown="${esc(shown)}" data-orig="${esc(p.apiKey)}" title="저장된 키입니다. 바꾸려면 이 칸을 클릭하고 새 키를 붙여넣으세요.">`
      : `<input data-k="apiKey" type="password" autocomplete="off" placeholder="${p.disabled ? '고도화 단계에서 연결' : 'API 키 붙여넣기'}" value="${esc(p.apiKey)}" ${p.disabled ? 'disabled' : ''}>`;
    return `
    <div class="prov ${p.disabled ? 'disabled' : ''}" data-id="${esc(id)}">
      <div class="nm">${esc(p.label)}${p.disabled ? '' : `<label class="offline" title="체크하면 '추천'이 이 공급자를 고르지 않습니다. 크레딧(잔액)이 없는 유료 공급자에 쓰세요. 직접 고른 부문에는 영향 없음."><input type="checkbox" data-k="off" ${p.off ? 'checked' : ''}> 추천에서 제외</label>`}</div>
      ${keyInput}
      <input data-k="baseUrl" placeholder="주소" value="${esc(p.baseUrl)}" title="접속 주소(보통 바꿀 필요 없음)" ${p.disabled ? 'disabled' : ''}>
      <select data-k="maxGrade" title="이 공급자가 다룰 수 있는 가장 높은 정보 등급. 자동 = 내 PC 로컬 S / 유료 I / 무료 P">${gradeOpts(p)}</select>
      <select data-k="tier" title="요금 유형: 무료는 비용 0원으로 계산·추천에서 우선, 유료는 단가표로 계산"><option value="free" ${tier === 'free' ? 'selected' : ''}>무료</option><option value="paid" ${tier === 'paid' ? 'selected' : ''}>유료</option></select>
      <button type="button" class="ghost" data-del="${esc(id)}" title="이 공급자를 목록에서 삭제합니다 (저장된 키도 함께 지워짐)">삭제</button>
    </div>`;
  }).join('') || '<div class="muted">공급자가 없습니다. "＋ 공급자 추가"를 누르거나 아래 "복원"을 눌러 주세요.</div>';
  // 저장된 키 칸: 클릭하면 전체 선택(바로 덮어쓰기), 새로 입력하면 다시 가려서 표시
  $$('#providers input.saved').forEach(el => {
    el.addEventListener('focus', () => el.select());
    el.addEventListener('input', () => { if (el.value !== el.dataset.shown) { el.type = 'password'; el.classList.remove('saved'); } });
  });
  // 요금 유형을 바꾸면 바로 저장하고 추천을 다시 계산해 보여 준다
  $$('#providers [data-k=off]').forEach(cb => cb.addEventListener('change', async () => { await saveSettings(true); renderProviders(); renderRoles(); }));
  $$('#providers [data-k=tier]').forEach(sel => sel.addEventListener('change', async () => { await saveSettings(true); renderProviders(); renderRoles(); }));
  // 삭제: 처음 누르면 "삭제 확인"으로 바뀌고, 3.5초 안에 한 번 더 누르면 삭제
  $$('#providers [data-del]').forEach(b => b.addEventListener('click', async () => {
    if (b.dataset.armed !== '1') {
      b.dataset.armed = '1'; b.textContent = '삭제 확인'; b.classList.remove('ghost'); b.classList.add('danger');
      setTimeout(() => { if (b.isConnected) { b.dataset.armed = ''; b.textContent = '삭제'; b.classList.remove('danger'); b.classList.add('ghost'); } }, 3500);
      return;
    }
    await saveSettings(true);   // 다른 칸에서 고친 내용 보존
    const r = await api.config.removeProvider(b.dataset.del);
    if (r.ok) { cfg = r.config; renderProviders(); renderRoles(); $('#save-msg').textContent = '삭제했습니다.'; }
    else $('#save-msg').textContent = '⚠ ' + r.error;
  }));
  $('#restore-line').classList.toggle('hidden', !(cfg.removedProviders && cfg.removedProviders.length));
}

function renderRoles() {
  const provOpts = Object.entries(cfg.providers).map(([id, p]) => `<option value="${esc(id)}">${esc(p.label)} · ${p.tier === 'free' ? '무료' : '유료'}</option>`).join('');
  $('#roles').innerHTML = Object.entries(cfg.roles).map(([id, r]) => `
    <div class="role" data-id="${esc(id)}" data-mode="${r.mode === 'manual' ? 'manual' : 'auto'}">
      <div class="nm">${esc(r.label)}<div class="seg"><button type="button" data-mode-btn="auto">추천</button><button type="button" data-mode-btn="manual">직접</button></div></div>
      <select data-k="provider">${provOpts}</select>
      <input data-k="model" list="model-suggestions" value="${esc(r.model)}" placeholder="모델 이름">
      <select data-k="effort" title="생각 깊이(effort)"><option value="">기본</option><option value="low">낮음</option><option value="medium">중간</option><option value="high">높음</option></select>
      <button class="ghost" data-test="${esc(id)}">연결 테스트</button>
      <div class="recline muted"></div>
      <div class="res muted"></div>
    </div>`).join('');
  $$('#roles .role').forEach(row => {
    const id = row.dataset.id, r = cfg.roles[id];
    const sel = row.querySelector('[data-k=provider]'), mdl = row.querySelector('[data-k=model]'), eff = row.querySelector('[data-k=effort]');
    sel.value = cfg.providers[r.provider] ? r.provider : (Object.keys(cfg.providers)[0] || '');
    eff.value = r.effort || '';
    const apply = () => {
      const auto = row.dataset.mode === 'auto';
      const rec = (cfg.recommend || {})[id];
      row.querySelectorAll('[data-mode-btn]').forEach(b => b.classList.toggle('on', b.dataset.modeBtn === row.dataset.mode));
      if (auto && rec) { sel.value = rec.provider; mdl.value = rec.model; }   // 추천값을 보여 준다(직접으로 바꾸면 이 값에서 시작)
      sel.disabled = mdl.disabled = auto && !!rec;
      const recLabel = rec && cfg.providers[rec.provider] ? `${cfg.providers[rec.provider].label} · ${rec.model}` : '';
      const line = row.querySelector('.recline');
      line.textContent = auto
        ? (rec ? `추천: ${recLabel} — ${rec.reason}` : `추천할 수 있는 공급자가 없습니다(키가 있는 공급자가 없거나, 정보 등급 ${cfg.infoGrade || 'P'}에 허용된 공급자가 없음). 아래 값으로 동작하며 "직접"으로 바꿀 수 있습니다.`)
        : (rec ? `직접 선택 중입니다. (추천은 ${recLabel})` : '직접 선택 중입니다.');
      const pp = cfg.providers[sel.value];
      if (pp && pp.tier === 'free' && !isLocalUrl(pp.baseUrl)) line.textContent += ' ⚠ 무료 등급: 입력이 학습에 쓰일 수 있으니(Gemini 무료는 공식 확인) 민감한 자료는 넣지 마세요.';
    };
    row._apply = apply;
    row.querySelectorAll('[data-mode-btn]').forEach(b => b.addEventListener('click', () => { row.dataset.mode = b.dataset.modeBtn; apply(); }));
    sel.addEventListener('change', apply);
    apply();
  });
  $$('#roles [data-test]').forEach(b => b.onclick = async () => {
    await saveSettings(true);
    const res = b.parentElement.querySelector('.res');
    res.textContent = '테스트 중…';
    const r = await api.config.test(b.dataset.test);
    res.textContent = r.ok ? `✅ 연결됨 — ${r.model} (응답: ${r.text})` : `❌ ${r.error}` + (/크레딧|credit/i.test(r.error || '') ? ' → 위 공급자 칸의 "추천에서 제외"를 체크하면 추천이 다른 공급자로 바뀝니다.' : '');
  });
}
async function openSettings(msg) {
  cfg = await api.config.get();
  settingsOpen = true;
  api.layout.hideWeb(true);
  $('#settings').classList.remove('hidden');
  $('#info-grade').value = cfg.infoGrade || 'I';
  $('#grade-desc').textContent = GRADE_DESC[cfg.infoGrade || 'I'];
  renderProviders();
  renderRoles();
  const a = cfg.agent;
  $('#agent-mode').value = a.mode; $('#jev-conf').value = a.jevConfidence; $('#shot-mode').value = a.screenshotMode;
  $('#escalate').checked = a.escalate; $('#budget').value = a.budgetKrw; $('#krw-rate').value = cfg.ui.krwPerUsd;
  $('#confirm-mode').value = a.confirmMode;
  $('#max-steps').value = a.maxSteps;
  $('#homepage').value = cfg.ui.homepage;
  $('#engine-grade').value = cfg.engine.maxGrade || 'I'; $('#engine-chat').checked = cfg.engine.useForChat !== false; $('#failover').checked = cfg.failover !== false;
  $('#engine-type').value = cfg.engine.type; $('#cc-path').value = cfg.engine.claudePath || ''; $('#cc-model').value = cfg.engine.claudeModel || '';
  refreshMcp(); checkClaude(false);
  try {
    const rs = (await api.config.routerStatus()).filter(x => x.hasKey || x.calls || x.fails);
    $('#router-status').innerHTML = rs.length ? rs.map(x => `${x.resting ? '⏸' : '●'} ${esc(x.label)} (${x.tier === 'free' ? '무료' : '유료'}): ${x.calls}회 · 약 $${x.usd.toFixed(4)}${x.resting ? ` — <b>쉬는 중 (${esc(x.restKind)}, 약 ${x.restMin}분 뒤 재시도)</b>` : ''}${x.fails ? ` · 막힘 ${x.fails}회` : ''}`).join('<br>') : '아직 기록이 없습니다.';
  } catch (_) {}
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
    const keyEl = row.querySelector('[data-k=apiKey]');
    // 저장된 키를 건드리지 않았으면 가려진 표시값 대신 '기존 키 유지' 신호(••••••••)를 보낸다
    const keyVal = keyEl.dataset.shown && keyEl.value.trim() === keyEl.dataset.shown ? keyEl.dataset.orig : keyEl.value.trim();
    patch.providers[id] = { apiKey: keyVal, baseUrl: row.querySelector('[data-k=baseUrl]').value.trim(), tier: row.querySelector('[data-k=tier]').value };
    patch.providers[id].maxGrade = row.querySelector('[data-k=maxGrade]').value;
    const offEl = row.querySelector('[data-k=off]'); if (offEl) patch.providers[id].off = offEl.checked;
  });
  $$('#roles .role').forEach(row => {
    const id = row.dataset.id, mode = row.dataset.mode === 'manual' ? 'manual' : 'auto';
    const rp = { mode, effort: row.querySelector('[data-k=effort]').value };
    // 추천 모드이고 추천값이 있으면 직접 고른 값(provider·model)은 건드리지 않고 보존한다
    if (mode === 'manual' || !(cfg.recommend || {})[id]) { rp.provider = row.querySelector('[data-k=provider]').value; rp.model = row.querySelector('[data-k=model]').value.trim(); }
    patch.roles[id] = rp;
  });
  const num = (v, lo, hi, d) => { const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; };
  patch.agent = {
    mode: $('#agent-mode').value, jevConfidence: num($('#jev-conf').value, 0.3, 0.99, 0.7), screenshotMode: $('#shot-mode').value,
    escalate: $('#escalate').checked, budgetKrw: num($('#budget').value, 0, 1e7, 500),
    confirmMode: $('#confirm-mode').value, maxSteps: num($('#max-steps').value, 5, 100, 30)
  };
  patch.engine = { type: $('#engine-type').value, claudePath: $('#cc-path').value.trim(), claudeModel: $('#cc-model').value, maxGrade: $('#engine-grade').value, useForChat: $('#engine-chat').checked };
  patch.failover = $('#failover').checked;
  patch.infoGrade = $('#info-grade').value;
  patch.ui = { homepage: $('#homepage').value.trim() || 'https://www.google.com', krwPerUsd: num($('#krw-rate').value, 500, 5000, 1400) };
  cfg = await api.config.update(patch);
  if (!quiet) { renderProviders(); renderRoles(); $('#save-msg').textContent = '저장했습니다.'; setTimeout(() => { $('#save-msg').textContent = ''; }, 2000); }
}
$('#add-provider-btn').onclick = () => { $('#add-provider').classList.toggle('hidden'); $('#ap-msg').textContent = ''; };
$('#ap-cancel').onclick = () => $('#add-provider').classList.add('hidden');
$('#ap-ok').onclick = async () => {
  await saveSettings(true);   // 다른 칸에서 고친 내용 보존
  const r = await api.config.addProvider({ label: $('#ap-label').value, type: $('#ap-type').value, baseUrl: $('#ap-url').value, tier: $('#ap-tier').value, apiKey: $('#ap-key').value });
  if (!r.ok) { $('#ap-msg').textContent = '⚠ ' + r.error; return; }
  ['#ap-label', '#ap-url', '#ap-key'].forEach(s => { $(s).value = ''; });
  $('#add-provider').classList.add('hidden');
  cfg = r.config; renderProviders(); renderRoles();
  $('#save-msg').textContent = '공급자를 추가했습니다. 키가 없으면 입력한 뒤 [직접]으로 부문에 배정하고 [연결 테스트]로 확인하세요(직접 추가한 공급자는 자동 추천 대상이 아닙니다).';
};
$('#restore-providers').onclick = async () => {
  await saveSettings(true);
  const r = await api.config.restoreProviders();
  if (r.ok) { cfg = r.config; renderProviders(); renderRoles(); $('#save-msg').textContent = '삭제했던 기본 공급자를 복원했습니다(키는 다시 입력해야 합니다).'; }
};
$('#info-grade').onchange = async () => { $('#grade-desc').textContent = GRADE_DESC[$('#info-grade').value]; await saveSettings(true); renderProviders(); renderRoles(); };
$('#roles-all-auto').onclick = () => { $$('#roles .role').forEach(row => { row.dataset.mode = 'auto'; row._apply && row._apply(); }); $('#save-msg').textContent = '저장하면 모든 부문이 추천 배정으로 바뀝니다.'; };
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
  // 추천 엔진: 구독(Claude Code)이 설치돼 있으면 구독을 권한다 (규칙은 src/models/recommend.js 와 같음)
  const want = r.ok ? 'claude-code' : 'api';
  const same = $('#engine-type').value === want;
  $('#engine-rec').textContent = (r.ok ? '구독: Claude Code — 구독 한도 안에서는 추가 비용이 없고, 어려운 작업을 맡기기에 적합함' : 'API 키 방식 — Claude Code가 설치돼 있지 않음') + (same ? ' (현재 설정과 같음)' : '');
  const ap = $('#engine-apply');
  ap.classList.toggle('hidden', same);
  ap.onclick = () => { $('#engine-type').value = want; ap.classList.add('hidden'); $('#engine-rec').textContent += ' — 적용됨(저장을 눌러 주세요)'; };
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
api.config.get().then(c => { cfg = c; setChatGrade(c.infoGrade || 'I'); sizes.preview = c.ui.previewWidth || 400; sizes.panel = c.ui.panelWidth || 420; applySizes(); setLayout(c.ui.layout || 'chat', { save: false }); syncEngineBadge(); if (c.engine.type !== 'claude-code' && !Object.values(c.providers).some(p => p.hasKey && !/127\.0\.0\.1|localhost/.test(p.baseUrl || ''))) setTimeout(() => openSettings('먼저 사용할 AI 공급자의 API 키를 입력하고 저장해 주세요.'), 600); });

// 자동 전환 알림(한도·잔액 소진 등으로 다른 AI 도구로 넘어갈 때)
api.config.onNotice(m => {
  const d = document.createElement('div');
  d.className = 'msg ai gradewarn';
  d.innerHTML = '<b>🔁 자동 전환</b> ' + esc(m);
  box.appendChild(d); scrollDown();
});

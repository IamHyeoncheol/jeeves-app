// 정책 엔진 화면(사양서 01 개정 2026-10-10): 비상 정지 버튼·재개, 자동 위임 규칙 관리, 오늘 비용.
// app.js 가 먼저 읽힌 뒤 실행된다(api·esc·openModal·closeModal 을 함께 씀). app.js 를 더 키우지 않으려고 따로 둔 파일.
(() => {
  const P = window.jeeves && window.jeeves.policy;
  if (!P) return;
  const el = (tag, attrs = {}, html = '') => { const e = document.createElement(tag); Object.assign(e, attrs); if (html) e.innerHTML = html; return e; };
  const ACTIONS = [
    ['click', '버튼 클릭'], ['type_text', '글 입력'], ['press_key', '키 누르기'], ['select_option', '항목 선택'],
    ['navigate', '주소 이동'], ['download', '다운로드'], ['mail_trash', '메일 휴지통 이동'], ['*', '모든 행동(R2 전용)']
  ];
  const actLabel = a => (ACTIONS.find(x => x[0] === a) || [a, a])[1];

  // ── 비상 정지 버튼(도구 막대, 항상 보임) ──
  const btn = el('button', { id: 'halt-btn', type: 'button', className: 'halt-btn', title: '지브스의 모든 작업을 즉시 멈춥니다 (단축키 Ctrl+Shift+F12)' }, '■ 비상 정지');
  const tb = document.getElementById('toolbar');
  if (tb) tb.insertBefore(btn, document.getElementById('open-settings'));
  let state = { halted: false };
  function paint() {
    btn.classList.toggle('halted', !!state.halted);
    if (state.halted) {
      const t = state.haltedAt ? new Date(state.haltedAt).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' }) : '';
      const how = { ui: '화면 버튼', shortcut: '단축키', mcp: '외부 에이전트' }[state.source] || state.source || '';
      btn.innerHTML = `⏸ 정지됨 ${esc(t)} · 재개`;
      btn.title = `비상 정지됨 (${how}${state.reason ? ' — ' + state.reason : ''}). 누르면 재개합니다.`;
    } else {
      btn.innerHTML = '■ 비상 정지';
      btn.title = `지브스의 모든 작업을 즉시 멈춥니다${state.shortcut ? ' (단축키 ' + state.shortcut.replace('CommandOrControl', 'Ctrl') + ')' : ''}`;
    }
  }
  btn.onclick = async () => {
    if (state.halted) {
      if (!confirm('비상 정지를 풀고 다시 작업을 받을까요?\n(정지 때 멈춘 작업은 자동으로 이어지지 않습니다. 필요하면 다시 지시해 주세요.)')) return;
      await P.resume();
    } else {
      await P.halt('화면 버튼');
    }
    state = { ...state, ...(await P.state()) }; paint();
  };
  P.onState(s => { state = { ...state, ...s }; paint(); });
  P.state().then(s => { state = s || state; paint(); });

  // ── 자동 위임 규칙 창 ──
  const modal = el('div', { id: 'policy-modal', className: 'modal hidden' });
  modal.setAttribute('role', 'dialog'); modal.setAttribute('aria-modal', 'true');
  modal.innerHTML = `<div class="sheet narrow">
    <div class="sheet-head"><h2>자동 위임 규칙</h2><button class="icon" id="pm-close">✕</button></div>
    <div class="sheet-body">
      <p class="muted">여기에 정한 범위의 행동은 <b>묻지 않고 자동으로</b> 처리하고 기록만 남깁니다. 규칙이 없으면 R2(보내기·게시·삭제 등)는 확인을 묻고, R3(결제·송금·탈퇴 등)는 실행하지 않습니다.
      규칙은 이 PC 화면에서만 만들 수 있고, AI·외부 에이전트는 만들거나 넓힐 수 없습니다. 비밀번호·카드번호 입력은 규칙으로도 풀리지 않습니다.</p>
      <div id="pm-cost" class="pm-cost muted"></div>
      <div id="pm-list"></div>
      <details id="pm-add-box"><summary><b>＋ 새 규칙</b></summary>
        <div class="pm-form">
          <label class="cu-f">이름(메모)<input id="pm-note" maxlength="60" placeholder="예) 네이버 메일 광고 휴지통 이동"></label>
          <label class="cu-f">허용 최고 등급
            <select id="pm-level"><option value="R2">R2 — 보내기·게시·삭제·휴지통 등(되돌리기 어려움)</option><option value="R3">R3 — 결제·송금·탈퇴 등(금전·계정) ⚠</option></select></label>
          <div class="cu-f">행동 종류<div id="pm-acts" class="pm-acts">${ACTIONS.map(([v, l]) => `<label><input type="checkbox" value="${v}"> ${l}</label>`).join('')}</div></div>
          <label class="cu-f">사이트 <small class="muted">(쉼표로 구분, 예: mail.naver.com, example.com — 하위 주소 포함. R3는 필수)</small><input id="pm-sites" placeholder="비우면 모든 사이트(R2만 가능)"></label>
          <label class="cu-f">버튼 이름에 들어갈 글 <small class="muted">(선택, 쉼표로 구분 — 예: 휴지통, 삭제)</small><input id="pm-labels"></label>
          <div class="pm-row">
            <label class="cu-f">횟수 한도<input id="pm-count" type="number" min="1" max="10000" placeholder="R3 필수"></label>
            <label class="cu-f">기간<select id="pm-period"><option value="day">하루</option><option value="month">한 달</option><option value="total">전체</option></select></label>
            <label class="cu-f">유효기간(까지)<input id="pm-exp" type="date"></label>
          </div>
          <label class="cu-row"><input type="checkbox" id="pm-shadow" checked> 그림자 실행으로 시작(추천) — 처음에는 자동 실행하지 않고 "자동이었다면 실행됐을 것"만 표시. 확인해 보고 자동으로 바꿉니다.</label>
          <div class="acts"><button class="primary" id="pm-add">규칙 추가</button><span id="pm-msg" class="muted"></span></div>
        </div>
      </details>
    </div>
    <div class="sheet-foot"><span class="muted">감사 기록: %APPDATA%\\Jeeves\\audit · 비용 장부: %APPDATA%\\Jeeves\\ledger</span><span class="foot-btns"><button class="primary" id="pm-done">닫기</button></span></div>
  </div>`;
  document.body.appendChild(modal);
  const $m = s => modal.querySelector(s);

  function ruleLine(r) {
    const exp = r.expiresAt ? new Date(r.expiresAt).toLocaleDateString('ko-KR') + '까지' : '기한 없음';
    const lim = r.maxCount ? `${{ day: '하루', month: '한 달', total: '전체' }[r.period]} ${r.used || 0}/${r.maxCount}회` : '횟수 제한 없음';
    const expired = r.expiresAt && new Date(r.expiresAt) <= new Date();
    return `<div class="pm-rule${r.enabled ? '' : ' off'}" data-id="${esc(r.id)}">
      <div><span class="lv-badge lv-${esc(r.maxLevel)}">${esc(r.maxLevel)}</span> <b>${esc(r.note || '(이름 없음)')}</b> ${r.mode === 'shadow' ? '<span class="pm-tag">🌓 그림자</span>' : '<span class="pm-tag on">자동</span>'}${expired ? ' <span class="pm-tag bad">만료</span>' : ''}</div>
      <small class="muted">${r.actions.map(actLabel).map(esc).join('·')} / ${r.sites.length ? r.sites.map(esc).join(', ') : '모든 사이트'}${r.labels.length ? ' / 이름: ' + r.labels.map(esc).join(', ') : ''} / ${esc(lim)} / ${esc(exp)}</small>
      <div class="acts">${r.mode === 'shadow' ? '<button class="ghost small" data-a="auto">자동으로 바꾸기</button>' : '<button class="ghost small" data-a="shadow">그림자로 되돌리기</button>'}
        <button class="ghost small" data-a="toggle">${r.enabled ? '끄기' : '켜기'}</button><button class="ghost small" data-a="del">삭제</button></div></div>`;
  }
  async function refresh() {
    const rules = await P.rules();
    $m('#pm-list').innerHTML = rules.length ? rules.map(ruleLine).join('') : '<p class="muted">아직 규칙이 없습니다 — 지금은 R2는 매번 확인, R3는 실행하지 않습니다.</p>';
    try {
      const [d, m] = await Promise.all([P.ledger('today'), P.ledger('month')]);
      if (d) $m('#pm-cost').textContent = `오늘 AI 비용(API): 약 ${(d.krw || 0).toLocaleString()}원 · ${d.calls}회${d.unknownCost ? ` (단가 모름 ${d.unknownCost}회)` : ''} / 이번 달 약 ${(m.krw || 0).toLocaleString()}원 · 구독 추정치는 별도`;
    } catch (_) {}
  }
  $m('#pm-list').onclick = async e => {
    const b = e.target.closest('button[data-a]'); if (!b) return;
    const id = b.closest('.pm-rule').dataset.id, a = b.dataset.a;
    const rule = (await P.rules()).find(r => r.id === id); if (!rule) return;
    let r;
    if (a === 'del') { if (!confirm(`"${rule.note || id}" 규칙을 삭제할까요?`)) return; r = await P.removeRule(id); }
    else if (a === 'toggle') r = await P.updateRule(id, { enabled: !rule.enabled });
    else if (a === 'auto') { if (!confirm(`"${rule.note || id}" 규칙을 자동 실행으로 바꿀까요?\n이후 이 범위의 ${rule.maxLevel} 행동은 묻지 않고 실행됩니다.`)) return; r = await P.updateRule(id, { mode: 'auto' }); }
    else if (a === 'shadow') r = await P.updateRule(id, { mode: 'shadow' });
    if (r && !r.ok) alert(r.error);
    refresh();
  };
  $m('#pm-level').onchange = () => { const r3 = $m('#pm-level').value === 'R3'; const all = $m('#pm-acts input[value="*"]'); all.disabled = r3; if (r3) all.checked = false; };
  $m('#pm-add').onclick = async () => {
    const actions = [...modal.querySelectorAll('#pm-acts input:checked')].map(i => i.value);
    const exp = $m('#pm-exp').value;
    const spec = {
      note: $m('#pm-note').value.trim(), maxLevel: $m('#pm-level').value, actions,
      sites: $m('#pm-sites').value, labels: $m('#pm-labels').value,
      maxCount: $m('#pm-count').value, period: $m('#pm-period').value,
      expiresAt: exp ? new Date(exp + 'T23:59:59').toISOString() : null,
      mode: $m('#pm-shadow').checked ? 'shadow' : 'auto'
    };
    if (spec.maxLevel === 'R3' && spec.mode === 'auto' && !confirm('R3(결제·송금 등)를 바로 자동 실행으로 위임합니다. 정말 진행할까요?\n(추천: 그림자 실행으로 먼저 확인)')) return;
    const r = await P.addRule(spec);
    $m('#pm-msg').textContent = r.ok ? '추가했습니다.' : '❌ ' + r.error;
    if (r.ok) { modal.querySelectorAll('.pm-form input[type=text], .pm-form input:not([type])').forEach(i => { i.value = ''; }); $m('#pm-count').value = ''; $m('#pm-exp').value = ''; refresh(); }
  };
  const close = () => closeModal('#policy-modal');
  $m('#pm-close').onclick = close; $m('#pm-done').onclick = close;
  const open = () => { $m('#pm-msg').textContent = ''; refresh(); openModal('#policy-modal'); };

  // 왼쪽 아래(맞춤설정·스킬 옆)에 "자동 위임" 단추
  const foot = document.getElementById('sb-foot');
  if (foot) {
    const b = el('button', { type: 'button', id: 'sb-policy', title: '묻지 않고 자동으로 처리할 범위(위임 규칙)와 오늘 비용을 봅니다' }, '<svg class="ico" viewBox="0 0 24 24"><path d="M12 3l7 3v5c0 4.5-3 8.5-7 10-4-1.5-7-5.5-7-10V6z"/><path d="M9 12l2 2 4-4"/></svg>자동 위임');
    b.onclick = open; foot.appendChild(b);
  }
  window.jeevesPolicyUi = { open, refresh };
})();

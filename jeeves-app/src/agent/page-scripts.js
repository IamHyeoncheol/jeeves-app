// 웹페이지 안에서 실행되는 스크립트들 (페이지와 분리된 "격리 공간"에서 실행)
// 1) snapshot: 화면에 보이는 버튼·입력칸 등에 번호를 붙여 표로 만든다
// 2) locate:   번호로 요소를 찾아 화면 가운데로 스크롤하고 클릭할 좌표를 돌려준다
// 3) marks:    화면 캡처 전에 번호표 배지를 잠깐 그렸다가 지운다

const SNAPSHOT_FN = function snapshot(opts) {
  const MAX = opts.maxElements || 200;
  const TEXT_MAX = opts.textMax || 6000;
  const gen = String(Date.now() % 100000);
  const vw = window.innerWidth, vh = window.innerHeight;

  document.querySelectorAll('[data-jeeves-id]').forEach(e => e.removeAttribute('data-jeeves-id'));

  const SEL = [
    'a[href]', 'button', 'input:not([type=hidden])', 'textarea', 'select', 'summary', 'label[for]',
    '[role=button]', '[role=link]', '[role=checkbox]', '[role=radio]', '[role=tab]', '[role=menuitem]',
    '[role=option]', '[role=switch]', '[role=combobox]', '[role=textbox]', '[role=searchbox]',
    '[contenteditable=""]', '[contenteditable=true]', '[onclick]', '[tabindex]:not([tabindex="-1"])'
  ].join(',');

  const clean = s => (s || '').replace(/\s+/g, ' ').trim();
  const cut = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

  function visible(el) {
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return null;
    if (r.bottom < -20 || r.top > vh * 1.5 || r.right < 0 || r.left > vw) return null;
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none' || Number(cs.opacity) === 0) return null;
    return r;
  }

  function nameOf(el) {
    const aria = el.getAttribute('aria-label');
    if (aria) return clean(aria);
    const lb = el.getAttribute('aria-labelledby');
    if (lb) {
      const t = lb.split(/\s+/).map(id => document.getElementById(id)).filter(Boolean).map(e => e.innerText).join(' ');
      if (clean(t)) return clean(t);
    }
    if (el.id) {
      const l = document.querySelector('label[for="' + CSS.escape(el.id) + '"]');
      if (l && clean(l.innerText)) return clean(l.innerText);
    }
    const parentLabel = el.closest('label');
    if (parentLabel && parentLabel !== el && clean(parentLabel.innerText)) return clean(parentLabel.innerText);
    const tag = el.tagName.toLowerCase();
    if (tag === 'input' && ['button', 'submit', 'reset'].includes(el.type)) return clean(el.value);
    if (tag === 'img') return clean(el.alt);
    const txt = clean(el.innerText || el.textContent);
    if (txt) return txt;
    const img = el.querySelector('img[alt]');
    if (img && clean(img.alt)) return clean(img.alt);
    return clean(el.getAttribute('placeholder') || el.getAttribute('title') || el.getAttribute('name') || '');
  }

  function kindOf(el) {
    const role = el.getAttribute('role');
    if (role) return role;
    const tag = el.tagName.toLowerCase();
    if (tag === 'input') return 'input:' + (el.type || 'text');
    if (tag === 'a') return 'link';
    if (el.isContentEditable) return 'editor';
    return tag;
  }

  const list = [];
  const seen = new Set();
  const nodes = Array.from(document.querySelectorAll(SEL));
  for (const el of nodes) {
    if (list.length >= MAX) break;
    if (seen.has(el)) continue;
    // 바깥 요소가 이미 같은 클릭 대상을 대표하면 중복 제거
    if (el.parentElement && seen.has(el.parentElement.closest(SEL)) && !/^(INPUT|TEXTAREA|SELECT|BUTTON)$/.test(el.tagName)) continue;
    // <label for=...> 는 연결된 입력칸이 보이면 중복이므로 뺀다(숨긴 체크박스용 라벨만 남김)
    if (el.tagName === 'LABEL') {
      const ctl = el.htmlFor && document.getElementById(el.htmlFor);
      if (ctl && visible(ctl)) continue;
    }
    const r = visible(el);
    if (!r) continue;
    seen.add(el);
    const id = list.length + 1;
    el.setAttribute('data-jeeves-id', gen + ':' + id);
    const tag = el.tagName.toLowerCase();
    const item = { id, kind: kindOf(el), name: cut(nameOf(el), 90) };
    if (r.top > vh) item.below = true; // 화면 아래쪽(스크롤 필요)
    if (tag === 'input' || tag === 'textarea') {
      const t = (el.type || '').toLowerCase();
      const ac = (el.getAttribute('autocomplete') || '').toLowerCase();
      item.sensitive = t === 'password' || /cc-|card|cvc|cvv/.test(ac + ' ' + (el.name || '') + ' ' + (el.id || ''));
      item.value = item.sensitive ? (el.value ? '***' : '') : cut(String(el.value || ''), 60);
      if (el.placeholder) item.placeholder = cut(clean(el.placeholder), 50);
      if (t === 'checkbox' || t === 'radio') item.checked = el.checked;
    }
    if (tag === 'select') {
      item.value = el.options[el.selectedIndex] ? clean(el.options[el.selectedIndex].text) : '';
      item.options = Array.from(el.options).slice(0, 25).map(o => cut(clean(o.text), 40));
    }
    if (el.disabled || el.getAttribute('aria-disabled') === 'true') item.disabled = true;
    if (tag === 'a') {
      const href = el.getAttribute('href') || '';
      if (href && !href.startsWith('javascript')) item.href = cut(href, 80);
    }
    if (el.getAttribute('aria-expanded')) item.expanded = el.getAttribute('aria-expanded') === 'true';
    list.push(item);
  }

  const bodyText = clean(document.body ? document.body.innerText : '');
  return {
    gen,
    url: location.href,
    title: document.title,
    scroll: { y: Math.round(scrollY), max: Math.max(0, Math.round(document.documentElement.scrollHeight - vh)), vh },
    elements: list,
    text: cut(bodyText, TEXT_MAX),
    textLength: bodyText.length,
    frames: document.querySelectorAll('iframe').length,
    hasPassword: !!document.querySelector('input[type=password]')
  };
};

const LOCATE_FN = function locate(arg) {
  const el = document.querySelector('[data-jeeves-id="' + arg.key + '"]');
  if (!el) return { ok: false, error: '해당 번호의 요소가 사라졌습니다(페이지가 바뀜). 화면을 다시 확인하세요.' };
  el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
  const r = el.getBoundingClientRect();
  const x = Math.round(r.left + Math.min(r.width / 2, 40 + r.width / 4));
  const y = Math.round(r.top + r.height / 2);
  const top = document.elementFromPoint(x, y);
  const covered = !!top && top !== el && !el.contains(top) && !top.contains(el);
  const tag = el.tagName.toLowerCase();
  const form = el.closest('form');
  return {
    ok: true, x, y, covered,
    coverName: covered ? (top.innerText || top.getAttribute('aria-label') || top.tagName).slice(0, 60) : '',
    tag, type: (el.type || '').toLowerCase(),
    editable: tag === 'input' || tag === 'textarea' || el.isContentEditable,
    name: (el.innerText || el.value || el.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim().slice(0, 80),
    formHasPassword: !!(form && form.querySelector('input[type=password]')),
    formHasCard: !!(form && form.querySelector('[autocomplete^="cc-"]'))
  };
};

const JS_CLICK_FN = function jsClick(arg) {
  const el = document.querySelector('[data-jeeves-id="' + arg.key + '"]');
  if (!el) return false;
  el.click();
  return true;
};

const FOCUS_CLEAR_FN = function focusClear(arg) {
  const el = document.querySelector('[data-jeeves-id="' + arg.key + '"]');
  if (!el) return false;
  el.focus();
  if (arg.clear) {
    if (el.isContentEditable) {
      const range = document.createRange(); range.selectNodeContents(el);
      const sel = getSelection(); sel.removeAllRanges(); sel.addRange(range);
    } else if (typeof el.select === 'function') {
      el.select();
    }
  }
  return true;
};

// 창에 키보드 포커스가 없을 때(백그라운드 탭) 쓰는 입력 방식
// 원래 값 설정 함수를 직접 써서 React 같은 화면 도구도 변화를 알아차리게 한다
const JS_TYPE_FN = function jsType(arg) {
  const el = document.querySelector('[data-jeeves-id="' + arg.key + '"]') || document.activeElement;
  if (!el) return { ok: false };
  el.focus();
  if (el.isContentEditable) {
    if (arg.clear) { const r = document.createRange(); r.selectNodeContents(el); const s = getSelection(); s.removeAllRanges(); s.addRange(r); }
    document.execCommand('insertText', false, arg.text);
    return { ok: true, value: el.innerText };
  }
  const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
  const next = arg.clear ? arg.text : (el.value || '') + arg.text;
  setter.call(el, next);
  el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: arg.text }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  return { ok: true, value: el.value };
};

const READ_VALUE_FN = function readValue(arg) {
  const el = document.querySelector('[data-jeeves-id="' + arg.key + '"]');
  if (!el) return null;
  return el.isContentEditable ? el.innerText : el.value;
};

const JS_KEY_FN = function jsKey(arg) {
  const el = document.activeElement || document.body;
  const opts = { key: arg.key, code: arg.key, bubbles: true, cancelable: true };
  const notCancelled = el.dispatchEvent(new KeyboardEvent('keydown', opts));
  el.dispatchEvent(new KeyboardEvent('keyup', opts));
  // Enter: 입력칸이 양식(form) 안에 있으면 제출까지 해 준다(실제 키보드와 같은 효과)
  if (arg.key === 'Enter' && notCancelled && el.form && /^(INPUT)$/.test(el.tagName)) {
    if (typeof el.form.requestSubmit === 'function') el.form.requestSubmit(); else el.form.submit();
    return { submitted: true };
  }
  if (arg.key === 'Escape') { /* 팝업 닫기는 사이트 처리에 맡김 */ }
  return { submitted: false };
};

const SELECT_FN = function selectOption(arg) {
  const el = document.querySelector('[data-jeeves-id="' + arg.key + '"]');
  if (!el || el.tagName !== 'SELECT') return { ok: false, error: '선택 목록(select)이 아닙니다.' };
  const want = String(arg.option).trim();
  const opt = Array.from(el.options).find(o => o.text.trim() === want) ||
              Array.from(el.options).find(o => o.text.trim().includes(want) || o.value === want);
  if (!opt) return { ok: false, error: '해당 항목이 없습니다. 가능한 항목: ' + Array.from(el.options).slice(0, 15).map(o => o.text.trim()).join(', ') };
  el.value = opt.value;
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  return { ok: true, chosen: opt.text.trim() };
};

const SCROLL_FN = function doScroll(arg) {
  const dy = (arg.direction === 'up' ? -1 : 1) * Math.round(innerHeight * (arg.amount === 'half' ? 0.5 : 0.85));
  // 페이지 전체가 아니라 안쪽 영역만 스크롤되는 사이트 대응: 가장 큰 스크롤 가능 영역을 찾는다
  let target = document.scrollingElement;
  if (target.scrollHeight <= innerHeight + 5) {
    let best = null, bestArea = 0;
    for (const el of document.querySelectorAll('div,main,section,article')) {
      const cs = getComputedStyle(el);
      if (/(auto|scroll)/.test(cs.overflowY) && el.scrollHeight > el.clientHeight + 20) {
        const a = el.clientWidth * el.clientHeight;
        if (a > bestArea) { best = el; bestArea = a; }
      }
    }
    if (best) target = best;
  }
  const before = target.scrollTop;
  target.scrollBy({ top: dy, behavior: 'instant' });
  return { moved: Math.round(target.scrollTop - before) };
};

const MARKS_ON_FN = function marksOn() {
  const box = document.createElement('div');
  box.id = '__jeeves_marks';
  box.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483647';
  document.querySelectorAll('[data-jeeves-id]').forEach(el => {
    const r = el.getBoundingClientRect();
    if (r.bottom < 0 || r.top > innerHeight) return;
    const n = el.getAttribute('data-jeeves-id').split(':')[1];
    const b = document.createElement('div');
    b.textContent = n;
    b.style.cssText = `position:fixed;left:${Math.max(0, r.left)}px;top:${Math.max(0, r.top - 2)}px;background:#e8590c;color:#fff;font:bold 11px/14px Arial;padding:0 3px;border-radius:3px;opacity:.9`;
    const o = document.createElement('div');
    o.style.cssText = `position:fixed;left:${r.left}px;top:${r.top}px;width:${r.width}px;height:${r.height}px;outline:1.5px solid rgba(232,89,12,.7)`;
    box.appendChild(o); box.appendChild(b);
  });
  document.documentElement.appendChild(box);
  return true;
};

const MARKS_OFF_FN = function marksOff() {
  const b = document.getElementById('__jeeves_marks');
  if (b) b.remove();
  return true;
};

const FULL_TEXT_FN = function fullText(arg) {
  const t = (document.body ? document.body.innerText : '').replace(/\n{3,}/g, '\n\n').trim();
  return { text: t.slice(0, arg.max || 20000), length: t.length, url: location.href, title: document.title };
};

// 함수를 "(함수)(인자)" 형태의 문자열로 만들어 페이지에 보낸다
function call(fn, arg) {
  return `(${fn.toString()})(${JSON.stringify(arg || {})})`;
}

module.exports = {
  snapshot: o => call(SNAPSHOT_FN, o),
  locate: key => call(LOCATE_FN, { key }),
  jsClick: key => call(JS_CLICK_FN, { key }),
  focusClear: (key, clear) => call(FOCUS_CLEAR_FN, { key, clear }),
  jsType: (key, text, clear) => call(JS_TYPE_FN, { key, text, clear }),
  readValue: key => call(READ_VALUE_FN, { key }),
  jsKey: key => call(JS_KEY_FN, { key }),
  select: (key, option) => call(SELECT_FN, { key, option }),
  scroll: (direction, amount) => call(SCROLL_FN, { direction, amount }),
  marksOn: () => call(MARKS_ON_FN),
  marksOff: () => call(MARKS_OFF_FN),
  fullText: max => call(FULL_TEXT_FN, { max }),
  _fns: { SNAPSHOT_FN, LOCATE_FN, SELECT_FN, SCROLL_FN }
};

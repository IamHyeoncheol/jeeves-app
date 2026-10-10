// 브라우저 조작기: 에이전트의 "손과 눈".
// 하나의 탭(webContents)을 받아 관찰(번호표·캡처)과 행동(클릭·입력·스크롤)을 수행한다.
const S = require('./page-scripts');
const { R3_WORDS, R2_WORDS } = require('../policy/risk');
// 관찰 때 이름보다 지금 이름이 더 위험한 말을 담고 있는가(R3 > R2 > 그 외)
function riskierNow(before, now) {
  const lv = t => (R3_WORDS.test(String(t || '')) ? 2 : R2_WORDS.test(String(t || '')) ? 1 : 0);
  return lv(now) > lv(before);
}

const WORLD = 1001; // 페이지 스크립트와 분리된 격리 공간 번호
const sleep = ms => new Promise(r => setTimeout(r, ms));

const KEYS = { Enter: 'Enter', Escape: 'Escape', Tab: 'Tab', ArrowDown: 'Down', ArrowUp: 'Up', ArrowLeft: 'Left', ArrowRight: 'Right', Backspace: 'Backspace', PageDown: 'PageDown', PageUp: 'PageUp', Space: 'Space' };

class PageDriver {
  constructor(webContents) {
    this.wc = webContents;
    this.gen = null;
    this.lastSnapshot = null;
  }

  alive() { return this.wc && !this.wc.isDestroyed(); }

  async run(code) {
    if (!this.alive()) throw new Error('탭이 닫혔습니다.');
    return this.wc.executeJavaScriptInIsolatedWorld(WORLD, [{ code }], false);
  }

  key(id) {
    if (!this.gen) throw new Error('먼저 화면을 관찰해야 합니다.');
    return `${this.gen}:${id}`;
  }

  // 페이지 로딩이 끝날 때까지(최대 timeout) 기다린다
  async settle(timeout = 8000) {
    const start = Date.now();
    await sleep(150);
    while (this.alive() && this.wc.isLoading() && Date.now() - start < timeout) await sleep(150);
    await sleep(350);
  }

  async observe({ screenshot = false, textMax = 6000 } = {}) {
    await this.settle(6000);
    let snap;
    for (let i = 0; i < 3; i++) {
      try { snap = await this.run(S.snapshot({ textMax, maxElements: 200 })); break; }
      catch (e) { if (i === 2) throw e; await sleep(500); }
    }
    this.gen = snap.gen;
    this.lastSnapshot = snap;
    let image = null;
    if (screenshot) image = await this.capture(true);
    return { snap, image };
  }

  async capture(withMarks) {
    try {
      if (withMarks) await this.run(S.marksOn());
      await sleep(60);
      let img = null;
      for (let i = 0; i < 4 && !img; i++) {
        try { img = await this.wc.capturePage(); if (img.isEmpty()) img = null; }
        catch (e) { if (i === 3) throw e; }
        if (!img) await sleep(250 * (i + 1)); // 새 페이지는 첫 화면이 그려질 때까지 잠깐 걸린다
      }
      if (!img) throw new Error('empty');
      if (withMarks) await this.run(S.marksOff());
      const size = img.getSize();
      const scaled = size.width > 1280 ? img.resize({ width: 1280, quality: 'good' }) : img;
      return { media_type: 'image/jpeg', data: scaled.toJPEG(70).toString('base64') };
    } catch (_) {
      try { await this.run(S.marksOff()); } catch (__) {}
      return null;
    }
  }

  async locate(id) {
    const info = await this.run(S.locate(this.key(id)));
    if (!info.ok) throw new Error(info.error);
    await sleep(80);
    return info;
  }

  async mouseClick(x, y) {
    this.wc.sendInputEvent({ type: 'mouseMove', x, y });
    this.wc.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
    await sleep(40);
    this.wc.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
  }

  async click(id) {
    const info = await this.locate(id);
    if (info.covered) {
      // 다른 요소(팝업 등)에 가려져 있으면 강제 클릭하지 않고 알려 준다
      return { ok: false, message: `[${id}]번이 다른 요소("${info.coverName}")에 가려져 있습니다. 팝업을 먼저 닫거나 다른 방법을 쓰세요.` };
    }
    // 관찰한 뒤 페이지가 버튼 이름을 위험한 말(결제·송금·보내기 등)로 바꿨으면 누르지 않는다(판정은 관찰 시점 이름으로 했으므로)
    const seen = this.lastSnapshot && Array.isArray(this.lastSnapshot.elements) ? this.lastSnapshot.elements.find(e => e.id === id) : null;
    if (seen && riskierNow(seen.name, info.name)) {
      return { ok: false, message: `[${id}]번 이름이 관찰 때("${String(seen.name).slice(0, 40)}")와 달라져 위험해 보이는 "${String(info.name).slice(0, 40)}"(으)로 바뀌었습니다. 누르지 않았습니다. 화면을 다시 확인하세요.` };
    }
    await this.mouseClick(info.x, info.y);
    await this.settle();
    return { ok: true, message: `[${id}] "${info.name}" 클릭함` };
  }

  // 이 탭이 사용자에게 보이고 키보드 포커스를 가진 상태인지
  focused() { try { return this.wc.isFocused(); } catch (_) { return false; } }

  async typeText(id, text, { clear = true, pressEnter = false } = {}) {
    const info = await this.locate(id);
    if (!info.editable) return { ok: false, message: `[${id}]번은 글자를 입력할 수 있는 칸이 아닙니다.` };
    text = String(text);
    const key = this.key(id);
    let typed = false;
    if (this.focused()) {
      // 실제 키보드와 같은 방식(신뢰도 높음)
      if (!info.covered) await this.mouseClick(info.x, info.y);
      await this.run(S.focusClear(key, clear));
      if (clear) { this.wc.sendInputEvent({ type: 'keyDown', keyCode: 'Backspace' }); this.wc.sendInputEvent({ type: 'keyUp', keyCode: 'Backspace' }); }
      await sleep(30);
      this.wc.insertText(text);
      await sleep(120);
      const v = await this.run(S.readValue(key));
      typed = typeof v === 'string' && v.includes(text);
    }
    if (!typed) {
      // 백그라운드 탭: 페이지 안에서 직접 값을 넣는다(사용자 작업을 방해하지 않음)
      const r = await this.run(S.jsType(key, text, clear));
      typed = r.ok;
    }
    await sleep(150);
    if (pressEnter) await this.pressKey('Enter');
    else await this.settle(1500);
    return typed ? { ok: true, message: `[${id}]에 "${text.slice(0, 60)}" 입력${pressEnter ? ' 후 Enter' : ''}` } : { ok: false, message: `[${id}]에 입력하지 못했습니다.` };
  }

  async selectOption(id, option) {
    const r = await this.run(S.select(this.key(id), option));
    await this.settle(3000);
    return r.ok ? { ok: true, message: `[${id}]에서 "${r.chosen}" 선택` } : { ok: false, message: r.error };
  }

  async scroll(direction, amount = 'page') {
    const r = await this.run(S.scroll(direction, amount));
    await sleep(300);
    return { ok: true, message: r.moved === 0 ? '더 이상 스크롤되지 않습니다(끝에 도달).' : `${direction === 'up' ? '위' : '아래'}로 ${Math.abs(r.moved)}px 스크롤` };
  }

  async pressKey(key) {
    const code = KEYS[key];
    if (!code) return { ok: false, message: '지원하지 않는 키: ' + key };
    if (this.focused()) {
      this.wc.sendInputEvent({ type: 'keyDown', keyCode: code });
      if (key === 'Enter') this.wc.sendInputEvent({ type: 'char', keyCode: '\r' });
      this.wc.sendInputEvent({ type: 'keyUp', keyCode: code });
    } else {
      await this.run(S.jsKey(key));
    }
    await this.settle(key === 'Enter' ? 8000 : 1000);
    return { ok: true, message: `${key} 키 누름` };
  }

  async navigate(url) {
    const u = normalizeUrl(url);
    if (!u) return { ok: false, message: 'http/https 주소만 열 수 있습니다.' };
    try { await this.wc.loadURL(u); } catch (e) { /* 리다이렉트 중단 등은 무시하고 결과 화면을 본다 */ }
    await this.settle(10000);
    return { ok: true, message: `${u} 열기` };
  }

  async goBack() {
    const nav = this.wc.navigationHistory;
    if (nav && nav.canGoBack()) { nav.goBack(); await this.settle(); return { ok: true, message: '뒤로 가기' }; }
    return { ok: false, message: '뒤로 갈 페이지가 없습니다.' };
  }

  async fullText(max = 20000) { return this.run(S.fullText(max)); }
}

function normalizeUrl(input) {
  let s = String(input || '').trim();
  if (!s) return null;
  if (/^(javascript|file|data|chrome|devtools|about):/i.test(s) && !/^about:blank$/i.test(s)) return null;
  if (!/^https?:\/\//i.test(s)) s = 'https://' + s;
  try { const u = new URL(s); return u.href; } catch (_) { return null; }
}

// 사용자가 주소창에 친 글자 → 주소 또는 검색
function addressBarToUrl(input) {
  const s = String(input || '').trim();
  if (/^https?:\/\//i.test(s)) return s;
  if (/^[\w-]+(\.[\w-]+)+(:\d+)?(\/.*)?$/.test(s) || /^localhost(:\d+)?/.test(s)) return 'https://' + s;
  return 'https://www.google.com/search?q=' + encodeURIComponent(s);
}

module.exports = { PageDriver, normalizeUrl, addressBarToUrl };

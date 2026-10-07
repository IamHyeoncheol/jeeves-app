// 탭 관리자
// - 사용자가 보고 있는 탭만 메인 창에 붙이고, 나머지 탭(에이전트 탭 포함)은
//   보이지 않는 "주차장 창"에 붙여 둔다. 그래서 백그라운드 탭도 화면이 정상적으로 그려지고
//   (멈춤·느려짐 없음) 에이전트가 사람 작업을 방해하지 않고 일할 수 있다.
const { BrowserWindow, WebContentsView, shell } = require('electron');
const { EventEmitter } = require('events');

class TabManager extends EventEmitter {
  constructor(mainWin, { partition, viewport }) {
    super();
    this.win = mainWin;
    this.partition = partition;
    this.viewport = viewport;
    this.tabs = new Map();
    this.activeId = null;
    this.seq = 0;
    this.bounds = { x: 0, y: 0, width: 800, height: 600 };
    this.hidden = false; // 설정 창 등이 열려 있으면 웹 화면을 잠시 숨긴다
    // 주차장 창: 백그라운드 탭(에이전트 탭 포함)이 정상적으로 그려지고 클릭·입력을 받게 하는 보이지 않는 창.
    // - 완전히 숨기거나 화면 밖에 두면 페이지가 다른 사이트로 넘어간 뒤 클릭이 전달되지 않는 문제가 있어
    //   화면 안(주 모니터 왼쪽 위)에 두되, 완전히 투명 + 마우스 통과 + 포커스 불가로 만들어 사용자에게 영향이 없게 한다.
    const { screen } = require('electron');
    const wa = screen.getPrimaryDisplay().workArea;
    this.parking = new BrowserWindow({
      show: false, x: wa.x, y: wa.y, width: viewport.width, height: viewport.height,
      frame: false, focusable: false, skipTaskbar: true, resizable: false, hasShadow: false,
      type: process.platform === 'win32' ? 'toolbar' : undefined,
      webPreferences: { backgroundThrottling: false }
    });
    this.parking.setOpacity(0);
    this.parking.setIgnoreMouseEvents(true); // 사용자의 마우스는 이 창을 그냥 통과한다
    this.parking.showInactive();
  }

  create(url, { agent = false, activate = true, taskId = null } = {}) {
    const id = ++this.seq;
    const view = new WebContentsView({
      webPreferences: { partition: this.partition, backgroundThrottling: false, contextIsolation: true, sandbox: true, nodeIntegration: false }
    });
    view.setBackgroundColor('#ffffff');
    const tab = { id, view, agent, taskId, title: agent ? '에이전트 작업' : '새 탭', url: url || '', loading: false, favicon: '' };
    this.tabs.set(id, tab);
    const wc = view.webContents;

    const changed = () => this.emit('changed');
    wc.on('page-title-updated', (_, t) => { tab.title = (tab.agent ? '🤖 ' : '') + t; changed(); });
    wc.on('did-start-loading', () => { tab.loading = true; changed(); });
    wc.on('did-stop-loading', () => { tab.loading = false; tab.url = wc.getURL(); changed(); });
    wc.on('did-navigate', (_, u) => { tab.url = u; changed(); });
    wc.on('did-navigate-in-page', (_, u) => { tab.url = u; changed(); });
    wc.on('page-favicon-updated', (_, f) => { tab.favicon = f[0] || ''; changed(); });
    // 새 창으로 여는 링크 → 같은 앱의 새 탭으로 연다 (에이전트 탭이면 그 탭에서 그대로 연다)
    wc.setWindowOpenHandler(({ url: u }) => {
      if (!/^https?:/i.test(u)) { return { action: 'deny' }; }
      if (tab.agent) wc.loadURL(u); else this.create(u, { activate: true });
      return { action: 'deny' };
    });
    // 다운로드는 테스트 버전에서 사용자 확인 후 진행 (Windows 기본 저장 대화상자)
    wc.on('will-navigate', (e, u) => { if (/^(mailto|tel):/i.test(u)) { e.preventDefault(); shell.openExternal(u); } });

    this.park(tab);
    if (url) wc.loadURL(url).catch(() => {});
    if (activate) this.activate(id);
    changed();
    return tab;
  }

  park(tab) {
    try { this.win.contentView.removeChildView(tab.view); } catch (_) {}
    this.parking.contentView.addChildView(tab.view);
    tab.view.setBounds({ x: 0, y: 0, width: this.viewport.width, height: this.viewport.height });
  }

  activate(id) {
    const tab = this.tabs.get(id);
    if (!tab) return;
    if (this.activeId && this.activeId !== id) {
      const prev = this.tabs.get(this.activeId);
      if (prev) this.park(prev);
    }
    this.activeId = id;
    if (!this.hidden) {
      try { this.parking.contentView.removeChildView(tab.view); } catch (_) {}
      this.win.contentView.addChildView(tab.view);
    }
    this.layout();
    this.emit('changed');
  }

  setBounds(b) { this.bounds = b; this.layout(); }
  // 작업 화면 모드(또는 설정 창)에서는 웹 화면을 메인 창에서 떼어 주차장 창에 둔다.
  // 그래도 화면은 계속 그려지므로 미리보기 캡처와 에이전트 작업이 그대로 된다.
  setHidden(h) {
    if (this.hidden === h) return;
    this.hidden = h;
    const tab = this.active();
    if (tab) {
      if (h) this.park(tab);
      else { try { this.parking.contentView.removeChildView(tab.view); } catch (_) {} this.win.contentView.addChildView(tab.view); }
    }
    this.layout();
  }

  // 미리보기용 축소 캡처 (data URL)
  async thumbnail(id, width = 480) {
    const tab = this.tabs.get(id);
    if (!tab || tab.view.webContents.isDestroyed()) return null;
    const url = tab.view.webContents.getURL();
    if (!url || url === 'about:blank') return null;
    try {
      const img = await tab.view.webContents.capturePage();
      if (img.isEmpty()) return null;
      const w = Math.min(width, img.getSize().width);
      return 'data:image/jpeg;base64,' + img.resize({ width: w, quality: 'good' }).toJPEG(72).toString('base64');
    } catch (_) { return null; }
  }

  layout() {
    const tab = this.tabs.get(this.activeId);
    if (!tab) return;
    if (this.hidden) return; // 주차장 창에서 원래 크기 유지
    tab.view.setBounds({ x: Math.round(this.bounds.x), y: Math.round(this.bounds.y), width: Math.max(1, Math.round(this.bounds.width)), height: Math.max(1, Math.round(this.bounds.height)) });
  }

  close(id) {
    const tab = this.tabs.get(id);
    if (!tab) return;
    try { this.win.contentView.removeChildView(tab.view); } catch (_) {}
    try { this.parking.contentView.removeChildView(tab.view); } catch (_) {}
    tab.view.webContents.close();
    this.tabs.delete(id);
    this.emit('closed', id);
    if (this.activeId === id) {
      this.activeId = null;
      const rest = [...this.tabs.values()].filter(t => !t.agent);
      const next = rest[rest.length - 1] || [...this.tabs.values()].pop();
      if (next) this.activate(next.id);
    }
    this.emit('changed');
  }

  get(id) { return this.tabs.get(id); }
  active() { return this.tabs.get(this.activeId); }

  list() {
    return [...this.tabs.values()].map(t => ({
      id: t.id, title: t.title, url: t.url, loading: t.loading, favicon: t.favicon, agent: t.agent, taskId: t.taskId,
      active: t.id === this.activeId,
      canGoBack: !t.view.webContents.isDestroyed() && t.view.webContents.navigationHistory.canGoBack(),
      canGoForward: !t.view.webContents.isDestroyed() && t.view.webContents.navigationHistory.canGoForward()
    }));
  }

  destroy() { try { this.parking.destroy(); } catch (_) {} }
}

module.exports = { TabManager };

// 화면(UI)과 메인 프로세스 사이의 안전한 연결 통로
const { contextBridge, ipcRenderer } = require('electron');

const on = (ch, fn) => { const h = (_, d) => fn(d); ipcRenderer.on(ch, h); return () => ipcRenderer.removeListener(ch, h); };

contextBridge.exposeInMainWorld('jeeves', {
  tabs: {
    create: url => ipcRenderer.invoke('tabs:create', url),
    close: id => ipcRenderer.invoke('tabs:close', id),
    activate: id => ipcRenderer.invoke('tabs:activate', id),
    navigate: (id, input) => ipcRenderer.invoke('tabs:navigate', { id, input }),
    nav: (id, action) => ipcRenderer.invoke('tabs:nav', { id, action }),
    thumb: (id, width) => ipcRenderer.invoke('tabs:thumb', { id, width }),
    onUpdate: fn => on('tabs:update', fn)
  },
  layout: {
    setBounds: b => ipcRenderer.invoke('layout:bounds', b),
    hideWeb: h => ipcRenderer.invoke('layout:hide-web', h)
  },
  config: {
    get: () => ipcRenderer.invoke('config:get'),
    update: patch => ipcRenderer.invoke('config:update', patch),
    test: role => ipcRenderer.invoke('config:test', role),
    importKeys: () => ipcRenderer.invoke('config:import-keys'),
    addProvider: spec => ipcRenderer.invoke('config:add-provider', spec),
    removeProvider: id => ipcRenderer.invoke('config:remove-provider', id),
    restoreProviders: () => ipcRenderer.invoke('config:restore-providers'),
    onUpdate: fn => on('config:update', fn),
    routerStatus: () => ipcRenderer.invoke('router:status'),
    onNotice: fn => on('router:notice', fn)
  },
  chat: {
    send: (text, opts) => ipcRenderer.invoke('chat:send', { text, ...opts }),
    reset: () => ipcRenderer.invoke('chat:reset'),
    truncate: (convId, k) => ipcRenderer.invoke('chat:truncate', { convId, k }),
    exportText: (name, text) => ipcRenderer.invoke('export:save', { name, text }),
    feedback: f => ipcRenderer.invoke('feedback:save', f)
  },
  sidebar: {
    get: () => ipcRenderer.invoke('sidebar:get'),
    onChanged: fn => on('sidebar:changed', fn),
    openConv: id => ipcRenderer.invoke('conv:open', id),
    renameConv: (id, title) => ipcRenderer.invoke('conv:rename', { id, title }),
    deleteConv: id => ipcRenderer.invoke('conv:delete', id),
    setConvProject: (id, projectId) => ipcRenderer.invoke('conv:set-project', { id, projectId }),
    addProject: name => ipcRenderer.invoke('project:add', name),
    renameProject: (id, name) => ipcRenderer.invoke('project:rename', { id, name }),
    deleteProject: id => ipcRenderer.invoke('project:delete', id),
    setWorkProject: (at, projectId) => ipcRenderer.invoke('work:set-project', { at, projectId }),
    deleteWork: at => ipcRenderer.invoke('work:delete', at)
  },
  agent: {
    start: (goal, where, infoGrade, projectId, attachments) => ipcRenderer.invoke('agent:start', { goal, where, infoGrade, projectId, attachments }),
    stop: id => ipcRenderer.invoke('agent:stop', id),
    respond: (id, payload) => ipcRenderer.invoke('agent:respond', { id, payload }),
    showTab: id => ipcRenderer.invoke('agent:show-tab', id),
    onEvent: fn => on('agent:event', fn)
  },
  usage: () => ipcRenderer.invoke('usage:get'),
  grade: { suspect: text => ipcRenderer.invoke('grade:suspect', String(text || '')) },
  mcp: {
    status: () => ipcRenderer.invoke('mcp:status'),
    restart: regenerate => ipcRenderer.invoke('mcp:restart', { regenerate })
  },
  cc: { check: custom => ipcRenderer.invoke('cc:check', custom) },
  copy: text => ipcRenderer.invoke('copy', String(text)),
  history: () => ipcRenderer.invoke('history:get'),
  ui: {
    onFocusAddress: fn => on('ui:focus-address', fn),
    onFocusChat: fn => on('ui:focus-chat', fn)
  }
});

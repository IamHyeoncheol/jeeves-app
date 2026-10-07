// 실제 Claude Code 를 구독 엔진으로 써서 Jeeves 앱 전체 흐름 확인 (개발 환경에서 1회 실행용)
const { app, BrowserWindow } = require('electron');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const outDir = path.join(__dirname, '..', 'shots');
fs.mkdirSync(outDir, { recursive: true });
const SITE = `<!doctype html><html><head><meta charset="utf-8"><title>가상 지원사업 포털</title></head><body style="font-family:sans-serif;padding:20px">
<h1>가상 지원사업 포털</h1><form action="/search"><input name="kw" placeholder="사업명 검색"> <button>검색</button></form></body></html>`;
const RESULTS = kw => `<!doctype html><html><head><meta charset="utf-8"><title>검색 결과</title></head><body style="font-family:sans-serif;padding:20px">
<h2>"${kw}" 검색 결과</h2><ul><li>전기안전 기술 실증 지원 (마감 2026-10-30)</li><li>안전설비 보급 사업 (마감 2026-11-14)</li><li>R&D 바우처 (마감 2026-10-21)</li></ul></body></html>`;
const site = http.createServer((q, r) => { r.setHeader('content-type', 'text/html; charset=utf-8'); const u = new URL(q.url, 'http://x'); r.end(u.pathname === '/search' ? RESULTS(u.searchParams.get('kw') || '') : SITE); }).listen(0);

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'jeeves-cc-'));
const claudeBin = execFileSync('which', ['claude']).toString().trim();
fs.writeFileSync(path.join(userData, 'jeeves-config.json'), JSON.stringify({
  version: 2, engine: { type: 'claude-code', claudePath: claudeBin, claudeModel: 'sonnet' },
  mcp: { enabled: true, port: 47831, token: 'tok_REAL_TEST_abcdefghijklmnop' }, ui: { homepage: `http://127.0.0.1:${site.address().port}/` }
}));
process.env.JEEVES_USER_DATA = userData;
require('../src/main/main.js');
const sleep = ms => new Promise(r => setTimeout(r, ms));

app.whenReady().then(async () => {
  await sleep(4000);
  const win = BrowserWindow.getAllWindows().find(w => w.webContents.getURL().endsWith('index.html'));
  const ui = js => win.webContents.executeJavaScript(js);
  await ui(`document.querySelector('[data-mode=act]').click(); document.querySelector('#input').value='http://127.0.0.1:${site.address().port}/ 에서 "전기안전"을 검색하고, 결과 3건을 마감일이 빠른 순서로 알려줘'; document.querySelector('#send').click();`);
  let card = '';
  for (let i = 0; i < 240; i++) { await sleep(1000); card = await ui(`(document.querySelector('.card')||{}).innerText||''`); if (/완료|중단/.test(await ui(`(document.querySelector('.card .badge')||{}).textContent||''`))) break; }
  const shot = await win.webContents.capturePage(); fs.writeFileSync(path.join(outDir, 'cc-real.png'), shot.toPNG());
  console.log('CARD:\n' + card);
  const ok = /10-21/.test(card) && /R&D/.test(card) && /구독/.test(card);
  console.log(ok ? 'CC REAL OK' : 'CC REAL PROBLEM');
  app.exit(ok ? 0 : 1);
});

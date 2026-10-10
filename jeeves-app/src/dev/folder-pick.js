// 개발 작업 폴더를 "미리 정해 둔 값"이 아니라 이번 지시 내용과 대화 맥락으로 정한다(0.48, AI 호출 없음).
// 순서: ① 지시문에 적힌 경로 → ② 이 대화에서 이미 쓰던 폴더 → ③ 모르면 묻는다(ask).
// 마지막에 쓴 전역 폴더를 몰래 쓰지 않는다 — 그것이 엉뚱한 폴더에 파일이 만들어진 원인이었다.
const path = require('path');
const W = path.win32;

const PATH_RE = /[A-Za-z]:[\\/][^\s"'<>|?*\r\n]*/g;
const TRAIL_PUNCT = /[.,;:!?)\]}」』”’…]+$/;
const JOSA_RE = /(으로써|으로|에서|에게|까지|부터|이라는|라는|이랑|하고|이며|이고|라고|을|를|은|는|이|가|로|에|의|와|과|도|만|랑)$/;
const FILE_EXT = /\.[A-Za-z0-9]{1,6}$/;

// stat(p) → 'dir' | 'file' | null  (시험에서는 가짜를 넣는다)
function cleanPath(raw, stat) {
  let p = raw.replace(/\//g, '\\').replace(TRAIL_PUNCT, '').replace(/\\+$/, '');
  if (/^[A-Za-z]:$/.test(p)) return p + '\\';
  // "…\iris_recognition를" 처럼 조사가 붙은 경우: 조사를 뗀 경로가 실제로 있을 때만 뗀다
  const cands = [p];
  let q = p;
  for (let i = 0; i < 2; i++) { const m = JOSA_RE.exec(q); if (!m) break; q = q.slice(0, q.length - m[0].length); if (q.length > 3) cands.push(q); }
  for (const c of cands) if (stat(c)) return c;   // 실제로 있는 경로가 먼저
  for (const c of cands.slice(1)) if (stat(W.dirname(c)) && !stat(W.dirname(p))) return c;
  // 어느 것도 없으면(새 폴더): 헷갈리지 않는 조사(이·가 제외)만 뗀다
  const m = /(으로써|으로|에서|에게|까지|부터|이라는|라는|이랑|하고|이며|이고|라고|을|를|은|는|로|에|의|와|과|도|만|랑)$/.exec(p);
  return m && p.length - m[0].length > 3 ? p.slice(0, p.length - m[0].length) : p;
}

function nearestExistingDir(p, stat) {
  let cur = p;
  for (let i = 0; i < 40; i++) {
    if (stat(cur) === 'dir') return cur;
    const up = W.dirname(cur);
    if (up === cur) return null;
    cur = up;
  }
  return null;
}

function commonAncestor(dirs) {
  const parts = dirs.map(d => W.resolve(d).split('\\').filter(Boolean));
  const first = parts[0], out = [];
  for (let i = 0; i < first.length; i++) {
    if (parts.every(p => p[i] && p[i].toLowerCase() === first[i].toLowerCase())) out.push(first[i]); else break;
  }
  return out.length ? out.join('\\') + (out.length === 1 ? '\\' : '') : null;
}

// 반환: { folder, source, reason, create?, broad? }  또는  { folder: null, ask: true, reason }
function pickFolderFor(goal, { sessionFolder = '', stat = () => null } = {}) {
  const text = String(goal || '');
  const raws = text.match(PATH_RE) || [];
  const found = [];
  for (const r of raws) {
    const p = cleanPath(r, stat);
    if (!/^[A-Za-z]:\\./.test(p)) continue;   // 드라이브 루트만 있는 경로는 폴더 단서로 쓰지 않는다
    if (!found.some(x => x.toLowerCase() === p.toLowerCase())) found.push(p);
  }
  if (found.length) {
    const dirs = [], news = [];
    for (const p of found) {
      const k = stat(p);
      if (k === 'dir') dirs.push(p);
      else if (k === 'file') dirs.push(W.dirname(p));
      else if (FILE_EXT.test(p)) { const d = nearestExistingDir(W.dirname(p), stat); if (d) dirs.push(d); }
      else { news.push(p); }
    }
    if (!dirs.length && news.length === 1 && stat(W.dirname(news[0])) === 'dir')
      return { folder: news[0], source: '지시문의 경로', reason: `지시문에 적힌 새 폴더 ${news[0]} (없어서 새로 만듭니다)`, create: true };
    for (const n of news) { const d = nearestExistingDir(W.dirname(n), stat); if (d) dirs.push(d); }
    if (dirs.length === 1) return { folder: dirs[0], source: '지시문의 경로', reason: `지시문에 적힌 경로 ${found[0]}` };
    if (dirs.length > 1) {
      const c = commonAncestor(dirs);
      if (c && !/^[A-Za-z]:\\?$/.test(c)) return { folder: c, source: '지시문의 경로', broad: true, reason: `지시문에 폴더가 여러 개 적혀 있어 그 위쪽 공통 폴더(${c})에서 작업합니다` };
    }
  }
  if (sessionFolder) return { folder: sessionFolder, source: '이 대화에서 이미 쓰던 폴더', reason: '이 대화에서 앞서 작업한 폴더를 이어서 씁니다' };
  return { folder: null, ask: true, reason: '지시문에 폴더가 없고 이 대화에서 쓴 폴더도 없습니다' };
}

module.exports = { pickFolderFor, extractPaths: (t, stat = () => null) => (String(t || '').match(PATH_RE) || []).map(r => cleanPath(r, stat)) };

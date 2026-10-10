// AI별 작업 내역(2026-10-10 사용자 요청): 개발 엔진이 한 번 끝날 때마다 "어느 AI가 어느 파일의 어느 줄을 추가·수정·삭제했는지"를
// 코드가 기록한다(AI 호출·토큰 0). Git 폴더는 체크포인트 사이 diff 로 줄·영역까지, Git 이 아니면 파일 단위까지.
// 기록: <프로젝트>/.jeeves/ATTRIBUTION.jsonl (Git 에서 제외되는 지브스 작업 폴더)
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const MAX_FILES = 200, MAX_HUNKS = 30;

function git(folder, args) {
  return new Promise(resolve => execFile('git', args, { cwd: folder, windowsHide: true, timeout: 30000, maxBuffer: 16 * 1024 * 1024 }, (err, out) => resolve(err ? null : String(out))));
}

// `git diff -U0` 출력에서 파일별 바뀐 줄 범위(새 파일 기준)와 함수 영역 이름을 뽑는다. 순수 함수 — 시험 가능
function parseHunks(diffText) {
  const files = {};
  let cur = null;
  for (const line of String(diffText || '').split('\n')) {
    const f = line.match(/^\+\+\+ b\/(.+)$/) || line.match(/^\+\+\+ (\/dev\/null)$/);
    if (line.startsWith('diff --git ')) { const m = line.match(/ b\/(.+)$/); cur = m ? m[1] : null; if (cur && !files[cur]) files[cur] = []; continue; }
    if (f && f[1] !== '/dev/null') { cur = f[1]; if (!files[cur]) files[cur] = []; continue; }
    const h = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@\s?(.*)$/);
    if (h && cur) {
      if (files[cur].length >= MAX_HUNKS) continue;
      const oldN = h[2] === undefined ? 1 : +h[2], newN = h[4] === undefined ? 1 : +h[4];
      const start = +h[3];
      files[cur].push({ from: newN ? start : Math.max(1, start), to: newN ? start + newN - 1 : Math.max(1, start), added: newN, removed: oldN, where: String(h[5] || '').trim().slice(0, 80) });
    }
  }
  return files;
}

// `git diff --numstat -z` 대신 줄 단위(numstat + name-status)를 합친다
function parseNumstat(text) {
  const out = {};
  for (const l of String(text || '').split('\n')) {
    const m = l.match(/^(\d+|-)\t(\d+|-)\t(.+)$/);
    if (m) out[m[3]] = { plus: m[1] === '-' ? null : +m[1], minus: m[2] === '-' ? null : +m[2] };
  }
  return out;
}
function parseNameStatus(text) {
  const out = {};
  for (const l of String(text || '').split('\n')) {
    const m = l.match(/^([AMDRC])\d*\t(.+?)(?:\t(.+))?$/);
    if (m) out[m[3] || m[2]] = m[1] === 'A' ? 'added' : m[1] === 'D' ? 'removed' : 'modified';
  }
  return out;
}

// Git 체크포인트 두 개 사이의 변경(엔진 한 번이 한 일)
async function gitAttribution(folder, fromRef, toRef) {
  if (!fromRef || !toRef) return null;
  const range = [fromRef, toRef, '--', '.', ':(exclude).jeeves'];
  const [ns, st, u0] = await Promise.all([
    git(folder, ['diff', '--numstat', ...range]),
    git(folder, ['diff', '--name-status', ...range]),
    git(folder, ['diff', '-U0', '--no-color', '--no-ext-diff', ...range])
  ]);
  if (ns === null || st === null) return null;
  const num = parseNumstat(ns), status = parseNameStatus(st), hunks = parseHunks(u0 || '');
  const files = Object.keys(status).slice(0, MAX_FILES).map(f => ({
    path: f, change: status[f], plus: num[f] ? num[f].plus : null, minus: num[f] ? num[f].minus : null, regions: hunks[f] || []
  }));
  return { files, truncated: Object.keys(status).length > MAX_FILES, detail: 'lines' };
}

// Git 이 아닐 때: 스냅샷 비교 결과(파일 이름만)
function snapAttribution(diff) {
  if (!diff) return null;
  const files = [
    ...diff.added.map(p => ({ path: p, change: 'added' })),
    ...diff.modified.map(p => ({ path: p, change: 'modified' })),
    ...diff.removed.map(p => ({ path: p, change: 'removed' }))
  ].filter(f => !f.path.startsWith('.jeeves/')).slice(0, MAX_FILES);
  return { files, truncated: !!diff.truncated, detail: 'files' };
}

function append(folder, entry) {
  try {
    const dir = path.join(folder, '.jeeves'); fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, 'ATTRIBUTION.jsonl'), JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n', 'utf8');
  } catch (_) {}
}

// 화면·커밋 메시지용 요약 (순수 함수). entries: [{ engine, files:[...] }]
function summarize(entries, { maxFiles = 6 } = {}) {
  const lines = [];
  for (const e of entries || []) {
    const fs_ = (e.files || []);
    if (!fs_.length) { lines.push(`${e.engine}: 변경 없음`); continue; }
    const plus = fs_.reduce((n, f) => n + (f.plus || 0), 0), minus = fs_.reduce((n, f) => n + (f.minus || 0), 0);
    const cnt = k => fs_.filter(f => f.change === k).length;
    const head = `${e.engine}: 추가 ${cnt('added')}·수정 ${cnt('modified')}·삭제 ${cnt('removed')}개 파일` + (e.detail === 'lines' ? ` (+${plus}/−${minus}줄)` : '');
    const det = fs_.slice(0, maxFiles).map(f => {
      const r = (f.regions || []).slice(0, 3).map(x => `${x.from}~${x.to}줄${x.where ? ' ' + x.where : ''}`).join(', ');
      return `  - ${f.path} [${f.change === 'added' ? '추가' : f.change === 'removed' ? '삭제' : '수정'}]${f.plus != null ? ` +${f.plus}/−${f.minus}` : ''}${r ? ' — ' + r : ''}`;
    });
    if (fs_.length > maxFiles) det.push(`  - 외 ${fs_.length - maxFiles}개`);
    lines.push(head, ...det);
  }
  return lines.join('\n');
}

module.exports = { parseHunks, parseNumstat, parseNameStatus, gitAttribution, snapAttribution, append, summarize };

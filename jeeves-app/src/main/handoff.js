// 개발 도구 전환 인수인계: 엔진(Claude Code·Codex·기타)이 바뀌어도 같은 맥락·같은 규칙으로 이어가도록
// 프로젝트 폴더의 .jeeves\ 에 인수인계 파일을 만든다. 파일은 AI 가 아니라 지브스 코드가 만든다(토큰 0).
// 사양: 사양서\02_개발도구_전환_인수인계.md. 비밀(키·비밀번호)은 어떤 파일에도 쓰지 않는다(기준서 7장).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn, execFile } = require('child_process');

const DIR = '.jeeves';
const MAX_HANDOFF = 2000;          // HANDOFF.md 글자 상한(다음 엔진이 읽는 토큰을 약 600 이하로)
const LOCK_STALE_MS = 3 * 60 * 60 * 1000;

// 다음 엔진에게 붙이는 공통 안내(150토큰 이내). 모든 엔진이 같은 문구를 받아 CLAUDE.md/AGENTS.md 차이로 달라지지 않게 한다.
const NOTICE = `[지브스 인수인계 안내] 먼저 .jeeves/HANDOFF.md 를 읽고 이미 된 일·깨진 파일·실패한 시험부터 확인하세요(.jeeves/CONTEXT.md 가 있으면 그 규칙·결정도 따르세요). 이미 된 파일은 다시 만들지 말고, 지시 범위 밖 파일은 고치지 마세요. 새 구조·라이브러리를 정했다면 .jeeves/CONTEXT.md 의 "결정" 줄에 이유와 함께 한 줄 추가하세요. 끝나면 마지막에 아래 3줄로 보고하세요.
한 일: …
남은 일: …
주의: …`;

// 기록에 비밀이 섞이지 않게 지운다
const SECRET_RES = [
  /sk-[A-Za-z0-9_\-]{16,}/g, /AIza[0-9A-Za-z_\-]{20,}/g, /xai-[A-Za-z0-9]{16,}/g, /gh[pousr]_[A-Za-z0-9]{20,}/g,
  /Bearer\s+[A-Za-z0-9._\-]{16,}/gi, /(password|passwd|비밀번호|api[_-]?key|token|secret)\s*[:=]\s*\S+/gi
];
function scrub(s) { let t = String(s == null ? '' : s); for (const re of SECRET_RES) t = t.replace(re, m => (/[:=]/.test(m) && !/^(sk-|AIza|xai-|gh|Bearer)/i.test(m) ? m.replace(/([:=]\s*)\S+$/, '$1[삭제됨]') : '[삭제됨]')); return t; }

const goalHash = g => crypto.createHash('sha1').update(String(g || '')).digest('hex').slice(0, 12);
const jdir = folder => path.join(folder, DIR);
const ensure = folder => { try { fs.mkdirSync(jdir(folder), { recursive: true }); return true; } catch (_) { return false; } };

// ── 동시 실행 방지(LOCK) ──
function pidAlive(pid) { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } }
function acquireLock(folder, taskId, engineLabel) {
  if (!ensure(folder)) return { ok: true, skipped: true };    // 폴더를 못 만들면 잠금 없이 진행(작업을 막지 않음)
  const f = path.join(jdir(folder), 'LOCK');
  try {
    const cur = JSON.parse(fs.readFileSync(f, 'utf8'));
    const fresh = Date.now() - (cur.at || 0) < LOCK_STALE_MS;
    if (fresh && pidAlive(cur.pid) && !(cur.pid === process.pid && cur.taskId === taskId)) {
      return { ok: false, reason: `이 폴더에서 이미 다른 개발 작업이 실행 중입니다(${cur.engine || '엔진'}). 끝난 뒤 다시 지시해 주세요. (잘못 남은 표시라면 .jeeves\\LOCK 파일을 지우세요)` };
    }
  } catch (_) { /* 없거나 깨짐 → 새로 잡음 */ }
  try { fs.writeFileSync(f, JSON.stringify({ pid: process.pid, taskId, engine: engineLabel || '', at: Date.now() })); } catch (_) {}
  return { ok: true };
}
function releaseLock(folder, taskId) {
  const f = path.join(jdir(folder), 'LOCK');
  try { const cur = JSON.parse(fs.readFileSync(f, 'utf8')); if (cur.pid === process.pid && cur.taskId === taskId) fs.unlinkSync(f); } catch (_) {}
}

// ── 구문 점검(바꾼 파일만): 한도로 끊겨 쓰다 만 파일 찾기 ──
function checkSyntax(folder, files, limit = 60) {
  const bad = [];
  const list = files.filter(f => /\.(js|mjs|cjs|json)$/i.test(f)).slice(0, limit);
  for (const rel of list) {
    const abs = path.join(folder, rel);
    let st; try { st = fs.statSync(abs); } catch (_) { continue; }
    if (!st.isFile() || st.size > 1024 * 1024) continue;
    if (/\.json$/i.test(rel)) {
      try { JSON.parse(fs.readFileSync(abs, 'utf8').replace(/^﻿/, '')); } catch (e) { bad.push(rel); }
    } else {
      const r = require('child_process').spawnSync(process.execPath, ['--check', abs], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, timeout: 15000, windowsHide: true });
      if (r.status !== 0 && r.status !== null) bad.push(rel);
    }
  }
  return bad;
}

// ── 시험 실행(프로젝트에 npm test 가 있을 때만, 코드가 실행 → 토큰 0) ──
const hasTest = dir => { try { const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')); const t = pkg && pkg.scripts && pkg.scripts.test; return !!t && !/no test specified/i.test(t); } catch (_) { return false; } };
// 시험을 돌릴 폴더: 프로젝트 폴더에 package.json(test)이 있으면 그곳, 없으면 바로 아래 하위 폴더 중 첫 번째(예: 지브스_Jeeves\jeeves-app)
function testDir(folder) {
  if (hasTest(folder)) return folder;
  let ents = []; try { ents = fs.readdirSync(folder, { withFileTypes: true }); } catch (_) { return null; }
  for (const e of ents) if (e.isDirectory() && !/^(\.|node_modules$)/.test(e.name) && hasTest(path.join(folder, e.name))) return path.join(folder, e.name);
  return null;
}
function testCommand(folder) { return testDir(folder) ? 'npm test' : null; }
function runTests(folder, timeoutMs = 180000) {
  return new Promise(resolve => {
    const dir = testDir(folder);
    if (!dir) return resolve({ ran: false });
    const win = process.platform === 'win32';
    let out = '', done = false;
    let child;
    try { child = spawn(win ? 'npm.cmd' : 'npm', ['test', '--silent'], { cwd: dir, shell: win, windowsHide: true, env: { ...process.env, CI: '1', FORCE_COLOR: '0' } }); }
    catch (_) { return resolve({ ran: false }); }
    const fin = (code, timedOut) => {
      if (done) return; done = true; clearTimeout(timer);
      const failed = [...new Set(out.split(/\r?\n/).filter(l => /^\s*(FAIL|✗|✖|not ok)\b/i.test(l)).map(l => scrub(l.trim()).slice(0, 120)))].slice(0, 8);
      resolve({ ran: true, ok: code === 0 && !timedOut, timedOut: !!timedOut, failed });
    };
    const timer = setTimeout(() => { try { child.kill(); } catch (_) {} fin(null, true); }, timeoutMs);
    const add = d => { out += d; if (out.length > 200000) out = out.slice(-100000); };
    child.stdout.on('data', add); child.stderr.on('data', add);
    child.on('error', () => fin(1)); child.on('close', code => fin(code));
  });
}

// ── 체크포인트(Git 폴더만): 작업 폴더·브랜치·색인을 건드리지 않고 현재 상태를 refs/jeeves/<작업>/<순번> 에 저장 ──
function git(folder, args, env) {
  return new Promise(resolve => execFile('git', args, { cwd: folder, windowsHide: true, env: { ...process.env, ...(env || {}) }, timeout: 30000, maxBuffer: 4 * 1024 * 1024 }, (err, out) => resolve(err ? null : String(out).trim())));
}
async function checkpoint(folder, taskId, n) {
  if (!fs.existsSync(path.join(folder, '.git'))) return null;
  const idx = path.join(jdir(folder), 'tmp-index');
  ensure(folder);
  try { fs.rmSync(idx, { force: true }); } catch (_) {}
  const env = { GIT_INDEX_FILE: idx };
  const head = await git(folder, ['rev-parse', '-q', '--verify', 'HEAD']);
  if (head) await git(folder, ['read-tree', 'HEAD'], env);
  if (await git(folder, ['add', '-A', '--', '.', ':(exclude).jeeves'], env) === null) { try { fs.rmSync(idx, { force: true }); } catch (_) {} return null; }
  const tree = await git(folder, ['write-tree'], env);
  try { fs.rmSync(idx, { force: true }); } catch (_) {}
  if (!tree) return null;
  const msg = `jeeves checkpoint ${taskId}-${n}`;
  const commit = await git(folder, ['-c', 'user.name=Jeeves', '-c', 'user.email=jeeves@localhost', 'commit-tree', tree, ...(head ? ['-p', head] : []), '-m', msg]);
  if (!commit) return null;
  const ref = `refs/jeeves/${String(taskId).replace(/[^A-Za-z0-9_-]/g, '')}/${n}`;
  if (await git(folder, ['update-ref', ref, commit]) === null) return null;
  return ref;
}

// ── 엔진이 남긴 3줄 보고 읽기 ──
function parseReport(text) {
  const t = String(text || '');
  const pick = k => { const m = t.match(new RegExp(k + '\\s*[:：]\\s*(.+)')); return m ? scrub(m[1]).slice(0, 200).trim() : ''; };
  const r = { done: pick('한 일'), todo: pick('남은 일'), warn: pick('주의') };
  return (r.done || r.todo || r.warn) ? r : null;
}

const KIND_TXT = { limit: '사용 한도', login: '로그인 필요', missing: '실행 불가', task: '작업 실패', error: '오류', stopped: '중지', ok: '성공' };
const fmtTime = t => { try { return new Date(t).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul', hour12: false }); } catch (_) { return ''; } };
const fileList = (arr, n) => arr.length <= n ? arr.join(', ') : arr.slice(0, n).join(', ') + ` 외 ${arr.length - n}개`;

// HANDOFF.md 문서 만들기 (순수 함수 — 시험 가능)
function buildHandoff({ goal, doneWhen, grade, attempts, state, tests, prevTests, badSyntax, checkpointRef, report, now }) {
  const L = [];
  L.push('# 인수인계 (지브스가 자동 작성 — 직접 고치지 마세요)');
  L.push(`goalHash: ${goalHash(goal)} · 갱신: ${fmtTime(now || Date.now())} · 정보 등급: ${grade || 'I'}`);
  L.push('');
  L.push('## 목표 (원문)');
  L.push(scrub(goal).slice(0, 700));
  if (doneWhen && doneWhen.length) L.push('완료 조건: ' + scrub(doneWhen.join(' / ')).slice(0, 300));
  L.push('');
  L.push('## 시도 이력');
  if (!attempts.length) L.push('- 아직 없음(처음 시작)');
  attempts.forEach((a, i) => L.push(`- ${i + 1}. ${a.engineLabel} — ${a.success ? '성공' : (KIND_TXT[a.kind] || '문제')}${a.resumeAt ? ` (한도 풀림 약 ${fmtTime(a.resumeAt)})` : ''}`));
  if (state) {
    L.push('');
    L.push('## 지금 폴더 상태 (파일 이름만, 내용은 직접 열어 확인)');
    L.push(`- 추가 ${state.added.length}: ${fileList(state.added, 15) || '없음'}`);
    L.push(`- 수정 ${state.modified.length}: ${fileList(state.modified, 15) || '없음'}`);
    if (state.removed.length) L.push(`- 삭제 ${state.removed.length}: ${fileList(state.removed, 8)}`);
  }
  const warn = [];
  if (badSyntax && badSyntax.length) warn.push(`⚠ 문법이 깨진 파일(쓰다 끊겼을 수 있음, 먼저 고치기): ${fileList(badSyntax, 8)}`);
  if (tests && tests.ran) {
    if (!tests.ok) warn.push(`⚠ 시험 ${tests.timedOut ? '시간 초과' : '실패'}${tests.failed && tests.failed.length ? ': ' + tests.failed.join(' | ') : ''}`);
    if (!tests.ok && prevTests && prevTests.ran && prevTests.ok) warn.unshift('⚠ 시험 퇴보 — 이전에는 통과했는데 지금 실패합니다. 새 일보다 먼저 복구하세요.');
  }
  L.push('');
  L.push('## 자동 점검 (코드가 실행)');
  L.push(tests && tests.ran ? `- 시험: ${tests.ok ? '통과' : '실패'}` : '- 시험: 실행 안 함(변경 없음 또는 시험 명령 없음)');
  if (warn.length) warn.forEach(w => L.push('- ' + w)); else L.push('- 문법 점검: 이상 없음');
  if (checkpointRef) L.push(`- 체크포인트(Git 저장 지점): ${checkpointRef} — 되돌릴 때: git checkout ${checkpointRef} -- .`);
  L.push('');
  L.push('## 이전 엔진의 보고');
  if (report) { if (report.done) L.push('- 한 일: ' + report.done); if (report.todo) L.push('- 남은 일: ' + report.todo); if (report.warn) L.push('- 주의: ' + report.warn); }
  else L.push('- 보고 없음(중단됨). 위 폴더 상태와 자동 점검을 근거로 이어가세요.');
  let s = L.join('\n');
  if (s.length > MAX_HANDOFF) {   // 상한: 시도 이력 중 오래된 줄부터 줄여 한 줄 요약
    const keep = attempts.slice(-3);
    const old = attempts.length - keep.length;
    const lines = s.split('\n').filter(l => !/^- \d+\. /.test(l));
    const at = lines.indexOf('## 시도 이력') + 1;
    const hist = keep.map((a, i) => `- ${old + i + 1}. ${a.engineLabel} — ${a.success ? '성공' : (KIND_TXT[a.kind] || '문제')}`);
    if (old) hist.unshift(`- (앞선 ${old}회 생략)`);
    lines.splice(at, 0, ...hist);
    s = lines.join('\n');
    if (s.length > MAX_HANDOFF) s = s.slice(0, MAX_HANDOFF - 20) + '\n…(줄임)';
  }
  return scrub(s) + '\n';
}

function writeHandoff(folder, data) {
  if (!ensure(folder)) return false;
  try { fs.writeFileSync(path.join(jdir(folder), 'HANDOFF.md'), buildHandoff(data), 'utf8'); return true; } catch (_) { return false; }
}
function appendLedger(folder, entry) {
  if (!ensure(folder)) return;
  try { fs.appendFileSync(path.join(jdir(folder), 'LEDGER.jsonl'), scrub(JSON.stringify({ at: new Date().toISOString(), ...entry })) + '\n', 'utf8'); } catch (_) {}
}
// 같은 목표의 이전(끊긴) 작업이 남아 있는지: 한도 풀린 뒤 같은 지시를 다시 하면 이어받는다
function readPrevHandoff(folder, goal) {
  try {
    const f = path.join(jdir(folder), 'HANDOFF.md');
    if (Date.now() - fs.statSync(f).mtimeMs > 48 * 3600 * 1000) return null;
    const s = fs.readFileSync(f, 'utf8');
    if (!s.includes('goalHash: ' + goalHash(goal))) return null;
    const hist = (s.split('## 시도 이력')[1] || '').split('\n## ')[0].split('\n').filter(l => /^- \d+\. /.test(l));
    if (!hist.length || /—\s*성공\s*$/.test(hist[hist.length - 1])) return null;   // 이력이 없거나 마지막이 성공이면 이어받을 것 없음
    return s;
  } catch (_) { return null; }
}

module.exports = { NOTICE, scrub, goalHash, acquireLock, releaseLock, checkSyntax, testCommand, testDir, runTests, checkpoint, parseReport, buildHandoff, writeHandoff, appendLedger, readPrevHandoff, MAX_HANDOFF };

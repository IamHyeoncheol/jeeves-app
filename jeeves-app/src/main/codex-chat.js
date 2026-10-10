// Codex(ChatGPT 구독)로 질문 한 번 답 받기 — 대화(Chat)에서 Claude 구독이 한도일 때 크레딧(API) 대신 쓰는 구독 경로.
// 읽기 전용 상자(--sandbox read-only)·빈 작업 폴더에서 실행하고, 대화 기록을 디스크에 남기지 않는다(--ephemeral).
// 마지막 답만 파일로 받아(-o) 돌려준다. 로그인은 사용자가 codex login 으로 직접(지브스는 로그인 정보를 다루지 않음).
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const LIMIT_RE = /(usage limit|rate limit|quota|exceeded|too many requests|\b429\b|한도)/i;
const LOGIN_RE = /(not logged in|log in|login required|unauthori[sz]ed|\b401\b|codex login)/i;

function codexChat({ bin, prompt, workDir, timeoutMs = 5 * 60 * 1000, spawnImpl = spawn }) {
  return new Promise((resolve, reject) => {
    const fail = (kind, msg) => { const e = new Error(msg); e.kind = kind; reject(e); };
    try { fs.mkdirSync(workDir, { recursive: true }); } catch (_) {}
    const outFile = path.join(workDir, `codex-answer-${process.pid}-${Date.now()}.txt`);
    const shell = /\.(cmd|bat)$/i.test(bin);
    const args = ['exec', '--sandbox', 'read-only', '--skip-git-repo-check', '--ephemeral', '--color', 'never', '-o', shell ? `"${outFile}"` : outFile, '-'];
    let child, err = '', out = '', finished = false;
    try { child = spawnImpl(bin, args, { cwd: workDir, windowsHide: true, shell, env: { ...process.env } }); }
    catch (e) { return fail('missing', 'Codex 실행 실패: ' + e.message); }
    const timer = setTimeout(() => { try { child.kill(); } catch (_) {} if (!finished) { finished = true; fail('error', 'Codex 응답 시간이 초과되었습니다.'); } }, timeoutMs);
    if (child.stdout) { child.stdout.setEncoding('utf8'); child.stdout.on('data', d => { out += d; if (out.length > 100000) out = out.slice(-100000); }); }
    if (child.stderr) { child.stderr.setEncoding('utf8'); child.stderr.on('data', d => { err += d; if (err.length > 20000) err = err.slice(-20000); }); }
    child.on('error', e => { clearTimeout(timer); if (!finished) { finished = true; fail('missing', 'Codex 실행 실패: ' + e.message); } });
    child.on('close', code => {
      clearTimeout(timer);
      if (finished) return; finished = true;
      let text = '';
      try { text = fs.readFileSync(outFile, 'utf8').trim(); } catch (_) {}
      try { fs.rmSync(outFile, { force: true }); } catch (_) {}
      if (code === 0 && text) return resolve({ text });
      const all = err + '\n' + out;
      if (LIMIT_RE.test(all)) return fail('limit', 'Codex 사용 한도에 도달했습니다.');
      if (LOGIN_RE.test(all)) return fail('login', 'Codex 로그인이 필요합니다(명령 프롬프트에서 codex login).');
      fail('error', `Codex 가 답하지 못했습니다(코드 ${code}). ${all.trim().slice(-200)}`);
    });
    child.stdin.end(prompt);
  });
}

module.exports = { codexChat };

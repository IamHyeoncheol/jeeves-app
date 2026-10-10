// 개발 모드 진행자: 계획된 엔진 순서대로 실행하고, 한도·로그인·실행 불가·실패가 나면 규칙(DevRouter)에 따라 다음 엔진으로 넘긴다.
// 넘길 때 AI 가 판단하지 않는다 — 코드가 결정한다. 같은 프로젝트 폴더를 공유하므로 다음 엔진은 폴더의 현재 상태에서 이어 간다.
const { DevTask, snapshotDir, diffSnap } = require('./dev-engine');
const H = require('./handoff');
const { ApiCoderTask } = require('./api-coder');
const { REST_MS } = require('../dev/dev-router');

const KIND_TXT = { limit: '사용 한도', login: '로그인 필요', missing: '실행 불가', task: '작업 실패', error: '오류' };

function runChain({ id, goal, folder, chain, devRouter, bins, workDir, emit, level, TaskClass = DevTask, timeoutMs, router, grade, krwPerUsd, ApiClass = ApiCoderTask, handoff = true }) {
  const attempts = [];
  let current = null, finished = false, escalated = false, totalUsd = 0, lastTests = null, lastRef = null, ckN = 0;
  const baseSnap = handoff ? snapshotDir(folder) : null;      // 이 작업을 시작할 때의 폴더 모양(누적 변경 계산용)
  const carried = handoff ? H.readPrevHandoff(folder, goal) : null;   // 같은 지시로 끊긴 이전 작업이 남아 있으면 이어받음
  const done = (success, summary, last, extra) => {
    if (finished) return; finished = true;
    if (handoff) H.releaseLock(folder, id);
    emit({ taskId: id, type: 'done', success, summary, dev: true, engine: 'dev', engineLabel: last ? last.engineLabel : '', level,
      chain: attempts.map(a => ({ label: a.engineLabel, ok: a.success, kind: a.kind })), changes: last ? last.changes : null, denied: last ? last.denied : [], estUsd: totalUsd, subscription: attempts.every(a => a.subscription !== false), ...(extra || {}) });
  };
  const launch = engine => {
    devRouter.used(engine.id);
    const prev = attempts[attempts.length - 1];
    const cont = prev
      ? `\n\n[이어서 진행] 앞서 ${prev.engineLabel} 가 ${KIND_TXT[prev.kind] || '문제'}로 중단됐습니다. 프로젝트 폴더에는 거기까지의 결과가 남아 있습니다. 먼저 현재 파일 상태를 확인하고, 이미 된 부분은 다시 만들지 말고 남은 부분을 이어서 끝내세요.`
      : (carried ? '\n\n[이어서 진행] 같은 지시로 하던 앞선 작업이 중단된 채 남아 있습니다. 이미 된 부분은 다시 만들지 말고 남은 부분을 이어서 끝내세요.' : '');
    const prompt = (handoff ? H.NOTICE + '\n\n' : '') + goal + cont;
    const bin = engine.kind === 'api-coder' ? null : (engine.family === 'cli' ? bins[engine.id] : bins[engine.family]);
    const task = engine.kind === 'api-coder'
      ? new ApiClass({ id, goal: prompt, folder, engine, router, grade, krwPerUsd })
      : new TaskClass({ id, goal: prompt, folder, engine, bin, workDir, timeoutMs });
    current = task;
    task.on('event', ev => emit(ev));
    task.on('finished', r => onFinished(engine, r));
    emit({ taskId: id, type: 'start', dev: true, engine: 'dev', engineLabel: engine.label, goal: '', level, attempt: attempts.length + 1 });
    task.start();
  };
  // 엔진 하나가 끝날 때마다(코드만, 토큰 0): 문법·시험 점검 → 체크포인트 → 인수인계 파일·장부 갱신
  const writeState = async (r, full) => {
    const state = baseSnap ? diffSnap(baseSnap, snapshotDir(folder)) : null;
    const changed = state ? [...state.added, ...state.modified] : [];
    const badSyntax = H.checkSyntax(folder, changed);
    let tests = null, ref = null;
    if (full && changed.length) {
      tests = await H.runTests(folder);
      ref = await H.checkpoint(folder, id, ++ckN);
    }
    const prevTests = lastTests; if (tests && tests.ran) lastTests = tests; if (ref) lastRef = ref;
    H.writeHandoff(folder, { goal, grade, attempts, state, tests: tests || lastTests, prevTests, badSyntax, checkpointRef: ref || lastRef, report: H.parseReport(r.summary) });
    H.appendLedger(folder, { task: id, engine: r.engineLabel, kind: r.success ? 'ok' : r.kind, level, changed: changed.length, tests: tests && tests.ran ? (tests.ok ? 'pass' : 'fail') : null, badSyntax: badSyntax.length, usd: r.estUsd || 0 });
    return { badSyntax, tests };
  };
  const onFinished = (engine, r) => {
    current = null;
    attempts.push(r); totalUsd += r.estUsd || 0;
    if (!handoff) return proceed(engine, r);
    writeState(r, !r.success).catch(() => null).then(() => proceed(engine, r));
  };
  const proceed = (engine, r) => {
    if (r.success) return done(true, r.summary, r);
    if (r.kind === 'stopped') return done(false, r.summary, r);
    const k = ['limit', 'login', 'missing'].includes(r.kind) ? r.kind : (r.kind === 'task' ? 'task' : 'error');
    if (k !== 'task') devRouter.rest(engine.id, REST_MS[k] || REST_MS.error, k);
    let next = null;
    if (k === 'task') { if (!escalated) { escalated = true; next = devRouter.next(chain, engine.id, 'task'); } }
    else next = devRouter.next(chain, engine.id, k);
    if (next) {
      emit({ taskId: id, type: 'info', text: `엔진 전환: ${engine.label} → ${next.label} (사유: ${KIND_TXT[k]})${k === 'task' ? ' — 더 강한 엔진으로 올립니다' : ''}` });
      return launch(next);
    }
    const hint = r.resumeAt ? ` 한도는 약 ${new Date(r.resumeAt).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })}에 풀립니다.` : '';
    done(false, `${r.summary}${hint}\n\n이어서 쓸 수 있는 다른 개발 AI가 없어 멈췄습니다. 설정 → 개발 모드에서 다른 엔진(Codex 등)을 켜거나, 한도가 풀린 뒤 같은 폴더에서 다시 지시하면 이어서 진행합니다.`, r);
  };
  if (!chain.length) { done(false, '쓸 수 있는 개발 AI가 없습니다.', null); return { stop() {} }; }
  if (handoff) {
    const lk = H.acquireLock(folder, id, chain[0].label);
    if (!lk.ok) { done(false, lk.reason, null); return { stop() {} }; }
    if (!carried) H.writeHandoff(folder, { goal, grade, attempts: [], state: null, report: null });
  }
  launch(chain[0]);
  return { stop() { if (current) current.stop(); }, get engine() { return current && current.engine; } };
}

module.exports = { runChain };

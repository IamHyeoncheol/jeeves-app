// 개발 모드 진행자: 계획된 엔진 순서대로 실행하고, 한도·로그인·실행 불가·실패가 나면 규칙(DevRouter)에 따라 다음 엔진으로 넘긴다.
// 넘길 때 AI 가 판단하지 않는다 — 코드가 결정한다. 같은 프로젝트 폴더를 공유하므로 다음 엔진은 폴더의 현재 상태에서 이어 간다.
const { DevTask, snapshotDir, diffSnap } = require('./dev-engine');
const H = require('./handoff');
const { ApiCoderTask } = require('./api-coder');
const { REST_MS } = require('../dev/dev-router');
const { verifyResult, hasChanges } = require('../dev/verify');

const KIND_TXT = { limit: '사용 한도', login: '로그인 필요', missing: '실행 불가', task: '작업 실패', error: '오류' };

function runChain({ id, goal, folder, chain, devRouter, bins, workDir, emit, level, TaskClass = DevTask, timeoutMs, router, grade, krwPerUsd, ApiClass = ApiCoderTask, handoff = true, onAttempt, verify = true }) {
  const attempts = [];
  let current = null, finished = false, escalated = false, totalUsd = 0, lastTests = null, lastRef = null, ckN = 0;
  const baseSnap = handoff ? snapshotDir(folder) : null;      // 이 작업을 시작할 때의 폴더 모양(누적 변경 계산용)
  const carried = handoff ? H.readPrevHandoff(folder, goal) : null;   // 같은 지시로 끊긴 이전 작업이 남아 있으면 이어받음
  const done = (success, summary, last, extra) => {
    if (finished) return; finished = true;
    if (handoff) H.releaseLock(folder, id);
    emit({ taskId: id, type: 'done', success, summary, dev: true, engine: 'dev', engineLabel: last ? last.engineLabel : '', level,
      chain: attempts.map(a => ({ label: a.engineLabel, ok: a.success, kind: a.kind })), changes: last ? last.changes : null, denied: last ? last.denied : [], estUsd: totalUsd, subscription: attempts.every(a => a.subscription !== false), lastKind: last ? last.kind : undefined, resumeAt: last ? last.resumeAt : undefined, verified: last ? last.verified : undefined, verifyNote: last ? last.verifyNote : undefined, ...(extra || {}) });
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
  // 끝났다는 보고를 믿기 전에 코드로 확인한다(글로 쓴 도구 호출 문장·변경 없음). 실패로 뒤집히면 규칙에 따라 더 강한 엔진으로 올라간다.
  const verifyAttempt = (engine, r) => {
    if (!verify || !r.success) return r;
    let probe = r;
    if (baseSnap && r.changes != null && !hasChanges(r.changes)) { try { probe = { ...r, changes: diffSnap(baseSnap, snapshotDir(folder)) }; } catch (_) {} }   // 엔진이 "변경 없음"이라 보고했을 때만, 앞선 엔진이 이미 바꾼 것까지 합쳐서 본다(변경 정보를 아예 안 준 엔진은 판단하지 않음)
    const v = verifyResult({ goal, result: probe, engine });
    if (v.level === 'fail') {
      emit({ taskId: id, type: 'info', text: `🔎 검증 실패 — ${engine.label}: ${v.reasons.join(' / ')}` });
      return { ...r, success: false, kind: 'task', verified: false, summary: `[검증 실패] ${v.reasons.join(' / ')}\n${r.summary || ''}`.slice(0, 2000) };
    }
    if (v.level === 'warn') {
      emit({ taskId: id, type: 'info', text: `🔎 미검증 — ${engine.label}: ${v.reasons.join(' / ')}` });
      return { ...r, verified: false, verifyNote: v.reasons.join(' / ') };
    }
    return { ...r, verified: true };
  };
  const onFinished = (engine, r0) => {
    current = null;
    const r = verifyAttempt(engine, r0);
    attempts.push(r); totalUsd += r.estUsd || 0;
    if (onAttempt) { try { onAttempt(engine, r); } catch (_) {} }   // 여유 기록(한도에 닿은 시각 등)
    if (!handoff) return proceed(engine, r);
    writeState(r, !r.success).catch(() => null).then(() => proceed(engine, r));
  };
  const proceed = (engine, r) => {
    if (r.success) return done(true, r.summary, r);
    if (r.kind === 'stopped') return done(false, r.summary, r);
    const k = ['limit', 'login', 'missing'].includes(r.kind) ? r.kind : (r.kind === 'task' ? 'task' : 'error');
    const famWide = ['limit', 'login', 'missing'].includes(k);   // 같은 계열(같은 Claude 구독·같은 Codex 로그인 — 주니어·기타 도구는 각자 따로)은 모델이 달라도 같이 막힌다고 본다
    if (k !== 'task') {
      const ms = k === 'limit' && r.resumeAt ? Math.max(60000, r.resumeAt - Date.now()) : (REST_MS[k] || REST_MS.error);   // 한도는 풀리는 시각까지 쉼(모르면 30분)
      for (const e of famWide && (engine.family === 'claude' || engine.family === 'codex') ? chain.filter(x => x.family === engine.family) : [engine]) devRouter.rest(e.id, ms, k);
    }
    let next = null;
    if (k === 'task') { if (!escalated) { escalated = true; next = devRouter.next(chain, engine.id, 'task'); } }
    else { next = devRouter.next(chain, engine.id, k); while (famWide && next && devRouter.resting && devRouter.resting(next.id)) next = devRouter.next(chain, next.id, k); }
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

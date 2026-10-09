// 팀 개발 진행자: 시니어(Claude Code·Codex)는 "계획"과 "검수"만, 쉬운 작업은 주니어(무료·로컬 AI)가 맡는다. 순서와 넘김은 모두 코드가 정한다.
//   1) 시니어가 .jeeves/PLAN.md + .jeeves/tasks.json 작성(구현은 하지 않음)
//   2) 작업을 차례로: 난이도 ≤ 주니어 한도 → 주니어(실패하면 한 번 더, 그래도 안 되면 시니어) / 그 외 → 시니어
//   3) 자동 검증: package.json 에 test 가 있으면 npm test → 실패하면 시니어가 고침(1회)
//   4) 시니어 최종 검수(빠진 것 보완)
// 계획이 깨졌거나 작업이 하나도 없으면 기존 방식(엔진 한 줄 이어달리기)으로 되돌아간다.
const fs = require('fs');
const path = require('path');
const { runChain } = require('./dev-chain');
const { snapshotDir, diffSnap } = require('./dev-engine');
const { runCommand } = require('./api-coder');

const MAX_TASKS = 10;

function planPrompt(goal) {
  return `[팀 작업 — 1단계: 계획] 당신은 팀의 시니어입니다. 이 단계에서는 코드를 구현하지 마세요. 프로젝트 폴더의 현재 상태를 확인한 뒤, 아래 두 파일만 만드세요.
1) .jeeves/PLAN.md — 구조·파일 목록·기술 선택·완료 기준 (한국어, 짧게)
2) .jeeves/tasks.json — JSON 배열만(설명 글 없이). 각 항목: {"id":1,"title":"짧은 제목","desc":"주니어가 이 글만 읽고 구현할 수 있도록 구체적으로(파일명·함수·입출력·주의점)","files":["만들거나 고칠 파일"],"level":1~4,"risk":"low"|"high"}
   · level: 1~2 = 단순, 3~4 = 어려움(설계·보안·복잡한 연동)
   · risk: "low" = 틀려도 품질에 거의 영향이 없고 검증하기 쉬운 부분만(화면 마크업·문구·스타일, 단순 입력 폼, 정형화된 반복 코드, 설정 파일, 단순 시험 코드, 문서). 핵심 로직·보안·데이터·외부 연동·알고리즘·원인 추적이 필요한 수정·여러 파일의 일관성이 필요한 일은 "high". 조금이라도 애매하면 "high". risk 가 low 이고 level 이 1~2 인 작업만 주니어(무료·로컬 AI)가 맡고, 나머지는 시니어가 직접 합니다.
   · 의존 순서대로, 최대 ${MAX_TASKS}개, 작업 하나는 파일 1~3개 범위
   · 이미 완성된 부분은 작업에 넣지 마세요.

[목표]
${goal}`;
}
const taskPrompt = (t, i, n) => `[팀 작업 — 2단계: 구현 ${i}/${n}] 먼저 .jeeves/PLAN.md 를 읽고(있다면), 아래 작업 하나만 구현하세요. 다른 작업 범위는 건드리지 마세요. 끝나면 결과를 한두 줄로 보고하세요.
작업: ${t.title}
내용: ${t.desc}
대상 파일: ${(t.files || []).join(', ') || '(작업 내용에 따라)'}`;
const fixPrompt = (goal, out) => `[팀 작업 — 3단계: 검증 실패 수정] 자동 검증(npm test)이 실패했습니다. 원인을 찾아 고치세요. 시험을 지우거나 약하게 바꿔서 통과시키지 마세요.
[검증 출력]
${String(out).slice(-3500)}

[원래 목표]
${goal.slice(0, 1500)}`;
const reviewPrompt = (goal, summaries) => `[팀 작업 — 4단계: 최종 검수] 당신은 시니어입니다. 아래 목표와 .jeeves/PLAN.md 를 기준으로 완성된 결과물을 훑어보고, 빠졌거나 틀린 부분이 있으면 직접 고치세요. 문제가 없으면 아무것도 바꾸지 말고 "이상 없음"이라고 보고하세요. 새 기능을 덧붙이지 마세요.
지금까지 한 일: ${summaries.slice(0, 1500)}

[목표]
${goal.slice(0, 2000)}`;

// tasks.json 읽기: 배열 또는 {tasks:[...]} 모두 허용하고, 이상한 항목은 버린다.
function readTasks(folder) {
  let raw;
  try { raw = fs.readFileSync(path.join(folder, '.jeeves', 'tasks.json'), 'utf8'); } catch (_) { return null; }
  let j; try { j = JSON.parse(raw.replace(/^﻿/, '').replace(/^```(?:json)?\s*|\s*```$/g, '')); } catch (_) { return null; }
  const arr = Array.isArray(j) ? j : (j && Array.isArray(j.tasks) ? j.tasks : null);
  if (!arr) return null;
  const tasks = arr.slice(0, MAX_TASKS).map((t, i) => {
    if (!t || typeof t !== 'object') return null;
    const desc = String(t.desc || t.description || '').trim().slice(0, 2000), title = String(t.title || '').trim().slice(0, 60);
    if (!desc && !title) return null;
    const lv = Math.round(Number(t.level)); const level = lv >= 1 && lv <= 4 ? lv : 3;   // 모르면 어려운 쪽(시니어)
    const files = (Array.isArray(t.files) ? t.files : []).map(f => String(f)).filter(f => f && !path.isAbsolute(f) && !f.split(/[\\/]/).includes('..')).slice(0, 6);
    return { id: i + 1, title: title || desc.slice(0, 40), desc: desc || title, files, level, risk: t.risk === 'low' ? 'low' : 'high' };   // 표시가 없거나 애매하면 high(시니어)
  }).filter(Boolean);
  return tasks.length ? tasks : null;
}

function hasTestScript(folder) {
  try { const p = JSON.parse(fs.readFileSync(path.join(folder, 'package.json'), 'utf8')); const s = p.scripts && p.scripts.test; return !!s && !/no test specified/i.test(s); } catch (_) { return false; }
}

// opts: { id, goal, folder, level, planFor(level, 'junior'|'senior'|'any') → 엔진 목록, devRouter, bins, workDir, router, grade, krwPerUsd, emit, juniorMaxLevel, verify=true, ApiClass, TaskClass }
function runTeam(o) {
  const { id, goal, folder, level, emit, planFor } = o;
  const base = { id, folder, devRouter: o.devRouter, bins: o.bins, workDir: o.workDir, router: o.router, grade: o.grade, krwPerUsd: o.krwPerUsd, ApiClass: o.ApiClass, TaskClass: o.TaskClass, timeoutMs: o.timeoutMs };
  let stopped = false, cur = null, usd = 0, subscription = true, started = false;
  const attempts = [];           // 화면용 요약 [{label, ok, kind}]
  const log = [];                // 작업별 결과 문장
  const before = snapshotDir(folder);
  const info = text => emit({ taskId: id, type: 'info', text });

  const stage = (title, chain, stageGoal, lv) => new Promise(resolve => {
    cur = runChain({
      ...base, goal: stageGoal, chain, level: lv,
      emit: ev => {
        if (ev.type === 'done') { usd += ev.estUsd || 0; if (ev.subscription === false) subscription = false; for (const c of ev.chain || []) attempts.push({ label: c.label, ok: c.ok, kind: c.kind }); resolve(ev); }
        else if (ev.type === 'start') info(`▶ ${title} — ${ev.engineLabel}`);
        else emit(ev);
      }
    });
  });
  const stopNow = () => stopped;

  const finish = (success, summary, extra) => {
    let changes = null; try { changes = diffSnap(before, snapshotDir(folder)); } catch (_) {}
    emit({ taskId: id, type: 'done', success, summary, dev: true, engine: 'dev', engineLabel: '팀 작업', level, chain: attempts, changes, denied: [], estUsd: usd, subscription, team: true, ...(extra || {}) });
  };

  (async () => {
    emit({ taskId: id, type: 'start', dev: true, engine: 'dev', engineLabel: '팀 작업 (시니어 계획·검수 + 주니어 구현)', goal: '', level, attempt: 1 });
    started = true;

    // 1) 계획
    info('🧭 1단계: 시니어가 작업 계획을 세웁니다');
    try { fs.mkdirSync(path.join(folder, '.jeeves'), { recursive: true }); } catch (_) {}
    const seniors = planFor(Math.max(level, 3), 'senior');
    const p = await stage('계획', seniors, planPrompt(goal), level);
    if (stopNow()) return finish(false, '사용자가 작업을 중지했습니다.', { kind: 'stopped' });
    if (!p.success && !seniors.length) return finish(false, p.summary);
    let tasks = p.success ? readTasks(folder) : null;
    if (!p.success) return finish(false, `계획 단계에서 멈췄습니다. ${p.summary}`);
    if (!tasks) {
      info('⚠ 계획 파일(tasks.json)을 읽지 못해 기존 방식(엔진 이어달리기)으로 진행합니다');
      const r = await stage('전체 작업', planFor(level, 'any'), goal, level);
      return finish(r.success, r.summary);
    }
    info(`📋 작업 ${tasks.length}개: ` + tasks.map(t => `${t.id}.${t.title}(L${t.level}${t.risk === 'low' ? '·주니어 가능' : ''})`).join(' · '));

    // 2) 구현
    const results = [];
    for (let i = 0; i < tasks.length; i++) {
      if (stopNow()) return finish(false, '사용자가 작업을 중지했습니다.', { kind: 'stopped' });
      const t = tasks[i], prompt = taskPrompt(t, i + 1, tasks.length);
      let r = null, by = '';
      if (t.level <= (o.juniorMaxLevel || 2) && t.risk === 'low') {
        for (let k = 0; k < 2 && !(r && r.success); k++) {
          const js = planFor(t.level, 'junior'); if (!js.length) break;
          info(`🔧 작업 ${i + 1}/${tasks.length} “${t.title}” → 주니어${k ? ' (재시도)' : ''}`);
          r = await stage(`작업 ${i + 1}`, js, prompt, t.level); by = r.engineLabel;
          if (r.kind === 'stopped' || stopNow()) return finish(false, '사용자가 작업을 중지했습니다.', { kind: 'stopped' });
        }
        if (r && !r.success) info(`↗ 작업 ${i + 1} 은 주니어가 끝내지 못해 시니어에게 올립니다`);
      }
      if (!r || !r.success) {
        info(`🔧 작업 ${i + 1}/${tasks.length} “${t.title}” → 시니어`);
        r = await stage(`작업 ${i + 1}`, planFor(Math.max(t.level, 2), 'senior'), prompt, t.level); by = r.engineLabel;
        if (stopNow()) return finish(false, '사용자가 작업을 중지했습니다.', { kind: 'stopped' });
      }
      results.push({ id: t.id, title: t.title, ok: !!r.success, by });
      log.push(`${t.id}. ${t.title}: ${r.success ? '완료' : '실패'} (${by || '엔진 없음'})`);
      if (!r.success) { return finish(false, `작업 ${t.id} “${t.title}” 에서 멈췄습니다. ${r.summary}\n\n지금까지 결과는 폴더에 남아 있습니다. 같은 폴더에서 다시 지시하면 이어서 진행합니다.\n${log.join('\n')}`, { teamTasks: results }); }
    }

    // 3) 자동 검증
    let verify = '해당 없음(시험 항목 없음)';
    if (o.verify !== false && hasTestScript(folder)) {
      info('🧪 3단계: 자동 검증(npm test)');
      let v = await runCommand(folder, 'npm test', 180000);
      if (!v.ok && !v.rejected) {
        info('⚠ 검증 실패 → 시니어가 고칩니다');
        const f = await stage('검증 수정', planFor(Math.max(level, 3), 'senior'), fixPrompt(goal, v.text), level);
        if (stopNow()) return finish(false, '사용자가 작업을 중지했습니다.', { kind: 'stopped' });
        v = await runCommand(folder, 'npm test', 180000);
        verify = v.ok ? '통과(수정 후)' : '실패';
        log.push(`검증: ${verify}${f.success ? '' : ' (시니어 수정도 실패)'}`);
      } else verify = v.rejected ? '실행 못 함' : '통과';
    }
    log.push(`검증: ${verify}`);

    // 4) 최종 검수
    info('🔍 4단계: 시니어 최종 검수');
    const rv = await stage('검수', planFor(Math.max(level, 3), 'senior'), reviewPrompt(goal, log.join(' / ')), level);
    if (stopNow()) return finish(false, '사용자가 작업을 중지했습니다.', { kind: 'stopped' });
    log.push(`검수: ${rv.success ? '완료' : '건너뜀(' + String(rv.summary).slice(0, 60) + ')'}`);
    const ok = !/^실패/.test(verify);
    finish(ok, `팀 작업 ${ok ? '완료' : '검증 실패로 미완'} — 작업 ${results.length}개\n${log.join('\n')}${rv.success ? '\n\n[검수 보고] ' + String(rv.summary).slice(0, 600) : ''}`, { teamTasks: results, verify });
  })().catch(e => finish(false, '팀 작업 내부 오류: ' + e.message));

  return { stop() { stopped = true; if (cur) cur.stop(); }, get started() { return started; } };
}

module.exports = { runTeam, readTasks, hasTestScript, planPrompt };

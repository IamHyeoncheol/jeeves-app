// 개발 도구 전환 인수인계 시험: 가짜 AI 사용(실제 계정·토큰 없음). 사양서 02 의 시험 계획 대응.
const assert = require('assert');
const fs = require('fs'), os = require('os'), path = require('path');
const { execFileSync } = require('child_process');
const H = require('../src/main/handoff');
const { runChain } = require('../src/main/dev-chain');

const results = [];
async function t(name, fn) { try { await fn(); results.push([true, name]); } catch (e) { results.push([false, name, e.stack || e.message]); } }
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'jv-ho-'));
const fake = path.join(__dirname, 'fixtures', 'fake-dev.js');
const E = {
  claude: { id: 'c', kind: 'claude', family: 'claude', label: 'Claude Code', cost: 'subscription' },
  codex: { id: 'x', kind: 'codex', family: 'codex', label: 'Codex', cost: 'subscription', args: 'exec -' },
  other: { id: 'k', kind: 'cli', family: 'cli', label: '기타 AI', cost: 'free', args: '' }
};
// 순서대로 다음 엔진을 주는 가짜 라우터(규칙 판정은 dev-tests 가 따로 시험)
const router = () => ({ used() {}, rest() {}, next(chain, id) { const i = chain.findIndex(e => e.id === id); return chain[i + 1] || null; } });
const run = (order, env, folder, extra) => new Promise(resolve => {
  delete process.env.FAKE_SEQ;
  const log = path.join(folder, '..', path.basename(folder) + '.log');
  Object.assign(process.env, { FAKE_LOG: log, FAKE_CLAUDE_MODE: 'ok', FAKE_CODEX_MODE: 'ok' }, env);
  const events = [];
  runChain({ id: 7, goal: '앱을 만들어줘', folder, chain: order.map(k => E[k]), devRouter: router(), bins: { claude: fake, codex: fake, k: fake }, grade: 'I',
    workDir: path.join(folder, '..', path.basename(folder) + '-work'), level: 3, ...(extra || {}),
    emit: ev => { events.push(ev); if (ev.type === 'done') resolve({ events, done: ev, log: fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse) : [] }); } });
});
const ho = d => fs.readFileSync(path.join(d, '.jeeves', 'HANDOFF.md'), 'utf8');

(async () => {
  await t('비밀 지우기: 키·토큰·비밀번호 값은 [삭제됨]', () => {
    const s = H.scrub('a sk-abcdefghijklmnopqrstuvwx b AIzaSyA1234567890abcdefghijk c password: hunter2 d Bearer abcdefghijklmnopqrstu');
    assert.ok(!/hunter2|abcdefghijklmnopqrstuvwx|AIzaSy|Bearer abcdef/.test(s));
    assert.ok(/\[삭제됨\]/.test(s));
  });

  await t('전환 Claude(한도) → Codex: 인수인계 안내·목표 원문이 전달되고 HANDOFF 가 사실대로 채워짐', async () => {
    const d = tmp(); const { done, log } = await run(['claude', 'codex'], { FAKE_CLAUDE_MODE: 'limit' }, d);
    assert.ok(done.success);
    assert.ok(log[1].who === 'codex' && log[1].stdin.includes('.jeeves/HANDOFF.md') && /앱을 만들어줘/.test(log[1].stdin) && /\[이어서 진행\]/.test(log[1].stdin));
    const s = ho(d);
    assert.ok(/## 목표 \(원문\)\n앱을 만들어줘/.test(s) && /Claude Code — 사용 한도/.test(s));
    assert.ok(fs.readFileSync(path.join(d, '.jeeves', 'LEDGER.jsonl'), 'utf8').trim().split('\n').length >= 2);
  });

  await t('전환 Codex(한도) → Claude Code: 같은 인수인계, Claude 가 이어서 완료', async () => {
    const d = tmp(); const { done, log } = await run(['codex', 'claude'], { FAKE_CODEX_MODE: 'limit' }, d);
    assert.ok(done.success && log[1].who === 'claude' && log[1].stdin.includes('.jeeves/HANDOFF.md'));
    assert.ok(/Codex — 사용 한도/.test(ho(d)));
  });

  await t('전환 기타 AI → Claude Code, 그리고 Codex → 기타 → Claude 3단 전환: 이력이 누적', async () => {
    const a = tmp(); const r1 = await run(['other', 'claude'], { FAKE_CODEX_MODE: 'limit' }, a);
    assert.ok(r1.done.success && /기타 AI — 사용 한도/.test(ho(a)));
    const b = tmp(); const r2 = await run(['codex', 'other', 'claude'], { FAKE_CODEX_MODE: 'limit' }, b);
    assert.ok(r2.done.success && r2.done.chain.length === 3);
    const s = ho(b); assert.ok(/1\. Codex/.test(s) && /2\. 기타 AI/.test(s));
  });

  await t('끊긴 AI가 만든 깨진 JSON·JS 감지(구문 점검)', () => {
    const d = tmp(); fs.writeFileSync(path.join(d, 'a.json'), '{"x":'); fs.writeFileSync(path.join(d, 'b.js'), 'function (('); fs.writeFileSync(path.join(d, 'ok.js'), 'const a=1;');
    const bad = H.checkSyntax(d, ['a.json', 'b.js', 'ok.js']);
    assert.deepStrictEqual(bad.sort(), ['a.json', 'b.js']);
  });

  await t('시험 퇴보 표시: 이전 통과 → 지금 실패면 맨 위 경고, 자동 되돌리기 문구 없음', () => {
    const s = H.buildHandoff({ goal: 'g', attempts: [{ engineLabel: 'A', success: false, kind: 'limit' }], state: { added: [], modified: ['x.js'], removed: [] },
      tests: { ran: true, ok: false, failed: ['FAIL 로그인'] }, prevTests: { ran: true, ok: true }, badSyntax: [] });
    assert.ok(/시험 퇴보/.test(s) && /FAIL 로그인/.test(s));
    assert.ok(!/자동으로 되돌/.test(s));
  });

  await t('시험 자동 실행: package.json 의 npm test 실패 이름이 HANDOFF 에 기록, 변경 없으면 실행 안 함', async () => {
    const d = tmp();
    fs.writeFileSync(path.join(d, 'package.json'), JSON.stringify({ scripts: { test: 'node t.js' } }));
    fs.writeFileSync(path.join(d, 't.js'), "console.log('FAIL 계산 시험'); process.exit(1);");
    const { done } = await run(['claude', 'codex'], { FAKE_CLAUDE_MODE: 'limit' }, d);   // Claude 는 한도, 파일 변경 없음 → 시험 안 돌림
    assert.ok(done.success);
    const d2 = tmp();
    fs.writeFileSync(path.join(d2, 'package.json'), JSON.stringify({ scripts: { test: 'node t.js' } }));
    fs.writeFileSync(path.join(d2, 't.js'), "console.log('FAIL 계산 시험'); process.exit(1);");
    const r = await H.runTests(d2);
    assert.ok(r.ran && !r.ok && r.failed.some(x => /계산 시험/.test(x)));
    assert.strictEqual((await H.runTests(tmp())).ran, false);
  });

  await t('Git 체크포인트: 작업 폴더·현재 브랜치·색인을 건드리지 않고 refs/jeeves 에 저장', async () => {
    const d = tmp(); const g = (...a) => execFileSync('git', a, { cwd: d, encoding: 'utf8' });
    g('init', '-q'); g('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '--allow-empty', '-q', '-m', 'init');
    fs.writeFileSync(path.join(d, 'new.txt'), 'hello');
    const before = g('status', '--porcelain');
    const ref = await H.checkpoint(d, 7, 1);
    assert.ok(/^refs\/jeeves\/7\/1$/.test(ref));
    assert.strictEqual(g('status', '--porcelain'), before);                    // 색인·작업 폴더 그대로(new.txt 는 여전히 미추적)
    assert.ok(/new\.txt/.test(g('ls-tree', '-r', '--name-only', ref)));          // 새 파일이 체크포인트에는 들어감
    assert.ok(!/\.jeeves/.test(g('ls-tree', '-r', '--name-only', ref)));
    assert.strictEqual(await H.checkpoint(tmp(), 7, 1), null);                  // Git 아님 → 건너뜀
  });

  await t('동시 실행 방지: 같은 폴더에서 두 번째 작업은 거부, 끝나면 해제', async () => {
    const d = tmp();
    assert.ok(H.acquireLock(d, 1, 'A').ok);
    const second = H.acquireLock(d, 2, 'B'); assert.ok(!second.ok && /이미 다른 개발 작업/.test(second.reason));
    H.releaseLock(d, 1); assert.ok(H.acquireLock(d, 2, 'B').ok); H.releaseLock(d, 2);
    const { done } = await run(['codex'], {}, d); assert.ok(done.success && !fs.existsSync(path.join(d, '.jeeves', 'LOCK')));
  });

  await t('상한: 시도가 많아도 2,000자 이하, 목표는 유지', () => {
    const attempts = Array.from({ length: 150 }, (_, i) => ({ engineLabel: '엔진' + i, success: false, kind: 'limit' }));
    const s = H.buildHandoff({ goal: '긴 목표 '.repeat(50), attempts, state: { added: Array.from({ length: 80 }, (_, i) => 'f' + i + '.js'), modified: [], removed: [] } });
    assert.ok(s.length <= H.MAX_HANDOFF + 2 && /긴 목표/.test(s) && /앞선 \d+회 생략/.test(s));
  });

  await t('엔진의 3줄 보고 읽기 + 기록·장부에 비밀 미포함', async () => {
    const r = H.parseReport('결론...\n한 일: 로그인 화면\n남은 일: 시험 작성\n주의: 키 sk-abcdefghijklmnopqrstuvwx 사용');
    assert.strictEqual(r.done, '로그인 화면'); assert.ok(!/sk-abcdefgh/.test(r.warn));
    assert.strictEqual(H.parseReport('보고 형식 없음'), null);
    const d = tmp(); await run(['codex'], {}, d, { goal: '키 sk-abcdefghijklmnopqrstuvwx 로 연결' });
    for (const f of ['HANDOFF.md', 'LEDGER.jsonl']) assert.ok(!/sk-abcdefghijklmnop/.test(fs.readFileSync(path.join(d, '.jeeves', f), 'utf8')));
  });

  await t('같은 지시로 끊긴 작업이 남아 있으면 새 실행이 이어받음(한도 풀린 뒤 재지시)', async () => {
    const d = tmp(); await run(['claude'], { FAKE_CLAUDE_MODE: 'limit' }, d);          // 한도로 멈춤(엔진 1개뿐)
    const { done, log } = await run(['codex'], {}, d);
    assert.ok(done.success && /중단된 채 남아 있습니다/.test(log[log.length - 1].stdin));
  });

  await t('handoff:false 이면 .jeeves 에 아무것도 만들지 않음(기존 동작)', async () => {
    const d = tmp(); const { done, log } = await run(['codex'], {}, d, { handoff: false });
    assert.ok(done.success && !fs.existsSync(path.join(d, '.jeeves')) && !/지브스 인수인계 안내/.test(log[0].stdin));
  });

  // ── 임의 순서·임의 횟수 전환 (사용자 확인: 순서·횟수는 정해진 것이 아님) ──
  const NOTICE_HEAD = '[지브스 인수인계 안내]';
  const runSeq = (bases, seq, folder) => new Promise(resolve => {
    const log = path.join(folder, '..', path.basename(folder) + '.log');
    Object.assign(process.env, { FAKE_LOG: log, FAKE_SEQ: seq.join(',') });
    const chain = bases.map((b, i) => ({ ...E[b], id: b + i }));   // 같은 종류가 여러 번 나와도 id 는 서로 다르게(모델 단계가 다른 Claude 처럼)
    const bins = new Proxy({}, { get: () => fake });
    runChain({ id: 9, goal: '앱을 만들어줘', folder, chain, devRouter: router(), bins, grade: 'I', workDir: path.join(folder, '..', path.basename(folder) + '-w'), level: 3,
      emit: ev => { if (ev.type === 'done') { delete process.env.FAKE_SEQ; resolve({ chain, done: ev, log: fs.readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse) }); } } });
  });
  // 앞 엔진들은 한도·로그인으로 막히고 마지막이 성공하는 시나리오. 매 전환마다 인수인계 내용을 검증한다.
  const checkChain = async (bases) => {
    const d = tmp();
    const seq = bases.map((b, i) => i === bases.length - 1 ? 'ok' : (b === 'claude' && i % 2 === 1 ? 'login' : 'limit'));
    const { chain, done, log } = await runSeq(bases, seq, d);
    const tag = bases.join('→');
    assert.ok(done.success, tag + ': 마지막 엔진이 완료해야 함');
    assert.strictEqual(log.length, bases.length, tag + ': 엔진 실행 횟수');
    log.forEach((e, i) => {
      assert.ok(e.stdin.includes(NOTICE_HEAD) && e.stdin.includes('앱을 만들어줘'), tag + ` #${i + 1}: 공통 안내·목표 원문`);
      assert.strictEqual(/\[이어서 진행\]/.test(e.stdin), i > 0, tag + ` #${i + 1}: 이어서 진행 문구`);
      if (i === 0) return;
      const h = e.handoff || '';
      const hist = (h.split('## 시도 이력')[1] || '').split('\n## ')[0].split('\n').filter(l => /^- \d+\. /.test(l));
      assert.strictEqual(hist.length, i, tag + ` #${i + 1}: 이전 시도 ${i}건이 이력에 있어야 함`);
      hist.forEach((l, j) => assert.ok(l.includes(chain[j].label) && /사용 한도|로그인 필요/.test(l), tag + ` #${i + 1}: 이력 ${j + 1} 내용`));
      for (let j = 0; j < i; j++) assert.ok(h.includes('step-' + j + '.txt'), tag + ` #${i + 1}: 앞선 엔진이 남긴 step-${j}.txt 가 폴더 상태에 있어야 함`);
      assert.ok(h.length <= H.MAX_HANDOFF + 2, tag + ': 상한');
    });
    assert.ok(!fs.existsSync(path.join(d, '.jeeves', 'LOCK')), tag + ': LOCK 해제');
    assert.strictEqual(fs.readFileSync(path.join(d, '.jeeves', 'LEDGER.jsonl'), 'utf8').trim().split('\n').length, bases.length, tag + ': 장부 줄 수');
  };

  await t('임의 순서 ①: 3종 엔진의 모든 순열 6가지(Claude·Codex·기타) 전환', async () => {
    const perms = [['claude', 'codex', 'other'], ['claude', 'other', 'codex'], ['codex', 'claude', 'other'], ['codex', 'other', 'claude'], ['other', 'claude', 'codex'], ['other', 'codex', 'claude']];
    for (const p of perms) await checkChain(p);
  });

  await t('임의 순서 ②: 같은 종류 반복·길이 2~8 무작위 전환 40가지(시드 고정)', async () => {
    let seed = 20261010; const rnd = n => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
    const kinds = ['claude', 'codex', 'other'];
    for (let k = 0; k < 40; k++) {
      const len = 2 + rnd(7); const bases = Array.from({ length: len }, () => kinds[rnd(3)]);
      await checkChain(bases);
    }
  });

  await t('임의 순서 ③: 전환 8회 연속에도 HANDOFF 는 상한 이내, 목표 원문 유지', async () => {
    const bases = ['claude', 'codex', 'other', 'claude', 'codex', 'other', 'claude', 'codex', 'other'];
    await checkChain(bases);
  });

  let fail = 0;
  for (const [ok, name, err] of results) { if (!ok) fail++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '  → ' + err}`); }
  console.log(`\nhandoff-tests: ${results.length - fail}/${results.length} 통과`);
  process.exit(fail ? 1 : 0);
})();

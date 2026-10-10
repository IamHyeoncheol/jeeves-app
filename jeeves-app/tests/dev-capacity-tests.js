// 개발 AI 자동 선정 시험: 분량 판정, 여유 상태, 엔진 순서 반영, 한도 기록, onAttempt 연결
const assert = require('assert');
const fs = require('fs'), os = require('os'), path = require('path');
const { estimateVolume, needOf, effectiveLevel, headroomPenalty, DevCapacity } = require('../src/dev/dev-capacity');
const { buildEngines, DevRouter } = require('../src/dev/dev-router');
const { runChain } = require('../src/main/dev-chain');
const { DEFAULTS } = require('../src/main/config');

const results = [];
async function t(name, fn) { try { await fn(); results.push([true, name]); } catch (e) { results.push([false, name, e.stack || e.message]); } }
const clone = o => JSON.parse(JSON.stringify(o));
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'jv-cap-'));
const H = 3600 * 1000;

(async () => {
  await t('분량: 짧은 수정 작음 / 항목·화면 많으면 큼 / 첨부·큰 프로젝트 가산', () => {
    assert.strictEqual(estimateVolume('버튼 문구 오타 수정해줘').volume, 1);
    const list = '다음을 만들어줘\n1. 로그인\n2. 목록\n3. 상세\n4. 검색\n5. 설정\n6. 알림 화면 전체';
    assert.ok(estimateVolume(list).volume >= 3);
    assert.ok(estimateVolume('화면 8개짜리 앱을 만들어줘').volume >= 3);
    assert.ok(estimateVolume('열 개의 화면을 만들어줘').volume >= 3);   // 한글 수량
    assert.ok(estimateVolume('앱 만들어줘', { fileCount: 1500, attCount: 3, hasImages: true }).volume > estimateVolume('앱 만들어줘').volume);
    assert.ok(estimateVolume('').volume === 1);
  });

  await t('필요 여유·유효 난이도: 곱이 클수록 large, 분량이 크면 난이도를 L3 이상으로 본다', () => {
    assert.strictEqual(needOf(1, 1), 'small'); assert.strictEqual(needOf(2, 3), 'medium'); assert.strictEqual(needOf(3, 4), 'large');
    assert.strictEqual(effectiveLevel(1, 3), 3); assert.strictEqual(effectiveLevel(1, 2), 1); assert.strictEqual(effectiveLevel(4, 4), 4);
  });

  await t('여유 감점: 작은 일은 빠듯해도 영향 없음, 큰 일은 크게 밀림, 한도는 항상 최대', () => {
    assert.strictEqual(headroomPenalty('tight', 'small'), 0);
    assert.ok(headroomPenalty('tight', 'large') > headroomPenalty('tight', 'medium'));
    assert.ok(headroomPenalty('low', 'small') > 0);
    assert.strictEqual(headroomPenalty('out', 'small'), 9);
    assert.strictEqual(headroomPenalty('unknown', 'large'), 0);
  });

  await t('여유 상태: 정보 없음=unknown / 입력 사용량 / 48시간 지나면 무시 / 한도 기록이 우선', () => {
    let now = 1_000_000_000_000; const clock = () => now;
    const c = new DevCapacity(null, clock);
    assert.strictEqual(c.state('claude').state, 'unknown');
    assert.strictEqual(c.state('claude', { usedPct: 50, at: now - H }).state, 'ok');
    assert.strictEqual(c.state('claude', { usedPct: 75, at: now - H }).state, 'tight');
    assert.strictEqual(c.state('claude', { usedPct: 95, at: now - H }).state, 'low');
    const old = c.state('claude', { usedPct: 95, at: now - 49 * H });
    assert.strictEqual(old.state, 'unknown'); assert.ok(/오래/.test(old.note));
    assert.strictEqual(c.state('claude', { usedPct: null, at: 0 }).state, 'unknown');
    c.record({ family: 'claude', kind: 'limit', resumeAt: now + 2 * H });
    const o = c.state('claude', { usedPct: 10, at: now });
    assert.strictEqual(o.state, 'out'); assert.strictEqual(o.until, now + 2 * H);
    assert.strictEqual(c.state('codex').state, 'unknown');   // 다른 계열은 영향 없음
    now += 3 * H;   // 풀린 뒤: 최근 24시간 한도 1회 → 빠듯
    assert.strictEqual(c.state('claude').state, 'tight');
    c.record({ family: 'claude', kind: 'limit', resumeAt: now + H }); now += 2 * H;
    assert.strictEqual(c.state('claude').state, 'low');   // 24시간 안에 2회
    now += 30 * H;
    assert.strictEqual(c.state('claude').state, 'unknown');
  });

  await t('한도 기록: 풀리는 시각을 모르면 30분, 파일로 저장·복원', () => {
    const f = path.join(tmp(), 'u.json'); let now = 5_000_000_000_000;
    const a = new DevCapacity(f, () => now);
    a.record({ family: 'codex', kind: 'limit' });
    assert.strictEqual(a.limitUntil('codex'), now + 30 * 60000);
    const b = new DevCapacity(f, () => now + 10 * 60000);
    assert.strictEqual(b.limitUntil('codex'), now + 30 * 60000);   // 다시 켜도 유지
    assert.strictEqual(new DevCapacity(f, () => now + H).limitUntil('codex'), 0);
    assert.strictEqual(new DevCapacity(path.join(tmp(), 'none.json')).events.length, 0);
    fs.writeFileSync(f, '깨진 파일'); assert.strictEqual(new DevCapacity(f).events.length, 0);   // 깨져도 시작은 됨
  });

  const cfg = () => { const c = clone(DEFAULTS); c.dev.codex.enabled = true; return c; };
  const engines = () => buildEngines(cfg(), { claude: true, codex: true });
  const ids = (cap, level, need) => new DevRouter().plan({ grade: 'I', level, engines: engines(), prefer: ['claude', 'codex'], capacity: cap, need }).chain.map(e => e.id);

  await t('엔진 순서: 여유 정보 없으면 기존 순서 그대로', () => {
    assert.deepStrictEqual(ids({}, 3, 'medium').slice(0, 2), ['claude-sonnet', 'codex']);
    assert.deepStrictEqual(ids({ claude: { state: 'unknown' }, codex: { state: 'unknown' } }, 3, 'large').slice(0, 2), ['claude-sonnet', 'codex']);
  });

  await t('엔진 순서: Claude 가 빠듯하면 중간·큰 일은 Codex 먼저, 작은 일은 그대로', () => {
    const cap = { claude: { state: 'tight', note: '' }, codex: { state: 'ok', note: '' } };
    assert.strictEqual(ids(cap, 3, 'large')[0], 'codex');
    assert.strictEqual(ids(cap, 3, 'medium')[0], 'codex');
    assert.strictEqual(ids(cap, 3, 'small')[0], 'claude-sonnet');   // 작은 일은 빠듯해도 그대로
    assert.strictEqual(ids(cap, 1, 'small')[0], 'claude-haiku');
  });

  await t('엔진 순서: 한도에 닿은 계열은 제외하고 풀리는 시각을 알림, 둘 다 한도면 빈 계획', () => {
    const r = new DevRouter();
    const cap = { claude: { state: 'out', note: '한도 도달', until: 12345 }, codex: { state: 'ok' } };
    const p = r.plan({ grade: 'I', level: 3, engines: engines(), capacity: cap, need: 'medium' });
    assert.deepStrictEqual(p.chain.map(e => e.id), ['codex']);
    assert.ok(p.skipped.some(x => x.out && x.until === 12345));
    const both = r.plan({ grade: 'I', level: 3, engines: engines(), capacity: { claude: { state: 'out', until: 1 }, codex: { state: 'out', until: 2 } } });
    assert.strictEqual(both.chain.length, 0);
    assert.strictEqual(both.skipped.filter(x => x.out).length, engines().length);
  });

  await t('엔진 순서: Codex 먼저 설정(first)은 비용 다음 순위라 여유 감점보다 우선', () => {
    const cap = { claude: { state: 'ok' }, codex: { state: 'low' } };
    const p = new DevRouter().plan({ grade: 'I', level: 3, engines: engines(), capacity: cap, need: 'large', first: 'codex' });
    assert.strictEqual(p.chain[0].id, 'codex');   // 사용자가 직접 정한 "Codex 먼저"는 존중(한도에 닿으면 out 으로 제외됨)
  });

  const fake = path.join(__dirname, 'fixtures', 'fake-dev.js');
  await t('실행 연결: 시도마다 onAttempt 호출, 모두 한도면 done 에 lastKind=limit·resumeAt 포함 → 한도 기록과 결합', async () => {
    const d = tmp(); const r = new DevRouter(); const cap = new DevCapacity(null);
    Object.assign(process.env, { FAKE_LOG: path.join(d, '..', path.basename(d) + '.log'), FAKE_CLAUDE_MODE: 'limit', FAKE_CODEX_MODE: 'limit' });
    const chain = r.plan({ grade: 'I', level: 3, engines: engines() }).chain.filter(e => e.id !== 'claude-opus');
    const seen = [];
    const done = await new Promise(resolve => runChain({ id: 7, goal: '앱을 만들어줘', folder: d, chain, devRouter: r, bins: { claude: fake, codex: fake }, workDir: path.join(d, '..', path.basename(d) + '-w'), level: 3,
      onAttempt: (engine, res) => { seen.push(engine.family + ':' + res.kind); cap.record({ family: engine.family, engineId: engine.id, kind: res.success ? 'ok' : res.kind, resumeAt: res.resumeAt }); },
      emit: ev => { if (ev.type === 'done') resolve(ev); } }));
    assert.strictEqual(done.success, false); assert.strictEqual(done.lastKind, 'limit');
    assert.deepStrictEqual(seen, ['claude:limit', 'codex:limit']);
    assert.ok(cap.limitUntil('claude') > Date.now() + 30 * 60000);   // 가짜 Claude 는 1시간 뒤 풀림을 알려 줌
    assert.ok(cap.limitUntil('codex') > Date.now());                  // 풀리는 시각을 모르면 30분
    assert.strictEqual(cap.state('claude').state, 'out');
  });

  let fail = 0;
  for (const [ok, name, err] of results) { if (!ok) fail++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '  → ' + err}`); }
  console.log(`\n${results.length - fail}/${results.length} 통과`);
  process.exit(fail ? 1 : 0);
})();

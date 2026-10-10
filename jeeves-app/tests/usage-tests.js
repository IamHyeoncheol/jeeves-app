// 구독 사용률 시험(사양서 04 1단계): rate_limit_event 변환, 손상 입력, 저장·재로드, 자동 우선·창 만료·수동 만료·정보 없음, 초기화별 선택, 설정 정제
// 가짜 데이터와 임시 시험 폴더만 쓴다(실제 계정·로그 열람 없음).
const assert = require('assert');
const fs = require('fs'), path = require('path');
const { DevCapacity, usageFromEvent, cleanWindows } = require('../src/dev/dev-capacity');
const { ConfigStore, DEFAULTS } = require('../src/main/config');

const results = [];
async function t(name, fn) { try { await fn(); results.push([true, name]); } catch (e) { results.push([false, name, e.stack || e.message]); } }
const tmp = () => {
  const root = path.resolve(__dirname, '../../.jeeves/test-tmp');
  fs.mkdirSync(root, { recursive: true });
  return fs.mkdtempSync(path.join(root, 'jv-usage-'));
};
const H = 3600 * 1000;

// 사양서 04 0장의 실기 기록과 같은 모양의 가짜 줄
const EVENT = { type: 'rate_limit_event', rate_limit_info: { status: 'allowed_warning', resetsAt: 1791928800, rateLimitType: 'seven_day', utilization: 0.97, surpassedThreshold: 0.75,
  unifiedWindows: { five_hour: { utilization: 0.67, resetsAt: 1791625200 }, seven_day: { utilization: 0.97, resetsAt: 1791928800 } } } };
const R5 = 1791625200 * 1000, R7 = 1791928800 * 1000;

(async () => {
  await t('이벤트 변환: utilization×100 → pct, 초 → ms, 창 두 개', () => {
    const u = usageFromEvent(EVENT, 123);
    assert.deepStrictEqual(u, { family: 'claude', at: 123, windows: { five_hour: { pct: 67, resetsAt: R5 }, seven_day: { pct: 97, resetsAt: R7 } } });
    // 창 목록이 없으면 대표 값(rateLimitType) 하나만
    const one = usageFromEvent({ type: 'rate_limit_event', rate_limit_info: { rateLimitType: 'five_hour', utilization: 0.5, resetsAt: 1791625200 } }, 1);
    assert.deepStrictEqual(one.windows, { five_hour: { pct: 50, resetsAt: R5 } });
    assert.strictEqual(usageFromEvent(EVENT, 1, 'codex').family, 'codex');
  });

  await t('손상 입력: 다른 줄·빈 값·문자/음수/NaN 사용률·초기화 시각 없음은 버린다(그 창만)', () => {
    for (const bad of [null, undefined, 'x', 7, {}, { type: 'assistant' }, { type: 'rate_limit_event' }, { type: 'rate_limit_event', rate_limit_info: 'x' },
      { type: 'rate_limit_event', rate_limit_info: { unifiedWindows: { five_hour: { utilization: '0.5', resetsAt: 1791625200 } } } },
      { type: 'rate_limit_event', rate_limit_info: { unifiedWindows: { five_hour: { utilization: NaN, resetsAt: 1791625200 } } } },
      { type: 'rate_limit_event', rate_limit_info: { unifiedWindows: { five_hour: { utilization: -0.1, resetsAt: 1791625200 } } } },
      { type: 'rate_limit_event', rate_limit_info: { unifiedWindows: { five_hour: { utilization: 0.5 } } } },
      { type: 'rate_limit_event', rate_limit_info: { unifiedWindows: { five_hour: { utilization: 0.5, resetsAt: -5 } } } }]) assert.strictEqual(usageFromEvent(bad), null, JSON.stringify(bad));
    const part = usageFromEvent({ type: 'rate_limit_event', rate_limit_info: { unifiedWindows: { five_hour: { utilization: 'x', resetsAt: 1 }, seven_day: { utilization: 0.2, resetsAt: 1791928800 } } } }, 1);
    assert.deepStrictEqual(Object.keys(part.windows), ['seven_day']);
    assert.strictEqual(usageFromEvent({ type: 'rate_limit_event', rate_limit_info: { unifiedWindows: { five_hour: { utilization: 1.4, resetsAt: 1791625200 } } } }).windows.five_hour.pct, 100);   // 100% 넘으면 100
    assert.deepStrictEqual(cleanWindows([1, 2]), {});
    assert.deepStrictEqual(cleanWindows({ a: { pct: [], resetsAt: 5000 }, b: { pct: '50', resetsAt: 5000 }, c: { pct: 5, resetsAt: true } }), {});
    assert.deepStrictEqual(cleanWindows(JSON.parse('{"__proto__":{"pct":5,"resetsAt":5000}}')), {});
    assert.deepStrictEqual(cleanWindows({ 'BAD KEY': { pct: 1, resetsAt: 1 }, a: { pct: true, resetsAt: 1 }, b: { pct: null, resetsAt: 1 }, c: { pct: 5, resetsAt: 0 } }), {});
    const c = new DevCapacity(null, () => 1000);
    assert.strictEqual(c.recordUsage(null), false);
    assert.strictEqual(c.recordUsage({ family: 'Claude!!', windows: { five_hour: { pct: 5, resetsAt: 5000 } } }), false);
    assert.strictEqual(c.recordUsage({ family: 'claude', windows: 'x' }), false);
    assert.strictEqual(c.recordUsage({ family: 'claude', windows: { five_hour: { pct: 'abc', resetsAt: 5000 } } }), false);
    assert.deepStrictEqual(c.usage, {});
    assert.strictEqual(c.state('constructor').source, 'none');
    assert.strictEqual(c.getChoice('constructor'), null);
  });

  await t('저장·재로드: 기존 events 보존, 계열별 최신 자동 값·org/user·선택 저장, 손상 항목은 버림', () => {
    const f = path.join(tmp(), 'cap.json'); let now = 1_791_000_000_000;
    fs.writeFileSync(f, JSON.stringify({ events: [{ at: now - H, family: 'claude', kind: 'ok' }] }));   // 예전 형식 파일
    const a = new DevCapacity(f, () => now, { org: 'acme', user: 'kim' });
    assert.strictEqual(a.events.length, 1);
    assert.strictEqual(a.recordUsage({ ...usageFromEvent(EVENT, now) }), true);
    assert.strictEqual(a.recordUsage({ family: 'claude', windows: { five_hour: { pct: 1, resetsAt: R5 } }, at: now - H }), false);   // 늦게 온 옛 값은 무시
    assert.strictEqual(a.usage.claude.windows.seven_day.pct, 97);
    a.record({ family: 'codex', kind: 'limit', resumeAt: now + H });
    assert.strictEqual(a.setChoice('claude', 'switch', R7), true);
    const j = JSON.parse(fs.readFileSync(f, 'utf8'));
    assert.strictEqual(j.events.length, 2);
    assert.deepStrictEqual([j.usage.claude.org, j.usage.claude.user, j.choices.claude.org, j.choices.claude.user], ['acme', 'kim', 'acme', 'kim']);
    const b = new DevCapacity(f, () => now);
    assert.strictEqual(b.events.length, 2);
    assert.deepStrictEqual(b.usage.claude.windows, a.usage.claude.windows);
    assert.strictEqual(b.usage.claude.org, 'acme');
    assert.strictEqual(b.getChoice('claude'), 'switch');
    assert.strictEqual(b.limitUntil('codex'), now + H);
    assert.strictEqual(b.state('claude').source, 'auto');
    // 손상된 항목이 섞인 파일: 쓸 수 있는 것만 읽는다
    fs.writeFileSync(f, JSON.stringify({ events: [null, 5, []], usage: { claude: { windows: { seven_day: { pct: 'x', resetsAt: R7 } } }, 'BAD!': { windows: { five_hour: { pct: 5, resetsAt: R5 } } }, codex: { windows: { five_hour: { pct: 40, resetsAt: R5 } }, at: now } },
      choices: { claude: { choice: 'explode', resetsAt: R7 }, codex: { choice: 'continue', resetsAt: 'x' } } }));
    const c = new DevCapacity(f, () => now);
    assert.deepStrictEqual(Object.keys(c.usage), ['codex']);
    assert.strictEqual(c.usage.codex.org, 'default'); assert.strictEqual(c.usage.codex.user, 'owner');
    assert.deepStrictEqual(c.choices, {});
    assert.strictEqual(c.state('codex').usedPct, 40);
    fs.writeFileSync(f, '{깨짐'); const d = new DevCapacity(f, () => now);
    assert.deepStrictEqual([d.events.length, Object.keys(d.usage).length, Object.keys(d.choices).length], [0, 0, 0]);
  });

  await t('자동 우선: 유효한 자동 창 중 큰 값이 수동 입력보다 먼저', () => {
    const now = R5 - 2 * H; const c = new DevCapacity(null, () => now);
    c.recordUsage(usageFromEvent(EVENT, now));
    const s = c.state('claude', { usedPct: 10, at: now - H });
    assert.deepStrictEqual([s.usedPct, s.window, s.resetsAt, s.source, s.state], [97, 'seven_day', R7, 'auto', 'low']);
    assert.ok(/7일 사용 97% 자동/.test(s.note), s.note);
  });

  await t('창 만료: 초기화 시각이 지난 창은 각각 무시 → 남은 창 → 수동 → 정보 없음', () => {
    let now = R5 - H; const c = new DevCapacity(null, () => now);
    c.recordUsage({ family: 'claude', windows: { five_hour: { pct: 99, resetsAt: R5 }, seven_day: { pct: 50, resetsAt: R7 } }, at: now });
    assert.deepStrictEqual([c.state('claude').usedPct, c.state('claude').window], [99, 'five_hour']);
    now = R5 + 1;   // 5시간 창만 지남
    let s = c.state('claude', { usedPct: 80, at: now - H });
    assert.deepStrictEqual([s.usedPct, s.window, s.source, s.state], [50, 'seven_day', 'auto', 'ok']);
    now = R7;       // 두 창 모두 지남 → 수동 값
    s = c.state('claude', { usedPct: 80, at: now - H });
    assert.deepStrictEqual([s.usedPct, s.window, s.resetsAt, s.source, s.state], [80, null, 0, 'manual', 'tight']);
    s = c.state('claude');
    assert.deepStrictEqual([s.usedPct, s.source, s.state], [null, 'none', 'unknown']);
  });

  await t('수동 만료: 48시간 지난 입력은 무시하고 정보 없음(오래됨 안내)', () => {
    const now = 2_000_000_000_000; const c = new DevCapacity(null, () => now);
    assert.strictEqual(c.state('claude', { usedPct: 60, at: now - 47 * H }).source, 'manual');
    assert.strictEqual(c.state('claude', { usedPct: 0, at: now - 48 * H }).source, 'manual');
    assert.strictEqual(c.state('claude', { usedPct: 60, at: now - 48 * H - 1 }).source, 'none');
    assert.strictEqual(c.state('claude', { usedPct: 60, at: now + H }).source, 'none');
    const s = c.state('claude', { usedPct: 95, at: now - 49 * H });
    assert.deepStrictEqual([s.usedPct, s.source, s.state], [null, 'none', 'unknown']);
    assert.ok(/오래/.test(s.note));
    for (const cap of [{ usedPct: null, at: now }, { usedPct: '', at: now }, { usedPct: 'abc', at: now }, { usedPct: true, at: now }, { usedPct: 50, at: 0 }, { usedPct: -5, at: now }])
      assert.strictEqual(c.state('claude', cap).source, 'none', JSON.stringify(cap));
  });

  await t('정보 없음(Codex): usedPct null·source none·기존 unknown 그대로, 다른 계열 자동 값에 영향 없음', () => {
    const now = R5 - H; const c = new DevCapacity(null, () => now);
    c.recordUsage(usageFromEvent(EVENT, now));
    const s = c.state('codex');
    assert.deepStrictEqual(s, { state: 'unknown', until: 0, note: '정보 없음(보통으로 봄)', usedPct: null, window: null, resetsAt: 0, source: 'none' });
  });

  await t('한도 대기 유지: 한도 기록이 있으면 out·until 우선, 사용률 칸은 함께 제공', () => {
    const now = R5 - 3 * H; const c = new DevCapacity(null, () => now);
    c.recordUsage({ family: 'claude', windows: { five_hour: { pct: 20, resetsAt: R5 } }, at: now });
    c.record({ family: 'claude', kind: 'limit', resumeAt: now + H });
    const s = c.state('claude');
    assert.deepStrictEqual([s.state, s.until, s.usedPct, s.source], ['out', now + H, 20, 'auto']);
    assert.ok(/한도 도달/.test(s.note));
  });

  await t('초기화별 선택: 초기화 전까지 기억, 지나면 해제, 잘못된 값은 저장 안 함', () => {
    let now = R5 - H; const c = new DevCapacity(null, () => now);
    assert.strictEqual(c.setChoice('claude', 'A', R5), false);
    assert.strictEqual(c.setChoice('claude', 'switch', now - 1), false);   // 이미 지난 초기화
    assert.strictEqual(c.setChoice('Bad Family', 'switch', R5), false);
    assert.strictEqual(c.getChoice('claude'), null);
    assert.strictEqual(c.setChoice('claude', 'continue', R5), true);
    assert.strictEqual(c.getChoice('claude'), 'continue');
    assert.strictEqual(c.getChoice('codex'), null);
    now = R5;
    assert.strictEqual(c.getChoice('claude'), null);
    assert.ok(!c.choices.claude);
    c.setChoice('codex', 'switch', R7); c.clearChoice('codex');
    assert.strictEqual(c.getChoice('codex'), null);
  });

  await t('설정 정제: 수동 사용률 0~100 정수, 잘못된 값 무시 (switchRule 이 있으면 범위·동작 검사)', () => {
    const cs = new ConfigStore(tmp(), null);
    cs.update({ dev: { capacity: { claude: { usedPct: 150, at: 5 }, codex: { usedPct: 'abc', at: 5 } } } });
    assert.deepStrictEqual(cs.get().dev.capacity.claude, { usedPct: 100, at: 5 });
    assert.deepStrictEqual(cs.get().dev.capacity.codex, { usedPct: null, at: 0 });
    cs.update({ dev: { capacity: { claude: { usedPct: -3.6, at: 0 } } } });
    assert.strictEqual(cs.get().dev.capacity.claude.usedPct, 0); assert.ok(cs.get().dev.capacity.claude.at > 0);
    cs.update({ dev: { capacity: { claude: { usedPct: '', at: 9 } } } });
    assert.deepStrictEqual(cs.get().dev.capacity.claude, { usedPct: null, at: 0 });
    if (DEFAULTS.dev.switchRule) {   // 작업 2(config.js)가 반영된 경우에만
      cs.update({ dev: { switchRule: { claude: { pct: 30, action: 'boom' }, codex: { pct: 95, action: 'switch' }, askTimeoutMin: -3 } } });
      const r = cs.get().dev.switchRule;
      assert.ok(Number.isInteger(r.claude.pct) && r.claude.pct >= 50 && r.claude.pct <= 100);
      assert.ok(['ask', 'switch', 'continue'].includes(r.claude.action));
      assert.deepStrictEqual([r.codex.pct, r.codex.action], [95, 'switch']);
      assert.ok(Number(r.askTimeoutMin) > 0);
    }
  });

  let fail = 0;
  for (const [ok, name, err] of results) { if (!ok) fail++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '  → ' + err}`); }
  console.log(`\n${results.length - fail}/${results.length} 통과`);
  process.exit(fail ? 1 : 0);
})();

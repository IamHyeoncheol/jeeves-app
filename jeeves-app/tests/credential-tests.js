// 자격 증명 읽기 부품·IMAP 점검 도구 시험 (가짜 spawn/메일함, 실제 자격 증명·네트워크 없음)
const assert = require('assert');
const { EventEmitter } = require('events');
const { readCredential } = require('../src/mail/credential-win');
const { run } = require('../tools/imap_check');
const { createImapMailbox } = require('../src/mail/imap-mailbox');

const results = [];
async function t(name, fn) { try { await fn(); results.push([true, name]); } catch (e) { results.push([false, name, e.message]); } }

const FAKE_PW = 'Zq9!fake-pass-XYZ';
// 가짜 spawn: 지정한 stdout/stderr/종료코드를 내보내고 받은 인자를 기록
function fakeSpawn({ stdout = '', stderr = '', code = 0 } = {}, calls = []) {
  return (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    const c = new EventEmitter();
    c.stdout = new EventEmitter(); c.stderr = new EventEmitter();
    setImmediate(() => { if (stdout) c.stdout.emit('data', Buffer.from(stdout)); if (stderr) c.stderr.emit('data', Buffer.from(stderr)); c.emit('close', code); });
    return c;
  };
}
const rejects = async (p) => { try { await p; } catch (e) { return e; } throw new Error('거부되어야 하는데 성공함'); };

(async () => {
  await t('정상 JSON 파싱', async () => {
    const r = await readCredential('naver', { platform: 'win32', spawn: fakeSpawn({ stdout: JSON.stringify({ user: 'abcd', password: FAKE_PW }) + '\r\n' }) });
    assert.deepStrictEqual(r, { user: 'abcd', password: FAKE_PW });
  });
  await t('항목 없음: 한국어 오류 문구', async () => {
    const e = await rejects(readCredential('naver', { platform: 'win32', spawn: fakeSpawn({ code: 3 }) }));
    assert.strictEqual(e.message, '자격 증명 Jeeves:mail:naver 가 없습니다. tools\\credential_register.bat 로 먼저 저장하세요');
  });
  await t('허용 안 된 서비스명 거부 (spawn 호출 없음)', async () => {
    const calls = [];
    for (const s of ['yahoo', '', 'naver; calc', "x' ; y", undefined]) await rejects(readCredential(s, { platform: 'win32', spawn: fakeSpawn({}, calls) }));
    assert.strictEqual(calls.length, 0);
  });
  await t('비Windows 거부', async () => {
    const calls = [];
    const e = await rejects(readCredential('naver', { platform: 'linux', spawn: fakeSpawn({}, calls) }));
    assert.ok(/Windows/.test(e.message)); assert.strictEqual(calls.length, 0);
  });
  await t('오류 메시지에 비밀번호 미포함 (stderr·깨진 stdout에 섞여도)', async () => {
    for (const o of [{ code: 1, stderr: FAKE_PW, stdout: FAKE_PW }, { code: 0, stdout: 'garbage ' + FAKE_PW }, { code: 0, stdout: JSON.stringify({ user: '', password: FAKE_PW }) }]) {
      const e = await rejects(readCredential('naver', { platform: 'win32', spawn: fakeSpawn(o) }));
      assert.ok(!e.message.includes(FAKE_PW));
    }
  });
  await t('spawn 인자·옵션에 비밀번호 없음, 대상 이름 포함, 환경변수 미전달', async () => {
    const calls = [];
    await readCredential('kakao', { platform: 'win32', spawn: fakeSpawn({ stdout: JSON.stringify({ user: 'u1', password: FAKE_PW }) }, calls) });
    const c = calls[0];
    assert.strictEqual(c.cmd, 'powershell');
    assert.deepStrictEqual(c.args.slice(0, 3), ['-NoProfile', '-NonInteractive', '-Command']);
    assert.ok(!JSON.stringify(c).includes(FAKE_PW));
    assert.ok(c.args[3].includes('Jeeves:mail:kakao'));
    assert.strictEqual(c.opts && c.opts.env, undefined);
  });

  await t('supportsMove: 가짜 클라이언트의 MOVE 능력을 불리언으로 반환', async () => {
    const mk = caps => createImapMailbox({ host: 'h', user: 'u', getPassword: async () => 'p', clientFactory: () => ({
      connect: async () => {}, logout: async () => {}, usable: true, capabilities: new Set(caps) }) });
    assert.strictEqual(await mk(['MOVE', 'IDLE']).supportsMove(), true);
    assert.strictEqual(await mk(['IDLE']).supportsMove(), false);
  });

  await t('listMessages limit: 최근 N통 범위 / limit 없음 / exists<limit 은 1:*', async () => {
    const ranges = [];
    const mk = exists => createImapMailbox({ host: 'h', user: 'u', getPassword: async () => 'p', clientFactory: () => ({
      connect: async () => {}, logout: async () => {}, usable: true, mailbox: { exists },
      getMailboxLock: async () => ({ release() {} }),
      fetch: (r) => { ranges.push(r); return (async function* () {})(); } }) });
    await mk(500).listMessages('INBOX', { limit: 50 });
    await mk(500).listMessages('INBOX');
    await mk(30).listMessages('INBOX', { limit: 50 });
    assert.deepStrictEqual(ranges, ['451:*', '1:*', '1:*']);
  });
  await t('imap_check: 정상 출력, move 미호출, 비밀번호·제목·보낸 사람·전체 주소 미출력', async () => {
    const lines = []; const log = []; let closed = false;
    const mb = {
      supportsMove: async () => true,
      listFolders: async () => ['INBOX', 'Sent'],
      listMessages: async () => Array.from({ length: 70 }, (_, i) => ({ uid: i, from: 'SECRETFROM <a@b.c>', subject: 'SECRETSUBJECT', flags: [] })),
      move: async () => { log.push('move'); }, close: async () => { closed = true; },
    };
    const code = await run({ service: 'naver', out: l => lines.push(l),
      readCredential: async () => ({ user: 'honggildong', password: FAKE_PW }),
      createImapMailbox: () => mb });
    const all = lines.join('\n');
    assert.strictEqual(code, 0); assert.strictEqual(log.length, 0); assert.ok(closed);
    for (const w of [FAKE_PW, 'SECRETSUBJECT', 'SECRETFROM', 'honggildong']) assert.ok(!all.includes(w), w);
    assert.ok(all.includes('연결 성공') && all.includes('MOVE 지원: 예') && all.includes('  Sent') && all.includes('INBOX 최근 70통 읽음') && all.includes('봉투 읽기 소요 시간(ms)') && all.includes('ho***'));
  });
  await t('imap_check: 오류는 한국어 요약, close 호출, 비밀번호 미출력', async () => {
    const lines = []; let closed = false;
    const mb = { supportsMove: async () => { throw new Error('메일 서버에 연결하지 못했습니다 (imap.naver.com, ETIMEDOUT)'); }, close: async () => { closed = true; } };
    const code = await run({ out: l => lines.push(l), readCredential: async () => ({ user: 'abcd', password: FAKE_PW }), createImapMailbox: () => mb });
    assert.strictEqual(code, 1); assert.ok(closed);
    assert.ok(lines.join('\n').includes('imap.naver.com') && !lines.join('\n').includes(FAKE_PW));
  });

  let fail = 0;
  for (const [ok, name, err] of results) { if (!ok) fail++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '  → ' + err}`); }
  console.log(`\n${results.length - fail}/${results.length} 통과`);
  process.exit(fail ? 1 : 0);
})();

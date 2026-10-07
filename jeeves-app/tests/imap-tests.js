// IMAP 메일함 부품 단위 시험 (가짜 imapflow 클라이언트 주입, 네트워크·실제 계정 없음)
const assert = require('assert');
const { createImapMailbox, PRESETS } = require('../src/mail/imap-mailbox');
const { run } = require('../src/mail/runner');

const results = [];
async function t(name, fn) { try { await fn(); results.push([true, name]); } catch (e) { results.push([false, name, e.message]); } }

const SECRET = 'pw-비밀-12345';
function fakeClient(opts = {}) {
  const st = { lists: 0, trap: [], locks: 0, released: 0, moves: [], logouts: 0, connects: 0, config: null };
  const msgs = opts.msgs || [
    { uid: 11, flags: new Set(['\\Seen']), envelope: { subject: '주문 완료', from: [{ name: '쿠팡', address: 'no-reply@mail.coupang.com' }] } },
    { uid: 12, flags: new Set(), envelope: { subject: '광고', from: [{ address: 'ads@shop.example' }] } },
  ];
  const c = {
    mailbox: { exists: opts.empty ? 0 : msgs.length },
    usable: true,
    capabilities: new Map(opts.noMove ? [['IMAP4rev1', true]] : [['IMAP4rev1', true], ['MOVE', true]]),
    async messageDelete() { st.trap.push('messageDelete'); throw new Error('함정 호출'); },
    async expunge() { st.trap.push('expunge'); throw new Error('함정 호출'); },
    async store() { st.trap.push('store'); throw new Error('함정 호출'); },
    async messageFlagsAdd() { st.trap.push('messageFlagsAdd'); throw new Error('함정 호출'); },
    async messageCopy() { st.trap.push('messageCopy'); throw new Error('함정 호출'); },
    async connect() { st.connects++; if (opts.connectError) { const e = new Error('auth failed for ' + SECRET); e.code = 'AUTHFAIL'; throw e; } },
    async list() { st.lists++; if (opts.listError) { const e = new Error('x'); e.responseText = 'SECRET-RESP'; e.code = 'LISTFAIL'; throw e; } return (opts.folders || ['INBOX', '주문·배송', '삭제대기']).map(p => ({ path: p })); },
    async getMailboxLock(p) { st.locks++; return { release() { st.released++; } }; },
    fetch() { if (opts.fetchError) { const e = new Error('fetch fail SECRET-RESP'); e.responseText = 'SECRET-RESP'; throw e; } return (async function* () { for (const m of msgs) yield m; })(); },
    async messageMove(range, dest, o) { if (opts.moveError) { const e = new Error('move fail'); e.response = 'SECRET-RESP'; e.responseText = 'SECRET-RESP'; throw e; } st.moves.push({ range, dest, o }); if (opts.moveFalse) return false; return { path: 'INBOX', destination: dest }; },
    async logout() { st.logouts++; },
  };
  return { c, st };
}
function mk(opts) {
  const f = fakeClient(opts);
  const mb = createImapMailbox({ host: 'imap.test', user: 'u@test', getPassword: async () => SECRET, clientFactory: cfg => { f.st.config = cfg; return f.c; } });
  return { mb, ...f };
}

(async () => {
  await t('프리셋: 호스트·포트만 있고 계정 정보 없음', async () => {
    assert.deepStrictEqual(Object.keys(PRESETS).sort(), ['gmail', 'kakao', 'naver']);
    assert.strictEqual(PRESETS.naver.host, 'imap.naver.com'); assert.strictEqual(PRESETS.kakao.host, 'imap.kakao.com'); assert.strictEqual(PRESETS.gmail.host, 'imap.gmail.com');
    for (const p of Object.values(PRESETS)) assert.deepStrictEqual(Object.keys(p).sort(), ['host', 'port']);
  });
  await t('listFolders: 폴더 경로 문자열 배열 반환', async () => {
    const { mb } = mk();
    assert.deepStrictEqual(await mb.listFolders(), ['INBOX', '주문·배송', '삭제대기']);
  });
  await t('listMessages: uid, from(이름 <주소>), subject, flags 배열 변환', async () => {
    const { mb } = mk();
    const m = await mb.listMessages('INBOX');
    assert.deepStrictEqual(m, [
      { uid: 11, from: '쿠팡 <no-reply@mail.coupang.com>', subject: '주문 완료', flags: ['\\Seen'] },
      { uid: 12, from: 'ads@shop.example', subject: '광고', flags: [] },
    ]);
    assert.ok(Array.isArray(m[0].flags));
  });
  await t('listMessages: 성공 시 lock 해제', async () => {
    const { mb, st } = mk(); await mb.listMessages('INBOX');
    assert.strictEqual(st.locks, 1); assert.strictEqual(st.released, 1);
  });
  await t('listMessages: 오류가 나도 lock 해제', async () => {
    const { mb, st } = mk({ fetchError: true });
    await assert.rejects(mb.listMessages('INBOX'));
    assert.strictEqual(st.locks, 1); assert.strictEqual(st.released, 1);
  });
  await t('move: uid 기반(uid:true)으로 대상 폴더에 이동하고 lock 해제', async () => {
    const { mb, st } = mk(); await mb.move(11, 'INBOX', '주문·배송');
    assert.deepStrictEqual(st.moves, [{ range: '11', dest: '주문·배송', o: { uid: true } }]);
    assert.strictEqual(st.locks, st.released);
  });
  await t('move: 없는 대상 폴더는 옮기지 않고 오류', async () => {
    const { mb, st } = mk();
    await assert.rejects(mb.move(11, 'INBOX', '없는폴더'), /대상 폴더 없음/);
    assert.strictEqual(st.moves.length, 0);
  });
  await t('move: 이동 중 오류가 나도 lock 해제', async () => {
    const { mb, st } = mk({ moveError: true });
    await assert.rejects(mb.move(11, 'INBOX', '주문·배송'));
    assert.strictEqual(st.locks, st.released); assert.ok(st.locks >= 1);
  });
  await t('인터페이스에 delete/remove/expunge/purge 계열 없음', async () => {
    const { mb } = mk();
    assert.deepStrictEqual(Object.keys(mb).sort(), ['close', 'listFolders', 'listMessages', 'move', 'supportsMove']);
    for (const k of Object.keys(mb)) assert.ok(!/delete|remove|expunge|purge/i.test(k));
  });
  await t('연결 실패 오류: 한국어 메시지, 비밀번호 미포함', async () => {
    const { mb } = mk({ connectError: true });
    try { await mb.listFolders(); assert.fail('오류가 나야 함'); }
    catch (e) { assert.ok(/연결하지 못했습니다/.test(e.message)); assert.ok(!e.message.includes(SECRET)); }
  });
  await t('비밀번호는 연결 시점에 getPassword로 받고 객체에 저장되지 않음', async () => {
    let calls = 0;
    const f = fakeClient();
    const mb = createImapMailbox({ host: 'h', user: 'u', getPassword: async () => { calls++; return SECRET; }, clientFactory: () => f.c });
    assert.strictEqual(calls, 0);
    await mb.listFolders(); await mb.listFolders();
    assert.strictEqual(calls, 1);
    assert.ok(!JSON.stringify(Object.keys(mb)).includes(SECRET));
    for (const v of Object.values(mb)) assert.ok(!String(v).includes(SECRET));
  });
  await t('close: 연결했으면 logout, 연결 전이면 아무 일 없음', async () => {
    const a = mk(); await a.mb.close(); assert.strictEqual(a.st.logouts, 0);
    const b = mk(); await b.mb.listFolders(); await b.mb.close(); await b.mb.close(); assert.strictEqual(b.st.logouts, 1);
  });
  await t('runner 미리보기: 이 부품으로 move를 한 번도 호출하지 않음', async () => {
    const { mb, st } = mk();
    const rules = [{ id: 'r1', when: { fromDomain: 'coupang.com' }, action: { type: 'move', folder: '주문·배송' } }];
    const r = await run(mb, { rules, trashFolder: '삭제대기' });
    assert.strictEqual(r.mode, 'preview'); assert.strictEqual(r.planned, 1);
    assert.strictEqual(st.moves.length, 0);
  });
  await t('runner 적용: 규칙에 맞는 메일은 uid:true로 이동', async () => {
    const { mb, st } = mk();
    const rules = [{ id: 'r1', when: { fromDomain: 'coupang.com' }, action: { type: 'move', folder: '주문·배송' } }];
    const r = await run(mb, { rules, mode: 'apply', trashFolder: '삭제대기' });
    assert.strictEqual(r.moved, 1); assert.strictEqual(st.moves[0].o.uid, true);
  });

  await t('MOVE 미지원 서버: messageMove·COPY 호출 없이 한국어 오류로 거부', async () => {
    const { mb, st } = mk({ noMove: true });
    await assert.rejects(mb.move(11, 'INBOX', '주문·배송'), /안전한 이동\(MOVE\)을 지원하지 않아 이동하지 않았습니다/);
    assert.strictEqual(st.moves.length, 0); assert.deepStrictEqual(st.trap, []);
  });
  await t('어떤 경로에서도 삭제·expunge·store·copy 함정 메서드가 호출되지 않음', async () => {
    for (const o of [{}, { noMove: true }, { moveError: true }, { moveFalse: true }, { fetchError: true }]) {
      const { mb, st } = mk(o);
      try { await mb.listFolders(); await mb.listMessages('INBOX'); } catch (_) {}
      try { await mb.move(11, 'INBOX', '주문·배송'); } catch (_) {}
      await mb.close();
      assert.deepStrictEqual(st.trap, []);
    }
  });
  await t('list/fetch/move 오류: 서버 원문(SECRET-RESP)·비밀번호가 오류 메시지에 없고 호스트+코드만', async () => {
    for (const [o, fn] of [[{ listError: true }, mb => mb.listFolders()], [{ fetchError: true }, mb => mb.listMessages('INBOX')], [{ moveError: true }, mb => mb.move(11, 'INBOX', '주문·배송')]]) {
      const { mb } = mk(o);
      try { await fn(mb); assert.fail('오류가 나야 함'); }
      catch (e) { assert.ok(/메일 서버 작업에 실패했습니다/.test(e.message)); assert.ok(!e.message.includes('SECRET-RESP')); assert.ok(!e.message.includes(SECRET)); assert.ok(e.message.includes('imap.test')); }
    }
  });
  await t('listFolders 오류 코드는 메시지에 포함', async () => {
    const { mb } = mk({ listError: true });
    await assert.rejects(mb.listFolders(), /LISTFAIL/);
  });
  await t('messageMove가 false를 반환하면 오류 처리하고 lock 해제', async () => {
    const { mb, st } = mk({ moveFalse: true });
    await assert.rejects(mb.move(11, 'INBOX', '주문·배송'), /옮기지 못했습니다/);
    assert.strictEqual(st.locks, st.released);
  });
  await t('원본(from) 폴더가 없으면 오류, 이동 안 함', async () => {
    const { mb, st } = mk();
    await assert.rejects(mb.move(11, '없는원본', '주문·배송'), /원본 폴더 없음/);
    assert.strictEqual(st.moves.length, 0);
  });
  await t('빈 메일함(exists 0)은 빈 배열, lock 해제', async () => {
    const { mb, st } = mk({ empty: true });
    assert.deepStrictEqual(await mb.listMessages('INBOX'), []);
    assert.strictEqual(st.locks, st.released);
  });
  await t('폴더 목록 캐시: move마다 LIST 하지 않음', async () => {
    const { mb, st } = mk();
    await mb.listFolders();
    await mb.move(11, 'INBOX', '주문·배송'); await mb.move(12, 'INBOX', '삭제대기');
    assert.strictEqual(st.lists, 1);
  });
  await t('연결이 끊기면(usable false) 정리하고 다음 호출에서 새로 연결', async () => {
    const clients = [];
    const mb = createImapMailbox({ host: 'h', user: 'u', getPassword: async () => SECRET, clientFactory: () => { const f = fakeClient(); clients.push(f); return f.c; } });
    await mb.listFolders();
    clients[0].c.usable = false;
    await mb.listFolders();
    assert.strictEqual(clients.length, 2); assert.strictEqual(clients[0].st.logouts, 1); assert.strictEqual(clients[1].st.connects, 1);
  });
  await t('연결 실패 후 다음 호출은 새로 연결을 시도', async () => {
    let n = 0; const f = fakeClient();
    const mb = createImapMailbox({ host: 'h', user: 'u', getPassword: async () => SECRET, clientFactory: () => { n++; if (n === 1) return fakeClient({ connectError: true }).c; return f.c; } });
    await assert.rejects(mb.listFolders(), /연결하지 못했습니다/);
    assert.deepStrictEqual(await mb.listFolders(), ['INBOX', '주문·배송', '삭제대기']);
    assert.strictEqual(n, 2);
  });

  let fail = 0;
  for (const [ok, name, err] of results) { if (!ok) fail++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '  → ' + err}`); }
  console.log(`\n${results.length - fail}/${results.length} 통과`);
  process.exit(fail ? 1 : 0);
})();

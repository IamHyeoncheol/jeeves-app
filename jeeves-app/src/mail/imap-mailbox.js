// 실제 IMAP 메일함 부품. 가짜 메일함(fake-mailbox.js)과 같은 모양(listFolders/listMessages/move)을 따른다.
// 헌장: 영구 삭제·expunge·delete 계열 기능은 일부러 만들지 않는다 (삭제는 휴지통 이동만).
// 보안: 비밀번호는 연결할 때 getPassword()로만 받고 객체·로그·오류 메시지에 남기지 않는다.
// 메일 본문은 내려받지 않는다 (봉투·플래그·uid만).

// 서비스 프리셋 (호스트만, 계정 정보 없음)
const PRESETS = {
  naver: { host: 'imap.naver.com', port: 993 },
  kakao: { host: 'imap.kakao.com', port: 993 },
  gmail: { host: 'imap.gmail.com', port: 993 },
};

function defaultClientFactory(config) {
  const { ImapFlow } = require('imapflow');
  return new ImapFlow(config);
}

// 봉투의 보낸 사람 -> "이름 <주소>" 문자열 (classifier.addressOf가 읽는 형태)
function formatFrom(envelope) {
  const a = envelope && envelope.from && envelope.from[0];
  if (!a || !a.address) return '';
  const name = String(a.name || '').replace(/[<>\r\n]/g, ' ').trim();
  return name ? `${name} <${a.address}>` : a.address;
}

function createImapMailbox({ host, port = 993, secure = true, user, getPassword, clientFactory = defaultClientFactory } = {}) {
  if (!host || !user || typeof getPassword !== 'function') throw new Error('IMAP 설정 오류: host, user, getPassword가 필요합니다');
  let client = null;
  let connecting = null;
  let folderCache = null; // 이미 받은 폴더 목록 (연결이 바뀌면 비운다)

  // 연결 정리: 실패해도 무시하고 상태를 비워 다음 호출에서 새로 연결되게 한다
  async function dropClient(c) {
    if (client === c) { client = null; folderCache = null; }
    if (c) {
      try { await c.logout(); } catch (_) { /* 이미 끊긴 연결은 무시 */ }
      try { if (typeof c.close === 'function') c.close(); } catch (_) { /* 무시 */ }
    }
  }

  // 오류 원문(서버 응답·메일 내용·비밀번호가 섞일 수 있음)은 버리고 호스트+오류 코드만 남긴다
  function wrapError(what, e) {
    const code = e && typeof e.code === 'string' ? ', ' + e.code : '';
    return new Error('메일 서버 작업에 실패했습니다 (' + what + ', ' + host + code + ')');
  }

  async function guarded(what, fn) {
    const c = await connect();
    try { return await fn(c); }
    catch (e) {
      if (e && e.jeevesSafe) throw e;
      if (c.usable === false) await dropClient(c);
      throw wrapError(what, e);
    }
  }
  function safeError(msg) { const e = new Error(msg); e.jeevesSafe = true; return e; }

  async function connect() {
    if (client && client.usable === false) await dropClient(client);
    if (client) return client;
    if (connecting) return connecting;
    connecting = (async () => {
      let c;
      try {
        const pass = await getPassword();
        c = clientFactory({ host, port, secure, auth: { user, pass }, logger: false });
        await c.connect();
      } catch (e) {
        await dropClient(c);
        throw new Error('메일 서버에 연결하지 못했습니다 (' + host + (e && typeof e.code === 'string' ? ', ' + e.code : '') + ')');
      }
      client = c;
      folderCache = null;
      return c;
    })();
    try { return await connecting; } finally { connecting = null; }
  }

  async function fetchFolders() {
    const list = await guarded('폴더 목록', c => c.list());
    folderCache = list.map(f => f.path);
    return folderCache;
  }

  async function listFolders() {
    return (await fetchFolders()).slice();
  }

  // opts.limit가 있으면 가장 최근 limit통만 읽는다 (없으면 전체)
  async function listMessages(folder, opts = {}) {
    return guarded('메일 목록', async c => {
      const lock = await c.getMailboxLock(folder);
      try {
        const out = [];
        if (c.mailbox && c.mailbox.exists === 0) return out;
        const exists = c.mailbox && typeof c.mailbox.exists === 'number' ? c.mailbox.exists : 0;
        const limit = opts && Number.isInteger(opts.limit) && opts.limit > 0 ? opts.limit : 0;
        const range = limit && exists > limit ? `${Math.max(1, exists - limit + 1)}:*` : '1:*';
        for await (const m of c.fetch(range, { uid: true, envelope: true, flags: true })) {
          out.push({
            uid: m.uid,
            from: formatFrom(m.envelope),
            subject: (m.envelope && m.envelope.subject) || '',
            flags: Array.from(m.flags || []),
          });
        }
        return out;
      } finally { lock.release(); }
    });
  }

  async function move(uid, from, to) {
    // 폴더 목록은 캐시를 쓰고, 없을 때만 한 번 다시 조회한다
    let folders = folderCache || await fetchFolders();
    if (!folders.includes(to) || !folders.includes(from)) folders = await fetchFolders();
    if (!folders.includes(to)) throw safeError('대상 폴더 없음: ' + to);
    if (!folders.includes(from)) throw safeError('원본 폴더 없음: ' + from);
    return guarded('메일 이동', async c => {
      // imapflow는 MOVE가 없으면 COPY+삭제표시+EXPUNGE로 대체해 영구 삭제가 되므로, MOVE 없으면 거부한다
      if (!c.capabilities || typeof c.capabilities.has !== 'function' || !c.capabilities.has('MOVE')) {
        throw safeError('이 서버는 안전한 이동(MOVE)을 지원하지 않아 이동하지 않았습니다');
      }
      const lock = await c.getMailboxLock(from);
      try {
        const r = await c.messageMove(String(uid), to, { uid: true });
        if (!r) throw safeError('메일을 옮기지 못했습니다: ' + uid);
      } finally { lock.release(); }
    });
  }

  // 서버가 안전한 MOVE를 지원하는지 (연결 후 확인만 하며 아무것도 바꾸지 않는다)
  async function supportsMove() {
    return guarded('MOVE 지원 확인', async c => !!(c.capabilities && typeof c.capabilities.has === 'function' && c.capabilities.has('MOVE')));
  }

  async function close() { await dropClient(client); }

  return { listFolders, listMessages, move, supportsMove, close };
}

module.exports = { createImapMailbox, PRESETS, formatFrom };

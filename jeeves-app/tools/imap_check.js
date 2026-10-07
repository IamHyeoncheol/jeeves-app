// 네이버 등 IMAP 읽기 전용 점검 도구. 폴더·개수·속도만 보고, 메일 이동/삭제는 하지 않는다.
// 사용: node tools\imap_check.js [naver|kakao|gmail]
// 출력에 비밀번호·메일 제목·보낸 사람·전체 메일 주소를 찍지 않는다.
const { readCredential } = require('../src/mail/credential-win');
const { createImapMailbox, PRESETS } = require('../src/mail/imap-mailbox');

const MAX_ENVELOPES = 50;

async function run({ service = 'naver', readCredential: rc = readCredential, createImapMailbox: cm = createImapMailbox, presets = PRESETS, out = console.log, now = () => Date.now() } = {}) {
  let mb = null;
  try {
    const preset = presets[service];
    if (!preset) throw new Error('지원하지 않는 서비스입니다: ' + service);
    const { user, password } = await rc(service);
    out('계정: ' + String(user).slice(0, 2) + '***');
    mb = cm({ host: preset.host, port: preset.port, user, getPassword: async () => password });
    const canMove = await mb.supportsMove(); // 이 호출이 연결을 만든다
    out('연결 성공 (' + preset.host + ')');
    out('MOVE 지원: ' + (canMove ? '예' : '아니오'));
    const folders = await mb.listFolders();
    out('폴더 ' + folders.length + '개');
    for (const f of folders) out('  ' + f);
    const t0 = now();
    const msgs = await mb.listMessages('INBOX', { limit: MAX_ENVELOPES });
    const ms = now() - t0;
    out('INBOX 최근 ' + msgs.length + '통 읽음 (최대 ' + MAX_ENVELOPES + '통)');
    out('봉투 읽기 소요 시간(ms): ' + ms + ' (' + msgs.length + '통 기준)');
    return 0;
  } catch (e) {
    out('점검 실패: ' + ((e && e.message) || '알 수 없는 오류'));
    return 1;
  } finally {
    if (mb) { try { await mb.close(); } catch (_) { /* 무시 */ } }
  }
}

if (require.main === module) {
  run({ service: process.argv[2] || 'naver' }).then(code => { process.exitCode = code; });
}

module.exports = { run };

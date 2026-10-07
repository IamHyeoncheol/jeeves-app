// 시험용 가짜 메일함. 실제 IMAP 연결 부품도 같은 모양(listFolders/listMessages/move)을 따른다.
// 영구 삭제 기능은 일부러 만들지 않는다 (헌장: 삭제는 휴지통 이동만).
class FakeMailbox {
  constructor(folders) { this.folders = {}; for (const [name, msgs] of Object.entries(folders)) this.folders[name] = msgs.map(m => ({ ...m })); }
  async listFolders() { return Object.keys(this.folders); }
  async listMessages(folder) { if (!this.folders[folder]) throw new Error('폴더 없음: ' + folder); return this.folders[folder].map(m => ({ ...m })); }
  async move(uid, from, to) {
    if (!this.folders[from] || !this.folders[to]) throw new Error('폴더 없음');
    const i = this.folders[from].findIndex(m => m.uid === uid);
    if (i < 0) throw new Error('메일 없음: ' + uid);
    this.folders[to].push(this.folders[from].splice(i, 1)[0]);
  }
}
module.exports = { FakeMailbox };

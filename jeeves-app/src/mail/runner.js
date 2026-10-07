// 계획(plan)을 메일함에 적용한다. 기본은 '미리보기'(아무것도 안 옮김).
const { plan } = require('./classifier');

// opts: { rules, inbox, trashFolder, mode: 'preview'|'apply', requireTrashApproval: true, approveTrash: async (items) => boolean, limit }
async function run(mailbox, opts) {
  const folders = await mailbox.listFolders();
  const inbox = opts.inbox || 'INBOX';
  const msgs = (await mailbox.listMessages(inbox, { limit: opts.limit || 200 })).slice(0, opts.limit || 200);
  const p = plan(msgs, opts.rules);
  const result = { planned: p.items.length, moved: 0, trashed: 0, unclassified: p.unclassified.length, skipped: p.skipped.length, errors: [], mode: opts.mode || 'preview' };
  if (result.mode !== 'apply') return { ...result, plan: p };

  const target = it => it.action.type === 'trash' ? opts.trashFolder : it.action.folder;
  let items = p.items;
  const trash = items.filter(i => i.action.type === 'trash');
  if (trash.length && opts.requireTrashApproval !== false) {
    const ok = opts.approveTrash ? await opts.approveTrash(trash) : false;
    if (!ok) items = items.filter(i => i.action.type !== 'trash'); // 거절·무응답이면 휴지통 이동은 하지 않는다
  }
  for (const it of items) {
    const to = target(it);
    if (!to || !folders.includes(to)) { result.errors.push({ uid: it.uid, error: '대상 폴더 없음: ' + to }); continue; }
    try { await mailbox.move(it.uid, inbox, to); if (it.action.type === 'trash') result.trashed++; else result.moved++; }
    catch (e) { result.errors.push({ uid: it.uid, error: e.message }); }
  }
  return { ...result, plan: p };
}
module.exports = { run };

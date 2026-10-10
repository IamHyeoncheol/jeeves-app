// 작업 폴더 결정 시험(0.48): 사전에 정해 둔 값이 아니라 지시문·대화 맥락으로 정한다.
const assert = require('assert');
const { pickFolderFor } = require('../src/dev/folder-pick');
const results = [];
const t = async (name, fn) => { try { await fn(); results.push([true, name]); } catch (e) { results.push([false, name, e.message]); } };

// 가짜 파일 시스템(드라이브 D: 아래 몇 개 폴더·파일)
const dirs = new Set(['d:\\', 'd:\\ai_project', 'd:\\ai_project\\박시', 'd:\\ai_project\\박시\\iris_recognition', 'd:\\ai_project\\jeeves', 'd:\\ai_project\\shop']);
const files = new Set(['d:\\ai_project\\박시\\iris_recognition\\iris.py', 'd:\\ai_project\\shop\\index.html']);
const stat = p => { const k = String(p).replace(/[\\/]+$/, '').toLowerCase().replace(/\//g, '\\'); const kk = /^[a-z]:$/.test(k) ? k + '\\' : k; return dirs.has(kk) ? 'dir' : files.has(kk) ? 'file' : null; };
const pick = (g, o = {}) => pickFolderFor(g, { stat, ...o });

(async () => {
  await t('지시문에 폴더 경로가 있으면 그 폴더(조사가 붙어도)', () => {
    let r = pick('D:\\AI_Project\\shop 폴더에서 버튼 색을 고쳐줘');
    assert.deepStrictEqual([r.folder, r.source], ['D:\\AI_Project\\shop', '지시문의 경로']);
    r = pick('D:\\AI_Project\\박시\\iris_recognition를 정리해줘');
    assert.strictEqual(r.folder, 'D:\\AI_Project\\박시\\iris_recognition');
  });
  await t('파일 경로면 그 파일이 든 폴더', () => {
    assert.strictEqual(pick('D:\\AI_Project\\shop\\index.html 제목을 바꿔줘').folder, 'D:\\AI_Project\\shop');
  });
  await t('폴더가 여러 개면 공통 상위 폴더(이동 지시)이고 넓다고 표시', () => {
    const r = pick('D:\\AI_Project\\박시\\iris_recognition 을 D:\\AI_Project\\jeeves 안으로 옮겨줘');
    assert.strictEqual(r.folder, 'D:\\AI_Project'); assert.strictEqual(r.broad, true);
  });
  await t('없는 새 폴더(부모는 있음)는 새로 만들 폴더로 판정', () => {
    const r = pick('D:\\AI_Project\\iris_new 폴더를 만들고 거기에 앱을 만들어줘');
    assert.deepStrictEqual([r.folder, r.create], ['D:\\AI_Project\\iris_new', true]);
  });
  await t('경로가 없으면 이 대화에서 쓰던 폴더, 그것도 없으면 묻는다(전역 기본값 없음)', () => {
    let r = pick('로그인 화면을 만들어줘', { sessionFolder: 'D:\\AI_Project\\shop' });
    assert.deepStrictEqual([r.folder, r.source], ['D:\\AI_Project\\shop', '이 대화에서 이미 쓰던 폴더']);
    r = pick('로그인 화면을 만들어줘');
    assert.deepStrictEqual([r.folder, r.ask], [null, true]);
  });
  await t('지시문 경로가 이 대화의 이전 폴더보다 우선', () => {
    assert.strictEqual(pick('D:\\AI_Project\\jeeves 의 설정을 고쳐줘', { sessionFolder: 'D:\\AI_Project\\shop' }).folder, 'D:\\AI_Project\\jeeves');
  });
  await t('드라이브 루트만 있는 경로는 단서로 쓰지 않는다', () => {
    assert.strictEqual(pick('D:\\ 에 뭔가 만들어줘').ask, true);
  });
  let fail = 0;
  for (const [ok, name, err] of results) { if (!ok) fail++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '  → ' + err}`); }
  console.log(`\nfolder-tests: ${results.length - fail}/${results.length} 통과`);
  process.exit(fail ? 1 : 0);
})();

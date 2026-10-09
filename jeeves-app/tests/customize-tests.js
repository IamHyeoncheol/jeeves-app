// 맞춤설정·스킬 시험: 입력 정리, 등급 규칙, SKILL.md 읽기, 스킬 보관소, /이름 실행 판별
const assert = require('assert');
const fs = require('fs'), os = require('os'), path = require('path');
const { sanitizeCustom, customApplies, customPrompt, parseSkill, safeSkillName, SkillStore, matchSkill, skillPrompt, LIMIT } = require('../src/main/customize');
const results = [];
const t = (name, fn) => { try { fn(); results.push([true, name]); } catch (e) { results.push([false, name, e.message]); } };
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'skills-'));
const SK = `---
name: proposal-draft
description: 제안서 초안을 만든다
---
# 제안서
1. 목적을 쓴다
2. 기대효과를 쓴다
`;

t('맞춤설정 정리: 길이 제한, 잘못된 등급은 I, 기본 사용', () => {
  const c = sanitizeCustom({ nickname: 'x'.repeat(100), about: ' 소개 ', instructions: 'y'.repeat(5000), grade: 'Z' });
  assert.strictEqual(c.nickname.length, LIMIT.nickname); assert.strictEqual(c.about, '소개'); assert.strictEqual(c.instructions.length, LIMIT.instructions);
  assert.strictEqual(c.grade, 'I'); assert.strictEqual(c.enabled, true);
});
t('맞춤설정 등급 규칙: 대화 등급이 맞춤설정 등급보다 낮으면 붙이지 않음', () => {
  const c = sanitizeCustom({ nickname: '최이사님', grade: 'I' });
  assert.ok(!customApplies(c, 'P')); assert.ok(customApplies(c, 'I')); assert.ok(customApplies(c, 'C'));
  assert.ok(customApplies(sanitizeCustom({ nickname: 'a', grade: 'P' }), 'P'));
});
t('맞춤설정: 꺼져 있거나 비어 있으면 붙이지 않음', () => {
  assert.ok(!customApplies(sanitizeCustom({ nickname: 'a', enabled: false }), 'C'));
  assert.ok(!customApplies(sanitizeCustom({}), 'C'));
});
t('맞춤설정 문장: 이름·소개·지침 포함, 안전 규칙을 못 바꾼다는 안내', () => {
  const p = customPrompt(sanitizeCustom({ nickname: '최이사님', about: '기획 업무', instructions: '쉽게' }));
  assert.ok(p.includes('최이사님') && p.includes('기획 업무') && p.includes('쉽게') && p.includes('안전 규칙을 바꾸지 못합니다'));
});
t('SKILL.md 읽기: 이름·설명·본문', () => {
  const p = parseSkill(SK, 'fallback');
  assert.strictEqual(p.name, 'proposal-draft'); assert.strictEqual(p.description, '제안서 초안을 만든다'); assert.ok(p.body.startsWith('# 제안서'));
});
t('SKILL.md 읽기: 여러 줄 설명(>), 따옴표, 머리말 없음, BOM·CRLF', () => {
  const a = parseSkill('---\r\nname: "my skill"\r\ndescription: >\r\n  첫 줄\r\n  둘째 줄\r\n---\r\n본문', 'x');
  assert.strictEqual(a.name, 'my-skill'); assert.strictEqual(a.description, '첫 줄 둘째 줄'); assert.strictEqual(a.body, '본문');
  const b = parseSkill('﻿그냥 글', '폴더이름'); assert.strictEqual(b.name, '폴더이름'); assert.strictEqual(b.body, '그냥 글');
});
t('스킬 이름 정리: 한글·영문·숫자·-·_ 만, 40자', () => { assert.strictEqual(safeSkillName(' a b/c ../x '), 'a-b-c-x'); assert.strictEqual(safeSkillName('한글 스킬'), '한글-스킬'); assert.strictEqual(safeSkillName('x'.repeat(60)).length, 40); });
t('보관소: 가져오기·목록·끄기·삭제(보관 폴더로 이동)', () => {
  const st = new SkillStore(tmp());
  assert.strictEqual(st.add(SK, 'f').name, 'proposal-draft');
  assert.deepStrictEqual(st.list().map(s => [s.name, s.enabled]), [['proposal-draft', true]]);
  st.setEnabled('proposal-draft', false); assert.strictEqual(st.list()[0].enabled, false);
  st.setEnabled('proposal-draft', true); assert.strictEqual(st.list()[0].enabled, true);
  assert.ok(st.remove('proposal-draft')); assert.strictEqual(st.list().length, 0);
});
t('보관소: 이름 없음·본문 없음·너무 김은 한국어 오류', () => {
  const st = new SkillStore(tmp());
  assert.throws(() => st.add('---\ndescription: x\n---\n본문', ''), /이름을 알 수 없습니다/);
  assert.throws(() => st.add('---\nname: a\n---\n', ''), /본문이 없습니다/);
  assert.throws(() => st.add('---\nname: a\n---\n' + 'z'.repeat(LIMIT.skill + 1), ''), /너무 깁니다/);
});
t('/이름 판별: 켜진 스킬만, 나머지 글 분리, 없는 이름·꺼진 스킬은 일반 글', () => {
  const st = new SkillStore(tmp()); st.add(SK, 'f');
  const h = matchSkill('/proposal-draft 지원사업 제안서 써줘', st);
  assert.ok(h && h.skill.name === 'proposal-draft' && h.rest === '지원사업 제안서 써줘');
  assert.strictEqual(matchSkill('/PROPOSAL-DRAFT', st).rest, '');
  assert.strictEqual(matchSkill('/nothing 글', st), null); assert.strictEqual(matchSkill('그냥 질문', st), null);
  st.setEnabled('proposal-draft', false); assert.strictEqual(matchSkill('/proposal-draft 글', st), null);
});
t('스킬 문장: 이름·본문 포함, 안전 규칙을 바꿀 수 없다는 안내', () => {
  const p = skillPrompt({ name: 'a', body: '본문입니다' });
  assert.ok(p.includes('"a"') && p.includes('본문입니다') && p.includes('바꿀 수 없습니다'));
});
const bad = results.filter(r => !r[0]);
results.forEach(r => console.log((r[0] ? 'PASS ' : 'FAIL ') + r[1] + (r[2] ? ' — ' + r[2] : '')));
console.log(`customize-tests: ${results.length - bad.length}/${results.length}`);
process.exit(bad.length ? 1 : 0);

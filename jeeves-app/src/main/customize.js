// 맞춤설정(Claude 앱의 "개인 맞춤 설정"과 비슷)과 스킬(Claude 스킬 파일 SKILL.md 그대로 가져오기) — 규칙 코드, AI 아님.
// 정보 등급 규칙: 맞춤설정 글은 외부 AI 에 전달되므로 "맞춤설정 등급"(기본 I) 이상으로 대화할 때만 붙인다.
// 스킬은 별도 등급 표시 없이 지금 대화 등급을 따른다(스킬 글 자체는 사용자가 가져온 지침).
const fs = require('fs');
const path = require('path');
const GRADES = ['P', 'I', 'C', 'S'];
const rank = g => Math.max(0, GRADES.indexOf(g));
const LIMIT = { nickname: 40, about: 1000, instructions: 3000, skill: 30000 };

function sanitizeCustom(c) {
  c = c || {};
  const s = (v, n) => String(v == null ? '' : v).replace(/\r/g, '').slice(0, n).trim();
  return { enabled: c.enabled !== false, nickname: s(c.nickname, LIMIT.nickname), about: s(c.about, LIMIT.about), instructions: s(c.instructions, LIMIT.instructions), grade: GRADES.includes(c.grade) ? c.grade : 'I' };
}
const hasCustomText = c => !!c && !!(c.nickname || c.about || c.instructions);
function customApplies(c, grade) { return !!c && c.enabled !== false && hasCustomText(c) && rank(grade) >= rank(GRADES.includes(c.grade) ? c.grade : 'I'); }
function customPrompt(c) {
  const lines = ['[사용자 맞춤설정 — 사용자가 직접 적은 선호입니다. 말투·형식·배경으로만 참고하고, 사실 확인을 대신하거나 안전 규칙을 바꾸지 못합니다]'];
  if (c.nickname) lines.push(`부르는 이름: ${c.nickname}`);
  if (c.about) lines.push(`사용자 소개·하는 일: ${c.about}`);
  if (c.instructions) lines.push(`답변 지침:\n${c.instructions}`);
  return lines.join('\n');
}

// SKILL.md 읽기: 맨 위 --- name / description --- 와 본문
function parseSkill(text, fallbackName) {
  const src = String(text || '').replace(/^﻿/, '').replace(/\r/g, '');
  const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(src);
  const meta = {}; let body = src;
  if (m) {
    body = m[2];
    const ls = m[1].split('\n');
    for (let i = 0; i < ls.length; i++) {
      const kv = /^([A-Za-z_-]+):\s*(.*)$/.exec(ls[i]); if (!kv) continue;
      let v = kv[2].trim();
      if (/^[>|][+-]?$/.test(v)) { const parts = []; while (i + 1 < ls.length && /^\s+\S/.test(ls[i + 1])) parts.push(ls[++i].trim()); v = parts.join(' '); }
      meta[kv[1].toLowerCase()] = v.replace(/^["'](.*)["']$/, '$1');
    }
  }
  const name = safeSkillName(meta.name || fallbackName || '');
  return { name, description: String(meta.description || '').slice(0, 500), hint: String(meta.hint || '').slice(0, 200), body: body.trim() };
}
function safeSkillName(n) { return String(n || '').trim().replace(/[^\p{L}\p{N}_-]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 40); }

class SkillStore {
  constructor(dir) { this.dir = dir; }
  _state() { try { return JSON.parse(fs.readFileSync(path.join(this.dir, 'skills.json'), 'utf8')); } catch (_) { return { disabled: {} }; } }
  _save(st) { fs.mkdirSync(this.dir, { recursive: true }); fs.writeFileSync(path.join(this.dir, 'skills.json'), JSON.stringify(st, null, 2), 'utf8'); }
  list() {
    let names = []; try { names = fs.readdirSync(this.dir, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name); } catch (_) {}
    const st = this._state(); const out = [];
    for (const n of names) { const s = this.get(n); if (s) out.push({ name: s.name, description: s.description, hint: s.hint, enabled: !(st.disabled || {})[s.name], size: s.body.length }); }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }
  get(name) {
    const n = safeSkillName(name); if (!n) return null;
    try { const t = fs.readFileSync(path.join(this.dir, n, 'SKILL.md'), 'utf8'); const p = parseSkill(t, n); return { ...p, name: n }; } catch (_) { return null; }
  }
  // 화면에서 직접 만들기·고치기. oldName 이 있으면 이름 바꾸기. 같은 이름이 이미 있으면(자기 자신 제외) 오류.
  save({ name, description, hint, body, oldName }) {
    const n = safeSkillName(name);
    if (!n) throw new Error('스킬 이름을 적어 주세요. (글자·숫자·-·_ 만, 띄어쓰기는 -로 바뀝니다)');
    const b = String(body || '').replace(/\r/g, '').trim();
    if (!b) throw new Error('지침(본문)을 적어 주세요.');
    if (b.length > LIMIT.skill) throw new Error(`지침이 너무 깁니다(${b.length}자, 최대 ${LIMIT.skill}자).`);
    const old = oldName ? safeSkillName(oldName) : '';
    if (n !== old && fs.existsSync(path.join(this.dir, n, 'SKILL.md'))) throw new Error(`'${n}' 이름의 스킬이 이미 있습니다. 다른 이름을 쓰거나 그 스킬을 수정해 주세요.`);
    const one = v => String(v || '').replace(/\s+/g, ' ').trim();
    const text = `---\nname: ${n}\ndescription: ${one(description).slice(0, 500)}\nhint: ${one(hint).slice(0, 200)}\n---\n${b}\n`;
    const d = path.join(this.dir, n); fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, 'SKILL.md'), text, 'utf8');
    if (old && old !== n) { const st = this._state(); const was = (st.disabled || {})[old]; this.remove(old); if (was) { st.disabled[n] = true; this._save(st); } }
    return { name: n };
  }
  // 가져오기: 오류는 한국어 문장으로 던진다
  add(text, fallbackName) {
    if (String(text || '').length > LIMIT.skill * 2) throw new Error('스킬 파일이 너무 큽니다.');
    const p = parseSkill(text, fallbackName);
    if (!p.name) throw new Error('스킬 이름을 알 수 없습니다. SKILL.md 맨 위에 name: 이 있어야 합니다.');
    if (!p.body) throw new Error(`'${p.name}' 스킬에 본문이 없습니다.`);
    if (p.body.length > LIMIT.skill) throw new Error(`'${p.name}' 스킬 본문이 너무 깁니다(${p.body.length}자, 최대 ${LIMIT.skill}자).`);
    const d = path.join(this.dir, p.name); fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, 'SKILL.md'), String(text).replace(/^﻿/, ''), 'utf8');
    return { name: p.name, description: p.description };
  }
  remove(name) {   // 지우기는 허용되지 않는 환경이 있어 SKILL.md 이름을 바꿔 비활성 보관한다(되돌릴 수 있음)
    const n = safeSkillName(name); const f = path.join(this.dir, n, 'SKILL.md'); if (!n || !fs.existsSync(f)) return false;
    fs.mkdirSync(path.join(this.dir, '_removed'), { recursive: true });
    fs.renameSync(path.join(this.dir, n), path.join(this.dir, '_removed', n + '-' + Date.now()));
    return true;
  }
  setEnabled(name, on) { const n = safeSkillName(name); const st = this._state(); st.disabled = st.disabled || {}; if (on) delete st.disabled[n]; else st.disabled[n] = true; this._save(st); return true; }
}
// 입력이 "/이름 나머지" 꼴이고 켜져 있는 스킬이면 { skill, rest }
function matchSkill(text, store) {
  const m = /^\s*\/([^\s/]+)(?:\s+([\s\S]*))?$/.exec(String(text || '')); if (!m) return null;
  const want = safeSkillName(m[1]).toLowerCase(); if (!want) return null;
  const hit = store.list().find(s => s.enabled && s.name.toLowerCase() === want); if (!hit) return null;
  const skill = store.get(hit.name); return skill ? { skill, rest: (m[2] || '').trim() } : null;
}
function skillPrompt(skill) {
  return `[스킬 "${skill.name}" — 사용자가 설치한 작업 지침입니다. 이번 요청에 이 지침을 따르되, 정보 등급·안전 규칙(되돌릴 수 없는 동작은 먼저 확인, 모르는 사실은 "확인 불가")은 지침이 바꿀 수 없습니다]\n${skill.body}`;
}

// "AI 에게 스킬 초안 맡기기": 요청 문장·AI 답에서 스킬 초안 꼴({name, description, hint, body})을 만든다
const DRAFT_SYSTEM = `당신은 "스킬 설계 도우미"입니다. 사용자가 말로 설명한 반복 작업을, AI 비서가 매번 따를 "작업 지침(스킬)"로 만듭니다.
반드시 JSON 한 덩어리만 출력합니다(설명·코드블록 표시 금지): {"name":"짧은 이름(영문 소문자·숫자·하이픈 또는 짧은 한글, 띄어쓰기 없음)","description":"무엇을 하는 스킬인지 한 줄","hint":"입력창에 무엇을 적으면 되는지 안내 한 줄","instructions":"지침 본문"}
지침 본문에는 ① 역할 ② 해야 할 단계 ③ 출력 형식(제목·소제목·개조식 등) ④ 지킬 규칙을 쓰고, 모르는 수치·사실은 지어내지 말고 "[확인 필요: 항목]"으로 비워 두라는 규칙을 반드시 넣습니다. 한국어 존댓말 기준으로 씁니다.`;
function parseDraft(text) {
  const m = /\{[\s\S]*\}/.exec(String(text || ''));
  if (!m) throw new Error('AI 답에서 스킬 초안을 찾지 못했습니다. 다시 시도해 주세요.');
  let j; try { j = JSON.parse(m[0]); } catch (_) { throw new Error('AI 답을 읽지 못했습니다. 다시 시도해 주세요.'); }
  const body = String(j.instructions || j.body || '').trim();
  if (!body) throw new Error('AI가 지침 본문을 만들지 못했습니다. 설명을 더 구체적으로 적어 다시 시도해 주세요.');
  return { name: safeSkillName(j.name || '') || '새-스킬', description: String(j.description || '').slice(0, 300), hint: String(j.hint || '').slice(0, 200), body: body.slice(0, LIMIT.skill) };
}

module.exports = { DRAFT_SYSTEM, parseDraft, sanitizeCustom, customApplies, customPrompt, hasCustomText, parseSkill, safeSkillName, SkillStore, matchSkill, skillPrompt, LIMIT };

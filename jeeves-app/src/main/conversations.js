// 대화(Chat) 저장소: 지브스를 껐다 켜도 이전 대화가 남고, 왼쪽 목록에서 다시 열 수 있게 한다.
// - 파일 하나(jeeves-conversations.json)에 프로젝트·대화를 저장한다. 내 PC 안에만 저장하며 암호화하지 않는다(작업 기록과 같은 수준).
// - 사진 원본은 저장하지 않는다(이름만 남김). 글 첨부는 이어지는 질문을 위해 최대 20000자까지 남긴다.
// - 쓰기는 임시 파일에 쓴 뒤 이름을 바꾸는 방식이라 도중에 꺼져도 파일이 깨지지 않는다.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MAX_CONVS = 300, MAX_TURNS = 100;
const newId = () => crypto.randomBytes(6).toString('hex');

class ConversationStore {
  constructor(file, clock) {
    this.file = file;
    this.now = clock || (() => new Date().toISOString());
    this.data = { v: 1, projects: [], convs: {} };
    this.timer = null;
    this.load();
  }

  load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (raw && typeof raw === 'object') this.data = { v: 1, projects: Array.isArray(raw.projects) ? raw.projects : [], convs: raw.convs && typeof raw.convs === 'object' ? raw.convs : {} };
    } catch (e) {
      if (e.code !== 'ENOENT') { try { fs.copyFileSync(this.file, this.file + '.broken'); } catch (_) {} }   // 깨진 파일은 따로 보관하고 새로 시작
    }
  }
  save(immediate) {
    if (!immediate) { clearTimeout(this.timer); this.timer = setTimeout(() => this.save(true), 300); return; }
    clearTimeout(this.timer); this.timer = null;
    try {
      const tmp = this.file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(this.data), 'utf8');
      fs.renameSync(tmp, this.file);
    } catch (_) {}
  }
  flush() { if (this.timer) this.save(true); }

  // ── 목록(왼쪽 영역용: 내용은 빼고 제목·시각만) ──
  list() {
    const convs = Object.values(this.data.convs).map(c => ({ id: c.id, title: c.title, projectId: c.projectId || null, updatedAt: c.updatedAt, grade: c.gradeMax || 'P', turns: c.turns.length }));
    convs.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
    return { projects: this.data.projects.slice(), convs };
  }
  get(id) { return this.data.convs[id] || null; }

  create({ title, projectId, grade }) {
    const id = newId(), t = this.now();
    const pid = this.data.projects.some(p => p.id === projectId) ? projectId : null;
    this.data.convs[id] = { id, title: String(title || '새 대화').slice(0, 60), projectId: pid, createdAt: t, updatedAt: t, gradeMax: grade || 'P', turns: [], history: [] };
    const all = Object.values(this.data.convs);
    if (all.length > MAX_CONVS) {   // 가장 오래 안 쓴 대화부터 정리
      all.sort((a, b) => String(a.updatedAt).localeCompare(String(b.updatedAt)));
      for (const c of all.slice(0, all.length - MAX_CONVS)) delete this.data.convs[c.id];
    }
    this.save();
    return this.data.convs[id];
  }
  // 한 번 주고받은 것(질문 q·답변 a)과 AI 에게 보낼 기록 전체를 저장
  saveTurn(id, turn, history, gradeMax) {
    const c = this.get(id); if (!c) return false;
    c.turns.push(turn);
    if (c.turns.length > MAX_TURNS) c.turns = c.turns.slice(-MAX_TURNS);
    c.history = history.slice(-MAX_TURNS * 2);
    if (gradeMax) c.gradeMax = gradeMax;
    c.updatedAt = this.now();
    this.save();
    return true;
  }
  // 수정·재시도: k 번째(0부터) 질문 앞까지만 남긴다
  truncate(id, k) {
    const c = this.get(id); if (!c) return false;
    k = Math.max(0, parseInt(k, 10) || 0);
    c.turns = c.turns.slice(0, k);
    c.history = c.history.slice(0, k * 2);
    this.save();
    return true;
  }
  rename(id, title) {
    const c = this.get(id); const t = String(title || '').trim().slice(0, 60);
    if (!c || !t) return false;
    c.title = t; this.save(); return true;
  }
  remove(id) { if (!this.data.convs[id]) return false; delete this.data.convs[id]; this.save(); return true; }
  setProject(id, projectId) {
    const c = this.get(id); if (!c) return false;
    c.projectId = this.data.projects.some(p => p.id === projectId) ? projectId : null;
    this.save(); return true;
  }

  // ── 프로젝트 ──
  addProject(name) {
    const n = String(name || '').trim().slice(0, 40);
    if (!n) return null;
    const p = { id: newId(), name: n, createdAt: this.now() };
    this.data.projects.push(p); this.save(); return p;
  }
  renameProject(id, name) {
    const p = this.data.projects.find(x => x.id === id); const n = String(name || '').trim().slice(0, 40);
    if (!p || !n) return false;
    p.name = n; this.save(); return true;
  }
  // 프로젝트를 지워도 안의 대화는 지우지 않고 "프로젝트 없음"으로 돌려보낸다
  removeProject(id) {
    const i = this.data.projects.findIndex(x => x.id === id);
    if (i < 0) return false;
    this.data.projects.splice(i, 1);
    for (const c of Object.values(this.data.convs)) if (c.projectId === id) c.projectId = null;
    this.save(); return true;
  }
}

module.exports = { ConversationStore };

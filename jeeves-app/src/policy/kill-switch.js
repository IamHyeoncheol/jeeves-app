// 비상 정지: 전역 단축키·화면 버튼·MCP 세 경로가 같은 halt() 를 부른다.
// 등록된 정지 함수를 모두 실행(하나가 실패해도 나머지는 계속). 재개는 PC 화면 버튼(source 'ui')만.
const { EventEmitter } = require('events');

class HaltedError extends Error {
  constructor() { super('비상 정지 중입니다. PC 화면에서 재개해야 합니다.'); this.name = 'HaltedError'; }
}

class KillSwitch extends EventEmitter {
  constructor({ now = () => new Date() } = {}) {
    super();
    this.now = now;
    this.fns = new Map();
    this._state = { halted: false, haltedAt: null, source: null, reason: '' };
  }
  register(name, fn) {
    this.fns.set(name, fn);
    return () => { if (this.fns.get(name) === fn) this.fns.delete(name); };
  }
  async halt({ source = 'ui', reason = '' } = {}) {
    this._state = { halted: true, haltedAt: this.now().toISOString(), source, reason: String(reason || '').slice(0, 200) };
    const stopped = [], errors = [];
    for (const [name, fn] of [...this.fns]) {
      try { await fn(reason); stopped.push(name); } catch (e) { errors.push({ name, message: e.message }); }
    }
    const res = { ...this._state, stopped, errors };
    this.emit('halt', res);
    return res;
  }
  resume({ source } = {}) {
    if (source !== 'ui') return false;   // 외부 에이전트·단축키로는 풀 수 없다
    if (!this._state.halted) return true;
    this._state = { halted: false, haltedAt: null, source: null, reason: '' };
    this.emit('resume', this.state());
    return true;
  }
  get halted() { return this._state.halted; }
  state() { return { ...this._state }; }
  assertRunning() { if (this._state.halted) throw new HaltedError(); }
}

module.exports = { KillSwitch, HaltedError };

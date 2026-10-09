#!/usr/bin/env node
// Claude Code 흉내: stream-json 출력. 첫 실행은 한도 도달, --resume 이면 성공.
const args = process.argv.slice(2);
const log = require('fs').appendFileSync;
const out = o => process.stdout.write(JSON.stringify(o) + '\n');
let stdin = '';
process.stdin.on('data', d => stdin += d);
process.stdin.on('end', () => {
  log(process.env.FAKE_LOG, JSON.stringify({ args, stdin }) + '\n');
  if (args.includes('--version')) { console.log('9.9.9 (Claude Code)'); return; }
  const resume = args.includes('--resume');
  out({ type: 'system', subtype: 'init', session_id: 'sess-123', model: 'claude-sonnet-5-5', mcp_servers: [{ name: 'jeeves', status: 'connected' }] });
  out({ type: 'assistant', message: { content: [{ type: 'text', text: resume ? '이어서 진행합니다' : '작업을 시작합니다' }, { type: 'tool_use', id: 't1', name: 'mcp__jeeves__browser_open', input: {} }] } });
  if (process.env.FAKE_MODE === 'login') { out({ type: 'result', subtype: 'success', is_error: true, result: 'Not logged in · Please run /login', session_id: 'sess-123' }); process.exit(1); }
  if (process.env.FAKE_MODE === 'chat') { out({ type: 'result', subtype: 'success', is_error: false, result: '구독으로 답했습니다', session_id: 's', total_cost_usd: 0 }); return; }
  if (process.env.FAKE_MODE === 'limit') { out({ type: 'result', subtype: 'success', is_error: true, result: `Claude AI usage limit reached|${Math.floor(Date.now() / 1000) + 3600}`, session_id: 's' }); process.exit(1); }
  if (!resume) { out({ type: 'result', subtype: 'success', is_error: true, result: `Claude AI usage limit reached|${Math.floor(Date.now() / 1000) + 1}`, session_id: 'sess-123', total_cost_usd: 0.05 }); process.exit(1); }
  out({ type: 'result', subtype: 'success', is_error: false, result: '결론: 완료했습니다.', session_id: 'sess-123', total_cost_usd: 0.12 });
});

#!/usr/bin/env node
// 개발 AI 흉내: Claude Code(stream-json) 또는 Codex(exec) 처럼 동작. 현재 폴더에 파일을 하나 만든다.
const fs = require('fs'), path = require('path');
const args = process.argv.slice(2);
const isClaude = args.includes('--output-format');
const mode = isClaude ? process.env.FAKE_CLAUDE_MODE : process.env.FAKE_CODEX_MODE;
let stdin = '';
process.stdin.on('data', d => stdin += d);
process.stdin.on('end', () => {
  fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify({ who: isClaude ? 'claude' : 'codex', args, stdin, cwd: process.cwd() }) + '\n');
  const out = o => process.stdout.write(JSON.stringify(o) + '\n');
  if (isClaude) {
    out({ type: 'system', subtype: 'init', session_id: 's1', model: 'fake' });
    if (mode === 'limit') { out({ type: 'result', subtype: 'success', is_error: true, result: `Claude AI usage limit reached|${Math.floor(Date.now() / 1000) + 3600}`, session_id: 's1' }); process.exit(1); }
    if (mode === 'login') { out({ type: 'result', subtype: 'success', is_error: true, result: 'Not logged in · Please run /login' }); process.exit(1); }
    if (mode === 'taskfail') { out({ type: 'result', subtype: 'success', is_error: true, result: '요구사항을 이해하지 못했습니다' }); process.exit(1); }
    fs.writeFileSync(path.join(process.cwd(), 'made-by-claude.txt'), 'hi');
    out({ type: 'assistant', message: { content: [{ type: 'text', text: '만드는 중' }, { type: 'tool_use', name: 'Write', input: { file_path: 'made-by-claude.txt' } }] } });
    out({ type: 'result', subtype: 'success', is_error: false, result: '결론: Claude가 완료했습니다.', total_cost_usd: 0.2, permission_denials: [{ tool_name: 'Bash', tool_input: { command: 'rm -rf x' } }] });
    return;
  }
  if (mode === 'fail') { process.stderr.write('Error: something broke\n'); process.exit(1); }
  if (mode === 'limit') { process.stderr.write('Error: rate limit exceeded (429)\n'); process.exit(1); }
  fs.writeFileSync(path.join(process.cwd(), 'made-by-codex.txt'), 'hi');
  process.stderr.write('working...\n');
  process.stdout.write('코덱스가 완료했습니다');
});

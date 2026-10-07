// Windows 자격 증명 관리자에서 'Jeeves:mail:<서비스>' 항목(사용자 이름+비밀번호)을 읽는 부품.
// 보안: 비밀번호는 PowerShell 프로세스의 stdout(JSON 한 줄)으로만 받는다.
//       명령줄 인자·환경변수·파일에 넣지 않으며, 오류 메시지·로그에도 절대 남기지 않는다.
const { spawn: realSpawn } = require('child_process');

const ALLOWED = ['naver', 'kakao', 'gmail'];

// 비밀 없는 고정 스크립트. 대상 이름만 허용 목록에서 골라 끼워 넣는다.
function buildScript(target) {
  return [
    "$ErrorActionPreference = 'Stop'",
    "Add-Type -TypeDefinition @'",
    'using System;',
    'using System.Runtime.InteropServices;',
    'public static class JvCred {',
    '  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]',
    '  public struct CRED {',
    '    public uint Flags; public uint Type; public IntPtr TargetName; public IntPtr Comment;',
    '    public uint LowDate; public uint HighDate; public uint BlobSize; public IntPtr Blob;',
    '    public uint Persist; public uint AttrCount; public IntPtr Attrs; public IntPtr Alias; public IntPtr UserName;',
    '  }',
    '  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]',
    '  public static extern bool CredRead(string target, uint type, uint flags, out IntPtr cred);',
    '  [DllImport("advapi32.dll")] public static extern void CredFree(IntPtr cred);',
    '  public static string[] Read(string target) {',
    '    IntPtr p; if (!CredRead(target, 1, 0, out p)) return null;',
    '    try {',
    '      CRED c = (CRED)Marshal.PtrToStructure(p, typeof(CRED));',
    '      string user = Marshal.PtrToStringUni(c.UserName);',
    '      string pass = c.BlobSize > 0 ? Marshal.PtrToStringUni(c.Blob, (int)(c.BlobSize / 2)) : "";',
    '      return new string[] { user, pass };',
    '    } finally { CredFree(p); }',
    '  }',
    '}',
    "'@",
    "$r = [JvCred]::Read('" + target + "')",
    'if ($null -eq $r) { exit 3 }',
    '$o = [ordered]@{ user = $r[0]; password = $r[1] }',
    '[Console]::Out.WriteLine(($o | ConvertTo-Json -Compress))',
  ].join('\n');
}

function readCredential(service, { spawn = realSpawn, platform = process.platform } = {}) {
  return new Promise((resolve, reject) => {
    if (!ALLOWED.includes(service)) return reject(new Error('지원하지 않는 서비스입니다 (허용: ' + ALLOWED.join(', ') + ')'));
    if (platform !== 'win32') return reject(new Error('Windows 자격 증명 관리자는 Windows에서만 읽을 수 있습니다'));
    const target = 'Jeeves:mail:' + service;
    let child;
    try {
      child = spawn('powershell', ['-NoProfile', '-NonInteractive', '-Command', buildScript(target)], { windowsHide: true });
    } catch (_) { return reject(new Error('PowerShell을 실행하지 못했습니다')); }
    let out = '';
    let done = false;
    const fail = msg => { if (!done) { done = true; reject(new Error(msg)); } };
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', () => { /* 내용은 버린다 (비밀이 섞일 수 있음) */ });
    child.on('error', () => fail('PowerShell을 실행하지 못했습니다'));
    child.on('close', code => {
      if (done) return;
      if (code === 3) return fail('자격 증명 ' + target + ' 가 없습니다. tools\\credential_register.bat 로 먼저 저장하세요');
      if (code !== 0) return fail('자격 증명을 읽지 못했습니다 (종료 코드 ' + code + ')');
      try {
        const j = JSON.parse(out.trim().split(/\r?\n/).pop());
        if (!j || typeof j.user !== 'string' || !j.user || typeof j.password !== 'string') throw new Error('x');
        done = true;
        resolve({ user: j.user, password: j.password });
      } catch (_) { fail('자격 증명 응답을 해석하지 못했습니다'); }
    });
  });
}

module.exports = { readCredential, ALLOWED };

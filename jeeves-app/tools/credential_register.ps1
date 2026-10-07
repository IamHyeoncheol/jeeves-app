# 메일 계정의 앱 비밀번호를 Windows 자격 증명 관리자에 저장한다 (화면에 보이지 않게 입력).
# 이 파일에는 비밀번호가 들어 있지 않다. 저장 이름: Jeeves:mail:<서비스>
# 저장 직후 다시 읽어서 확인한 경우에만 '저장 완료'를 표시한다.
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class JvCredW {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct CRED {
    public uint Flags; public uint Type; public IntPtr TargetName; public IntPtr Comment;
    public uint LowDate; public uint HighDate; public uint BlobSize; public IntPtr Blob;
    public uint Persist; public uint AttrCount; public IntPtr Attrs; public IntPtr Alias; public IntPtr UserName;
  }
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern bool CredWrite(ref CRED cred, uint flags);
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern bool CredRead(string target, uint type, uint flags, out IntPtr cred);
  [DllImport("advapi32.dll")] static extern void CredFree(IntPtr cred);
  public static int Write(string target, string user, string pass) {
    byte[] b = Encoding.Unicode.GetBytes(pass);
    IntPtr blob = Marshal.AllocHGlobal(b.Length);
    IntPtr t = Marshal.StringToCoTaskMemUni(target);
    IntPtr u = Marshal.StringToCoTaskMemUni(user);
    try {
      Marshal.Copy(b, 0, blob, b.Length);
      CRED c = new CRED();
      c.Type = 1; c.TargetName = t; c.UserName = u; c.BlobSize = (uint)b.Length; c.Blob = blob; c.Persist = 2;
      bool ok = CredWrite(ref c, 0);
      return ok ? 0 : Marshal.GetLastWin32Error();
    } finally {
      for (int i = 0; i < b.Length; i++) b[i] = 0;
      Marshal.Copy(b, 0, blob, b.Length);
      Marshal.FreeHGlobal(blob); Marshal.FreeCoTaskMem(t); Marshal.FreeCoTaskMem(u);
    }
  }
  // 저장된 항목의 비밀번호 글자 수만 돌려준다 (-1 = 없음). 비밀번호 자체는 돌려주지 않는다.
  public static int ReadLength(string target, out string user) {
    user = null; IntPtr p;
    if (!CredRead(target, 1, 0, out p)) return -1;
    try {
      CRED c = (CRED)Marshal.PtrToStructure(p, typeof(CRED));
      user = Marshal.PtrToStringUni(c.UserName);
      return (int)(c.BlobSize / 2);
    } finally { CredFree(p); }
  }
}
'@
$svc = (Read-Host '서비스 (naver / kakao / gmail)').Trim().ToLower()
if ($svc -notin @('naver','kakao','gmail')) { Write-Host '서비스 이름이 올바르지 않습니다. 저장하지 않았습니다.'; exit 1 }
$id = (Read-Host '메일 주소 전체 (예: abc@naver.com)').Trim()
if ($id -notmatch '^[^@\s,]+@[^@\s,]+$') { Write-Host '메일 주소 형식이 올바르지 않습니다 (한 칸에는 한 가지만 입력). 저장하지 않았습니다.'; exit 1 }
$sec = Read-Host '앱 비밀번호 (입력해도 화면에 안 보입니다)' -AsSecureString
$bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec)
$len = 0
try {
  $plain = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
  $len = $plain.Length
  if ($len -lt 8) { Write-Host '비밀번호가 너무 짧습니다. 저장하지 않았습니다.'; exit 1 }
  $target = "Jeeves:mail:$svc"
  $err = [JvCredW]::Write($target, $id, $plain)
} finally {
  [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
  $plain = $null
}
if ($err -ne 0) { Write-Host "저장에 실패했습니다 (Windows 오류 코드 $err)."; exit 1 }
$u2 = $null
$n = [JvCredW]::ReadLength($target, [ref]$u2)
if ($n -ne $len -or $u2 -ne $id) { Write-Host '저장 후 다시 읽어 보니 확인되지 않았습니다. 저장 실패로 봅니다.'; exit 1 }
Write-Host "저장 확인 완료: $target (계정 $u2, 비밀번호 $n 글자)"
Write-Host '이제 iron_account.txt 등에 적어 둔 비밀번호는 지우세요.'

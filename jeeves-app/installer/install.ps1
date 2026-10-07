# Doran 테스트 버전 설치 스크립트 (조각 합치기 → 압축 풀기 → 바로가기 만들기)
$ErrorActionPreference = 'Stop'
$src = $PSScriptRoot
$expected = '04227DAF92D75B42A3BAEC206030E50E4F5906A2D51318B1AE563C1645D3EA2D'
$dest = Join-Path $env:LOCALAPPDATA 'Programs'
$appDir = Join-Path $dest 'Doran'
$zip = Join-Path $env:TEMP 'Doran-0.1.0-win-x64.zip'

Write-Host ''
Write-Host '=== Doran 테스트 버전 0.1 설치 ===' -ForegroundColor Green
if (Get-Process -Name 'Doran' -ErrorAction SilentlyContinue) {
  Write-Host 'Doran 이 실행 중입니다. 창을 닫은 뒤 다시 실행해 주세요.' -ForegroundColor Yellow
  exit 1
}

Write-Host '1/4 조각 파일 합치는 중...'
$parts = Get-ChildItem -Path $src -Filter 'Doran-0.1.0-win-x64.zip.part*' | Sort-Object { [int]($_.Name -replace '.*\.part', '') }
if ($parts.Count -ne 6) { Write-Host "조각 파일이 6개여야 하는데 $($parts.Count)개입니다. 폴더를 확인해 주세요." -ForegroundColor Red; exit 1 }
$out = [System.IO.File]::Create($zip)
try { foreach ($p in $parts) { $in = [System.IO.File]::OpenRead($p.FullName); try { $in.CopyTo($out) } finally { $in.Close() } } } finally { $out.Close() }

Write-Host '2/4 파일 손상 여부 확인 중...'
$hash = (Get-FileHash -Path $zip -Algorithm SHA256).Hash
if ($hash -ne $expected) { Write-Host '파일이 손상되었습니다. 조각 파일을 다시 받아 주세요.' -ForegroundColor Red; Remove-Item $zip; exit 1 }

Write-Host "3/4 설치 중... ($appDir)"
if (Test-Path $appDir) {
  # 설정·로그인·기록은 %APPDATA%\Doran 에 있으므로 프로그램 폴더만 교체해도 안전
  Remove-Item -Recurse -Force $appDir
}
New-Item -ItemType Directory -Force -Path $dest | Out-Null
Add-Type -AssemblyName System.IO.Compression.FileSystem
try {
  [System.IO.Compression.ZipFile]::ExtractToDirectory($zip, $dest, [System.Text.Encoding]::UTF8)
} catch {
  Write-Host '  다른 방식으로 다시 풀어 보는 중...' -ForegroundColor Yellow
  if (Test-Path $appDir) { Remove-Item -Recurse -Force $appDir }
  Expand-Archive -Path $zip -DestinationPath $dest -Force
}
if (-not (Test-Path (Join-Path $appDir 'Doran.exe'))) { Write-Host '설치 실패: Doran.exe 를 찾을 수 없습니다.' -ForegroundColor Red; exit 1 }
Remove-Item $zip

Write-Host '4/4 바탕 화면·시작 메뉴 바로가기 만드는 중...'
$exe = Join-Path $appDir 'Doran.exe'
$shell = New-Object -ComObject WScript.Shell
foreach ($dir in @([Environment]::GetFolderPath('Desktop'), (Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs'))) {
  $lnk = $shell.CreateShortcut((Join-Path $dir 'Doran.lnk'))
  $lnk.TargetPath = $exe
  $lnk.WorkingDirectory = $appDir
  $lnk.Description = 'Doran AI 브라우저 (테스트 버전)'
  $lnk.Save()
}

Write-Host ''
Write-Host '설치 완료! 바탕 화면의 Doran 아이콘으로 실행하세요.' -ForegroundColor Green
Write-Host "사용설명서: $appDir\사용설명서.txt"
# Windows 탐색기를 통해 실행해야 이 창을 닫아도 Doran 이 함께 꺼지지 않는다
Start-Process explorer.exe -ArgumentList ('"' + $exe + '"')
Write-Host '이 창은 닫아도 됩니다. (Doran 은 계속 실행됩니다)'

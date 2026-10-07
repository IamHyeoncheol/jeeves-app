# Doran 0.3.2 업데이트: 설치된 Doran 의 프로그램 코드(app.asar)만 교체합니다.
$ErrorActionPreference = 'Stop'
$src = $PSScriptRoot
$expected = '6BB816CA32319F636889368E105FD676B68CD67CEBD2056943B0B2103ADFA338'
$appDir = Join-Path $env:LOCALAPPDATA 'Programs\Doran'
$target = Join-Path $appDir 'resources\app.asar'

Write-Host ''
Write-Host '=== Doran 0.3.2 업데이트 ===' -ForegroundColor Green
if (-not (Test-Path $target)) { Write-Host 'Doran 이 설치되어 있지 않습니다. 먼저 0.1 설치하기.bat 을 실행해 주세요.' -ForegroundColor Red; exit 1 }
while (Get-Process -Name 'Doran' -ErrorAction SilentlyContinue) {
  Write-Host 'Doran 이 실행 중입니다. Doran 창을 모두 닫은 뒤 Enter 를 누르세요.' -ForegroundColor Yellow
  [void](Read-Host)
}
$new = Join-Path $src 'app.asar'
if ((Get-FileHash -Path $new -Algorithm SHA256).Hash -ne $expected) { Write-Host '업데이트 파일이 손상되었습니다. 다시 받아 주세요.' -ForegroundColor Red; exit 1 }

Write-Host '1/2 이전 버전 백업 중...'
Copy-Item $target (Join-Path $appDir 'resources\app.asar.before-0.3.2.bak') -Force
Write-Host '2/2 새 버전 설치 중...'
Copy-Item $new $target -Force
Copy-Item (Join-Path $src '사용설명서.txt') (Join-Path $appDir '사용설명서.txt') -Force
if ((Get-FileHash -Path $target -Algorithm SHA256).Hash -ne $expected) { Write-Host '설치 확인 실패. 백업 파일로 되돌리세요.' -ForegroundColor Red; exit 1 }

Write-Host ''
Write-Host '업데이트 완료! (설정·API 키·로그인 정보는 그대로 유지됩니다)' -ForegroundColor Green
Write-Host '되돌리려면: resources 폴더의 app.asar.before-0.3.2.bak 을 app.asar 로 이름을 바꾸세요.'
# Windows 탐색기를 통해 실행해야 이 창을 닫아도 Doran 이 함께 꺼지지 않는다
Start-Process explorer.exe -ArgumentList ('"' + (Join-Path $appDir 'Doran.exe') + '"')
Write-Host '이 창은 닫아도 됩니다. (Doran 은 계속 실행됩니다)'

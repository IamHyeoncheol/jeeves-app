# 설치·업데이트 스크립트

- `install.ps1` + `설치하기.bat`: 첫 설치용. 28MB 조각(Doran-x.y.z-win-x64.zip.partN)을 합쳐 SHA256 확인 후 `%LOCALAPPDATA%\Programs\Doran` 에 설치, 바로가기 생성, 탐색기로 실행.
  - 새로 만들 때 `$expected`(전체 zip 해시)와 조각 개수(현재 6) 확인.
- `update.ps1` + `업데이트하기.bat`: app.asar 만 교체. `$expected` 를 새 app.asar 의 SHA256(대문자)으로, 버전 문자열·백업 이름을 바꿔 사용.
- .ps1 은 UTF-8(BOM)+CRLF, .bat 은 ASCII 로 저장 (한글 깨짐 방지).

@echo off
chcp 65001 >nul
cd /d "%~dp0jeeves-app"
echo [1/5] npm install
call npm install --no-audit --no-fund
echo [2/5] unit tests
call node tests\run-tests.js
echo [2b] mail tests
call node tests\mail-tests.js
echo [3/5] e2e-driver
call npx electron tests\e2e-driver.js
echo [4/5] e2e-mcp
call npx electron tests\e2e-mcp.js
echo [5/5] e2e-app
call npx electron tests\e2e-app.js
echo.
echo Done. Send a screenshot of this window to Claude.
pause

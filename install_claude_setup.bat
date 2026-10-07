@echo off
chcp 65001 >nul
cd /d "%~dp0"
if not exist ".claude\agents" mkdir ".claude\agents"
copy /Y "_claude_setup\settings.json" ".claude\settings.json" >nul
copy /Y "_claude_setup\agents\*.md" ".claude\agents\" >nul
echo.
echo [OK] Jeeves model routing installed: .claude\settings.json + 6 agents
dir /b ".claude\agents"
echo.
pause

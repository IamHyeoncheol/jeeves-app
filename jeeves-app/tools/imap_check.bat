@echo off
chcp 65001 >nul
node "%~dp0imap_check.js" %*
pause

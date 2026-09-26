@echo off
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo This launcher needs Node.js 20.11 or newer.
  echo You can still open prototype.html and production.html to explore them.
  pause
  exit /b 1
)
node server.mjs
pause

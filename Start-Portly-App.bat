@echo off
setlocal
cd /d "%~dp0"
echo Launching Portly Desktop App...
node desktop-app.js
if errorlevel 1 (
  echo.
  echo Portly exited with an error. Press any key to close...
  pause >nul
)

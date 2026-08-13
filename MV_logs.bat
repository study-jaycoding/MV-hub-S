@echo off
REM Live server log viewer - the auto-started server has no console window,
REM so this replaces it. Double-click to follow the log (Ctrl+C to quit).
setlocal
set "ROOT=%~dp0"
if not exist "%ROOT%logs\server_console.log" (
  echo No log yet: %ROOT%logs\server_console.log
  echo Run register_autostart.bat first, or wait for the server to start.
  pause
  exit /b 1
)
powershell -NoProfile -Command "Get-Content -Path '%ROOT%logs\server_console.log' -Tail 50 -Wait"

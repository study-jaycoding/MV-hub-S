@echo off
chcp 65001 >nul
setlocal

REM Build a zip package and latest.json for server distribution.
REM Usage:
REM   make_release.bat
REM   make_release.bat 2026.06.25-1530

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0make_release.ps1" %*
if errorlevel 1 (
  echo.
  echo [ERROR] Release build failed.
  pause
  exit /b 1
)

echo.
echo [done] Release package is ready.
pause
exit /b 0

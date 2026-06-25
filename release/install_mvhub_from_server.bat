@echo off
chcp 65001 >nul
setlocal
REM ============================================================================
REM  MV Hub - install / update on a worker PC from the company release folder.
REM
REM  This installs or updates ONLY (it does not launch the agent). It pulls the
REM  installer logic and the latest package from your release folder, verifies
REM  the download (SHA256), and installs to %USERPROFILE%\Desktop\MV-hub-S.
REM  The worker's local data (backend\data) is never touched.
REM
REM  EDIT THIS to your release folder, then double-click. A UNC share like
REM  \\SERVER\MVHub\packages or an http URL like http://192.168.1.199:8010/packages
REM  both work.
REM ============================================================================
set "BASE_URL=\\YOUR-SERVER\MVHub\packages"

set "PS1=%TEMP%\mvhub_bootstrap_%RANDOM%.ps1"
set "IS_HTTP="
echo %BASE_URL%| findstr /b /i "http" >nul && set "IS_HTTP=1"
if defined IS_HTTP (
  curl -fsSL -o "%PS1%" "%BASE_URL%/MV_agent_bootstrap.ps1" || goto :fail
) else (
  copy /y "%BASE_URL%\MV_agent_bootstrap.ps1" "%PS1%" >nul || goto :fail
)

powershell -NoProfile -ExecutionPolicy Bypass -File "%PS1%" -BaseUrl "%BASE_URL%" -NoLaunch
set "RC=%errorlevel%"
del "%PS1%" >nul 2>nul
if not "%RC%"=="0" goto :fail

echo.
echo [done] MV Hub is installed/updated.
pause
exit /b 0

:fail
echo.
echo [ERROR] Install/update failed. Check that BASE_URL points at the release
echo         folder that holds latest.json and MV_agent_bootstrap.ps1.
del "%PS1%" >nul 2>nul
pause
exit /b 1

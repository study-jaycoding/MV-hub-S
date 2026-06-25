@echo off
chcp 65001 >nul
setlocal
REM ============================================================================
REM  MV Hub - one-file worker bootstrap: install/update from the company release
REM  folder, THEN launch the installed MV_agent. Give a worker ONLY this file.
REM
REM  It downloads the installer logic + the latest package from your release
REM  folder, verifies the download (SHA256), installs to
REM  %USERPROFILE%\Desktop\MV-hub-S (preserving the worker's backend\data), and
REM  starts MV_agent.
REM
REM  EDIT THIS to your release folder, then give the file to the worker. A UNC
REM  share like \\SERVER\MVHub\packages or an http URL both work.
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

powershell -NoProfile -ExecutionPolicy Bypass -File "%PS1%" -BaseUrl "%BASE_URL%"
set "RC=%errorlevel%"
del "%PS1%" >nul 2>nul
if not "%RC%"=="0" goto :fail
exit /b 0

:fail
echo.
echo [ERROR] Bootstrap failed. Check that BASE_URL points at the release folder
echo         that holds latest.json and MV_agent_bootstrap.ps1.
del "%PS1%" >nul 2>nul
pause
exit /b 1

@echo off
chcp 65001 >nul
REM ============================================================================
REM  MV Hub - SHARED SERVER launcher  [auto-restart]
REM
REM  Role: the team's single "shared DB". Each worker runs MV_agent (local hub)
REM  on their own PC and publishes only selected items to here. This server
REM  collects the published items (Higgsfield public URLs) for the team to view.
REM
REM  Note: Assets (local-folder browsing) and reveal do NOT work on this server
REM        (it reads the server disk). Those run on each worker's MV_agent.
REM
REM  Auto-restart: the Python supervisor relaunches ordinary crashes with backoff.
REM                Repeated quick failures stop and let Task Scheduler retry later.
REM  Stop: press Ctrl+C in this window, then answer Y.
REM
REM  Access: same PC       http://127.0.0.1:%PORT%
REM          same network   http://<this-PC-IP>:%PORT%   (find IP via ipconfig)
REM ============================================================================
setlocal
set "ROOT=%~dp0"
if "%HOST%"=="" set "HOST=0.0.0.0"
if "%PORT%"=="" set "PORT=8010"
REM Shared server: login required (each member signs in / publishes). Set 0 to disable.
if "%CONTENT_HUB_AUTH%"=="" set "CONTENT_HUB_AUTH=1"
REM Enable the PM / manage dashboard (board icon in the top bar). Set 0 to disable.
if "%CONTENT_HUB_MANAGE%"=="" set "CONTENT_HUB_MANAGE=1"
REM Shared server ingests via push agents only - it has no CLI login of its own, so
REM periodic CLI sync would just fail every cycle (CLIError noise). Set 1 to re-enable.
if "%CONTENT_HUB_SERVER_SYNC%"=="" set "CONTENT_HUB_SERVER_SYNC=0"

if "%PYEXE%"=="" (
  if exist "%ROOT%runtime\python\python.exe" set "PYEXE=%ROOT%runtime\python\python.exe"
)
if "%PYEXE%"=="" (
  for /f "delims=" %%p in ('dir /b /s "%ROOT%release\_staging\MVHub-*\runtime\python\python.exe" 2^>nul') do set "PYEXE=%%p"
)
if "%PYEXE%"=="" (
  for /f "delims=" %%p in ('where python 2^>nul') do (
    echo %%p | findstr /i "\\WindowsApps\\python.exe" >nul || if not defined PYEXE set "PYEXE=%%p"
  )
)
if "%PYEXE%"=="" (
  echo [ERROR] Python not found - install from python.org and retry.
  goto :fail
)
echo.
echo [python] %PYEXE%
echo [1/2] Checking frontend build ^(dist^)...
cd /d "%ROOT%frontend" || goto :err
REM update_git.bat owns dependency sync/build. A boot must not depend on the npm
REM registry or mutate package-lock.json. Only repair a genuinely missing dist.
if exist "%ROOT%frontend\dist\index.html" (
  echo     existing build found - skip install/build.
) else (
  where npm.cmd >nul 2>nul || (echo [ERROR] Frontend build is missing and Node.js/npm is unavailable. & goto :fail)
  echo     build missing - restoring exact locked packages once ^(npm ci^)...
  call npm ci --include=dev --no-audit --no-fund || goto :err
  call npm run build || goto :err
)

cd /d "%ROOT%backend" || goto :err
set "CONTENT_HUB_HOST=%HOST%"
set "CONTENT_HUB_PORT=%PORT%"
echo.
echo [2/2] Starting SHARED server ^(auto-restart^)  http://%HOST%:%PORT%
echo     same PC: http://127.0.0.1:%PORT%    Login required = %CONTENT_HUB_AUTH%  ^(1=yes^)
echo     Stop: Ctrl+C then Y
echo.

REM Do NOT use --reload (breaks the CLI subprocess). serve.py = IPv4/IPv6 dual-stack.
"%PYEXE%" "%ROOT%tools\server_supervisor.py"
if errorlevel 1 goto :err
exit /b 0

:err
echo.
echo [ERROR] a step above failed - aborting.
:fail
REM Under the scheduled task (CONTENT_HUB_TASK=1) there is no console user:
REM "pause" would hang the hidden window forever and Task Scheduler could never
REM retry. Exit nonzero instead -> the task's RestartCount retries in 5 min
REM (covers boot-time transients such as a temporarily unavailable data drive).
if not "%CONTENT_HUB_TASK%"=="1" pause
exit /b 1

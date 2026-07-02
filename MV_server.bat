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
REM  Auto-restart: if the server process dies or drops, it relaunches itself.
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
  pause
  exit /b 1
)
where npm    >nul 2>nul || (echo [ERROR] Node.js/npm not found - install from nodejs.org and retry. & pause & exit /b 1)

echo.
echo [python] %PYEXE%
echo [1/2] Building frontend (dist)...
cd /d "%ROOT%frontend" || goto :err
if not exist node_modules (
  echo     node_modules missing - running npm install ^(first time, a few minutes^)
  call npm install || goto :err
)
call npm run build || goto :err

cd /d "%ROOT%backend" || goto :err
set "CONTENT_HUB_HOST=%HOST%"
set "CONTENT_HUB_PORT=%PORT%"
echo.
echo [2/2] Starting SHARED server ^(auto-restart^)  http://%HOST%:%PORT%
echo     same PC: http://127.0.0.1:%PORT%    Login required = %CONTENT_HUB_AUTH%  ^(1=yes^)
echo     Stop: Ctrl+C then Y
echo.

:serverloop
REM Do NOT use --reload (breaks the CLI subprocess). serve.py = IPv4/IPv6 dual-stack.
"%PYEXE%" serve.py
echo.
echo [restart] server exited ^(code %errorlevel%^) - relaunching in 3s... ^(full stop: Ctrl+C^)
timeout /t 3 /nobreak >nul
goto :serverloop

:err
echo.
echo [ERROR] a step above failed - aborting.
pause
exit /b 1

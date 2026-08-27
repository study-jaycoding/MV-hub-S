@echo off
chcp 65001 >nul
setlocal EnableExtensions
REM ============================================================================
REM  MV Hub - ONE-CLICK LOCAL DEV   run on YOUR OWN PC
REM
REM  One double-click starts all local development processes:
REM    - isolated test backend + generation agent: 127.0.0.1:8012
REM    - Vite live frontend:                       this PC:5173 (localhost + LAN IP; override: set FRONTEND_PORT=3173)
REM    - browser:                                  Vite URL above
REM    - login:                                    copied real account
REM
REM  Frontend .tsx/.css edits update immediately. Backend .py edits require this
REM  launcher to be restarted (uvicorn --reload is intentionally not used because
REM  it breaks the generation CLI subprocess).
REM
REM  Data is isolated in backend\data_test and never proxied to the team server.
REM  WARNING: generation still creates REAL Higgsfield jobs and spends REAL credits.
REM
REM  Stop: close this window. Backend/Vite/agent stop; the browser stays open.
REM ============================================================================
set "ROOT=%~dp0"
REM Vite port. Set FRONTEND_PORT before running if 5173 is reserved on this PC
REM (check: netsh interface ipv4 show excludedportrange protocol=tcp).
if not defined FRONTEND_PORT set "FRONTEND_PORT=5173"
set "BACKEND_PORT=8012"
set "FRONTEND_URL=http://127.0.0.1:%FRONTEND_PORT%"
set "BACKEND=http://127.0.0.1:8012"

REM Isolated backend settings. MV_agent.bat performs the Python/CLI checks, starts
REM the backend first, waits for health, then starts the Vite frontend and opens it.
set "PORT=%BACKEND_PORT%"
set "CONTENT_HUB_DATA=%ROOT%backend\data_test"
set "CONTENT_HUB_DB=%ROOT%backend\data_test\db\content_hub.db"
set "CONTENT_HUB_AUTH=1"
set "CONTENT_HUB_NO_PROXY=1"
set "CONTENT_HUB_SERVER_SYNC=0"
set "MVHUB_OPEN_URL=%FRONTEND_URL%"
set "MVHUB_DEV_FRONTEND_DIR=%ROOT%frontend"
set "MVHUB_DEV_FRONTEND_PORT=%FRONTEND_PORT%"
set "MVHUB_DEV_FRONTEND_HOST=0.0.0.0"

REM One-launch, memory-only pairing key. The browser login selects the account; the local
REM agent exchanges this key for that session, so CMD never asks for email or hub password.
for /f "delims=" %%s in ('powershell -NoProfile -Command "[guid]::NewGuid().ToString('N')"') do set "CONTENT_HUB_LOCAL_AGENT_PAIR_SECRET=%%s"
if "%CONTENT_HUB_LOCAL_AGENT_PAIR_SECRET%"=="" (
  echo [ERROR] Could not create the local browser-agent pairing key.
  pause
  exit /b 1
)

where npm.cmd >nul 2>nul || (echo [ERROR] Node.js/npm not found - install from nodejs.org. & pause & exit /b 1)

cd /d "%ROOT%frontend" || (echo [ERROR] frontend folder not found. & pause & exit /b 1)
call npm.cmd ls --depth=0 >nul 2>nul
if errorlevel 1 (
  echo [setup] installing frontend packages ^(first time, a few minutes^)...
  call npm.cmd install || (echo [ERROR] npm install failed. & pause & exit /b 1)
)

REM Replace only a previous dev session launched from THIS project root. The helper
REM validates the full process ancestry before stopping anything; unrelated programs
REM using either port are left untouched and still fail the safety checks below.
set "DEV_RESTART_HELPER=%ROOT%tools\replace_dev_session.ps1"
if not exist "%DEV_RESTART_HELPER%" (
  echo [ERROR] Dev restart helper is missing: %DEV_RESTART_HELPER%
  pause
  exit /b 1
)
powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "%DEV_RESTART_HELPER%" -Root "%ROOT%." -FrontendPort %FRONTEND_PORT% -BackendPort %BACKEND_PORT%
if errorlevel 1 (
  echo.
  echo [ERROR] Could not safely replace the previous dev session.
  pause
  exit /b 1
)

set "PORT_PID="
for /f "tokens=5" %%p in ('netstat -ano ^| findstr "LISTENING" ^| findstr /c:":%FRONTEND_PORT% "') do set "PORT_PID=%%p"
if defined PORT_PID (
  echo.
  echo [ERROR] Vite port %FRONTEND_PORT% is already in use ^(pid %PORT_PID%^).
  echo         Close the previous dev window, then double-click this file again.
  pause
  exit /b 1
)

set "PORT_PID="
for /f "tokens=5" %%p in ('netstat -ano ^| findstr "LISTENING" ^| findstr /c:":%BACKEND_PORT% "') do set "PORT_PID=%%p"
if defined PORT_PID (
  echo.
  echo [ERROR] Test backend port %BACKEND_PORT% is already in use ^(pid %PORT_PID%^).
  echo         Close the previous backend/agent or dev window, then run this file again.
  echo         This prevents two generation agents from running at the same time.
  pause
  exit /b 1
)

echo.
echo [DEV ONE-CLICK] frontend = %FRONTEND_URL%    api/data = %BACKEND%
echo   Edit .tsx/.css and save -^> the page updates instantly.
echo   Backend (.py) changes -^> restart this file.
echo   Generation is isolated from the team DB but spends REAL Higgsfield credits.
echo   Log in only in the browser. The local agent follows that browser account automatically.
echo.

REM MV_agent owns the complete lifecycle. In test mode it starts 8012, waits for
REM /api/health, starts 5173, then opens the browser. Closing this window stops
REM the local services only; the browser remains open and shows they are offline.
cd /d "%ROOT%" || (echo [ERROR] Project folder not found. & pause & exit /b 1)
call "%ROOT%MV_agent.bat"
exit /b %ERRORLEVEL%

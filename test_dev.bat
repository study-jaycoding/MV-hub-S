@echo off
chcp 65001 >nul
setlocal EnableExtensions
REM ============================================================================
REM  MV Hub - ONE-CLICK LOCAL DEV   run on YOUR OWN PC
REM
REM  One double-click starts all local development processes:
REM    - isolated test backend + generation agent: 127.0.0.1:8012
REM    - Vite live frontend:                       127.0.0.1:5173
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
REM  Stop: close this window. A normal agent exit also stops the Vite child process.
REM ============================================================================
set "ROOT=%~dp0"
set "FRONTEND_PORT=5173"
set "BACKEND_PORT=8012"
set "FRONTEND_URL=http://127.0.0.1:%FRONTEND_PORT%"
set "BACKEND=http://127.0.0.1:8012"
set "VITE_PID="

REM Isolated backend settings. MV_agent.bat performs the Python/CLI checks, starts
REM the backend, opens MVHUB_OPEN_URL and keeps agent_push.py in the foreground.
set "PORT=%BACKEND_PORT%"
set "CONTENT_HUB_DATA=%ROOT%backend\data_test"
set "CONTENT_HUB_DB=%ROOT%backend\data_test\db\content_hub.db"
set "CONTENT_HUB_AUTH=1"
set "CONTENT_HUB_NO_PROXY=1"
set "CONTENT_HUB_SERVER_SYNC=0"
set "MVHUB_OPEN_URL=%FRONTEND_URL%"

where npm.cmd >nul 2>nul || (echo [ERROR] Node.js/npm not found - install from nodejs.org. & pause & exit /b 1)

cd /d "%ROOT%frontend" || (echo [ERROR] frontend folder not found. & pause & exit /b 1)
call npm.cmd ls --depth=0 >nul 2>nul
if errorlevel 1 (
  echo [setup] installing frontend packages ^(first time, a few minutes^)...
  call npm.cmd install || (echo [ERROR] npm install failed. & pause & exit /b 1)
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

if "%MVHUB_AGENT_EMAIL%"=="" set /p "MVHUB_AGENT_EMAIL=Test login email: "
if "%MVHUB_AGENT_EMAIL%"=="" (
  echo [ERROR] Login email is required so My Work can be scoped to your account.
  pause
  exit /b 1
)

echo.
echo [DEV ONE-CLICK] frontend = %FRONTEND_URL%    api/data = %BACKEND%
echo   Login account: %MVHUB_AGENT_EMAIL%
echo   Edit .tsx/.css and save -^> the page updates instantly.
echo   Backend (.py) changes -^> restart this file.
echo   Generation is isolated from the team DB but spends REAL Higgsfield credits.
echo   Use the SAME account in the browser and at the agent password prompt.
echo.

REM Keep Vite attached to this console so closing the one launcher window stops it.
REM MV_agent waits for the backend and opens FRONTEND_URL later, avoiding two tabs.
start "" /b cmd /d /c "npm.cmd run dev -- --host 127.0.0.1 --strictPort"

echo [wait] Starting Vite on %FRONTEND_URL% ...
set /a VITE_TRIES=0
:wait_vite
set /a VITE_TRIES+=1
curl -fsS -o nul "%FRONTEND_URL%" 2>nul && goto :vite_ready
if %VITE_TRIES% geq 30 goto :vite_error
timeout /t 1 /nobreak >nul
goto :wait_vite

:vite_ready
for /f "tokens=5" %%p in ('netstat -ano ^| findstr "LISTENING" ^| findstr /c:":%FRONTEND_PORT% "') do if not defined VITE_PID set "VITE_PID=%%p"
cd /d "%ROOT%" || goto :vite_error
call "%ROOT%MV_agent.bat"
set "DEV_EXIT=%ERRORLEVEL%"
call :stop_vite
exit /b %DEV_EXIT%

:vite_error
echo.
echo [ERROR] Vite did not start on %FRONTEND_URL%.
call :stop_vite
pause
exit /b 1

:stop_vite
if defined VITE_PID taskkill /f /t /pid %VITE_PID% >nul 2>nul
exit /b 0

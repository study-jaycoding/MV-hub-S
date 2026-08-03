@echo off
chcp 65001 >nul
setlocal EnableExtensions
REM ============================================================================
REM  MV Hub - PREDEPLOY LOCAL TEST
REM
REM  Double-click this file only. It starts the final predeploy candidate with:
REM    - local-only address: 127.0.0.1:8011
REM    - isolated data: this folder\backend\data
REM    - login + manage dashboard enabled
REM    - shared-server proxy and background server sync disabled
REM
REM  Login: admin@millionvolt.com / LocalTest2026!
REM  Stop : Ctrl+C in this window
REM ============================================================================

set "ROOT=%~dp0"
set "HOST=127.0.0.1"
set "PORT=8011"
set "TEST_URL=http://127.0.0.1:%PORT%"

set "CONTENT_HUB_DATA=%ROOT%backend\data"
set "CONTENT_HUB_DB=%ROOT%backend\data\db\content_hub.db"
set "CONTENT_HUB_HOST=%HOST%"
set "CONTENT_HUB_PORT=%PORT%"
set "CONTENT_HUB_AUTH=1"
set "CONTENT_HUB_AUTH_SECRET=predeploy-local-test-only"
set "CONTENT_HUB_ADMIN_EMAIL=admin@millionvolt.com"
set "CONTENT_HUB_ADMIN_PASSWORD=LocalTest2026!"
set "CONTENT_HUB_MANAGE=1"
set "CONTENT_HUB_NO_PROXY=1"
set "CONTENT_HUB_SERVER_SYNC=0"
set "CONTENT_HUB_BACKUP_INTERVAL=0"
set "CONTENT_HUB_METRICS_LOG_INTERVAL=60"

set "PORT_PID="
for /f "tokens=5" %%p in ('netstat -ano ^| findstr "LISTENING" ^| findstr ":%PORT%"') do set "PORT_PID=%%p"
if defined PORT_PID (
  echo.
  echo [ERROR] Port %PORT% is already in use ^(pid %PORT_PID%^).
  echo         Close that test server and double-click this file again.
  pause
  exit /b 1
)

set "PYEXE="
for /f "delims=" %%p in ('where python 2^>nul') do (
  echo %%p | findstr /i "\\WindowsApps\\python.exe" >nul || if not defined PYEXE set "PYEXE=%%p"
)
if not defined PYEXE (
  echo.
  echo [ERROR] Python not found.
  pause
  exit /b 1
)

"%PYEXE%" -c "import fastapi, uvicorn, pydantic, websockets, PIL, watchdog" >nul 2>nul
if errorlevel 1 (
  echo [setup] Installing pinned backend packages...
  "%PYEXE%" -m pip install -r "%ROOT%backend\requirements.txt" || goto :error
)

if not exist "%ROOT%frontend\dist\index.html" (
  where npm.cmd >nul 2>nul || (
    echo [ERROR] frontend\dist is missing and Node.js/npm was not found.
    pause
    exit /b 1
  )
  echo [setup] Building frontend from the locked package versions...
  cd /d "%ROOT%frontend" || goto :error
  call npm.cmd ci || goto :error
  call npm.cmd run build || goto :error
)

echo.
echo ============================================================
echo  MV Hub predeploy local test
echo  URL      : %TEST_URL%
echo  Data     : %CONTENT_HUB_DATA%
echo  Email    : admin@millionvolt.com
echo  Password : LocalTest2026!
echo  Stop     : Ctrl+C
echo ============================================================
echo.

if not "%MVHUB_TEST_NO_BROWSER%"=="1" (
  start "" powershell -NoProfile -WindowStyle Hidden -Command "Start-Sleep -Seconds 2; Start-Process '%TEST_URL%'"
)

cd /d "%ROOT%backend" || goto :error
"%PYEXE%" serve.py
set "SERVER_EXIT=%ERRORLEVEL%"

echo.
echo [stopped] Test server exited with code %SERVER_EXIT%.
pause
exit /b %SERVER_EXIT%

:error
echo.
echo [ERROR] Predeploy test setup failed.
pause
exit /b 1

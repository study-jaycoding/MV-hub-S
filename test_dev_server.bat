@echo off
chcp 65001 >nul
setlocal EnableExtensions
REM ============================================================================
REM  MV Hub - LOCAL SERVER-LIKE FINAL TEST   run on YOUR OWN PC
REM
REM  Expected flow:
REM    1) Server: test_push-db.bat
REM    2) This PC: test_pull-db.bat
REM    3) This PC: test_dev_server.bat  (this file)
REM
REM  Uses the pulled backend\data_test DB, builds the frontend, and serves both UI
REM  and API from one production-like server on 127.0.0.1:8011. No Vite hot reload
REM  and no generation agent are started. Use test_dev.bat for live code editing.
REM
REM  The copied DB is isolated. The live server is never proxied or modified.
REM  Stop: Ctrl+C then Y.
REM ============================================================================
set "ROOT=%~dp0"
set "HOST=127.0.0.1"
set "PORT=8011"
set "TEST_URL=http://127.0.0.1:%PORT%"
set "TEST_DATA=%ROOT%backend\data_test"
set "TEST_DB=%TEST_DATA%\db\content_hub.db"

set "CONTENT_HUB_AUTH=1"
set "CONTENT_HUB_MANAGE=1"
set "CONTENT_HUB_NO_PROXY=1"
set "CONTENT_HUB_SERVER_SYNC=0"
set "CONTENT_HUB_DATA=%TEST_DATA%"
set "CONTENT_HUB_DB=%TEST_DB%"

echo.
echo ============================================================
echo  MV Hub - local server-like final test
echo  copied test DB : %TEST_DB%
echo  test URL       : %TEST_URL%
echo  mode           : built frontend + single server, proxy off
echo ============================================================
echo.

if not exist "%TEST_DB%" (
  echo [ERROR] Pulled test DB not found: %TEST_DB%
  echo         Run test_pull-db.bat first.
  pause
  exit /b 1
)

set "PORT_PID="
for /f "tokens=5" %%p in ('netstat -ano ^| findstr "LISTENING" ^| findstr /c:":%PORT% "') do set "PORT_PID=%%p"
if defined PORT_PID (
  echo [ERROR] Local server-test port %PORT% is already in use ^(pid %PORT_PID%^).
  echo         Close the previous test_dev_server window, then run this file again.
  pause
  exit /b 1
)

echo [start] Building and starting the production-like local server...
echo         The browser will open automatically when the server is ready.
echo.

REM Wait in a hidden helper and open the browser only after the server answers.
start "" powershell -NoProfile -WindowStyle Hidden -Command "$u='%TEST_URL%'; for($i=0;$i -lt 600;$i++){ try { Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 $u | Out-Null; Start-Process $u; break } catch { Start-Sleep -Seconds 1 } }"

call "%ROOT%MV_server.bat"

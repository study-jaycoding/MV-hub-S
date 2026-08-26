@echo off
chcp 65001 >nul
setlocal EnableExtensions
REM ============================================================================
REM  MV Hub - PREPARE/PUBLISH A TEST DB SNAPSHOT   run ON THE SERVER
REM
REM  One double-click does:
REM    1) Copy a consistent SQLite snapshot of the LIVE DB into data_test_push.
REM    2) Start an isolated snapshot server on port 8011.
REM    3) Print a one-time code for test_pull-db.bat to download every DB in THIS snapshot.
REM
REM  The live DB on 8010 is READ ONLY here. Nothing is deleted or overwritten in
REM  E:\MV-hub-S\backend\data. An older pushed TEST snapshot is archived.
REM
REM  Keep this window open while the developer runs test_pull-db.bat.
REM  Stop: Ctrl+C then Y.
REM ============================================================================
set "ROOT=%~dp0"
REM --- LIVE data folder on THIS server. Change this line if the server path moves. ---
set "SRC=E:\MV-hub-S\backend\data"
set "DST=%ROOT%backend\data_test_push"
set "HOST=0.0.0.0"
set "PORT=8011"

REM Production-like login, but fully isolated from the live shared server.
set "CONTENT_HUB_AUTH=1"
set "CONTENT_HUB_MANAGE=1"
set "CONTENT_HUB_NO_PROXY=1"
set "CONTENT_HUB_SERVER_SYNC=0"
set "CONTENT_HUB_TEST_SNAPSHOT_EXPORT=1"
REM The LAN-facing staging copy has no login-capable account. The downloaded ZIP
REM gets its local-only test admin later, while being built for the one authorized pull.
set "CONTENT_HUB_TEST_SNAPSHOT_STAGING=1"
set "CONTENT_HUB_DATA=%DST%"
set "CONTENT_HUB_DB=%DST%\db\content_hub.db"

echo.
echo ============================================================
echo  MV Hub - push test DB snapshot
echo  live data ^(read-only^) : %SRC%
echo  pushed test snapshot   : %DST%
echo  pull source URL        : http://[this server LAN IP]:%PORT%
echo  dev PC override        : set MVHUB_SNAPSHOT_SERVER=http://host:port  then run test_pull-db.bat
echo ============================================================
echo.

if not exist "%SRC%\db" (
  echo [ERROR] Live DB folder not found: %SRC%\db
  echo         Edit SRC near the top of this file if the live path changed.
  pause
  exit /b 1
)

REM Do not kill an existing listener automatically. It may be an older snapshot
REM server whose window must be closed cleanly before replacing the snapshot.
set "PORT_PID="
for /f "tokens=5" %%p in ('netstat -ano ^| findstr "LISTENING" ^| findstr /c:":%PORT% "') do set "PORT_PID=%%p"
if defined PORT_PID (
  echo [ERROR] Snapshot port %PORT% is already in use ^(pid %PORT_PID%^).
  echo         Close the previous test_push-db window, then run this file again.
  pause
  exit /b 1
)

REM Locate Python once and pass it through to MV_server.bat as well.
set "PYEXE="
if exist "%ROOT%runtime\python\python.exe" set "PYEXE=%ROOT%runtime\python\python.exe"
if "%PYEXE%"=="" for /f "delims=" %%p in ('dir /b /s "%ROOT%release\_staging\MVHub-*\runtime\python\python.exe" 2^>nul') do set "PYEXE=%%p"
if "%PYEXE%"=="" for /f "delims=" %%p in ('where python 2^>nul') do (
  echo %%p | findstr /i "\\WindowsApps\\python.exe" >nul || if not defined PYEXE set "PYEXE=%%p"
)
if "%PYEXE%"=="" (
  echo [ERROR] Python not found. Install Python or run from the MV Hub runtime.
  pause
  exit /b 1
)
echo [python] %PYEXE%

REM Generate a random 122-bit per-run code. setlocal removes it when this window exits.
set "CONTENT_HUB_TEST_SNAPSHOT_TOKEN="
for /f "delims=" %%T in ('powershell -NoProfile -Command "[guid]::NewGuid().ToString('N')"') do if not defined CONTENT_HUB_TEST_SNAPSHOT_TOKEN set "CONTENT_HUB_TEST_SNAPSHOT_TOKEN=%%T"
if not defined CONTENT_HUB_TEST_SNAPSHOT_TOKEN (
  echo [ERROR] Could not create the one-time snapshot code.
  pause
  exit /b 1
)

echo.
echo [1/2] Creating a verified isolated snapshot from the live DB...
"%PYEXE%" "%ROOT%tools\refresh_pm_test_data.py" "%SRC%" "%DST%"
if errorlevel 1 (
  echo.
  echo [ERROR] Snapshot creation failed. The live DB was not modified.
  pause
  exit /b 1
)

echo.
echo [2/2] Publishing the snapshot for test_pull-db on port %PORT%...
echo.
echo ============================================================
echo  ONE-TIME DOWNLOAD CODE
echo  %CONTENT_HUB_TEST_SNAPSHOT_TOKEN%
echo ============================================================
echo  Copy this code into test_pull-db.bat on the developer PC.
echo  It works once. If the pull fails after authorization, rerun this file.
echo       Keep this window open until the pull is complete.
echo       Stop: Ctrl+C then Y.
echo.

REM MV_server builds the matching frontend and exposes only the copied snapshot.
call "%ROOT%MV_server.bat"

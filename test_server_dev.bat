@echo off
chcp 65001 >nul
setlocal EnableExtensions
REM ============================================================================
REM  MV Hub - ONE-CLICK SERVER PREDEPLOY TEST   run ON THE SERVER
REM
REM  One double-click does:
REM    1) Copy a safe SQLite snapshot of the LIVE data into this test clone.
REM    2) Build the frontend from this test clone's code.
REM    3) Start the isolated test server on port 8011 with login/manage enabled.
REM
REM  LIVE stays on 8010 and is READ ONLY. The copied test data is replaced, while
REM  the previous test data is archived by tools\refresh_pm_test_data.py.
REM
REM  Open from your PC: http://192.168.1.199:8011
REM  Stop: Ctrl+C then Y. Close an older server-test window before running again.
REM ============================================================================
set "ROOT=%~dp0"
REM --- LIVE data folder on THIS server. Change this line if the server path moves. ---
set "SRC=E:\MV-hub-S\backend\data"
set "DST=%ROOT%backend\data"
set "HOST=0.0.0.0"
set "PORT=8011"

REM Production-like login/manage, but fully isolated from the live shared server.
set "CONTENT_HUB_AUTH=1"
set "CONTENT_HUB_MANAGE=1"
set "CONTENT_HUB_NO_PROXY=1"
set "CONTENT_HUB_SERVER_SYNC=0"
set "CONTENT_HUB_DATA=%DST%"

echo.
echo ============================================================
echo  MV Hub server predeploy test
echo  live data ^(read-only^) : %SRC%
echo  test data             : %DST%
echo  test URL              : http://192.168.1.199:%PORT%
echo ============================================================
echo.

if not exist "%SRC%\db" (
  echo [ERROR] Live DB folder not found: %SRC%\db
  echo         Edit SRC near the top of this file if the live path changed.
  pause
  exit /b 1
)

REM Do not kill a listener automatically. MV_server.bat auto-restarts its child, so
REM killing only Python could make the old window race this new DB refresh.
set "PORT_PID="
for /f "tokens=5" %%p in ('netstat -ano ^| findstr "LISTENING" ^| findstr /c:":%PORT% "') do set "PORT_PID=%%p"
if defined PORT_PID (
  echo [ERROR] Test port %PORT% is already in use ^(pid %PORT_PID%^).
  echo         Close the previous server-test window, then run this file again.
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

echo.
echo [1/2] Refreshing the isolated test DB from live ^(live is read-only^)...
"%PYEXE%" "%ROOT%tools\refresh_pm_test_data.py" "%SRC%" "%DST%"
if errorlevel 1 (
  echo.
  echo [ERROR] Test DB refresh failed. The live DB was not modified.
  pause
  exit /b 1
)

echo.
echo [2/2] Starting the server test on http://192.168.1.199:%PORT%
echo       Login and manage permissions use the copied real accounts.
echo       Stop: Ctrl+C then Y.
echo.

REM MV_server builds the frontend and keeps the test server alive with auto-restart.
call "%ROOT%MV_server.bat"

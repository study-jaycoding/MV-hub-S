@echo off
chcp 65001 >nul
REM ============================================================================
REM  MV Hub - TEST launcher (PM dashboard branch)
REM
REM  Isolated from production:
REM    - PORT 8011         (production stays on its own machine / 8010)
REM    - CONTENT_HUB_DATA  -> ..\_pm_test_data  (a COPY of the DB; never touches real data)
REM    - CONTENT_HUB_AUTH 0 (local mode, no login - faster testing)
REM    - HOST 127.0.0.1    (this PC only)
REM
REM  Open in browser on THIS PC:  http://127.0.0.1:8011
REM  Stop: Ctrl+C then Y
REM
REM  To mirror the shared server (login + roles), set CONTENT_HUB_AUTH=1 below.
REM ============================================================================
setlocal
set "PORT=8011"
set "HOST=127.0.0.1"
set "CONTENT_HUB_AUTH=0"
set "CONTENT_HUB_DATA=%~dp0..\_pm_test_data"
for %%I in ("%CONTENT_HUB_DATA%") do set "CONTENT_HUB_DATA=%%~fI"
if "%CONTENT_HUB_TEST_DB_MODE%"=="" set "CONTENT_HUB_TEST_DB_MODE=server"
REM PM dashboard module ON for testing (production keeps it OFF until ready).
set "CONTENT_HUB_MANAGE=1"
REM Force-disable delegation so this test server is FULLY local (copied DB only) and never
REM forwards to the production shared server. Without this, the copied DB re-establishes the
REM shared_server_token on login and /api/manage/* would be proxied to production (404 there).
set "CONTENT_HUB_NO_PROXY=1"

REM Pin the test server to the DB inside the copied test data folder. AUTH=0 normally follows
REM active.json dynamically; setting CONTENT_HUB_DB makes the test run read exactly the copied
REM snapshot and prevents accidental fallback to another local/account DB.
set "PYEXE="
for /f "delims=" %%p in ('dir /b /s "%~dp0release\_staging\MVHub-*\runtime\python\python.exe" 2^>nul') do set "PYEXE=%%p"
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
echo [python] %PYEXE%
set "DBPATH_FILE=%TEMP%\mvhub-test-db-path-%RANDOM%-%RANDOM%.txt"
"%PYEXE%" "%~dp0tools\resolve_test_db.py" "%CONTENT_HUB_DATA%" "%CONTENT_HUB_TEST_DB_MODE%" > "%DBPATH_FILE%"
if errorlevel 1 (
  del "%DBPATH_FILE%" >nul 2>nul
  echo [ERROR] Could not resolve copied test DB path.
  pause
  exit /b 1
)
set /p CONTENT_HUB_DB=<"%DBPATH_FILE%"
del "%DBPATH_FILE%" >nul 2>nul
if "%CONTENT_HUB_DB%"=="" (
  echo [ERROR] Could not resolve copied test DB path.
  pause
  exit /b 1
)
if not exist "%CONTENT_HUB_DB%" (
  echo [ERROR] Copied test DB does not exist: %CONTENT_HUB_DB%
  echo         Run refresh_pm_test_data.bat first.
  pause
  exit /b 1
)

REM Free the port FIRST. serve.py uses SO_REUSEADDR, so an old server left running on
REM this port would otherwise keep listening alongside the new one and requests would be
REM split between old and new code (stale UI / missing buttons). Kill any prior listener.
for /f "tokens=5" %%p in ('netstat -ano ^| findstr "LISTENING" ^| findstr ":%PORT%"') do taskkill /f /pid %%p >nul 2>nul

echo.
echo [TEST MODE] port=%PORT%  data=%CONTENT_HUB_DATA%  auth=%CONTENT_HUB_AUTH%
echo            db=%CONTENT_HUB_DB%
echo            db_mode=%CONTENT_HUB_TEST_DB_MODE%  proxy=off
echo            production is NOT affected (separate machine + separate data dir).
echo.

call "%~dp0run-server.bat"

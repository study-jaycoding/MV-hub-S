@echo off
chcp 65001 >nul
setlocal EnableExtensions
REM ============================================================================
REM  Refresh the TEST DB from the LIVE server DB   (run ON THE SERVER)
REM
REM    source (live) : backend\data of the LIVE service   -> READ ONLY
REM    target (test) : this test clone's backend\data      -> overwritten
REM
REM  Uses a consistent SQLite snapshot (safe even while live is running).
REM  Assets / media / backups are skipped (DB files only). The LIVE data is
REM  only READ - never modified.
REM
REM  Run this BEFORE TEST_run-server.bat, and again whenever you want fresh data.
REM ============================================================================
set "ROOT=%~dp0"
REM --- LIVE (production) data folder on THIS server. Change if it differs. ---
set "SRC=E:\MV-hub-S\backend\data"
REM --- TEST target = this clone's own backend\data ---
set "DST=%ROOT%backend\data"
set "PORT=8011"

echo.
echo [REFRESH TEST DB]
echo   source (live, read-only): %SRC%
echo   target (test)           : %DST%
echo.

if not exist "%SRC%\db" (
  echo [ERROR] Live db folder not found: %SRC%\db
  echo         Edit SRC at the top of this file to your live backend\data path.
  pause
  exit /b 1
)

REM --- locate python (same logic as the other launchers) ---
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

REM --- stop the test server on 8011 so the DB is not locked during copy ---
for /f "tokens=5" %%p in ('netstat -ano ^| findstr "LISTENING" ^| findstr ":%PORT%"') do (
  echo [stop] closing test server on port %PORT% ^(pid %%p^)
  taskkill /f /pid %%p >nul 2>nul
)

"%PYEXE%" "%ROOT%tools\refresh_pm_test_data.py" "%SRC%" "%DST%"
if errorlevel 1 (
  echo.
  echo [ERROR] refresh failed.
  pause
  exit /b 1
)

echo.
echo [OK] Test DB refreshed from live.
echo      Now start TEST_run-server.bat, then open http://192.168.1.199:%PORT%
echo.
pause

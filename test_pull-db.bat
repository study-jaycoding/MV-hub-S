@echo off
chcp 65001 >nul
setlocal EnableExtensions
REM ============================================================================
REM  Pull the SHARED SERVER db into this PC's TEST data   (run on YOUR OWN PC)
REM
REM    source (server) : http://192.168.1.199:8010   -> downloaded via admin login
REM    target (test)   : this PC's  backend\data_test  -> filled with that copy
REM
REM  After this, run test_dev.bat (backend port 8012): you see the copied real data
REM  AND anything you generate locally, fully isolated from the live server.
REM
REM  Only the DB is downloaded (no media/assets). The live server is READ only.
REM ============================================================================
set "ROOT=%~dp0"
set "SERVER=http://192.168.1.199:8010"
set "DST=%ROOT%backend\data_test"
set "PM_TEST_ADMIN_EMAIL=lee.jaelyun@gmail.com"

echo.
echo [PULL SERVER DB -^> TEST]
echo   server (read-only): %SERVER%
echo   admin email       : %PM_TEST_ADMIN_EMAIL%
echo   target (test data): %DST%
echo.
set /p "PM_TEST_ADMIN_PASSWORD=Admin password for %PM_TEST_ADMIN_EMAIL%: "
if "%PM_TEST_ADMIN_PASSWORD%"=="" (
  echo [ERROR] password is empty - aborting.
  pause
  exit /b 1
)

REM --- locate python (same logic as the other launchers) ---
set "PYEXE="
if exist "%ROOT%runtime\python\python.exe" set "PYEXE=%ROOT%runtime\python\python.exe"
if "%PYEXE%"=="" for /f "delims=" %%p in ('where python 2^>nul') do (
  echo %%p | findstr /i "\\WindowsApps\\python.exe" >nul || if not defined PYEXE set "PYEXE=%%p"
)
if "%PYEXE%"=="" for /f "delims=" %%p in ('where py 2^>nul') do if not defined PYEXE set "PYEXE=py"
if "%PYEXE%"=="" (
  echo [ERROR] Python not found - install Python or run from the MV Hub runtime.
  pause
  exit /b 1
)
echo [python] %PYEXE%

"%PYEXE%" "%ROOT%tools\refresh_pm_test_data.py" "%SERVER%" "%DST%"
if errorlevel 1 (
  echo.
  echo [ERROR] pull failed. Check the server address, your admin password, and that
  echo         the shared server on %SERVER% is running.
  pause
  exit /b 1
)

echo.
echo [OK] Server DB copied into the test data.
echo      Now start test_dev.bat  -^> open http://127.0.0.1:5173
echo.
pause

@echo off
chcp 65001 >nul
setlocal EnableExtensions
REM ============================================================================
REM  Pull the SHARED SERVER db into this PC's TEST data   (run on YOUR OWN PC)
REM
REM    source (server) : test_push-db snapshot on http://192.168.1.199:8011
REM    target (test)   : this PC's  backend\data_test  -> filled with that copy
REM
REM  After this, run test_dev_server.bat for the production-like final test.
REM  For live Vite editing + local generation, use test_dev.bat instead.
REM
REM  All snapshot DBs are downloaded (content/trash/manage/account DBs; no media/assets).
REM  The live server is READ only. The old local test data is archived before replacement.
REM  Enter the one-time code shown by test_push-db; the real admin password is never used.
REM ============================================================================
set "ROOT=%~dp0"
set "SERVER=http://192.168.1.199:8011"
set "DST=%ROOT%backend\data_test"

echo.
echo [PULL SERVER DB -^> TEST]
echo   pushed snapshot   : %SERVER%
echo   target (test data): %DST%
echo.

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

REM Python reads the one-time code with echo disabled and prints only * characters.
"%PYEXE%" "%ROOT%tools\refresh_pm_test_data.py" "%SERVER%" "%DST%"
if errorlevel 1 (
  echo.
  echo [ERROR] pull failed. Check the server address, one-time code, and that
  echo         test_push-db.bat is still running. Used codes cannot be retried.
  pause
  exit /b 1
)

echo.
echo [OK] Server DB copied into the test data.
echo      Now start test_dev_server.bat -^> open http://127.0.0.1:8011
echo      ^(Use test_dev.bat instead when you need Vite live editing.^)
echo.
pause

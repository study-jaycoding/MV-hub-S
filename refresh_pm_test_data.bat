@echo off
chcp 65001 >nul
setlocal EnableExtensions

REM Refresh the isolated PM test data folder from the shared server data.
REM This is a "button" for PM testing:
REM   1) stops the 8011 test server if it is running
REM   2) snapshots the shared server backend\data DB files into ..\_pm_test_data
REM   3) leaves production/shared server data untouched

set "ROOT=%~dp0"
set "SOURCE_FILE=%ROOT%pm_test_source_data.txt"
set "SRC=%~1"
if "%SRC%"=="" set "SRC=%PM_TEST_SOURCE_DATA%"
if "%SRC%"=="" if exist "%SOURCE_FILE%" set /p SRC=<"%SOURCE_FILE%"
if "%SRC%"=="" if exist "Z:\mvutil\MV_hub_S\backend\data" set "SRC=Z:\mvutil\MV_hub_S\backend\data"
if "%SRC%"=="" if exist "\\192.168.1.199\mvutil\MV_hub_S\backend\data" set "SRC=\\192.168.1.199\mvutil\MV_hub_S\backend\data"
if "%SRC%"=="" set "SRC=http://192.168.1.199:8010"
if not "%SRC%"=="" for %%I in ("%SRC%") do set "SRC=%%~I"
set "DST=%ROOT%..\_pm_test_data"
set "PORT=8011"

echo.
echo [PM TEST DB REFRESH]
echo   source: %SRC%
echo   target: %DST%
echo.

if "%SRC%"=="" (
  echo Shared server data path was not found automatically.
  echo.
  echo Paste the shared server backend\data path or server URL.
  echo Example:
  echo   Z:\mvutil\MV_hub_S\backend\data
  echo   \\server\share\MV-hub-S\backend\data
  echo   http://192.168.1.199:8010
  echo.
  echo If you use a mapped drive like Z:, run this BAT from the same user session
  echo that can see Z:. Administrator cmd often cannot see user-mapped drives.
  echo.
  set /p "SRC=Shared server backend\data path or URL: "
)
if not "%SRC%"=="" for %%I in ("%SRC%") do set "SRC=%%~I"
if "%SRC%"=="" (
  echo [ERROR] Shared server data path was not provided.
  pause
  exit /b 1
)

set "IS_URL=0"
echo %SRC% | findstr /b /i "http:// https://" >nul && set "IS_URL=1"

if "%IS_URL%"=="1" goto :source_ok

if not exist "%SRC%" (
  echo [ERROR] Shared server data path does not exist: %SRC%
  pause
  exit /b 1
)
if not exist "%SRC%\db" (
  echo [ERROR] Shared server db folder does not exist: %SRC%\db
  pause
  exit /b 1
)
for %%I in ("%SRC%") do set "SRC=%%~fI"
for %%I in ("%DST%") do set "DST=%%~fI"

:source_ok
if not "%IS_URL%"=="1" goto :after_url_source
set "PM_TEST_SERVER_URL=%SRC%"
if "%PM_TEST_ADMIN_EMAIL%"=="" set /p "PM_TEST_ADMIN_EMAIL=Admin email [admin@millionvolt.com]: "
if "%PM_TEST_ADMIN_EMAIL%"=="" set "PM_TEST_ADMIN_EMAIL=admin@millionvolt.com"
if "%PM_TEST_ADMIN_PASSWORD%"=="" set /p "PM_TEST_ADMIN_PASSWORD=Admin password: "
if "%PM_TEST_ADMIN_EMAIL%"=="" (
  echo [ERROR] Admin email was not provided.
  pause
  exit /b 1
)
if "%PM_TEST_ADMIN_PASSWORD%"=="" (
  echo [ERROR] Admin password was not provided.
  pause
  exit /b 1
)
for %%I in ("%DST%") do set "DST=%%~fI"

:after_url_source

set "PYEXE="
for /f "delims=" %%p in ('dir /b /s "%ROOT%release\_staging\MVHub-*\runtime\python\python.exe" 2^>nul') do set "PYEXE=%%p"
if "%PYEXE%"=="" (
  for /f "delims=" %%p in ('where python 2^>nul') do (
    echo %%p | findstr /i "\\WindowsApps\\python.exe" >nul || if not defined PYEXE set "PYEXE=%%p"
  )
)
if "%PYEXE%"=="" (
  echo [ERROR] Python not found. Install Python or run from the MV Hub runtime environment.
  pause
  exit /b 1
)
echo [python] %PYEXE%

REM Stop only the PM test server port. Do not touch the normal shared server port.
for /f "tokens=5" %%p in ('netstat -ano ^| findstr "LISTENING" ^| findstr ":%PORT%"') do (
  echo [stop] closing old test server on port %PORT% ^(pid %%p^)
  taskkill /f /pid %%p >nul 2>nul
)

"%PYEXE%" "%ROOT%tools\refresh_pm_test_data.py" "%SRC%" "%DST%"
if errorlevel 1 (
  echo.
  echo [ERROR] refresh failed.
  pause
  exit /b 1
)
>"%SOURCE_FILE%" echo %SRC%

echo.
echo [OK] Test DB snapshot refreshed.
echo      Now run run-test.bat and open http://127.0.0.1:8011
echo.
pause

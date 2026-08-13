@echo off
REM ============================================================================
REM  Scheduled-task launcher (used by register_autostart.bat - not run by hand)
REM  Usage: task_launch.bat server | watchdog | backup
REM
REM  Why this exists:
REM   - rotates the console log BEFORE the redirect handle opens (>50MB -> .old)
REM   - sets CONTENT_HUB_TASK=1 so child scripts skip interactive "pause" on
REM     errors and exit nonzero instead -> Task Scheduler can retry (boot-time
REM     npm/network failures are transient)
REM   - keeps the schtasks /TR command line short (261-char limit)
REM ============================================================================
setlocal
set "ROOT=%~dp0"
set "MODE=%~1"
set "CONTENT_HUB_TASK=1"
if not exist "%ROOT%logs" mkdir "%ROOT%logs"

REM SYSTEM does not see user-scoped Python/Node PATH entries. The one-click
REM registration records the verified absolute paths used by the admin user.
if exist "%ROOT%logs\scheduled_python.txt" for /f "usebackq delims=" %%p in ("%ROOT%logs\scheduled_python.txt") do if exist "%%p" set "PYEXE=%%p"
if exist "%ROOT%logs\scheduled_node_dir.txt" for /f "usebackq delims=" %%p in ("%ROOT%logs\scheduled_node_dir.txt") do if exist "%%p\npm.cmd" set "PATH=%%p;%PATH%"

set "LOG="
if "%MODE%"=="server"   set "LOG=%ROOT%logs\server_console.log"
if "%MODE%"=="watchdog" set "LOG=%ROOT%logs\watchdog_console.log"
if "%MODE%"=="backup"   set "LOG=%ROOT%logs\backup_console.log"
if not defined LOG (
  echo [task_launch] unknown mode: %MODE%
  exit /b 1
)

if defined PYEXE >> "%LOG%" echo [task_launch] configured python: %PYEXE%

REM Rotate before the redirect below opens the file (open handle = no rename).
if exist "%LOG%" for %%F in ("%LOG%") do if %%~zF gtr 52428800 (
  del "%LOG%.old" 2>nul
  move /y "%LOG%" "%LOG%.old" >nul
)

if "%MODE%"=="server"   call "%ROOT%MV_server.bat" >> "%LOG%" 2>&1
if "%MODE%"=="watchdog" call "%ROOT%MV_watchdog.bat" >> "%LOG%" 2>&1
if "%MODE%"=="backup"   call "%ROOT%run_py.bat" "%ROOT%tools\backup_replicate.py" >> "%LOG%" 2>&1
exit /b %errorlevel%

@echo off
REM MV Hub - build a server migration package from this server's live databases.
REM
REM The shared server MUST be fully stopped first. Disable the scheduled tasks
REM before ending them - /End alone lets them come back after a reboot:
REM   schtasks /Change /TN "MVHub Watchdog" /DISABLE
REM   schtasks /Change /TN "MVHub Server"   /DISABLE
REM   schtasks /End /TN "MVHub Watchdog"
REM   schtasks /End /TN "MVHub Server"
REM
REM Usage: server_move_export.bat <empty folder> [--with-worker-backups] [--with-media]
REM See docs\SERVER_MIGRATION.md for the full procedure.
setlocal
set "ROOT=%~dp0"
if "%~1"=="" (
  echo Usage: server_move_export.bat ^<destination folder^> [options]
  echo.
  echo   Stop the shared server first, then run this from the server PC.
  echo   Options: --with-worker-backups  --with-media  --data-dir ^<dir^>
  echo   Details: docs\SERVER_MIGRATION.md
  exit /b 1
)
call "%ROOT%run_py.bat" "%ROOT%tools\server_move.py" export %*
exit /b %errorlevel%

@echo off
REM ============================================================================
REM  MV Hub - register AUTO-START on the SERVER PC (run as Administrator)
REM
REM  Registers Windows Task Scheduler tasks so the shared server survives
REM  reboots (Windows Update etc.) without anyone logging in:
REM    MVHub Server      - at boot (+1 min): MV_server.bat  -> logs\server_console.log
REM    MVHub Watchdog    - at boot (+2 min): MV_watchdog.bat -> logs\watchdog_console.log
REM    MVHub BackupCopy  - daily 03:30: tools\backup_replicate.py (off-PC replica)
REM
REM  After registering, do NOT also run MV_server.bat manually (port clash).
REM  Console output goes to the log files above instead of a visible window.
REM
REM  Stop/start manually:
REM    schtasks /End /TN "MVHub Server"   + taskkill the python serve.py process
REM    schtasks /Run /TN "MVHub Server"
REM  Unregister: schtasks /Delete /TN "MVHub Server" /F   (same for the others)
REM ============================================================================
setlocal
set "ROOT=%~dp0"

net session >nul 2>&1
if errorlevel 1 (
  echo [ERROR] Run this file as Administrator (right-click - Run as administrator).
  pause
  exit /b 1
)

if not exist "%ROOT%logs" mkdir "%ROOT%logs"

echo [1/3] MVHub Server (boot, +1 min delay)...
schtasks /Create /F /TN "MVHub Server" /SC ONSTART /DELAY 0001:00 /RU SYSTEM /RL HIGHEST ^
  /TR "cmd /c call \"%ROOT%MV_server.bat\" >> \"%ROOT%logs\server_console.log\" 2>&1"
if errorlevel 1 goto :err

echo [2/3] MVHub Watchdog (boot, +2 min delay)...
schtasks /Create /F /TN "MVHub Watchdog" /SC ONSTART /DELAY 0002:00 /RU SYSTEM /RL HIGHEST ^
  /TR "cmd /c call \"%ROOT%MV_watchdog.bat\" >> \"%ROOT%logs\watchdog_console.log\" 2>&1"
if errorlevel 1 goto :err

echo [3/3] MVHub BackupCopy (daily 03:30)...
schtasks /Create /F /TN "MVHub BackupCopy" /SC DAILY /ST 03:30 /RU SYSTEM /RL HIGHEST ^
  /TR "cmd /c call \"%ROOT%run_py.bat\" \"%ROOT%tools\backup_replicate.py\" >> \"%ROOT%logs\backup_console.log\" 2>&1"
if errorlevel 1 goto :err

REM schtasks default kills a task after 72h ("Stop the task if it runs longer
REM than 3 days"). Server/watchdog run forever and ONSTART would not refire
REM until the next reboot -> the whole hub silently dies on day 3.
REM Fix: disable the execution time limit (PT0S) on all three tasks.
echo [4/4] Removing the 72h execution time limit...
powershell -NoProfile -Command "$s = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Seconds 0) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable; foreach ($t in 'MVHub Server','MVHub Watchdog','MVHub BackupCopy') { Set-ScheduledTask -TaskName $t -Settings $s | Out-Null }; Write-Output 'time limit disabled for 3 tasks'"
if errorlevel 1 goto :err

echo.
echo Done. Registered tasks:
schtasks /Query /TN "MVHub Server" /FO LIST | findstr /i "TaskName Status"
schtasks /Query /TN "MVHub Watchdog" /FO LIST | findstr /i "TaskName Status"
schtasks /Query /TN "MVHub BackupCopy" /FO LIST | findstr /i "TaskName Status"
echo.
echo Start now without rebooting:
echo   schtasks /Run /TN "MVHub Server"
echo   schtasks /Run /TN "MVHub Watchdog"
echo.
pause
exit /b 0

:err
echo [ERROR] task registration failed - see message above.
pause
exit /b 1

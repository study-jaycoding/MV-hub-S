@echo off
REM ============================================================================
REM  MV Hub - ONE-CLICK server setup (double-click this file once on the
REM  SERVER PC; it asks for admin rights by itself)
REM
REM  What it does in one run:
REM    1) asks for the NAS backup path (Enter = skip, can be set later)
REM    2) registers auto-start tasks (server / watchdog / daily backup copy)
REM       - starts at boot without login, no 72h time limit
REM    3) starts the server + watchdog right now (no reboot needed)
REM
REM  After this, nothing else to do. The server survives crashes, hangs and
REM  reboots by itself. Watch logs with MV_logs.bat (replaces the old console).
REM  Do NOT run MV_server.bat manually anymore (port clash).
REM ============================================================================
setlocal
set "ROOT=%~dp0"
if "%PORT%"=="" set "PORT=8010"

REM ---- self-elevate to admin ------------------------------------------------
net session >nul 2>&1
if errorlevel 1 (
  echo Requesting administrator rights...
  powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  exit /b
)
cd /d "%ROOT%"

echo.
echo ============================================
echo  MV Hub server one-click setup
echo ============================================
echo.

REM ---- step 1: NAS backup replica path (optional) ---------------------------
REM NOTE: no parenthesized block here - %NASPATH% read after set /p must expand
REM at execution time (inside a block it expands at parse time = always empty).
if exist "%ROOT%tools\backup_replica_target.txt" goto :nas_have
echo [1/3] Where should daily DB backups be copied?
echo       Use a UNC path like \\NAS\share\mvhub_backup  (NOT Z:\...)
echo       Press Enter to skip - you can set it later in
echo       tools\backup_replica_target.txt
set "NASPATH="
set /p "NASPATH=  NAS path (Enter=skip): "
if not defined NASPATH goto :nas_skip
>"%ROOT%tools\backup_replica_target.txt" echo %NASPATH%
echo       saved.
goto :nas_done
:nas_skip
echo       skipped - backups stay on this PC only for now.
goto :nas_done
:nas_have
echo [1/3] Backup replica target already set:
type "%ROOT%tools\backup_replica_target.txt"
:nas_done

REM ---- step 2: register scheduled tasks -------------------------------------
if not exist "%ROOT%logs" mkdir "%ROOT%logs"
echo.
echo [2/3] Registering auto-start tasks...

schtasks /Create /F /TN "MVHub Server" /SC ONSTART /DELAY 0001:00 /RU SYSTEM /RL HIGHEST ^
  /TR "cmd /c call \"%ROOT%MV_server.bat\" >> \"%ROOT%logs\server_console.log\" 2>&1" >nul
if errorlevel 1 goto :err

schtasks /Create /F /TN "MVHub Watchdog" /SC ONSTART /DELAY 0002:00 /RU SYSTEM /RL HIGHEST ^
  /TR "cmd /c call \"%ROOT%MV_watchdog.bat\" >> \"%ROOT%logs\watchdog_console.log\" 2>&1" >nul
if errorlevel 1 goto :err

schtasks /Create /F /TN "MVHub BackupCopy" /SC DAILY /ST 03:30 /RU SYSTEM /RL HIGHEST ^
  /TR "cmd /c call \"%ROOT%run_py.bat\" \"%ROOT%tools\backup_replicate.py\" >> \"%ROOT%logs\backup_console.log\" 2>&1" >nul
if errorlevel 1 goto :err

REM schtasks default kills a task after 72h and ONSTART would not refire until
REM the next reboot -> the hub would silently die on day 3. Disable the limit.
powershell -NoProfile -Command "$s = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Seconds 0) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable; foreach ($t in 'MVHub Server','MVHub Watchdog','MVHub BackupCopy') { Set-ScheduledTask -TaskName $t -Settings $s | Out-Null }"
if errorlevel 1 goto :err
echo       done (3 tasks, no time limit, start at boot without login).

REM ---- step 3: start now ----------------------------------------------------
echo.
echo [3/3] Starting the server now...

REM If a server is already running in a console window, stop it first so the
REM scheduled task can own the port from now on.
netstat -ano | findstr /c:":%PORT% " | findstr LISTENING >nul
if not errorlevel 1 (
  echo       A server is already running on port %PORT% - moving it under
  echo       auto-start (the running one will be stopped)...
  powershell -NoProfile -Command "$p=(Get-NetTCPConnection -LocalPort %PORT% -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty OwningProcess); if($p){ $c=(Get-CimInstance Win32_Process -Filter \"ProcessId=$p\").CommandLine; if($c -like '*serve.py*'){ taskkill /PID $p /T /F | Out-Null; Write-Output '      stopped old server.' } else { Write-Output '      WARNING: port is used by another program - not touching it.' } }"
  timeout /t 3 /nobreak >nul
)

schtasks /Run /TN "MVHub Server" >nul
schtasks /Run /TN "MVHub Watchdog" >nul
if exist "%ROOT%tools\backup_replica_target.txt" schtasks /Run /TN "MVHub BackupCopy" >nul

echo.
echo ============================================
echo  Setup complete.
echo ============================================
echo  - First start builds the frontend: the hub may take a few minutes
echo    to come up. Check:  http://127.0.0.1:%PORT%
echo  - Live log (old console window): double-click MV_logs.bat
echo  - From now on do NOT run MV_server.bat manually.
echo  - Everything auto-recovers: crash, hang, reboot.
echo.
pause
exit /b 0

:err
echo.
echo [ERROR] setup failed - see message above.
pause
exit /b 1

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
REM `net session` can fail even for an administrator when the Windows Server
REM service is disabled. Ask Windows for the token's actual Administrator role.
powershell -NoProfile -Command "if (([Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent())).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { exit 0 } else { exit 1 }" >nul 2>nul
if errorlevel 1 (
  echo Requesting administrator rights...
  set "MVHUB_ELEVATE_FILE=%~f0"
  powershell -NoProfile -Command "Start-Process -FilePath $env:MVHUB_ELEVATE_FILE -Verb RunAs"
  exit /b
)
cd /d "%ROOT%"

REM A code-only sparse clone made before the supervisor rollout may not have
REM tools/. Do not register tasks that can never start; explain the repair.
if not exist "%ROOT%tools\server_supervisor.py" goto :tools_missing
if not exist "%ROOT%tools\server_watchdog.py" goto :tools_missing
if not exist "%ROOT%tools\backup_replicate.py" goto :tools_missing
if not exist "%ROOT%logs" mkdir "%ROOT%logs"
set "RUNTIME_CONFIG=%ROOT%.mvhub-runtime"
if not exist "%RUNTIME_CONFIG%" mkdir "%RUNTIME_CONFIG%"

REM Scheduled tasks run as SYSTEM, which does not inherit the signed-in user's
REM PATH. Resolve the working Python/Node locations now and persist only their
REM absolute paths for task_launch.bat.
set "PYEXE="
for /f "delims=" %%p in ('py -3 -c "import sys; print(sys.executable)" 2^>nul') do if not defined PYEXE set "PYEXE=%%p"
if not defined PYEXE for /f "delims=" %%p in ('python -c "import sys; print(sys.executable)" 2^>nul') do if not defined PYEXE set "PYEXE=%%p"
if not defined PYEXE goto :python_missing
if not exist "%PYEXE%" goto :python_missing
"%PYEXE%" -c "import fastapi,uvicorn,pydantic,websockets,multipart,PIL,watchdog" >nul 2>nul
if errorlevel 1 goto :python_deps_missing
"%PYEXE%" "%ROOT%tools\verify_requirements.py" "%ROOT%backend\requirements.txt" >nul 2>nul
if errorlevel 1 goto :python_deps_missing

set "NPMCMD="
for /f "delims=" %%p in ('where npm.cmd 2^>nul') do if not defined NPMCMD set "NPMCMD=%%p"
if not defined NPMCMD goto :node_missing
if not exist "%NPMCMD%" goto :node_missing
for %%p in ("%NPMCMD%") do set "NODEDIR=%%~dpp"
if not exist "%NODEDIR%node.exe" goto :node_missing
"%NODEDIR%node.exe" --version >nul 2>nul
if errorlevel 1 goto :node_missing
call "%NPMCMD%" --version >nul 2>nul
if errorlevel 1 goto :node_missing

>"%RUNTIME_CONFIG%\python.txt" echo(%PYEXE%
>"%RUNTIME_CONFIG%\node_dir.txt" echo(%NODEDIR%

echo.
echo ============================================
echo  MV Hub server one-click setup
echo ============================================
echo  Python: %PYEXE%
echo  Node:   %NODEDIR%
echo.

REM ---- step 1: NAS backup replica path (optional) ---------------------------
REM NOTE: no parenthesized block here - the value read by set /p must expand at
REM execution time. Delayed expansion (!VAR!) is used for every reference so a
REM path containing & ^ ( ) is never re-parsed as a command (P1: with %VAR% an
REM input like \\NAS\a&whoami would RUN whoami in this elevated window).
if exist "%ROOT%tools\backup_replica_target.txt" goto :nas_have
echo [1/3] Where should daily DB backups be copied?
echo       Use a UNC path like \\NAS\share\mvhub_backup  (NOT Z:\...)
echo       Press Enter to skip - you can set it later in
echo       tools\backup_replica_target.txt
setlocal EnableDelayedExpansion
set "NASPATH="
set /p "NASPATH=  NAS path (Enter=skip): "
REM parentheses required: a bare `if X A & B` runs B unconditionally (cmd rule)
if not defined NASPATH ( endlocal & goto :nas_skip )
if not "!NASPATH:~0,2!"=="\\" (
  echo       NOT saved: must be a UNC path starting with \\  ...
  echo       Drive letters like Z: are invisible to the SYSTEM task account.
  endlocal
  goto :nas_skip
)
>"%ROOT%tools\backup_replica_target.txt" echo(!NASPATH!
endlocal
echo       saved.
goto :nas_done
:nas_skip
echo       skipped - backups stay on this PC only for now.
goto :nas_done
:nas_have
echo [1/3] Backup replica target already set:
type "%ROOT%tools\backup_replica_target.txt"
findstr /b /l /c:"\\" "%ROOT%tools\backup_replica_target.txt" >nul || (
  echo       WARNING: not a UNC path - the SYSTEM backup task cannot see
  echo       mapped drives like Z:. Edit tools\backup_replica_target.txt.
)
:nas_done

REM ---- step 2: register scheduled tasks -------------------------------------
echo.
echo [2/3] Registering auto-start tasks...

REM task_launch.bat rotates the console log, sets CONTENT_HUB_TASK=1 (child
REM scripts then exit instead of pausing on errors) and does the redirection.
schtasks /Create /F /TN "MVHub Server" /SC ONSTART /DELAY 0001:00 /RU SYSTEM /RL HIGHEST ^
  /TR "cmd /c call \"%ROOT%task_launch.bat\" server" >nul
if errorlevel 1 goto :err

schtasks /Create /F /TN "MVHub Watchdog" /SC ONSTART /DELAY 0002:00 /RU SYSTEM /RL HIGHEST ^
  /TR "cmd /c call \"%ROOT%task_launch.bat\" watchdog" >nul
if errorlevel 1 goto :err

schtasks /Create /F /TN "MVHub BackupCopy" /SC DAILY /ST 03:30 /RU SYSTEM /RL HIGHEST ^
  /TR "cmd /c call \"%ROOT%task_launch.bat\" backup" >nul
if errorlevel 1 goto :err

REM schtasks default kills a task after 72h and ONSTART would not refire until
REM the next reboot -> the hub would silently die on day 3. Disable the limit.
REM RestartCount/Interval: boot-time failures (npm not ready, network down) now
REM exit nonzero thanks to CONTENT_HUB_TASK=1 -> scheduler retries every 5 min.
powershell -NoProfile -Command "$s = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Seconds 0) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -RestartCount 10 -RestartInterval (New-TimeSpan -Minutes 5); foreach ($t in 'MVHub Server','MVHub Watchdog','MVHub BackupCopy') { Set-ScheduledTask -TaskName $t -Settings $s | Out-Null }"
if errorlevel 1 goto :err
echo       done (3 tasks, no time limit, retry on boot failure, no login needed).

REM ---- step 3: start now ----------------------------------------------------
echo.
echo [3/3] Starting the server now...
set "CONTENT_HUB_NO_PAUSE=1"
call "%ROOT%restart_server_task.bat"
if errorlevel 1 goto :err
if exist "%ROOT%tools\backup_replica_target.txt" (
  schtasks /Run /TN "MVHub BackupCopy" >nul
  if errorlevel 1 goto :err
)

echo.
echo ============================================
echo  Setup complete - server is UP:  http://127.0.0.1:%PORT%
echo ============================================
echo  - Live log (old console window): double-click MV_logs.bat
echo  - From now on do NOT run MV_server.bat manually.
echo  - Everything auto-recovers: crash, hang, reboot.
echo.
pause
exit /b 0

:tools_missing
echo.
echo [ERROR] Required server tools are missing from this checkout.
echo         Run update_git.bat once more, then run register_autostart.bat.
echo         Manual repair: git sparse-checkout add tools
echo.
pause
exit /b 1

:python_missing
echo.
echo [ERROR] Python is installed for another account or could not be resolved.
echo         Run update_git.bat from this Windows account, then retry.
echo.
pause
exit /b 1

:python_deps_missing
echo.
echo [ERROR] Python exists, but required MV Hub packages are missing.
echo         Run update_git.bat and retry auto-start registration.
echo.
pause
exit /b 1

:node_missing
echo.
echo [ERROR] Node.js/npm could not be resolved for server auto-start.
echo         Install Node.js, reopen this window, then retry.
echo.
pause
exit /b 1

:err
echo.
echo [ERROR] setup failed - see message above.
pause
exit /b 1

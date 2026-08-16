@echo off
REM ============================================================================
REM  MV Hub - server WATCHDOG launcher  [auto-restart]
REM
REM  Watches /api/ready on the shared server. If the server process hangs
REM  (alive but not responding), kills ONLY the serve.py process so the
REM  server supervisor restarts it. Crash restarts are already handled by
REM  that bounded supervisor.
REM
REM  Safe by design: does not intervene during the boot/database migration grace,
REM  treats busy/maintenance as alert-only, refuses to kill when the target is ambiguous,
REM  and stops intervening on a restart storm (3 kills / 60 min -> ALERT).
REM
REM  Run on the SERVER PC only. Logs: logs\watchdog.log
REM ============================================================================
setlocal
set "ROOT=%~dp0"
if "%PORT%"=="" set "PORT=8010"

if "%PYEXE%"=="" (
  if exist "%ROOT%runtime\python\python.exe" set "PYEXE=%ROOT%runtime\python\python.exe"
)
if "%PYEXE%"=="" (
  for /f "delims=" %%p in ('dir /b /s "%ROOT%release\_staging\MVHub-*\runtime\python\python.exe" 2^>nul') do set "PYEXE=%%p"
)
if "%PYEXE%"=="" (
  for /f "delims=" %%p in ('where python 2^>nul') do (
    echo %%p | findstr /i "\\WindowsApps\\python.exe" >nul || if not defined PYEXE set "PYEXE=%%p"
  )
)
if "%PYEXE%"=="" (
  echo [ERROR] Python not found - install from python.org and retry.
  exit /b 1
)

echo [watchdog] python: %PYEXE%  port: %PORT%
:watchloop
"%PYEXE%" "%ROOT%tools\server_watchdog.py" --port %PORT%
set "WATCHDOG_RC=%errorlevel%"
REM Under Task Scheduler, return control so its bounded 5-minute retry policy
REM applies. A local 10-second forever loop would turn a persistent code/config
REM error into a CPU/log storm and hide the task failure result.
if "%CONTENT_HUB_TASK%"=="1" (
  echo [watchdog] exited ^(code %WATCHDOG_RC%^) - handing retry to Task Scheduler.
  if "%WATCHDOG_RC%"=="0" exit /b 1
  exit /b %WATCHDOG_RC%
)
echo [watchdog] exited ^(code %WATCHDOG_RC%^) - relaunching in 10s...
timeout /t 10 /nobreak >nul
goto :watchloop

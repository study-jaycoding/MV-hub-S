@echo off
REM ============================================================================
REM  MV Hub - server move, step 2 of 2 (run on the NEW server PC)
REM  Put the move folder on this user's Desktop first. This checks the PC,
REM  verifies and installs the databases, applies the server settings,
REM  registers auto-start and starts the server. A person changes the IP.
REM  Details: docs\SERVER_MIGRATION.md (easy move)
REM ============================================================================
setlocal
set "ROOT=%~dp0"
powershell -NoProfile -Command "if (([Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent())).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { exit 0 } else { exit 1 }" >nul 2>nul
if errorlevel 1 (
  echo Requesting administrator rights...
  set "MVHUB_ELEVATE_FILE=%~f0"
  set "MVHUB_ELEVATE_ARGS=%*"
  powershell -NoProfile -Command "if ($env:MVHUB_ELEVATE_ARGS) { Start-Process -FilePath $env:MVHUB_ELEVATE_FILE -ArgumentList $env:MVHUB_ELEVATE_ARGS -Verb RunAs } else { Start-Process -FilePath $env:MVHUB_ELEVATE_FILE -Verb RunAs }"
  exit /b
)
cd /d "%ROOT%"
REM One Python for install + index rebuild + the scheduled server: the same
REM rule as register_autostart.bat, passed on to it as MVHUB_SERVER_PYEXE.
set "PYEXE="
for /f "delims=" %%p in ('py -3 -c "import sys; print(sys.executable)" 2^>nul') do if not defined PYEXE set "PYEXE=%%p"
if not defined PYEXE for /f "delims=" %%p in ('python -c "import sys; print(sys.executable)" 2^>nul') do if not defined PYEXE set "PYEXE=%%p"
if not defined PYEXE (
  echo [ERROR] Python 3 was not found. Install Python, then run this again.
  echo.
  pause
  exit /b 1
)
"%PYEXE%" "%ROOT%tools\server_move_easy.py" in %*
echo.
pause

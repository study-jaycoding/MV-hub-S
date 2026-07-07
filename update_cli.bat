@echo off
chcp 65001 >nul
REM ============================================================================
REM  MV Hub - Higgsfield CLI updater (standalone)
REM
REM  Ensures the Higgsfield CLI matches the PINNED version in hf_cli_version.txt:
REM  installs that exact version if missing or different, does nothing if already
REM  matching. Never @latest - Higgsfield ships breaking changes; bump the pin file
REM  to roll the whole team forward on a version we tested.
REM
REM  Usage:
REM    update_cli.bat            run directly (pauses at the end)
REM    update_cli.bat nopause    called by another script (no pause, best-effort)
REM
REM  update_git.bat calls this with "nopause" so the CLI logic lives in one place.
REM ============================================================================
setlocal
set "QUIET=0"
if /i "%~1"=="nopause" set "QUIET=1"
set "ROOT=%~dp0"

where npm >nul 2>nul
if errorlevel 1 (
  echo     npm not found - install Node.js from nodejs.org, then retry.
  goto :end_skip
)

REM Pinned version = single source of truth. Install EXACTLY this, never @latest.
set "HF_CLI_VERSION="
if exist "%ROOT%hf_cli_version.txt" set /p HF_CLI_VERSION=<"%ROOT%hf_cli_version.txt"
REM trim stray leading/trailing spaces a re-saved pin file might add.
for /f "tokens=* delims= " %%x in ("%HF_CLI_VERSION%") do set "HF_CLI_VERSION=%%x"
if not defined HF_CLI_VERSION (
  echo     [warn] hf_cli_version.txt missing/empty - cannot pin; skipping.
  goto :end_skip
)

where higgsfield >nul 2>nul
if errorlevel 1 (
  echo     Higgsfield CLI not installed - installing pinned @%HF_CLI_VERSION%...
  call npm install -g @higgsfield/cli@%HF_CLI_VERSION% || echo     [warn] CLI install failed - continuing.
  goto :end_ok
)

REM Local version compare (no network). Reinstall only when it differs from the pin.
set "CUR="
for /f "tokens=2" %%v in ('higgsfield version 2^>nul') do if not defined CUR set "CUR=%%v"
if "%CUR%"=="%HF_CLI_VERSION%" (
  echo     Higgsfield CLI already at pinned %HF_CLI_VERSION% - skip.
) else (
  echo     Installed %CUR% differs from pin %HF_CLI_VERSION% - installing pinned...
  call npm install -g @higgsfield/cli@%HF_CLI_VERSION% || echo     [warn] CLI update failed - continuing.
)

:end_ok
if "%QUIET%"=="0" (
  echo.
  echo [done] Higgsfield CLI check complete.
  pause
)
exit /b 0

:end_skip
if "%QUIET%"=="0" pause
exit /b 0

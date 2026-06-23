@echo off
chcp 65001 >nul
REM ============================================================================
REM  MV Hub - Higgsfield CLI updater (standalone)
REM
REM  Checks the Higgsfield CLI: installs it if missing, updates it only when a
REM  newer version exists, and does nothing when already current.
REM
REM  Usage:
REM    update-cli.bat            run directly (pauses at the end)
REM    update-cli.bat nopause    called by another script (no pause, best-effort)
REM
REM  update.bat calls this with "nopause" so the CLI logic lives in one place.
REM ============================================================================
setlocal
set "QUIET=0"
if /i "%~1"=="nopause" set "QUIET=1"

where npm >nul 2>nul
if errorlevel 1 (
  echo     npm not found - install Node.js from nodejs.org, then retry.
  goto :end_skip
)

where higgsfield >nul 2>nul
if errorlevel 1 (
  echo     Higgsfield CLI not installed - installing latest...
  call npm install -g @higgsfield/cli@latest || echo     [warn] CLI install failed - continuing.
  goto :end_ok
)

REM npm outdated exits 1 when a newer version is available, 0 when already current.
npm outdated -g @higgsfield/cli >nul 2>nul
if errorlevel 1 (
  echo     New version available - updating Higgsfield CLI...
  call npm install -g @higgsfield/cli@latest || echo     [warn] CLI update failed - continuing.
) else (
  echo     Higgsfield CLI is already the latest version - skip.
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

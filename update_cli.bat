@echo off
chcp 65001 >nul
REM ============================================================================
REM  MV Hub - Higgsfield CLI updater (standalone)
REM
REM  Ensures the effective Higgsfield CLI on PATH exactly matches the version in
REM  hf_cli_version.txt. Never installs @latest - Higgsfield ships breaking
REM  changes; bump the pin file to roll the whole team onto a tested version.
REM
REM  To bump the pin safely, follow docs\HF_CLI_UPGRADE.md:
REM    change pin -> run this updater -> run contract smoke -> commit/release.
REM
REM  Usage:
REM    update_cli.bat            interactive; pauses before returning
REM    update_cli.bat nopause    no pause; returns the same verified exit code
REM
REM  No script calls this file today (update_git, MV_agent and release paths all
REM  handle the CLI themselves), so a non-zero exit cannot block app startup.
REM  Exit 0 = the CLI actually executed and matched the pin.
REM  Exit 1 = the pinned CLI could not be established.
REM ============================================================================
setlocal
set "QUIET=0"
if /i "%~1"=="nopause" set "QUIET=1"
set "ROOT=%~dp0"
set "RESULT=1"

if "%QUIET%"=="0" (
  echo     [note] This checks the standalone/global CLI against hf_cli_version.txt.
)

REM Pinned version = single source of truth. Install EXACTLY this, never @latest.
set "HF_CLI_VERSION="
if exist "%ROOT%hf_cli_version.txt" set /p HF_CLI_VERSION=<"%ROOT%hf_cli_version.txt"
REM Trim stray leading spaces a re-saved pin file might add.
for /f "tokens=* delims= " %%x in ("%HF_CLI_VERSION%") do set "HF_CLI_VERSION=%%x"
if not defined HF_CLI_VERSION (
  echo     [error] hf_cli_version.txt is missing or empty; refusing an unpinned install.
  goto :finish
)

REM Fast/offline-safe path: an already-correct CLI needs neither npm nor network.
call :read_current_version
if "%CUR%"=="%HF_CLI_VERSION%" (
  echo     Higgsfield CLI already at pinned %HF_CLI_VERSION% - skip.
  set "RESULT=0"
  goto :finish
)

if defined CUR (
  echo     Installed %CUR% differs from pin %HF_CLI_VERSION% - installing pinned...
) else (
  echo     Higgsfield CLI is missing or unreadable - installing pinned @%HF_CLI_VERSION%...
)

where npm >nul 2>nul
if errorlevel 1 (
  echo     [error] npm not found; cannot install the pinned CLI.
  goto :verify
)

REM npm's return code is diagnostic. The final decision is the effective CLI version.
call npm install -g @higgsfield/cli@%HF_CLI_VERSION%
if errorlevel 1 (
  echo     [warn] npm reported an install failure; verifying the effective CLI anyway.
)

:verify
call :read_current_version
if "%CUR%"=="%HF_CLI_VERSION%" (
  echo     [done] Verified Higgsfield CLI %HF_CLI_VERSION%.
  set "RESULT=0"
) else (
  if defined CUR (
    echo     [error] Effective Higgsfield CLI is %CUR%, expected %HF_CLI_VERSION%.
  ) else (
    echo     [error] Higgsfield CLI is still unavailable after the install attempt.
  )
  echo     [error] Do not use generation until the pinned version is available.
  set "RESULT=1"
)

:finish
if "%QUIET%"=="0" (
  echo.
  if "%RESULT%"=="0" (
    echo [done] Higgsfield CLI check complete.
  ) else (
    echo [failed] Higgsfield CLI does not match the project pin.
  )
  pause
)
exit /b %RESULT%

REM ---------------------------------------------------------------------------
REM Reads the version of the CLI that this shell will actually execute.
REM CUR stays empty when the command is missing, fails, or has an unknown format.
REM ---------------------------------------------------------------------------
:read_current_version
set "CUR="
where higgsfield >nul 2>nul
if errorlevel 1 exit /b 0

set "VERSION_TMP=%TEMP%\mvhub-hf-version-%RANDOM%-%RANDOM%.tmp"
call higgsfield version >"%VERSION_TMP%" 2>nul
set "VERSION_RC=%ERRORLEVEL%"
if "%VERSION_RC%"=="0" for /f "usebackq tokens=2" %%v in ("%VERSION_TMP%") do if not defined CUR set "CUR=%%v"
del /q "%VERSION_TMP%" >nul 2>nul
set "VERSION_TMP="
set "VERSION_RC="
exit /b 0

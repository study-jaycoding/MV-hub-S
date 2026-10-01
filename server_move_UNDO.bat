@echo off
REM ============================================================================
REM  MV Hub - undo server move step 1 (run on the OLD server PC)
REM  Puts the old server back exactly as it was before server_move_OUT.bat.
REM  Valid ONLY before the new PC takes this server's IP address.
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
set "PYEXE="
if exist "%ROOT%.mvhub-runtime\python.txt" set /p PYEXE=<"%ROOT%.mvhub-runtime\python.txt"
if defined PYEXE if not exist "%PYEXE%" set "PYEXE="
if defined PYEXE (
  "%PYEXE%" "%ROOT%tools\server_move_easy.py" undo-out %*
) else (
  call "%ROOT%run_py.bat" "%ROOT%tools\server_move_easy.py" undo-out %*
)
echo.
pause

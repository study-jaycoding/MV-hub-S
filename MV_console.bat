@echo off
REM ============================================================================
REM  MV Hub - server console window (run on the SERVER PC)
REM  Asks for administrator rights once, then opens the tkinter window.
REM  Uses only the verified Python in .mvhub-runtime\python.txt (register_autostart).
REM  That Python asks for the approval itself: no shell program is looked up through
REM  PATH or an inherited SystemRoot. Details: docs\SERVER.md (server console)
REM ============================================================================
setlocal
set "ROOT=%~dp0"
cd /d "%ROOT%"
REM Python honours __PYVENV_LAUNCHER__ even with -I: it would change sys.executable.
set "__PYVENV_LAUNCHER__="
set "PYEXE="
if exist "%ROOT%.mvhub-runtime\python.txt" set /p PYEXE=<"%ROOT%.mvhub-runtime\python.txt"
if not defined PYEXE goto :nopython
if not exist "%PYEXE%" goto :nopython
set "HOME="
set "TCLLIBPATH="
set "TCL_LIBRARY="
set "TK_LIBRARY="
"%PYEXE%" -I "%ROOT%tools\server_console\main.py" --check
if errorlevel 1 (
  echo [error] The server console cannot start: tkinter is not available in %PYEXE%
  pause
  exit /b 1
)
"%PYEXE%" -I "%ROOT%tools\server_console\main.py" --launch
if errorlevel 1 (
  echo [error] The server console was not opened: administrator approval was declined or failed.
  pause
  exit /b 1
)
exit /b 0

:nopython
echo [error] .mvhub-runtime\python.txt is missing or points to a missing Python.
echo         Run register_autostart.bat once on the server PC first.
pause
exit /b 1

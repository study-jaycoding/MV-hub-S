@echo off
chcp 65001 >nul
REM Clean operational log viewer. Shows structured lifecycle/generation/error events
REM instead of raw HTTP access noise. Ctrl+C to stop following.
setlocal
set "ROOT=%~dp0"
call "%ROOT%run_py.bat" "%ROOT%tools\log_viewer.py"
if errorlevel 1 pause
exit /b %errorlevel%

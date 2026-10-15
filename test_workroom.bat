@echo off
setlocal EnableExtensions
chcp 65001 >nul
cd /d "%~dp0" || exit /b 1
REM Standard-library bootstrap only. Dependencies are never installed here.
if exist "%~dp0.venv\Scripts\python.exe" (
  "%~dp0.venv\Scripts\python.exe" "%~dp0tools\workroom.py" %*
) else (
  py -3 "%~dp0tools\workroom.py" %*
)
set "WORKROOM_EXIT=%ERRORLEVEL%"
if not "%WORKROOM_EXIT%"=="0" if not defined MVHUB_WORKROOM_CHILD_OPTIONS pause
exit /b %WORKROOM_EXIT%

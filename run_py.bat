@echo off
REM Helper: resolve the project's python and run the given script.
REM Usage: run_py.bat path\to\script.py [args...]
setlocal
set "ROOT=%~dp0"
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
  echo [ERROR] Python not found.
  exit /b 1
)
"%PYEXE%" %*
exit /b %errorlevel%

@echo off
chcp 65001 >nul
setlocal EnableDelayedExpansion
set "ROOT=%~dp0"
if "%PORT%"=="" set "PORT=8010"

if not exist "%ROOT%restart_server_task.ps1" (
  echo [ERROR] restart_server_task.ps1 is missing.
  exit /b 1
)

powershell -NoProfile -Command "if (([Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent())).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { exit 0 } else { exit 1 }" >nul 2>nul
if errorlevel 1 (
  echo Requesting administrator rights to restart the shared server...
  set "MVHUB_ELEVATE_FILE=%~f0"
  powershell -NoProfile -Command "$p=Start-Process -FilePath $env:MVHUB_ELEVATE_FILE -Verb RunAs -Wait -PassThru; exit $p.ExitCode"
  exit /b !errorlevel!
)

powershell -NoProfile -ExecutionPolicy Bypass -File "%ROOT%restart_server_task.ps1" -Port %PORT%
set "RC=%errorlevel%"
if not "%CONTENT_HUB_NO_PAUSE%"=="1" pause
exit /b %RC%

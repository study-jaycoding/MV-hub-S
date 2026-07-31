@echo off
chcp 65001 >nul
setlocal EnableExtensions
REM ============================================================================
REM  MV Hub - PREDEPLOY TEST AGENT
REM
REM  Run this AFTER test_predeploy.bat (the hub on 127.0.0.1:8011).
REM  This window keeps the generation agent running: the hub's Generate button
REM  sends jobs here, and this agent runs them on YOUR local Higgsfield CLI.
REM
REM  Stop: close this window (the hub keeps running).
REM ============================================================================

set "ROOT=%~dp0"
set "HUB=http://127.0.0.1:8011"

set "PYEXE="
for /f "delims=" %%p in ('where python 2^>nul') do (
  echo %%p | findstr /i "\\WindowsApps\\python.exe" >nul || if not defined PYEXE set "PYEXE=%%p"
)
if not defined PYEXE (
  echo.
  echo [ERROR] Python not found.
  pause
  exit /b 1
)

echo.
echo ============================================================
echo  MV Hub predeploy test agent
echo  Hub    : %HUB%  (start test_predeploy.bat first)
echo  Account: admin@millionvolt.com
echo  Stop   : close this window
echo ============================================================
echo.

"%PYEXE%" "%ROOT%agent_push.py" --server %HUB% --email admin@millionvolt.com --password LocalTest2026! --watch 30

echo.
echo [stopped] Agent exited.
pause

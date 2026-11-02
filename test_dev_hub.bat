@echo off
chcp 65001 >nul
setlocal EnableExtensions
REM ============================================================================
REM  MV Hub - LOCAL HUB SCREENS with live reload   run on YOUR OWN PC
REM
REM  test_dev.bat runs in server mode, so hub-only screens never appear on 5173:
REM  admin window update tab, super admin, workspace switch, canvas keep/load.
REM  This adds a second set next to it and leaves 5173 and 8012 alone:
REM    - local hub (AUTH off):  127.0.0.1:8013, data in backend\data_hub_dev
REM    - Vite live frontend:    http://localhost:5273 (moves if Windows reserves it)
REM    - shared server:         the test_dev backend on 8012 - start test_dev.bat first
REM
REM  Log in with the SAME account as 5173: the 8012 agent follows the last account it
REM  sees and submits that account's pending requests for real. Shared data goes
REM  through 8012 into backend\data_test. Canvas scenes stay in this hub, apart from 5173.
REM  The hub process sends HTTP beyond this PC, the media CDN and Higgsfield to a dead
REM  proxy and refuses direct LAN connections, so it cannot reach the real team server.
REM  No generation agent runs here: Generate only queues in this hub.
REM  NAS folders are not blocked. Details: tools\dev_hub.py
REM
REM  Stop: close this window. Only this hub and Vite stop.
REM ============================================================================
set "ROOT=%~dp0"
if "%MVHUB_SESSION_GUARDED%"=="1" goto :guarded

py -3 --version >nul 2>nul || (echo [ERROR] Python launcher py not found. & pause & exit /b 1)

REM run_agent_session.py names its single-run lock after CONTENT_HUB_PORT.
set "CONTENT_HUB_PORT=8013"
set "VITE_PORT=5273"
for /f "usebackq delims=" %%p in (`powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "%ROOT%tools\pick_dev_port.ps1" -Preferred %VITE_PORT%`) do set "VITE_PORT=%%p"

REM Stop here if anything holds these ports. This launcher never closes another program.
for %%p in (%CONTENT_HUB_PORT% %VITE_PORT%) do (
  netstat -ano | findstr "LISTENING" | findstr /c:":%%p " >nul && (
    echo [ERROR] Port %%p is in use. Close the previous test_dev_hub window, then run this file again.
    pause
    exit /b 1
  )
)

REM Same kill-on-close Job Object as MV_agent.bat: closing this window stops the hub and Vite.
py -3 "%ROOT%run_agent_session.py" "%~f0"
set "SESSION_EXIT=%ERRORLEVEL%"
if not "%SESSION_EXIT%"=="0" pause
exit /b %SESSION_EXIT%

:guarded
py -3 "%ROOT%tools\dev_hub.py" --port %CONTENT_HUB_PORT% --vite-port %VITE_PORT%
exit /b %ERRORLEVEL%

@echo off
chcp 65001 >nul
REM ============================================================================
REM  MV Hub - DEV (hot reload) for the test setup   run on YOUR OWN PC
REM
REM  Frontend edits show INSTANTLY at http://localhost:5173 (Vite HMR) - no
REM  rebuild, no refresh. Data / API / generation come from test_agent.bat
REM  (port 8012) through Vite's proxy.
REM
REM  How to use:
REM    1) start test_agent.bat   (backend 8012: copied DB + generation)
REM    2) start this file        (frontend hot reload on 5173; browser opens)
REM
REM  Only FRONTEND (.tsx/.css) edits are live. Backend (.py) edits still need
REM  test_agent.bat restarted - this app cannot auto-reload the backend
REM  (uvicorn --reload breaks the generation CLI subprocess).
REM
REM  Stop: close this window (stops the dev server; 8012 keeps running).
REM ============================================================================
setlocal
set "ROOT=%~dp0"
REM Point Vite's /api, /ws, /media proxy at the test backend (test_agent = 8012).
set "BACKEND=http://127.0.0.1:8012"

where npm.cmd >nul 2>nul || (echo [ERROR] Node.js/npm not found - install from nodejs.org. & pause & exit /b 1)

cd /d "%ROOT%frontend" || (echo [ERROR] frontend folder not found. & pause & exit /b 1)
if not exist node_modules (
  echo [setup] installing frontend packages ^(first time, a few minutes^)...
  call npm.cmd install || (echo [ERROR] npm install failed. & pause & exit /b 1)
)

echo.
echo [DEV HOT RELOAD]  frontend = http://localhost:5173    api/data = %BACKEND%
echo   Edit .tsx/.css and save -^> the page updates instantly.
echo   Backend (.py) changes still need test_agent.bat restarted.
echo   Stop: close this window.
echo.

REM --open makes Vite open the browser once the dev server is ready.
call npm.cmd run dev -- --open

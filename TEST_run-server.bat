@echo off
chcp 65001 >nul
REM ============================================================================
REM  MV Hub - SERVER TEST launcher   (run ON THE SERVER, inside the test clone)
REM
REM  Starts the TEST server on port 8011, bound to ALL interfaces so your
REM  local PC can open it at  http://<server-ip>:8011  (use TEST_open.bat).
REM
REM  Isolated from the live service (which stays on 8010):
REM    - PORT 8011
REM    - data = THIS folder's backend\data  (a COPY of live; use
REM             TEST_refresh-db.bat to snapshot the live DB into here)
REM    - NO_PROXY = fully standalone (never forwards to the live server)
REM    - MANAGE   = 1 (PM dashboard ON for testing)
REM    - AUTH     = 1 (login required; the copied DB has the real accounts)
REM
REM  Steps on the server:
REM    1) TEST_refresh-db.bat   (copy live DB -> this test DB)
REM    2) TEST_run-server.bat   (this file)   -> serves 8011
REM  Stop: Ctrl+C then Y.
REM ============================================================================
setlocal
set "HOST=0.0.0.0"
set "PORT=8011"
REM Login required by default. Set 0 ONLY for loopback tests (0 on a LAN address
REM is refused unless CONTENT_HUB_ALLOW_REMOTE_AUTH_OFF=1).
if "%CONTENT_HUB_AUTH%"=="" set "CONTENT_HUB_AUTH=1"
REM PM dashboard ON for testing (live keeps it OFF until ready).
set "CONTENT_HUB_MANAGE=1"
REM Fully standalone: never proxy /api/manage/* to the live server. Without this,
REM the copied DB can re-establish a shared_server_token on login and forward.
set "CONTENT_HUB_NO_PROXY=1"

echo.
echo [SERVER TEST] host=%HOST% port=%PORT% auth=%CONTENT_HUB_AUTH% manage=1 proxy=off
echo             data = %~dp0backend\data   (copy of live; refresh to update)
echo             open from your PC: http://^<server-ip^>:%PORT%   (or use TEST_open.bat)
echo.

REM Reuse the shared server launcher (builds frontend, auto-restart, serve.py).
call "%~dp0run-server.bat"

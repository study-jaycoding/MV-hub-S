@echo off
chcp 65001 >nul
REM ============================================================================
REM  MV Hub - worker LOCAL launcher (MV_agent)
REM
REM  One double-click does:
REM    1) Start a LOCAL hub on this PC (127.0.0.1). The hub asks you to LOG IN
REM       with your TEAM account (the one admin created on the shared server).
REM       Assets (local-folder browsing), reveal and generation all run on THIS
REM       PC (no remote-server path problems).
REM    2) Check Higgsfield CLI login (needed for generation; token stays local).
REM    3) Open the local hub in your browser -> log in to your team server.
REM    4) Keep a generation agent running so the hub's generate/regenerate
REM       buttons run on your local CLI, and results are pushed to the team
REM       server DB under YOUR account (server-direct: the server is the single
REM       source of truth for data). "Share" just flips a generation to
REM       team-visible; your own work stays private until then.
REM
REM  Team shared-server address has a baked-in default (admins can change it in
REM  the hub's admin window). To override here, uncomment and edit:
REM  set "CONTENT_HUB_SHARED_URL=http://192.168.1.199:8010"
REM
REM  Stop: close this one window - both the hub and the agent stop.
REM ============================================================================
setlocal
REM Force Python/pip to UTF-8 (avoid Korean Windows cp949 UnicodeDecodeError on pip install).
set "PYTHONUTF8=1"
set "ROOT=%~dp0"
if "%PORT%"=="" set "PORT=8010"
REM Local hub backend has no login of its own; the team-server login gate guards the UI.
set "CONTENT_HUB_AUTH=0"
REM Show the manage (PM dashboard) button on the local hub too. Manage DATA is proxied
REM to the shared server; access is still gated by each account's global role. Set 0 to hide.
if "%CONTENT_HUB_MANAGE%"=="" set "CONTENT_HUB_MANAGE=1"
set "CONTENT_HUB_HOST=127.0.0.1"
set "CONTENT_HUB_PORT=%PORT%"
set "HUB=http://127.0.0.1:%PORT%"

REM Prefer tools bundled with the release package. This keeps worker PCs close to
REM zero-install: no Git, no system Python, no system Node needed for normal use.
if exist "%ROOT%runtime\node\node.exe" set "PATH=%ROOT%runtime\node;%PATH%"
if exist "%ROOT%runtime\higgsfield\higgsfield.cmd" set "PATH=%ROOT%runtime\higgsfield;%PATH%"

REM Resolve a REAL Python. Release packages may include runtime\python so workers do
REM not need to install Python. The Microsoft Store "python.exe" fake stub is ignored.
set "PY_EXE="
set "PY_ARGS="
if exist "%ROOT%runtime\python\python.exe" (
  set "PY_EXE=%ROOT%runtime\python\python.exe"
  goto :py_resolved
)
py -3 --version >nul 2>nul && (set "PY_EXE=py" & set "PY_ARGS=-3")
if defined PY_EXE goto :py_resolved
python --version 2>nul | findstr /b /c:"Python 3" >nul && set "PY_EXE=python"
:py_resolved
if not defined PY_EXE (
  echo [ERROR] No real Python found ^(the Microsoft Store stub does not count^).
  echo         Fix: download the latest MV Hub release, or install Python from python.org
  echo         and turn OFF Settings ^> Apps ^> App execution aliases ^> python.exe / python3.exe
  pause
  exit /b 1
)
echo     Using Python: "%PY_EXE%" %PY_ARGS%

set "HAVE_NPM="
set "NPM_CMD="
where npm.cmd >nul 2>nul && (set "HAVE_NPM=1" & set "NPM_CMD=npm.cmd")

echo.
echo [1/5] Preparing frontend...
cd /d "%ROOT%frontend" || goto :err
if not exist dist (
  if not defined HAVE_NPM (
    echo [ERROR] frontend\dist is missing and Node.js/npm is not installed.
    echo         Release packages should already contain frontend\dist.
    pause
    exit /b 1
  )
  if not exist node_modules (
    echo     node_modules missing - running npm install ^(first time, a few minutes^)
    call %NPM_CMD% install || goto :err
  )
  echo     dist missing - building once. ^(Use update_git.bat to refresh later.^)
  call %NPM_CMD% run build || goto :err
  goto :frontend_ready
)
:frontend_ready

echo [2/5] Checking backend dependencies...
REM Install when EITHER a package is missing OR requirements.txt changed since the last
REM successful install. The import-only check is a fast path, but it cannot see version
REM drift: after a release update bumps requirements.txt, old packages still import fine
REM and the hub would silently run on stale versions. The hash marker closes that gap.
set "REQ=%ROOT%backend\requirements.txt"
set "DEP_MARK=%ROOT%backend\.deps_installed"
set "REQ_HASH="
for /f "skip=1 delims=" %%h in ('certutil -hashfile "%REQ%" MD5 2^>nul') do if not defined REQ_HASH set "REQ_HASH=%%h"
set "OLD_HASH="
if exist "%DEP_MARK%" set /p OLD_HASH=<"%DEP_MARK%"
set "NEED_DEPS="
"%PY_EXE%" %PY_ARGS% -c "import fastapi, uvicorn, pydantic, websockets, multipart, PIL" >nul 2>nul || set "NEED_DEPS=1"
if not "%REQ_HASH%"=="%OLD_HASH%" set "NEED_DEPS=1"
if defined NEED_DEPS (
  echo     Installing/updating backend Python packages...
  "%PY_EXE%" %PY_ARGS% -m pip install -r "%REQ%" || goto :err
  if defined REQ_HASH (> "%DEP_MARK%" echo %REQ_HASH%)
)

echo [3/5] Starting local hub ^(background; log: backend\hub.log^)  %HUB%
REM Stop any hub left running on this port from a previous launch. Without this, an old
REM backend process keeps the port and the freshly-updated code never takes effect
REM (symptom: code updates do not apply until the machine reboots).
for /f "tokens=5" %%p in ('netstat -ano ^| findstr "LISTENING" ^| findstr ":%PORT%"') do taskkill /f /pid %%p >nul 2>nul
REM Run the hub in the background of THIS window (no separate window). Its log goes to a
REM file so this one window stays clean and shows the agent. Closing this window stops both.
cd /d "%ROOT%backend"
start "" /b cmd /c ""%PY_EXE%" %PY_ARGS% serve.py > hub.log 2>&1"
cd /d "%ROOT%"

echo     Waiting for the hub to come up...
set /a _tries=0
:waitloop
set /a _tries+=1
curl -fsS -o nul "%HUB%/api/health" 2>nul && goto :hubup
if %_tries% geq 40 (echo [warn] hub is slow to respond - continuing anyway. & goto :hubup)
timeout /t 1 /nobreak >nul
goto :waitloop
:hubup

echo [4/5] Checking Higgsfield CLI login...
set "RUN_AGENT=1"
set "HF=higgsfield"
where higgsfield >nul 2>nul || set "HF=hf"
where %HF% >nul 2>nul
if errorlevel 1 (
  if defined HAVE_NPM (
    echo     Higgsfield CLI not installed - installing via npm...
    call %NPM_CMD% install -g @higgsfield/cli
    if errorlevel 1 (
      echo [warn] CLI install failed - generation off, but browsing/Assets still work.
      set "RUN_AGENT=0"
      goto :skip_higgsfield
    )
    set "HF=higgsfield"
  ) else (
    echo [warn] Higgsfield CLI not found, and Node.js/npm is not installed.
    echo        Browsing/Assets will work, but generation sync is off until Higgsfield CLI is installed.
    set "RUN_AGENT=0"
    goto :skip_higgsfield
  )
)
call %HF% account status >nul 2>nul
if errorlevel 1 (
  echo     Login required - follow the prompts to sign in to your Higgsfield account.
  call %HF% auth login
)
echo.
echo  ===========================================================================
echo   YOUR HIGGSFIELD CLI ACCOUNT (verify FIRST) - shown below.
echo   Log in to the hub with the SAME email. Your generations are pushed to the
echo   team server under that account; a different hub login will be REJECTED.
echo   If they differ, the running agent will OFFER to switch the CLI account
echo   for you (answer y) - no separate login script needed.
echo  ===========================================================================
call %HF% account status
echo  ===========================================================================
echo.

:skip_higgsfield
echo [5/5] Opening the hub + keeping the generation agent running ^(closing this window stops it^)
start "" "%HUB%"
echo.
if "%RUN_AGENT%"=="1" (
  "%PY_EXE%" %PY_ARGS% "%ROOT%agent_push.py" --server %HUB% --token local --watch 30
) else (
  echo [info] Generation agent is not running because Higgsfield CLI is not available.
  echo [info] The local hub is open. Close this window to stop the local hub.
  pause
)
echo.
echo [stopped] agent stopped. Closing this window stops the hub too.
pause
exit /b 0

:err
echo.
echo [ERROR] a step above failed - aborting.
pause
exit /b 1

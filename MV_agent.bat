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
REM Normal local hubs use the team-server login gate and need no local login. Isolated
REM test_dev may override this to 1 so a copied multi-user DB keeps account boundaries.
if "%CONTENT_HUB_AUTH%"=="" set "CONTENT_HUB_AUTH=0"
REM Show the manage (PM dashboard) button on the local hub too. Manage DATA is proxied
REM to the shared server; access is still gated by each account's global role. Set 0 to hide.
if "%CONTENT_HUB_MANAGE%"=="" set "CONTENT_HUB_MANAGE=1"
set "CONTENT_HUB_HOST=127.0.0.1"
set "CONTENT_HUB_PORT=%PORT%"
set "HUB=http://127.0.0.1:%PORT%"
REM Normal launches open the built app served by the hub. Development launchers may
REM override only the browser URL (for example Vite on 5173) while keeping HUB as the
REM backend/agent endpoint.
if "%MVHUB_OPEN_URL%"=="" set "MVHUB_OPEN_URL=%HUB%"

REM Prefer tools bundled with the release package. This keeps worker PCs close to
REM zero-install: no Git, no system Python, no system Node needed for normal use.
if exist "%ROOT%runtime\node\node.exe" set "PATH=%ROOT%runtime\node;%PATH%"
REM NOTE: the bundled Higgsfield CLI is intentionally NOT prepended here. A stale
REM bundle would shadow a correct global install. The [4/5] step below picks the CLI
REM whose version matches hf_cli_version.txt and only then puts that one on PATH.

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
    echo     node_modules missing - restoring locked packages ^(npm ci^)
    call %NPM_CMD% ci --include=dev --no-audit --no-fund || goto :err
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

echo [3/5] Selecting the pinned Higgsfield CLI ^(before the hub starts^)...
REM Do this BEFORE launching the hub: serve.py inherits PATH at start and cli_bridge
REM resolves the CLI via shutil.which. Selecting/adding the CLI only after the hub
REM started would leave the hub (model list/cost/workspace APIs) blind to a bundled
REM CLI on release PCs.
set "RUN_AGENT=1"
set "HF="
set "HF_CLI_VERSION="
if exist "%ROOT%hf_cli_version.txt" set /p HF_CLI_VERSION=<"%ROOT%hf_cli_version.txt"
REM trim stray leading/trailing spaces a re-saved pin file might add.
for /f "tokens=* delims= " %%x in ("%HF_CLI_VERSION%") do set "HF_CLI_VERSION=%%x"
set "BUNDLED=%ROOT%runtime\higgsfield\higgsfield.cmd"
if not defined HF_CLI_VERSION (
  echo [warn] hf_cli_version.txt missing/empty - generation off for safety; browsing still works.
  goto :cli_selected
)
REM Pick the CLI whose version == the pin: prefer the bundled copy (zero-install),
REM then a matching global install, else install the pinned version globally.
REM @latest is intentionally avoided: Higgsfield ships breaking changes often.
if exist "%BUNDLED%" call :try_cli "%BUNDLED%"
where higgsfield >nul 2>nul && call :try_cli "higgsfield"
if not defined HF if defined HAVE_NPM (
  echo     Installing pinned Higgsfield CLI @%HF_CLI_VERSION% ^(one time^)...
  call %NPM_CMD% install -g @higgsfield/cli@%HF_CLI_VERSION%
  where higgsfield >nul 2>nul && call :try_cli "higgsfield"
)
:cli_selected
if defined HF (
  echo     Using Higgsfield CLI %HF_CLI_VERSION%: %HF%
  REM Global installs are already on PATH; a bundled match must be prepended here so
  REM BOTH the hub (started next) and agent_push resolve the same pinned CLI.
  if /i "%HF%"=="%BUNDLED%" set "PATH=%ROOT%runtime\higgsfield;%PATH%"
) else (
  echo [warn] No pinned Higgsfield CLI available - generation off; browsing/Assets still work.
  set "RUN_AGENT=0"
)

echo [4/5] Starting local hub ^(background; log: backend\hub.log^)  %HUB%
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
if %_tries% geq 40 (
  if defined MVHUB_DEV_FRONTEND_DIR (
    echo [ERROR] Test backend did not become healthy. Vite will not be started.
    goto :err
  )
  echo [warn] hub is slow to respond - continuing anyway.
  goto :hubup
)
timeout /t 1 /nobreak >nul
goto :waitloop
:hubup

REM test_dev hook: only the isolated live-development launcher defines these values.
REM Start Vite AFTER the backend health check so an already-open 5173 tab can never
REM reconnect while 8012 is still unavailable. Normal MV_agent launches are unchanged.
if defined MVHUB_DEV_FRONTEND_DIR (
  call :start_dev_frontend
  if errorlevel 1 goto :err
)

REM --- Code/CLI version gate (after hub up so the proxying hub can reach the shared server). ---
REM The hub compares our code pin (hf_cli_version.txt) to the server's expected CLI version. If they
REM differ, our CODE is behind the team server; updating only the CLI would break stale code (1.x
REM renamed flags), so generation stays OFF until the code is updated. Server unreachable / standalone
REM / old hub without the endpoint -> empty output -> proceed (offline-safe).
"%PY_EXE%" %PY_ARGS% -c "import urllib.request,json,sys; d=json.loads(urllib.request.urlopen(sys.argv[1]+'/api/cli-check',timeout=10).read().decode()); print(d.get('status',''))" "%HUB%" > "%TEMP%\mvhub_clichk.txt" 2>nul
set "_CLICHK="
if exist "%TEMP%\mvhub_clichk.txt" set /p _CLICHK=<"%TEMP%\mvhub_clichk.txt"
del "%TEMP%\mvhub_clichk.txt" >nul 2>nul
if /i "%_CLICHK%"=="code_stale" (
  echo.
  echo  [action needed] Your code is behind the team server ^(it expects a different CLI version^).
  echo  Generation is OFF until you update your code. Run:  update_git.bat   then re-run MV_agent.bat.
  echo  ^(Updating only the CLI is unsafe - old code can break on a newer CLI.^)
  echo.
  set "RUN_AGENT=0"
  goto :agent_stage
)

REM --- Higgsfield login + workspace (AFTER the hub is up; interactive). ---
if not defined HF goto :agent_stage
call "%HF%" auth token >nul 2>nul
if errorlevel 1 (
  echo     Login required - a browser window will open to sign in to Higgsfield.
  call "%HF%" auth login
)
REM CLI 1.x requires a selected workspace; generate fails (rc!=0) without one.
REM When NONE is selected, default to the shared (non-personal) workspace - this is a team tool.
REM Only kicks in if nothing is chosen yet - an existing choice (incl. personal) is respected.
REM 'team' AND 'enterprise' plans both count as shared (enterprise upgrade broke the old
REM plan_type=='team' filter and new installs fell through to the manual prompt).
REM Falls back to the single workspace. Multiple shared candidates -> ask below (avoid wrong billing).
"%PY_EXE%" %PY_ARGS% -c "import subprocess,sys,json; hf=sys.argv[1]; r=subprocess.run([hf,'workspace','list','--json'],capture_output=True,text=True); ws=json.loads(r.stdout or '[]') if r.returncode==0 else []; ws=ws if isinstance(ws,list) else []; sel=any(w.get('is_selected') for w in ws); shared=[w for w in ws if str(w.get('plan_type') or '').lower() not in ('', 'free', 'private', 'personal')]; pick=(shared[0] if len(shared)==1 else (ws[0] if len(ws)==1 else None)); (not sel and pick) and subprocess.run([hf,'workspace','set',pick['id']])" "%HF%" >nul 2>nul
call "%HF%" account status >nul 2>nul
if errorlevel 1 (
  echo.
  echo  [action needed] No Higgsfield workspace selected - generation is OFF until you set one:
  call "%HF%" workspace list
  echo     run:  higgsfield workspace set [id]   then re-run MV_agent.bat.
  echo.
  set "RUN_AGENT=0"
) else (
  echo.
  echo  ===========================================================================
  echo   YOUR HIGGSFIELD CLI ACCOUNT ^(verify FIRST^) - shown below.
  echo   Log in to the hub with the SAME email. Your generations are pushed to the
  echo   team server under that account; a different hub login will be REJECTED.
  echo   If they differ, the running agent will OFFER to switch the CLI account
  echo   for you ^(answer y^) - no separate login script needed.
  echo  ===========================================================================
  call "%HF%" account status
  echo  ===========================================================================
  echo.
)

:agent_stage
echo [5/5] Opening the app + keeping the generation agent running ^(closing this window stops it^)
echo     Browser: %MVHUB_OPEN_URL%
start "" "%MVHUB_OPEN_URL%"
echo.
if "%RUN_AGENT%"=="1" (
  if not "%CONTENT_HUB_LOCAL_AGENT_PAIR_SECRET%"=="" (
    echo [login] Waiting for the browser login - no CMD email/password input is needed.
    "%PY_EXE%" %PY_ARGS% "%ROOT%agent_push.py" --server %HUB% --pair-secret "%CONTENT_HUB_LOCAL_AGENT_PAIR_SECRET%" --watch 30
  ) else if "%CONTENT_HUB_AUTH%"=="1" (
    echo [login] The browser and generation agent must use the same account.
    "%PY_EXE%" %PY_ARGS% "%ROOT%agent_push.py" --server %HUB% --email "%MVHUB_AGENT_EMAIL%" --watch 30
  ) else (
    "%PY_EXE%" %PY_ARGS% "%ROOT%agent_push.py" --server %HUB% --token local --watch 30
  )
) else (
  echo [info] Generation agent is not running - see the reason shown above.
  echo [info] The local hub is open. Close this window to stop the local hub.
  pause
)
echo.
echo [stopped] agent stopped. Closing this window stops the hub too.
pause
call :stop_dev_frontend
exit /b 0

REM ---------------------------------------------------------------------------
REM test_dev-only Vite lifecycle. The backend is already healthy when this runs.
REM ---------------------------------------------------------------------------
:start_dev_frontend
if "%MVHUB_DEV_FRONTEND_PORT%"=="" (
  echo [ERROR] MVHUB_DEV_FRONTEND_PORT is missing.
  exit /b 1
)
if "%MVHUB_DEV_FRONTEND_HOST%"=="" set "MVHUB_DEV_FRONTEND_HOST=127.0.0.1"
echo [dev] Backend is healthy. Starting Vite on %MVHUB_OPEN_URL% ...
cd /d "%MVHUB_DEV_FRONTEND_DIR%" || exit /b 1
set "_DEV_VITE_PID="
set "_DEV_EXISTING_PID="
for /f "tokens=5" %%p in ('netstat -ano ^| findstr "LISTENING" ^| findstr /c:":%MVHUB_DEV_FRONTEND_PORT% "') do if not defined _DEV_EXISTING_PID set "_DEV_EXISTING_PID=%%p"
if defined _DEV_EXISTING_PID (
  echo [ERROR] Port %MVHUB_DEV_FRONTEND_PORT% is already in use by PID %_DEV_EXISTING_PID%.
  echo [ERROR] Stop the existing process and run test_dev.bat again.
  set "_DEV_EXISTING_PID="
  cd /d "%ROOT%"
  exit /b 1
)
start "" /b cmd /d /c "npm.cmd run dev -- --host %MVHUB_DEV_FRONTEND_HOST% --port %MVHUB_DEV_FRONTEND_PORT% --strictPort"
set /a _DEV_VITE_TRIES=0
:wait_dev_frontend
set /a _DEV_VITE_TRIES+=1
curl -fsS -o nul "%MVHUB_OPEN_URL%" 2>nul && goto :dev_frontend_ready
if %_DEV_VITE_TRIES% geq 30 goto :dev_frontend_error
timeout /t 1 /nobreak >nul
goto :wait_dev_frontend

:dev_frontend_ready
for /f "tokens=5" %%p in ('netstat -ano ^| findstr "LISTENING" ^| findstr /c:":%MVHUB_DEV_FRONTEND_PORT% "') do if not defined _DEV_VITE_PID set "_DEV_VITE_PID=%%p"
set "_DEV_EXISTING_PID="
cd /d "%ROOT%"
exit /b 0

:dev_frontend_error
echo [ERROR] Vite did not start on %MVHUB_OPEN_URL%.
call :stop_dev_frontend
cd /d "%ROOT%"
exit /b 1

:stop_dev_frontend
if defined _DEV_VITE_PID taskkill /f /t /pid %_DEV_VITE_PID% >nul 2>nul
set "_DEV_VITE_PID="
exit /b 0

REM ---------------------------------------------------------------------------
REM :try_cli  %1 = a Higgsfield CLI (quoted path or bare name).
REM Sets HF=%~1 only if that CLI reports the pinned version. No-op once HF is set.
REM Used to choose the exact binary matching hf_cli_version.txt (avoids the stale
REM bundled-CLI shadowing a good global install, and vice-versa).
REM ---------------------------------------------------------------------------
:try_cli
if defined HF exit /b 0
set "_CLIVER="
for /f "usebackq tokens=2" %%v in (`"%~1" version 2^>nul`) do if not defined _CLIVER set "_CLIVER=%%v"
if "%_CLIVER%"=="%HF_CLI_VERSION%" set "HF=%~1"
exit /b 0

:err
call :stop_dev_frontend
echo.
echo [ERROR] a step above failed - aborting.
pause
exit /b 1

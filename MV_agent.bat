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
set "CONTENT_HUB_HOST=127.0.0.1"
set "CONTENT_HUB_PORT=%PORT%"
set "HUB=http://127.0.0.1:%PORT%"

REM Resolve a REAL Python. The Microsoft Store "python.exe" is a fake stub that just
REM prints "Python" and exits - it makes serve.py and the agent silently do nothing.
REM Prefer the 'py' launcher (never shadowed by the Store alias); else a real python3.
set "PY="
py -3 --version >nul 2>nul && set "PY=py -3"
if defined PY goto :py_resolved
python --version 2>nul | findstr /b /c:"Python 3" >nul && set "PY=python"
:py_resolved
if not defined PY (
  echo [ERROR] No real Python found ^(the Microsoft Store stub does not count^).
  echo         Fix: run setup_and_clone_mvhub.bat, or install Python from python.org
  echo         and turn OFF Settings ^> Apps ^> App execution aliases ^> python.exe / python3.exe
  pause
  exit /b 1
)
echo     Using Python: %PY%
where npm    >nul 2>nul || (echo [ERROR] Node.js/npm not found - install from nodejs.org and retry. & pause & exit /b 1)

echo.
echo [1/5] Preparing frontend...
cd /d "%ROOT%frontend" || goto :err
if not exist node_modules (
  echo     node_modules missing - running npm install ^(first time, a few minutes^)
  call npm install || goto :err
)
if not exist dist (
  echo     dist missing - building once. ^(Use update.bat to refresh later.^)
  call npm run build || goto :err
)

echo [2/5] Checking backend dependencies...
%PY% -m pip install -r "%ROOT%backend\requirements.txt" >nul 2>nul

echo [3/5] Starting local hub ^(background; log: backend\hub.log^)  %HUB%
REM Stop any hub left running on this port from a previous launch. Without this, an old
REM backend process keeps the port and the freshly-updated code never takes effect
REM (symptom: code updates do not apply until the machine reboots).
for /f "tokens=5" %%p in ('netstat -ano ^| findstr "LISTENING" ^| findstr ":%PORT%"') do taskkill /f /pid %%p >nul 2>nul
REM Run the hub in the background of THIS window (no separate window). Its log goes to a
REM file so this one window stays clean and shows the agent. Closing this window stops both.
cd /d "%ROOT%backend"
start "" /b cmd /c "%PY% serve.py > hub.log 2>&1"
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
set "HF=higgsfield"
where higgsfield >nul 2>nul || set "HF=hf"
where %HF% >nul 2>nul
if errorlevel 1 (
  echo     Higgsfield CLI not installed - installing via npm...
  call npm install -g @higgsfield/cli || (echo [warn] CLI install failed - generation off, but browsing/Assets still work.)
  set "HF=higgsfield"
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
echo  ===========================================================================
call %HF% account status
echo  ===========================================================================
echo.

echo [5/5] Opening the hub + keeping the generation agent running ^(closing this window stops it^)
start "" "%HUB%"
echo.
%PY% "%ROOT%push_agent.py" --server %HUB% --token local --watch 30
echo.
echo [stopped] agent stopped. Closing this window stops the hub too.
pause
exit /b 0

:err
echo.
echo [ERROR] a step above failed - aborting.
pause
exit /b 1

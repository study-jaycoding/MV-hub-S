@echo off
chcp 65001 >nul
REM ============================================================================
REM  MV Hub - update launcher
REM
REM  Pulls the latest program from git and refreshes only what actually changed:
REM  backend deps are reinstalled only when requirements.txt changed (or missing),
REM  the frontend is rebuilt only when frontend/ changed (or no build exists yet).
REM  The Higgsfield CLI is NOT touched here - manage it with update_cli.bat when needed.
REM
REM  After this:  server PC -> MV_server.bat,  worker PC -> MV_agent.bat
REM  Requires: this folder must be a git clone (git clone <repo>).
REM ============================================================================
setlocal enabledelayedexpansion
REM Force Python/pip to UTF-8 so reading files (e.g. requirements.txt) never hits the
REM Korean Windows cp949 codec (UnicodeDecodeError on non-ASCII bytes).
set "PYTHONUTF8=1"
set "ROOT=%~dp0"
cd /d "%ROOT%"
set "UPDATE_LOG=%ROOT%logs\update.log"
set "UPDATE_STAGE=preflight"
set "SERVER_RESULT=not-checked"
set "BEFORE="
set "AFTER="
if not exist "%ROOT%logs" mkdir "%ROOT%logs"
if exist "%ROOT%tools\rotate_text_log.py" call "%ROOT%run_py.bat" "%ROOT%tools\rotate_text_log.py" "%UPDATE_LOG%" --max-bytes 2097152 --keep 3 >nul 2>&1
call :write_update_log "START" "update requested"

where git >nul 2>nul || (echo [ERROR] git not found - install from git-scm.com and retry. & goto :err)
where npm.cmd >nul 2>nul || (echo [ERROR] Node.js/npm not found - run setup_clone_git.bat first. & goto :err)
if not exist "%ROOT%.git" (
  echo [ERROR] this folder is not a git clone ^(no .git^).
  echo         Get it ^(code only, skips docs/^):
  echo           git clone --filter=blob:none --sparse https://github.com/study-jaycoding/MV-hub-S.git
  echo           cd MV-hub-S ^&^& git sparse-checkout set backend frontend tools
  goto :err
)

REM Remember the commit before pulling so we can see exactly what changed.
set "BEFORE="
for /f "delims=" %%i in ('git rev-parse HEAD 2^>nul') do set "BEFORE=%%i"

echo.
echo [1/3] Pulling latest ^(git pull^)...
set "UPDATE_STAGE=git-pull"
REM Older sparse clones only included backend/frontend. Server auto-start,
REM backup and log tools live under tools/, so make that directory part of the
REM working tree before pulling. Full clones are deliberately left unchanged.
git sparse-checkout list >nul 2>nul
if not errorlevel 1 (
  git sparse-checkout add tools || (
    echo [ERROR] could not enable the required tools folder.
    goto :err
  )
)

REM Resolve all required runtimes before changing the working tree. A previous
REM updater silently skipped Python and still printed success, leaving the next
REM server boot to fail much later.
set "PYEXE="
set "PYARGS="
if exist "%ROOT%runtime\python\python.exe" set "PYEXE=%ROOT%runtime\python\python.exe"
if defined PYEXE goto :update_python_ready
py -3 --version >nul 2>nul
if not errorlevel 1 (
  set "PYEXE=py"
  set "PYARGS=-3"
)
if defined PYEXE goto :update_python_ready
python --version 2>nul | findstr /b /c:"Python 3" >nul
if not errorlevel 1 set "PYEXE=python"
:update_python_ready
if not defined PYEXE (
  echo [ERROR] Real Python 3 not found - run setup_clone_git.bat first.
  goto :err
)
node --version >nul 2>nul || (echo [ERROR] Node.js executable is not usable. & goto :err)

REM Old npm install runs may have reordered JSON keys in the tracked lock file.
REM Restore it only when parsed JSON is exactly equal to HEAD (no real edit).
if exist "%ROOT%tools\repair_package_lock.py" "!PYEXE!" !PYARGS! "%ROOT%tools\repair_package_lock.py" || goto :err
git pull --ff-only || (echo [ERROR] git pull failed - resolve local changes and retry. & goto :err)
if exist "%ROOT%tools\repair_package_lock.py" "!PYEXE!" !PYARGS! "%ROOT%tools\repair_package_lock.py" || goto :err

set "AFTER="
for /f "delims=" %%i in ('git rev-parse HEAD 2^>nul') do set "AFTER=%%i"

REM Decide what to refresh from the pulled diff (BEFORE..AFTER).
set "REQ_CHANGED="
set "FE_CHANGED="
if "!BEFORE!"=="!AFTER!" (
  echo     Already up to date - will skip unchanged steps.
) else if "!BEFORE!"=="" (
  REM Could not read the old commit - play safe and refresh everything.
  set "REQ_CHANGED=1"
  set "FE_CHANGED=1"
) else (
  for /f "delims=" %%f in ('git diff --name-only !BEFORE! !AFTER! 2^>nul') do (
    echo %%f| findstr /b /c:"backend/requirements.txt" >nul && set "REQ_CHANGED=1"
    echo %%f| findstr /b /c:"frontend/" >nul && set "FE_CHANGED=1"
  )
)

echo [2/3] Backend dependencies...
set "UPDATE_STAGE=backend-dependencies"
echo     Using Python: !PYEXE! !PYARGS!
if defined REQ_CHANGED (
  echo     requirements.txt changed - installing...
  "!PYEXE!" !PYARGS! -m pip install -r "%ROOT%backend\requirements.txt" || goto :err
) else (
  "!PYEXE!" !PYARGS! -c "import fastapi, uvicorn" 2>nul && (
    echo     unchanged - skip.
  ) || (
    echo     deps missing - installing...
    "!PYEXE!" !PYARGS! -m pip install -r "%ROOT%backend\requirements.txt" || goto :err
  )
)
"!PYEXE!" !PYARGS! -c "import fastapi,uvicorn,pydantic,websockets,multipart,PIL,watchdog" 2>nul || (
  echo [ERROR] Backend dependency verification failed after install/check.
  goto :err
)
"!PYEXE!" !PYARGS! "%ROOT%tools\verify_requirements.py" "%ROOT%backend\requirements.txt" || goto :err

echo [3/3] Frontend...
set "UPDATE_STAGE=frontend-build"
cd /d "%ROOT%frontend" || goto :err
if not exist node_modules set "FE_CHANGED=1"
if not exist "%ROOT%frontend\dist\index.html" set "FE_CHANGED=1"
if defined FE_CHANGED (
  REM Recreate exactly what package-lock.json declares. Unlike npm install this
  REM never rewrites the tracked lock file just because the npm version differs.
  echo     restoring locked packages ^(npm ci^)...
  call npm ci --include=dev --no-audit --no-fund || goto :err
  echo     building frontend...
  call npm run build || goto :err
) else (
  echo     no frontend changes - skip build.
)
cd /d "%ROOT%"

echo.
set "UPDATE_STAGE=server-restart"
set "SERVER_RESULT=not-registered"
schtasks /Query /TN "MVHub Server" >nul 2>nul
if not errorlevel 1 (
  echo [server] Registered shared server detected - applying update by restart...
  set "SERVER_RESULT=restart-failed"
  set "CONTENT_HUB_NO_PAUSE=1"
  call "%ROOT%restart_server_task.bat" || goto :err
  set "SERVER_RESULT=restarted-ready"
) else (
  echo [server] No shared-server task on this PC - no server restart needed.
)

echo.
set "UPDATE_STAGE=complete"
call :write_update_log "SUCCESS" "before=!BEFORE! after=!AFTER! server=!SERVER_RESULT!"
echo [done] updated to the latest version.
echo        - registered server: restarted and readiness-checked automatically
echo        - worker PC:         run MV_agent.bat again
echo        - Higgsfield CLI:    run update_cli.bat separately if you want to update it
pause
exit /b 0

:err
set "UPDATE_RC=!errorlevel!"
if "!UPDATE_RC!"=="0" set "UPDATE_RC=1"
call :write_update_log "FAILED" "stage=!UPDATE_STAGE! before=!BEFORE! after=!AFTER! server=!SERVER_RESULT! exit=!UPDATE_RC!"
echo.
echo [ERROR] update failed - aborting.
pause
exit /b 1

:write_update_log
ver >nul
>>"!UPDATE_LOG!" echo [!date! !time!] %~1 %~2
if errorlevel 1 echo [WARN] Could not write update history: !UPDATE_LOG!
exit /b 0

@echo off
chcp 65001 >nul
REM ============================================================================
REM  MV Hub - isolated update worker
REM
REM  Pulls the latest program from git and refreshes only what actually changed:
REM  backend deps are reinstalled only when requirements.txt changed (or missing),
REM  the frontend is rebuilt only when frontend/ changed (or no build exists yet).
REM  The Higgsfield CLI is NOT touched here - manage it with update_cli.bat when needed.
REM
REM  After this:  server PC -> MV_server.bat,  worker PC -> MV_agent.bat
REM  This file is copied to TEMP by tools\run_update_git.ps1 before execution.
REM  Requires: the supplied root folder must be a git clone (git clone <repo>).
REM ============================================================================
setlocal enabledelayedexpansion
REM Force Python/pip to UTF-8 so reading files (e.g. requirements.txt) never hits the
REM Korean Windows cp949 codec (UnicodeDecodeError on non-ASCII bytes).
set "PYTHONUTF8=1"
set "ROOT=%~1"
if not defined ROOT (
  echo [ERROR] update worker did not receive the repository path.
  exit /b 1
)
for %%i in ("%ROOT%") do set "ROOT=%%~fi"
if not "!ROOT:~-1!"=="\" set "ROOT=!ROOT!\"
cd /d "%ROOT%"
set "UPDATE_LOG=%ROOT%logs\update.log"
set "LEGACY_FRONTEND_PENDING=%ROOT%logs\frontend-build.pending"
set "LEGACY_BACKEND_PENDING=%ROOT%logs\backend-deps.pending"
set "LEGACY_ISOLATED_UPDATER_READY=%ROOT%logs\isolated-updater-v1.ready"
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

REM Recovery markers belong inside Git's own writable state directory. If git pull
REM can update this clone, this location is writable even when an operational logs
REM directory is redirected, locked, or governed by a different ACL. rev-parse also
REM resolves linked worktrees whose .git entry is a file instead of a directory.
set "GIT_DIR="
for /f "delims=" %%i in ('git rev-parse --absolute-git-dir 2^>nul') do set "GIT_DIR=%%i"
if not defined GIT_DIR (
  echo [ERROR] could not resolve the writable Git state directory.
  goto :err
)
set "UPDATE_STATE_DIR=!GIT_DIR!\mvhub-update"
set "FRONTEND_PENDING=!UPDATE_STATE_DIR!\frontend-build.pending"
set "BACKEND_PENDING=!UPDATE_STATE_DIR!\backend-deps.pending"
set "ISOLATED_UPDATER_READY=!UPDATE_STATE_DIR!\isolated-updater-v2.ready"
if not exist "!UPDATE_STATE_DIR!" mkdir "!UPDATE_STATE_DIR!" >nul 2>nul
if not exist "!UPDATE_STATE_DIR!" (
  echo [ERROR] could not prepare the Git update state directory: !UPDATE_STATE_DIR!
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

REM A failed dependency install/build must survive the next run. Git is already at
REM AFTER by then, so BEFORE..AFTER alone would otherwise hide the unfinished work.
if not exist "%ROOT%frontend\node_modules" set "FE_CHANGED=1"
if not exist "%ROOT%frontend\dist\index.html" set "FE_CHANGED=1"
if exist "!FRONTEND_PENDING!" (
  echo     Previous frontend refresh was incomplete - retrying it.
  set "FE_CHANGED=1"
)
if not exist "!ISOLATED_UPDATER_READY!" if exist "!LEGACY_FRONTEND_PENDING!" (
  echo     Previous legacy frontend refresh was incomplete - retrying it.
  set "FE_CHANGED=1"
)
if exist "!BACKEND_PENDING!" (
  echo     Previous backend dependency refresh was incomplete - retrying it.
  set "REQ_CHANGED=1"
)
if not exist "!ISOLATED_UPDATER_READY!" if exist "!LEGACY_BACKEND_PENDING!" (
  echo     Previous legacy backend refresh was incomplete - retrying it.
  set "REQ_CHANGED=1"
)
REM The first run through the isolated updater repairs a server that may already
REM have advanced HEAD while the old self-overwriting batch aborted. Do not rely
REM on BEFORE..AFTER for this one-time transition: refresh both runtime layers.
if not exist "!ISOLATED_UPDATER_READY!" if not exist "!LEGACY_ISOLATED_UPDATER_READY!" (
  echo     First safe updater run - refreshing backend and frontend once.
  set "REQ_CHANGED=1"
  set "FE_CHANGED=1"
)
if defined FE_CHANGED (
  call :persist_marker "!FRONTEND_PENDING!" "!AFTER!"
  if errorlevel 1 (
    echo [ERROR] could not persist the pending frontend refresh marker.
    goto :err
  )
)

echo [2/3] Backend dependencies...
set "UPDATE_STAGE=backend-dependencies"
echo     Using Python: !PYEXE! !PYARGS!
REM Persist the backend stage before touching pip. If install or exact-version
REM verification fails, the next update run must retry even though git HEAD has
REM already advanced and BEFORE..AFTER is then empty.
call :persist_marker "!BACKEND_PENDING!" "!AFTER!"
if errorlevel 1 (
  echo [ERROR] could not persist the pending backend dependency marker.
  goto :err
)
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
del /q "!BACKEND_PENDING!" >nul 2>nul
del /q "!LEGACY_BACKEND_PENDING!" >nul 2>nul
if exist "!BACKEND_PENDING!" (
  echo [ERROR] backend verification succeeded but its pending marker could not be cleared.
  goto :err
)

echo [3/3] Frontend...
set "UPDATE_STAGE=frontend-build"
cd /d "%ROOT%frontend" || goto :err
if defined FE_CHANGED (
  REM Recreate exactly what package-lock.json declares. Unlike npm install this
  REM never rewrites the tracked lock file just because the npm version differs.
  echo     restoring locked packages ^(npm ci^)...
  call npm ci --include=dev --no-audit --no-fund || goto :err
  echo     building frontend...
  call npm run build || goto :err
  del /q "!FRONTEND_PENDING!" >nul 2>nul
  del /q "!LEGACY_FRONTEND_PENDING!" >nul 2>nul
  if exist "!FRONTEND_PENDING!" (
    echo [ERROR] frontend build succeeded but its pending marker could not be cleared.
    goto :err
  )
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
call :persist_marker "!ISOLATED_UPDATER_READY!" "!AFTER!"
if errorlevel 1 (
  echo [ERROR] could not persist the safe-updater completion marker.
  goto :err
)
del /q "!LEGACY_ISOLATED_UPDATER_READY!" >nul 2>nul
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

:persist_marker
REM cmd.exe's ECHO redirection preserves a previous non-zero ERRORLEVEL even when
REM the write succeeds. Write to a sibling temp file, verify the exact commit, then
REM replace the marker and verify again. The returned code now describes this write.
set "MARKER_FILE=%~1"
set "MARKER_VALUE=%~2"
set "MARKER_TEMP=%~1.tmp-!RANDOM!-!RANDOM!"
>"!MARKER_TEMP!" echo(!MARKER_VALUE!
%SystemRoot%\System32\findstr.exe /l /x /c:"!MARKER_VALUE!" "!MARKER_TEMP!" >nul 2>nul
if errorlevel 1 (
  del /q "!MARKER_TEMP!" >nul 2>nul
  exit /b 1
)
move /y "!MARKER_TEMP!" "!MARKER_FILE!" >nul 2>nul
if errorlevel 1 (
  del /q "!MARKER_TEMP!" >nul 2>nul
  exit /b 1
)
%SystemRoot%\System32\findstr.exe /l /x /c:"!MARKER_VALUE!" "!MARKER_FILE!" >nul 2>nul
exit /b !errorlevel!

:write_update_log
ver >nul
>>"!UPDATE_LOG!" echo [!date! !time!] %~1 %~2
if errorlevel 1 echo [WARN] Could not write update history: !UPDATE_LOG!
exit /b 0

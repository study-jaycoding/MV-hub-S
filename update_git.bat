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

where git >nul 2>nul || (echo [ERROR] git not found - install from git-scm.com and retry. & pause & exit /b 1)
if not exist "%ROOT%.git" (
  echo [ERROR] this folder is not a git clone ^(no .git^).
  echo         Get it ^(code only, skips docs/^):
  echo           git clone --filter=blob:none --sparse https://github.com/study-jaycoding/MV-hub-S.git
  echo           cd MV-hub-S ^&^& git sparse-checkout set backend frontend
  pause & exit /b 1
)

REM Remember the commit before pulling so we can see exactly what changed.
set "BEFORE="
for /f "delims=" %%i in ('git rev-parse HEAD 2^>nul') do set "BEFORE=%%i"

echo.
echo [1/3] Pulling latest ^(git pull^)...
git pull --ff-only || (echo [ERROR] git pull failed - resolve local changes and retry. & pause & exit /b 1)

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
REM Resolve a REAL Python (ignore the Microsoft Store stub that prints "Python" and exits).
REM Prefer the 'py' launcher (never shadowed by the Store alias); else a real python3.
set "PY="
py -3 --version >nul 2>nul && set "PY=py -3"
if defined PY goto :py_resolved
python --version 2>nul | findstr /b /c:"Python 3" >nul && set "PY=python"
:py_resolved
if not defined PY (echo     real Python not found - skipping backend deps ^(run setup_clone_git.bat to install it^). & goto :after_deps)
echo     Using Python: !PY!
if defined REQ_CHANGED (
  echo     requirements.txt changed - installing...
  !PY! -m pip install -r "%ROOT%backend\requirements.txt" || goto :err
) else (
  !PY! -c "import fastapi, uvicorn" 2>nul && (
    echo     unchanged - skip.
  ) || (
    echo     deps missing - installing...
    !PY! -m pip install -r "%ROOT%backend\requirements.txt" || goto :err
  )
)
:after_deps

echo [3/3] Frontend...
cd /d "%ROOT%frontend" || goto :err
if not exist node_modules (
  echo     node_modules missing - running npm install ^(first time, a few minutes^)
  call npm install || goto :err
  set "FE_CHANGED=1"
)
if not exist "%ROOT%frontend\dist\index.html" set "FE_CHANGED=1"
if defined FE_CHANGED (
  echo     building frontend...
  call npm run build || goto :err
) else (
  echo     no frontend changes - skip build.
)
cd /d "%ROOT%"

echo.
echo [done] updated to the latest version.
echo        - shared server PC:  run MV_server.bat again
echo        - worker PC:         run MV_agent.bat again
echo        - Higgsfield CLI:    run update_cli.bat separately if you want to update it
pause
exit /b 0

:err
echo.
echo [ERROR] update failed - aborting.
pause
exit /b 1

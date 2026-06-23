@echo off
chcp 65001 >nul
REM ============================================================================
REM  MV Hub - update launcher
REM
REM  Pulls the latest program from git and refreshes dependencies + frontend build.
REM  Works on either side: server PC runs run-server.bat after this; worker PC
REM  runs MV_agent.bat after this.
REM
REM  Requires: this folder must be a git clone (git clone <repo>).
REM ============================================================================
setlocal
REM Force Python/pip to UTF-8 so reading files (e.g. requirements.txt) never hits the
REM Korean Windows cp949 codec (UnicodeDecodeError on non-ASCII bytes).
set "PYTHONUTF8=1"
set "ROOT=%~dp0"
cd /d "%ROOT%"

where git >nul 2>nul || (echo [ERROR] git not found - install from git-scm.com and retry. & pause & exit /b 1)
if not exist "%ROOT%.git" (
  echo [ERROR] this folder is not a git clone ^(no .git^).
  echo         Get it with:  git clone ^<repository-url^>
  pause & exit /b 1
)

echo.
echo [1/4] Pulling latest ^(git pull^)...
git pull --ff-only || (echo [ERROR] git pull failed - resolve local changes and retry. & pause & exit /b 1)

echo [2/4] Updating backend dependencies...
where python >nul 2>nul && (python -m pip install -r "%ROOT%backend\requirements.txt" || goto :err)

echo [3/4] Updating Higgsfield CLI to the latest version...
where npm >nul 2>nul
if errorlevel 1 (
  echo     npm not found - skipping CLI update.
) else (
  REM @latest installs the newest; if already latest this is a no-op, if older it upgrades.
  call npm install -g @higgsfield/cli@latest
  if errorlevel 1 (echo     [warn] CLI update failed ^(network/permission^) - continuing.) else (echo     Higgsfield CLI is up to date.)
)

echo [4/4] Building frontend...
cd /d "%ROOT%frontend" || goto :err
if not exist node_modules (
  echo     node_modules missing - running npm install ^(first time, a few minutes^)
  call npm install || goto :err
)
call npm run build || goto :err

echo.
echo [done] updated to the latest version.
echo        - shared server PC:  run run-server.bat again
echo        - worker PC:         run MV_agent.bat again
pause
exit /b 0

:err
echo.
echo [ERROR] update failed - aborting.
pause
exit /b 1

@echo off
chcp 65001 >nul
title MV-hub-S setup / clone
setlocal

REM ---------------------------------------------------------------------------
REM  Clones MV-hub-S "code only" (docs/ and deploy/ are NOT downloaded) to the
REM  REAL Desktop using git partial clone + sparse-checkout. Re-running updates
REM  an existing folder. ASCII-only body on purpose (Korean breaks under CP949);
REM  the resolved Desktop path may contain Korean - that is data, not code.
REM ---------------------------------------------------------------------------

REM ===== 1) Ensure git (install via winget, then continue in the SAME window) =====
where git >nul 2>nul
if not errorlevel 1 goto :have_git

echo ============================================
echo  git is not installed. Trying to install it...
echo ============================================
where winget >nul 2>nul
if errorlevel 1 (
    echo.
    echo [ERROR] winget not found.
    echo  Install Git manually from git-scm.com, then run this file again.
    echo.
    pause
    exit /b 1
)
winget install --id Git.Git -e --source winget --accept-source-agreements --accept-package-agreements
REM A freshly installed git is not on this window's PATH yet - add its default
REM location so we can keep going without making the user re-open a new window.
set "PATH=%ProgramFiles%\Git\cmd;%ProgramFiles(x86)%\Git\cmd;%LOCALAPPDATA%\Programs\Git\cmd;%PATH%"
where git >nul 2>nul
if errorlevel 1 (
    echo.
    echo  Install finished, but git is not visible in this window yet.
    echo  CLOSE this window and run this .bat again ^(a fresh window sees git^).
    echo.
    pause
    exit /b 0
)
echo  git is ready - continuing...

:have_git

REM ===== 2) Resolve the REAL Desktop (handles OneDrive redirect / localized name) =====
set "DESKTOP="
for /f "usebackq delims=" %%d in (`powershell -NoProfile -Command "[Environment]::GetFolderPath('Desktop')" 2^>nul`) do set "DESKTOP=%%d"
if not defined DESKTOP set "DESKTOP=%USERPROFILE%\Desktop"
echo  Target Desktop: %DESKTOP%
if not exist "%DESKTOP%\" (
    echo [ERROR] Desktop folder not found: %DESKTOP%
    pause
    exit /b 1
)
cd /d "%DESKTOP%" || (
    echo [ERROR] Cannot enter the Desktop folder above.
    pause
    exit /b 1
)

REM ===== 3) Clone (or update) code only =====
if exist "MV-hub-S\.git" (
    echo Existing folder found - updating to latest ^(code only^)...
    cd MV-hub-S
    git sparse-checkout set backend frontend
    git pull --ff-only || (
        echo [ERROR] git pull failed. Check your internet / repo access above.
        pause
        exit /b 1
    )
    goto :done
)

if exist "MV-hub-S" (
    echo [ERROR] A "MV-hub-S" folder exists but is not a git clone.
    echo  Delete or rename "%DESKTOP%\MV-hub-S" and run this again.
    pause
    exit /b 1
)

echo Cloning ^(code only, skips docs/ and deploy/^)...
git clone --filter=blob:none --sparse https://github.com/study-jaycoding/MV-hub-S.git || (
    echo [ERROR] git clone failed. Check your internet / repo access above.
    pause
    exit /b 1
)
cd MV-hub-S || (
    echo [ERROR] Clone reported success but the folder is missing.
    pause
    exit /b 1
)
git sparse-checkout set backend frontend

:done
echo.
echo Done!  Folder: %DESKTOP%\MV-hub-S
pause
exit /b 0

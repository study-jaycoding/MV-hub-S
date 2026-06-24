@echo off
title MV-hub-S setup / clone

REM ---------------------------------------------------------------------------
REM  Clones MV-hub-S "code only" (docs/ and deploy/ are NOT downloaded) using
REM  git partial clone + sparse-checkout. Re-running updates an existing folder.
REM  NOTE: ASCII-only body on purpose - Korean text in .bat breaks under CP949.
REM ---------------------------------------------------------------------------

where git >nul 2>nul
if errorlevel 1 (
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
        exit /b
    )
    winget install --id Git.Git -e --source winget
    echo.
    echo ============================================
    echo  Install finished.
    echo  Close this window and run this .bat again.
    echo  (the newly installed git is only seen in a fresh window.)
    echo ============================================
    pause
    exit /b
)

cd /d "%USERPROFILE%\Desktop"

if exist "MV-hub-S" (
    echo Existing folder found - updating to latest ^(code only^)...
    cd MV-hub-S
    REM ensure sparse-checkout is applied even if it was a plain clone before
    git sparse-checkout set backend frontend
    git pull --ff-only
) else (
    echo Cloning ^(code only, skips docs/ and deploy/^)...
    git clone --filter=blob:none --sparse https://github.com/study-jaycoding/MV-hub-S.git
    cd MV-hub-S
    git sparse-checkout set backend frontend
)

echo.
echo Done!
pause

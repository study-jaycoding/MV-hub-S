@echo off
chcp 65001 >nul
title MV-hub-S setup / clone
setlocal

REM ---------------------------------------------------------------------------
REM  Clones MV-hub-S "code only" (docs/ and deploy/ are NOT downloaded) to the
REM  REAL Desktop using git partial clone + sparse-checkout. Re-running updates.
REM
REM  The path-sensitive part (find Desktop + clone) runs in PowerShell so it works
REM  no matter whether the Desktop path is English or Korean, and even when OneDrive
REM  redirects it (e.g. ...\OneDrive\Desktop or ...\OneDrive\바탕 화면). The .bat
REM  body stays ASCII (Korean in .bat breaks under CP949); the path is data, not code.
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
REM location so we (and the PowerShell child below) can keep going without a re-run.
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

REM ===== 2) Resolve the REAL Desktop + clone, all inside PowerShell (Unicode-safe) =====
powershell -NoProfile -ExecutionPolicy Bypass -Command "$d=[Environment]::GetFolderPath('Desktop'); Write-Host (' Target Desktop: ' + $d); if(-not (Test-Path -LiteralPath $d)){ Write-Host '[ERROR] Desktop folder not found.'; exit 1 }; Set-Location -LiteralPath $d; $r=Join-Path $d 'MV-hub-S'; if(Test-Path -LiteralPath (Join-Path $r '.git')){ Write-Host 'Existing clone found - updating to latest (code only)...'; Set-Location -LiteralPath $r; git sparse-checkout set backend frontend; git pull --ff-only; if($LASTEXITCODE -ne 0){ Write-Host '[ERROR] git pull failed - check internet / repo access above.'; exit 1 } } elseif(Test-Path -LiteralPath $r){ Write-Host '[ERROR] A MV-hub-S folder exists but is not a git clone. Delete or rename it, then retry.'; exit 1 } else { Write-Host 'Cloning (code only, skips docs/ and deploy/)...'; git clone --filter=blob:none --sparse https://github.com/study-jaycoding/MV-hub-S.git; if($LASTEXITCODE -ne 0){ Write-Host '[ERROR] git clone failed - check internet / repo access above.'; exit 1 }; Set-Location -LiteralPath $r; git sparse-checkout set backend frontend }; Write-Host (' Done!  Folder: ' + $r)"

echo.
if errorlevel 1 (
    echo  Finished with an error above.
) else (
    echo  All set.
)
pause
exit /b

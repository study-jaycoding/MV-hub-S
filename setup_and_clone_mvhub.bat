@echo off
chcp 65001 >nul
title MV-hub-S setup / clone
setlocal

REM ---------------------------------------------------------------------------
REM  One-shot setup for a NEW PC. Installs EVERYTHING MV-hub-S needs and clones
REM  it (code only) to the REAL Desktop, then pre-installs all dependencies so
REM  MV_agent.bat starts fast with nothing left to download:
REM    - Git, Node.js (LTS), Python 3.12        (via winget)
REM    - backend Python deps  (pip -r requirements.txt)
REM    - frontend deps + build (npm install + npm run build)
REM    - Higgsfield CLI        (npm i -g @higgsfield/cli)
REM
REM  Robustness notes:
REM   - Detects a REAL Python and IGNORES the Microsoft Store stub (a fake
REM     python.exe under WindowsApps that just prints "Python" and exits). It
REM     prefers the 'py' launcher (never shadowed by the Store alias). If only
REM     the stub exists it installs real Python and, if still shadowed, tells
REM     you to turn the alias off.
REM   - Runs in PowerShell so it refreshes PATH from the registry right after
REM     each winget install (no need to reopen a window) and handles English OR
REM     Korean / OneDrive-redirected Desktop paths.
REM   - .bat body stays ASCII (Korean in .bat breaks under CP949).
REM  Some installs may pop a UAC / install window - accept them. First run can
REM  take several minutes.
REM ---------------------------------------------------------------------------

echo.
echo  MV-hub-S setup - installs Git, Node.js, Python, all project dependencies,
echo  and clones the app to your Desktop. First run takes a few minutes and may
echo  show install windows / prompts - please accept them.
echo.

powershell -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference='Continue'; function Has($c){[bool](Get-Command $c -ErrorAction SilentlyContinue)}; function Refresh(){$env:Path=[Environment]::GetEnvironmentVariable('Path','Machine')+';'+[Environment]::GetEnvironmentVariable('Path','User')}; function FindPy(){ if(Has 'py'){ & py -3 --version *>$null; if($LASTEXITCODE -eq 0){ return ,@('py','-3') } }; $g=Get-Command python -ErrorAction SilentlyContinue; if($g -and ($g.Source -notmatch 'WindowsApps')){ & python --version *>$null; if($LASTEXITCODE -eq 0){ return ,@('python') } }; return $null }; if(-not(Has 'winget') -and ((-not(Has 'git')) -or (-not(Has 'npm')) -or (-not(FindPy)))){ Write-Host '[ERROR] winget not found and a prerequisite is missing. Install Git/Node.js/Python manually, then re-run.'; exit 1 }; if(-not(Has 'git')){ Write-Host 'Installing Git...'; winget install --id Git.Git -e --source winget --accept-source-agreements --accept-package-agreements; Refresh }; if(-not(Has 'npm')){ Write-Host 'Installing Node.js LTS...'; winget install --id OpenJS.NodeJS.LTS -e --source winget --accept-source-agreements --accept-package-agreements; Refresh }; $py=FindPy; if(-not $py){ Write-Host 'Installing Python 3.12...'; winget install --id Python.Python.3.12 -e --source winget --accept-source-agreements --accept-package-agreements; Refresh; $py=FindPy }; if(-not $py){ Write-Host '[ERROR] Real Python not found - the Microsoft Store stub may be shadowing it. Open Settings > Apps > Advanced app settings > App execution aliases, turn OFF python.exe and python3.exe, then re-run.'; exit 1 }; $miss=@(); if(-not(Has 'git')){$miss+='git'}; if(-not(Has 'npm')){$miss+='npm'}; if($miss.Count -gt 0){ Write-Host ('[ERROR] Still missing after install: '+($miss -join ', ')+'. CLOSE this window and run this file again.'); exit 1 }; $d=[Environment]::GetFolderPath('Desktop'); Write-Host (' Target Desktop: '+$d); if(-not(Test-Path -LiteralPath $d)){ Write-Host '[ERROR] Desktop folder not found.'; exit 1 }; $r=Join-Path $d 'MV-hub-S'; if(Test-Path -LiteralPath (Join-Path $r '.git')){ Write-Host 'Existing clone found - updating (code only)...'; Set-Location -LiteralPath $r; git sparse-checkout set backend frontend; git pull --ff-only }elseif(Test-Path -LiteralPath $r){ Write-Host '[ERROR] A MV-hub-S folder exists but is not a git clone. Delete or rename it, then retry.'; exit 1 }else{ Write-Host 'Cloning (code only, skips docs and deploy)...'; Set-Location -LiteralPath $d; git clone --filter=blob:none --sparse https://github.com/study-jaycoding/MV-hub-S.git; if($LASTEXITCODE -ne 0){ Write-Host '[ERROR] git clone failed.'; exit 1 }; Set-Location -LiteralPath $r; git sparse-checkout set backend frontend }; $pyExe=$py[0]; $pyArgs=@($py | Select-Object -Skip 1); Write-Host ('Using Python: '+($py -join ' ')); Write-Host 'Installing backend Python deps (pip)...'; & $pyExe @pyArgs -m pip install -r (Join-Path (Join-Path $r 'backend') 'requirements.txt'); Write-Host 'Installing frontend deps (npm install) - first time takes a few minutes...'; Set-Location -LiteralPath (Join-Path $r 'frontend'); npm install; Write-Host 'Building frontend (npm run build)...'; npm run build; Write-Host 'Installing Higgsfield CLI (global)...'; npm install -g '@higgsfield/cli'; Write-Host ''; Write-Host (' Done!  Everything installed. Folder: '+$r); Write-Host ' Next: open the MV-hub-S folder and run MV_agent.bat'"

echo.
if errorlevel 1 (
    echo  Finished with an ERROR above - read the messages, fix it, and run again.
) else (
    echo  All set. Open the MV-hub-S folder on your Desktop and run MV_agent.bat.
)
echo.
pause
exit /b

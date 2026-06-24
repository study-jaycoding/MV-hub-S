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
REM  The heavy lifting runs in PowerShell so it (a) refreshes PATH from the
REM  registry right after each winget install - no need to reopen a window -
REM  and (b) handles English OR Korean / OneDrive-redirected Desktop paths.
REM  The .bat body stays ASCII (Korean in .bat breaks under CP949).
REM  Some installs may pop a UAC / install window - accept them. First run can
REM  take several minutes.
REM ---------------------------------------------------------------------------

echo.
echo  MV-hub-S setup - this installs Git, Node.js, Python, all project
echo  dependencies, and clones the app to your Desktop. First run takes a
echo  few minutes and may show install windows / prompts - please accept them.
echo.

powershell -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference='Continue'; function Need($c){[bool](Get-Command $c -ErrorAction SilentlyContinue)}; function Refresh(){$env:Path=[Environment]::GetEnvironmentVariable('Path','Machine')+';'+[Environment]::GetEnvironmentVariable('Path','User')}; if(-not(Need 'winget') -and ((-not(Need 'git')) -or (-not(Need 'npm')) -or (-not(Need 'python')))){Write-Host '[ERROR] winget not found and a prerequisite is missing. Install Git/Node.js/Python manually from their sites, then re-run.'; exit 1}; if(-not(Need 'git')){Write-Host 'Installing Git...'; winget install --id Git.Git -e --source winget --accept-source-agreements --accept-package-agreements; Refresh}; if(-not(Need 'npm')){Write-Host 'Installing Node.js LTS...'; winget install --id OpenJS.NodeJS.LTS -e --source winget --accept-source-agreements --accept-package-agreements; Refresh}; if(-not(Need 'python')){Write-Host 'Installing Python 3.12...'; winget install --id Python.Python.3.12 -e --source winget --accept-source-agreements --accept-package-agreements; Refresh}; $miss=@(); foreach($c in @('git','npm','python')){if(-not(Need $c)){$miss+=$c}}; if($miss.Count -gt 0){Write-Host ('[ERROR] Still missing after install: '+($miss -join ', ')+'. CLOSE this window and run this file again.'); exit 1}; $d=[Environment]::GetFolderPath('Desktop'); Write-Host (' Target Desktop: '+$d); if(-not(Test-Path -LiteralPath $d)){Write-Host '[ERROR] Desktop folder not found.'; exit 1}; $r=Join-Path $d 'MV-hub-S'; if(Test-Path -LiteralPath (Join-Path $r '.git')){Write-Host 'Existing clone found - updating (code only)...'; Set-Location -LiteralPath $r; git sparse-checkout set backend frontend; git pull --ff-only}elseif(Test-Path -LiteralPath $r){Write-Host '[ERROR] A MV-hub-S folder exists but is not a git clone. Delete or rename it, then retry.'; exit 1}else{Write-Host 'Cloning (code only, skips docs and deploy)...'; Set-Location -LiteralPath $d; git clone --filter=blob:none --sparse https://github.com/study-jaycoding/MV-hub-S.git; if($LASTEXITCODE -ne 0){Write-Host '[ERROR] git clone failed.'; exit 1}; Set-Location -LiteralPath $r; git sparse-checkout set backend frontend}; Write-Host 'Installing backend Python deps (pip)...'; python -m pip install -r (Join-Path (Join-Path $r 'backend') 'requirements.txt'); Write-Host 'Installing frontend deps (npm install) - first time takes a few minutes...'; Set-Location -LiteralPath (Join-Path $r 'frontend'); npm install; Write-Host 'Building frontend (npm run build)...'; npm run build; Write-Host 'Installing Higgsfield CLI (global)...'; npm install -g '@higgsfield/cli'; Write-Host ''; Write-Host (' Done!  Everything installed. Folder: '+$r); Write-Host ' Next: open the MV-hub-S folder and run MV_agent.bat'"

echo.
if errorlevel 1 (
    echo  Finished with an ERROR above - read the messages, fix it, and run again.
) else (
    echo  All set. Open the MV-hub-S folder on your Desktop and run MV_agent.bat.
)
echo.
pause
exit /b

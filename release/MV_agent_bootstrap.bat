@echo off
chcp 65001 >nul
setlocal

REM One-file launcher for artists.
REM It downloads/updates MV Hub from the company server, then runs the real MV_agent.bat.
REM Edit this path before distribution.
REM UNC example:
REM   set "BASE_URL=\\YOUR-SERVER\MVHub\packages"
REM HTTP example:
REM   set "BASE_URL=http://YOUR-SERVER/mvhub/packages"
set "BASE_URL=\\YOUR-SERVER\MVHub\packages"

REM Local install/update location.
set "TARGET_DIR=%USERPROFILE%\Desktop\MV-hub-S"

REM Optional overrides for admin testing.
if not "%MVHUB_BASE_URL%"=="" set "BASE_URL=%MVHUB_BASE_URL%"
if not "%MVHUB_TARGET_DIR%"=="" set "TARGET_DIR=%MVHUB_TARGET_DIR%"

set "BOOTSTRAP_PS1=%TEMP%\mvhub-bootstrap-%RANDOM%-%RANDOM%.ps1"

powershell -NoProfile -ExecutionPolicy Bypass -Command "$raw = Get-Content -LiteralPath '%~f0' -Raw; $marker = '### MVHUB_' + 'BOOTSTRAP_POWERSHELL ###'; $parts = $raw -split [regex]::Escape($marker), 2; if ($parts.Count -lt 2) { throw 'Bootstrap payload not found.' }; Set-Content -LiteralPath '%BOOTSTRAP_PS1%' -Value $parts[1] -Encoding UTF8"
if errorlevel 1 (
  echo.
  echo [ERROR] Failed to prepare MV Hub bootstrap.
  pause
  exit /b 1
)

powershell -NoProfile -ExecutionPolicy Bypass -File "%BOOTSTRAP_PS1%" -BaseUrl "%BASE_URL%" -TargetDir "%TARGET_DIR%" %*
set "BOOTSTRAP_EXIT=%ERRORLEVEL%"
del "%BOOTSTRAP_PS1%" >nul 2>nul

if not "%BOOTSTRAP_EXIT%"=="0" (
  echo.
  echo [ERROR] MV Hub bootstrap failed.
  pause
  exit /b %BOOTSTRAP_EXIT%
)

exit /b 0

### MVHUB_BOOTSTRAP_POWERSHELL ###
param(
    [string]$BaseUrl,
    [string]$TargetDir = (Join-Path ([Environment]::GetFolderPath("Desktop")) "MV-hub-S"),
    [switch]$NoLaunch
)

$ErrorActionPreference = "Stop"

if (-not $BaseUrl -or $BaseUrl -like "\\YOUR-SERVER*") {
    throw "Edit BASE_URL in MV_agent_bootstrap.bat first."
}

function Get-ReleaseFile {
    param(
        [string]$Name,
        [string]$Destination
    )

    if ($BaseUrl -match "^https?://") {
        $Uri = $BaseUrl.TrimEnd("/") + "/" + $Name
        Invoke-WebRequest -Uri $Uri -OutFile $Destination
    }
    else {
        $Src = Join-Path $BaseUrl $Name
        if (-not (Test-Path -LiteralPath $Src)) {
            throw "Server file not found: $Src"
        }
        Copy-Item -LiteralPath $Src -Destination $Destination -Force
    }
}

function Install-Package {
    param(
        [object]$Latest,
        [string]$TempRoot
    )

    $ZipPath = Join-Path $TempRoot $Latest.file
    $ExtractDir = Join-Path $TempRoot "extract"

    Write-Host "[update] Downloading $($Latest.file)..."
    Get-ReleaseFile -Name $Latest.file -Destination $ZipPath

    # sha256 is guaranteed present by the manifest check above - always verify (block corrupt/manual zips).
    $Actual = (Get-FileHash -LiteralPath $ZipPath -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($Actual -ne ([string]$Latest.sha256).ToLowerInvariant()) {
        throw "SHA256 mismatch. Expected $($Latest.sha256), got $Actual"
    }

    Write-Host "[update] Extracting..."
    Expand-Archive -LiteralPath $ZipPath -DestinationPath $ExtractDir -Force

    Write-Host "[update] Installing to $TargetDir..."
    New-Item -ItemType Directory -Force -Path $TargetDir | Out-Null
    Get-ChildItem -LiteralPath $ExtractDir -Force | ForEach-Object {
        Copy-Item -LiteralPath $_.FullName -Destination $TargetDir -Recurse -Force
    }
    Set-Content -LiteralPath (Join-Path $TargetDir "INSTALL_SOURCE.txt") -Value $BaseUrl -Encoding ASCII
}

$TempRoot = Join-Path $env:TEMP ("mvhub-bootstrap-" + [Guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Force -Path $TempRoot | Out-Null

try {
    Write-Host "[1/3] Checking MV Hub release server..."
    $LatestPath = Join-Path $TempRoot "latest.json"
    Get-ReleaseFile -Name "latest.json" -Destination $LatestPath
    $Latest = Get-Content -LiteralPath $LatestPath -Raw | ConvertFrom-Json
    if (-not $Latest.version -or -not $Latest.file -or -not $Latest.sha256) {
        throw "latest.json must contain version, file, and sha256."
    }

    $VersionPath = Join-Path $TargetDir "VERSION.txt"
    $CurrentVersion = ""
    if (Test-Path -LiteralPath $VersionPath) {
        $CurrentVersion = (Get-Content -LiteralPath $VersionPath -Raw).Trim()
    }

    $AgentPath = Join-Path $TargetDir "MV_agent.bat"
    if ($CurrentVersion -eq [string]$Latest.version -and (Test-Path -LiteralPath $AgentPath)) {
        Write-Host "[2/3] Already up to date: $CurrentVersion"
    }
    else {
        Write-Host "[2/3] Updating: '$CurrentVersion' -> '$($Latest.version)'"
        Install-Package -Latest $Latest -TempRoot $TempRoot
    }

    if ($NoLaunch) {
        Write-Host "[3/3] Launch skipped by -NoLaunch."
        return
    }

    if (-not (Test-Path -LiteralPath $AgentPath)) {
        throw "Installed MV_agent.bat not found: $AgentPath"
    }

    Write-Host "[3/3] Starting MV Hub agent..."
    Push-Location $TargetDir
    try {
        & cmd.exe /c "`"$AgentPath`""
        if ($LASTEXITCODE -ne 0) {
            exit $LASTEXITCODE
        }
    }
    finally {
        Pop-Location
    }
}
finally {
    Remove-Item -LiteralPath $TempRoot -Recurse -Force -ErrorAction SilentlyContinue
}

@echo off
chcp 65001 >nul
setlocal

REM MV Hub local updater.
REM Run this from the installed MV-hub-S folder. It reads INSTALL_SOURCE.txt,
REM checks the company release folder, updates app files, and does NOT launch.

for %%I in ("%~dp0.") do set "TARGET_DIR=%%~fI"
set "UPDATE_PS1=%TEMP%\mvhub-update-%RANDOM%-%RANDOM%.ps1"

powershell -NoProfile -ExecutionPolicy Bypass -Command "$raw = Get-Content -LiteralPath '%~f0' -Raw; $marker = '### MVHUB_' + 'UPDATE_POWERSHELL ###'; $parts = $raw -split [regex]::Escape($marker), 2; if ($parts.Count -lt 2) { throw 'Update payload not found.' }; Set-Content -LiteralPath '%UPDATE_PS1%' -Value $parts[1] -Encoding UTF8"
if errorlevel 1 (
  echo.
  echo [ERROR] Failed to prepare MV Hub updater.
  if not "%MVHUB_NO_PAUSE%"=="1" pause
  exit /b 1
)

powershell -NoProfile -ExecutionPolicy Bypass -File "%UPDATE_PS1%" -TargetDir "%TARGET_DIR%"
set "UPDATE_EXIT=%ERRORLEVEL%"
del "%UPDATE_PS1%" >nul 2>nul

if not "%UPDATE_EXIT%"=="0" (
  echo.
  echo [ERROR] MV Hub update failed.
  if not "%MVHUB_NO_PAUSE%"=="1" pause
  exit /b %UPDATE_EXIT%
)

echo.
echo [done] Update check finished. Run MV_agent.bat when ready.
if not "%MVHUB_NO_PAUSE%"=="1" pause
exit /b 0

### MVHUB_UPDATE_POWERSHELL ###
param(
    [string]$TargetDir
)

$ErrorActionPreference = "Stop"

if (-not $TargetDir) {
    throw "TargetDir is required."
}

$TargetDir = (Resolve-Path -LiteralPath $TargetDir).Path
$SourceFile = Join-Path $TargetDir "INSTALL_SOURCE.txt"
if (-not (Test-Path -LiteralPath $SourceFile)) {
    throw "INSTALL_SOURCE.txt not found. Run MVHub_Install.bat from the server once, then use this updater."
}

$BaseUrl = (Get-Content -LiteralPath $SourceFile -Raw).Trim()
if (-not $BaseUrl) {
    throw "INSTALL_SOURCE.txt is empty."
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

function Stop-MvHubProcesses {
    param([string]$Root)

    if (-not (Test-Path -LiteralPath $Root)) {
        return
    }

    $ResolvedRoot = (Resolve-Path -LiteralPath $Root).Path.TrimEnd("\") + "\"
    $Running = @(Get-Process -ErrorAction SilentlyContinue | ForEach-Object {
        if ($_.Id -eq $PID) {
            return
        }
        try {
            $Path = $_.Path
        }
        catch {
            return
        }
        if ($Path -and $Path.StartsWith($ResolvedRoot, [StringComparison]::OrdinalIgnoreCase)) {
            $_
        }
    })

    if (-not $Running.Count) {
        return
    }

    Write-Host "[update] Stopping running MV Hub processes before replacing files..."
    foreach ($Proc in $Running) {
        try {
            Write-Host "      stop pid=$($Proc.Id) $($Proc.ProcessName)"
            Stop-Process -Id $Proc.Id -Force -ErrorAction Stop
        }
        catch {
            Write-Host "      warn: could not stop pid=$($Proc.Id): $($_.Exception.Message)"
        }
    }

    for ($i = 0; $i -lt 20; $i++) {
        $StillRunning = @(Get-Process -ErrorAction SilentlyContinue | ForEach-Object {
            if ($_.Id -eq $PID) {
                return
            }
            try {
                $Path = $_.Path
            }
            catch {
                return
            }
            if ($Path -and $Path.StartsWith($ResolvedRoot, [StringComparison]::OrdinalIgnoreCase)) {
                $_
            }
        })
        if (-not $StillRunning.Count) {
            return
        }
        Start-Sleep -Milliseconds 500
    }

    $Names = ($StillRunning | ForEach-Object { "$($_.ProcessName)(pid=$($_.Id))" }) -join ", "
    throw "Some MV Hub processes are still running: $Names. Close MV_agent windows and try again."
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

    $Actual = (Get-FileHash -LiteralPath $ZipPath -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($Actual -ne ([string]$Latest.sha256).ToLowerInvariant()) {
        throw "SHA256 mismatch. Expected $($Latest.sha256), got $Actual"
    }

    Write-Host "[update] Extracting..."
    Expand-Archive -LiteralPath $ZipPath -DestinationPath $ExtractDir -Force

    Write-Host "[update] Installing to $TargetDir..."
    New-Item -ItemType Directory -Force -Path $TargetDir | Out-Null
    Stop-MvHubProcesses -Root $TargetDir
    Get-ChildItem -LiteralPath $ExtractDir -Force | ForEach-Object {
        Copy-Item -LiteralPath $_.FullName -Destination $TargetDir -Recurse -Force
    }
    Set-Content -LiteralPath (Join-Path $TargetDir "INSTALL_SOURCE.txt") -Value $BaseUrl -Encoding UTF8
}

$TempRoot = Join-Path $env:TEMP ("mvhub-update-" + [Guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Force -Path $TempRoot | Out-Null

try {
    Write-Host "[1/3] Checking MV Hub release server..."
    Write-Host "      Source: $BaseUrl"

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

    if ($CurrentVersion -eq [string]$Latest.version) {
        Write-Host "[2/3] Already up to date: $CurrentVersion"
    }
    else {
        Write-Host "[2/3] Updating: '$CurrentVersion' -> '$($Latest.version)'"
        Install-Package -Latest $Latest -TempRoot $TempRoot
    }

    Write-Host "[3/3] Update complete."
}
finally {
    Remove-Item -LiteralPath $TempRoot -Recurse -Force -ErrorAction SilentlyContinue
}

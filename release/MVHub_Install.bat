@echo off
chcp 65001 >nul
setlocal

REM MV Hub first installer.
REM Run this from the company server release folder. It installs/updates MV Hub
REM to the worker's Desktop, remembers the release source, and does NOT launch.

REM Keep this installer beside latest.json, or one folder above a packages folder.
REM It discovers the release source from its own location, including UNC paths.
for %%I in ("%~dp0.") do set "BASE_URL=%%~fI"
if exist "%~dp0packages\latest.json" for %%I in ("%~dp0packages\.") do set "BASE_URL=%%~fI"

REM Local install/update location.
set "TARGET_DIR=%USERPROFILE%\Desktop\MV-hub-S"

REM Optional overrides for admin testing.
if not "%MVHUB_BASE_URL%"=="" set "BASE_URL=%MVHUB_BASE_URL%"
if not "%MVHUB_TARGET_DIR%"=="" set "TARGET_DIR=%MVHUB_TARGET_DIR%"

set "INSTALL_PS1=%TEMP%\mvhub-install-%RANDOM%-%RANDOM%.ps1"

powershell -NoProfile -ExecutionPolicy Bypass -Command "$raw = Get-Content -LiteralPath '%~f0' -Raw -Encoding UTF8; $marker = '### MVHUB_' + 'INSTALL_POWERSHELL ###'; $parts = $raw -split [regex]::Escape($marker), 2; if ($parts.Count -lt 2) { throw 'Install payload not found.' }; Set-Content -LiteralPath '%INSTALL_PS1%' -Value $parts[1] -Encoding UTF8"
if errorlevel 1 (
  echo.
  echo [ERROR] Failed to prepare MV Hub installer.
  if not "%MVHUB_NO_PAUSE%"=="1" pause
  exit /b 1
)

powershell -NoProfile -ExecutionPolicy Bypass -File "%INSTALL_PS1%" -BaseUrl "%BASE_URL%" -TargetDir "%TARGET_DIR%"
set "INSTALL_EXIT=%ERRORLEVEL%"
del "%INSTALL_PS1%" >nul 2>nul

if not "%INSTALL_EXIT%"=="0" (
  echo.
  echo [ERROR] MV Hub install/update failed.
  if not "%MVHUB_NO_PAUSE%"=="1" pause
  exit /b %INSTALL_EXIT%
)

echo.
echo [done] MV Hub is installed.
echo        Run: "%TARGET_DIR%\MV_agent.bat"
echo        Update later: "%TARGET_DIR%\update_release.bat"
if not "%MVHUB_NO_PAUSE%"=="1" pause
exit /b 0

### MVHUB_INSTALL_POWERSHELL ###
param(
    [string]$BaseUrl,
    [string]$TargetDir = (Join-Path ([Environment]::GetFolderPath("Desktop")) "MV-hub-S")
)

$ErrorActionPreference = "Stop"

if (-not $BaseUrl) {
    throw "Release source is empty. Keep MVHub_Install.bat beside latest.json."
}
if ($BaseUrl -match "^https://") {
    [System.Net.ServicePointManager]::SecurityProtocol = `
        [System.Net.ServicePointManager]::SecurityProtocol -bor [System.Net.SecurityProtocolType]::Tls12
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

function Assert-BundledCli {
    param(
        [string]$Root,
        [string]$ExpectedVersion = "",
        [string]$Label = "package"
    )

    $PinPath = Join-Path $Root "hf_cli_version.txt"
    $ManifestPath = Join-Path $Root "runtime\higgsfield\node_modules\@higgsfield\cli\package.json"
    $NodeExe = Join-Path $Root "runtime\node\node.exe"
    $CliEntry = Join-Path $Root "runtime\higgsfield\node_modules\@higgsfield\cli\bin\higgsfield.js"
    foreach ($RequiredPath in @($PinPath, $ManifestPath, $NodeExe, $CliEntry)) {
        if (-not (Test-Path -LiteralPath $RequiredPath -PathType Leaf)) {
            throw "Bundled CLI validation failed ($Label): missing $RequiredPath"
        }
    }

    $Pin = (Get-Content -LiteralPath $PinPath -TotalCount 1).Trim()
    $PackageVersion = [string]((Get-Content -LiteralPath $ManifestPath -Raw | ConvertFrom-Json).version)
    if (-not $Pin -or $PackageVersion -ne $Pin) {
        throw "Bundled CLI validation failed ($Label): pin=$Pin package=$PackageVersion"
    }
    if ($ExpectedVersion -and $Pin -ne $ExpectedVersion) {
        throw "Bundled CLI validation failed ($Label): latest=$ExpectedVersion package=$Pin"
    }

    $VersionOutput = @(& $NodeExe $CliEntry version 2>&1)
    $VersionText = $VersionOutput -join "`n"
    $VersionLine = $VersionText.Trim()
    $ExpectedPrefix = "higgsfield $Pin"
    if (
        $LASTEXITCODE -ne 0 -or
        ($VersionLine -ne $ExpectedPrefix -and -not $VersionLine.StartsWith($ExpectedPrefix + " "))
    ) {
        throw "Bundled CLI execution failed ($Label): expected=$Pin output=$VersionText"
    }
    Write-Host "[$Label] Higgsfield CLI verified: $Pin"
    return $Pin
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

    Write-Host "[install] Stopping running MV Hub processes before replacing files..."
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

    Write-Host "[install] Downloading $($Latest.file)..."
    Get-ReleaseFile -Name $Latest.file -Destination $ZipPath

    $Actual = (Get-FileHash -LiteralPath $ZipPath -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($Actual -ne ([string]$Latest.sha256).ToLowerInvariant()) {
        throw "SHA256 mismatch. Expected $($Latest.sha256), got $Actual"
    }

    Write-Host "[install] Extracting..."
    Expand-Archive -LiteralPath $ZipPath -DestinationPath $ExtractDir -Force
    $PackageUpdater = Join-Path $ExtractDir "update_release.bat"
    if (-not (Test-Path -LiteralPath $PackageUpdater -PathType Leaf)) {
        throw "Release package is missing update_release.bat."
    }

    # One installation engine owns all replacement rules. The updater from the
    # SHA-verified package performs package/runtime validation, clean directory
    # swaps, rollback and the final VERSION commit. This prevents the installer
    # and updater from drifting into two different (and unsafe) copy behaviours.
    Write-Host "[install] Running the verified package installer..."
    New-Item -ItemType Directory -Force -Path $TargetDir | Out-Null
    Set-Content -LiteralPath (Join-Path $TargetDir "INSTALL_SOURCE.txt") -Value $TempRoot -Encoding UTF8
    $PreviousTarget = $env:MVHUB_UPDATE_TARGET_DIR
    $PreviousPause = $env:MVHUB_NO_PAUSE
    $PreviousRestart = $env:MVHUB_UPDATE_RESTART
    $env:MVHUB_UPDATE_TARGET_DIR = $TargetDir
    $env:MVHUB_NO_PAUSE = "1"
    $env:MVHUB_UPDATE_RESTART = "0"
    try {
        $Command = 'call "' + $PackageUpdater + '"'
        & $env:ComSpec /d /c $Command
        if ($LASTEXITCODE -ne 0) {
            throw "Verified package updater failed with exit code $LASTEXITCODE."
        }
    }
    finally {
        if ($null -eq $PreviousTarget) { Remove-Item Env:MVHUB_UPDATE_TARGET_DIR -ErrorAction SilentlyContinue }
        else { $env:MVHUB_UPDATE_TARGET_DIR = $PreviousTarget }
        if ($null -eq $PreviousPause) { Remove-Item Env:MVHUB_NO_PAUSE -ErrorAction SilentlyContinue }
        else { $env:MVHUB_NO_PAUSE = $PreviousPause }
        if ($null -eq $PreviousRestart) { Remove-Item Env:MVHUB_UPDATE_RESTART -ErrorAction SilentlyContinue }
        else { $env:MVHUB_UPDATE_RESTART = $PreviousRestart }
        Set-Content -LiteralPath (Join-Path $TargetDir "INSTALL_SOURCE.txt") -Value $BaseUrl -Encoding UTF8
    }
}

$TempRoot = Join-Path $env:TEMP ("mvhub-install-" + [Guid]::NewGuid().ToString("N"))
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
    $ReleaseFileName = [string]$Latest.file
    if ([IO.Path]::GetFileName($ReleaseFileName) -ne $ReleaseFileName -or
        $ReleaseFileName.Contains("/") -or $ReleaseFileName.Contains("\")) {
        throw "latest.json contains an unsafe release filename."
    }
    if (-not ([string]$Latest.sha256 -match "^[0-9a-fA-F]{64}$")) {
        throw "latest.json contains an invalid SHA256 value."
    }

    $VersionPath = Join-Path $TargetDir "VERSION.txt"
    $CurrentVersion = ""
    if (Test-Path -LiteralPath $VersionPath) {
        $CurrentVersion = (Get-Content -LiteralPath $VersionPath -Raw).Trim()
    }

    Write-Host "[2/3] Installing/updating: '$CurrentVersion' -> '$($Latest.version)'"
    Install-Package -Latest $Latest -TempRoot $TempRoot

    Write-Host "[3/3] Install/update complete."
}
finally {
    Remove-Item -LiteralPath $TempRoot -Recurse -Force -ErrorAction SilentlyContinue
}

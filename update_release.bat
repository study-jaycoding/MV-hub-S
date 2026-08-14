@echo off
chcp 65001 >nul
setlocal

REM MV Hub local updater.
REM Run this from the installed MV-hub-S folder. It reads INSTALL_SOURCE.txt,
REM checks the company release folder, updates app files, and does NOT launch.

for %%I in ("%~dp0.") do set "TARGET_DIR=%%~fI"
if defined MVHUB_UPDATE_TARGET_DIR for %%I in ("%MVHUB_UPDATE_TARGET_DIR%") do set "TARGET_DIR=%%~fI"
set "UPDATE_PS1=%TEMP%\mvhub-update-%RANDOM%-%RANDOM%.ps1"

powershell -NoProfile -ExecutionPolicy Bypass -Command "$raw = Get-Content -LiteralPath '%~f0' -Raw; $marker = '### MVHUB_' + 'UPDATE_POWERSHELL ###'; $parts = $raw -split [regex]::Escape($marker), 2; if ($parts.Count -lt 2) { throw 'Update payload not found.' }; Set-Content -LiteralPath '%UPDATE_PS1%' -Value $parts[1] -Encoding UTF8"
if errorlevel 1 (
  echo.
  echo [ERROR] Failed to prepare MV Hub updater.
  if not "%MVHUB_NO_PAUSE%"=="1" pause
  exit /b 1
)

powershell -NoProfile -ExecutionPolicy Bypass -File "%UPDATE_PS1%" -TargetDir "%TARGET_DIR%" -StateFile "%MVHUB_UPDATE_STATE_FILE%" -RestartAfterInstall "%MVHUB_UPDATE_RESTART%" -ReadyUrl "%MVHUB_UPDATE_READY_URL%"
set "UPDATE_EXIT=%ERRORLEVEL%"
del "%UPDATE_PS1%" >nul 2>nul

if not "%UPDATE_EXIT%"=="0" (
  echo.
  echo [ERROR] MV Hub update failed.
  if not "%MVHUB_NO_PAUSE%"=="1" pause
  exit /b %UPDATE_EXIT%
)

echo.
if "%MVHUB_UPDATE_RESTART%"=="1" (
  echo [done] Update finished and MV Hub restarted.
) else (
  echo [done] Update check finished. Run MV_agent.bat when ready.
)
if not "%MVHUB_NO_PAUSE%"=="1" pause
exit /b 0

### MVHUB_UPDATE_POWERSHELL ###
param(
    [string]$TargetDir,
    [string]$StateFile = "",
    [string]$RestartAfterInstall = "0",
    [string]$ReadyUrl = ""
)

$ErrorActionPreference = "Stop"

if (-not $TargetDir) {
    throw "TargetDir is required."
}

$TargetDir = (Resolve-Path -LiteralPath $TargetDir).Path
$CurrentVersion = ""
$LatestVersion = ""

function Write-UpdateState {
    param(
        [string]$State,
        [string]$Message,
        [string]$Latest = $LatestVersion
    )
    if (-not $StateFile) {
        return
    }
    $StateDir = Split-Path -Parent $StateFile
    New-Item -ItemType Directory -Force -Path $StateDir | Out-Null
    $VersionPath = Join-Path $TargetDir "VERSION.txt"
    $InstalledVersion = ""
    if (Test-Path -LiteralPath $VersionPath) {
        $InstalledVersion = (Get-Content -LiteralPath $VersionPath -Raw).Trim()
    }
    $Payload = [ordered]@{
        state = $State
        message = $Message
        current_version = $InstalledVersion
        latest_version = $Latest
        updated_at = [DateTime]::UtcNow.ToString("o")
    }
    $TempState = "$StateFile.$PID.tmp"
    $Payload | ConvertTo-Json | Set-Content -LiteralPath $TempState -Encoding UTF8
    Move-Item -LiteralPath $TempState -Destination $StateFile -Force
}

function Restart-MvHubAndWaitReady {
    param([string]$ExpectedVersion)
    if ($RestartAfterInstall -ne "1") {
        return
    }
    $Launcher = Join-Path $TargetDir "MV_agent.bat"
    if (-not (Test-Path -LiteralPath $Launcher -PathType Leaf)) {
        throw "MV_agent.bat is missing after update."
    }
    if (-not $ReadyUrl) {
        $ReadyUrl = "http://127.0.0.1:8010/api/ready"
    }
    Write-UpdateState -State "restarting" -Message "새 버전으로 프로그램을 다시 시작하는 중…" -Latest $ExpectedVersion
    $PreviousNoBrowser = $env:MVHUB_NO_BROWSER
    $env:MVHUB_NO_BROWSER = "1"
    try {
        Start-Process -FilePath $Launcher -WorkingDirectory $TargetDir | Out-Null
    }
    finally {
        if ($null -eq $PreviousNoBrowser) {
            Remove-Item Env:MVHUB_NO_BROWSER -ErrorAction SilentlyContinue
        }
        else {
            $env:MVHUB_NO_BROWSER = $PreviousNoBrowser
        }
    }

    $Deadline = (Get-Date).AddMinutes(3)
    while ((Get-Date) -lt $Deadline) {
        try {
            $Ready = Invoke-RestMethod -Uri $ReadyUrl -TimeoutSec 2
            $Installed = (Get-Content -LiteralPath (Join-Path $TargetDir "VERSION.txt") -Raw).Trim()
            if ($Ready.status -eq "ready" -and $Installed -eq $ExpectedVersion) {
                Write-UpdateState -State "complete" -Message "업데이트 완료 · 프로그램이 다시 시작됐습니다." -Latest $ExpectedVersion
                return
            }
        }
        catch {
            # 기존 프로세스 종료와 새 허브 부팅 사이에는 연결 실패가 정상이다.
        }
        Start-Sleep -Seconds 1
    }
    throw "MV Hub did not become ready within 3 minutes after update."
}

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
    Write-UpdateState -State "downloading" -Message "업데이트 파일을 내려받는 중…" -Latest ([string]$Latest.version)
    Get-ReleaseFile -Name $Latest.file -Destination $ZipPath

    $Actual = (Get-FileHash -LiteralPath $ZipPath -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($Actual -ne ([string]$Latest.sha256).ToLowerInvariant()) {
        throw "SHA256 mismatch. Expected $($Latest.sha256), got $Actual"
    }

    Write-Host "[update] Extracting..."
    Expand-Archive -LiteralPath $ZipPath -DestinationPath $ExtractDir -Force
    $ExpectedCliVersion = [string]$Latest.higgsfield_cli_version
    Assert-BundledCli -Root $ExtractDir -ExpectedVersion $ExpectedCliVersion -Label "package" | Out-Null

    Write-Host "[update] Installing to $TargetDir..."
    Write-UpdateState -State "installing" -Message "검증된 새 버전을 설치하는 중…" -Latest ([string]$Latest.version)
    New-Item -ItemType Directory -Force -Path $TargetDir | Out-Null
    Stop-MvHubProcesses -Root $TargetDir
    Get-ChildItem -LiteralPath $ExtractDir -Force | ForEach-Object {
        Copy-Item -LiteralPath $_.FullName -Destination $TargetDir -Recurse -Force
    }
    Assert-BundledCli -Root $TargetDir -ExpectedVersion $ExpectedCliVersion -Label "installed" | Out-Null
    Set-Content -LiteralPath (Join-Path $TargetDir "INSTALL_SOURCE.txt") -Value $BaseUrl -Encoding UTF8
}

$TempRoot = Join-Path $env:TEMP ("mvhub-update-" + [Guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Force -Path $TempRoot | Out-Null

try {
    Write-Host "[1/3] Checking MV Hub release server..."
    Write-Host "      Source: $BaseUrl"
    Write-UpdateState -State "checking" -Message "최신 릴리스를 확인하는 중…"

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
    $LatestVersion = [string]$Latest.version

    $VersionPath = Join-Path $TargetDir "VERSION.txt"
    $CurrentVersion = ""
    if (Test-Path -LiteralPath $VersionPath) {
        $CurrentVersion = (Get-Content -LiteralPath $VersionPath -Raw).Trim()
    }

    $NeedsInstall = $CurrentVersion -ne [string]$Latest.version
    if (-not $NeedsInstall) {
        try {
            Assert-BundledCli `
                -Root $TargetDir `
                -ExpectedVersion ([string]$Latest.higgsfield_cli_version) `
                -Label "installed" | Out-Null
            Write-Host "[2/3] Already up to date: $CurrentVersion"
            Write-UpdateState -State "up_to_date" -Message "이미 최신 버전입니다." -Latest $LatestVersion
        }
        catch {
            Write-Host "[2/3] App version matches, but bundled CLI needs repair: $($_.Exception.Message)"
            $NeedsInstall = $true
        }
    }
    if ($NeedsInstall) {
        Write-Host "[2/3] Updating: '$CurrentVersion' -> '$($Latest.version)'"
        Install-Package -Latest $Latest -TempRoot $TempRoot
        if ($RestartAfterInstall -eq "1") {
            Restart-MvHubAndWaitReady -ExpectedVersion $LatestVersion
        }
        else {
            Write-UpdateState -State "complete" -Message "업데이트 설치가 완료됐습니다. 프로그램을 다시 실행하세요." -Latest $LatestVersion
        }
    }

    Write-Host "[3/3] Update complete."
}
catch {
    Write-UpdateState -State "failed" -Message ("업데이트 실패: " + $_.Exception.Message) -Latest $LatestVersion
    throw
}
finally {
    Remove-Item -LiteralPath $TempRoot -Recurse -Force -ErrorAction SilentlyContinue
}

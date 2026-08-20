@echo off
chcp 65001 >nul
setlocal

REM MV Hub isolated release-update worker.
REM run_release_update.ps1 copies this file to TEMP before it reads or replaces
REM anything in the installed MV-hub-S folder.

if not defined MVHUB_UPDATE_TARGET_DIR (
  echo [ERROR] Isolated updater did not receive the installation path.
  if not "%MVHUB_NO_PAUSE%"=="1" pause
  exit /b 1
)
for %%I in ("%MVHUB_UPDATE_TARGET_DIR%") do set "TARGET_DIR=%%~fI"

if not defined TEMP if defined TMP set "TEMP=%TMP%"
if not defined TEMP if defined LOCALAPPDATA set "TEMP=%LOCALAPPDATA%\Temp"
if not defined TEMP set "TEMP=%SystemRoot%\Temp"
if not exist "%TEMP%\" mkdir "%TEMP%" >nul 2>nul
if not exist "%TEMP%\" (
  echo [ERROR] No writable temporary folder is available.
  if not "%MVHUB_NO_PAUSE%"=="1" pause
  exit /b 1
)
set "UPDATE_PS1=%TEMP%\mvhub-update-%RANDOM%-%RANDOM%.ps1"
set "MVHUB_UPDATE_SCRIPT=%~f0"
set "MVHUB_UPDATE_PAYLOAD=%UPDATE_PS1%"

REM NOTE: keep this whole file ASCII-only. On stock Korean Windows (ANSI=CP949) a
REM PowerShell default-encoding read of UTF-8 Korean text eats adjacent ASCII bytes
REM (closing quotes/braces), which corrupted the extracted payload and killed every
REM update with "The term 'catch' is not recognized". -Encoding UTF8 below is the
REM second layer of the same defense.
powershell -NoProfile -ExecutionPolicy Bypass -Command "$raw = Get-Content -LiteralPath $env:MVHUB_UPDATE_SCRIPT -Raw -Encoding UTF8; $marker = '### MVHUB_' + 'UPDATE_POWERSHELL ###'; $parts = $raw -split [regex]::Escape($marker), 2; if ($parts.Count -lt 2) { throw 'Update payload not found.' }; Set-Content -LiteralPath $env:MVHUB_UPDATE_PAYLOAD -Value $parts[1] -Encoding UTF8"
if errorlevel 1 (
  echo.
  echo [ERROR] Failed to prepare MV Hub updater.
  if defined MVHUB_UPDATE_STATE_FILE powershell -NoProfile -Command "@{state='failed';message='Update launcher failed to prepare. Replace update_release.bat from the release share and retry.';updated_at=[DateTime]::UtcNow.ToString('o')} | ConvertTo-Json -Compress | Set-Content -LiteralPath $env:MVHUB_UPDATE_STATE_FILE -Encoding UTF8"
  if not "%MVHUB_NO_PAUSE%"=="1" pause
  exit /b 1
)

powershell -NoProfile -ExecutionPolicy Bypass -File "%UPDATE_PS1%" -TargetDir "%TARGET_DIR%" -StateFile "%MVHUB_UPDATE_STATE_FILE%" -RestartAfterInstall "%MVHUB_UPDATE_RESTART%" -ReadyUrl "%MVHUB_UPDATE_READY_URL%"
set "UPDATE_EXIT=%ERRORLEVEL%"
del "%UPDATE_PS1%" >nul 2>nul

if not "%UPDATE_EXIT%"=="0" (
  echo.
  echo [ERROR] MV Hub update failed.
  REM Keep the payload's detailed failed state (e.g. SHA mismatch); write this generic
  REM fallback only when the payload died before recording its own failure.
  if defined MVHUB_UPDATE_STATE_FILE powershell -NoProfile -Command "$f=$env:MVHUB_UPDATE_STATE_FILE; $keep=$false; if (Test-Path -LiteralPath $f) { try { if ((Get-Content -LiteralPath $f -Raw -Encoding UTF8 | ConvertFrom-Json).state -eq 'failed') { $keep=$true } } catch {} }; if (-not $keep) { @{state='failed';message='Update script failed (exit %UPDATE_EXIT%). Check %%LOCALAPPDATA%%\MVHub\updates\update.log.';updated_at=[DateTime]::UtcNow.ToString('o')} | ConvertTo-Json -Compress | Set-Content -LiteralPath $f -Encoding UTF8 }"
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
        [string]$Latest = $LatestVersion,
        [int]$Percent = -1
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
    if ($Percent -ge 0) {
        $Payload["percent"] = [Math]::Min(100, $Percent)
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
    Write-UpdateState -State "restarting" -Message "Restarting MV Hub on the new version..." -Latest $ExpectedVersion -Percent 95
    # The updater itself is intentionally hidden, but the newly installed app must
    # not be hidden with it. Start a fresh, visible cmd so users get one durable
    # control window and the normal launcher opens the browser after readiness.
    $StartInfo = New-Object System.Diagnostics.ProcessStartInfo
    $StartInfo.FileName = $env:ComSpec
    $StartInfo.Arguments = '/d /c call "' + $Launcher + '"'
    $StartInfo.WorkingDirectory = $TargetDir
    $StartInfo.UseShellExecute = $true
    $StartInfo.CreateNoWindow = $false
    $StartInfo.WindowStyle = [System.Diagnostics.ProcessWindowStyle]::Normal
    $PreviousNoBrowser = $env:MVHUB_NO_BROWSER
    $PreviousNoPause = $env:MVHUB_NO_PAUSE
    Remove-Item Env:MVHUB_NO_BROWSER -ErrorAction SilentlyContinue
    Remove-Item Env:MVHUB_NO_PAUSE -ErrorAction SilentlyContinue
    try {
        $Started = [System.Diagnostics.Process]::Start($StartInfo)
    }
    finally {
        if ($null -ne $PreviousNoBrowser) { $env:MVHUB_NO_BROWSER = $PreviousNoBrowser }
        if ($null -ne $PreviousNoPause) { $env:MVHUB_NO_PAUSE = $PreviousNoPause }
    }
    if (-not $Started) {
        throw "Could not start MV_agent.bat after update."
    }

    $Deadline = (Get-Date).AddMinutes(3)
    while ((Get-Date) -lt $Deadline) {
        try {
            $Ready = Invoke-RestMethod -Uri $ReadyUrl -TimeoutSec 2
            $Installed = (Get-Content -LiteralPath (Join-Path $TargetDir "VERSION.txt") -Raw).Trim()
            if ($Ready.status -eq "ready" -and $Installed -eq $ExpectedVersion) {
                Write-UpdateState -State "complete" -Message "Update finished. MV Hub restarted." -Latest $ExpectedVersion -Percent 100
                return
            }
        }
        catch {
            # Connection failures are expected between old-process exit and new-hub boot.
        }
        Start-Sleep -Seconds 1
    }
    throw "MV Hub did not become ready within 3 minutes after update."
}

$SourceFile = Join-Path $TargetDir "INSTALL_SOURCE.txt"
if (-not (Test-Path -LiteralPath $SourceFile)) {
    throw "INSTALL_SOURCE.txt not found. Run MVHub_Install.bat from the server once, then use this updater."
}

$BaseUrl = (Get-Content -LiteralPath $SourceFile -Raw -Encoding UTF8).Trim()
if (-not $BaseUrl) {
    throw "INSTALL_SOURCE.txt is empty."
}
if ($BaseUrl -match "^https://") {
    # PS 5.1 defaults can exclude TLS 1.2; enable it for both Invoke-WebRequest and WebRequest.
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

function Get-Sha256Hex {
    param([string]$Path)

    $Stream = [System.IO.File]::OpenRead($Path)
    $Hasher = [System.Security.Cryptography.SHA256]::Create()
    try {
        return ([BitConverter]::ToString($Hasher.ComputeHash($Stream))).Replace("-", "").ToLowerInvariant()
    }
    finally {
        $Hasher.Dispose()
        $Stream.Dispose()
    }
}

function Get-ReleaseFileWithProgress {
    # Streams the big release ZIP in 1MB chunks so both the console window and the
    # in-app state file can show percent progress. Download maps to 10-60% overall.
    param(
        [string]$Name,
        [string]$Destination,
        [long]$ExpectedSize = 0
    )
    $Response = $null
    $In = $null
    $Out = $null
    try {
        if ($BaseUrl -match "^https?://") {
            $Uri = $BaseUrl.TrimEnd("/") + "/" + $Name
            $Response = [System.Net.WebRequest]::Create($Uri).GetResponse()
            $In = $Response.GetResponseStream()
            if ($ExpectedSize -le 0) { $ExpectedSize = [long]$Response.ContentLength }
        }
        else {
            $Src = Join-Path $BaseUrl $Name
            if (-not (Test-Path -LiteralPath $Src)) {
                throw "Server file not found: $Src"
            }
            if ($ExpectedSize -le 0) { $ExpectedSize = (Get-Item -LiteralPath $Src).Length }
            $In = [System.IO.File]::OpenRead($Src)
        }
        $Out = [System.IO.File]::Create($Destination)
        $Buffer = New-Object byte[] 1048576
        [long]$Done = 0
        $LastPct = -1
        while (($Read = $In.Read($Buffer, 0, $Buffer.Length)) -gt 0) {
            $Out.Write($Buffer, 0, $Read)
            $Done += $Read
            if ($ExpectedSize -gt 0) {
                # Server-reported size may be wrong; clamp so progress never exceeds 100%.
                $Pct = [Math]::Min(100, [int][Math]::Floor(100 * $Done / $ExpectedSize))
                if ($Pct -ge ($LastPct + 5)) {
                    $LastPct = $Pct
                    $Overall = 10 + [int][Math]::Floor($Pct / 2)
                    Write-Host ("[update] {0,3}%  downloading {1} ({2}%)" -f $Overall, $Name, $Pct)
                    Write-UpdateState -State "downloading" -Message "Downloading update package... ($Pct%)" -Percent $Overall
                }
            }
        }
    }
    finally {
        if ($Out) { $Out.Dispose() }
        if ($In) { $In.Dispose() }
        if ($Response) { $Response.Dispose() }
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

function Assert-PythonRuntime {
    param(
        [string]$RuntimeDir,
        [string]$Label = "runtime"
    )

    $Exe = Join-Path $RuntimeDir "python.exe"
    if (-not (Test-Path -LiteralPath $Exe -PathType Leaf)) {
        throw "Bundled Python validation failed ($Label): python.exe is missing."
    }
    $Probe = @(
        "import sys,struct,glob,pathlib,ssl,sqlite3,json,asyncio",
        "import fastapi,uvicorn,pydantic,websockets,multipart,PIL,watchdog",
        "import starlette,pydantic_core,annotated_types,annotated_doc,typing_inspection,typing_extensions",
        "import anyio,idna,click,h11,httptools,dotenv,yaml,watchfiles,colorama,pip",
        "print('%d.%d.%d|%d' % (*sys.version_info[:3], struct.calcsize('P') * 8))"
    ) -join ";"
    $Output = @(& $Exe -I -c $Probe 2>&1)
    if ($LASTEXITCODE -ne 0 -or -not $Output) {
        throw "Bundled Python validation failed ($Label): $($Output -join ' ')"
    }

    $RuntimeIdentity = ([string]$Output[-1]).Trim().Split("|")
    if ($RuntimeIdentity.Count -ne 2 -or [int]$RuntimeIdentity[1] -ne 64) {
        throw "Bundled Python validation failed ($Label): expected 64-bit runtime, got '$($Output[-1])'."
    }
    $Parts = $RuntimeIdentity[0].Split(".")
    if ($Parts.Count -lt 2) {
        throw "Bundled Python validation failed ($Label): invalid version output."
    }
    if ([int]$Parts[0] -ne 3 -or [int]$Parts[1] -ne 14) {
        throw "Bundled Python validation failed ($Label): release runtime must be Python 3.14 x64."
    }
    $ExpectedDll = "python$($Parts[0])$($Parts[1]).dll"
    $VersionDlls = @(Get-ChildItem -LiteralPath $RuntimeDir -File -Filter "python*.dll" | Where-Object {
        $_.Name -match "^python3\d{2}\.dll$"
    })
    if ($VersionDlls.Count -ne 1 -or $VersionDlls[0].Name -ine $ExpectedDll) {
        $Found = ($VersionDlls | ForEach-Object Name) -join ", "
        throw "Bundled Python validation failed ($Label): expected only $ExpectedDll, found [$Found]."
    }
    Write-Host "[$Label] Python runtime verified: $($RuntimeIdentity[0]) 64-bit, $ExpectedDll"
}

function Assert-AppLayout {
    param(
        [string]$Root,
        [string]$Label = "install"
    )
    $Required = @(
        "MV_agent.bat",
        "update_release.bat",
        "run_release_update.ps1",
        "update_release_worker.bat",
        "run_agent_session.py",
        "agent_push.py",
        "backend\serve.py",
        "backend\app\main.py",
        "frontend\dist\index.html"
    )
    foreach ($Relative in $Required) {
        $Path = Join-Path $Root $Relative
        if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
            throw "MV Hub validation failed ($Label): missing $Relative"
        }
    }
}

function Replace-ImmutableDirectory {
    param(
        [string]$SourceDir,
        [string]$TargetDir,
        [string]$Label
    )
    if (-not (Test-Path -LiteralPath $SourceDir -PathType Container)) {
        throw "Update package is missing $Label."
    }
    $Parent = Split-Path -Parent $TargetDir
    $Leaf = Split-Path -Leaf $TargetDir
    $Token = [Guid]::NewGuid().ToString("N").Substring(0, 8)
    $NextDir = Join-Path $Parent "$Leaf.next.$Token"
    $PrevDir = Join-Path $Parent "$Leaf.previous.$Token"
    New-Item -ItemType Directory -Force -Path $Parent | Out-Null
    Copy-Item -LiteralPath $SourceDir -Destination $NextDir -Recurse -Force
    $HadPrevious = Test-Path -LiteralPath $TargetDir
    if ($HadPrevious) {
        Rename-Item -LiteralPath $TargetDir -NewName (Split-Path -Leaf $PrevDir)
    }
    try {
        Rename-Item -LiteralPath $NextDir -NewName $Leaf
    }
    catch {
        if ($HadPrevious -and (Test-Path -LiteralPath $PrevDir)) {
            Rename-Item -LiteralPath $PrevDir -NewName $Leaf
        }
        Remove-Item -LiteralPath $NextDir -Recurse -Force -ErrorAction SilentlyContinue
        throw "Atomic replacement failed for $Label; previous directory restored. $($_.Exception.Message)"
    }
    if ($HadPrevious) {
        Remove-Item -LiteralPath $PrevDir -Recurse -Force -ErrorAction SilentlyContinue
    }
}

function Get-MvHubProcessIds {
    param([string]$ResolvedRoot)

    $Launcher = Join-Path $ResolvedRoot "MV_agent.bat"
    $Ids = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | ForEach-Object {
        if ($_.ProcessId -eq $PID) {
            return
        }

        $ExecutablePath = [string]$_.ExecutablePath
        if (
            $ExecutablePath -and
            $ExecutablePath.StartsWith($ResolvedRoot, [StringComparison]::OrdinalIgnoreCase)
        ) {
            [int]$_.ProcessId
            return
        }

        # The visible launcher is a system cmd.exe, so its executable lives outside
        # the install folder. Match only shells running this exact MV_agent.bat.
        $CommandLine = [string]$_.CommandLine
        if (
            $_.Name -ieq "cmd.exe" -and
            $CommandLine.IndexOf($Launcher, [StringComparison]::OrdinalIgnoreCase) -ge 0
        ) {
            [int]$_.ProcessId
        }
    })

    return @($Ids | Sort-Object -Unique)
}

function Stop-MvHubProcesses {
    param([string]$Root)

    if (-not (Test-Path -LiteralPath $Root)) {
        return
    }

    $ResolvedRoot = (Resolve-Path -LiteralPath $Root).Path.TrimEnd("\") + "\"
    $RunningIds = @(Get-MvHubProcessIds -ResolvedRoot $ResolvedRoot)

    if (-not $RunningIds.Count) {
        return
    }

    Write-Host "[update] Stopping running MV Hub processes before replacing files..."
    foreach ($ProcessId in $RunningIds) {
        try {
            $Proc = Get-Process -Id $ProcessId -ErrorAction SilentlyContinue
            if (-not $Proc) {
                continue
            }
            Write-Host "      stop pid=$ProcessId $($Proc.ProcessName)"
            Stop-Process -Id $ProcessId -Force -ErrorAction Stop
        }
        catch {
            Write-Host "      warn: could not stop pid=$ProcessId`: $($_.Exception.Message)"
        }
    }

    for ($i = 0; $i -lt 20; $i++) {
        $StillRunningIds = @(Get-MvHubProcessIds -ResolvedRoot $ResolvedRoot)
        if (-not $StillRunningIds.Count) {
            return
        }
        Start-Sleep -Milliseconds 500
    }

    $Names = ($StillRunningIds | ForEach-Object {
        $Proc = Get-Process -Id $_ -ErrorAction SilentlyContinue
        if ($Proc) { "$($Proc.ProcessName)(pid=$_)" } else { "pid=$_" }
    }) -join ", "
    throw "Some MV Hub processes are still running: $Names. Close MV_agent windows and try again."
}

function Install-Package {
    param(
        [object]$Latest,
        [string]$TempRoot
    )

    $ZipPath = Join-Path $TempRoot $Latest.file
    $ExtractDir = Join-Path $TempRoot "extract"

    Write-Host "[update]  10%  Downloading $($Latest.file)..."
    Write-UpdateState -State "downloading" -Message "Downloading update package..." -Latest ([string]$Latest.version) -Percent 10
    $ExpectedSize = 0
    try { $ExpectedSize = [long]$Latest.size } catch { $ExpectedSize = 0 }
    Get-ReleaseFileWithProgress -Name $Latest.file -Destination $ZipPath -ExpectedSize $ExpectedSize

    Write-Host "[update]  62%  Verifying SHA256..."
    Write-UpdateState -State "downloading" -Message "Verifying package integrity..." -Latest ([string]$Latest.version) -Percent 62
    $Actual = Get-Sha256Hex -Path $ZipPath
    if ($Actual -ne ([string]$Latest.sha256).ToLowerInvariant()) {
        throw "SHA256 mismatch. Expected $($Latest.sha256), got $Actual"
    }

    Write-Host "[update]  65%  Extracting..."
    Write-UpdateState -State "installing" -Message "Extracting update package..." -Latest ([string]$Latest.version) -Percent 65
    Expand-Archive -LiteralPath $ZipPath -DestinationPath $ExtractDir -Force
    $ExpectedCliVersion = [string]$Latest.higgsfield_cli_version
    Assert-AppLayout -Root $ExtractDir -Label "package"
    Assert-BundledCli -Root $ExtractDir -ExpectedVersion $ExpectedCliVersion -Label "package" | Out-Null
    $NewPython = Join-Path $ExtractDir "runtime\python"
    Assert-PythonRuntime -RuntimeDir $NewPython -Label "package"

    Write-Host "[update]  75%  Installing to $TargetDir..."
    Write-UpdateState -State "installing" -Message "Installing verified files..." -Latest ([string]$Latest.version) -Percent 75
    New-Item -ItemType Directory -Force -Path $TargetDir | Out-Null
    Stop-MvHubProcesses -Root $TargetDir

    # Mutable backend data/media stays in place. Immutable application trees are not
    # merged: a merge leaves files removed by newer releases behind. Copy only stable
    # root/backend metadata here, then replace app/dist/runtimes wholesale below.
    Get-ChildItem -LiteralPath $ExtractDir -Force | ForEach-Object {
        if ($_.Name -eq "backend") {
            $BackendTarget = Join-Path $TargetDir "backend"
            New-Item -ItemType Directory -Force -Path $BackendTarget | Out-Null
            Get-ChildItem -LiteralPath $_.FullName -Force | ForEach-Object {
                # backend\data owns user DBs, backup outbox, and replica status.
                # Never overwrite it even if a malformed package unexpectedly contains data.
                if ($_.Name -ne "app" -and $_.Name -ne "data") {
                    Copy-Item -LiteralPath $_.FullName -Destination $BackendTarget -Recurse -Force
                }
            }
        }
        elseif ($_.Name -ne "runtime" -and $_.Name -ne "frontend" -and $_.Name -ne "VERSION.txt") {
            Copy-Item -LiteralPath $_.FullName -Destination $TargetDir -Recurse -Force
        }
    }

    Replace-ImmutableDirectory `
        -SourceDir (Join-Path $ExtractDir "backend\app") `
        -TargetDir (Join-Path $TargetDir "backend\app") `
        -Label "backend\app"
    Replace-ImmutableDirectory `
        -SourceDir (Join-Path $ExtractDir "frontend\dist") `
        -TargetDir (Join-Path $TargetDir "frontend\dist") `
        -Label "frontend\dist"
    Replace-ImmutableDirectory `
        -SourceDir (Join-Path $ExtractDir "runtime\node") `
        -TargetDir (Join-Path $TargetDir "runtime\node") `
        -Label "runtime\node"
    Replace-ImmutableDirectory `
        -SourceDir (Join-Path $ExtractDir "runtime\higgsfield") `
        -TargetDir (Join-Path $TargetDir "runtime\higgsfield") `
        -Label "runtime\higgsfield"

    if (Test-Path -LiteralPath $NewPython) {
        # Stage the new runtime fully in python.next.<token>, verify it runs, then swap
        # with two renames. If the second rename fails, restore previous immediately -
        # whatever point this dies at, a runnable runtime remains (atomic swap).
        # The previous backup is deleted only after the swap verifies.
        $Token = [Guid]::NewGuid().ToString("N").Substring(0, 8)
        $PythonDir = Join-Path $TargetDir "runtime\python"
        $NextDir = Join-Path $TargetDir "runtime\python.next.$Token"
        $PrevDir = Join-Path $TargetDir "runtime\python.previous.$Token"

        Write-Host "[update]  85%  Staging new Python runtime..."
        Write-UpdateState -State "installing" -Message "Swapping Python runtime..." -Latest ([string]$Latest.version) -Percent 85
        New-Item -ItemType Directory -Force -Path (Join-Path $TargetDir "runtime") | Out-Null
        Copy-Item -LiteralPath $NewPython -Destination $NextDir -Recurse -Force
        try {
            Assert-PythonRuntime -RuntimeDir $NextDir -Label "staged"
        }
        catch {
            Remove-Item -LiteralPath $NextDir -Recurse -Force -ErrorAction SilentlyContinue
            throw
        }

        Write-Host "[update] Swapping verified Python runtime..."
        $HadPrevious = Test-Path -LiteralPath $PythonDir
        if ($HadPrevious) {
            Rename-Item -LiteralPath $PythonDir -NewName (Split-Path -Leaf $PrevDir)
        }
        try {
            Rename-Item -LiteralPath $NextDir -NewName "python"
        }
        catch {
            if ($HadPrevious) {
                Rename-Item -LiteralPath $PrevDir -NewName "python"
            }
            Remove-Item -LiteralPath $NextDir -Recurse -Force -ErrorAction SilentlyContinue
            throw "Python runtime swap failed; previous runtime restored. $($_.Exception.Message)"
        }
        try {
            Assert-PythonRuntime -RuntimeDir $PythonDir -Label "installed"
        }
        catch {
            Remove-Item -LiteralPath $PythonDir -Recurse -Force -ErrorAction SilentlyContinue
            if ($HadPrevious -and (Test-Path -LiteralPath $PrevDir)) {
                Rename-Item -LiteralPath $PrevDir -NewName "python"
            }
            throw "New Python runtime failed after swap; previous runtime restored. $($_.Exception.Message)"
        }
        if ($HadPrevious) {
            Remove-Item -LiteralPath $PrevDir -Recurse -Force -ErrorAction SilentlyContinue
        }
    }
    else {
        throw "Update package is missing runtime\python."
    }

    Write-Host "[update]  92%  Verifying installed files..."
    Write-UpdateState -State "installing" -Message "Verifying installed files..." -Latest ([string]$Latest.version) -Percent 92
    Assert-AppLayout -Root $TargetDir -Label "installed"
    Assert-PythonRuntime -RuntimeDir (Join-Path $TargetDir "runtime\python") -Label "installed"
    Assert-BundledCli -Root $TargetDir -ExpectedVersion $ExpectedCliVersion -Label "installed" | Out-Null
    Set-Content -LiteralPath (Join-Path $TargetDir "INSTALL_SOURCE.txt") -Value $BaseUrl -Encoding UTF8
    # VERSION is the transaction commit marker. Never advertise the new version
    # before every file and runtime validation above has passed; a failed update
    # must be retried instead of being mistaken for an up-to-date installation.
    Set-Content -LiteralPath (Join-Path $TargetDir "VERSION.txt") -Value ([string]$Latest.version) -Encoding ASCII
}

$TempRoot = Join-Path $env:TEMP ("mvhub-update-" + [Guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Force -Path $TempRoot | Out-Null

try {
    Write-Host "[1/3] Checking MV Hub release server..."
    Write-Host "      Source: $BaseUrl"
    Write-UpdateState -State "checking" -Message "Checking the release server..." -Percent 5

    $LatestPath = Join-Path $TempRoot "latest.json"
    Get-ReleaseFile -Name "latest.json" -Destination $LatestPath
    $Latest = Get-Content -LiteralPath $LatestPath -Raw -Encoding UTF8 | ConvertFrom-Json
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
            Assert-AppLayout -Root $TargetDir -Label "installed"
            Assert-PythonRuntime `
                -RuntimeDir (Join-Path $TargetDir "runtime\python") `
                -Label "installed"
            Assert-BundledCli `
                -Root $TargetDir `
                -ExpectedVersion ([string]$Latest.higgsfield_cli_version) `
                -Label "installed" | Out-Null
            Write-Host "[2/3] Already up to date: $CurrentVersion"
            Write-UpdateState -State "up_to_date" -Message "Already up to date." -Latest $LatestVersion
        }
        catch {
            Write-Host "[2/3] App version matches, but the installation needs repair: $($_.Exception.Message)"
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
            Write-UpdateState -State "complete" -Message "Update installed. Start MV Hub again." -Latest $LatestVersion -Percent 100
        }
    }

    Write-Host "[3/3] Update complete."
}
catch {
    Write-UpdateState -State "failed" -Message ("Update failed: " + $_.Exception.Message) -Latest $LatestVersion
    throw
}
finally {
    Remove-Item -LiteralPath $TempRoot -Recurse -Force -ErrorAction SilentlyContinue
}

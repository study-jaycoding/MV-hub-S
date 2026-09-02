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

if "%UPDATE_EXIT%"=="17" (
  REM Another updater already holds the install lock. Its state file is live -
  REM never overwrite it with a generic failure from this duplicate run.
  echo.
  echo [ERROR] Another MV Hub update is already running for this install.
  if not "%MVHUB_NO_PAUSE%"=="1" pause
  exit /b 17
)

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
$SwapToken = [Guid]::NewGuid().ToString("N").Substring(0, 8)
$JournalPath = Join-Path $TargetDir "update-journal.json"
# recovery describes what the install tree looks like when the updater fails:
#   not_started       - nothing was stopped or replaced; the app kept running
#   rolled_back       - processes were stopped but the old tree is intact/restored
#   new_committed     - the new version committed (VERSION.txt) but restart failed
#   recovery_required - rollback itself failed; backups and journal are preserved
$script:RecoveryState = "not_started"
$script:ProcessesStopped = $false
$script:InstalledComponents = $null
# True when this run found backups/journal from an earlier interrupted update.
# Such a tree cannot be trusted (it may be half-swapped), so a full reinstall is
# forced even on matching versions, and a failed reinstall must never be booted
# or have its quarantined backups deleted.
$script:HadRecoveryAssets = $false

function Write-UpdateState {
    param(
        [string]$State,
        [string]$Message,
        [string]$Latest = $LatestVersion,
        [int]$Percent = -1,
        [string]$Recovery = ""
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
    if ($Recovery) {
        $Payload["recovery"] = $Recovery
    }
    $TempState = "$StateFile.$PID.tmp"
    $Payload | ConvertTo-Json | Set-Content -LiteralPath $TempState -Encoding UTF8
    Move-Item -LiteralPath $TempState -Destination $StateFile -Force
}

# Windows error codes that mean "someone briefly holds a handle" - the only
# failures worth retrying. Everything else (missing path, destination exists,
# bad name, disk errors) fails immediately.
$script:RetryableMoveCodes = @(5, 32, 33)  # ACCESS_DENIED, SHARING_VIOLATION, LOCK_VIOLATION

function Get-TransientLockCode {
    # Returns the FACILITY_WIN32 error code when the exception chain ends in an
    # IO/access exception, or -1 for everything else (wrong type, no Win32 facility).
    param([System.Exception]$Exception)
    $Inner = $Exception
    while ($null -ne $Inner.InnerException) { $Inner = $Inner.InnerException }
    if (-not (($Inner -is [System.IO.IOException]) -or ($Inner -is [System.UnauthorizedAccessException]))) {
        return -1
    }
    try {
        $HResult = [int]$Inner.HResult
        if ((($HResult -shr 16) -band 0xFFFF) -eq 0x8007) {
            return $HResult -band 0xFFFF
        }
    }
    catch {
        return -1
    }
    return -1
}

function Move-PathWithRetry {
    # Directory/file rename with a retry window for transient locks. Antivirus and
    # the search indexer scan freshly copied trees and can hold handles for a few
    # seconds; a single failed rename must not kill a whole update (seen live on
    # 2026-09-02: frontend\dist swap died on one ACCESS_DENIED).
    param(
        [string]$Path,
        [string]$Destination,
        [string]$Label,
        [int]$TimeoutSeconds = 15
    )
    if (-not (Test-Path -LiteralPath $Path)) {
        throw "Move failed for ${Label}: source is missing: $Path"
    }
    if (Test-Path -LiteralPath $Destination) {
        throw "Move failed for ${Label}: destination already exists: $Destination"
    }
    $IsContainer = Test-Path -LiteralPath $Path -PathType Container
    $Deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    $DelayMs = 250
    $Attempt = 0
    while ($true) {
        $Attempt++
        try {
            if ($IsContainer) {
                [System.IO.Directory]::Move($Path, $Destination)
            }
            else {
                [System.IO.File]::Move($Path, $Destination)
            }
            if ($Attempt -gt 1) {
                Write-Host "[update] move recovered for $Label after $Attempt attempts"
            }
            return
        }
        catch {
            $Win32Code = Get-TransientLockCode -Exception $_.Exception
            $Retryable = $script:RetryableMoveCodes -contains $Win32Code
            if (-not $Retryable -or (Get-Date) -ge $Deadline) {
                throw
            }
            Write-Host "[update] move retry $Attempt for $Label (win32=$Win32Code): $Path"
            # Clamp the sleep to the remaining window so total time honors the deadline.
            $RemainingMs = [int][Math]::Max(0, ($Deadline - (Get-Date)).TotalMilliseconds)
            Start-Sleep -Milliseconds ([Math]::Min($DelayMs, [Math]::Max(1, $RemainingMs)))
            $DelayMs = [Math]::Min(2000, $DelayMs * 2)
        }
    }
}

function Invoke-CheckedProcess {
    # Runs a validation executable with a hard timeout. A hung child must turn into
    # a normal failure (so rollback and restart-on-failure still run) instead of
    # freezing the whole updater forever.
    param(
        [string]$FilePath,
        [string[]]$ArgumentList,
        [string]$Label,
        [int]$TimeoutSeconds = 60
    )
    $ProbeBase = Join-Path $env:TEMP ("mvhub-probe-" + [Guid]::NewGuid().ToString("N"))
    $OutPath = $ProbeBase + ".out"
    $ErrPath = $ProbeBase + ".err"
    $Process = $null
    try {
        $Process = Start-Process -FilePath $FilePath -ArgumentList $ArgumentList -NoNewWindow -PassThru `
            -RedirectStandardOutput $OutPath -RedirectStandardError $ErrPath
        # PS 5.1 trap: without touching .Handle first, ExitCode reads back $null
        # after the process exits (the handle is never cached). Measured live.
        [void]$Process.Handle
        if (-not $Process.WaitForExit($TimeoutSeconds * 1000)) {
            try { $Process.Kill() } catch {}
            throw "Validation timed out after ${TimeoutSeconds}s (${Label}): $FilePath"
        }
        $Process.WaitForExit()  # flush: blocks until redirected streams are closed
        $StdOut = ""
        $StdErr = ""
        if (Test-Path -LiteralPath $OutPath) { $StdOut = [System.IO.File]::ReadAllText($OutPath) }
        if (Test-Path -LiteralPath $ErrPath) { $StdErr = [System.IO.File]::ReadAllText($ErrPath) }
        return @{ ExitCode = $Process.ExitCode; StdOut = $StdOut; StdErr = $StdErr }
    }
    finally {
        Remove-Item -LiteralPath $OutPath -Force -ErrorAction SilentlyContinue
        Remove-Item -LiteralPath $ErrPath -Force -ErrorAction SilentlyContinue
    }
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

function Start-MvHubAfterFailure {
    # Best-effort relaunch of the (restored) old version after a failed install, so
    # users are never left with a dead backend and a frozen progress screen.
    # Deliberately writes NO update state: the failed record must stay visible.
    try {
        $Launcher = Join-Path $TargetDir "MV_agent.bat"
        if (-not (Test-Path -LiteralPath $Launcher -PathType Leaf)) {
            Write-Host "[update] warn: MV_agent.bat is missing - cannot restart the app after failure."
            return
        }
        if (-not $ReadyUrl) {
            $ReadyUrl = "http://127.0.0.1:8010/api/ready"
        }
        # new_committed can reach here with the freshly launched hub already alive
        # (readiness timed out, not the launch). Never stack a second launcher.
        $ResolvedRoot = (Resolve-Path -LiteralPath $TargetDir).Path.TrimEnd("\") + "\"
        $Existing = @(Get-MvHubProcessIds -ResolvedRoot $ResolvedRoot)
        if ($Existing.Count) {
            Write-Host "[update] MV Hub processes already running (pids: $($Existing -join ', ')) - not launching another."
            return
        }
        Write-Host "[update] Restarting MV Hub after the failed update..."
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
            [void][System.Diagnostics.Process]::Start($StartInfo)
        }
        finally {
            if ($null -ne $PreviousNoBrowser) { $env:MVHUB_NO_BROWSER = $PreviousNoBrowser }
            if ($null -ne $PreviousNoPause) { $env:MVHUB_NO_PAUSE = $PreviousNoPause }
        }
        $Deadline = (Get-Date).AddSeconds(90)
        while ((Get-Date) -lt $Deadline) {
            try {
                $Ready = Invoke-RestMethod -Uri $ReadyUrl -TimeoutSec 2
                if ($Ready.status -eq "ready") {
                    Write-Host "[update] MV Hub is running again on the previous version."
                    return
                }
            }
            catch {
                # Booting - keep waiting.
            }
            Start-Sleep -Seconds 1
        }
        Write-Host "[update] warn: MV Hub did not report ready within 90s after the failed update."
    }
    catch {
        Write-Host "[update] warn: could not restart the app after failure: $($_.Exception.Message)"
    }
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

    $Result = Invoke-CheckedProcess -FilePath $NodeExe -ArgumentList @(('"' + $CliEntry + '"'), "version") -Label $Label -TimeoutSeconds 60
    $VersionLine = ([string]$Result.StdOut).Trim()
    $ExpectedPrefix = "higgsfield $Pin"
    if (
        $Result.ExitCode -ne 0 -or
        ($VersionLine -ne $ExpectedPrefix -and -not $VersionLine.StartsWith($ExpectedPrefix + " "))
    ) {
        $Detail = (($Result.StdOut + "`n" + $Result.StdErr)).Trim()
        throw "Bundled CLI execution failed ($Label): expected=$Pin output=$Detail"
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
    $Result = Invoke-CheckedProcess -FilePath $Exe -ArgumentList @("-I", "-c", ('"' + $Probe + '"')) -Label $Label -TimeoutSeconds 60
    $OutputLines = @(([string]$Result.StdOut) -split "\r?\n" | Where-Object { $_.Trim() })
    if ($Result.ExitCode -ne 0 -or -not $OutputLines.Count) {
        $Detail = (($Result.StdOut + "`n" + $Result.StdErr)).Trim()
        throw "Bundled Python validation failed ($Label): $Detail"
    }

    $RuntimeIdentity = ([string]$OutputLines[-1]).Trim().Split("|")
    if ($RuntimeIdentity.Count -ne 2 -or [int]$RuntimeIdentity[1] -ne 64) {
        throw "Bundled Python validation failed ($Label): expected 64-bit runtime, got '$($OutputLines[-1])'."
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

function Get-UpdateComponents {
    # Builds the full transactional replacement list, data-driven from the verified
    # package. Every component (immutable directories AND root/backend metadata
    # files) goes through the same stage -> swap -> rollback machinery, so a failed
    # update can never leave a mixed old/new tree behind.
    param([string]$ExtractDir)

    $Components = New-Object System.Collections.ArrayList
    foreach ($Required in @("backend\app", "frontend\dist", "runtime\node", "runtime\higgsfield", "runtime\python")) {
        if (-not (Test-Path -LiteralPath (Join-Path $ExtractDir $Required) -PathType Container)) {
            throw "Update package is missing $Required."
        }
        [void]$Components.Add(@{ Relative = $Required; Kind = "dir" })
    }
    Get-ChildItem -LiteralPath $ExtractDir -Force | ForEach-Object {
        if ($_.PSIsContainer) {
            # backend/frontend/runtime are decomposed above; any other packaged
            # top-level directory (e.g. tools) is replaced wholesale - merges leave
            # files removed by newer releases behind.
            if ($_.Name -ne "backend" -and $_.Name -ne "frontend" -and $_.Name -ne "runtime") {
                [void]$Components.Add(@{ Relative = $_.Name; Kind = "dir" })
            }
        }
        elseif ($_.Name -ne "VERSION.txt") {
            [void]$Components.Add(@{ Relative = $_.Name; Kind = "file" })
        }
    }
    Get-ChildItem -LiteralPath (Join-Path $ExtractDir "backend") -Force | ForEach-Object {
        # backend\data owns user DBs, backup outbox, and replica status. Never touch
        # it even if a malformed package unexpectedly contains data.
        if ($_.PSIsContainer) {
            if ($_.Name -ne "app" -and $_.Name -ne "data") {
                [void]$Components.Add(@{ Relative = "backend\" + $_.Name; Kind = "dir" })
            }
        }
        else {
            [void]$Components.Add(@{ Relative = "backend\" + $_.Name; Kind = "file" })
        }
    }
    return ,$Components
}

function Move-LeftoversToQuarantine {
    # Leftovers from a previously failed or killed update are RECOVERY ASSETS.
    # Deciding "which side is current" from file existence alone is provably
    # unsafe for multi-component crashes (Codex review), so this makes NO guess
    # and deletes NO backup: .previous/.rollback trees and the journal are moved
    # aside into a quarantine folder, and the update then re-stages the fresh
    # package in full - after which the tree is a complete new install no matter
    # what shape the crash left behind. Disposable .next staging copies are the
    # only thing deleted. Quarantine is removed only after this run confirms the
    # new version; if this run fails too, the preserved backups are still on disk.
    $ArtifactPattern = "^.+\.(?<kind>next|previous|rollback)\.[0-9a-f]{8}$"
    $QuarantineRoot = Join-Path $TargetDir ("update-quarantine." + $SwapToken)
    $Bases = @($TargetDir, (Join-Path $TargetDir "backend"), (Join-Path $TargetDir "frontend"), (Join-Path $TargetDir "runtime"))
    # A quarantine folder from an even earlier interrupted run also proves the
    # current tree cannot be trusted as-is.
    if (@(Get-ChildItem -Path (Join-Path $TargetDir "update-quarantine.*") -Force -ErrorAction SilentlyContinue).Count) {
        $script:HadRecoveryAssets = $true
    }
    foreach ($Base in $Bases) {
        if (-not (Test-Path -LiteralPath $Base -PathType Container)) { continue }
        foreach ($Leftover in @(Get-ChildItem -LiteralPath $Base -Force -ErrorAction SilentlyContinue)) {
            if ($Leftover.Name -notmatch $ArtifactPattern) { continue }
            if ($Matches["kind"] -eq "next") {
                Write-Host ("[update] removing stale staging copy: " + $Leftover.FullName)
                Remove-Item -LiteralPath $Leftover.FullName -Recurse -Force -ErrorAction SilentlyContinue
                continue
            }
            New-Item -ItemType Directory -Force -Path $QuarantineRoot | Out-Null
            $Prefix = ""
            if ($Base -ne $TargetDir) { $Prefix = (Split-Path -Leaf $Base) + "." }
            Write-Host ("[update] preserving leftover backup in quarantine: " + $Leftover.FullName)
            Move-PathWithRetry -Path $Leftover.FullName -Destination (Join-Path $QuarantineRoot ($Prefix + $Leftover.Name)) -Label ($Leftover.Name + " (quarantine)")
            $script:HadRecoveryAssets = $true
        }
    }
    if (Test-Path -LiteralPath $JournalPath) {
        New-Item -ItemType Directory -Force -Path $QuarantineRoot | Out-Null
        Move-PathWithRetry -Path $JournalPath -Destination (Join-Path $QuarantineRoot "update-journal.json") -Label "update journal (quarantine)"
        $script:HadRecoveryAssets = $true
    }
}

function New-StagedComponents {
    # Stage every component next to its target (same volume, so the later swap is a
    # pure rename) while the app is still RUNNING - any failure here is harmless,
    # and the actual downtime window shrinks to renames plus verification.
    param(
        [string]$ExtractDir,
        [object[]]$Components
    )
    foreach ($Component in $Components) {
        $Source = Join-Path $ExtractDir $Component.Relative
        $Component.Target = Join-Path $TargetDir $Component.Relative
        $Component.Staged = Join-Path $TargetDir ($Component.Relative + ".next." + $SwapToken)
        $Component.Previous = Join-Path $TargetDir ($Component.Relative + ".previous." + $SwapToken)
        $StagedParent = Split-Path -Parent $Component.Staged
        New-Item -ItemType Directory -Force -Path $StagedParent | Out-Null
        try {
            Copy-Item -LiteralPath $Source -Destination $Component.Staged -Recurse -Force
        }
        catch {
            # The app is still running; one retry absorbs a transient scanner lock.
            Start-Sleep -Milliseconds 750
            Remove-Item -LiteralPath $Component.Staged -Recurse -Force -ErrorAction SilentlyContinue
            Copy-Item -LiteralPath $Source -Destination $Component.Staged -Recurse -Force
        }
    }
}

function Write-UpdateJournal {
    # Persist swap progress so a human (or a later run's recovery pass) can see
    # exactly which components moved. Disk-state recovery does not depend on the
    # journal (Restore-SwapArtifacts verifies the filesystem directly), so mid-swap
    # writes are best-effort - but the INITIAL intent write is -Required: if the
    # journal cannot even be created, abort before the first rename touches the tree.
    param(
        [object[]]$Components,
        [switch]$Required
    )
    try {
        $Entries = @()
        foreach ($Component in $Components) {
            $Entries += @{
                relative = $Component.Relative
                kind = $Component.Kind
                had_previous = [bool]$Component.HadPrevious
                old_moved = [bool]$Component.OldMoved
                swapped = [bool]$Component.Swapped
            }
        }
        @{ token = $SwapToken; updated_at = [DateTime]::UtcNow.ToString("o"); components = $Entries } |
            ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $JournalPath -Encoding UTF8
    }
    catch {
        if ($Required) {
            throw "Could not write the update journal before swapping: $($_.Exception.Message)"
        }
        Write-Host "[update] warn: could not write update journal: $($_.Exception.Message)"
    }
}

function Invoke-ComponentSwap {
    # Downtime section: replace every component by rename only (with lock retries).
    param([object[]]$Components)
    # Compute every HadPrevious up front so the intent journal below is accurate,
    # then record it before the first rename - nothing has been touched yet, so a
    # journal failure here aborts with the old tree fully intact.
    foreach ($Component in $Components) {
        $Component.HadPrevious = [bool](Test-Path -LiteralPath $Component.Target)
    }
    Write-UpdateJournal $Components -Required
    foreach ($Component in $Components) {
        if ($Component.HadPrevious) {
            Move-PathWithRetry -Path $Component.Target -Destination $Component.Previous -Label ($Component.Relative + " (backup)")
        }
        $Component.OldMoved = $true
        Write-UpdateJournal $Components
        Move-PathWithRetry -Path $Component.Staged -Destination $Component.Target -Label $Component.Relative
        $Component.Swapped = $true
        Write-UpdateJournal $Components
    }
}

function Undo-ComponentSwaps {
    # Restore the old tree in reverse order. The new content is quarantined first so
    # the restore rename can never collide. Returns the list of components that
    # could not be restored (empty = full rollback).
    param([object[]]$Components)
    $Failures = New-Object System.Collections.ArrayList
    for ($Index = $Components.Count - 1; $Index -ge 0; $Index--) {
        $Component = $Components[$Index]
        if (-not $Component.OldMoved) { continue }
        try {
            if ($Component.Swapped -and (Test-Path -LiteralPath $Component.Target)) {
                Move-PathWithRetry -Path $Component.Target -Destination ($Component.Target + ".rollback." + $SwapToken) -Label ($Component.Relative + " (quarantine)")
            }
            if ($Component.HadPrevious) {
                Move-PathWithRetry -Path $Component.Previous -Destination $Component.Target -Label ($Component.Relative + " (restore)")
            }
        }
        catch {
            [void]$Failures.Add($Component.Relative + ": " + $_.Exception.Message)
        }
    }
    Write-UpdateJournal $Components
    return ,@($Failures)
}

function Remove-SwapLeftovers {
    # Cleanup of this run's swap artifacts. Cleanup trouble is logged, never
    # escalated into a failure. Quarantined backups from earlier interrupted runs
    # are deleted ONLY with -IncludeQuarantine (i.e. after this run confirmed a
    # complete install) - a failed recovery reinstall must keep them on disk.
    param(
        [object[]]$Components,
        [switch]$IncludeQuarantine
    )
    foreach ($Component in $Components) {
        foreach ($Leftover in @($Component.Previous, $Component.Staged, ($Component.Target + ".rollback." + $SwapToken))) {
            if ($Leftover -and (Test-Path -LiteralPath $Leftover)) {
                Remove-Item -LiteralPath $Leftover -Recurse -Force -ErrorAction SilentlyContinue
                if (Test-Path -LiteralPath $Leftover) {
                    Write-Host "[update] warn: could not remove leftover $Leftover (will be cleaned on the next update)"
                }
            }
        }
    }
    if ($IncludeQuarantine) {
        Get-ChildItem -Path (Join-Path $TargetDir "update-quarantine.*") -Force -ErrorAction SilentlyContinue |
            Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
        Remove-Item -LiteralPath $JournalPath -Force -ErrorAction SilentlyContinue
    }
}

function Commit-VersionMarker {
    # VERSION is the transaction commit marker. Never advertise the new version
    # before every file and runtime validation has passed; a failed update must be
    # retried instead of being mistaken for an up-to-date installation. Written via
    # a same-volume temp file + atomic replace so it can never be half-written.
    # The backup argument must be [NullString]::Value, not $null: Windows PowerShell
    # turns $null into an empty string for .NET [string] parameters, and File.Replace
    # then fails with "The path is not of a legal form." (2026-09-02 field failure).
    param([string]$Version)
    $VersionPath = Join-Path $TargetDir "VERSION.txt"
    $TempPath = Join-Path $TargetDir ("VERSION.txt.commit." + $SwapToken)
    Set-Content -LiteralPath $TempPath -Value $Version -Encoding ASCII
    if (Test-Path -LiteralPath $VersionPath) {
        # Same transient-lock tolerance as the swaps: a scanner touching the old
        # marker for a moment must not fail an otherwise fully verified install.
        $ReplaceDeadline = (Get-Date).AddSeconds(5)
        while ($true) {
            try {
                [System.IO.File]::Replace($TempPath, $VersionPath, [NullString]::Value)
                break
            }
            catch {
                $LockCode = Get-TransientLockCode -Exception $_.Exception
                if (-not ($script:RetryableMoveCodes -contains $LockCode) -or (Get-Date) -ge $ReplaceDeadline) { throw }
                Start-Sleep -Milliseconds 250
            }
        }
    }
    else {
        Move-PathWithRetry -Path $TempPath -Destination $VersionPath -Label "VERSION.txt"
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

function Assert-NoActiveResolveImport {
    param([string]$Root)

    if (-not (Test-Path -LiteralPath $Root)) {
        return
    }
    $ResolvedRoot = (Resolve-Path -LiteralPath $Root).Path.TrimEnd("\") + "\"
    $Active = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
        $CommandLine = [string]$_.CommandLine
        $ExecutablePath = [string]$_.ExecutablePath
        $BelongsToRoot = $ExecutablePath -and $ExecutablePath.StartsWith(
            $ResolvedRoot,
            [StringComparison]::OrdinalIgnoreCase
        )
        $BelongsToRoot -and
            $CommandLine.IndexOf(
                "app.services.resolve_import_worker",
                [StringComparison]::OrdinalIgnoreCase
            ) -ge 0
    })
    if ($Active.Count) {
        $Names = ($Active | ForEach-Object { "pid=$($_.ProcessId)" }) -join ", "
        throw "DaVinci Resolve import is still running ($Names). Wait for it to finish, then update again."
    }
}

function Install-Package {
    param(
        [object]$Latest,
        [string]$TempRoot
    )

    $ZipPath = Join-Path $TempRoot $Latest.file
    $ExtractDir = Join-Path $TempRoot "extract"

    # ----- Prepare phase: the running app is untouched until the Commit phase. -----
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
    Assert-PythonRuntime -RuntimeDir (Join-Path $ExtractDir "runtime\python") -Label "package"

    $Components = Get-UpdateComponents -ExtractDir $ExtractDir

    # Staging duplicates the package next to the install; require the headroom up
    # front instead of dying halfway through a copy.
    $PackageBytes = (Get-ChildItem -LiteralPath $ExtractDir -Recurse -File | Measure-Object -Property Length -Sum).Sum
    $TargetRoot = [System.IO.Path]::GetPathRoot($TargetDir)
    $FreeBytes = (New-Object System.IO.DriveInfo($TargetRoot)).AvailableFreeSpace
    if ($FreeBytes -lt ($PackageBytes + 200MB)) {
        throw "Not enough free disk space on $TargetRoot to stage the update (need ~$([Math]::Ceiling($PackageBytes / 1MB)) MB free)."
    }

    Write-Host "[update]  70%  Staging new files next to the install..."
    Write-UpdateState -State "installing" -Message "Staging verified files..." -Latest ([string]$Latest.version) -Percent 70
    New-StagedComponents -ExtractDir $ExtractDir -Components $Components
    Assert-PythonRuntime -RuntimeDir (Join-Path $TargetDir ("runtime\python.next." + $SwapToken)) -Label "staged"

    # ----- Commit phase: stop the app, swap by rename only, verify, mark version. -----
    Assert-NoActiveResolveImport -Root $TargetDir
    Stop-MvHubProcesses -Root $TargetDir
    $script:ProcessesStopped = $true
    # From here until the version marker commits, the old tree is either untouched
    # or restorable from .previous - so a failure below reports recovery=rolled_back
    # unless the rollback itself breaks.
    $script:RecoveryState = "rolled_back"
    $script:InstalledComponents = $Components

    try {
        Write-Host "[update]  80%  Swapping staged files into place..."
        Write-UpdateState -State "installing" -Message "Installing verified files..." -Latest ([string]$Latest.version) -Percent 80
        Invoke-ComponentSwap -Components $Components

        Write-Host "[update]  90%  Verifying installed files..."
        Write-UpdateState -State "installing" -Message "Verifying installed files..." -Latest ([string]$Latest.version) -Percent 90
        Assert-AppLayout -Root $TargetDir -Label "installed"
        Assert-PythonRuntime -RuntimeDir (Join-Path $TargetDir "runtime\python") -Label "installed"
        Assert-BundledCli -Root $TargetDir -ExpectedVersion $ExpectedCliVersion -Label "installed" | Out-Null
        # INSTALL_SOURCE.txt is deliberately NOT rewritten here: its value is what
        # this run was read from, and a non-atomic Set-Content outside the swap
        # transaction could leave it half-written (Codex review). The first-time
        # installer owns writing it.
        Commit-VersionMarker -Version ([string]$Latest.version)
        $script:RecoveryState = "new_committed"
    }
    catch {
        $InstallError = $_.Exception.Message
        Write-Host "[update] Install failed - rolling back to the previous version: $InstallError"
        $Failures = @(Undo-ComponentSwaps -Components $Components)
        if ($Failures.Count) {
            # Rollback is incomplete: keep .previous backups and the journal for
            # manual recovery, and never auto-restart a half-swapped tree.
            $script:RecoveryState = "recovery_required"
            throw "Install failed and rollback is incomplete [$($Failures -join '; ')]. Backups (*.previous.$SwapToken) and update-journal.json are preserved in $TargetDir. Original error: $InstallError"
        }
        if ($script:HadRecoveryAssets) {
            # The tree we just rolled back TO was itself left by an interrupted
            # earlier run - it may be half-swapped. Never boot it, and keep the
            # quarantined backups on disk (Codex review).
            $script:RecoveryState = "recovery_required"
            throw "Recovery reinstall failed; the pre-existing tree is not trustworthy. Quarantined backups are preserved in $TargetDir\update-quarantine.*. Original error: $InstallError"
        }
        Remove-SwapLeftovers -Components $Components
        throw
    }
}

$TempRoot = Join-Path $env:TEMP ("mvhub-update-" + [Guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Force -Path $TempRoot | Out-Null

# One updater per install: the in-app path is already serialized by the backend,
# but a manually launched update_release.bat can race it. Exit code 17 tells the
# batch wrapper to leave the live updater's state file alone.
$UpdateLockPath = Join-Path $TargetDir ".update.lock"
$UpdateLockStream = $null
try {
    $UpdateLockStream = [System.IO.File]::Open(
        $UpdateLockPath,
        [System.IO.FileMode]::OpenOrCreate,
        [System.IO.FileAccess]::ReadWrite,
        [System.IO.FileShare]::None
    )
}
catch {
    # Only a genuine sharing/lock violation means "another updater is running".
    # ACL or disk errors must surface as a normal failure, not be mistaken for a
    # duplicate run (Codex review).
    $Inner = $_.Exception
    while ($null -ne $Inner.InnerException) { $Inner = $Inner.InnerException }
    $Win32Code = -1
    try {
        $HResult = [int]$Inner.HResult
        if ((($HResult -shr 16) -band 0xFFFF) -eq 0x8007) {
            $Win32Code = $HResult -band 0xFFFF
        }
    }
    catch {
        $Win32Code = -1
    }
    if ($Win32Code -eq 32 -or $Win32Code -eq 33) {
        Write-Host "[ERROR] Another MV Hub update is already running for this install."
        Remove-Item -LiteralPath $TempRoot -Recurse -Force -ErrorAction SilentlyContinue
        [Environment]::Exit(17)
    }
    Remove-Item -LiteralPath $TempRoot -Recurse -Force -ErrorAction SilentlyContinue
    throw
}

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

    # Leftovers are handled BEFORE the same-version early return: a crashed
    # transaction can leave a matching VERSION with backups still on disk, and
    # recovery must not be skipped just because versions match (Codex review).
    # Moving them aside never touches live targets, so this is safe while the
    # app is still running; the layout checks below then judge the real tree.
    New-Item -ItemType Directory -Force -Path $TargetDir | Out-Null
    Move-LeftoversToQuarantine

    # Recovery assets prove the tree may be half-swapped: shallow layout checks
    # cannot certify it, so a matching version never skips the full reinstall.
    $NeedsInstall = ($CurrentVersion -ne [string]$Latest.version) -or $script:HadRecoveryAssets
    if ($script:HadRecoveryAssets) {
        Write-Host "[2/3] Previous update left recovery backups behind - forcing a full reinstall."
    }
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
        # Backups are only deleted after the new version is confirmed (readiness for
        # auto-restart, commit for manual runs). Cleanup trouble never fails the update.
        if ($script:InstalledComponents) {
            Remove-SwapLeftovers -Components $script:InstalledComponents -IncludeQuarantine
        }
    }

    Write-Host "[3/3] Update complete."
}
catch {
    # Preserve the original install error first: recording state and relaunching
    # the app are independent best-effort steps that must not mask it - and a
    # state-file hiccup must not leave the app dead (Codex review).
    $InstallFailure = $_
    try {
        Write-UpdateState -State "failed" -Message ("Update failed: " + $InstallFailure.Exception.Message) -Latest $LatestVersion -Recovery $script:RecoveryState
    }
    catch {
        Write-Host "[update] warn: could not record the failed state: $($_.Exception.Message)"
    }
    # If we killed the app and the old tree is intact (or the new one committed),
    # bring MV Hub back up so nobody is stranded on a dead backend with a frozen
    # progress screen. A half-swapped tree (recovery_required) must NOT be booted.
    if (
        $script:ProcessesStopped -and
        $RestartAfterInstall -eq "1" -and
        ($script:RecoveryState -eq "rolled_back" -or $script:RecoveryState -eq "new_committed")
    ) {
        Start-MvHubAfterFailure
    }
    throw $InstallFailure
}
finally {
    if ($UpdateLockStream) {
        $UpdateLockStream.Dispose()
        Remove-Item -LiteralPath $UpdateLockPath -Force -ErrorAction SilentlyContinue
    }
    Remove-Item -LiteralPath $TempRoot -Recurse -Force -ErrorAction SilentlyContinue
}

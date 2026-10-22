param(
    [Parameter(Mandatory = $true)]
    [string]$Root,
    [switch]$Elevated,
    [string]$SourceReceipt = "",
    [string]$VerificationPython = "",
    [switch]$NoPause
)

$ErrorActionPreference = "Stop"
$ExitCode = 1
$TempWorkers = New-Object System.Collections.Generic.List[string]
$GitLock = $null
$UpdateLock = $null
$SupervisorLock = $null
$PauseAtEnd = -not ($NoPause -or $env:MVHUB_NO_PAUSE -eq "1")

function Test-UpdateAdministrator {
    $Principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
    return $Principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Assert-LocalUpdatePath([string]$Path) {
    if (-not [IO.Path]::IsPathRooted($Path) -or $Path.StartsWith("\\") -or $Path -match '["%!\r\n]') {
        throw "The updater requires an absolute local path without cmd expansion characters."
    }
    for ($item = $Path; $item; $item = [IO.Path]::GetDirectoryName($item)) {
        if ((Test-Path -LiteralPath $item) -and ((Get-Item -LiteralPath $item -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) {
            throw "Update paths must not traverse a reparse point."
        }
    }
}

function Assert-ElevationArgument([string]$Value) {
    # A quote, cmd expansion character or trailing backslash would split or rewrite the relaunched argument.
    if (-not $Value -or $Value -match '["%!\r\n]' -or $Value.EndsWith("\")) {
        throw "Updater arguments must not contain quotes, %, !, line breaks or a trailing backslash."
    }
}

function Get-UpdateOverride([string]$Argument, [string]$Name) {
    $Value = if ($Argument) { $Argument } else { [Environment]::GetEnvironmentVariable($Name, "Process") }
    if ($Value) {
        Assert-ElevationArgument $Value
        if (-not (Test-RootedUpdatePath $Value)) { throw "$Name must be an absolute path." }
    }
    return $Value
}

function Format-UpdateArgument([string]$Value) {
    Assert-ElevationArgument $Value
    return '"' + $Value + '"'
}

function Wait-UpdateKey {
    # Without a console keyboard (redirected input) there is nobody to wait for.
    if ([Console]::IsInputRedirected) { return }
    Write-Host "Press any key to continue . . ."
    [void][Console]::ReadKey($true)
}

function Invoke-ElevatedUpdate([string]$RootPath, [bool]$Quiet) {
    # Elevation does not reliably carry this window's environment: pass only explicit, re-checked values.
    # Fixed switches stay bare; every value is quoted, so a value can never become a separate option.
    $Parts = @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", (Format-UpdateArgument $PSCommandPath),
               "-Root", (Format-UpdateArgument $RootPath), "-Elevated")
    $Receipt = Get-UpdateOverride $SourceReceipt "MVHUB_SERVER_SOURCE_RECEIPT"
    $Verifier = Get-UpdateOverride $VerificationPython "MVHUB_SERVER_VERIFICATION_PYTHON"
    if ($Receipt) { $Parts += @("-SourceReceipt", (Format-UpdateArgument $Receipt)) }
    if ($Verifier) { $Parts += @("-VerificationPython", (Format-UpdateArgument $Verifier)) }
    if ($Quiet) { $Parts += "-NoPause" }
    $Line = $Parts -join " "
    try {
        $Process = Start-Process -FilePath (Join-Path $PSHOME "powershell.exe") -Verb RunAs `
            -WorkingDirectory $RootPath -ArgumentList $Line -PassThru
    }
    catch {
        Write-Host "[ERROR] Administrator approval was cancelled or failed: $($_.Exception.Message)"
        if (-not $Quiet) { Wait-UpdateKey }
        return 1
    }
    # Hold the handle so ExitCode survives; -Wait would also wait for long-lived grandchildren.
    $null = $Process.Handle
    $Process.WaitForExit()
    return $Process.ExitCode
}

function Read-UpdateBytes([string]$Path) {
    return ,([System.IO.File]::ReadAllBytes($Path))
}

function Get-BytesSha256([byte[]]$Bytes) {
    $Hasher = [System.Security.Cryptography.SHA256]::Create()
    try { return [System.BitConverter]::ToString($Hasher.ComputeHash($Bytes)).Replace("-", "") }
    finally { $Hasher.Dispose() }
}

function Initialize-ServerVerifier([string]$RootPath) {
    $Code = Invoke-UpdateBatch (Join-Path $RootPath "run_py.bat") @(
        (Join-Path $RootPath "tools\server_verifier.py"), "--root", $RootPath)
    if ($Code -ne 0) { throw "The server verifier Python could not be prepared (see the message above)." }
    $Path = Join-Path $RootPath "logs\server-verifier\Scripts\python.exe"
    Assert-LocalUpdatePath $Path
    return $Path
}

function Get-SelectedCommit([string]$RootPath) {
    & git -C $RootPath fetch origin main
    if ($LASTEXITCODE -ne 0) { throw "git fetch origin main failed." }
    $Output = @(& git -C $RootPath rev-parse origin/main)
    $Commit = if ($Output.Count) { [string]$Output[0] } else { "" }
    if ($LASTEXITCODE -ne 0 -or $Commit -notmatch '^[0-9a-f]{40}$') { throw "Could not read origin/main." }
    return $Commit
}

function Import-ServerReceipt([string]$RootPath, [string]$Commit) {
    $Config = Join-Path $RootPath "logs\server-update.local.json"
    if (-not (Test-Path -LiteralPath $Config -PathType Leaf)) {
        throw ("The server receipt folder is not configured. Create $Config with " +
            '{"receipt_dir": "\\\\NAS\\share\\MV_hub_S\\server-receipts"} (docs/SERVER.md).')
    }
    $Directory = [string]((Get-Content -LiteralPath $Config -Raw -Encoding UTF8 | ConvertFrom-Json).receipt_dir)
    if (-not $Directory) { throw "receipt_dir is missing in $Config." }
    $Short = $Commit.Substring(0, 12)
    $Source = Join-Path $Directory ($Commit + ".json")
    try { $Bytes = [byte[]](Read-UpdateBytes $Source) }
    catch {
        throw ("No readable server receipt for $Short at $Source. Publish it from the release PC with " +
            "tools\publish_server_receipt.py; if it exists, this administrator window may lack saved Windows " +
            "credentials for that NAS share. ($($_.Exception.Message))")
    }
    $Hash = Get-BytesSha256 $Bytes
    if ([string](([System.Text.Encoding]::UTF8.GetString($Bytes) | ConvertFrom-Json).source.commit) -ne $Commit) {
        throw "The published receipt for $Short names a different commit."
    }
    $Store = Join-Path $RootPath "logs\server-receipts"
    Assert-LocalUpdatePath $Store
    [void][System.IO.Directory]::CreateDirectory($Store)
    $Final = Join-Path $Store ($Commit + ".json")
    $Temp = $Final + ".tmp-" + [Guid]::NewGuid().ToString("N")
    try {
        # Creation, write, verification and publish share one cleanup scope (a failed write leaves no .tmp).
        $Stream = [System.IO.File]::Open($Temp, [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)
        try { $Stream.Write($Bytes, 0, $Bytes.Length); $Stream.Flush($true) }
        finally { $Stream.Dispose() }
        if ((Get-BytesSha256 ([byte[]](Read-UpdateBytes $Source))) -ne $Hash) {
            throw "The published receipt for $Short changed while it was being copied. Run update_git.bat again."
        }
        if (Test-Path -LiteralPath $Final) {
            if ((Get-BytesSha256 ([byte[]](Read-UpdateBytes $Final))) -ne $Hash) {
                throw "A different local receipt copy already exists: $Final"
            }
        }
        else { [System.IO.File]::Move($Temp, $Final) }
    }
    finally {
        if (Test-Path -LiteralPath $Temp) { Remove-Item -LiteralPath $Temp -Force }
    }
    return $Final
}

function Write-RemoteChangeNote([string]$RootPath, [string]$Commit) {
    # Diagnostic only: its own failure must never replace the coordinator's exit code.
    try {
        # Read all output: Select-Object -First would stop git early and leave LASTEXITCODE = -1.
        $Output = @(& git -C $RootPath rev-parse origin/main 2>$null)
        $Now = if ($Output.Count) { [string]$Output[0] } else { "" }
        if ($LASTEXITCODE -eq 0 -and $Now -and $Now -ne $Commit) {
            Write-Host "[note] origin/main also moved from $($Commit.Substring(0, 12)) to $($Now.Substring(0, [Math]::Min(12, $Now.Length))) during preparation. Check the error above, then run update_git.bat again."
        }
    }
    catch { }
}

function Open-UpdateLock([string]$Path) {
    Assert-LocalUpdatePath $Path
    $stream = [IO.File]::Open($Path, [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::ReadWrite)
    try {
        # Match server_activation.exclusive_lock: byte zero, length one. Never truncate a marker.
        $stream.Lock(0, 1)
        return $stream
    }
    catch {
        $stream.Dispose()
        if (($_.Exception.GetBaseException().HResult -band 0xffff) -eq 33) { return $null }
        throw
    }
}

function Split-UpdateCommandLine([string]$CommandLine) {
    $tokens = New-Object System.Collections.Generic.List[string]
    $current = New-Object Text.StringBuilder
    $inQuote = $false
    foreach ($ch in $CommandLine.ToCharArray()) {
        if ($ch -eq '"') { $inQuote = -not $inQuote; continue }
        if (-not $inQuote -and ($ch -eq ' ' -or $ch -eq "`t")) {
            if ($current.Length) { [void]$tokens.Add($current.ToString()); [void]$current.Clear() }
        }
        else { [void]$current.Append($ch) }
    }
    if ($inQuote) { throw "Could not determine an updater/server command line. Clear the running process before retrying." }
    if ($current.Length) { [void]$tokens.Add($current.ToString()) }
    return $tokens.ToArray()
}

# Windows PowerShell 5.1 throws on <>|" in path APIs; redirect tokens such as '>' or '2>&1' are never paths.
function Test-RootedUpdatePath([string]$Value) {
    try { return [IO.Path]::IsPathRooted($Value) } catch { return $false }
}

function Get-UpdatePathLeaf([string]$Value) {
    try { return [IO.Path]::GetFileName($Value) } catch { return '' }
}

function Test-UpdatePathArgument([string]$Value, [string]$Expected) {
    if (-not (Test-RootedUpdatePath $Value)) { return $false }
    try { return [string]::Equals([IO.Path]::GetFullPath($Value), $Expected, [StringComparison]::OrdinalIgnoreCase) }
    catch { return $false }
}

function Get-GitUpdateRole([string]$RootPath, [bool]$SupervisorFree) {
    # Query failure is different from confirmed absence, including access-denied SYSTEM processes.
    $processes = @(Get-CimInstance -ClassName Win32_Process -ErrorAction Stop)
    $tasks = @(Get-ScheduledTask -ErrorAction Stop)
    $supervisors = @()
    $otherServerProcess = $false
    $expectedSupervisor = Join-Path $RootPath 'tools\server_supervisor.py'
    $expectedServe = Join-Path $RootPath 'backend\serve.py'
    $expectedLauncher = Join-Path $RootPath 'MV_server.bat'
    $taskLauncher = Join-Path $RootPath 'task_launch.bat'
    foreach ($process in $processes) {
        if ($process.Name -notmatch '^(python[0-9.]*w?|py|cmd|powershell|pwsh)\.exe$') { continue }
        if ([string]::IsNullOrWhiteSpace($process.CommandLine)) {
            throw "Cannot inspect a possible server process. Obtain process-query access or stop it before updating."
        }
        if ($process.CommandLine.IndexOf($RootPath, [StringComparison]::OrdinalIgnoreCase) -lt 0 -and
            $process.CommandLine -notmatch '(serve|server_supervisor)\.py') { continue }
        $tokens = @(Split-UpdateCommandLine $process.CommandLine)
        $proved = $false
        $scriptIndex = 1
        while ($scriptIndex -lt $tokens.Count -and $tokens[$scriptIndex] -match '^-(B|E|I|S|s|u)$') { $scriptIndex++ }
        while ($scriptIndex + 1 -lt $tokens.Count -and $tokens[$scriptIndex] -match '^-(X|W)$') { $scriptIndex += 2 }
        if ($process.Name -match '^python[0-9.]*w?\.exe$' -and $scriptIndex -lt $tokens.Count -and
            (Test-UpdatePathArgument $tokens[$scriptIndex] $expectedSupervisor)) {
            if (-not $process.ProcessId -or -not $process.CreationDate -or
                -not $process.ExecutablePath -or -not (Test-Path -LiteralPath $process.ExecutablePath -PathType Leaf)) {
                throw "The supervisor's live process identity is unavailable."
            }
            $supervisors += $process
            $proved = $true
        }
        foreach ($token in $tokens) {
            # A supervisor path outside a verified supervisor process is server evidence too, never a worker.
            if ((Test-UpdatePathArgument $token $expectedServe) -or (Test-UpdatePathArgument $token $expectedLauncher) -or
                (Test-UpdatePathArgument $token $expectedSupervisor)) {
                $otherServerProcess = $true
                $proved = $true
            }
            # An unproved relative server argument stays ambiguous regardless of Python option order.
            if ($process.Name -match '^(python[0-9.]*w?|py)\.exe$' -and
                $token -notmatch '^(?:[A-Za-z]:[\\/]|[\\/]{2})' -and
                (Get-UpdatePathLeaf $token) -in @('serve.py', 'server_supervisor.py')) {
                throw "A server process uses a relative entrypoint; its installation cannot be established. Stop it before updating."
            }
        }
        # The token split does not model every cmd quoting form (e.g. cmd /c ""exe" "a b\serve.py""); an entry
        # path visible in the raw command line but not in its tokens must never fall through to a worker update.
        if (-not $proved) {
            foreach ($entry in @($expectedServe, $expectedSupervisor, $expectedLauncher)) {
                if ($process.CommandLine.IndexOf($entry, [StringComparison]::OrdinalIgnoreCase) -ge 0) {
                    throw "A server command line could not be parsed; its installation cannot be established. Stop it before updating."
                }
            }
        }
    }
    $scheduledServer = $false
    foreach ($task in $tasks) {
        $knownServerTask = $false
        foreach ($action in $task.Actions) {
            if ($task.TaskName -ne 'MVHub Server' -and
                ([string]$action.Arguments).IndexOf($RootPath, [StringComparison]::OrdinalIgnoreCase) -lt 0 -and
                -not (Test-UpdatePathArgument ([string]$action.Execute) $expectedLauncher)) { continue }
            $tokens = @($action.Execute) + @(Split-UpdateCommandLine ([string]$action.Arguments))
            $actionProved = $false
            for ($i = 0; $i -lt $tokens.Count; $i++) {
                if (Test-UpdatePathArgument $tokens[$i] $expectedLauncher) { $scheduledServer = $true; $actionProved = $true }
                if ((Test-UpdatePathArgument $tokens[$i] $taskLauncher) -and $i + 1 -lt $tokens.Count -and $tokens[$i + 1] -eq 'server') {
                    $scheduledServer = $true; $actionProved = $true
                }
                if ((Test-RootedUpdatePath $tokens[$i]) -and
                    (([IO.Path]::GetFileName($tokens[$i]) -eq 'MV_server.bat') -or
                     ([IO.Path]::GetFileName($tokens[$i]) -eq 'task_launch.bat' -and $i + 1 -lt $tokens.Count -and $tokens[$i + 1] -eq 'server'))) {
                    $knownServerTask = $true
                }
            }
            # Same rule as processes: this installation's server launch in the raw action text must be proved by tokens.
            $raw = [string]$action.Execute + ' ' + [string]$action.Arguments
            if (-not $actionProved -and ($raw.IndexOf($expectedLauncher, [StringComparison]::OrdinalIgnoreCase) -ge 0 -or
                $raw -match ([regex]::Escape($taskLauncher) + '"*\s+"*server(?![\w.])'))) {
                throw "A scheduled server action could not be parsed; its installation cannot be established."
            }
        }
        if ($task.TaskName -eq 'MVHub Server' -and -not $knownServerTask) {
            throw "The registered server task's installation cannot be established."
        }
    }
    if (-not $SupervisorFree) {
        if ($supervisors.Count -ne 1) { throw "The supervisor lock is busy but its owning server cannot be established." }
        return 'server'
    }
    if ($supervisors.Count -or $otherServerProcess -or $scheduledServer) {
        throw "This installation is a server without its active supervisor. Start MV_server.bat before a staged update."
    }
    $serverStateNames = @('server-activation.json', 'server-current.json', 'server-install-journal.json',
                         'server-update-request.json', 'server-prepare.json', 'server-stages', 'server_ALERT.txt')
    # Successful full enumeration proves absence; failed observation must never mean a worker.
    foreach ($item in @(Get-ChildItem -LiteralPath (Join-Path $RootPath 'logs') -Force -ErrorAction Stop)) {
        if ($item.Name -in $serverStateNames) {
            throw "Server state remains without a verified live supervisor. Resolve server recovery before updating."
        }
    }
    return 'worker'
}

function Get-Sha256Hex {
    param(
        [Parameter(Mandatory = $true)]
        [string]$LiteralPath
    )

    # Get-FileHash is loaded from Microsoft.PowerShell.Utility on demand. A fresh or
    # redirected TEMP can prevent that module's analysis cache from loading during
    # updater bootstrap, so use the .NET runtime that Windows PowerShell already owns.
    $Stream = [System.IO.File]::OpenRead($LiteralPath)
    try {
        $Hasher = [System.Security.Cryptography.SHA256]::Create()
        try {
            return [System.BitConverter]::ToString(
                $Hasher.ComputeHash($Stream)
            ).Replace("-", "")
        }
        finally {
            $Hasher.Dispose()
        }
    }
    finally {
        $Stream.Dispose()
    }
}

function Invoke-UpdateBatch([string]$BatchPath, [string[]]$Arguments) {
    $quoted = @($BatchPath) + $Arguments | ForEach-Object {
        if ($_ -match '["%!\r\n]') { throw "Unsupported cmd expansion characters in updater arguments." }
        '"' + $_ + '"'
    }
    $Process = New-Object System.Diagnostics.Process
    try {
        $Process.StartInfo = New-Object System.Diagnostics.ProcessStartInfo
        $Process.StartInfo.FileName = $env:ComSpec
        $Process.StartInfo.Arguments = '/d /s /c "' + ($quoted -join ' ') + '"'
        $Process.StartInfo.UseShellExecute = $false
        if (-not $Process.Start()) { throw "Could not start the isolated update command." }
        $Process.WaitForExit()
        return $Process.ExitCode
    }
    finally { $Process.Dispose() }
}

function Invoke-IsolatedWorker {
    param(
        [Parameter(Mandatory = $true)]
        [string]$WorkerPath,
        [Parameter(Mandatory = $true)]
        [string]$RootPath
    )

    $TempWorker = Join-Path $env:TEMP ("mvhub-update-{0}.bat" -f [Guid]::NewGuid().ToString("N"))
    Copy-Item -LiteralPath $WorkerPath -Destination $TempWorker -Force
    [void]$TempWorkers.Add($TempWorker)
    $body = [IO.File]::ReadAllText($TempWorker)
    $marker = 'REM MVHUB_ISOLATED_WORKER_BODY'
    $offset = $body.IndexOf($marker + "`r`n", [StringComparison]::Ordinal)
    $markerLength = $marker.Length + 2
    if ($offset -lt 0) {
        $offset = $body.IndexOf($marker + "`n", [StringComparison]::Ordinal)
        $markerLength = $marker.Length + 1
    }
    if ($offset -ge 0) { [IO.File]::WriteAllText($TempWorker, $body.Substring($offset + $markerLength), [Text.Encoding]::ASCII) }
    return Invoke-UpdateBatch $TempWorker @($RootPath)
}

try {
    if (-not (Test-UpdateAdministrator)) {
        if ($Elevated) {
            throw "Administrator privileges required. Run this updater in an administrator console."
        }
        # Relaunch once through UAC before any lock, role query or Git work; no state exists yet to clean up.
        exit (Invoke-ElevatedUpdate ([System.IO.Path]::GetFullPath($Root).TrimEnd("\", "/")) (-not $PauseAtEnd))
    }
    $RootPath = [System.IO.Path]::GetFullPath($Root).TrimEnd("\", "/")
    Assert-LocalUpdatePath $RootPath
    $Worker = Join-Path $RootPath "tools\update_git_worker.bat"
    if (-not (Test-Path -LiteralPath $Worker -PathType Leaf)) {
        throw "Update worker is missing: $Worker"
    }
    $Logs = Join-Path $RootPath 'logs'
    Assert-LocalUpdatePath $Logs
    [void][IO.Directory]::CreateDirectory($Logs)
    # Every supported entry, including direct worker invocation, retains these locks through retry.
    $GitLock = Open-UpdateLock (Join-Path $Logs 'git-update.lock')
    if ($null -eq $GitLock) { throw "Another Git updater is active." }
    $UpdateLock = Open-UpdateLock (Join-Path $Logs 'server-update.lock')
    if ($null -eq $UpdateLock) { throw "A server stage updater is active." }
    $SupervisorLock = Open-UpdateLock (Join-Path $Logs 'server-supervisor.lock')
    $Role = Get-GitUpdateRole $RootPath ($null -ne $SupervisorLock)
    if ($Role -eq 'server') {
        # The existing coordinator owns this lock itself; do not self-deadlock.
        $UpdateLock.Dispose()
        $UpdateLock = $null
        # Each input: explicit argument or environment variable first, otherwise the automatic local setup.
        $ReceiptPath = Get-UpdateOverride $SourceReceipt "MVHUB_SERVER_SOURCE_RECEIPT"
        $VerifierPath = Get-UpdateOverride $VerificationPython "MVHUB_SERVER_VERIFICATION_PYTHON"
        $SelectedCommit = $null
        if (-not $VerifierPath) { $VerifierPath = Initialize-ServerVerifier $RootPath }
        if (-not $ReceiptPath) {
            $SelectedCommit = Get-SelectedCommit $RootPath
            $ReceiptPath = Import-ServerReceipt $RootPath $SelectedCommit
        }
        $ExitCode = Invoke-UpdateBatch (Join-Path $RootPath 'run_py.bat') @(
            (Join-Path $RootPath 'tools\server_release_update.py'), '--root', $RootPath,
            '--source-receipt', $ReceiptPath,
            '--verification-python', $VerifierPath)
        if ($ExitCode -ne 0 -and $SelectedCommit) { Write-RemoteChangeNote $RootPath $SelectedCommit }
    }
    else {

        # cmd.exe reads batch files from disk while they run; immutable TEMP survives git pull.
        $InitialWorkerHash = Get-Sha256Hex -LiteralPath $Worker
        $ExitCode = Invoke-IsolatedWorker -WorkerPath $Worker -RootPath $RootPath

        # Retry an updater migration once, keeping admission locks throughout both immutable bodies.
        if ($ExitCode -ne 0 -and (Test-Path -LiteralPath $Worker -PathType Leaf)) {
            $CurrentWorkerHash = Get-Sha256Hex -LiteralPath $Worker
            if ($CurrentWorkerHash -ne $InitialWorkerHash) {
                Write-Host "[recovery] The updater changed during git pull; retrying once with the new worker..."
                $ExitCode = Invoke-IsolatedWorker -WorkerPath $Worker -RootPath $RootPath
            }
        }
    }
}
catch {
    Write-Host "[ERROR] Could not start the safe updater: $($_.Exception.Message)"
    $ExitCode = 1
}
finally {
    if ($null -ne $SupervisorLock) { $SupervisorLock.Dispose() }
    if ($null -ne $UpdateLock) { $UpdateLock.Dispose() }
    if ($null -ne $GitLock) { $GitLock.Dispose() }
    foreach ($TempWorker in $TempWorkers) {
        Remove-Item -LiteralPath $TempWorker -Force -ErrorAction SilentlyContinue
    }
}

# Every administrator run (relaunched or opened directly) shows its result once. The non-administrator
# window that relaunched has already exited inside the try block, and waits only when UAC was cancelled.
if ($PauseAtEnd) {
    Write-Host ""
    Write-Host "MV Hub update ended (exit code $ExitCode)."
    Wait-UpdateKey
}
exit $ExitCode

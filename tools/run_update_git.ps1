param(
    [Parameter(Mandatory = $true)]
    [string]$Root
)

$ErrorActionPreference = "Stop"
$ExitCode = 1
$TempWorkers = New-Object System.Collections.Generic.List[string]
$GitLock = $null
$UpdateLock = $null
$SupervisorLock = $null

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

function Test-UpdatePathArgument([string]$Value, [string]$Expected) {
    if (-not [IO.Path]::IsPathRooted($Value)) { return $false }
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
        }
        foreach ($token in $tokens) {
            if ((Test-UpdatePathArgument $token $expectedServe) -or (Test-UpdatePathArgument $token $expectedLauncher)) {
                $otherServerProcess = $true
            }
            # An unproved relative server argument stays ambiguous regardless of Python option order.
            if ($process.Name -match '^(python[0-9.]*w?|py)\.exe$' -and
                $token -notmatch '^(?:[A-Za-z]:[\\/]|[\\/]{2})' -and
                [IO.Path]::GetFileName($token) -in @('serve.py', 'server_supervisor.py')) {
                throw "A server process uses a relative entrypoint; its installation cannot be established. Stop it before updating."
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
            for ($i = 0; $i -lt $tokens.Count; $i++) {
                if (Test-UpdatePathArgument $tokens[$i] $expectedLauncher) { $scheduledServer = $true }
                if ((Test-UpdatePathArgument $tokens[$i] $taskLauncher) -and $i + 1 -lt $tokens.Count -and $tokens[$i + 1] -eq 'server') {
                    $scheduledServer = $true
                }
                if ([IO.Path]::IsPathRooted($tokens[$i]) -and
                    (([IO.Path]::GetFileName($tokens[$i]) -eq 'MV_server.bat') -or
                     ([IO.Path]::GetFileName($tokens[$i]) -eq 'task_launch.bat' -and $i + 1 -lt $tokens.Count -and $tokens[$i + 1] -eq 'server'))) {
                    $knownServerTask = $true
                }
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
        throw "Administrator privileges required. Run this updater in an administrator console."
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
        if (-not $env:MVHUB_SERVER_SOURCE_RECEIPT -or -not $env:MVHUB_SERVER_VERIFICATION_PYTHON) {
            throw "Set MVHUB_SERVER_SOURCE_RECEIPT and MVHUB_SERVER_VERIFICATION_PYTHON for the staged server update."
        }
        $ExitCode = Invoke-UpdateBatch (Join-Path $RootPath 'run_py.bat') @(
            (Join-Path $RootPath 'tools\server_release_update.py'), '--root', $RootPath,
            '--source-receipt', $env:MVHUB_SERVER_SOURCE_RECEIPT,
            '--verification-python', $env:MVHUB_SERVER_VERIFICATION_PYTHON)
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
    if ($env:MVHUB_NO_PAUSE -ne "1") {
        Write-Host "Press any key to continue . . ."
        [void][Console]::ReadKey($true)
    }
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

exit $ExitCode

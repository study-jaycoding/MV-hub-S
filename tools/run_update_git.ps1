param(
    [Parameter(Mandatory = $true)]
    [string]$Root,
    [switch]$Elevated,
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
    $Verifier = Get-UpdateOverride $VerificationPython "MVHUB_SERVER_VERIFICATION_PYTHON"
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

function Initialize-ServerVerifier([string]$RootPath) {
    $Code = Invoke-UpdateBatch (Join-Path $RootPath "run_py.bat") @(
        (Join-Path $RootPath "tools\server_verifier.py"), "--root", $RootPath)
    if ($Code -ne 0) { throw "The server verifier Python could not be prepared (see the message above)." }
    $Path = Join-Path $RootPath "logs\server-verifier\Scripts\python.exe"
    Assert-LocalUpdatePath $Path
    return $Path
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

function Start-UpdateBatch([string]$BatchPath, [string[]]$Arguments) {
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
        return $Process
    }
    catch { $Process.Dispose(); throw }
}

function Invoke-UpdateBatch([string]$BatchPath, [string[]]$Arguments) {
    $Process = Start-UpdateBatch $BatchPath $Arguments
    try {
        $Process.WaitForExit()
        return $Process.ExitCode
    }
    finally { $Process.Dispose() }
}

function Read-UpdateRecord([string]$Path) {
    # Display only: share delete so the coordinator/supervisor can still replace the file while it is read.
    # 'missing' only when the file is certainly absent; every other failure is 'unreadable', never absence.
    try { $Stream = [IO.File]::Open($Path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]'ReadWrite, Delete') }
    catch {
        $Inner = $_.Exception
        while ($Inner.InnerException) { $Inner = $Inner.InnerException }
        if ($Inner -is [IO.FileNotFoundException] -or $Inner -is [IO.DirectoryNotFoundException]) { return @{ State = 'missing' } }
        return @{ State = 'unreadable' }
    }
    try {
        try { $Text = (New-Object IO.StreamReader($Stream, [Text.Encoding]::UTF8)).ReadToEnd() }
        finally { $Stream.Dispose() }
        $Value = $Text | ConvertFrom-Json
        if ($null -eq $Value) { return @{ State = 'unreadable' } }
        return @{ State = 'ok'; Value = $Value }
    }
    catch { return @{ State = 'unreadable' } }
}

function Get-ServerUpdateProgress([string]$Logs) {
    # Reads only files the coordinator and supervisor already write; a folder means its step has started.
    $Prepare = Read-UpdateRecord (Join-Path $Logs 'server-prepare.json')
    $Run = if ($Prepare.State -eq 'ok' -and $Prepare.Value.run_id -is [string]) { $Prepare.Value.run_id } else { '' }
    if (-not $Run) { return @{ Step = 0; Run = ''; Status = ''; Phase = ''; Stage = ''; Journal = '' } }
    $Stage = Join-Path $Logs ('server-stages\' + $Run)
    $Step = 1
    if (Test-Path -LiteralPath (Join-Path $Stage '.venv')) { $Step = 2 }
    if (Test-Path -LiteralPath (Join-Path $Stage 'runtime\higgsfield')) { $Step = 3 }
    if ((Test-Path -LiteralPath (Join-Path $Stage 'frontend\node_modules')) -or
        (Test-Path -LiteralPath (Join-Path $Stage 'frontend\dist\index.html'))) { $Step = 4 }
    if (Test-Path -LiteralPath (Join-Path $Stage 'server-stage.json')) { $Step = 5 }
    # Journal: 'this' (this run's), 'other' (another run's), 'missing', or 'unreadable' (never treated as absent).
    $Record = Read-UpdateRecord (Join-Path $Logs 'server-install-journal.json')
    $Journal = $Record.State
    $Phase = ''
    if ($Record.State -eq 'ok') {
        $Owner = if ($Record.Value.target) { $Record.Value.target.build_id } else { $null }
        # A journal that does not name its run proves nothing about this run.
        if (-not ($Owner -is [string]) -or -not $Owner) { $Journal = 'unreadable' }
        elseif ($Owner -eq $Run) { $Journal = 'this'; $Phase = [string]$Record.Value.phase }
        else { $Journal = 'other' }
    }
    $Status = [string]$Prepare.Value.status
    # The request is posted before 'prepared' is recorded, so this run's journal outranks the prepare status.
    if ($Status -eq 'prepared' -or $Journal -eq 'this') { $Step = 6 }
    return @{ Step = $Step; Run = $Run; Status = $Status; Phase = $Phase; Stage = $Stage; Journal = $Journal }
}

function Show-ServerUpdateProgress([string]$Logs, [hashtable]$Shown, [datetime]$PinAfter) {
    # Display only: no failure here may stop the wait or change the exit code.
    # Shows one run: the first whose per-run prepare record was created after this window started the
    # coordinator (MaxValue pins nothing new). shortcut: a coordinator run by hand at the same moment could
    # be the one shown; the result line never depends on it. Pin by run_id once the coordinator can pass it.
    try {
        $State = Get-ServerUpdateProgress $Logs
        if ($State.Run -and -not $Shown.Run -and
            (Get-Item -LiteralPath (Join-Path $Logs ('server-prepare-' + $State.Run + '.json')) -ErrorAction Stop).CreationTimeUtc -ge $PinAfter) {
            $Shown.Run = $State.Run
        }
        if (-not $Shown.Run -or $State.Run -ne $Shown.Run -or $State.Step -lt $Shown.Step) { return }
        $Labels = @{ 1 = '새 코드 받는 중'; 2 = '파이썬 패키지 설치 중'; 3 = 'Higgsfield CLI 설치 중'
                     4 = '화면(프런트) 설치·빌드 중'; 5 = '새 판 시험 기동 중'; 6 = '서버 바꿔 끼우는 중' }
        $Phases = @{ '' = '전환 요청을 넘겼습니다'; 'prepare' = '새 판 확인'; 'verified' = '새 판 확인'
                     'draining' = '진행 중인 요청 마무리'; 'quiesced' = '서버 잠시 멈춤, DB 안전 사본'
                     'checkpointed' = '서버 잠시 멈춤, DB 안전 사본'; 'activation_pending' = '새 판 켜는 중'
                     'starting' = '새 판 켜는 중'; 'ready' = '새 판 응답 확인'; 'committed' = '바꿔 끼우기 끝'
                     'failed' = '실패, 이전 판으로 되돌리는 중'; 'rolled_back' = '이전 판으로 되돌림'
                     'recovery_required' = '자동 복구가 막힘' }
        $Text = $Labels[$State.Step]
        if ($State.Step -eq 6) {
            $Sub = $Phases[$State.Phase]
            if (-not $Sub) { $Sub = $State.Phase }
            $Text = $Text + ': ' + $Sub
        }
        if ($State.Step -eq $Shown.Step -and $Text -eq $Shown.Text) { return }
        Write-Host ('[{0:HH:mm:ss}] [{1}/6] {2}' -f (Get-Date), $State.Step, $Text)
        $Shown.Step = $State.Step
        $Shown.Text = $Text
    }
    catch { }
}

function Write-ServerUpdateResult([int]$Code) {
    # The verdict is the coordinator's exit code: it returns 0 only when its own run committed or the
    # server already ran origin/main. Records cannot prove which run they belong to, so nothing is added
    # from them, and failures are not explained here; the coordinator's reason is above.
    if ($Code -eq 0) {
        $Text = '완료: 서버가 최신 판으로 동작 중입니다.'
        $Color = 'Green'
    }
    else {
        $Text = "실패: 업데이트가 끝나지 않았습니다(종료 코드 $Code). 위 메시지를 확인하고 이 화면을 보내 주세요."
        $Color = 'Red'
    }
    $Line = '=' * 60
    Write-Host ''
    Write-Host $Line -ForegroundColor $Color
    Write-Host (' ' + $Text) -ForegroundColor $Color
    Write-Host $Line -ForegroundColor $Color
}

function Disable-UpdateQuickEdit {
    # Clicking the window enters Select mode and freezes all output; returns the mode to restore.
    try {
        if ([Console]::IsInputRedirected) { return $null }
        if (-not ('MvHubUpdateConsole' -as [type])) {
            Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class MvHubUpdateConsole { [DllImport("kernel32.dll")] public static extern IntPtr GetStdHandle(int handle); [DllImport("kernel32.dll")] public static extern bool GetConsoleMode(IntPtr handle, out uint mode); [DllImport("kernel32.dll")] public static extern bool SetConsoleMode(IntPtr handle, uint mode); }'
        }
        $Handle = [MvHubUpdateConsole]::GetStdHandle(-10)
        $Mode = [uint32]0
        if (-not [MvHubUpdateConsole]::GetConsoleMode($Handle, [ref]$Mode)) { return $null }
        # Clear ENABLE_QUICK_EDIT_MODE (0x40); ENABLE_EXTENDED_FLAGS (0x80) makes that take effect.
        if ([MvHubUpdateConsole]::SetConsoleMode($Handle, [uint32]((([int64]$Mode) -band 0xFFFFFFBFL) -bor 0x80))) { return $Mode }
    }
    catch { }
    return $null
}

function Restore-UpdateQuickEdit($Mode) {
    if ($null -eq $Mode) { return }
    try { [void][MvHubUpdateConsole]::SetConsoleMode([MvHubUpdateConsole]::GetStdHandle(-10), [uint32]$Mode) } catch { }
}

function Invoke-ServerUpdateWithProgress([string]$RootPath, [string[]]$Arguments) {
    $Logs = Join-Path $RootPath 'logs'
    $Shown = @{ Step = 0; Text = ''; Run = '' }
    $QuickEdit = Disable-UpdateQuickEdit
    try {
        $PinAfter = [DateTime]::UtcNow
        $Process = Start-UpdateBatch (Join-Path $RootPath 'run_py.bat') $Arguments
        try {
            while (-not $Process.WaitForExit(1000)) { Show-ServerUpdateProgress $Logs $Shown $PinAfter }
            $Process.WaitForExit()
            # One last look so the pinned run's final step shows.
            Show-ServerUpdateProgress $Logs $Shown ([DateTime]::MaxValue)
            $Code = $Process.ExitCode
        }
        finally { $Process.Dispose() }
        try { Write-ServerUpdateResult $Code }
        catch {
            # Even the plain fallback line may fail on a broken console; the exit code must survive it.
            try { Write-Host "확인 필요: 결과 안내를 표시하지 못했습니다(종료 코드 $Code)." } catch { }
        }
    }
    # Restored only after the result is printed, so a click cannot freeze the last lines.
    finally { Restore-UpdateQuickEdit $QuickEdit }
    return $Code
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
        # Explicit argument or environment variable first, otherwise the automatic local verifier.
        $VerifierPath = Get-UpdateOverride $VerificationPython "MVHUB_SERVER_VERIFICATION_PYTHON"
        if (-not $VerifierPath) { $VerifierPath = Initialize-ServerVerifier $RootPath }
        # No source-gate receipt: only gated commits reach main (Jay 10-22). The coordinator fetches origin/main.
        # Same coordinator command; the window only adds step lines and one clear result.
        $ExitCode = Invoke-ServerUpdateWithProgress $RootPath @(
            (Join-Path $RootPath 'tools\server_release_update.py'), '--root', $RootPath,
            '--verification-python', $VerifierPath)
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

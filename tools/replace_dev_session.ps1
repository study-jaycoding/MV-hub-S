[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$Root,
    [Parameter(Mandatory = $true)]
    [int]$FrontendPort,
    [Parameter(Mandatory = $true)]
    [int]$BackendPort
)

$ErrorActionPreference = "Stop"
$rootPath = [IO.Path]::GetFullPath($Root).TrimEnd('\')
$guardScript = Join-Path $rootPath "run_agent_session.py"
$devLauncher = Join-Path $rootPath "test_dev.bat"
$ports = @($FrontendPort, $BackendPort) | Select-Object -Unique

function Get-ListeningProcessIds([int]$Port) {
    try {
        return @(
            Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction Stop |
                Select-Object -ExpandProperty OwningProcess -Unique
        )
    }
    catch {
        $ids = @()
        foreach ($line in (& "$env:SystemRoot\System32\netstat.exe" -ano -p tcp 2>$null)) {
            if ($line -match (":{0}\s+.*LISTENING\s+(\d+)\s*$" -f $Port)) {
                $ids += [int]$Matches[1]
            }
        }
        return @($ids | Select-Object -Unique)
    }
}

function Test-ContainsPath([string]$Value, [string]$Path) {
    return (
        $Value -and
        $Value.IndexOf($Path, [StringComparison]::OrdinalIgnoreCase) -ge 0
    )
}

$all = @(Get-CimInstance Win32_Process -ErrorAction Stop)
$byId = @{}
foreach ($process in $all) {
    $byId[[int]$process.ProcessId] = $process
}

function Find-SessionStopTarget([int]$ListenerPid) {
    $cursor = $ListenerPid
    $visited = @{}
    $guardPid = 0
    $launcherPid = 0

    while ($cursor -gt 0 -and -not $visited.ContainsKey($cursor)) {
        $visited[$cursor] = $true
        $process = $byId[$cursor]
        if (-not $process) { break }

        $commandLine = [string]$process.CommandLine
        if (Test-ContainsPath $commandLine $rootPath) {
            if (Test-ContainsPath $commandLine $guardScript) { $guardPid = $cursor }
            if (
                $process.Name -ieq "cmd.exe" -and
                (Test-ContainsPath $commandLine $devLauncher)
            ) {
                $launcherPid = $cursor
            }
        }
        $cursor = [int]$process.ParentProcessId
    }

    if ($launcherPid -gt 0) { return $launcherPid }
    if ($guardPid -gt 0) { return $guardPid }
    return 0
}

$listeners = @()
foreach ($port in $ports) {
    foreach ($listenerPid in @(Get-ListeningProcessIds $port)) {
        $targetPid = Find-SessionStopTarget ([int]$listenerPid)
        $listeners += [pscustomobject]@{
            Port = $port
            ListenerPid = [int]$listenerPid
            TargetPid = [int]$targetPid
        }
    }
}

# Validate every occupied port before stopping anything. If even one listener is unrelated,
# leave all processes untouched so a developer tool cannot close another application.
$unrelated = @($listeners | Where-Object { $_.TargetPid -le 0 })
if ($unrelated.Count -gt 0) {
    foreach ($item in $unrelated) {
        Write-Host "[ERROR] Port $($item.Port) is used by another program (PID $($item.ListenerPid))."
        Write-Host "        It was not stopped. Close that program or change the dev port."
    }
    exit 2
}

$targets = @($listeners | Select-Object -ExpandProperty TargetPid -Unique)
foreach ($targetPid in $targets) {
    Write-Host "[restart] Stopping the previous MV Hub dev session (PID $targetPid)..."
    & "$env:SystemRoot\System32\taskkill.exe" /PID $targetPid /T /F *> $null
}

if ($targets.Count -eq 0) { exit 0 }

$deadline = [DateTime]::UtcNow.AddSeconds(12)
do {
    $remaining = @()
    foreach ($port in $ports) {
        foreach ($listenerPid in @(Get-ListeningProcessIds $port)) {
            $remaining += [pscustomobject]@{ Port = $port; ListenerPid = [int]$listenerPid }
        }
    }
    if ($remaining.Count -eq 0) {
        Write-Host "[restart] Previous dev session stopped. Starting a fresh session..."
        exit 0
    }
    Start-Sleep -Milliseconds 200
} while ([DateTime]::UtcNow -lt $deadline)

foreach ($item in $remaining) {
    Write-Host "[ERROR] Port $($item.Port) did not close (PID $($item.ListenerPid))."
}
exit 3

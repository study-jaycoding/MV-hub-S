param(
    [int]$Port = 8010,
    [int]$TimeoutSeconds = 180
)

$ErrorActionPreference = "Stop"
$Root = $PSScriptRoot
$serverTask = "MVHub Server"
$watchdogTask = "MVHub Watchdog"

function Get-TaskResultText([string]$TaskName) {
    try {
        $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction Stop
        $info = Get-ScheduledTaskInfo -TaskName $TaskName -ErrorAction Stop
        return "state=$($task.State), lastResult=$($info.LastTaskResult), lastRun=$($info.LastRunTime)"
    }
    catch { return "unavailable: $($_.Exception.Message)" }
}

function Show-LogTail([string]$Name) {
    $log = Join-Path $Root "logs\$Name"
    if (Test-Path -LiteralPath $log) {
        Write-Host "--- $Name (last 40 lines) ---" -ForegroundColor Yellow
        Get-Content -LiteralPath $log -Encoding UTF8 -Tail 40 -ErrorAction SilentlyContinue
    }
}

function Stop-ProcessTree([int]$TargetPid, [string]$Description) {
    Write-Host "Stopping $Description PID $TargetPid..."
    & taskkill.exe /PID $TargetPid /T /F | Out-Null
    if ($LASTEXITCODE -ne 0 -and (Get-Process -Id $TargetPid -ErrorAction SilentlyContinue)) {
        throw "Could not stop $Description PID $TargetPid."
    }
}

function Wait-TaskStopped([string]$TaskName, [int]$WaitSeconds = 15) {
    $deadline = (Get-Date).AddSeconds($WaitSeconds)
    do {
        $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction Stop
        if ($task.State -ne "Running") { return }
        Start-Sleep -Milliseconds 500
    } while ((Get-Date) -lt $deadline)
    throw "$TaskName did not stop: $(Get-TaskResultText $TaskName)"
}

function Start-TaskAndWaitRunning([string]$TaskName, [int]$WaitSeconds = 15) {
    Start-ScheduledTask -TaskName $TaskName -ErrorAction Stop
    $deadline = (Get-Date).AddSeconds($WaitSeconds)
    do {
        $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction Stop
        if ($task.State -eq "Running") { return }
        Start-Sleep -Milliseconds 500
    } while ((Get-Date) -lt $deadline)
    throw "$TaskName did not enter Running state: $(Get-TaskResultText $TaskName)"
}

try {
    foreach ($name in @($serverTask, $watchdogTask)) {
        Get-ScheduledTask -TaskName $name -ErrorAction Stop | Out-Null
    }

    Write-Host "Stopping existing scheduled server/watchdog..."
    Stop-ScheduledTask -TaskName $watchdogTask -ErrorAction SilentlyContinue
    Stop-ScheduledTask -TaskName $serverTask -ErrorAction SilentlyContinue
    Wait-TaskStopped -TaskName $watchdogTask
    Wait-TaskStopped -TaskName $serverTask

    # Stopping a scheduled cmd task can leave its Python supervisor or watchdog
    # detached. Remove only managed processes belonging to this repo so a new
    # scheduled task cannot exit early because an old process is still active.
    $rootPath = (Resolve-Path -LiteralPath $Root).Path.TrimEnd("\")
    $rootPrefix = $rootPath + "\"
    $managedProcesses = @(
        Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
            Where-Object {
                $command = [string]$_.CommandLine
                ($command.IndexOf("server_supervisor.py", [StringComparison]::OrdinalIgnoreCase) -ge 0 -or
                    $command.IndexOf("server_watchdog.py", [StringComparison]::OrdinalIgnoreCase) -ge 0) -and
                $command.IndexOf($rootPrefix, [StringComparison]::OrdinalIgnoreCase) -ge 0
            }
    )
    foreach ($managedProcess in $managedProcesses) {
        $command = [string]$managedProcess.CommandLine
        $description = if ($command.IndexOf("server_watchdog.py", [StringComparison]::OrdinalIgnoreCase) -ge 0) {
            "previous MV Hub watchdog"
        } else {
            "previous MV Hub supervisor"
        }
        Stop-ProcessTree -TargetPid ([int]$managedProcess.ProcessId) -Description $description
    }
    Start-Sleep -Seconds 1

    $owners = @(
        Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue |
            Select-Object -ExpandProperty OwningProcess -Unique
    )
    foreach ($ownerPid in $owners) {
        $process = Get-CimInstance Win32_Process -Filter "ProcessId=$ownerPid" -ErrorAction SilentlyContinue
        $command = [string]$process.CommandLine
        if ($command -notlike "*serve.py*") {
            throw "Port $Port is owned by another program (PID $ownerPid). It was not stopped."
        }
        Stop-ProcessTree -TargetPid $ownerPid -Description "previous MV Hub server process"
    }

    $portDeadline = (Get-Date).AddSeconds(15)
    do {
        $remainingOwners = @(
            Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue |
                Select-Object -ExpandProperty OwningProcess -Unique
        )
        if (-not $remainingOwners) { break }
        Start-Sleep -Milliseconds 500
    } while ((Get-Date) -lt $portDeadline)
    if ($remainingOwners) {
        throw "Port $Port did not become free after stopping the previous server (PID $($remainingOwners -join ', '))."
    }

    Write-Host "Starting scheduled server..."
    Start-TaskAndWaitRunning -TaskName $serverTask
    Write-Host "Starting scheduled watchdog..."
    Start-TaskAndWaitRunning -TaskName $watchdogTask

    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    $ready = $false
    while ((Get-Date) -lt $deadline) {
        try {
            $response = Invoke-WebRequest -UseBasicParsing -TimeoutSec 3 "http://127.0.0.1:$Port/api/ready"
            if ($response.StatusCode -eq 200) { $ready = $true; break }
        }
        catch { }
        Start-Sleep -Seconds 3
    }
    if (-not $ready) {
        throw "Server did not become ready within $TimeoutSeconds seconds. ${serverTask}: $(Get-TaskResultText $serverTask)"
    }

    Start-Sleep -Seconds 2
    $server = Get-ScheduledTask -TaskName $serverTask -ErrorAction Stop
    if ($server.State -ne "Running") {
        throw "$serverTask did not stay running: $(Get-TaskResultText $serverTask)"
    }
    $watchdog = Get-ScheduledTask -TaskName $watchdogTask -ErrorAction Stop
    if ($watchdog.State -ne "Running") {
        throw "$watchdogTask did not stay running: $(Get-TaskResultText $watchdogTask)"
    }

    # 복구가 확인됐는데 예전 경고 표식이 남아 사용자를 계속 불안하게 하지 않도록 정리한다.
    foreach ($alertName in @("server_ALERT.txt", "watchdog_ALERT.txt")) {
        $alertPath = Join-Path $Root "logs\$alertName"
        if (Test-Path -LiteralPath $alertPath) {
            Remove-Item -LiteralPath $alertPath -Force -ErrorAction SilentlyContinue
        }
    }

    Write-Host "Server is UP: http://127.0.0.1:$Port" -ForegroundColor Green
    Write-Host "${serverTask}: $(Get-TaskResultText $serverTask)"
    Write-Host "${watchdogTask}: $(Get-TaskResultText $watchdogTask)"
    exit 0
}
catch {
    Write-Host "[ERROR] $($_.Exception.Message)" -ForegroundColor Red
    Write-Host "${serverTask}: $(Get-TaskResultText $serverTask)"
    Write-Host "${watchdogTask}: $(Get-TaskResultText $watchdogTask)"
    Show-LogTail "server_console.log"
    Show-LogTail "watchdog_console.log"
    exit 1
}

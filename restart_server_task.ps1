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
        Get-Content -LiteralPath $log -Tail 40 -ErrorAction SilentlyContinue
    }
}

try {
    foreach ($name in @($serverTask, $watchdogTask)) {
        Get-ScheduledTask -TaskName $name -ErrorAction Stop | Out-Null
    }

    Write-Host "Stopping existing scheduled server/watchdog..."
    Stop-ScheduledTask -TaskName $watchdogTask -ErrorAction SilentlyContinue
    Stop-ScheduledTask -TaskName $serverTask -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 2

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
        Write-Host "Stopping previous MV Hub server process PID $ownerPid..."
        & taskkill.exe /PID $ownerPid /T /F | Out-Null
        if ($LASTEXITCODE -ne 0) { throw "Could not stop previous server PID $ownerPid." }
    }

    Write-Host "Starting scheduled server..."
    Start-ScheduledTask -TaskName $serverTask -ErrorAction Stop
    Write-Host "Starting scheduled watchdog..."
    Start-ScheduledTask -TaskName $watchdogTask -ErrorAction Stop

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
    $watchdog = Get-ScheduledTask -TaskName $watchdogTask -ErrorAction Stop
    if ($watchdog.State -ne "Running") {
        throw "$watchdogTask did not stay running: $(Get-TaskResultText $watchdogTask)"
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

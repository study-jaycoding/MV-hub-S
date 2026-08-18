param(
    [int]$LoadUsers = 100,
    [double]$LoadDurationSeconds = 60,
    [int]$LoadCycles = 2,
    [ValidateRange(1, 256)]
    [int]$LoadServerCpuCores = 2,
    [ValidateSet("normal", "below-normal")]
    [string]$LoadServerPriority = "below-normal",
    [ValidateRange(64.0, 32768.0)]
    [double]$LoadMaxRssMb = 512.0,
    [switch]$SkipLoad,
    [switch]$SkipBackupDrill,
    [switch]$AllowDirty,
    [string]$PythonExe = "",
    [string]$ReportDirectory = ""
)

$ErrorActionPreference = "Stop"

function Invoke-Checked {
    param(
        [string]$Label,
        [scriptblock]$Command
    )

    Write-Host ""
    Write-Host "== $Label =="
    & $Command
    if ($LASTEXITCODE -ne 0) {
        throw "$Label failed (exit code $LASTEXITCODE)"
    }
}

function Resolve-TestPython {
    param(
        [string]$ProjectRoot,
        [string]$PreferredExe
    )

    $Candidates = @()
    if ($PreferredExe) {
        $Candidates += $PreferredExe
    }
    $Candidates += (Join-Path $ProjectRoot "backend\.venv\Scripts\python.exe")
    $Candidates += (Join-Path $ProjectRoot ".venv\Scripts\python.exe")
    $Candidates += (Join-Path $ProjectRoot "runtime\python\python.exe")

    $Launcher = Get-Command py -ErrorAction SilentlyContinue
    if ($Launcher) {
        $Resolved = @(& $Launcher.Source -3 -c "import sys; print(sys.executable)" 2>$null)
        if ($LASTEXITCODE -eq 0 -and $Resolved) {
            $Candidates += ([string]$Resolved[-1]).Trim()
        }
    }

    $PythonCommand = Get-Command python -ErrorAction SilentlyContinue
    if ($PythonCommand -and $PythonCommand.Source -notmatch "WindowsApps") {
        $Candidates += $PythonCommand.Source
    }

    foreach ($Candidate in ($Candidates | Where-Object { $_ } | Select-Object -Unique)) {
        try {
            if (-not (Test-Path -LiteralPath $Candidate -PathType Leaf)) {
                continue
            }
            & $Candidate -c "import psutil, pytest, sys; print(sys.executable)" *> $null
            if ($LASTEXITCODE -eq 0) {
                return (Resolve-Path -LiteralPath $Candidate).Path
            }
        }
        catch {
            continue
        }
    }

    throw "No Python environment with pytest and psutil was found. Install backend\requirements-dev.txt or pass -PythonExe C:\Path\To\python.exe."
}

$ProjectRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path
$PythonExe = Resolve-TestPython -ProjectRoot $ProjectRoot -PreferredExe $PythonExe
if (-not $ReportDirectory) {
    $ReportDirectory = Join-Path $ProjectRoot "predeploy-reports"
}
$ReportDirectory = [System.IO.Path]::GetFullPath($ReportDirectory)
New-Item -ItemType Directory -Force -Path $ReportDirectory | Out-Null

Push-Location $ProjectRoot
try {
    $Commit = (& git rev-parse HEAD).Trim()
    if ($LASTEXITCODE -ne 0) {
        throw "Git commit could not be resolved."
    }
    $Branch = (& git branch --show-current).Trim()
    $Dirty = @(& git status --porcelain)
    if ($LASTEXITCODE -ne 0) {
        throw "Git status could not be read."
    }
    if ($Dirty.Count -gt 0 -and -not $AllowDirty) {
        throw "Working tree is not clean. Commit the intended release changes, or use -AllowDirty only for local rehearsal."
    }

    Write-Host "MV Hub predeploy gate"
    Write-Host "  branch : $Branch"
    Write-Host "  commit : $Commit"
    Write-Host "  reports: $ReportDirectory"
    Write-Host "  python : $PythonExe"

    Invoke-Checked "Backend tests" {
        Push-Location (Join-Path $ProjectRoot "backend")
        try {
            & $PythonExe -m pytest tests -q
        }
        finally {
            Pop-Location
        }
    }

    Invoke-Checked "Frontend tests" {
        Push-Location (Join-Path $ProjectRoot "frontend")
        try {
            & npm.cmd test
        }
        finally {
            Pop-Location
        }
    }

    Invoke-Checked "Production frontend build" {
        Push-Location (Join-Path $ProjectRoot "frontend")
        try {
            & npm.cmd run build
        }
        finally {
            Pop-Location
        }
    }

    if (-not $SkipBackupDrill) {
        Invoke-Checked "SQLite online backup and restore drill" {
            & $PythonExe (Join-Path $ProjectRoot "tools\verify_backup_restore.py")
        }
    }
    else {
        Write-Host ""
        Write-Host "== SQLite backup drill skipped =="
    }

    $LoadReport = $null
    $LoadResult = $null
    if (-not $SkipLoad) {
        $Stamp = Get-Date -Format "yyyyMMdd-HHmmss"
        $LoadReport = Join-Path $ReportDirectory "load-$LoadUsers-users-$Stamp.json"
        Invoke-Checked "$LoadUsers-user isolated load test" {
            & $PythonExe (Join-Path $ProjectRoot "tools\load_test_100.py") `
                --users $LoadUsers `
                --duration $LoadDurationSeconds `
                --cycles $LoadCycles `
                --generations-per-user 20 `
                --server-cpu-cores $LoadServerCpuCores `
                --server-priority $LoadServerPriority `
                --max-rss-mb $LoadMaxRssMb `
                --output $LoadReport `
                --quiet
        }
        $LoadResult = Get-Content -LiteralPath $LoadReport -Raw | ConvertFrom-Json
        if (-not $LoadResult.acceptance.passed) {
            throw "Load report did not preserve a passing acceptance result."
        }
        if ([int]$LoadResult.server_limits.requested_cpu_cores -ne $LoadServerCpuCores) {
            throw "Load report CPU limit does not match the requested predeploy profile."
        }
        if ([string]$LoadResult.server_limits.priority -ne $LoadServerPriority) {
            throw "Load report process priority does not match the requested predeploy profile."
        }
        if ([double]$LoadResult.config.max_rss_mb -ne $LoadMaxRssMb) {
            throw "Load report RSS limit does not match the requested predeploy profile."
        }
        if (-not $LoadResult.acceptance.checks.rss_within_target) {
            throw "Load report did not enforce the predeploy RSS limit."
        }
    }
    else {
        Write-Host ""
        Write-Host "== Load test skipped =="
    }

    $Summary = [ordered]@{
        passed = $true
        checked_at = (Get-Date).ToString("s")
        branch = $Branch
        commit = $Commit
        python = $PythonExe
        dirty_tree_allowed = [bool]$AllowDirty
        backend_tests = "passed"
        frontend_tests = "passed"
        frontend_build = "passed"
        backup_restore_drill = $(if ($SkipBackupDrill) { "skipped" } else { "passed" })
        load_test = $(if ($SkipLoad) { "skipped" } else { "passed" })
        load_server_cpu_cores = $(if ($SkipLoad) { $null } else { $LoadServerCpuCores })
        load_server_priority = $(if ($SkipLoad) { $null } else { $LoadServerPriority })
        load_server_cpu_affinity = $(if ($SkipLoad) { $null } else { @($LoadResult.server_limits.cpu_affinity) })
        load_max_rss_mb = $(if ($SkipLoad) { $null } else { $LoadMaxRssMb })
        load_max_rss_bytes_observed = $(if ($SkipLoad) { $null } else { $LoadResult.server.resource_summary.max_rss_bytes })
        load_report = $LoadReport
    }
    $SummaryPath = Join-Path $ReportDirectory "predeploy-latest.json"
    $Summary | ConvertTo-Json | Set-Content -LiteralPath $SummaryPath -Encoding UTF8

    Write-Host ""
    Write-Host "PREDEPLOY GATE PASSED"
    Write-Host "  summary: $SummaryPath"
    if ($LoadReport) {
        Write-Host "  load   : $LoadReport"
    }
}
finally {
    Pop-Location
}

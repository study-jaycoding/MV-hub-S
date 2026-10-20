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
    [string]$ReportDirectory = "",
    # Source DB for the SQLite backup/restore drill (default: the current DB). The fixed release folder has
    # no backend/data, so pass a copy of a real content_hub.db here (2026-09-30).
    [string]$BackupSource = ""
)

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot 'validation_result.ps1')

function Invoke-Checked {
    param(
        [string]$Label,
        [scriptblock]$Command
    )

    Write-Host ""
    Write-Host "== $Label =="
    $Step = [ordered]@{ name = $Label; status = 'running'; exit_code = $null }
    $Run.Data.current_step = $Label
    $Run.Data.steps += $Step
    Save-ValidationRun $Run
    $global:LASTEXITCODE = 0
    try {
        & $Command
        $Step.exit_code = $LASTEXITCODE
        if ($LASTEXITCODE -ne 0) {
            throw "$Label failed (exit code $LASTEXITCODE)"
        }
    }
    catch {
        $Step.status = 'failed'
        $Step.exit_code = $LASTEXITCODE
        # Evidence failure must not replace the command's original exception.
        try { Save-ValidationRun $Run }
        catch { Write-Warning 'Could not persist the failed validation step.' }
        throw
    }
    $Step.status = 'passed'
    Save-ValidationRun $Run
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
if (-not $ReportDirectory) {
    $ReportDirectory = Join-Path $ProjectRoot "predeploy-reports"
}
$ReportDirectory = [System.IO.Path]::GetFullPath($ReportDirectory)
$Run = Start-ValidationRun -ReportDirectory $ReportDirectory -Options ([ordered]@{
    allow_dirty = [bool]$AllowDirty; skip_load = [bool]$SkipLoad; skip_backup_drill = [bool]$SkipBackupDrill
})
$FinalizationAttempted = $false
$LocationPushed = $false
try {
    $Run.Data.current_step = 'resolve-python'
    Save-ValidationRun $Run
    $PythonExe = Resolve-TestPython -ProjectRoot $ProjectRoot -PreferredExe $PythonExe
    Push-Location $ProjectRoot
    $LocationPushed = $true
    $Run.Data.current_step = 'source-manifest'
    Save-ValidationRun $Run
    $Run.Data.source = Get-ValidationSourceManifest -ProjectRoot $ProjectRoot
    Save-ValidationRun $Run
    $Commit = $Run.Data.source.commit
    $Branch = $Run.Data.source.branch
    if ($Run.Data.source.dirty -and -not $AllowDirty) {
        throw "Working tree is not clean. Commit the intended release changes, or use -AllowDirty only for local rehearsal."
    }

    Write-Host "MV Hub predeploy gate"
    Write-Host "  branch : $Branch"
    Write-Host "  commit : $Commit"
    Write-Host "  reports: $ReportDirectory"
    Write-Host "  python : $PythonExe"

    Invoke-Checked "Documentation lint" {
        Push-Location (Join-Path $ProjectRoot "frontend")
        try {
            & npm.cmd run lint:docs
        }
        finally {
            Pop-Location
        }
    }

    Invoke-Checked "Architecture lint" {
        Push-Location (Join-Path $ProjectRoot "frontend")
        try {
            & npm.cmd run lint:architecture
        }
        finally {
            Pop-Location
        }
    }

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
            $DrillArgs = @()
            if ($BackupSource) { $DrillArgs += @("--source", $BackupSource) }
            & $PythonExe (Join-Path $ProjectRoot "tools\verify_backup_restore.py") @DrillArgs
        }
    }
    else {
        Write-Host ""
        Write-Host "== SQLite backup drill skipped =="
        $Run.Data.steps += [ordered]@{ name = 'SQLite online backup and restore drill'; status = 'skipped'; exit_code = $null }
        Save-ValidationRun $Run
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
        $Run.Data.steps += [ordered]@{ name = 'Isolated load test'; status = 'skipped'; exit_code = $null }
        Save-ValidationRun $Run
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
    $Run.Data.current_step = 'verify-source-unchanged'
    $Run.Data.source_after = Get-ValidationSourceManifest -ProjectRoot $ProjectRoot
    $Run.Data.source_unchanged = ($Run.Data.source.sha256 -eq $Run.Data.source_after.sha256 -and
        $Run.Data.source.commit -eq $Run.Data.source_after.commit)
    Save-ValidationRun $Run
    if (-not $Run.Data.source_unchanged) { throw 'Source changed during validation; results do not describe a fixed target.' }
    $Run.Data['summary'] = $Summary
    $Run.Data.current_step = 'complete'
    $FinalizationAttempted = $true
    Complete-ValidationRun -Run $Run -Status passed

    Write-Host ""
    Write-Host "PREDEPLOY GATE PASSED"
    Write-Host "  run    : $($Run.Path)"
    Write-Host "  latest : $($Run.LatestPath)"
    Write-Host "  scope  : source-only; release_eligible=false (artifact validation not implemented)"
    if ($LoadReport) {
        Write-Host "  load   : $LoadReport"
    }
}
catch {
    # Preserve the original exception/exit details even if the evidence disk fails.
    if (-not $FinalizationAttempted) {
        $FinalizationAttempted = $true
        $Failure = @{ type = $_.Exception.GetType().FullName; step = $Run.Data.current_step; exit_code = $LASTEXITCODE }
        $FailureStatus = if ($_.Exception -is [System.Management.Automation.PipelineStoppedException]) { 'interrupted' } else { 'failed' }
        try { Complete-ValidationRun -Run $Run -Status $FailureStatus -Failure $Failure }
        catch { Write-Warning 'Validation failed and its final result could not be persisted; the run is incomplete.' }
    }
    throw
}
finally {
    try {
        # Pipeline cancellation can bypass catch. Hard process termination may
        # bypass finally too: the persisted running record then stays incomplete.
        if (-not $FinalizationAttempted) { Complete-ValidationRun -Run $Run -Status interrupted }
    }
    finally {
        if ($LocationPushed) { Pop-Location }
    }
}

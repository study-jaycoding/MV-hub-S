param(
    [int]$LoadUsers = 100,
    [double]$LoadDurationSeconds = 60,
    [int]$LoadCycles = 2,
    [switch]$SkipLoad,
    [switch]$SkipBackupDrill,
    [switch]$AllowDirty,
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

$ProjectRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path
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

    Invoke-Checked "Backend tests" {
        Push-Location (Join-Path $ProjectRoot "backend")
        try {
            & python -m pytest tests -q
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
            & python (Join-Path $ProjectRoot "tools\verify_backup_restore.py")
        }
    }
    else {
        Write-Host ""
        Write-Host "== SQLite backup drill skipped =="
    }

    $LoadReport = $null
    if (-not $SkipLoad) {
        $Stamp = Get-Date -Format "yyyyMMdd-HHmmss"
        $LoadReport = Join-Path $ReportDirectory "load-$LoadUsers-users-$Stamp.json"
        Invoke-Checked "$LoadUsers-user isolated load test" {
            & python (Join-Path $ProjectRoot "tools\load_test_100.py") `
                --users $LoadUsers `
                --duration $LoadDurationSeconds `
                --cycles $LoadCycles `
                --generations-per-user 20 `
                --output $LoadReport `
                --quiet
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
        dirty_tree_allowed = [bool]$AllowDirty
        backend_tests = "passed"
        frontend_tests = "passed"
        frontend_build = "passed"
        backup_restore_drill = $(if ($SkipBackupDrill) { "skipped" } else { "passed" })
        load_test = $(if ($SkipLoad) { "skipped" } else { "passed" })
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

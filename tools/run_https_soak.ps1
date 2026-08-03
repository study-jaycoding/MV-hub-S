param(
    [int]$Users = 100,
    [double]$QualificationDurationSeconds = 900,
    [int]$QualificationCycles = 2,
    [double]$SoakDurationSeconds = 14400,
    [int]$SoakCycles = 2,
    [string]$CertFile = "",
    [string]$KeyFile = "",
    [string]$ReportDirectory = ""
)

$ErrorActionPreference = "Stop"

$ProjectRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path
if (-not $ReportDirectory) {
    $ReportDirectory = Join-Path $ProjectRoot "predeploy-reports"
}
$ReportDirectory = [System.IO.Path]::GetFullPath($ReportDirectory)
if (-not $CertFile) {
    $CertFile = Join-Path $ReportDirectory "tls-local\localhost-cert.pem"
}
if (-not $KeyFile) {
    $KeyFile = Join-Path $ReportDirectory "tls-local\localhost-key.pem"
}

$PythonExe = Join-Path $ProjectRoot ".venv\Scripts\python.exe"
$LoadTool = Join-Path $ProjectRoot "tools\load_test_100.py"
$StatePath = Join-Path $ReportDirectory "https-soak-state.json"
$QualificationReport = Join-Path $ReportDirectory "https-100-users-30m.json"
$SoakReport = Join-Path $ReportDirectory "https-100-users-8h.json"
$StartedAt = (Get-Date).ToString("s")
$CurrentStage = "initializing"
$CurrentReport = ""
$BaselineCommit = ""

function Write-State {
    param(
        [string]$Status,
        [string]$Message,
        [Nullable[int]]$ExitCode = $null
    )

    $State = [ordered]@{
        status = $Status
        stage = $script:CurrentStage
        message = $Message
        pid = $PID
        users = $Users
        commit = $script:BaselineCommit
        started_at = $script:StartedAt
        updated_at = (Get-Date).ToString("s")
        report = $script:CurrentReport
        exit_code = $ExitCode
    }
    $TempState = "$StatePath.tmp"
    $State | ConvertTo-Json | Set-Content -LiteralPath $TempState -Encoding UTF8
    Move-Item -LiteralPath $TempState -Destination $StatePath -Force
}

function Assert-BaselineCommit {
    $CurrentCommit = (& git -C $ProjectRoot rev-parse HEAD).Trim()
    if ($LASTEXITCODE -ne 0 -or $CurrentCommit -ne $script:BaselineCommit) {
        throw "시험 도중 Git 커밋이 변경되었습니다. 시작=$($script:BaselineCommit), 현재=$CurrentCommit"
    }
    $Dirty = @(& git -C $ProjectRoot status --porcelain)
    if ($LASTEXITCODE -ne 0 -or $Dirty.Count -gt 0) {
        throw "시험 도중 작업 폴더가 변경되었습니다. 동일 코드 보장을 위해 중단합니다."
    }
}

function Invoke-LoadStage {
    param(
        [string]$Stage,
        [double]$DurationSeconds,
        [int]$Cycles,
        [string]$OutputPath
    )

    Assert-BaselineCommit
    $script:CurrentStage = $Stage
    $script:CurrentReport = $OutputPath
    Write-State -Status "running" -Message "$Stage 시험 실행 중"
    Write-Host "[$Stage] users=$Users duration=$DurationSeconds cycles=$Cycles"

    & $PythonExe $LoadTool `
        --users $Users `
        --duration $DurationSeconds `
        --cycles $Cycles `
        --generations-per-user 20 `
        --tls-certfile $CertFile `
        --tls-keyfile $KeyFile `
        --tls-ca-file $CertFile `
        --output $OutputPath `
        --quiet
    $StageExitCode = $LASTEXITCODE
    if ($StageExitCode -ne 0) {
        Write-State -Status "failed" -Message "$Stage 시험 실패" -ExitCode $StageExitCode
        throw "$Stage 시험 실패(exit code $StageExitCode)"
    }
    Write-State -Status "passed" -Message "$Stage 시험 합격" -ExitCode 0
}

New-Item -ItemType Directory -Force -Path $ReportDirectory | Out-Null
foreach ($RequiredFile in @($PythonExe, $LoadTool, $CertFile, $KeyFile)) {
    if (-not (Test-Path -LiteralPath $RequiredFile -PathType Leaf)) {
        throw "필수 파일을 찾을 수 없습니다: $RequiredFile"
    }
}

$BaselineCommit = (& git -C $ProjectRoot rev-parse HEAD).Trim()
if ($LASTEXITCODE -ne 0) {
    throw "Git 기준 커밋을 확인할 수 없습니다."
}

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class MvHubSoakPower {
    [DllImport("kernel32.dll")]
    public static extern uint SetThreadExecutionState(uint flags);
}
"@

try {
    # ES_CONTINUOUS | ES_SYSTEM_REQUIRED: 화면은 끌 수 있지만 시스템 절전은 시험 동안 방지한다.
    [void][MvHubSoakPower]::SetThreadExecutionState(0x80000001)
    Write-State -Status "running" -Message "HTTPS 장시간 시험 준비 중"
    Invoke-LoadStage `
        -Stage "qualification_30m" `
        -DurationSeconds $QualificationDurationSeconds `
        -Cycles $QualificationCycles `
        -OutputPath $QualificationReport
    Invoke-LoadStage `
        -Stage "soak_8h" `
        -DurationSeconds $SoakDurationSeconds `
        -Cycles $SoakCycles `
        -OutputPath $SoakReport
    $CurrentStage = "complete"
    $CurrentReport = $SoakReport
    Write-State -Status "complete" -Message "HTTPS 30분 및 8시간 시험 합격" -ExitCode 0
}
catch {
    if ((Test-Path -LiteralPath $StatePath) -and $CurrentStage -ne "complete") {
        Write-State -Status "failed" -Message $_.Exception.Message -ExitCode 1
    }
    Write-Error $_
    exit 1
}
finally {
    [void][MvHubSoakPower]::SetThreadExecutionState(0x80000000)
}

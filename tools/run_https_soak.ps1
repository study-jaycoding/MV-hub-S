param(
    [int]$Users = 100,
    [double]$QualificationDurationSeconds = 900,
    [int]$QualificationCycles = 2,
    [double]$SoakDurationSeconds = 14400,
    [int]$SoakCycles = 2,
    [int]$ServerCpuCores = 4,
    [ValidateSet("normal", "below-normal")]
    [string]$ServerPriority = "below-normal",
    [double]$SampleIntervalSeconds = 30,
    [double]$MaxRssMb = 512,
    [double]$MaxP95Ms = 500,
    [double]$MaxLoginP95Ms = 10000,
    [double]$MaxMemoryGrowthPercent = 20,
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
$UsesManagedLocalTls = -not $CertFile -and -not $KeyFile
if ([bool]$CertFile -ne [bool]$KeyFile) {
    throw "CertFile and KeyFile must be supplied together."
}
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

if ($Users -lt 1 -or $Users -gt 500) {
    throw "Users must be between 1 and 500."
}
if ($QualificationDurationSeconds -le 0 -or $SoakDurationSeconds -le 0) {
    throw "QualificationDurationSeconds and SoakDurationSeconds must be greater than 0."
}
if ($QualificationCycles -lt 1 -or $SoakCycles -lt 1) {
    throw "QualificationCycles and SoakCycles must be at least 1."
}
if ($ServerCpuCores -lt 1) {
    throw "ServerCpuCores must be at least 1 for the low-spec soak profile."
}
if ($SampleIntervalSeconds -le 0 -or $MaxRssMb -le 0) {
    throw "SampleIntervalSeconds and MaxRssMb must be greater than 0."
}
if (
    $MaxP95Ms -le 0 -or
    $MaxLoginP95Ms -le 0 -or
    $MaxMemoryGrowthPercent -lt 0
) {
    throw "Latency limits must be greater than 0 and memory growth must not be negative."
}

function Test-TlsCertificatePair {
    param(
        [string]$CertificatePath,
        [string]$PrivateKeyPath,
        [datetime]$ValidUntil = (Get-Date).ToUniversalTime().AddHours(24)
    )

    if (
        -not (Test-Path -LiteralPath $CertificatePath -PathType Leaf) -or
        -not (Test-Path -LiteralPath $PrivateKeyPath -PathType Leaf)
    ) {
        return $false
    }

    $Certificate = $null
    try {
        $Certificate = [System.Security.Cryptography.X509Certificates.X509Certificate2]::CreateFromPemFile(
            $CertificatePath,
            $PrivateKeyPath
        )
        $Now = (Get-Date).ToUniversalTime()
        return (
            $Certificate.HasPrivateKey -and
            $Certificate.NotBefore.ToUniversalTime() -le $Now -and
            $Certificate.NotAfter.ToUniversalTime() -gt $ValidUntil
        )
    }
    catch {
        return $false
    }
    finally {
        if ($Certificate) {
            $Certificate.Dispose()
        }
    }
}

function New-LocalTlsCertificatePair {
    param(
        [string]$CertificatePath,
        [string]$PrivateKeyPath
    )

    $CertificateDirectory = Split-Path -Parent $CertificatePath
    $PrivateKeyDirectory = Split-Path -Parent $PrivateKeyPath
    New-Item -ItemType Directory -Force -Path $CertificateDirectory | Out-Null
    New-Item -ItemType Directory -Force -Path $PrivateKeyDirectory | Out-Null

    $Rsa = [System.Security.Cryptography.RSA]::Create(2048)
    $Certificate = $null
    $CertificateTemp = "$CertificatePath.tmp"
    $PrivateKeyTemp = "$PrivateKeyPath.tmp"
    try {
        if (-not ($Rsa.PSObject.Methods.Name -contains "ExportPkcs8PrivateKeyPem")) {
            throw "Automatic local TLS certificate creation requires PowerShell 7 or newer."
        }

        $Request = [System.Security.Cryptography.X509Certificates.CertificateRequest]::new(
            "CN=MV Hub Local TLS Test",
            $Rsa,
            [System.Security.Cryptography.HashAlgorithmName]::SHA256,
            [System.Security.Cryptography.RSASignaturePadding]::Pkcs1
        )
        $San = [System.Security.Cryptography.X509Certificates.SubjectAlternativeNameBuilder]::new()
        $San.AddIpAddress([System.Net.IPAddress]::Parse("127.0.0.1"))
        $San.AddDnsName("localhost")
        $Request.CertificateExtensions.Add($San.Build())
        $Request.CertificateExtensions.Add(
            [System.Security.Cryptography.X509Certificates.X509BasicConstraintsExtension]::new(
                $false,
                $false,
                0,
                $true
            )
        )
        $KeyUsage = (
            [System.Security.Cryptography.X509Certificates.X509KeyUsageFlags]::DigitalSignature -bor
            [System.Security.Cryptography.X509Certificates.X509KeyUsageFlags]::KeyEncipherment
        )
        $Request.CertificateExtensions.Add(
            [System.Security.Cryptography.X509Certificates.X509KeyUsageExtension]::new(
                $KeyUsage,
                $true
            )
        )
        $ServerAuthOids = [System.Security.Cryptography.OidCollection]::new()
        [void]$ServerAuthOids.Add([System.Security.Cryptography.Oid]::new("1.3.6.1.5.5.7.3.1"))
        $Request.CertificateExtensions.Add(
            [System.Security.Cryptography.X509Certificates.X509EnhancedKeyUsageExtension]::new(
                $ServerAuthOids,
                $true
            )
        )

        $Now = [DateTimeOffset]::UtcNow
        $Certificate = $Request.CreateSelfSigned($Now.AddMinutes(-5), $Now.AddDays(30))
        $Utf8NoBom = [System.Text.UTF8Encoding]::new($false)
        [System.IO.File]::WriteAllText(
            $CertificateTemp,
            $Certificate.ExportCertificatePem(),
            $Utf8NoBom
        )
        [System.IO.File]::WriteAllText(
            $PrivateKeyTemp,
            $Rsa.ExportPkcs8PrivateKeyPem(),
            $Utf8NoBom
        )
        Move-Item -LiteralPath $CertificateTemp -Destination $CertificatePath -Force
        Move-Item -LiteralPath $PrivateKeyTemp -Destination $PrivateKeyPath -Force
    }
    finally {
        foreach ($TemporaryPath in @($CertificateTemp, $PrivateKeyTemp)) {
            if (Test-Path -LiteralPath $TemporaryPath -PathType Leaf) {
                Remove-Item -LiteralPath $TemporaryPath -Force
            }
        }
        if ($Certificate) {
            $Certificate.Dispose()
        }
        $Rsa.Dispose()
    }
}

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
        server_cpu_cores = $ServerCpuCores
        server_priority = $ServerPriority
        sample_interval_seconds = $SampleIntervalSeconds
        max_rss_mb = $MaxRssMb
        max_p95_ms = $MaxP95Ms
        max_login_p95_ms = $MaxLoginP95Ms
        max_memory_growth_percent = $MaxMemoryGrowthPercent
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
        --server-cpu-cores $ServerCpuCores `
        --server-priority $ServerPriority `
        --sample-interval $SampleIntervalSeconds `
        --max-rss-mb $MaxRssMb `
        --max-p95-ms $MaxP95Ms `
        --max-login-p95-ms $MaxLoginP95Ms `
        --max-memory-growth-percent $MaxMemoryGrowthPercent `
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
if ($UsesManagedLocalTls -and -not (Test-TlsCertificatePair $CertFile $KeyFile)) {
    Write-Host "[tls] local test certificate is missing or stale - creating a new 30-day pair."
    New-LocalTlsCertificatePair $CertFile $KeyFile
}
if (-not (Test-TlsCertificatePair $CertFile $KeyFile)) {
    throw "TLS certificate/key is invalid, mismatched, expired, or expires within 24 hours."
}
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
    [void][MvHubSoakPower]::SetThreadExecutionState([uint32]2147483649)
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
    [void][MvHubSoakPower]::SetThreadExecutionState([uint32]2147483648)
}

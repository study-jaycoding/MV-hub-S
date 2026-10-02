param(
    [Parameter(Mandatory = $true)]
    [string]$PackagePath,
    [string]$LatestPath = "",
    # 릴리스 폴더 잠금(release.lock)을 기다리는 시간. 시험만 줄인다.
    [double]$LockWaitSeconds = 10
)

$ErrorActionPreference = "Stop"

function Get-Sha256Hex {
    param([string]$Path)

    $Stream = [System.IO.File]::OpenRead($Path)
    $Hasher = [System.Security.Cryptography.SHA256]::Create()
    try {
        return ([BitConverter]::ToString($Hasher.ComputeHash($Stream))).Replace("-", "").ToLowerInvariant()
    }
    finally {
        $Hasher.Dispose()
        $Stream.Dispose()
    }
}

function Read-ManifestSha {
    # 표지·후보의 sha256(없거나 깨졌으면 빈 문자열) — 안내 문구용
    param([string]$Path)
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return "" }
    try { return [string]((Get-Content -LiteralPath $Path -Raw -Encoding UTF8 | ConvertFrom-Json).sha256) }
    catch { return "" }
}

. (Join-Path $PSScriptRoot "release_manifest_io.ps1")

$Package = Get-Item -LiteralPath $PackagePath -ErrorAction Stop
if ($Package.Extension -ne ".zip") {
    throw "PackagePath must point to an MV Hub zip package."
}
if (-not $LatestPath) {
    $LatestPath = Join-Path $Package.DirectoryName "latest.json"
}
$LatestPath = [System.IO.Path]::GetFullPath($LatestPath)

Add-Type -AssemblyName System.IO.Compression.FileSystem
$Archive = [System.IO.Compression.ZipFile]::OpenRead($Package.FullName)
try {
    $VersionEntry = $Archive.GetEntry("VERSION.txt")
    if (-not $VersionEntry) {
        throw "VERSION.txt is missing from package: $($Package.FullName)"
    }
    $Reader = New-Object System.IO.StreamReader($VersionEntry.Open())
    try {
        $Version = $Reader.ReadToEnd().Trim()
    }
    finally {
        $Reader.Dispose()
    }

    $CliPinEntry = $Archive.Entries | Where-Object {
        $_.FullName.Replace("\", "/") -eq "hf_cli_version.txt"
    } | Select-Object -First 1
    $CliPackageEntry = $Archive.Entries | Where-Object {
        $_.FullName.Replace("\", "/") -eq "runtime/higgsfield/node_modules/@higgsfield/cli/package.json"
    } | Select-Object -First 1
    if (-not $CliPinEntry -or -not $CliPackageEntry) {
        throw "Bundled Higgsfield CLI metadata is missing from package: $($Package.FullName)"
    }
    $Reader = New-Object System.IO.StreamReader($CliPinEntry.Open())
    try {
        $CliVersion = $Reader.ReadToEnd().Trim()
    }
    finally {
        $Reader.Dispose()
    }
    $Reader = New-Object System.IO.StreamReader($CliPackageEntry.Open())
    try {
        $CliPackageVersion = [string](($Reader.ReadToEnd() | ConvertFrom-Json).version)
    }
    finally {
        $Reader.Dispose()
    }
    if (-not $CliVersion -or $CliPackageVersion -ne $CliVersion) {
        throw "Bundled Higgsfield CLI mismatch: pin=$CliVersion package=$CliPackageVersion"
    }
}
finally {
    $Archive.Dispose()
}
if (-not $Version) {
    throw "VERSION.txt is empty in package: $($Package.FullName)"
}

$Latest = [ordered]@{
    version = $Version
    higgsfield_cli_version = $CliVersion
    file = $Package.Name
    sha256 = Get-Sha256Hex -Path $Package.FullName
    size = $Package.Length
    created_at = (Get-Date).ToString("s")
}
# 이전 Set-Content -Encoding UTF8 과 같은 바이트(UTF-8 BOM) — 후보와 공개 표지가 같은 원문을 갖는다.
$ManifestBytes = (New-Object System.Text.UTF8Encoding($true)).GetPreamble() +
    (New-Object System.Text.UTF8Encoding($false)).GetBytes(($Latest | ConvertTo-Json) + "`r`n")

$LatestDirectory = Split-Path -Parent $LatestPath
New-Item -ItemType Directory -Force -Path $LatestDirectory | Out-Null
$CandidatePath = Join-Path $LatestDirectory "candidate.json"
$BackupPath = ""
$Lock = Open-ReleaseLock -Directory $LatestDirectory -WaitSeconds $LockWaitSeconds
try {
    # 아직 공지·배포되지 않은 후보가 있으면 이 선택이 그것을 취소한다(B안 — 되돌린 판이 다시 배포되지 않게).
    $PendingSha = Read-ManifestSha -Path $CandidatePath
    if ($PendingSha -and $PendingSha -ne (Read-ManifestSha -Path $LatestPath) -and $PendingSha -ne $Latest.sha256) {
        Write-Host "Note: the unannounced candidate ($PendingSha) is cancelled by this selection."
    }

    if (Test-Path -LiteralPath $LatestPath) {
        $BackupDirectory = Join-Path $LatestDirectory "latest-backups"
        $BackupFolder = [System.IO.Directory]::CreateDirectory($BackupDirectory)
        if ($BackupFolder.Attributes -band [System.IO.FileAttributes]::ReparsePoint) {
            throw "Backup directory must not be a link: $BackupDirectory"
        }
        # 초 단위 시각 + 고유 접미사(promote 와 같은 규칙) — 같은 초에 다시 실행해도 막히지 않는다(Codex 코드 리뷰)
        $BackupName = "latest.previous-{0}-{1}.json" -f (Get-Date -Format "yyyyMMdd-HHmmss"), [Guid]::NewGuid().ToString("N").Substring(0, 6)
        $BackupPath = Join-Path $BackupDirectory $BackupName
        $PreviousHash = Get-Sha256Hex -Path $LatestPath
        # Refuse overwrites even if another selector creates this name after the check.
        [System.IO.File]::Copy($LatestPath, $BackupPath, $false)
        if ((Get-Sha256Hex -Path $BackupPath) -ne $PreviousHash) {
            throw "Backup verification failed; latest.json was not replaced: $BackupPath"
        }
    }

    # 후보 먼저, 공개 표지 마지막(Codex r4) — 중간에 멈추면 '후보만 바뀜·공개는 그대로'라 다시 실행하면 된다.
    Write-ManifestAtomic -Path $CandidatePath -Bytes $ManifestBytes
    try {
        Write-ManifestAtomic -Path $LatestPath -Bytes $ManifestBytes
    }
    catch {
        # 무변경이 확인된 실패만 '안 바뀜·다시 실행'이라고 말한다. 결과를 확인 못 했으면 단정하지 않는다(Codex 코드 리뷰).
        if ($_.Exception.Message -like "Could not replace *") {
            throw "candidate.json now points to $Version but latest.json was NOT switched; run the same command again. $($_.Exception.Message)"
        }
        throw "candidate.json now points to $Version; the latest.json switch result could not be confirmed - check latest.json before running again. $($_.Exception.Message)"
    }
}
finally {
    $Lock.Dispose()
}

Write-Host "Selected release:"
Write-Host "  version: $Version"
Write-Host "  cli    : $CliVersion"
Write-Host "  package: $($Package.FullName)"
Write-Host "  latest : $LatestPath"
Write-Host "  candidate: $CandidatePath"
if ($BackupPath) {
    Write-Host "  backup : $BackupPath"
}
Write-Host "Workers can now run update_release.bat to install this exact version."

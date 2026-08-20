param(
    [Parameter(Mandatory = $true)]
    [string]$PackagePath,
    [string]$LatestPath = ""
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

$LatestDirectory = Split-Path -Parent $LatestPath
New-Item -ItemType Directory -Force -Path $LatestDirectory | Out-Null
if (Test-Path -LiteralPath $LatestPath) {
    $BackupName = "latest.previous-{0}.json" -f (Get-Date -Format "yyyyMMdd-HHmmss")
    Copy-Item -LiteralPath $LatestPath -Destination (Join-Path $LatestDirectory $BackupName)
}

$TemporaryLatest = "$LatestPath.tmp-$PID"
try {
    $Latest | ConvertTo-Json | Set-Content -LiteralPath $TemporaryLatest -Encoding UTF8
    Move-Item -LiteralPath $TemporaryLatest -Destination $LatestPath -Force
}
finally {
    Remove-Item -LiteralPath $TemporaryLatest -Force -ErrorAction SilentlyContinue
}

Write-Host "Selected release:"
Write-Host "  version: $Version"
Write-Host "  cli    : $CliVersion"
Write-Host "  package: $($Package.FullName)"
Write-Host "  latest : $LatestPath"
Write-Host "Workers can now run update_release.bat to install this exact version."

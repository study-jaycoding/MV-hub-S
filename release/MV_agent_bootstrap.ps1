param(
    [Parameter(Mandatory = $true)][string]$BaseUrl,
    [string]$InstallDir = (Join-Path ([Environment]::GetFolderPath('Desktop')) 'MV-hub-S'),
    [switch]$NoLaunch
)

# ============================================================================
#  MV Hub installer / updater (shared logic for the worker bootstrap .bat files)
#
#  - Reads <BaseUrl>/latest.json (UNC share or http server)
#  - If the installed VERSION.txt already matches, does nothing (idempotent)
#  - Otherwise downloads the zip, VERIFIES its SHA256 against latest.json,
#    extracts over InstallDir WITHOUT deleting anything (so backend\data, the
#    worker's local DB/media, is never touched), then optionally launches.
#
#  This file is also handy to run directly for admin/testing:
#    powershell -ExecutionPolicy Bypass -File MV_agent_bootstrap.ps1 `
#        -BaseUrl \\SERVER\MVHub\packages -NoLaunch
# ============================================================================

$ErrorActionPreference = 'Stop'

function Get-Remote {
    param([string]$RelPath, [string]$OutFile)
    if ($BaseUrl -match '^[A-Za-z][A-Za-z0-9+.-]*://') {
        $url = ($BaseUrl.TrimEnd('/')) + '/' + $RelPath
        Invoke-WebRequest -Uri $url -OutFile $OutFile -UseBasicParsing
    }
    else {
        $src = Join-Path $BaseUrl $RelPath
        if (-not (Test-Path -LiteralPath $src)) { throw "Not found on server: $src" }
        Copy-Item -LiteralPath $src -Destination $OutFile -Force
    }
}

$tmp = Join-Path $env:TEMP ('mvhub_' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force -Path $tmp | Out-Null
try {
    Write-Host "[1/4] Reading release manifest from $BaseUrl ..."
    $jsonPath = Join-Path $tmp 'latest.json'
    Get-Remote 'latest.json' $jsonPath
    $meta = Get-Content -LiteralPath $jsonPath -Raw | ConvertFrom-Json
    if (-not $meta.version -or -not $meta.file -or -not $meta.sha256) {
        throw 'latest.json is missing version/file/sha256.'
    }

    $versionFile = Join-Path $InstallDir 'VERSION.txt'
    $installed = ''
    if (Test-Path -LiteralPath $versionFile) {
        $installed = (Get-Content -LiteralPath $versionFile -Raw).Trim()
    }

    if ($installed -eq $meta.version) {
        Write-Host "[2/4] Already up to date: $installed"
    }
    else {
        Write-Host "[2/4] Updating: '$installed' -> '$($meta.version)'"
        $zipPath = Join-Path $tmp $meta.file
        Get-Remote $meta.file $zipPath

        Write-Host '[3/4] Verifying download (SHA256) ...'
        $hash = (Get-FileHash -LiteralPath $zipPath -Algorithm SHA256).Hash.ToLowerInvariant()
        $want = ([string]$meta.sha256).Trim().ToLowerInvariant()
        if ($hash -ne $want) {
            throw "SHA256 mismatch (corrupt/incomplete download). expected=$want got=$hash"
        }

        $stage = Join-Path $tmp 'unzip'
        New-Item -ItemType Directory -Force -Path $stage | Out-Null
        Expand-Archive -LiteralPath $zipPath -DestinationPath $stage -Force
        New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null

        # /E copies all app files; NO /MIR or /PURGE, so the worker's backend\data
        # (local DB + media, never in the zip) is preserved across updates.
        & robocopy $stage $InstallDir /E /NFL /NDL /NJH /NJS /NP | Out-Null
        if ($LASTEXITCODE -ge 8) { throw "robocopy failed (code $LASTEXITCODE)" }
        Write-Host "      Installed to $InstallDir"
    }

    if ($NoLaunch) {
        Write-Host '[4/4] Done (install/update only; not launching).'
    }
    else {
        $agent = Join-Path $InstallDir 'MV_agent.bat'
        if (Test-Path -LiteralPath $agent) {
            Write-Host '[4/4] Launching MV_agent ...'
            Start-Process -FilePath $agent -WorkingDirectory $InstallDir
        }
        else {
            throw "MV_agent.bat not found in $InstallDir"
        }
    }
}
finally {
    Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue
}

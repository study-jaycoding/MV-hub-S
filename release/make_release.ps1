param(
    [string]$Version = (Get-Date -Format "yyyy.MM.dd-HHmm"),
    [string]$OutputDir = (Join-Path $PSScriptRoot "packages"),
    [string]$PythonExe = "",
    [string]$NodeRoot = "",
    [string]$HiggsfieldRoot = "",
    [switch]$SkipPythonRuntime,
    [switch]$SkipNodeRuntime,
    [switch]$SkipHiggsfieldCli
)

$ErrorActionPreference = "Stop"

function Copy-RoboChecked {
    param(
        [string]$Source,
        [string]$Destination,
        [string[]]$ExtraArgs = @()
    )
    New-Item -ItemType Directory -Force -Path $Destination | Out-Null
    & robocopy $Source $Destination /E @ExtraArgs /NFL /NDL /NJH /NJS /NP | Out-Null
    if ($LASTEXITCODE -gt 7) {
        throw "robocopy failed: $Source -> $Destination (code $LASTEXITCODE)"
    }
}

function Resolve-PythonRuntime {
    param([string]$PreferredExe)

    $Candidates = @()
    if ($PreferredExe) {
        $Candidates += $PreferredExe
    }

    $LocalPython = Join-Path $env:LOCALAPPDATA "Python\bin\python.exe"
    if (Test-Path -LiteralPath $LocalPython) {
        $Candidates += $LocalPython
    }

    $PythonCommand = Get-Command python -ErrorAction SilentlyContinue
    if ($PythonCommand -and $PythonCommand.Source -notmatch "WindowsApps") {
        $Candidates += $PythonCommand.Source
    }

    foreach ($Candidate in ($Candidates | Select-Object -Unique)) {
        try {
            $Lines = @(& $Candidate -c "import sys; print(sys.executable); print(sys.base_prefix)" 2>$null)
            if ($LASTEXITCODE -ne 0 -or -not $Lines -or $Lines.Count -lt 2) {
                continue
            }
            $BaseRoot = [string]$Lines[1]
            $BasePython = Join-Path $BaseRoot "python.exe"
            if (Test-Path -LiteralPath $BasePython) {
                return [pscustomobject]@{
                    Exe = $BasePython
                    Root = $BaseRoot
                }
            }
        }
        catch {
            continue
        }
    }

    throw "No real Python runtime found. Pass -PythonExe C:\Path\To\python.exe or install Python first."
}

function Resolve-NodeRuntime {
    param([string]$PreferredRoot)

    if ($PreferredRoot) {
        $NodeExe = Join-Path $PreferredRoot "node.exe"
        $NpmCmd = Join-Path $PreferredRoot "npm.cmd"
        if ((Test-Path -LiteralPath $NodeExe) -and (Test-Path -LiteralPath $NpmCmd)) {
            return (Resolve-Path -LiteralPath $PreferredRoot).Path
        }
        throw "NodeRoot must contain node.exe and npm.cmd: $PreferredRoot"
    }

    $Node = Get-Command node.exe -ErrorAction SilentlyContinue
    if ($Node) {
        $Root = Split-Path -Parent $Node.Source
        if (Test-Path -LiteralPath (Join-Path $Root "npm.cmd")) {
            return $Root
        }
    }

    throw "No Node.js runtime found. Pass -NodeRoot C:\Path\To\nodejs or install Node.js first."
}

function Resolve-HiggsfieldCli {
    param([string]$PreferredRoot)

    $Roots = @()
    if ($PreferredRoot) {
        $Roots += $PreferredRoot
    }

    $Higgsfield = Get-Command higgsfield.cmd -ErrorAction SilentlyContinue
    if ($Higgsfield) {
        $Roots += (Split-Path -Parent $Higgsfield.Source)
    }

    foreach ($RootCandidate in ($Roots | Select-Object -Unique)) {
        $Root = (Resolve-Path -LiteralPath $RootCandidate -ErrorAction SilentlyContinue)
        if (-not $Root) {
            continue
        }
        $RootPath = $Root.Path
        $Shim = Join-Path $RootPath "higgsfield.cmd"
        $Package = Join-Path $RootPath "node_modules\@higgsfield\cli"
        if ((Test-Path -LiteralPath $Shim) -and (Test-Path -LiteralPath $Package)) {
            return [pscustomobject]@{
                Root = $RootPath
                Package = $Package
            }
        }
    }

    throw "No Higgsfield CLI found. Run npm install -g @higgsfield/cli, pass -HiggsfieldRoot, or use -SkipHiggsfieldCli."
}

$ProjectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$PackageName = "MVHub-$Version"
$StagingRoot = Join-Path $PSScriptRoot "_staging"
$Stage = Join-Path $StagingRoot $PackageName

Write-Host "[1/8] Preparing staging folder..."
Remove-Item -LiteralPath $StagingRoot -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $Stage | Out-Null
New-Item -ItemType Directory -Force -Path $OutputDir | Out-Null

Write-Host "[2/8] Building frontend dist..."
Push-Location (Join-Path $ProjectRoot "frontend")
try {
    if (-not (Test-Path -LiteralPath "node_modules")) {
        & npm.cmd install
        if ($LASTEXITCODE -ne 0) { throw "npm install failed" }
    }
    & npm.cmd run build
    if ($LASTEXITCODE -ne 0) { throw "npm run build failed" }
}
finally {
    Pop-Location
}

Write-Host "[3/8] Copying app files..."
Copy-RoboChecked `
    -Source (Join-Path $ProjectRoot "backend") `
    -Destination (Join-Path $Stage "backend") `
    -ExtraArgs @(
        "/XD", "data", "__pycache__",
        "/XF", "*.log", "*.pyc", "content_hub.db", "content_hub.db-wal", "content_hub.db-shm", "sample_real.json"
    )

New-Item -ItemType Directory -Force -Path (Join-Path $Stage "frontend") | Out-Null
Copy-RoboChecked `
    -Source (Join-Path $ProjectRoot "frontend\dist") `
    -Destination (Join-Path $Stage "frontend\dist")

$RootFiles = @(
    "MV_agent.bat",
    "MVHub_Update.bat",
    "run-server.bat",
    "cli-login.bat",
    "update-cli.bat",
    "push_agent.py",
    "README.md"
)
foreach ($Name in $RootFiles) {
    $Src = Join-Path $ProjectRoot $Name
    if (Test-Path -LiteralPath $Src) {
        Copy-Item -LiteralPath $Src -Destination (Join-Path $Stage $Name) -Force
    }
}

Set-Content -LiteralPath (Join-Path $Stage "VERSION.txt") -Value $Version -Encoding ASCII

if (-not $SkipPythonRuntime) {
    Write-Host "[4/8] Copying bundled Python runtime..."
    $Python = Resolve-PythonRuntime -PreferredExe $PythonExe
    $RuntimeDir = Join-Path $Stage "runtime\python"
    $SitePackages = Join-Path $RuntimeDir "Lib\site-packages"

    Copy-RoboChecked `
        -Source $Python.Root `
        -Destination $RuntimeDir `
        -ExtraArgs @(
            "/XD",
            (Join-Path $Python.Root "Doc"),
            (Join-Path $Python.Root "Lib\site-packages"),
            "__pycache__",
            "/XF", "*.pyc", "*.pyo"
        )

    New-Item -ItemType Directory -Force -Path $SitePackages | Out-Null
    Write-Host "      Installing backend packages into runtime..."
    & $Python.Exe -m pip install --upgrade --target $SitePackages -r (Join-Path $ProjectRoot "backend\requirements.txt")
    if ($LASTEXITCODE -ne 0) {
        throw "pip install into bundled runtime failed"
    }

    $RequirementsHash = (Get-FileHash -LiteralPath (Join-Path $ProjectRoot "backend\requirements.txt") -Algorithm MD5).Hash.ToLowerInvariant()
    Set-Content -LiteralPath (Join-Path $Stage "backend\.deps_installed") -Value $RequirementsHash -Encoding ASCII
}
else {
    Write-Host "[4/8] Skipping bundled Python runtime."
}

if (-not $SkipNodeRuntime) {
    Write-Host "[5/8] Copying bundled Node.js runtime..."
    $NodeSource = Resolve-NodeRuntime -PreferredRoot $NodeRoot
    Copy-RoboChecked `
        -Source $NodeSource `
        -Destination (Join-Path $Stage "runtime\node") `
        -ExtraArgs @(
            "/XD", "__pycache__",
            "/XF", "*.log"
        )
}
else {
    Write-Host "[5/8] Skipping bundled Node.js runtime."
}

if (-not $SkipHiggsfieldCli) {
    Write-Host "[6/8] Copying bundled Higgsfield CLI..."
    $Higgsfield = Resolve-HiggsfieldCli -PreferredRoot $HiggsfieldRoot
    $HfDest = Join-Path $Stage "runtime\higgsfield"
    $HfPackageDest = Join-Path $HfDest "node_modules\@higgsfield\cli"
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $HfPackageDest) | Out-Null

    foreach ($Shim in @("higgsfield.cmd", "higgsfield")) {
        $Src = Join-Path $Higgsfield.Root $Shim
        if (Test-Path -LiteralPath $Src) {
            Copy-Item -LiteralPath $Src -Destination (Join-Path $HfDest $Shim) -Force
        }
    }

    Copy-RoboChecked `
        -Source $Higgsfield.Package `
        -Destination $HfPackageDest `
        -ExtraArgs @(
            "/XD", "__pycache__",
            "/XF", "*.log"
        )
}
else {
    Write-Host "[6/8] Skipping bundled Higgsfield CLI."
}

Write-Host "[7/8] Creating zip..."
$ZipPath = Join-Path $OutputDir "$PackageName.zip"
Remove-Item -LiteralPath $ZipPath -Force -ErrorAction SilentlyContinue
Compress-Archive -Path (Join-Path $Stage "*") -DestinationPath $ZipPath -CompressionLevel Optimal

Write-Host "[8/8] Writing latest.json..."
$Zip = Get-Item -LiteralPath $ZipPath
$Hash = (Get-FileHash -LiteralPath $ZipPath -Algorithm SHA256).Hash.ToLowerInvariant()
$Latest = [ordered]@{
    version = $Version
    file = $Zip.Name
    sha256 = $Hash
    size = $Zip.Length
    created_at = (Get-Date).ToString("s")
}
$LatestPath = Join-Path $OutputDir "latest.json"
$Latest | ConvertTo-Json | Set-Content -LiteralPath $LatestPath -Encoding UTF8

Write-Host ""
Write-Host "Release ready:"
Write-Host "  $ZipPath"
Write-Host "  $LatestPath"
Write-Host ""
Write-Host "Upload latest.json and the zip file to your company server packages folder."

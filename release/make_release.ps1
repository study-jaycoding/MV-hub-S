param(
    [string]$Version = (Get-Date -Format "yyyy.MM.dd-HHmm"),
    [string]$OutputDir = (Join-Path $PSScriptRoot "packages"),
    [string]$PublishDir = "",
    [string]$PythonExe = "",
    [string]$NodeRoot = "",
    [string]$HiggsfieldRoot = "",
    [switch]$SkipPythonRuntime,
    [switch]$SkipNodeRuntime,
    [switch]$SkipHiggsfieldCli,
    [switch]$SkipPublish
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

function Read-ArchiveText {
    param(
        [object]$Archive,
        [string]$EntryName
    )

    $Entry = $Archive.Entries | Where-Object {
        $_.FullName.Replace("\", "/") -eq $EntryName
    } | Select-Object -First 1
    if (-not $Entry) {
        throw "Release archive is missing required file: $EntryName"
    }
    $Reader = New-Object System.IO.StreamReader($Entry.Open())
    try {
        return $Reader.ReadToEnd()
    }
    finally {
        $Reader.Dispose()
    }
}

function Assert-PythonRuntimeTree {
    param(
        [string]$RuntimeDir,
        [string]$Label = "runtime"
    )

    $Exe = Join-Path $RuntimeDir "python.exe"
    if (-not (Test-Path -LiteralPath $Exe -PathType Leaf)) {
        throw "Bundled Python validation failed ($Label): python.exe is missing."
    }

    # A successful `python --version` is not enough. A stale Lib tree from another
    # version can still start and then fail on the first real import (the 3.14
    # pathlib + 3.11 glob mix was one such production failure). Exercise both the
    # standard library and every backend dependency from the finished runtime.
    $Probe = @(
        "import sys,struct,glob,pathlib,ssl,sqlite3,json,asyncio",
        "import fastapi,uvicorn,pydantic,websockets,multipart,PIL,watchdog",
        "import starlette,pydantic_core,annotated_types,annotated_doc,typing_inspection,typing_extensions",
        "import anyio,idna,click,h11,httptools,dotenv,yaml,watchfiles,colorama,pip",
        "print('%d.%d.%d|%d' % (*sys.version_info[:3], struct.calcsize('P') * 8))"
    ) -join ";"
    $Output = @(& $Exe -I -c $Probe 2>&1)
    if ($LASTEXITCODE -ne 0 -or -not $Output) {
        throw "Bundled Python validation failed ($Label): $($Output -join ' ')"
    }

    $RuntimeIdentity = ([string]$Output[-1]).Trim().Split("|")
    if ($RuntimeIdentity.Count -ne 2 -or [int]$RuntimeIdentity[1] -ne 64) {
        throw "Bundled Python validation failed ($Label): expected 64-bit runtime, got '$($Output[-1])'."
    }
    $VersionParts = $RuntimeIdentity[0].Split(".")
    if ($VersionParts.Count -lt 2) {
        throw "Bundled Python validation failed ($Label): invalid version output '$($Output[-1])'."
    }
    if ([int]$VersionParts[0] -ne 3 -or [int]$VersionParts[1] -ne 14) {
        throw "Bundled Python validation failed ($Label): release runtime must be Python 3.14 x64."
    }
    $ExpectedDll = "python$($VersionParts[0])$($VersionParts[1]).dll"
    $VersionDlls = @(Get-ChildItem -LiteralPath $RuntimeDir -File -Filter "python*.dll" | Where-Object {
        $_.Name -match "^python3\d{2}\.dll$"
    })
    if ($VersionDlls.Count -ne 1 -or $VersionDlls[0].Name -ine $ExpectedDll) {
        $Found = ($VersionDlls | ForEach-Object Name) -join ", "
        throw "Bundled Python validation failed ($Label): expected only $ExpectedDll, found [$Found]."
    }

    Write-Host "      Python runtime verified ($Label): $($RuntimeIdentity[0]) 64-bit, $ExpectedDll"
}

function Assert-ReleaseArchive {
    param(
        [string]$ArchivePath,
        [string]$ExpectedVersion
    )

    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $Archive = [System.IO.Compression.ZipFile]::OpenRead($ArchivePath)
    try {
        $Entries = @($Archive.Entries)
        $Names = @($Entries | ForEach-Object { $_.FullName.Replace("\", "/") })
        $Required = @(
            "VERSION.txt",
            "MV_agent.bat",
            "update_release.bat",
            "run_release_update.ps1",
            "update_release_worker.bat",
            "agent_push.py",
            "run_agent_session.py",
            "hf_cli_version.txt",
            "backend/serve.py",
            "backend/app/main.py",
            "backend/app/routers/release_update.py",
            "backend/app/services/release_update.py",
            "backend/requirements.txt",
            "frontend/dist/index.html",
            "runtime/python/python.exe",
            "runtime/python/Lib/site-packages/fastapi/__init__.py",
            "runtime/python/Lib/site-packages/pip/__init__.py",
            "backend/.deps_installed",
            "runtime/node/node.exe",
            "runtime/node/npm.cmd",
            "runtime/higgsfield/higgsfield.cmd",
            "runtime/higgsfield/node_modules/@higgsfield/cli/bin/higgsfield.js"
        )
        if ($SkipPythonRuntime) {
            $Required = @($Required | Where-Object {
                $_ -notmatch "^(runtime/python/|backend/\.deps_installed$)"
            })
        }
        if ($SkipNodeRuntime) {
            $Required = @($Required | Where-Object { $_ -notmatch "^runtime/node/" })
        }
        if ($SkipHiggsfieldCli) {
            $Required = @($Required | Where-Object { $_ -notmatch "^runtime/higgsfield/" })
        }
        foreach ($Name in $Required) {
            if ($Names -notcontains $Name) {
                throw "Release archive is missing required file: $Name"
            }
        }

        if (-not $SkipPythonRuntime) {
            $PythonVersionDlls = @($Names | Where-Object {
                $_ -match "^runtime/python/python3\d{2}\.dll$"
            })
            if ($PythonVersionDlls.Count -ne 1) {
                throw "Release archive must contain exactly one version-specific Python DLL; found $($PythonVersionDlls.Count)."
            }
        }

        # 릴리즈는 복사 허용 목록으로 만들지만, 나중에 스테이징 로직이 바뀌어 개발 파일이
        # 조용히 추가되는 회귀도 압축을 배포하기 전에 막는다.
        $AllowedTopLevel = @(
            "VERSION.txt",
            "backend",
            "frontend",
            "runtime",
            "MV_agent.bat",
            "update_release.bat",
            "run_release_update.ps1",
            "update_release_worker.bat",
            "agent_push.py",
            "run_agent_session.py",
            "hf_cli_version.txt"
        )
        $UnexpectedTopLevel = @($Names | Where-Object {
            $TopLevel = ($_ -split "/", 2)[0]
            $AllowedTopLevel -notcontains $TopLevel
        })
        $AllowedBackendFiles = @(
            "backend/serve.py",
            "backend/schema.sql",
            "backend/requirements.txt",
            "backend/.deps_installed"
        )
        $UnexpectedBackend = @($Names | Where-Object {
            $_ -match "^backend/" -and
            $_ -notmatch "^backend/app(/|$)" -and
            $AllowedBackendFiles -notcontains $_
        })
        $UnexpectedFrontend = @($Names | Where-Object {
            $_ -match "^frontend/" -and $_ -notmatch "^frontend/dist(/|$)"
        })
        $UnexpectedLayout = @($UnexpectedTopLevel + $UnexpectedBackend + $UnexpectedFrontend)
        if ($UnexpectedLayout.Count -gt 0) {
            $Preview = ($UnexpectedLayout | Select-Object -Unique -First 10) -join ", "
            throw "Release archive contains files outside the allowlist: $Preview"
        }

        $Forbidden = @($Names | Where-Object {
            $_ -match "^backend/(data|data_test|data_backup_[^/]*|\.data_test-incoming-[^/]*|_pm_test_data_snapshots|media|\.pytest_cache|tests)(/|$)" -or
            $_ -match "^backend/.*\.(db|db-wal|db-shm|sqlite|sqlite3)$" -or
            $_ -match "^backend/(.*/)?__pycache__(/|$)" -or
            $_ -match "^backend/(backfill_import|cleanup_orphan_creators|reset_db|requirements-dev\.txt)$" -or
            $_ -match "^frontend/(src|tests|node_modules)(/|$)" -or
            $_ -match "^frontend/.*\.(map|tsbuildinfo)$" -or
            $_ -match "^(docs|tools|deploy|release|predeploy-reports)(/|$)" -or
            $_ -match "^(test_.*\.bat|setup_clone_git\.bat|update_git\.bat)$" -or
            $_ -match "(^|/)\.env($|\.)" -or
            $_ -match "(^|/)(publish_target|INSTALL_SOURCE)\.txt$"
        })
        if ($Forbidden.Count -gt 0) {
            $Preview = ($Forbidden | Select-Object -First 10) -join ", "
            throw "Release archive contains forbidden local/test data: $Preview"
        }

        $ArchiveVersion = (Read-ArchiveText -Archive $Archive -EntryName "VERSION.txt").Trim()
        if ($ArchiveVersion -ne $ExpectedVersion) {
            throw "Release version mismatch: expected $ExpectedVersion, got $ArchiveVersion"
        }

        # 빌드 원본만 믿지 않고 완성된 ZIP 안의 pin과 실제 npm 패키지 버전을 다시 비교한다.
        # 이 검사를 통과한 ZIP이면 update_release.bat 하나로 코드와 정확한 CLI를 함께 배포할 수 있다.
        if (-not $SkipHiggsfieldCli) {
            $ArchiveCliPin = (Read-ArchiveText -Archive $Archive -EntryName "hf_cli_version.txt").Trim()
            $ArchiveCliManifest = (
                Read-ArchiveText `
                    -Archive $Archive `
                    -EntryName "runtime/higgsfield/node_modules/@higgsfield/cli/package.json"
            ) | ConvertFrom-Json
            $ArchiveCliVersion = [string]$ArchiveCliManifest.version
            if (-not $ArchiveCliPin -or $ArchiveCliVersion -ne $ArchiveCliPin) {
                throw "Bundled Higgsfield CLI mismatch: pin=$ArchiveCliPin package=$ArchiveCliVersion"
            }
        }
    }
    finally {
        $Archive.Dispose()
    }
}

function Resolve-PythonRuntime {
    param([string]$PreferredExe)

    $Candidates = @()
    if ($PreferredExe) {
        $Candidates += $PreferredExe
    }

    # 릴리스 기본 런타임은 현재 제품 검증 기준인 CPython 3.14 x64다. Python
    # Launcher가 있으면 PATH나 Microsoft Store 별칭보다 먼저 정확한 버전을 찾는다.
    $PythonLauncher = Get-Command py -ErrorAction SilentlyContinue
    if ($PythonLauncher) {
        $PythonLauncherExe = [string]$PythonLauncher.Source
        $Python314 = @(& $PythonLauncherExe -3.14 -c "import sys; print(sys.executable)" 2>$null)
        if ($LASTEXITCODE -eq 0 -and $Python314) {
            $Candidates += ([string]$Python314[-1]).Trim()
        }
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

function Assert-SupportedPython {
    param([object]$Python)

    # 현재 설치된 Resolve 20.3.2의 공식 Scripting README는 Python >= 3.6 64-bit를 요구한다.
    # 그 범위 안에서 실제 Resolve 20.3.2 연결까지 검증한 CPython 3.14 x64를 제품
    # 릴리스 런타임으로 고정한다. 빌드 PC의 PATH 순서에 따라 3.11/3.12가 다시
    # 번들되어 PC마다 동작이 달라지는 일을 막기 위한 재현 가능한 빌드 계약이다.
    $Raw = @(& $Python.Exe -c "import struct,sys; print('%d.%d.%d' % sys.version_info[:3]); print(struct.calcsize('P') * 8)" 2>$null)
    if ($LASTEXITCODE -ne 0 -or -not $Raw -or $Raw.Count -lt 2) {
        throw "Could not read bundled Python version: $($Python.Exe)"
    }
    $VersionText = ([string]$Raw[0]).Trim()
    $Bits = [int](([string]$Raw[1]).Trim())
    $Parts = $VersionText.Split(".")
    $Minor = [int]$Parts[1]
    if ([int]$Parts[0] -ne 3 -or $Minor -ne 14) {
        throw "Bundled Python $VersionText is not the verified release runtime. Python 3.14 x64 is required."
    }
    if ($Bits -ne 64) {
        throw "Bundled Python $VersionText is $Bits-bit. MV Hub and DaVinci Resolve require 64-bit Python."
    }
    Write-Host "      Bundled Python $VersionText ($Bits-bit; Resolve official prerequisite satisfied)"
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
$ReleaseCliVersion = ""

Write-Host "[1/8] Preparing staging folder..."
Remove-Item -LiteralPath $StagingRoot -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $Stage | Out-Null
New-Item -ItemType Directory -Force -Path $OutputDir | Out-Null

Write-Host "[2/8] Building frontend dist..."
Push-Location (Join-Path $ProjectRoot "frontend")
try {
    $TscCmd = Join-Path $PWD "node_modules\.bin\tsc.cmd"
    $ViteCmd = Join-Path $PWD "node_modules\.bin\vite.cmd"
    if ((-not (Test-Path -LiteralPath $TscCmd)) -or (-not (Test-Path -LiteralPath $ViteCmd))) {
        Write-Host "      frontend build tools missing - running npm ci"
        & npm.cmd ci --include=dev --no-audit --no-fund
        if ($LASTEXITCODE -ne 0) { throw "npm ci failed" }
    }
    & npm.cmd run build
    if ($LASTEXITCODE -ne 0) { throw "npm run build failed" }
}
finally {
    Pop-Location
}

Write-Host "[3/8] Copying app files..."
New-Item -ItemType Directory -Force -Path (Join-Path $Stage "backend") | Out-Null
Copy-RoboChecked `
    -Source (Join-Path $ProjectRoot "backend\app") `
    -Destination (Join-Path $Stage "backend\app") `
    -ExtraArgs @(
        "/XD", "__pycache__",
        "/XF", "*.log", "*.pyc"
    )

$BackendFiles = @(
    "serve.py",
    "schema.sql",
    "requirements.txt"
)
foreach ($Name in $BackendFiles) {
    $Src = Join-Path $ProjectRoot "backend\$Name"
    if (Test-Path -LiteralPath $Src) {
        Copy-Item -LiteralPath $Src -Destination (Join-Path $Stage "backend\$Name") -Force
    }
}

New-Item -ItemType Directory -Force -Path (Join-Path $Stage "frontend") | Out-Null
Copy-RoboChecked `
    -Source (Join-Path $ProjectRoot "frontend\dist") `
    -Destination (Join-Path $Stage "frontend\dist") `
    -ExtraArgs @(
        "/XD", ".vite",
        "/XF", "*.map", "*.tsbuildinfo"
    )

$RootFiles = @(
    "MV_agent.bat",
    "update_release.bat",
    "run_release_update.ps1",
    "update_release_worker.bat",
    "agent_push.py",
    "run_agent_session.py",
    "hf_cli_version.txt"
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
    Assert-SupportedPython -Python $Python
    $RuntimeDir = Join-Path $Stage "runtime\python"
    $SitePackages = Join-Path $RuntimeDir "Lib\site-packages"

    Copy-RoboChecked `
        -Source $Python.Root `
        -Destination $RuntimeDir `
        -ExtraArgs @(
            "/XD",
            (Join-Path $Python.Root "Doc"),
            (Join-Path $Python.Root "Lib\site-packages"),
            (Join-Path $Python.Root "Lib\ensurepip"),
            (Join-Path $Python.Root "Lib\idlelib"),
            (Join-Path $Python.Root "Lib\tkinter"),
            (Join-Path $Python.Root "Lib\turtledemo"),
            (Join-Path $Python.Root "Lib\venv"),
            (Join-Path $Python.Root "Scripts"),
            (Join-Path $Python.Root "include"),
            (Join-Path $Python.Root "libs"),
            (Join-Path $Python.Root "tcl"),
            "__pycache__",
            "/XF", "*.pyc", "*.pyo", "pythonw.exe", "_tkinter.pyd", "tcl*.dll", "tk*.dll"
        )

    New-Item -ItemType Directory -Force -Path $SitePackages | Out-Null
    Write-Host "      Installing backend packages into runtime..."
    # 원본 Python의 site-packages는 복사하지 않으므로 pip도 명시적으로 넣는다. MV_agent.bat이
    # 누락된 앱 의존성을 자동 복구할 때 `python -m pip`가 실제로 동작해야 한다.
    & $Python.Exe -m pip install --upgrade --ignore-installed --target $SitePackages `
        "pip==25.3" -r (Join-Path $ProjectRoot "backend\requirements.txt")
    if ($LASTEXITCODE -ne 0) {
        throw "pip install into bundled runtime failed"
    }

    Assert-PythonRuntimeTree -RuntimeDir $RuntimeDir -Label "staging"

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

    # The bundle must match the pinned version (hf_cli_version.txt). Otherwise a stale
    # build machine would ship a CLI the launcher then has to reinstall on first run,
    # or worse, a version we never tested. Fail loudly instead of shipping a mismatch.
    $HfPinFile = Join-Path $ProjectRoot "hf_cli_version.txt"
    if (-not (Test-Path -LiteralPath $HfPinFile)) {
        throw "hf_cli_version.txt not found at repo root - cannot verify the bundled CLI version."
    }
    $HfPin = (Get-Content -LiteralPath $HfPinFile -TotalCount 1).Trim()
    $ReleaseCliVersion = $HfPin
    $BundledVer = (Get-Content -LiteralPath (Join-Path $Higgsfield.Package "package.json") -Raw | ConvertFrom-Json).version
    if ($BundledVer -ne $HfPin) {
        throw "Higgsfield CLI to bundle is $BundledVer but hf_cli_version.txt pins $HfPin. Fix: npm install -g @higgsfield/cli@$HfPin then re-run (or update the pin file)."
    }
    Write-Host "      Bundling pinned Higgsfield CLI $HfPin"

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
try {
    Assert-ReleaseArchive -ArchivePath $ZipPath -ExpectedVersion $Version
    if (-not $SkipPythonRuntime) {
        # Verify what users will actually unzip, not only the pre-compression staging
        # directory. This catches damaged/truncated archives before latest.json moves.
        $ArchiveVerifyRoot = Join-Path $env:TEMP ("mvhub-release-verify-" + [Guid]::NewGuid().ToString("N"))
        try {
            Expand-Archive -LiteralPath $ZipPath -DestinationPath $ArchiveVerifyRoot -Force
            Assert-PythonRuntimeTree `
                -RuntimeDir (Join-Path $ArchiveVerifyRoot "runtime\python") `
                -Label "finished archive"
        }
        finally {
            Remove-Item -LiteralPath $ArchiveVerifyRoot -Recurse -Force -ErrorAction SilentlyContinue
        }
    }
    Write-Host "      Archive contents and bundled runtime validated."
}
catch {
    Remove-Item -LiteralPath $ZipPath -Force -ErrorAction SilentlyContinue
    throw
}

Write-Host "[8/8] Writing latest.json..."
$Zip = Get-Item -LiteralPath $ZipPath
$Hash = (Get-FileHash -LiteralPath $ZipPath -Algorithm SHA256).Hash.ToLowerInvariant()
$Latest = [ordered]@{
    version = $Version
    higgsfield_cli_version = $ReleaseCliVersion
    file = $Zip.Name
    sha256 = $Hash
    size = $Zip.Length
    created_at = (Get-Date).ToString("s")
}
$LatestPath = Join-Path $OutputDir "latest.json"
$Latest | ConvertTo-Json | Set-Content -LiteralPath $LatestPath -Encoding UTF8
$InstallerPath = Join-Path $OutputDir "MVHub_Install.bat"
Copy-Item -LiteralPath (Join-Path $PSScriptRoot "MVHub_Install.bat") -Destination $InstallerPath -Force

Write-Host ""
Write-Host "Release ready:"
Write-Host "  $ZipPath"
Write-Host "  $LatestPath"
Write-Host "  $InstallerPath"
Write-Host ""

# ── Auto-publish to the server packages folder (optional) ──────────────────
# Destination comes from -PublishDir, else from publish_target.txt (machine-local,
# git-ignored). If set and reachable, copy the zip FIRST and latest.json LAST so a
# worker never sees a latest.json that points to a not-yet-copied zip.
$PublishTarget = $PublishDir
if ((-not $SkipPublish) -and (-not $PublishTarget)) {
    $TargetFile = Join-Path $PSScriptRoot "publish_target.txt"
    if (Test-Path -LiteralPath $TargetFile) {
        $PublishTarget = (Get-Content -LiteralPath $TargetFile -Raw).Trim()
    }
}
if ($SkipPublish) {
    Write-Host "[publish] skipped by -SkipPublish. Package remains local for validation."
}
elseif (-not $PublishTarget) {
    Write-Host "Upload latest.json and the zip file to your company server packages folder."
    Write-Host "(To automate: put the server packages path in release\publish_target.txt)"
}
elseif ($PublishTarget -match "^https?://") {
    Write-Host "[publish] '$PublishTarget' is an http URL - auto-copy not supported. Upload manually."
}
elseif (-not (Test-Path -LiteralPath $PublishTarget)) {
    Write-Host "[publish] target folder not found: $PublishTarget"
    Write-Host "          Check the network drive / permissions, or copy the two files manually."
}
else {
    Write-Host "[publish] copying to server: $PublishTarget"
    Copy-Item -LiteralPath $ZipPath -Destination $PublishTarget -Force
    Copy-Item -LiteralPath $InstallerPath -Destination $PublishTarget -Force
    Copy-Item -LiteralPath $LatestPath -Destination $PublishTarget -Force
    Write-Host "[publish] done - latest.json was published last; installer/update are ready."
}

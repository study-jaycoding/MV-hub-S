param(
    [string]$Version = (Get-Date -Format "yyyy.MM.dd-HHmm"),
    [string]$OutputDir = (Join-Path $PSScriptRoot "packages"),
    [string]$PublishDir = "",
    [string]$PythonExe = "",
    [string]$NodeRoot = "",
    [string]$HiggsfieldRoot = "",
    [string]$CompatibilityPath = "",
    [string]$PublishCandidatePath = "",
    [switch]$SkipPythonRuntime,
    [switch]$SkipNodeRuntime,
    [switch]$SkipHiggsfieldCli,
    [switch]$SkipPublish
)

$ErrorActionPreference = "Stop"


function Write-TrustedFirstInstaller {
    param([string]$Template, [string]$Verifier, [string]$Destination)
    $Text = [IO.File]::ReadAllText($Template)
    $Marker = '__MVHUB_TRUSTED_BOOTSTRAP_BASE64__'
    if ([regex]::Matches($Text, $Marker).Count -ne 1) { throw 'Installer bootstrap template marker is invalid.' }
    $Bytes = [IO.File]::ReadAllBytes($Verifier)
    [IO.File]::WriteAllText($Destination, $Text.Replace($Marker, [Convert]::ToBase64String($Bytes)), (New-Object Text.UTF8Encoding($false)))
}

function Get-FileDigestHex {
    param(
        [string]$Path,
        [ValidateSet("MD5", "SHA256")]
        [string]$Algorithm
    )

    $Stream = [System.IO.File]::OpenRead($Path)
    if ($Algorithm -eq "MD5") {
        $Hasher = [System.Security.Cryptography.MD5]::Create()
    }
    else {
        $Hasher = [System.Security.Cryptography.SHA256]::Create()
    }
    try {
        return ([BitConverter]::ToString($Hasher.ComputeHash($Stream))).Replace("-", "").ToLowerInvariant()
    }
    finally {
        $Hasher.Dispose()
        $Stream.Dispose()
    }
}

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
    # -B: 이 확인이 스테이징에 pyc 를 남기면 배포 목록에 실리고, 설치 PC 의 파이썬이 그 캐시를 다시 써
    # 1358 에서 올라온 설치본이 지문 검사로 부팅을 거부한다(2026-10-22 1717 선설치).
    $Output = @(& $Exe -I -B -c $Probe 2>&1)
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

function Assert-McpAdapterTree {
    param([string]$Root, [string]$Label = "runtime")

    $Exe = Join-Path $Root "runtime\python\python.exe"
    $Adapter = Join-Path $Root "tools\mcp_adapter\server.py"
    $Setup = Join-Path $Root "tools\mcp_adapter\local_setup.py"
    $Packages = Join-Path $Root "tools\mcp_adapter\site-packages"
    if (-not (Test-Path -LiteralPath $Exe -PathType Leaf) -or
        -not (Test-Path -LiteralPath $Adapter -PathType Leaf) -or
        -not (Test-Path -LiteralPath $Setup -PathType Leaf)) {
        throw "Bundled MCP validation failed ($Label): Python or adapter is missing."
    }
    # -S excludes backend/user .pth files; only the isolated SDK's pywin32 .pth is loaded.
    $Probe = @'
import importlib.metadata, pathlib, site, sys
root = pathlib.Path(sys.argv[1]).resolve()
site.addsitedir(str(root))
import mcp, mcp.client.stdio, pydantic, pywintypes, win32api
for module in (mcp, mcp.client.stdio, pydantic, pywintypes, win32api):
    if not pathlib.Path(module.__file__).resolve().is_relative_to(root):
        raise RuntimeError('MCP import escaped bundled packages: ' + module.__name__)
version = importlib.metadata.version('mcp')
if version != '2.3.0':
    raise RuntimeError('Unexpected MCP SDK version: ' + version)
print('MCP ' + version + ' isolated imports OK')
'@
    $Output = @(& $Exe -I -S -B -c $Probe $Packages 2>&1)
    if ($LASTEXITCODE -ne 0) {
        throw "Bundled MCP validation failed ($Label): $($Output -join ' ')"
    }
    $Help = @(& $Exe -I -S -B -X utf8 $Adapter --help 2>&1)
    if ($LASTEXITCODE -ne 0 -or ($Help -join ' ') -notmatch "usage:") {
        throw "Bundled MCP adapter failed ($Label): $($Help -join ' ')"
    }
    Write-Host "      MCP runtime verified ($Label): $($Output -join ' ')"
}

function Install-HashLockedPackages {
    param([string]$PythonExe, [string]$LockPath, [string]$Target, [string]$Label)

    # 잠금 파일의 판·지문(SHA256)이 다르거나 휠이 없으면 멈춘다 — 받은 파일이 바뀌었거나 소스 빌드·이 PC 의 pip 설정
    # (pip.ini·환경변수)으로 다른 것이 들어가지 않게(배포 전 P1, 2026-10-16 — MCP, 같은 날 Jay 3A 로 백엔드도). --no-deps 를 쓰지 않아
    # 잠금에서 빠진 하위 의존성도 실패로 잡힌다. 대상은 빈 폴더라, 빌드 PC 에 깔린 무관한 패키지와의 거짓 충돌 경고만 숨긴다.
    # 대상이 비어 있지 않으면 멈춘다 — 남은 패키지 위에 설치하면 pip 는 이미 있는 폴더를 바꾸지 않아, 지문을 확인하고도 옛 코드를
    # 포장할 수 있다(스테이징 지우기는 실패를 무시한다 — [1/8]. Codex 3A 리뷰 P2).
    if ((Test-Path -LiteralPath $Target) -and @(Get-ChildItem -LiteralPath $Target -Force).Count -gt 0) {
        throw "bundled $Label packages target is not empty: $Target"
    }
    $PreviousPipConfig = $env:PIP_CONFIG_FILE
    $env:PIP_CONFIG_FILE = "nul"
    try {
        & $PythonExe -m pip --isolated install --require-hashes --only-binary=:all: `
            --index-url https://pypi.org/simple --no-compile --ignore-installed --no-warn-conflicts --target $Target -r $LockPath
        $PipExit = $LASTEXITCODE
    } finally {
        $env:PIP_CONFIG_FILE = $PreviousPipConfig
    }
    if ($PipExit -ne 0) {
        throw "pip install into bundled $Label packages failed"
    }
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
            "update_release_contract.ps1",
            "installer-capabilities.json",
            "agent_push.py",
            "run_agent_session.py",
            "hf_cli_version.txt",
            "mvhub.ico",
            "backend/serve.py",
            "backend/app/main.py",
            "backend/app/routers/release_update.py",
            "backend/app/services/release_update.py",
            "backend/requirements.txt",
            "frontend/dist/index.html",
            "tools/mcp_adapter/server.py",
            "tools/mcp_adapter/update.py",
            "tools/mcp_adapter/local_setup.py",
            "tools/mcp_adapter/requirements.txt",
            "tools/mcp_adapter/requirements.lock.txt",
            "tools/mcp_adapter/site-packages/mcp/__init__.py",
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
                $_ -notmatch "^(runtime/python/|backend/\.deps_installed$|tools/mcp_adapter/site-packages/)"
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
            "build-manifest.json",
            "backend",
            "frontend",
            "runtime",
            "tools",
            "MV_agent.bat",
            "update_release.bat",
            "run_release_update.ps1",
            "update_release_worker.bat",
            "update_release_contract.ps1",
            "installer-capabilities.json",
            "agent_push.py",
            "run_agent_session.py",
            "hf_cli_version.txt",
            "mvhub.ico"
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
            $_ -match "^(docs|deploy|release|predeploy-reports)(/|$)" -or
            ($_ -match "^tools(/|$)" -and
                $_ -notmatch "^tools/(install_db_probe\.py|stop_local_hub_on_port\.ps1|mcp_adapter/(server\.py|update\.py|local_setup\.py|requirements\.txt|requirements\.lock\.txt))$" -and
                $_ -notmatch "^tools/mcp_adapter/site-packages/") -or
            $_ -match "^tools/mcp_adapter/(.*/)?__pycache__(/|$)" -or
            $_ -match "^runtime/python/.*\.pyc$" -or
            $_ -match "^(test_.*\.bat|setup_clone_git\.bat|update_git\.bat)$" -or
            $_ -match "(^|/)\.env($|\.)" -or
            $_ -match "(^|/)(publish_target|INSTALL_SOURCE)\.txt$"
        })
        if ($Forbidden.Count -gt 0) {
            $Preview = ($Forbidden | Select-Object -First 10) -join ", "
            throw "Release archive contains forbidden local/test data: $Preview"
        }

        $FrontendCode = @($Names | Where-Object { $_ -match "^frontend/dist/assets/.*\.(js|css)$" })
        if ($FrontendCode.Count -eq 0) {
            throw "Release archive contains no frontend JS/CSS assets."
        }
        foreach ($Compressed in @($Names | Where-Object { $_ -match "^frontend/dist/assets/.*\.gz$" })) {
            $Original = $Compressed.Substring(0, $Compressed.Length - 3)
            if ($FrontendCode -cnotcontains $Original) {
                throw "Precompressed frontend asset has no JS/CSS original: $Compressed"
            }
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
. (Join-Path $PSScriptRoot "release_manifest_io.ps1")

# Enforce the existing fixed-folder/clean-origin policy before any build or publish write.
if ($ProjectRoot.TrimEnd('\') -ine 'D:\ClaudeCode\MV-hub-S-release') {
    throw 'Releases must be built/published from the fixed MV-hub-S-release checkout.'
}
$Head = & git -C $ProjectRoot rev-parse HEAD
if ($LASTEXITCODE -ne 0) { throw 'Cannot resolve release HEAD.' }
$Main = & git -C $ProjectRoot rev-parse origin/main
if ($LASTEXITCODE -ne 0 -or $Head -cne $Main) { throw 'Release HEAD must equal origin/main.' }
$Dirty = & git -C $ProjectRoot status --porcelain --untracked-files=normal
if ($LASTEXITCODE -ne 0 -or $Dirty) { throw 'Release checkout must be clean.' }
if ($PublishCandidatePath) {
    if ($SkipPublish) { throw 'PublishCandidatePath and SkipPublish cannot be combined.' }
    Publish-QualifiedRelease -CandidatePath $PublishCandidatePath -Directory $PublishDir
    Write-Host 'Qualified candidate published without rebuilding. latest.json was not changed.'
    return
}
if (-not $CompatibilityPath) { $CompatibilityPath = Join-Path $ProjectRoot 'release\compatibility.json' }
$BuildPython = Resolve-PythonRuntime -PreferredExe $PythonExe
$ContractTool = Join-Path $ProjectRoot 'tools\release_contract.py'
$SourceIdentityRaw = & $BuildPython.Exe $ContractTool source --root $ProjectRoot --compatibility $CompatibilityPath
if ($LASTEXITCODE -ne 0) { throw 'Cannot fingerprint release source.' }
$SourceHasher = [System.Security.Cryptography.SHA256]::Create()
try {
    # Python emits LF canonical JSON; PowerShell native output splits it into lines.
    $SourceBytes = [System.Text.Encoding]::UTF8.GetBytes(($SourceIdentityRaw -join "`n").TrimEnd() + "`n")
    $ExpectedSource = ([BitConverter]::ToString($SourceHasher.ComputeHash($SourceBytes))).Replace('-', '').ToLowerInvariant()
}
finally { $SourceHasher.Dispose() }

# 한 번 만든 판(zip)은 바뀌지 않는다(B안 r3) — 같은 이름이 있으면 지우고 다시 만들지 않고 멈춘다.
$ZipPath = Join-Path $OutputDir "$PackageName.zip"
if (Test-Path -LiteralPath $ZipPath) {
    throw "Package already exists: $ZipPath - build with a new -Version (a built zip is never rebuilt in place)."
}
# 게시 대상은 빌드 전에 정한다. 출력 폴더가 곧 게시 폴더면 zip·설치기 생성이 공개 폴더를 직접 바꾼다(Codex r4).
# (드라이브 문자와 UNC 처럼 다른 이름으로 같은 폴더를 가리키는 경우는 가려내지 못한다.)
$ConfiguredTarget = $PublishDir
$TargetFile = Join-Path $PSScriptRoot "publish_target.txt"
if ((-not $ConfiguredTarget) -and (Test-Path -LiteralPath $TargetFile)) {
    $ConfiguredTarget = (Get-Content -LiteralPath $TargetFile -Raw).Trim()
}
# 안전 비교는 -SkipPublish 여도 한다 — 게시 폴더를 -OutputDir 로 주면 설치기·zip 이 공개 폴더에 바로 생긴다(Codex 코드 리뷰)
$PublishTarget = if ($SkipPublish) { "" } else { $ConfiguredTarget }
if ($ConfiguredTarget -and $ConfiguredTarget -notmatch "^https?://") {
    $OutputFull = [System.IO.Path]::GetFullPath($OutputDir).TrimEnd("\", "/")
    $PublishFull = [System.IO.Path]::GetFullPath($ConfiguredTarget).TrimEnd("\", "/")
    if ($OutputFull -ieq $PublishFull) {
        throw "OutputDir must not be the publish folder ($ConfiguredTarget). Build locally; the script uploads the candidate."
    }
}

Write-Host "[1/8] Preparing staging folder..."
Remove-Item -LiteralPath $StagingRoot -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $Stage | Out-Null
New-Item -ItemType Directory -Force -Path $OutputDir | Out-Null

Write-Host "[2/8] Building frontend dist..."
Push-Location (Join-Path $ProjectRoot "frontend")
try {
    if (-not (Test-Path -LiteralPath "package-lock.json" -PathType Leaf)) {
        throw "Frontend package-lock.json is required for a reproducible release build."
    }
    Write-Host "      installing frontend dependencies from package-lock.json"
    & npm.cmd ci --include=dev --no-audit --no-fund
    if ($LASTEXITCODE -ne 0) {
        throw "npm ci failed; build stopped. If files are locked, close frontend dev/build processes and retry."
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
    "update_release_contract.ps1",
    "agent_push.py",
    "run_agent_session.py",
    "hf_cli_version.txt",
    # 바탕화면 바로가기 아이콘. 런처가 %LOCALAPPDATA%\MVHub 로 복사해 그 사본을 가리킨다
    # - 설치 폴더 원본을 가리키면 탐색기가 쥔 핸들 때문에 업데이트 rename 이 막힐 수 있다.
    "mvhub.ico"
)
foreach ($Name in $RootFiles) {
    $Src = Join-Path $ProjectRoot $Name
    if (Test-Path -LiteralPath $Src) {
        Copy-Item -LiteralPath $Src -Destination (Join-Path $Stage $Name) -Force
    }
}
[System.IO.File]::WriteAllText((Join-Path $Stage 'installer-capabilities.json'), '{"format_version":1,"capabilities":["artifact-receipt-v1","install-journal-v1"]}', (New-Object System.Text.UTF8Encoding($false)))

# Port-cleanup helper - MV_agent.bat runs it before starting the hub. tools\ as a whole is
# excluded from bundles; without this file worker PCs printed a red
# PowerShell "-File does not exist" error and skipped stale-hub cleanup entirely.
$PortHelper = Join-Path $ProjectRoot "tools\stop_local_hub_on_port.ps1"
if (Test-Path -LiteralPath $PortHelper) {
    New-Item -ItemType Directory -Force -Path (Join-Path $Stage "tools") | Out-Null
    Copy-Item -LiteralPath $PortHelper -Destination (Join-Path $Stage "tools\stop_local_hub_on_port.ps1") -Force
}

$McpAdapterDir = Join-Path $Stage "tools\mcp_adapter"
Copy-Item -LiteralPath (Join-Path $ProjectRoot 'tools\install_db_probe.py') -Destination (Join-Path $Stage 'tools\install_db_probe.py')
New-Item -ItemType Directory -Force -Path $McpAdapterDir | Out-Null
foreach ($Name in @("server.py", "update.py", "local_setup.py", "requirements.txt", "requirements.lock.txt")) {
    Copy-Item -LiteralPath (Join-Path $ProjectRoot "tools\mcp_adapter\$Name") -Destination (Join-Path $McpAdapterDir $Name)
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
    # 원본 Python의 site-packages는 복사하지 않으므로 pip도 명시적으로 넣는다(잠금의 pip==25.3). MV_agent.bat이
    # 누락된 앱 의존성을 자동 복구할 때 `python -m pip`가 실제로 동작해야 한다.
    # 판은 requirements.txt, 지문은 requirements.lock.txt(CPython 3.14·3.12 Windows x64 휠 — 여기서는 3.14 지문이 맞는다) — 둘이 어긋나면 시험이 잡는다.
    # 완성 런타임은 아래 import/ZIP 검증으로 별도 확정한다.
    Install-HashLockedPackages -PythonExe $Python.Exe -LockPath (Join-Path $ProjectRoot "backend\requirements.lock.txt") `
        -Target $SitePackages -Label "backend"

    Assert-PythonRuntimeTree -RuntimeDir $RuntimeDir -Label "staging"

    # The SDK shares only Python's executable/stdlib, never the backend dependencies.
    $McpPackages = Join-Path $McpAdapterDir "site-packages"
    Install-HashLockedPackages -PythonExe $Python.Exe -LockPath (Join-Path $McpAdapterDir "requirements.lock.txt") -Target $McpPackages -Label "MCP"
    Assert-McpAdapterTree -Root $Stage -Label "staging"

    $RequirementsHash = Get-FileDigestHex -Path (Join-Path $ProjectRoot "backend\requirements.txt") -Algorithm MD5
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

# The updater in the package is what future updates will run. If it ships broken,
# every PC that installs this release loses the ability to update itself and needs
# a manual repair - so refuse to package a known-bad worker (2026-09-02 incident).
$StagedWorker = Join-Path $Stage "update_release_worker.bat"
if (-not (Test-Path -LiteralPath $StagedWorker -PathType Leaf)) {
    throw "update_release_worker.bat is missing from the staged package."
}
$WorkerText = Get-Content -LiteralPath $StagedWorker -Raw
if ($WorkerText -match [regex]::Escape('$VersionPath, $null')) {
    # Windows PowerShell turns $null into "" for .NET [string] parameters, so
    # File.Replace(...,$null) dies with "The path is not of a legal form."
    throw "Refusing to package: update_release_worker.bat still passes `$null to File.Replace (use [NullString]::Value)."
}
if ($WorkerText -notmatch [regex]::Escape('[NullString]::Value')) {
    throw "Refusing to package: update_release_worker.bat is missing the [NullString]::Value fix."
}
Write-Host "      Updater verified: VERSION commit uses [NullString]::Value."

Write-Host "[7/8] Creating zip..."
& $BuildPython.Exe $ContractTool descriptor --root $ProjectRoot --stage $Stage --version $Version `
    --compatibility $CompatibilityPath --expected-source $ExpectedSource
if ($LASTEXITCODE -ne 0) { throw 'Build descriptor failed; archive not created.' }
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
            Assert-McpAdapterTree -Root $ArchiveVerifyRoot -Label "finished archive"
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

Write-Host "[8/8] Writing candidate.json..."
& $BuildPython.Exe $ContractTool candidate --package $ZipPath
if ($LASTEXITCODE -ne 0) { throw 'Candidate contract creation failed.' }
$CandidatePath = Join-Path $OutputDir "candidate.json"
$InstallerPath = Join-Path $OutputDir "MVHub_Install.bat"
Write-TrustedFirstInstaller -Template (Join-Path $PSScriptRoot "MVHub_Install.bat") -Verifier (Join-Path $ProjectRoot "update_release_contract.ps1") -Destination $InstallerPath

Write-Host ""
Write-Host "Release ready:"
Write-Host "  $ZipPath"
Write-Host "  $CandidatePath"
Write-Host "  $InstallerPath"
Write-Host ""

# Building never publishes. Validate this exact ZIP, bind the resulting receipt with
# tools/release_contract.py qualify, then explicitly use -PublishCandidatePath.
Write-Host 'Candidate is local and unqualified. Build-time checks are not a release qualification.'
Write-Host 'After artifact qualification, publish the same candidate using -PublishCandidatePath and -PublishDir.'

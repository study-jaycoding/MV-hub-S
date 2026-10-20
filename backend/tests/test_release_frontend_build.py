"""릴리스 전체는 실행하지 않고 프런트 빌드 블록만 가짜 npm으로 검증한다."""
from __future__ import annotations

import os
from pathlib import Path
import subprocess
import zipfile

import pytest


@pytest.mark.skipif(os.name != "nt", reason="PowerShell release build")
@pytest.mark.parametrize("has_lock,ci_exit,build_exit,expected", [
    (True, 0, 0, ["ci --include=dev --no-audit --no-fund", "run build"]),
    (True, 7, 0, ["ci --include=dev --no-audit --no-fund"]),
    (True, 0, 9, ["ci --include=dev --no-audit --no-fund", "run build"]),
    (False, 0, 0, []),
])
def test_release_reinstalls_locked_dependencies_and_stops_on_failure(
    tmp_path: Path, has_lock: bool, ci_exit: int, build_exit: int, expected: list[str],
) -> None:
    source = (Path(__file__).resolve().parents[2] / "release/make_release.ps1").read_text(encoding="utf-8-sig")
    block = source.split('Write-Host "[2/8] Building frontend dist..."', 1)[1].split('Write-Host "[3/8] Copying app files..."', 1)[0]
    frontend = tmp_path / "frontend"
    tools = frontend / "node_modules/.bin"
    tools.mkdir(parents=True)
    # 기존 도구가 있어도 ci가 반드시 실행되어야 한다.
    for name in ("tsc.cmd", "vite.cmd"):
        (tools / name).write_text("unused", encoding="ascii")
    if has_lock:
        (frontend / "package-lock.json").write_text("{}", encoding="ascii")
    calls = tmp_path / "calls.txt"
    harness = tmp_path / "build-probe.ps1"
    harness.write_text(
        "param([string]$ProjectRoot,[string]$CallLog,[int]$CiExit,[int]$BuildExit)\n"
        "$ErrorActionPreference = 'Stop'\n"
        "function npm.cmd {\n"
        "  param([Parameter(ValueFromRemainingArguments=$true)][string[]]$NpmArgs)\n"
        "  Add-Content -LiteralPath $CallLog -Value ($NpmArgs -join ' ')\n"
        "  $global:LASTEXITCODE = if ($NpmArgs[0] -eq 'ci') { $CiExit } else { $BuildExit }\n"
        "}\n" + block,
        encoding="utf-8-sig",
    )
    result = subprocess.run(
        ["powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", str(harness),
         "-ProjectRoot", str(tmp_path), "-CallLog", str(calls), "-CiExit", str(ci_exit), "-BuildExit", str(build_exit)],
        capture_output=True, text=True, timeout=20,
    )
    assert (result.returncode == 0) == (has_lock and ci_exit == build_exit == 0), result.stderr
    assert (calls.read_text().splitlines() if calls.exists() else []) == expected


_MCP_LOCK = Path(__file__).resolve().parents[2] / "tools/mcp_adapter/requirements.lock.txt"


def test_release_mcp_lock_has_hash_for_every_pin() -> None:
    # 배포 전 P1(2026-10-16): 번들 SDK 를 판만 고정해 받으면 받은 파일이 바뀌어도 모른다 — 모든 핀에 SHA256 지문
    lines = [line.strip() for line in _MCP_LOCK.read_text(encoding="utf-8").splitlines() if line.strip() and not line.startswith("#")]
    pins = [line.split()[0] for line in lines if "==" in line]
    hashes = [line for line in lines if line.startswith("--hash=sha256:")]
    assert len(pins) == len(hashes) > 20
    assert all(len(h.split(":", 1)[1]) == 64 for h in hashes)
    assert all(line.endswith("\\") for line in lines if "==" in line)  # 핀과 지문이 한 항목으로 묶인다
    direct = (_MCP_LOCK.parent / "requirements.txt").read_text(encoding="utf-8").split()
    assert set(direct) <= set(pins)  # 직접 요구(mcp 판)가 잠금과 같다


_BACKEND = Path(__file__).resolve().parents[1]


def test_release_backend_lock_pins_every_requirement_with_a_hash() -> None:
    # Jay 2026-10-16 3A — 백엔드 번들 의존성도 판만 고정해 받던 것을 지문까지(MCP 와 같은 방식)
    lines = [line.strip() for line in (_BACKEND / "requirements.lock.txt").read_text(encoding="utf-8").splitlines()
             if line.strip() and not line.startswith("#")]
    pins = [line.split()[0] for line in lines if "==" in line]
    hashes = [line for line in lines if line.startswith("--hash=sha256:")]
    assert len(pins) == len(hashes) and all(len(h.split(":", 1)[1]) == 64 for h in hashes)
    assert all(line.endswith("\\") for line in lines if "==" in line)
    required = [line.split("#")[0].strip() for line in (_BACKEND / "requirements.txt").read_text(encoding="utf-8").splitlines()
                if line.split("#")[0].strip()]
    assert sorted(pins) == sorted(["pip==25.3", *required])  # 판이 requirements.txt 와 같고 빠진 것·더한 것이 없다


def test_release_backend_install_uses_the_hash_lock() -> None:
    source = (Path(__file__).resolve().parents[2] / "release/make_release.ps1").read_text(encoding="utf-8-sig")
    assert 'Install-HashLockedPackages -PythonExe $Python.Exe -LockPath (Join-Path $ProjectRoot "backend\\requirements.lock.txt")' in source
    assert '-r (Join-Path $ProjectRoot "backend\\requirements.txt")' not in source  # 지문 없는 설치가 남지 않았다


@pytest.mark.skipif(os.name != "nt", reason="PowerShell release build")
@pytest.mark.parametrize("pip_exit", [0, 3])
def test_release_mcp_install_requires_hashes_and_wheels(tmp_path: Path, pip_exit: int) -> None:
    source = (Path(__file__).resolve().parents[2] / "release/make_release.ps1").read_text(encoding="utf-8-sig")
    function = "function Install-HashLockedPackages {" + source.split("function Install-HashLockedPackages {", 1)[1].split("\n}\n", 1)[0] + "\n}\n"
    log = tmp_path / "pip.txt"
    fake = tmp_path / "python.cmd"
    fake.write_text(f"@echo off\r\necho ARGS %*> \"{log}\"\r\necho CFG %PIP_CONFIG_FILE%>> \"{log}\"\r\nexit /b {pip_exit}\r\n", encoding="ascii")
    harness = tmp_path / "mcp-probe.ps1"
    harness.write_text(
        "param([string]$Py,[string]$Lock,[string]$Target)\n$ErrorActionPreference = 'Stop'\n$env:PIP_CONFIG_FILE = 'C:\\custom\\pip.ini'\n"
        + function
        + "try { Install-HashLockedPackages -PythonExe $Py -LockPath $Lock -Target $Target -Label 'MCP'; Write-Output 'INSTALLED' } catch { Write-Output ('THREW ' + $_) }\n"
        "Write-Output ('AFTER ' + $env:PIP_CONFIG_FILE)\n",
        encoding="utf-8-sig",
    )
    result = subprocess.run(
        ["powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", str(harness),
         "-Py", str(fake), "-Lock", str(_MCP_LOCK), "-Target", str(tmp_path / "site-packages")],
        capture_output=True, text=True, timeout=30,
    )
    args, cfg = log.read_text().splitlines()[:2]
    for flag in ("--isolated", "--require-hashes", "--only-binary=:all:", "--index-url https://pypi.org/simple", "--ignore-installed"):
        assert flag in args
    assert "--no-deps" not in args  # 잠금에서 빠진 하위 의존성도 실패로 잡힌다
    assert cfg.strip() == "CFG nul"  # 이 PC 의 pip.ini 를 읽지 않는다
    assert ("INSTALLED" in result.stdout) == (pip_exit == 0)
    assert ("THREW" in result.stdout) == (pip_exit != 0)  # 실패면 뒤 단계로 가지 않는다
    assert "AFTER C:\\custom\\pip.ini" in result.stdout  # 성공·실패 모두 원래 설정으로 되돌린다


@pytest.mark.skipif(os.name != "nt", reason="PowerShell release build")
def test_release_locked_install_refuses_a_target_with_leftover_packages(tmp_path: Path) -> None:
    # Codex 3A 리뷰 P2 — 남은 패키지 위에 설치하면 pip 가 이미 있는 폴더를 바꾸지 않아 지문 확인을 지나 옛 코드가 포장될 수 있다
    source = (Path(__file__).resolve().parents[2] / "release/make_release.ps1").read_text(encoding="utf-8-sig")
    function = "function Install-HashLockedPackages {" + source.split("function Install-HashLockedPackages {", 1)[1].split("\n}\n", 1)[0] + "\n}\n"
    log = tmp_path / "pip.txt"
    fake = tmp_path / "python.cmd"
    fake.write_text(f"@echo off\r\necho CALLED> \"{log}\"\r\nexit /b 0\r\n", encoding="ascii")
    target = tmp_path / "site-packages"
    (target / "fastapi").mkdir(parents=True)  # 앞 빌드가 남긴 것
    harness = tmp_path / "leftover-probe.ps1"
    harness.write_text(
        "param([string]$Py,[string]$Lock,[string]$Target)\n$ErrorActionPreference = 'Stop'\n"
        + function
        + "try { Install-HashLockedPackages -PythonExe $Py -LockPath $Lock -Target $Target -Label 'backend'; Write-Output 'INSTALLED' } catch { Write-Output ('THREW ' + $_) }\n",
        encoding="utf-8-sig",
    )
    result = subprocess.run(
        ["powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", str(harness),
         "-Py", str(fake), "-Lock", str(_BACKEND / "requirements.lock.txt"), "-Target", str(target)],
        capture_output=True, text=True, timeout=30,
    )
    assert "THREW" in result.stdout and "not empty" in result.stdout
    assert not log.exists()  # pip 를 부르지 않았다


def _archive_probe(
    tmp_path: Path, assets: list[str], *, extra: tuple[str, ...] = (),
    missing: str = "", python: bool = False,
) -> subprocess.CompletedProcess[str]:
    archive = tmp_path / "fixture.zip"
    required = [
        "MV_agent.bat", "update_release.bat", "run_release_update.ps1", "update_release_worker.bat",
        "update_release_contract.ps1", "installer-capabilities.json",
        "agent_push.py", "run_agent_session.py", "hf_cli_version.txt", "mvhub.ico",
        "backend/serve.py", "backend/app/main.py", "backend/app/routers/release_update.py",
        "backend/app/services/release_update.py", "backend/requirements.txt", "frontend/dist/index.html",
        "tools/mcp_adapter/server.py", "tools/mcp_adapter/local_setup.py", "tools/mcp_adapter/requirements.txt",
        "tools/mcp_adapter/requirements.lock.txt",
    ]
    if python:
        required += [
            "runtime/python/python.exe", "runtime/python/python314.dll",
            "runtime/python/Lib/site-packages/fastapi/__init__.py",
            "runtime/python/Lib/site-packages/pip/__init__.py", "backend/.deps_installed",
            "tools/mcp_adapter/site-packages/mcp/__init__.py",
        ]
    with zipfile.ZipFile(archive, "w") as target:
        target.writestr("VERSION.txt", "test")
        for name in required + list(extra) + ["frontend/dist/assets/" + name for name in assets]:
            if name != missing:
                target.writestr(name, "fixture")
    harness = tmp_path / "archive-probe.ps1"
    harness.write_text("""param([string]$Source,[string]$ArchivePath)
$ErrorActionPreference = 'Stop'
$tokens = $null; $errors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile($Source, [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw 'Parse error' }
# 읽기 전용 검사 함수 둘만 추출한다. 빌드·삭제·게시 본문은 실행하지 않는다.
foreach ($name in @('Read-ArchiveText', 'Assert-ReleaseArchive')) {
    $node = $ast.Find({param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq $name}, $false)
    if (-not $node) { throw "Missing function: $name" }
    . ([scriptblock]::Create($node.Extent.Text))
}
$SkipPythonRuntime = SKIP_PYTHON; $SkipNodeRuntime = $true; $SkipHiggsfieldCli = $true
Assert-ReleaseArchive -ArchivePath $ArchivePath -ExpectedVersion 'test'
""".replace("SKIP_PYTHON", "$false" if python else "$true"), encoding="utf-8-sig")
    source = Path(__file__).resolve().parents[2] / "release/make_release.ps1"
    return subprocess.run(
        ["powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", str(harness),
         "-Source", str(source), "-ArchivePath", str(archive)],
        capture_output=True, text=True, timeout=20,
    )


@pytest.mark.skipif(os.name != "nt", reason="PowerShell archive validator")
@pytest.mark.parametrize("assets,valid", [
    (["index-test.js", "index-test.js.gz"], True),
    (["index-test.js", "missing.js.gz"], False),
    ([], False),
])
def test_release_archive_checks_compressed_asset_pairs(tmp_path: Path, assets: list[str], valid: bool) -> None:
    result = _archive_probe(tmp_path, assets)
    assert (result.returncode == 0) == valid, result.stderr
    if not valid:
        assert ("no JS/CSS original" if assets else "no frontend JS/CSS") in result.stderr


@pytest.mark.skipif(os.name != "nt", reason="PowerShell archive validator")
@pytest.mark.parametrize("name,allowed", [
    ("tools/stop_local_hub_on_port.ps1", True),
    ("tools/mcp_adapter/site-packages/pywin32.pth", True),
    ("tools/mcp_adapter/site-packages/win32/win32api.pyd", True),
    ("tools/mcp_adapter/test_server.py", False),
    ("tools/mcp_adapter/test_local_setup.py", False),
    ("tools/mcp_adapter/README.md", False),
    ("tools/mcp_adapter/server.py.bak", False),
    ("tools/mcp_adapter/__pycache__/server.cpython-314.pyc", False),
    ("tools/mcp_adapter/site-packages/mcp/__pycache__/__init__.cpython-314.pyc", False),
    ("tools/mcp_adapter/site-packages-other/leak.py", False),
    ("tools/unrelated.py", False),
])
def test_release_mcp_tools_allowlist(tmp_path: Path, name: str, allowed: bool) -> None:
    result = _archive_probe(tmp_path, ["index-test.js"], extra=(name,))
    assert (result.returncode == 0) == allowed, result.stderr
    if not allowed:
        assert "forbidden local/test data" in result.stderr


@pytest.mark.skipif(os.name != "nt", reason="PowerShell archive validator")
@pytest.mark.parametrize("missing", [
    "tools/mcp_adapter/server.py",
    "tools/mcp_adapter/local_setup.py",
    "tools/mcp_adapter/requirements.txt",
    "tools/mcp_adapter/requirements.lock.txt",
    "tools/mcp_adapter/site-packages/mcp/__init__.py",
])
def test_release_requires_mcp_adapter_and_bundled_sdk(tmp_path: Path, missing: str) -> None:
    result = _archive_probe(tmp_path, ["index-test.js"], missing=missing, python=True)
    assert result.returncode != 0
    assert "missing required file" in result.stderr
    assert missing in result.stderr


@pytest.mark.skipif(os.name != "nt", reason="PowerShell archive validator")
def test_release_accepts_mcp_sdk_with_bundled_python(tmp_path: Path) -> None:
    result = _archive_probe(tmp_path, ["index-test.js"], python=True)
    assert result.returncode == 0, result.stderr

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


@pytest.mark.skipif(os.name != "nt", reason="PowerShell archive validator")
@pytest.mark.parametrize("assets,valid", [
    (["index-test.js", "index-test.js.gz"], True),
    (["index-test.js", "missing.js.gz"], False),
    ([], False),
])
def test_release_archive_checks_compressed_asset_pairs(tmp_path: Path, assets: list[str], valid: bool) -> None:
    archive = tmp_path / "fixture.zip"
    required = [
        "MV_agent.bat", "update_release.bat", "run_release_update.ps1", "update_release_worker.bat",
        "agent_push.py", "run_agent_session.py", "hf_cli_version.txt", "mvhub.ico",
        "backend/serve.py", "backend/app/main.py", "backend/app/routers/release_update.py",
        "backend/app/services/release_update.py", "backend/requirements.txt", "frontend/dist/index.html",
    ]
    with zipfile.ZipFile(archive, "w") as target:
        target.writestr("VERSION.txt", "test")
        for name in required + ["frontend/dist/assets/" + name for name in assets]:
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
$SkipPythonRuntime = $true; $SkipNodeRuntime = $true; $SkipHiggsfieldCli = $true
Assert-ReleaseArchive -ArchivePath $ArchivePath -ExpectedVersion 'test'
""", encoding="utf-8-sig")
    source = Path(__file__).resolve().parents[2] / "release/make_release.ps1"
    result = subprocess.run(
        ["powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", str(harness),
         "-Source", str(source), "-ArchivePath", str(archive)],
        capture_output=True, text=True, timeout=20,
    )
    assert (result.returncode == 0) == valid, result.stderr
    if not valid:
        assert ("no JS/CSS original" if assets else "no frontend JS/CSS") in result.stderr

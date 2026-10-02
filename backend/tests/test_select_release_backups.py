"""Exercise the selector against tiny synthetic ZIPs, never a real release/NAS."""
from __future__ import annotations

import base64
import hashlib
import json
import os
import re
import shutil
from pathlib import Path
import subprocess
from zipfile import ZipFile

import pytest


pytestmark = pytest.mark.skipif(os.name != "nt", reason="Windows PowerShell release tool")
SELECTOR = Path(__file__).resolve().parents[2] / "release" / "select_release.ps1"


def _quote(path: Path) -> str:
    return "'" + str(path).replace("'", "''") + "'"


def _package(tmp_path: Path, *, valid: bool = True) -> Path:
    directory = tmp_path / "packages [test]"
    directory.mkdir()
    path = directory / "MVHub-test.zip"
    with ZipFile(path, "w") as archive:
        archive.writestr("VERSION.txt", "test-version")
        archive.writestr("hf_cli_version.txt", "1.1.25")
        if valid:
            archive.writestr(
                "runtime/higgsfield/node_modules/@higgsfield/cli/package.json",
                json.dumps({"version": "1.1.25"}),
            )
    return path


def _run(
    package: Path, latest: Path | None = None, *, lock_latest: bool = False,
    backup_target: Path | None = None, hold_release_lock: bool = False,
):
    arguments = f"-PackagePath {_quote(package)} -LockWaitSeconds 0.5"
    if latest is not None:
        arguments += f" -LatestPath {_quote(latest)}"
    setup = ""
    if backup_target is not None:
        setup = (
            f"New-Item -ItemType Junction -Path {_quote(package.parent / 'latest-backups')} "
            f"-Target {_quote(backup_target)} | Out-Null"
        )
    script = f"""
$ErrorActionPreference = 'Stop'
{setup}
function Get-Date {{
    param([string]$Format)
    $FixedDate = [datetime]'2026-09-18T09:00:00'
    if ($Format) {{ return $FixedDate.ToString($Format) }}
    return $FixedDate
}}
& {_quote(SELECTOR)} {arguments}
"""
    if lock_latest:
        assert latest is not None
        script = (
            f"$Locked = [IO.File]::Open({_quote(latest)}, 'Open', 'ReadWrite', 'None')\n"
            f"try {{\n{script}\n}} finally {{ $Locked.Dispose() }}"
        )
    if hold_release_lock:  # 다른 배포 도구(promote·make_release)가 잠금을 쥔 상태
        lock = (latest.parent if latest is not None else package.parent) / "release.lock"
        script = (
            f"$Held = [IO.File]::Open({_quote(lock)}, 'OpenOrCreate', 'ReadWrite', 'None')\n"
            f"try {{\n{script}\n}} finally {{ $Held.Dispose() }}"
        )
    encoded = base64.b64encode(script.encode("utf-16-le")).decode("ascii")
    return subprocess.run(
        ["powershell.exe", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
         "-EncodedCommand", encoded],
        capture_output=True, timeout=30, cwd=package.parent,
        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
    )


@pytest.mark.parametrize("custom_latest", [False, True])
def test_previous_manifest_is_preserved_in_backup_directory(tmp_path: Path, custom_latest: bool):
    package = _package(tmp_path)
    directory = tmp_path / "separate source" if custom_latest else package.parent
    directory.mkdir(exist_ok=True)
    latest = directory / "latest.json"
    previous = b'\xef\xbb\xbf{"version":"previous", "keep":"all original bytes"}\r\n'
    latest.write_bytes(previous)
    legacy = directory / "latest.previous-20260911.json"
    legacy.write_bytes(b"older backup remains untouched")

    result = _run(package, latest if custom_latest else None)

    assert result.returncode == 0, result.stderr
    assert b"backup :" in result.stdout
    backups = list((directory / "latest-backups").glob("latest.previous-*.json"))
    assert len(backups) == 1
    assert re.fullmatch(r"latest\.previous-20260918-090000-[0-9a-f]{6}\.json", backups[0].name)
    assert backups[0].read_bytes() == previous
    assert list(directory.glob("latest.previous-*.json")) == [legacy]
    assert legacy.read_bytes() == b"older backup remains untouched"
    selected = json.loads(latest.read_text("utf-8-sig"))
    assert selected["version"] == "test-version"
    assert selected["higgsfield_cli_version"] == "1.1.25"
    assert selected["file"] == package.name
    assert selected["sha256"] == hashlib.sha256(package.read_bytes()).hexdigest()
    assert selected["size"] == package.stat().st_size
    assert not list(directory.glob("*.tmp-*"))
    if custom_latest:
        assert not (package.parent / "latest-backups").exists()


def test_first_selection_has_no_previous_manifest_to_back_up(tmp_path: Path):
    package = _package(tmp_path)
    result = _run(package)
    assert result.returncode == 0, result.stderr
    assert (package.parent / "latest.json").is_file()
    assert not (package.parent / "latest-backups").exists()


def test_same_second_reselection_keeps_both_backups(tmp_path: Path):
    # 백업 이름에 고유 접미사 — 같은 초에 다시 골라도 막히지 않고 두 백업이 다 남는다(Codex 코드 리뷰, promote 와 같은 규칙)
    package = _package(tmp_path)
    latest = package.parent / "latest.json"
    original = b'{"version":"original"}'
    latest.write_bytes(original)
    first = _run(package)
    assert first.returncode == 0, first.stderr
    after_first = latest.read_bytes()
    second = _run(package)
    assert second.returncode == 0, second.stderr
    backups = sorted(b.read_bytes() for b in (package.parent / "latest-backups").glob("latest.previous-*.json"))
    assert backups == sorted([original, after_first])
    assert not list(package.parent.glob("*.tmp-*"))


@pytest.mark.parametrize("failure", ["directory_is_file", "latest_locked", "invalid_package"])
def test_backup_or_validation_failure_keeps_current_latest(tmp_path: Path, failure: str):
    package = _package(tmp_path, valid=failure != "invalid_package")
    latest = package.parent / "latest.json"
    original = b'{"version":"do-not-replace"}'
    latest.write_bytes(original)
    backup_directory = package.parent / "latest-backups"
    if failure == "directory_is_file":
        backup_directory.write_bytes(b"do not overwrite this file either")

    result = _run(package, latest, lock_latest=failure == "latest_locked")

    assert result.returncode != 0
    assert latest.read_bytes() == original
    assert not list(package.parent.glob("*.tmp-*"))
    if failure == "directory_is_file":
        assert backup_directory.read_bytes() == b"do not overwrite this file either"
    elif failure == "invalid_package":
        assert not backup_directory.exists()


def test_linked_backup_directory_is_rejected_without_writing_through_it(tmp_path: Path):
    package = _package(tmp_path)
    latest = package.parent / "latest.json"
    original = b'{"version":"do-not-replace"}'
    latest.write_bytes(original)
    target = tmp_path / "outside packages"
    target.mkdir()
    sentinel = target / "keep.txt"
    sentinel.write_bytes(b"untouched")

    result = _run(package, backup_target=target)

    assert result.returncode != 0
    assert b"Backup directory must not be a link" in result.stderr
    assert latest.read_bytes() == original
    assert list(target.iterdir()) == [sentinel]
    assert sentinel.read_bytes() == b"untouched"
    assert not list(package.parent.glob("*.tmp-*"))


def test_selection_writes_the_same_bytes_to_candidate_and_latest(tmp_path: Path):
    package = _package(tmp_path)
    result = _run(package)
    assert result.returncode == 0, result.stderr
    latest, candidate = package.parent / "latest.json", package.parent / "candidate.json"
    # 롤백 뒤 후보 = 공개본 → 되돌린 판이 '공지됨·배포 안 됨'으로 다시 배포될 길이 없다(B안)
    assert candidate.read_bytes() == latest.read_bytes()
    assert json.loads(latest.read_text("utf-8-sig"))["file"] == package.name


def test_selection_announces_that_it_cancels_an_unannounced_candidate(tmp_path: Path):
    package = _package(tmp_path)
    (package.parent / "latest.json").write_text(json.dumps({"sha256": "1" * 64}), encoding="utf-8")
    (package.parent / "candidate.json").write_text(json.dumps({"sha256": "2" * 64}), encoding="utf-8")
    result = _run(package)
    assert result.returncode == 0, result.stderr
    assert b"cancelled by this selection" in result.stdout


def test_latest_switch_failure_leaves_candidate_updated_and_latest_untouched(tmp_path: Path):
    package = _package(tmp_path)
    latest = package.parent / "latest.json"
    original = b'{"version":"keep-public"}'
    latest.write_bytes(original)
    os.chmod(latest, 0o444)  # 읽기 전용 → 백업은 되고 교체만 실패
    try:
        result = _run(package)
    finally:
        os.chmod(latest, 0o666)
    assert result.returncode != 0
    assert b"latest.json was NOT switched" in result.stderr
    assert latest.read_bytes() == original
    assert json.loads((package.parent / "candidate.json").read_text("utf-8-sig"))["file"] == package.name
    assert not list(package.parent.glob("*.tmp-*"))  # 무변경이 확인된 실패 — 임시 파일 정리
    # 같은 명령을 다시 — 시험은 시각이 고정이라 같은 이름 백업 충돌만 피하려 백업 폴더를 비운다
    shutil.rmtree(package.parent / "latest-backups", onexc=lambda fn, path, _exc: (os.chmod(path, 0o666), fn(path)))
    rerun = _run(package)
    assert rerun.returncode == 0, rerun.stderr
    assert latest.read_bytes() == (package.parent / "candidate.json").read_bytes()


def test_selection_waits_for_the_release_lock_and_changes_nothing(tmp_path: Path):
    package = _package(tmp_path)
    latest = package.parent / "latest.json"
    original = b'{"version":"locked-out"}'
    latest.write_bytes(original)
    result = _run(package, hold_release_lock=True)
    assert result.returncode != 0
    assert b"locked by another release tool" in result.stderr
    assert latest.read_bytes() == original
    assert not (package.parent / "candidate.json").exists()

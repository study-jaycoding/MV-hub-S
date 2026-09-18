"""Exercise the selector against tiny synthetic ZIPs, never a real release/NAS."""
from __future__ import annotations

import base64
import hashlib
import json
import os
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
    backup_target: Path | None = None,
):
    arguments = f"-PackagePath {_quote(package)}"
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
    assert backups[0].name == "latest.previous-20260918-090000.json"
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


def test_same_second_collision_stops_without_overwriting_backup_or_latest(tmp_path: Path):
    package = _package(tmp_path)
    latest = package.parent / "latest.json"
    original = b'{"version":"original"}'
    latest.write_bytes(original)
    first = _run(package)
    assert first.returncode == 0, first.stderr
    after_first = latest.read_bytes()
    second = _run(package)
    assert second.returncode != 0
    backups = list((package.parent / "latest-backups").glob("latest.previous-*.json"))
    assert len(backups) == 1
    assert backups[0].read_bytes() == original
    assert latest.read_bytes() == after_first
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

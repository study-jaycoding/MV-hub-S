from __future__ import annotations

import json
import os
from pathlib import Path
import subprocess

import pytest
from fastapi import HTTPException
from starlette.requests import Request

from app.routers import release_update as release_update_router
from app.services import release_update, request_guards


def _release_root(tmp_path: Path, *, version: str = "1.0.0") -> tuple[Path, Path]:
    root = tmp_path / "installed"
    source = tmp_path / "releases"
    root.mkdir()
    source.mkdir()
    (root / "VERSION.txt").write_text(version, encoding="utf-8")
    (root / "INSTALL_SOURCE.txt").write_text(str(source), encoding="utf-8")
    (root / "update_release.bat").write_text("@echo off\r\necho updater\r\n", encoding="utf-8")
    (root / "MV_agent.bat").write_text("@echo off\r\n", encoding="utf-8")
    return root, source


def _latest(source: Path, *, version: str = "1.1.0", filename: str = "MVHub-1.1.0.zip") -> None:
    (source / "latest.json").write_text(
        json.dumps(
            {
                "version": version,
                "file": filename,
                "sha256": "a" * 64,
                "higgsfield_cli_version": "1.2.3",
            }
        ),
        encoding="utf-8",
    )


@pytest.fixture(autouse=True)
def isolated_update_state(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setattr(release_update, "UPDATE_STATE_BASE", tmp_path / "state")
    monkeypatch.setattr(release_update, "AUTH_ENABLED", False)


def test_refresh_reports_available_and_same_version(tmp_path: Path):
    root, source = _release_root(tmp_path)
    _latest(source)

    available = release_update.get_status(refresh=True, root=root)
    assert available["state"] == "available"
    assert available["current_version"] == "1.0.0"
    assert available["latest_version"] == "1.1.0"
    assert available["can_update"] is True

    _latest(source, version="1.0.0", filename="MVHub-1.0.0.zip")
    current = release_update.get_status(refresh=True, root=root)
    assert current["state"] == "up_to_date"
    assert current["can_update"] is False


def test_refresh_rejects_unsafe_release_filename(tmp_path: Path):
    root, source = _release_root(tmp_path)
    _latest(source, filename="..\\outside.zip")

    status = release_update.get_status(refresh=True, root=root)
    assert status["state"] == "check_failed"
    assert "안전하지" in status["message"]
    assert status["can_update"] is False


def test_start_update_uses_detached_temp_bootstrap(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    root, source = _release_root(tmp_path)
    _latest(source)
    launched: dict[str, object] = {}
    monkeypatch.setenv("MVHUB_SESSION_GUARDED", "1")

    def fake_launch(script: Path, env: dict[str, str], log_path: Path) -> int:
        launched.update(script=script, env=env, log_path=log_path)
        assert script.parent == Path(release_update.tempfile.gettempdir())
        assert script.read_text(encoding="utf-8") == (root / "update_release.bat").read_text(encoding="utf-8")
        return 4321

    monkeypatch.setattr(release_update, "_launch_bootstrap", fake_launch)
    result = release_update.start_update(
        activity_check=lambda: 0,
        ready_url="http://127.0.0.1:8123/api/ready",
        root=root,
    )

    assert result["accepted"] is True
    assert result["state"] == "starting"
    env = launched["env"]
    assert isinstance(env, dict)
    assert env["MVHUB_UPDATE_TARGET_DIR"] == str(root)
    assert env["MVHUB_UPDATE_RESTART"] == "1"
    assert env["MVHUB_UPDATE_READY_URL"] == "http://127.0.0.1:8123/api/ready"
    assert "MVHUB_SESSION_GUARDED" not in env


def test_start_update_blocks_active_generation(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    root, source = _release_root(tmp_path)
    _latest(source)
    monkeypatch.setattr(
        release_update,
        "_launch_bootstrap",
        lambda *_args, **_kwargs: pytest.fail("busy update must not launch"),
    )

    with pytest.raises(release_update.ReleaseUpdateBusyError):
        release_update.start_update(activity_check=lambda: 1, root=root)


def test_update_route_is_limited_to_the_worker_machine(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setattr(request_guards, "local_machine_hosts", lambda: frozenset({"127.0.0.1"}))
    local = Request({"type": "http", "method": "GET", "path": "/", "headers": [], "client": ("127.0.0.1", 5000)})
    remote = Request({"type": "http", "method": "GET", "path": "/", "headers": [], "client": ("192.168.10.44", 5000)})

    release_update_router._require_local(local)
    with pytest.raises(HTTPException) as exc:
        release_update_router._require_local(remote)
    assert exc.value.status_code == 403


def test_shared_server_never_becomes_a_worker_release_updater(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    root, source = _release_root(tmp_path)
    _latest(source)
    monkeypatch.setattr(release_update, "AUTH_ENABLED", True)

    status = release_update.get_status(refresh=True, root=root)
    assert status["install_mode"] == "server"
    assert status["state"] == "unavailable"
    assert status["can_update"] is False


def test_update_scripts_keep_normal_process_cleanup_and_allow_only_explicit_breakaway():
    project_root = Path(__file__).resolve().parents[2]
    updater = (project_root / "update_release.bat").read_text(encoding="utf-8")
    launcher = (project_root / "run_agent_session.py").read_text(encoding="utf-8")
    builder = (project_root / "release" / "make_release.ps1").read_text(encoding="utf-8")

    assert "MVHUB_UPDATE_TARGET_DIR" in updater
    assert "Restart-MvHubAndWaitReady" in updater
    assert "unsafe release filename" in updater
    assert "taskkill /T" not in updater
    assert "CREATE_BREAKAWAY_FROM_JOB" in launcher
    assert "JOB_OBJECT_LIMIT_BREAKAWAY_OK" in launcher
    assert "backend/app/routers/release_update.py" in builder
    assert "backend/app/services/release_update.py" in builder


@pytest.mark.skipif(os.name != "nt", reason="Windows batch bootstrap regression")
def test_manual_updater_survives_its_installed_batch_being_overwritten(tmp_path: Path):
    """The installed wrapper must finish from TEMP after the target copy is replaced."""
    project_root = Path(__file__).resolve().parents[2]
    installed = tmp_path / "installed"
    temp_dir = tmp_path / "temp"
    installed.mkdir()
    temp_dir.mkdir()
    marker = "### MVHUB_UPDATE_POWERSHELL ###"
    wrapper = (project_root / "update_release.bat").read_text(encoding="utf-8").split(marker, 1)[0]
    overwrite_payload = """param(
    [string]$TargetDir,
    [string]$StateFile = "",
    [string]$RestartAfterInstall = "0",
    [string]$ReadyUrl = ""
)
Set-Content -LiteralPath (Join-Path $TargetDir "update_release.bat") -Value "@echo off" -Encoding ASCII
Write-Host "[3/3] Update complete."
"""
    (installed / "update_release.bat").write_text(
        wrapper + marker + "\n" + overwrite_payload,
        encoding="ascii",
    )

    env = os.environ.copy()
    env["TEMP"] = str(temp_dir)
    env["TMP"] = str(temp_dir)
    env["MVHUB_NO_PAUSE"] = "1"
    env.pop("MVHUB_UPDATE_TARGET_DIR", None)
    completed = subprocess.run(
        ["cmd.exe", "/d", "/c", str(installed / "update_release.bat")],
        cwd=installed,
        env=env,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=15,
        check=False,
    )

    output = completed.stdout + completed.stderr
    assert completed.returncode == 0, output
    assert "[done] Update check finished" in output
    assert "not recognized" not in output
    assert "Failed to prepare MV Hub updater" not in output
    assert not list(temp_dir.glob("mvhub-update-bootstrap-*.bat"))

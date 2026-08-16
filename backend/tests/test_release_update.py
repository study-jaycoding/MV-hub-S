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
    (root / "run_release_update.ps1").write_text("exit 0\n", encoding="utf-8")
    (root / "update_release_worker.bat").write_text("@exit /b 0\r\n", encoding="utf-8")
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
    monkeypatch.setattr(release_update, "_installation_health", lambda *_args, **_kwargs: (True, ""))


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


def test_same_version_damage_is_offered_as_repair(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    root, source = _release_root(tmp_path, version="1.1.0")
    _latest(source, version="1.1.0")
    monkeypatch.setattr(
        release_update,
        "_installation_health",
        lambda *_args, **_kwargs: (False, "Python DLL 혼합 감지"),
    )

    status = release_update.get_status(refresh=True, root=root)

    assert status["state"] == "available"
    assert status["can_update"] is True
    assert status["repair_required"] is True
    assert "복구" in status["message"]


def test_cached_up_to_date_state_is_rechecked_for_damage(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    root, _source = _release_root(tmp_path, version="1.1.0")
    release_update.write_state(
        "up_to_date",
        "최신 버전입니다.",
        root=root,
        current_version="1.1.0",
        latest_version="1.1.0",
    )
    monkeypatch.setattr(
        release_update,
        "_installation_health",
        lambda *_args, **_kwargs: (False, "필수 파일 누락"),
    )

    status = release_update.get_status(refresh=False, root=root)

    assert status["state"] == "available"
    assert status["repair_required"] is True


def test_release_mode_survives_missing_version_or_launcher(tmp_path: Path):
    root, _source = _release_root(tmp_path)
    (root / "VERSION.txt").unlink()
    (root / "MV_agent.bat").unlink()

    assert release_update.install_mode(root) == "release"


def test_start_update_uses_installed_safe_launcher(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    root, source = _release_root(tmp_path)
    _latest(source)
    launched: dict[str, object] = {}
    monkeypatch.setenv("MVHUB_SESSION_GUARDED", "1")

    def fake_launch(script: Path, env: dict[str, str], log_path: Path) -> int:
        launched.update(script=script, env=env, log_path=log_path)
        assert script == root / "update_release.bat"
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


def test_start_update_reinstalls_same_version_when_health_check_fails(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    root, source = _release_root(tmp_path, version="1.1.0")
    _latest(source, version="1.1.0")
    monkeypatch.setattr(
        release_update,
        "_installation_health",
        lambda *_args, **_kwargs: (False, "runtime damaged"),
    )
    monkeypatch.setattr(release_update, "_launch_bootstrap", lambda *_args, **_kwargs: 9876)

    result = release_update.start_update(activity_check=lambda: 0, root=root)

    assert result["accepted"] is True
    assert result["state"] == "starting"


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
    update_launcher = (project_root / "update_release.bat").read_text(encoding="utf-8")
    update_runner = (project_root / "run_release_update.ps1").read_text(encoding="utf-8")
    updater = (project_root / "update_release_worker.bat").read_text(encoding="utf-8")
    launcher = (project_root / "run_agent_session.py").read_text(encoding="utf-8")
    builder = (project_root / "release" / "make_release.ps1").read_text(encoding="utf-8")

    assert "MVHUB_UPDATE_TARGET_DIR" in updater
    assert len(update_launcher.splitlines()) == 1
    assert "run_release_update.ps1" in update_launcher
    assert "Copy-Item -LiteralPath $Worker -Destination $TempWorker" in update_runner
    assert "mvhub-release-update-" in update_runner
    assert "Restart-MvHubAndWaitReady" in updater
    assert "unsafe release filename" in updater
    assert "Assert-PythonRuntime" in updater
    assert "expected 64-bit runtime" in updater
    assert "release runtime must be Python 3.14 x64" in updater
    assert '$_.Name -ne "VERSION.txt"' in updater
    assert "VERSION is the transaction commit marker" in updater
    assert "Replace-ImmutableDirectory" in updater
    assert '$_.Name -ne "app" -and $_.Name -ne "data"' in updater
    assert '-TargetDir (Join-Path $TargetDir "backend\\app")' in updater
    assert '-TargetDir (Join-Path $TargetDir "frontend\\dist")' in updater
    assert "UseShellExecute = $true" in updater
    assert 'MVHUB_NO_BROWSER = "1"' not in updater
    assert "taskkill /T" not in updater
    assert "Get-MvHubProcessIds" in updater
    assert "Get-CimInstance Win32_Process" in updater
    assert 'Join-Path $ResolvedRoot "MV_agent.bat"' in updater
    assert "CREATE_BREAKAWAY_FROM_JOB" in launcher
    assert "JOB_OBJECT_LIMIT_BREAKAWAY_OK" in launcher
    assert "backend/app/routers/release_update.py" in builder
    assert "backend/app/services/release_update.py" in builder
    assert '"run_release_update.ps1"' in builder
    assert '"update_release_worker.bat"' in builder
    assert "Assert-PythonRuntimeTree" in builder
    assert "expected 64-bit runtime" in builder


def test_release_update_contract_preserves_worker_backup_state_and_outbox():
    project_root = Path(__file__).resolve().parents[2]
    updater = (project_root / "update_release_worker.bat").read_text(encoding="utf-8")
    builder = (project_root / "release" / "make_release.ps1").read_text(encoding="utf-8")

    # 상태 DB와 staging은 backend/data 아래에 있으므로 이 폴더는 패키징·교체 양쪽에서 제외해야 한다.
    assert '"data"' not in builder[builder.index("$BackendFiles = @(") : builder.index(")", builder.index("$BackendFiles = @("))]
    assert '$_.Name -ne "app" -and $_.Name -ne "data"' in updater
    assert '-TargetDir (Join-Path $TargetDir "backend\\data")' not in updater
    assert "worker_backup_state.db" not in builder
    assert "worker-backup-outbox" not in builder


def test_release_builder_requires_verified_python_314_without_an_unproven_resolve_range():
    project_root = Path(__file__).resolve().parents[2]
    builder = (project_root / "release" / "make_release.ps1").read_text(encoding="utf-8")

    assert '-3.14 -c "import sys; print(sys.executable)"' in builder
    assert "Assert-SupportedPython" in builder
    assert "Python 3.14 x64 is required" in builder
    assert "release runtime must be Python 3.14 x64" in builder
    assert "require 64-bit Python" in builder
    assert "3.10-3.12" not in builder
    assert "AllowResolveIncompatiblePython" not in builder


def test_worker_launcher_keeps_startup_failure_visible():
    project_root = Path(__file__).resolve().parents[2]
    launcher = (project_root / "MV_agent.bat").read_text(encoding="utf-8")

    assert 'set "SESSION_EXIT=%ERRORLEVEL%"' in launcher
    assert "Run update_release.bat to verify and repair this installation." in launcher
    assert 'if not "%MVHUB_NO_PAUSE%"=="1" pause' in launcher


@pytest.mark.skipif(os.name != "nt", reason="Windows process cleanup regression")
def test_release_update_cleanup_closes_the_old_visible_launcher(tmp_path: Path):
    project_root = Path(__file__).resolve().parents[2]
    updater = (project_root / "update_release_worker.bat").read_text(encoding="utf-8")
    function_start = updater.index("function Get-MvHubProcessIds")
    function_end = updater.index("function Install-Package", function_start)
    cleanup_functions = updater[function_start:function_end]

    install_root = tmp_path / "MV Hub installed"
    install_root.mkdir()
    launcher = install_root / "MV_agent.bat"
    launcher.write_text("@echo off\r\n:wait\r\ngoto wait\r\n", encoding="ascii")
    process = subprocess.Popen(  # noqa: S603 - isolated test-owned batch process
        [os.environ.get("ComSpec", "cmd.exe"), "/d", "/c", "call", str(launcher)],
        cwd=install_root,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
    )
    harness = tmp_path / "verify_cleanup.ps1"
    harness.write_text(
        "param([string]$Root)\n$ErrorActionPreference = 'Stop'\n"
        + cleanup_functions
        + "\nStop-MvHubProcesses -Root $Root\n",
        encoding="utf-8-sig",
    )
    try:
        completed = subprocess.run(
            [
                "powershell.exe",
                "-NoProfile",
                "-ExecutionPolicy",
                "Bypass",
                "-File",
                str(harness),
                "-Root",
                str(install_root),
            ],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=15,
            check=False,
        )
        output = completed.stdout + completed.stderr
        assert completed.returncode == 0, output
        assert "Stopping running MV Hub processes" in output
        assert process.wait(timeout=3) != 0
    finally:
        if process.poll() is None:
            process.kill()
            process.wait(timeout=3)


def test_first_installer_delegates_to_the_verified_package_updater():
    project_root = Path(__file__).resolve().parents[2]
    installer = (project_root / "release" / "MVHub_Install.bat").read_text(encoding="utf-8")
    builder = (project_root / "release" / "make_release.ps1").read_text(encoding="utf-8")

    assert 'if exist "%~dp0packages\\latest.json"' in installer
    assert 'Join-Path $ExtractDir "update_release.bat"' in installer
    assert '$env:MVHUB_UPDATE_TARGET_DIR = $TargetDir' in installer
    assert "latest.json contains an unsafe release filename" in installer
    assert 'Copy-Item -LiteralPath $InstallerPath -Destination $PublishTarget -Force' in builder
    assert builder.index(
        'Copy-Item -LiteralPath $InstallerPath -Destination $PublishTarget -Force'
    ) < builder.index('Copy-Item -LiteralPath $LatestPath -Destination $PublishTarget -Force')


@pytest.mark.skipif(os.name != "nt", reason="Windows batch bootstrap regression")
def test_manual_updater_survives_its_installed_batch_being_overwritten(tmp_path: Path):
    """The installed launcher and runner may both be replaced while TEMP keeps running."""
    project_root = Path(__file__).resolve().parents[2]
    installed = tmp_path / "installed"
    temp_dir = tmp_path / "temp"
    installed.mkdir()
    temp_dir.mkdir()
    (installed / "update_release.bat").write_text(
        (project_root / "update_release.bat").read_text(encoding="utf-8"), encoding="ascii"
    )
    (installed / "run_release_update.ps1").write_text(
        (project_root / "run_release_update.ps1").read_text(encoding="utf-8"), encoding="ascii"
    )
    (installed / "update_release_worker.bat").write_text(
        """@echo off
>"%MVHUB_UPDATE_TARGET_DIR%\\update_release.bat" echo @echo off
>"%MVHUB_UPDATE_TARGET_DIR%\\run_release_update.ps1" echo exit 99
>"%MVHUB_UPDATE_TARGET_DIR%\\update_release_worker.bat" echo @exit /b 99
>"%MVHUB_UPDATE_TARGET_DIR%\\update-finished.txt" echo safe
echo [3/3] Update complete.
exit /b 0
""",
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
    assert "[3/3] Update complete." in output
    assert (installed / "update-finished.txt").read_text(encoding="ascii").strip() == "safe"
    assert "not recognized" not in output
    assert "Failed to prepare MV Hub updater" not in output
    assert not list(temp_dir.glob("mvhub-release-update-*.bat"))


@pytest.mark.skipif(os.name != "nt", reason="Windows batch bootstrap regression")
def test_manual_updater_propagates_isolated_worker_failure(tmp_path: Path):
    """A real worker failure must remain visible to callers and automation."""
    project_root = Path(__file__).resolve().parents[2]
    installed = tmp_path / "installed"
    temp_dir = tmp_path / "temp"
    installed.mkdir()
    temp_dir.mkdir()
    (installed / "update_release.bat").write_text(
        (project_root / "update_release.bat").read_text(encoding="utf-8"), encoding="ascii"
    )
    (installed / "run_release_update.ps1").write_text(
        (project_root / "run_release_update.ps1").read_text(encoding="utf-8"), encoding="ascii"
    )
    (installed / "update_release_worker.bat").write_text(
        "@echo off\r\necho worker failed\r\nexit /b 23\r\n",
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

    assert completed.returncode == 23
    assert "worker failed" in completed.stdout
    assert not list(temp_dir.glob("mvhub-release-update-*.bat"))

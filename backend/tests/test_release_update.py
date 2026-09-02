from __future__ import annotations

import asyncio
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


def test_latest_metadata_exposes_only_safe_release_fields(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setattr(release_update_router, "_require_local", lambda _request: None)
    monkeypatch.setattr(release_update_router, "install_mode", lambda _root: "release")
    monkeypatch.setattr(
        release_update_router,
        "fetch_latest",
        lambda _root: {
            "version": "1.2.3",
            "file": "MVHub-1.2.3.zip",
            "sha256": "a" * 64,
            "size": 1234,
            "created_at": "2026-08-24T00:00:00+00:00",
            "source": Path(r"Z:\private\release"),
        },
    )

    result = asyncio.run(release_update_router.release_update_latest_metadata(object()))

    assert result == {
        "version": "1.2.3",
        "file": "MVHub-1.2.3.zip",
        "sha256": "a" * 64,
        "size": 1234,
        "created_at": "2026-08-24T00:00:00+00:00",
    }
    assert "source" not in result


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


def test_start_route_force_skips_activity_check(monkeypatch: pytest.MonkeyPatch):
    """force=True 는 오류 잔여 카드 등으로 active 카운트가 남아 있어도 activity_check 를
    0 으로 바꿔 시작한다(폴더의 update_release.bat 직접 실행과 동일한 우회).
    기본(force 없음)은 여전히 실제 활동 카운트를 본다."""
    monkeypatch.setattr(release_update_router, "_require_local", lambda _request: None)
    monkeypatch.setattr(
        release_update_router,
        "_activity",
        lambda: {"generation_active": 3, "comfy_active": 0, "resolve_active": 0, "active_total": 3},
    )
    captured: dict[str, object] = {}

    def fake_start_update(*, activity_check, ready_url=None):
        captured["blocked"] = activity_check() > 0
        return {"state": "starting", "can_update": False}

    monkeypatch.setattr(release_update_router, "start_update", fake_start_update)
    request = Request(
        {"type": "http", "method": "POST", "path": "/", "headers": [], "client": ("127.0.0.1", 5000)}
    )

    result = asyncio.run(
        release_update_router.release_update_start(
            release_update_router.UpdateStartIn(confirm=True, force=True),
            request,
            x_mvhub_update="1",
        )
    )
    assert captured["blocked"] is False  # 강제 — active 3건이어도 게이트 통과
    assert result["active_total"] == 3  # 응답에는 실제 카운트가 그대로 남는다

    asyncio.run(
        release_update_router.release_update_start(
            release_update_router.UpdateStartIn(confirm=True),
            request,
            x_mvhub_update="1",
        )
    )
    assert captured["blocked"] is True  # 일반 경로는 여전히 활동 카운트를 본다


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


def test_update_activity_counts_inflight_direct_resolve_transfers(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setattr(
        release_update_router,
        "generation_queue_snapshot",
        lambda: {"active_total": 0},
    )
    monkeypatch.setattr(release_update_router.comfy, "active_run_job_count", lambda: 0)
    monkeypatch.setattr(release_update_router, "active_transfer_count", lambda: 1)

    activity = release_update_router._activity()
    guarded = release_update_router._with_activity({"can_update": True})

    assert activity == {
        "generation_active": 0,
        "comfy_active": 0,
        "resolve_active": 1,
        "active_total": 1,
    }
    assert guarded["can_update"] is False


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
    assert "-Command" in update_launcher
    assert "& $env:MVHUB_UPDATE_RUNNER -Root $env:MVHUB_UPDATE_ROOT" in update_launcher
    assert "[Environment]::Exit($ExitCode)" in update_runner
    assert "Copy-Item -LiteralPath $Worker -Destination $TempWorker" in update_runner
    assert "mvhub-release-update-" in update_runner
    assert "Restart-MvHubAndWaitReady" in updater
    assert "unsafe release filename" in updater
    assert "Assert-PythonRuntime" in updater
    assert "expected 64-bit runtime" in updater
    assert "release runtime must be Python 3.14 x64" in updater
    assert '$_.Name -ne "VERSION.txt"' in updater
    assert "VERSION is the transaction commit marker" in updater
    assert "Move-PathWithRetry" in updater
    assert "Get-UpdateComponents" in updater
    assert "Invoke-ComponentSwap" in updater
    assert "Undo-ComponentSwaps" in updater
    assert '$_.Name -ne "app" -and $_.Name -ne "data"' in updater
    assert "UseShellExecute = $true" in updater
    assert 'MVHUB_NO_BROWSER = "1"' not in updater
    assert "taskkill /T" not in updater
    assert "Get-MvHubProcessIds" in updater
    assert "Get-CimInstance Win32_Process" in updater
    assert "Assert-NoActiveResolveImport -Root $TargetDir" in updater
    assert "app.services.resolve_import_worker" in updater
    assert 'Join-Path $ResolvedRoot "MV_agent.bat"' in updater
    assert "CREATE_BREAKAWAY_FROM_JOB" in launcher
    assert "JOB_OBJECT_LIMIT_BREAKAWAY_OK" in launcher
    assert "backend/app/routers/release_update.py" in builder
    assert "backend/app/services/release_update.py" in builder
    assert '"run_release_update.ps1"' in builder
    assert '"update_release_worker.bat"' in builder
    assert "Assert-PythonRuntimeTree" in builder
    assert "expected 64-bit runtime" in builder


def test_predeploy_gate_defaults_to_a_repeatable_low_spec_server_profile():
    project_root = Path(__file__).resolve().parents[2]
    gate = (project_root / "tools" / "predeploy_gate.ps1").read_text(encoding="utf-8")

    assert '[int]$LoadServerCpuCores = 2' in gate
    assert '[string]$LoadServerPriority = "below-normal"' in gate
    assert '[double]$LoadMaxRssMb = 512.0' in gate
    assert "--server-cpu-cores $LoadServerCpuCores" in gate
    assert "--server-priority $LoadServerPriority" in gate
    assert "--max-rss-mb $LoadMaxRssMb" in gate
    assert "load_server_cpu_cores" in gate
    assert "load_server_priority" in gate
    assert "LoadResult.server_limits.requested_cpu_cores" in gate
    assert "LoadResult.server_limits.priority" in gate
    assert "load_server_cpu_affinity" in gate
    assert "LoadResult.acceptance.checks.rss_within_target" in gate
    assert "load_max_rss_bytes_observed" in gate


def test_https_soak_runner_enforces_the_documented_low_spec_profile():
    project_root = Path(__file__).resolve().parents[2]
    soak = (project_root / "tools" / "run_https_soak.ps1").read_text(encoding="utf-8")

    assert '[int]$ServerCpuCores = 4' in soak
    assert '[string]$ServerPriority = "below-normal"' in soak
    assert '[double]$SampleIntervalSeconds = 30' in soak
    assert '[double]$MaxRssMb = 512' in soak
    assert "--server-cpu-cores $ServerCpuCores" in soak
    assert "--server-priority $ServerPriority" in soak
    assert "--sample-interval $SampleIntervalSeconds" in soak
    assert "--max-rss-mb $MaxRssMb" in soak
    assert "--max-p95-ms $MaxP95Ms" in soak
    assert "--max-login-p95-ms $MaxLoginP95Ms" in soak
    assert "--max-memory-growth-percent $MaxMemoryGrowthPercent" in soak
    assert "server_cpu_cores = $ServerCpuCores" in soak
    assert "max_rss_mb = $MaxRssMb" in soak
    assert "$UsesManagedLocalTls" in soak
    assert "Test-TlsCertificatePair" in soak
    assert "New-LocalTlsCertificatePair" in soak
    assert "CreateSelfSigned" in soak
    assert "ExportPkcs8PrivateKeyPem" in soak


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


def test_release_builder_ignores_unrelated_build_machine_package_conflicts():
    project_root = Path(__file__).resolve().parents[2]
    builder = (project_root / "release" / "make_release.ps1").read_text(encoding="utf-8")

    # Runtime site-packages is created empty and verified after install. Conflicts from unrelated
    # packages installed on the builder must not look like a failed release in the operator log.
    assert 'Join-Path $Python.Root "Lib\\site-packages"' in builder
    assert "--ignore-installed --no-warn-conflicts --target $SitePackages" in builder


def test_release_tooling_hashes_without_powershell_module_autoloading():
    project_root = Path(__file__).resolve().parents[2]
    scripts = {
        "installer": (project_root / "release" / "MVHub_Install.bat").read_text(encoding="utf-8"),
        "updater": (project_root / "update_release_worker.bat").read_text(encoding="utf-8"),
        "builder": (project_root / "release" / "make_release.ps1").read_text(encoding="utf-8"),
        "selector": (project_root / "release" / "select_release.ps1").read_text(encoding="utf-8"),
    }

    # Get-FileHash depends on Microsoft.PowerShell.Utility auto-loading. Some managed
    # Windows PCs disable it, so every release path must use the .NET hash primitive.
    for name, script in scripts.items():
        assert "Get-FileHash" not in script, name
        assert "System.Security.Cryptography.SHA256" in script, name
    assert "System.Security.Cryptography.MD5" in scripts["builder"]
    assert "$env:MVHUB_INSTALL_SCRIPT" in scripts["installer"]
    assert "$env:MVHUB_UPDATE_SCRIPT" in scripts["updater"]


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


@pytest.mark.skipif(os.name != "nt", reason="Windows temporary-folder fallback regression")
def test_manual_updater_uses_local_app_data_when_temp_variables_are_empty(tmp_path: Path):
    project_root = Path(__file__).resolve().parents[2]
    installed = tmp_path / "설치 폴더 with spaces"
    local_app_data = tmp_path / "로컬 앱 데이터"
    installed.mkdir()
    (installed / "update_release.bat").write_text(
        (project_root / "update_release.bat").read_text(encoding="utf-8"), encoding="ascii"
    )
    (installed / "run_release_update.ps1").write_text(
        (project_root / "run_release_update.ps1").read_text(encoding="utf-8"), encoding="utf-8-sig"
    )
    (installed / "update_release_worker.bat").write_text(
        '@echo off\r\n>"%MVHUB_UPDATE_TARGET_DIR%\\fallback-finished.txt" echo safe\r\nexit /b 0\r\n',
        encoding="ascii",
    )

    env = os.environ.copy()
    env["TEMP"] = ""
    env["TMP"] = ""
    env["LOCALAPPDATA"] = str(local_app_data)
    env["MVHUB_NO_PAUSE"] = "1"
    env.pop("MVHUB_UPDATE_TARGET_DIR", None)
    # ★런처는 전체 경로로 부른다. 이름만 주면 cmd 가 '현재 폴더'에서 찾아야 하는데,
    # NoDefaultCurrentDirectoryInExePath=1 인 셸(보안 설정·일부 CI/도구 셸)에서는 그 탐색이
    # 꺼져 있어 이 테스트만 "not recognized" 로 실패했다 — 검증 대상(TEMP 비었을 때의 임시
    # 폴더 폴백)과 무관한 오탐이다. 실제 업데이트 경로도 %~dp0/전체 경로만 쓰므로(형제
    # 테스트들과 동일) 전체 경로 호출이 운영 동작에 더 가깝다. cwd 는 그대로 둔다.
    completed = subprocess.run(
        ["cmd.exe", "/d", "/c", "call", str(installed / "update_release.bat")],
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
    assert (installed / "fallback-finished.txt").read_text(encoding="ascii").strip() == "safe"
    fallback_temp = local_app_data / "Temp"
    assert fallback_temp.is_dir()
    assert not list(fallback_temp.glob("mvhub-release-update-*.bat"))


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


def _worker_payload() -> str:
    """update_release_worker.bat 의 PowerShell payload 부분(마커 아래)만 반환."""
    project_root = Path(__file__).resolve().parents[2]
    raw = (project_root / "update_release_worker.bat").read_text(encoding="utf-8")
    marker = "### MVHUB_" + "UPDATE_POWERSHELL ###"
    parts = raw.split(marker)
    assert len(parts) >= 2, "worker payload marker missing"
    return parts[-1]


def test_updater_transaction_stages_before_stopping_and_rolls_back_everything():
    """2026-09-02 실측 실패(백신 잠금 1회로 업데이트 전체 사망 + 혼합 트리) 재발 방지 계약."""
    payload = _worker_payload()

    # 재시도는 잠금 계열 Win32 코드(5/32/33)만 — 경로 없음·목적지 존재는 즉시 실패해야 한다.
    assert "$script:RetryableMoveCodes = @(5, 32, 33)" in payload
    # 모든 rename 은 재시도 헬퍼(Directory/File.Move)를 지나야 한다 — raw Rename-Item 금지.
    assert "Rename-Item" not in payload
    assert "[System.IO.Directory]::Move" in payload

    install_body = payload[payload.index("function Install-Package") :]
    # 스테이징(복사)은 앱이 살아 있는 동안 — 다운타임은 rename+검증으로 줄인다.
    assert install_body.index("New-StagedComponents -ExtractDir") < install_body.index(
        "Stop-MvHubProcesses -Root"
    )
    # 커밋 마커(VERSION)는 설치 검증이 전부 통과한 뒤에만 쓴다.
    assert install_body.index('Assert-BundledCli -Root $TargetDir') < install_body.index(
        "Commit-VersionMarker"
    )
    # 실패 시 완료된 스왑 전부 롤백, 롤백 미완이면 recovery_required 로 승급(백업 보존).
    assert "Undo-ComponentSwaps -Components" in install_body
    assert '"recovery_required"' in install_body

    # 루트·backend 메타 파일도 같은 스왑 트랜잭션을 지난다(Copy-Item -Force 직덮어쓰기 금지).
    assert "root/backend metadata" in payload
    assert '$_.Name -ne "VERSION.txt"' in payload
    assert '$_.Name -ne "app" -and $_.Name -ne "data"' in payload


def test_updater_restarts_the_app_after_failure_without_touching_state():
    payload = _worker_payload()

    fail_fn = payload[
        payload.index("function Start-MvHubAfterFailure") : payload.index("$SourceFile = Join-Path")
    ]
    # 실패 재기동은 상태를 절대 쓰지 않는다 — failed 기록이 화면에 남아야 한다(코덱스 검토).
    assert "Write-UpdateState" not in fail_fn
    # 이미 살아 있는 허브(new_committed 의 readiness 초과)에 launcher 를 겹치지 않는다.
    assert "Get-MvHubProcessIds" in fail_fn

    main_catch = payload[payload.index("$InstallFailure = $_") :]
    # 상태 기록은 best-effort — 기록 실패가 재기동을 막으면 앱이 죽은 채 남는다(코덱스 BLOCK).
    assert "could not record the failed state" in main_catch
    assert main_catch.index("could not record the failed state") < main_catch.index(
        "Start-MvHubAfterFailure"
    )
    assert "throw $InstallFailure" in main_catch
    # 반쯤 스왑된 트리(recovery_required)는 부팅 금지 — 원상 복원·신버전 커밋 시만 재기동.
    assert (
        '$script:RecoveryState -eq "rolled_back" -or $script:RecoveryState -eq "new_committed"'
        in main_catch
    )


def test_updater_quarantines_leftovers_without_guessing_and_before_version_checks():
    """다중 컴포넌트 크래시에서 파일 존재만으로 방향 판별은 불가(코덱스 리뷰) —
    잔재는 추측·삭제 없이 격리 보존하고, 새 전체 설치가 트리를 확정한다."""
    payload = _worker_payload()

    quarantine_fn = payload[
        payload.index("function Move-LeftoversToQuarantine") : payload.index("function New-StagedComponents")
    ]
    # 백업(.previous/.rollback)은 삭제하지 않고 격리 폴더로 보존 이동한다.
    assert "preserving leftover backup in quarantine" in quarantine_fn
    assert "update-quarantine." in quarantine_fn
    # 삭제되는 것은 일회용 스테이징 사본(.next)뿐이다.
    assert "removing stale staging copy" in quarantine_fn
    # 토큰 형식(8자리 hex)이 맞는 우리 잔재만 다룬다 — 사용자 폴더 오폭 방지.
    assert "[0-9a-f]{8}" in quarantine_fn

    # 잔재 처리는 동버전 조기 반환(NeedsInstall 판정)보다 앞 — 동버전 recovery 진입점.
    main_body = payload[payload.index("[1/3] Checking MV Hub release server") :]
    assert main_body.index("Move-LeftoversToQuarantine") < main_body.index("$NeedsInstall = ")
    # 복구 자산이 있던 트리는 얕은 검증으로 up_to_date 확정 불가 — 무조건 전체 재설치.
    assert "-or $script:HadRecoveryAssets" in main_body

    # 복구 재설치가 또 실패하면: 격리 백업 보존(-IncludeQuarantine 은 성공 확정 후만),
    # 롤백이 됐어도 그 트리는 신뢰 불가라 recovery_required 로 부팅 금지(코덱스 리뷰).
    install_body = payload[payload.index("function Install-Package") :]
    assert "Recovery reinstall failed" in install_body
    cleanup_calls = [
        line.strip() for line in payload.splitlines() if "Remove-SwapLeftovers -Components" in line
    ]
    assert "Remove-SwapLeftovers -Components $script:InstalledComponents -IncludeQuarantine" in cleanup_calls
    assert "Remove-SwapLeftovers -Components $Components" in cleanup_calls  # 실패 경로: 격리 미포함

    swap_fn = payload[
        payload.index("function Invoke-ComponentSwap") : payload.index("function Undo-ComponentSwaps")
    ]
    # journal 최초 기록은 필수(-Required) — 첫 rename 전에 기록 불가면 트리 무변경 중단.
    assert "Write-UpdateJournal $Components -Required" in swap_fn
    # intent journal 이 정확하도록 HadPrevious 는 첫 rename 전에 전량 계산한다.
    assert swap_fn.index("$Component.HadPrevious = [bool]") < swap_fn.index("-Required")

    # 성공 확정 후에만 격리 백업을 정리한다.
    cleanup_fn = payload[
        payload.index("function Remove-SwapLeftovers") : payload.index("function Commit-VersionMarker")
    ]
    assert "update-quarantine.*" in cleanup_fn

    # INSTALL_SOURCE.txt 는 트랜잭션 밖 비원자 쓰기라 워커에서 다시 쓰지 않는다(코덱스 BLOCK).
    assert 'Set-Content -LiteralPath (Join-Path $TargetDir "INSTALL_SOURCE.txt")' not in payload

    # 설치 락은 공유 위반(32/33)만 "이미 실행 중"으로 판정 — ACL·디스크 오류는 일반 실패.
    assert "$Win32Code -eq 32 -or $Win32Code -eq 33" in payload


def test_updater_cleans_backups_only_after_the_new_version_is_confirmed():
    payload = _worker_payload()
    main_body = payload[payload.index("if ($NeedsInstall) {") :]
    # 자동 재시작 경로에선 readiness 확인 후에만 .previous 백업을 지운다.
    assert main_body.index("Restart-MvHubAndWaitReady") < main_body.index(
        "Remove-SwapLeftovers -Components $script:InstalledComponents"
    )


def test_updater_duplicate_run_exits_17_and_wrapper_preserves_live_state():
    project_root = Path(__file__).resolve().parents[2]
    raw = (project_root / "update_release_worker.bat").read_text(encoding="utf-8")
    payload = _worker_payload()
    # 설치 폴더 배타 잠금 — 수동 bat 이중 실행이 진행 중 업데이트를 방해하지 못한다.
    assert "[Environment]::Exit(17)" in payload
    bat_part = raw.split("### MVHUB_" + "UPDATE_POWERSHELL ###")[0]
    assert 'if "%UPDATE_EXIT%"=="17"' in bat_part
    # 17 분기는 generic failed 기록 분기보다 앞 — 살아 있는 업데이터의 상태를 덮지 않는다.
    assert bat_part.index('=="17"') < bat_part.index("Update script failed (exit")


def test_failed_state_survives_background_refresh_until_resolved(tmp_path: Path):
    """알림센터의 60초 refresh=true 가 실패 기록을 available 로 덮던 구멍(코덱스 검토)."""
    root, source = _release_root(tmp_path)
    _latest(source)

    release_update.write_state(
        "failed", "Update failed: swap died", root=root, latest_version="1.1.0"
    )
    path = release_update.state_path(root)
    value = json.loads(path.read_text("utf-8"))
    value["recovery"] = "rolled_back"  # 워커가 남기는 필드를 흉내낸다
    path.write_text(json.dumps(value), encoding="utf-8")

    status = release_update.get_status(refresh=True, root=root)
    assert status["state"] == "failed"
    assert status["recovery"] == "rolled_back"
    assert status["can_update"] is True  # 재시도는 가능해야 한다
    assert status["latest_version"] == "1.1.0"

    stored = release_update.get_status(refresh=False, root=root)
    assert stored["state"] == "failed"
    assert stored["can_update"] is True


def test_failed_state_blocks_retry_when_manual_recovery_is_required(tmp_path: Path):
    root, source = _release_root(tmp_path)
    _latest(source)
    release_update.write_state(
        "failed", "Update failed: rollback incomplete", root=root, latest_version="1.1.0"
    )
    path = release_update.state_path(root)
    value = json.loads(path.read_text("utf-8"))
    value["recovery"] = "recovery_required"
    path.write_text(json.dumps(value), encoding="utf-8")

    status = release_update.get_status(refresh=True, root=root)
    assert status["state"] == "failed"
    assert status["can_update"] is False


def test_recovery_required_survives_even_when_versions_match(tmp_path: Path):
    """동버전 repair 실패(코덱스 리뷰): current==latest 라도 반쯤 스왑된 트리는
    up_to_date/available 로 둔갑하면 안 된다."""
    root, source = _release_root(tmp_path, version="1.1.0")
    _latest(source)  # latest == current == 1.1.0
    release_update.write_state(
        "failed", "Update failed: rollback incomplete", root=root, latest_version="1.1.0"
    )
    path = release_update.state_path(root)
    value = json.loads(path.read_text("utf-8"))
    value["recovery"] = "recovery_required"
    path.write_text(json.dumps(value), encoding="utf-8")

    for refresh in (True, False):
        status = release_update.get_status(refresh=refresh, root=root)
        assert status["state"] == "failed", refresh
        assert status["recovery"] == "recovery_required"
        assert status["can_update"] is False


def test_start_update_runs_the_worker_for_same_version_recovery(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    """recovery_required 는 동버전+health 통과여도 워커를 실행해야 실제 복구 진입점이 생긴다
    (코덱스 리뷰: up_to_date 조기 반환이 복구 경로를 막던 구멍)."""
    root, source = _release_root(tmp_path, version="1.1.0")
    _latest(source)  # latest == current == 1.1.0
    release_update.write_state(
        "failed", "Update failed: rollback incomplete", root=root, latest_version="1.1.0"
    )
    path = release_update.state_path(root)
    value = json.loads(path.read_text("utf-8"))
    value["recovery"] = "recovery_required"
    path.write_text(json.dumps(value), encoding="utf-8")

    launched: list[Path] = []
    monkeypatch.setattr(
        release_update,
        "_launch_bootstrap",
        lambda script, _env, _log: launched.append(script) or 123,
    )

    status = release_update.start_update(activity_check=lambda: 0, root=root)

    assert launched, "동버전 recovery_required 인데 워커가 실행되지 않았다"
    assert status.get("accepted") is True


def test_failed_state_resolves_once_the_new_version_is_actually_installed(tmp_path: Path):
    root, source = _release_root(tmp_path, version="1.1.0")
    _latest(source)  # latest == current → 이전 실패 기록은 낡은 것
    release_update.write_state(
        "failed",
        "Update failed: restart timed out",
        root=root,
        latest_version="1.1.0",
        current_version="1.0.0",
    )

    status = release_update.get_status(refresh=True, root=root)
    assert status["state"] == "up_to_date"


def _move_retry_harness(tmp_path: Path) -> Path:
    payload = _worker_payload()
    helper = payload[
        payload.index("$script:RetryableMoveCodes") : payload.index("function Invoke-CheckedProcess")
    ]
    harness = tmp_path / "move_retry.ps1"
    harness.write_text(
        "param([string]$Path, [string]$Destination)\n$ErrorActionPreference = 'Stop'\n"
        + helper
        + "\nMove-PathWithRetry -Path $Path -Destination $Destination -Label 'test'\n",
        encoding="utf-8-sig",
    )
    return harness


@pytest.mark.skipif(os.name != "nt", reason="Windows rename-retry regression")
def test_move_with_retry_survives_a_transient_directory_lock(tmp_path: Path):
    """열린 핸들(백신 스캔 모사)로 rename 이 잠깐 실패해도 재시도로 성공해야 한다."""
    import threading

    source_dir = tmp_path / "swap-src"
    source_dir.mkdir()
    locked_file = source_dir / "locked.bin"
    locked_file.write_bytes(b"x" * 16)
    dest_dir = tmp_path / "swap-dst"
    harness = _move_retry_harness(tmp_path)

    handle = open(locked_file, "rb")  # 열린 핸들 → 부모 폴더 rename 이 ACCESS_DENIED
    release = threading.Timer(2.0, handle.close)
    release.start()
    try:
        completed = subprocess.run(
            [
                "powershell.exe",
                "-NoProfile",
                "-ExecutionPolicy",
                "Bypass",
                "-File",
                str(harness),
                "-Path",
                str(source_dir),
                "-Destination",
                str(dest_dir),
            ],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=60,
            check=False,
        )
    finally:
        release.cancel()
        if not handle.closed:
            handle.close()

    output = completed.stdout + completed.stderr
    assert completed.returncode == 0, output
    assert "move recovered" in output, output
    assert dest_dir.is_dir()
    assert not source_dir.exists()


@pytest.mark.skipif(os.name != "nt", reason="Windows rename-retry regression")
def test_move_with_retry_fails_fast_when_destination_exists(tmp_path: Path):
    source_dir = tmp_path / "swap-src"
    source_dir.mkdir()
    dest_dir = tmp_path / "swap-dst"
    dest_dir.mkdir()  # 목적지 존재 → 재시도 없이 즉시 실패해야 한다
    harness = _move_retry_harness(tmp_path)

    completed = subprocess.run(
        [
            "powershell.exe",
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            str(harness),
            "-Path",
            str(source_dir),
            "-Destination",
            str(dest_dir),
        ],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=30,
        check=False,
    )

    output = completed.stdout + completed.stderr
    assert completed.returncode != 0
    assert "destination already exists" in output
    assert "move retry" not in output
    assert source_dir.is_dir()


def _quarantine_harness(tmp_path: Path) -> Path:
    payload = _worker_payload()
    move_helper = payload[
        payload.index("$script:RetryableMoveCodes") : payload.index("function Invoke-CheckedProcess")
    ]
    quarantine_fn = payload[
        payload.index("function Move-LeftoversToQuarantine") : payload.index("function New-StagedComponents")
    ]
    harness = tmp_path / "quarantine_leftovers.ps1"
    harness.write_text(
        "param([string]$Root)\n$ErrorActionPreference = 'Stop'\n"
        "$TargetDir = $Root\n$SwapToken = 'feedc0de'\n"
        "$JournalPath = Join-Path $TargetDir 'update-journal.json'\n"
        "$script:HadRecoveryAssets = $false\n"
        + move_helper
        + quarantine_fn
        + "\nMove-LeftoversToQuarantine\nWrite-Host ('had=' + $script:HadRecoveryAssets)\n",
        encoding="utf-8-sig",
    )
    return harness


def _run_ps(harness: Path, *args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", str(harness), *args],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=60,
        check=False,
    )


@pytest.mark.skipif(os.name != "nt", reason="Windows leftover-recovery regression")
def test_leftover_backups_are_preserved_in_quarantine_never_deleted(tmp_path: Path):
    """반쯤 스왑된 트리의 .previous 백업과 journal 은 삭제 대신 격리 폴더로 보존돼야 한다."""
    root = tmp_path / "installed"
    (root / "backend").mkdir(parents=True)
    previous = root / "backend" / "app.previous.deadbeef"
    previous.mkdir()
    (previous / "marker.txt").write_text("old-tree", encoding="ascii")
    (root / "update-journal.json").write_text("{}", encoding="utf-8")

    completed = _run_ps(_quarantine_harness(tmp_path), "-Root", str(root))

    output = completed.stdout + completed.stderr
    assert completed.returncode == 0, output
    assert "preserving leftover backup in quarantine" in output
    assert "had=True" in output  # 복구 자산 발견 → 동버전이어도 전체 재설치 강제
    assert not previous.exists()
    quarantine = root / "update-quarantine.feedc0de"
    preserved = quarantine / "backend.app.previous.deadbeef" / "marker.txt"
    assert preserved.read_text(encoding="ascii") == "old-tree"
    assert (quarantine / "update-journal.json").is_file()
    assert not (root / "update-journal.json").exists()


@pytest.mark.skipif(os.name != "nt", reason="Windows leftover-recovery regression")
def test_leftover_staging_copies_are_deleted_and_live_targets_untouched(tmp_path: Path):
    root = tmp_path / "installed"
    (root / "backend" / "app").mkdir(parents=True)
    (root / "backend" / "app" / "marker.txt").write_text("current", encoding="ascii")
    staging = root / "backend" / "app.next.deadbeef"
    staging.mkdir()
    (staging / "marker.txt").write_text("staged", encoding="ascii")

    completed = _run_ps(_quarantine_harness(tmp_path), "-Root", str(root))

    output = completed.stdout + completed.stderr
    assert completed.returncode == 0, output
    assert "removing stale staging copy" in output
    assert "had=False" in output  # 일회용 스테이징 사본만으론 재설치를 강제하지 않는다
    assert not staging.exists()
    assert (root / "backend" / "app" / "marker.txt").read_text(encoding="ascii") == "current"


@pytest.mark.skipif(os.name != "nt", reason="Windows process-timeout helper regression")
def test_checked_process_handles_spaced_paths_and_captures_output(tmp_path: Path):
    """검증 실행 헬퍼 — 공백 경로 실행 파일과 인자 quoting, stdout 캡처 실측(코덱스 요청)."""
    import shutil

    payload = _worker_payload()
    helper = payload[
        payload.index("function Invoke-CheckedProcess") : payload.index("function Restart-MvHubAndWaitReady")
    ]
    spaced_dir = tmp_path / "spaced dir"
    spaced_dir.mkdir()
    shell_copy = spaced_dir / "my shell.exe"
    shutil.copyfile(Path(os.environ.get("ComSpec", r"C:\Windows\System32\cmd.exe")), shell_copy)

    harness = tmp_path / "checked_process.ps1"
    harness.write_text(
        "param([string]$Exe)\n$ErrorActionPreference = 'Stop'\n"
        + helper
        + "\n$Result = Invoke-CheckedProcess -FilePath $Exe -ArgumentList @('/d', '/c', 'echo hello world') -Label 'test' -TimeoutSeconds 30\n"
        + "if ($Result.ExitCode -ne 0) { throw ('exit=' + $Result.ExitCode) }\n"
        + "if ($Result.StdOut.Trim() -ne 'hello world') { throw ('stdout=[' + $Result.StdOut + ']') }\n"
        + "Write-Host 'checked-process-ok'\n",
        encoding="utf-8-sig",
    )

    completed = _run_ps(harness, "-Exe", str(shell_copy))

    output = completed.stdout + completed.stderr
    assert completed.returncode == 0, output
    assert "checked-process-ok" in output

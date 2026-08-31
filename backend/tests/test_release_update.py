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
    assert "Replace-ImmutableDirectory" in updater
    assert '$_.Name -ne "app" -and $_.Name -ne "data"' in updater
    assert '-TargetDir (Join-Path $TargetDir "backend\\app")' in updater
    assert '-TargetDir (Join-Path $TargetDir "frontend\\dist")' in updater
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

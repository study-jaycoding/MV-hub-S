import os
import shutil
import subprocess
from pathlib import Path

import pytest


ROOT = Path(__file__).resolve().parents[2]


def _read(name: str) -> str:
    return (ROOT / name).read_text(encoding="utf-8")


def _read_updater() -> str:
    return _read("tools/update_git_worker.bat")


def test_update_adds_server_tools_only_for_sparse_checkout():
    script = _read_updater()

    assert "git sparse-checkout list >nul 2>nul" in script
    assert "git sparse-checkout add tools" in script


def test_clone_setup_includes_server_tools_for_existing_and_new_clones():
    script = _read("setup_clone_git.ps1")

    assert script.count('"backend", "frontend", "tools"') == 2
    assert "Invoke-Native \"Update repository\"" in script


def test_production_launchers_use_locked_frontend_install_without_boot_rebuild():
    server = _read("MV_server.bat")
    updater = _read_updater()
    agent = _read("MV_agent.bat")
    setup = _read("setup_clone_git.ps1")

    assert 'if exist "%ROOT%frontend\\dist\\index.html"' in server
    assert "npm ci --include=dev --no-audit --no-fund" in server
    assert "npm install" not in server
    assert server.index("if exist \"%ROOT%frontend\\dist\\index.html\"") < server.index("where npm.cmd")
    assert "npm ci --include=dev --no-audit --no-fund" in updater
    assert "call npm install" not in updater
    assert "tools\\verify_requirements.py" in updater
    assert "-m pip check" not in updater
    assert "ci --include=dev --no-audit --no-fund" in agent
    assert '"ci", "--include=dev", "--no-audit", "--no-fund"' in setup
    assert "tools\\verify_requirements.py" in setup


def test_first_time_setup_propagates_each_native_failure():
    batch = _read("setup_clone_git.bat")
    script = _read("setup_clone_git.ps1")

    assert 'setup_clone_git.ps1"' in batch
    assert "if errorlevel 1" in batch
    assert "function Invoke-Native" in script
    assert 'throw "$Label failed (exit $LASTEXITCODE)"' in script


def test_autostart_fails_early_when_server_tools_are_missing():
    script = _read("register_autostart.bat")

    for required in (
        "tools\\server_supervisor.py",
        "tools\\server_watchdog.py",
        "tools\\backup_replicate.py",
    ):
        assert required in script
    assert ":tools_missing" in script


def test_autostart_delegates_restart_instead_of_embedding_fragile_cmd_logic():
    script = _read("register_autostart.bat")

    assert 'call "%ROOT%restart_server_task.bat"' in script
    assert "Get-NetTCPConnection" not in script
    assert "UPSTATE" not in script
    assert "WindowsBuiltInRole]::Administrator" in script
    assert "net session" not in "\n".join(
        line for line in script.splitlines() if not line.startswith("REM")
    )


def test_autostart_persists_runtime_paths_for_system_account():
    register = _read("register_autostart.bat")
    launcher = _read("task_launch.bat")

    assert 'py -3 -c "import sys; print(sys.executable)"' in register
    assert "where npm.cmd" in register
    assert "import fastapi,uvicorn,pydantic,websockets,multipart,PIL,watchdog" in register
    assert ":python_deps_missing" in register
    assert ".mvhub-runtime" in register
    assert "python.txt" in register
    assert "node_dir.txt" in register
    assert "logs\\scheduled_python.txt" not in register
    assert "logs\\scheduled_node_dir.txt" not in register
    assert "logs\\scheduled_python.txt" in launcher  # one-time migration
    assert 'set "PYEXE=%%p"' in launcher
    assert 'set "PYTHONUTF8=1"' in launcher
    assert 'set "PYTHONIOENCODING=utf-8:replace"' in launcher
    assert "logs\\scheduled_node_dir.txt" in launcher  # one-time migration
    assert 'set "PATH=%%p;%PATH%"' in launcher


def test_scheduled_watchdog_uses_bounded_task_scheduler_retry():
    watchdog = _read("MV_watchdog.bat")

    assert 'if "%CONTENT_HUB_TASK%"=="1"' in watchdog
    assert "handing retry to Task Scheduler" in watchdog
    assert "exit /b %WATCHDOG_RC%" in watchdog


def test_update_restarts_registered_server_and_checks_readiness():
    updater = _read_updater()
    wrapper = _read("restart_server_task.bat")
    restart = _read("restart_server_task.ps1")

    assert 'schtasks /Query /TN "MVHub Server"' in updater
    assert 'call "%ROOT%restart_server_task.bat"' in updater
    assert "Start-Process" in wrapper and "-Verb RunAs" in wrapper
    assert "WindowsBuiltInRole]::Administrator" in wrapper
    assert "Start-ScheduledTask -TaskName $TaskName" in restart
    assert "Start-TaskAndWaitRunning -TaskName $serverTask" in restart
    assert "Start-TaskAndWaitRunning -TaskName $watchdogTask" in restart
    assert "/api/ready" in restart
    assert "Get-ScheduledTaskInfo" in restart
    assert "server_console.log" in restart
    assert "watchdog_console.log" in restart
    assert "$Root = $PSScriptRoot" in restart
    assert '-Root "%ROOT%"' not in wrapper
    assert 'IndexOf("server_supervisor.py"' in restart
    assert "previous MV Hub supervisor" in restart
    assert 'IndexOf("server_watchdog.py"' in restart
    assert "previous MV Hub watchdog" in restart
    assert '$rootPrefix = $rootPath + "\\"' in restart
    assert "IndexOf($rootPrefix" in restart
    assert "Wait-TaskStopped" in restart
    assert "Start-TaskAndWaitRunning" in restart
    assert "Get-Content -LiteralPath $log -Encoding UTF8" in restart
    assert "Port $Port did not become free" in restart
    assert "$server.State -ne \"Running\"" in restart


def test_update_persists_commit_and_restart_result():
    updater = _read_updater()

    assert 'set "UPDATE_LOG=%ROOT%logs\\update.log"' in updater
    assert 'call :write_update_log "START" "update requested"' in updater
    assert (
        'call :write_update_log "SUCCESS" '
        '"before=!BEFORE! after=!AFTER! server=!SERVER_RESULT!"'
    ) in updater
    assert 'set "SERVER_RESULT=restart-failed"' in updater
    assert 'set "SERVER_RESULT=restarted-ready"' in updater
    assert (
        'call :write_update_log "FAILED" '
        '"stage=!UPDATE_STAGE! before=!BEFORE! after=!AFTER! '
        'server=!SERVER_RESULT! exit=!UPDATE_RC!"'
    ) in updater


def test_failed_frontend_refresh_is_retried_before_server_restart():
    updater = _read_updater()

    marker = 'set "FRONTEND_PENDING=%ROOT%logs\\frontend-build.pending"'
    detect_pending = 'if exist "!FRONTEND_PENDING!" ('
    persist_pending = '>"!FRONTEND_PENDING!" echo !AFTER!'
    install = "call npm ci --include=dev --no-audit --no-fund"
    build = "call npm run build"
    clear_pending = 'del /q "!FRONTEND_PENDING!"'
    restart = 'call "%ROOT%restart_server_task.bat"'

    for contract in (marker, detect_pending, persist_pending, clear_pending):
        assert contract in updater
    assert updater.index(persist_pending) < updater.index(install)
    assert updater.index(install) < updater.index(build)
    assert updater.index(build) < updater.index(clear_pending)
    assert updater.index(clear_pending) < updater.index(restart)


def test_failed_backend_dependency_refresh_is_retried():
    updater = _read_updater()

    marker = 'set "BACKEND_PENDING=%ROOT%logs\\backend-deps.pending"'
    detect_pending = 'if exist "!BACKEND_PENDING!" ('
    persist_pending = '>"!BACKEND_PENDING!" echo !AFTER!'
    install = '-m pip install -r "%ROOT%backend\\requirements.txt"'
    verify = 'tools\\verify_requirements.py'
    clear_pending = 'del /q "!BACKEND_PENDING!"'

    for contract in (marker, detect_pending, persist_pending, install, verify, clear_pending):
        assert contract in updater
    assert updater.index(persist_pending) < updater.index(install)
    assert updater.index(verify) < updater.index(clear_pending)


def test_first_isolated_update_repairs_an_interrupted_legacy_update_once():
    updater = _read_updater()

    marker = 'set "ISOLATED_UPDATER_READY=%ROOT%logs\\isolated-updater-v1.ready"'
    first_run = 'if not exist "!ISOLATED_UPDATER_READY!" ('
    force_backend = 'set "REQ_CHANGED=1"'
    force_frontend = 'set "FE_CHANGED=1"'
    persist = '>"!ISOLATED_UPDATER_READY!" echo !AFTER!'
    success = 'call :write_update_log "SUCCESS"'

    for contract in (marker, first_run, persist):
        assert contract in updater
    transition = updater[updater.index(first_run) : updater.index(first_run) + 320]
    assert force_backend in transition
    assert force_frontend in transition
    assert updater.index(persist) < updater.index(success)


def test_operational_text_logs_use_bounded_rotation_and_recovery_clears_alerts():
    launcher = _read("task_launch.bat")
    updater = _read_updater()
    restart = _read("restart_server_task.ps1")

    assert "tools\\rotate_text_log.py" in launcher
    assert "--max-bytes 10485760 --keep 3" in launcher
    assert "tools\\rotate_text_log.py" in updater
    assert "--max-bytes 2097152 --keep 3" in updater
    assert 'server_ALERT.txt", "watchdog_ALERT.txt' in restart
    assert "Remove-Item -LiteralPath $alertPath" in restart


def test_git_updater_runs_from_an_isolated_temp_copy():
    launcher = _read("update_git.bat")
    bootstrap = _read("tools/run_update_git.ps1")
    worker = _read_updater()

    assert len(launcher.splitlines()) == 1
    assert "tools\\run_update_git.ps1" in launcher
    assert "git pull" not in launcher
    assert "Copy-Item -LiteralPath $Worker -Destination $TempWorker" in bootstrap
    assert "[Guid]::NewGuid()" in bootstrap
    assert "Remove-Item -LiteralPath $TempWorker" in bootstrap
    assert 'set "ROOT=%~1"' in worker


@pytest.mark.skipif(os.name != "nt", reason="Windows batch self-update regression")
def test_git_updater_finishes_after_repository_scripts_are_overwritten(tmp_path: Path):
    root = tmp_path / "repo with spaces"
    tools = root / "tools"
    temp_dir = tmp_path / "temp"
    tools.mkdir(parents=True)
    temp_dir.mkdir()
    shutil.copy2(ROOT / "update_git.bat", root / "update_git.bat")
    shutil.copy2(ROOT / "tools" / "run_update_git.ps1", tools / "run_update_git.ps1")
    (tools / "update_git_worker.bat").write_text(
        """@echo off
set "ROOT=%~1"
>"%ROOT%\\update_git.bat" echo @echo off
>"%ROOT%\\tools\\update_git_worker.bat" echo @echo off
>"%ROOT%\\update-finished.txt" echo safe
exit /b 0
""",
        encoding="ascii",
    )

    env = os.environ.copy()
    env["TEMP"] = str(temp_dir)
    env["TMP"] = str(temp_dir)
    completed = subprocess.run(
        ["cmd.exe", "/d", "/c", str(root / "update_git.bat")],
        cwd=root,
        env=env,
        capture_output=True,
        text=True,
        timeout=30,
    )

    assert completed.returncode == 0, completed.stdout + completed.stderr
    assert (root / "update-finished.txt").read_text(encoding="ascii").strip() == "safe"
    assert not list(temp_dir.glob("mvhub-update-*.bat"))


@pytest.mark.skipif(os.name != "nt", reason="Windows batch exit-code regression")
def test_git_updater_propagates_the_isolated_worker_exit_code(tmp_path: Path):
    root = tmp_path / "repo"
    tools = root / "tools"
    tools.mkdir(parents=True)
    shutil.copy2(ROOT / "update_git.bat", root / "update_git.bat")
    shutil.copy2(ROOT / "tools" / "run_update_git.ps1", tools / "run_update_git.ps1")
    (tools / "update_git_worker.bat").write_text("@exit /b 23\n", encoding="ascii")

    env = os.environ.copy()
    env["MVHUB_NO_PAUSE"] = "1"
    completed = subprocess.run(
        ["cmd.exe", "/d", "/c", str(root / "update_git.bat")],
        cwd=root,
        env=env,
        capture_output=True,
        text=True,
        timeout=30,
    )

    assert completed.returncode == 23

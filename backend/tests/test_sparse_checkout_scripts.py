import os
import shutil
import subprocess
import sys
from pathlib import Path

import pytest


ROOT = Path(__file__).resolve().parents[2]


def _read(name: str) -> str:
    return (ROOT / name).read_text(encoding="utf-8")


def _read_updater() -> str:
    return _read("tools/update_git_worker.bat")


@pytest.mark.skipif(os.name != "nt", reason="Windows batch BOM contract")
def test_agent_cli_pin_reader_accepts_utf8_bom_and_keeps_batch_ascii(tmp_path):
    launcher_path = ROOT / "MV_agent.bat"
    launcher_bytes = launcher_path.read_bytes()
    launcher = launcher_bytes.decode("ascii")  # 런처 자체는 계속 ASCII 전용
    reader_line = next(
        line
        for line in launcher.splitlines()
        if line.startswith('if exist "%HF_CLI_PIN_FILE%" for /f')
    )
    helper = ROOT / "backend" / "app" / "services" / "read_utf8_sig_first_line.py"
    assert "utf-8-sig" in helper.read_text(encoding="utf-8")
    assert helper.name in reader_line
    assert "set /p HF_CLI_VERSION" not in launcher

    pin = tmp_path / "hf_cli_version.txt"
    pin.write_text("  1.2.3  \n", encoding="utf-8-sig")
    probe = tmp_path / "probe.bat"
    probe.write_text(
        "\r\n".join(
            [
                "@echo off",
                "setlocal",
                f'set "ROOT={ROOT}\\"',
                f'set "PY_EXE={sys.executable}"',
                'set "PY_ARGS="',
                f'set "HF_CLI_PIN_FILE={pin}"',
                'set "HF_CLI_VERSION="',
                reader_line,
                "echo VALUE=%HF_CLI_VERSION%",
            ]
        ),
        encoding="ascii",
    )
    result = subprocess.run(
        [os.environ.get("ComSpec", "cmd.exe"), "/d", "/c", "call", str(probe)],
        cwd=tmp_path,
        capture_output=True,
        text=True,
        timeout=10,
        check=False,
    )

    assert result.returncode == 0, result.stderr
    assert "VALUE=1.2.3" in result.stdout


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
    assert '$expectedServePath = Join-Path $rootPath "backend\\serve.py"' in restart
    assert "Test-MvHubServerCommandLine" in restart
    assert "not owned by this MV Hub installation" in restart
    assert '$command -notlike "*serve.py*"' not in restart
    assert "Wait-TaskStopped" in restart
    assert "Start-TaskAndWaitRunning" in restart
    assert "Get-Content -LiteralPath $log -Encoding UTF8" in restart
    assert "Port $Port did not become free" in restart
    assert "$server.State -ne \"Running\"" in restart


@pytest.mark.skipif(
    os.name != "nt", reason="Windows PowerShell process identity boundary"
)
def test_restart_identity_accepts_only_the_current_installation_path(tmp_path: Path):
    restart = _read("restart_server_task.ps1")
    function_start = restart.index("function Test-MvHubServerCommandLine")
    function_end = restart.index("\nfunction Wait-TaskStopped", function_start)
    identity_function = restart[function_start:function_end]

    root = tmp_path / "한글 설치 폴더 with spaces"
    expected = root / "backend" / "serve.py"
    unrelated = tmp_path / "other app" / "serve.py"
    probe = tmp_path / "identity-probe.ps1"
    probe.write_text(
        identity_function
        + "\n"
        + "$expected = $env:MVHUB_EXPECTED_SERVE\n"
        + "$unrelated = $env:MVHUB_UNRELATED_SERVE\n"
        + "$matching = '\"C:\\Python314\\python.exe\" \"' + $expected + '\"'\n"
        + "$foreign = '\"C:\\Python314\\python.exe\" \"' + $unrelated + '\"'\n"
        + "$backup = '\"C:\\Python314\\python.exe\" \"' + $expected + '.backup\"'\n"
        + "$embedded = '\"C:\\other\\app.exe\" \"--config=' + $expected + '\"'\n"
        + "if (-not (Test-MvHubServerCommandLine $matching $expected)) { exit 11 }\n"
        + "if (Test-MvHubServerCommandLine $foreign $expected) { exit 12 }\n"
        + "if (Test-MvHubServerCommandLine '' $expected) { exit 13 }\n"
        # 부분 문자열 매칭의 오탐 케이스 — 경로가 '포함'만 된 남의 프로세스를 죽이면 안 된다.
        + "if (Test-MvHubServerCommandLine $backup $expected) { exit 14 }\n"
        + "if (Test-MvHubServerCommandLine $embedded $expected) { exit 15 }\n"
        + "exit 0\n",
        encoding="utf-8-sig",
    )
    env = os.environ.copy()
    env["MVHUB_EXPECTED_SERVE"] = str(expected)
    env["MVHUB_UNRELATED_SERVE"] = str(unrelated)
    result = subprocess.run(
        [
            "powershell.exe",
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            str(probe),
        ],
        env=env,
        capture_output=True,
        text=True,
        timeout=15,
        check=False,
    )
    assert result.returncode == 0, result.stdout + result.stderr


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

    marker = 'set "FRONTEND_PENDING=!UPDATE_STATE_DIR!\\frontend-build.pending"'
    legacy_marker = 'set "LEGACY_FRONTEND_PENDING=%ROOT%logs\\frontend-build.pending"'
    detect_pending = 'if exist "!FRONTEND_PENDING!" ('
    detect_legacy = (
        'if not exist "!ISOLATED_UPDATER_READY!" '
        'if exist "!LEGACY_FRONTEND_PENDING!" ('
    )
    persist_pending = 'call :persist_marker "!FRONTEND_PENDING!" "!AFTER!"'
    install = "call npm ci --include=dev --no-audit --no-fund"
    build = "call npm run build"
    clear_pending = 'del /q "!FRONTEND_PENDING!"'
    restart = 'call "%ROOT%restart_server_task.bat"'

    for contract in (
        marker,
        legacy_marker,
        detect_pending,
        detect_legacy,
        persist_pending,
        clear_pending,
    ):
        assert contract in updater
    assert updater.index(persist_pending) < updater.index(install)
    assert updater.index(install) < updater.index(build)
    assert updater.index(build) < updater.index(clear_pending)
    assert updater.index(clear_pending) < updater.index(restart)


def test_failed_backend_dependency_refresh_is_retried():
    updater = _read_updater()

    marker = 'set "BACKEND_PENDING=!UPDATE_STATE_DIR!\\backend-deps.pending"'
    legacy_marker = 'set "LEGACY_BACKEND_PENDING=%ROOT%logs\\backend-deps.pending"'
    detect_pending = 'if exist "!BACKEND_PENDING!" ('
    detect_legacy = (
        'if not exist "!ISOLATED_UPDATER_READY!" '
        'if exist "!LEGACY_BACKEND_PENDING!" ('
    )
    persist_pending = 'call :persist_marker "!BACKEND_PENDING!" "!AFTER!"'
    install = '-m pip install -r "%ROOT%backend\\requirements.txt"'
    verify = 'tools\\verify_requirements.py'
    clear_pending = 'del /q "!BACKEND_PENDING!"'

    for contract in (
        marker,
        legacy_marker,
        detect_pending,
        detect_legacy,
        persist_pending,
        install,
        verify,
        clear_pending,
    ):
        assert contract in updater
    assert updater.index(persist_pending) < updater.index(install)
    assert updater.index(verify) < updater.index(clear_pending)


def test_first_isolated_update_repairs_an_interrupted_legacy_update_once():
    updater = _read_updater()

    marker = 'set "ISOLATED_UPDATER_READY=!UPDATE_STATE_DIR!\\isolated-updater-v2.ready"'
    legacy_marker = 'set "LEGACY_ISOLATED_UPDATER_READY=%ROOT%logs\\isolated-updater-v1.ready"'
    first_run = (
        'if not exist "!ISOLATED_UPDATER_READY!" '
        'if not exist "!LEGACY_ISOLATED_UPDATER_READY!" ('
    )
    force_backend = 'set "REQ_CHANGED=1"'
    force_frontend = 'set "FE_CHANGED=1"'
    persist = 'call :persist_marker "!ISOLATED_UPDATER_READY!" "!AFTER!"'
    success = 'call :write_update_log "SUCCESS"'

    for contract in (marker, legacy_marker, first_run, persist):
        assert contract in updater
    transition = updater[updater.index(first_run) : updater.index(first_run) + 320]
    assert force_backend in transition
    assert force_frontend in transition
    assert updater.index(persist) < updater.index(success)


def test_update_recovery_markers_use_the_writable_git_state_directory():
    updater = _read_updater()

    assert "git rev-parse --absolute-git-dir" in updater
    assert 'set "UPDATE_STATE_DIR=!GIT_DIR!\\mvhub-update"' in updater
    assert "could not prepare the Git update state directory" in updater
    assert ':persist_marker' in updater
    assert '%SystemRoot%\\System32\\findstr.exe /l /x' in updater
    assert 'move /y "!MARKER_TEMP!" "!MARKER_FILE!"' in updater


@pytest.mark.skipif(os.name != "nt", reason="Windows cmd ERRORLEVEL regression")
def test_marker_write_ignores_a_stale_errorlevel_and_verifies_content(tmp_path: Path):
    updater = _read_updater()
    helper_start = updater.index("\n:persist_marker\n") + 1
    helper_end = updater.index("\n:write_update_log\n", helper_start) + 1
    helper = updater[helper_start:helper_end]
    marker = tmp_path / "state with spaces" / "backend-deps.pending"
    marker.parent.mkdir()
    probe = tmp_path / "probe-marker.bat"
    probe.write_text(
        "@echo off\n"
        "setlocal enabledelayedexpansion\n"
        "cmd.exe /c exit 7\n"
        f'call :persist_marker "{marker}" "abc123"\n'
        "set \"RESULT=!errorlevel!\"\n"
        "if not \"!RESULT!\"==\"0\" exit /b !RESULT!\n"
        "exit /b 0\n\n"
        + helper,
        encoding="ascii",
    )

    completed = subprocess.run(
        ["cmd.exe", "/d", "/c", str(probe)],
        cwd=tmp_path,
        capture_output=True,
        text=True,
        timeout=15,
        check=False,
    )

    assert completed.returncode == 0, completed.stdout + completed.stderr
    assert marker.read_text(encoding="ascii").strip() == "abc123"
    assert not list(marker.parent.glob("*.tmp-*"))


@pytest.mark.skipif(os.name != "nt", reason="Windows git updater integration")
def test_update_worker_persists_and_clears_markers_in_the_actual_git_dir(tmp_path: Path):
    root = tmp_path / "repo"
    tools = root / "tools"
    backend = root / "backend"
    frontend = root / "frontend"
    fake_bin = tmp_path / "fake-bin"
    tools.mkdir(parents=True)
    backend.mkdir()
    (frontend / "dist").mkdir(parents=True)
    fake_bin.mkdir()
    shutil.copy2(ROOT / "tools" / "update_git_worker.bat", tools / "update_git_worker.bat")
    (tools / "verify_requirements.py").write_text("print('verified')\n", encoding="ascii")
    (backend / "requirements.txt").write_text("", encoding="ascii")
    (frontend / "dist" / "index.html").write_text("ok\n", encoding="ascii")
    (fake_bin / "npm.cmd").write_text("@exit /b 0\n", encoding="ascii")
    # A .cmd shim invoked without CALL would replace the worker's control flow.
    # Use an executable that safely returns non-zero for schtasks-style arguments.
    shutil.copy2(
        Path(os.environ["SystemRoot"]) / "System32" / "where.exe",
        fake_bin / "schtasks.exe",
    )

    def git(*args: str) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            ["git", *args],
            cwd=root,
            capture_output=True,
            text=True,
            timeout=20,
            check=True,
        )

    git("init")
    git("config", "user.email", "test@example.com")
    git("config", "user.name", "MV Hub Test")
    git("add", ".")
    git("commit", "-m", "fixture")
    bare = tmp_path / "origin.git"
    subprocess.run(["git", "init", "--bare", str(bare)], check=True, capture_output=True)
    git("remote", "add", "origin", str(bare))
    git("push", "-u", "origin", "HEAD")
    (frontend / "node_modules").mkdir()
    git_dir = Path(git("rev-parse", "--absolute-git-dir").stdout.strip())
    state_dir = git_dir / "mvhub-update"
    legacy_dir = root / "logs"
    legacy_dir.mkdir()
    legacy_backend = legacy_dir / "backend-deps.pending"
    legacy_ready = legacy_dir / "isolated-updater-v1.ready"
    head = git("rev-parse", "HEAD").stdout.strip()
    legacy_backend.write_text(head + "\n", encoding="ascii")
    legacy_ready.write_text(head + "\n", encoding="ascii")

    env = os.environ.copy()
    env["PATH"] = str(fake_bin) + os.pathsep + env["PATH"]
    env["MVHUB_NO_PAUSE"] = "1"
    completed = subprocess.run(
        ["cmd.exe", "/d", "/c", str(tools / "update_git_worker.bat"), str(root)],
        cwd=root,
        env=env,
        stdin=subprocess.DEVNULL,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=60,
        check=False,
    )

    output = completed.stdout + completed.stderr
    assert completed.returncode == 0, output
    assert "[done] updated to the latest version." in output
    assert not (state_dir / "backend-deps.pending").exists()
    assert not (state_dir / "frontend-build.pending").exists()
    assert not legacy_backend.exists()
    assert not legacy_ready.exists()
    ready = state_dir / "isolated-updater-v2.ready"
    assert ready.read_text(encoding="ascii").strip() == git("rev-parse", "HEAD").stdout.strip()
    assert "SUCCESS" in (root / "logs" / "update.log").read_text(encoding="ascii")


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
    assert "Copy-Item -LiteralPath $WorkerPath -Destination $TempWorker" in bootstrap
    assert "[Guid]::NewGuid()" in bootstrap
    assert "Remove-Item -LiteralPath $TempWorker" in bootstrap
    assert "Get-FileHash -LiteralPath" not in bootstrap
    assert "[System.Security.Cryptography.SHA256]::Create()" in bootstrap
    assert "$Stream.Dispose()" in bootstrap
    assert "$InitialWorkerHash" in bootstrap
    assert "$CurrentWorkerHash -ne $InitialWorkerHash" in bootstrap
    assert "retrying once with the new worker" in bootstrap
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


@pytest.mark.skipif(os.name != "nt", reason="Windows updater migration regression")
def test_git_updater_retries_once_when_git_pull_replaces_a_failed_worker(tmp_path: Path):
    root = tmp_path / "repo"
    tools = root / "tools"
    temp_dir = tmp_path / "temp"
    tools.mkdir(parents=True)
    temp_dir.mkdir()
    shutil.copy2(ROOT / "update_git.bat", root / "update_git.bat")
    shutil.copy2(ROOT / "tools" / "run_update_git.ps1", tools / "run_update_git.ps1")
    (tools / "replacement-worker.bat").write_text(
        '@echo off\n>"%~1\\retry-finished.txt" echo recovered\nexit /b 0\n',
        encoding="ascii",
    )
    (tools / "update_git_worker.bat").write_text(
        '@echo off\ncopy /y "%~1\\tools\\replacement-worker.bat" '
        '"%~1\\tools\\update_git_worker.bat" >nul\nexit /b 23\n',
        encoding="ascii",
    )

    env = os.environ.copy()
    env["TEMP"] = str(temp_dir)
    env["TMP"] = str(temp_dir)
    env["MVHUB_NO_PAUSE"] = "1"
    completed = subprocess.run(
        ["cmd.exe", "/d", "/c", str(root / "update_git.bat")],
        cwd=root,
        env=env,
        capture_output=True,
        text=True,
        timeout=30,
        check=False,
    )

    output = completed.stdout + completed.stderr
    assert completed.returncode == 0, output
    assert "retrying once with the new worker" in output
    assert (root / "retry-finished.txt").read_text(encoding="ascii").strip() == "recovered"
    assert not list(temp_dir.glob("mvhub-update-*.bat"))

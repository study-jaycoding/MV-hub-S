from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]


def _read(name: str) -> str:
    return (ROOT / name).read_text(encoding="utf-8")


def test_update_adds_server_tools_only_for_sparse_checkout():
    script = _read("update_git.bat")

    assert "git sparse-checkout list >nul 2>nul" in script
    assert "git sparse-checkout add tools" in script


def test_clone_setup_includes_server_tools_for_existing_and_new_clones():
    script = _read("setup_clone_git.ps1")

    assert script.count('"backend", "frontend", "tools"') == 2
    assert "Invoke-Native \"Update repository\"" in script


def test_production_launchers_use_locked_frontend_install_without_boot_rebuild():
    server = _read("MV_server.bat")
    updater = _read("update_git.bat")
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
    updater = _read("update_git.bat")
    wrapper = _read("restart_server_task.bat")
    restart = _read("restart_server_task.ps1")

    assert 'schtasks /Query /TN "MVHub Server"' in updater
    assert 'call "%ROOT%restart_server_task.bat"' in updater
    assert "Start-Process" in wrapper and "-Verb RunAs" in wrapper
    assert "WindowsBuiltInRole]::Administrator" in wrapper
    assert 'Start-ScheduledTask -TaskName $serverTask' in restart
    assert 'Start-ScheduledTask -TaskName $watchdogTask' in restart
    assert "/api/ready" in restart
    assert "Get-ScheduledTaskInfo" in restart
    assert "server_console.log" in restart
    assert "watchdog_console.log" in restart
    assert "$Root = $PSScriptRoot" in restart
    assert '-Root "%ROOT%"' not in wrapper
    assert 'IndexOf("server_supervisor.py"' in restart
    assert "previous MV Hub supervisor" in restart
    assert "Port $Port did not become free" in restart
    assert "$server.State -ne \"Running\"" in restart


def test_update_persists_commit_and_restart_result():
    updater = _read("update_git.bat")

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

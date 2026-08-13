from pathlib import Path
import re


ROOT = Path(__file__).resolve().parents[2]


def _read(name: str) -> str:
    return (ROOT / name).read_text(encoding="utf-8")


def test_update_adds_server_tools_only_for_sparse_checkout():
    script = _read("update_git.bat")

    assert "git sparse-checkout list >nul 2>nul" in script
    assert "git sparse-checkout add tools" in script


def test_clone_setup_includes_server_tools_for_existing_and_new_clones():
    script = _read("setup_clone_git.bat")

    assert script.count("git sparse-checkout set backend frontend tools") == 2
    assert not re.search(
        r"git sparse-checkout set backend frontend(?! tools)", script
    )


def test_autostart_fails_early_when_server_tools_are_missing():
    script = _read("register_autostart.bat")

    for required in (
        "tools\\server_supervisor.py",
        "tools\\server_watchdog.py",
        "tools\\backup_replicate.py",
    ):
        assert required in script
    assert ":tools_missing" in script


def test_autostart_escapes_parentheses_inside_command_block():
    script = _read("register_autostart.bat")

    assert "auto-start ^(the running one will be stopped^)..." in script
    assert "auto-start (the running one will be stopped)..." not in script

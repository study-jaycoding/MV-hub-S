"""격리 복원 서버가 남았을 때 검증 도구가 성공으로 보고하지 않는지 확인한다.

ready 불일치·로그인 실패·행 수 변화는 verify_restored_set_runtime 이 예외를 던져
종료 코드 1 이 되지만, `process_stopped` 는 값으로만 돌아와 판정에서 빠져 있었다.
"""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]


def _load_cli():
    path = ROOT / "tools" / "verify_backup_restore.py"
    spec = importlib.util.spec_from_file_location("mvhub_verify_backup_restore_cli", path)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


@pytest.fixture(scope="module")
def cli():
    return _load_cli()


def _stub_run(cli, monkeypatch, tmp_path, *, process_stopped: bool):
    backup = tmp_path / "content_hub_20260101_000000_000000.db"
    backup.write_bytes(b"")
    monkeypatch.setattr(sys, "argv", ["verify_backup_restore.py", "--backup-set", str(backup)])
    monkeypatch.setattr(cli, "verify_restore_set", lambda *a, **k: {"ok": True, "files": {}})
    monkeypatch.setattr(
        cli,
        "verify_restored_set_runtime",
        lambda *a, **k: {"ok": True, "ready": True, "process_stopped": process_stopped},
    )
    return cli.main()


def test_leftover_isolated_server_fails(cli, monkeypatch, tmp_path, capsys):
    assert _stub_run(cli, monkeypatch, tmp_path, process_stopped=False) == 1
    assert "IsolatedServerLeftRunning" in capsys.readouterr().err


def test_stopped_isolated_server_passes(cli, monkeypatch, tmp_path, capsys):
    assert _stub_run(cli, monkeypatch, tmp_path, process_stopped=True) == 0
    assert capsys.readouterr().err == ""


def test_single_database_mode_has_no_isolated_server(cli, monkeypatch, tmp_path):
    """--backup 단일 모드는 격리 서버를 띄우지 않으므로 판정에 걸리지 않아야 한다."""
    backup = tmp_path / "one.db"
    backup.write_bytes(b"")
    monkeypatch.setattr(sys, "argv", ["verify_backup_restore.py", "--backup", str(backup)])
    monkeypatch.setattr(cli, "verify_restore_drill", lambda *a, **k: {"ok": True})
    assert cli.main() == 0

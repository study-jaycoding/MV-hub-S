"""쉬운 서버 이사(tools/server_move_easy.py) 계약 — Codex r2 검토 조건이 그대로 시험이 된다.

1. 옛 서버 OUT 은 무엇이든 바꾸기 전에 되돌리기 기록과 바탕화면 UNDO bat 을 만든다.
2. 정지 뒤 최종 확인에서 새 생성 기록이 보이면 내보내지 않는다.
3. 이사 폴더의 기계 설정 파일도 manifest 의 크기·SHA 대조 대상이다.
4. 새 서버 IN 은 점검이 하나라도 걸리면 아무것도 바꾸지 않는다.
5. IN 은 첫 서버 시작 전에 임시 관리자 비밀번호 파일을 지우고 생성 접수 멈춤을 원래 값으로 돌리며,
   기계 변수는 이름 목록에 있는 것만 적용한다.
6. UNDO 는 원래 켜져 있던 것만 되돌린다(BackupCopy 는 다시 돌리지 않는다).
7. register_autostart.bat 은 넘겨받은 파이썬을 그대로 쓰고, 부른 쪽이 원하면 확인 창을 건너뛴다.
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import sqlite3
import sys
from contextlib import closing
from pathlib import Path

import pytest

ROOT_DIR = Path(__file__).resolve().parents[2]
ROLE_TABLES = {
    "content": ("generation", "worker", "account", "project", "share"),
    "trash": ("trashed",),
    "manage": ("team_generation_fact",),
}
KST = "Korea Standard Time"


def _module():
    path = ROOT_DIR / "tools" / "server_move_easy.py"
    spec = importlib.util.spec_from_file_location("server_move_easy", path)
    module = importlib.util.module_from_spec(spec)
    assert spec and spec.loader
    spec.loader.exec_module(module)
    return module


def _make_db(path: Path, tables: tuple[str, ...], *, pause: str | None = None) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with closing(sqlite3.connect(path)) as conn:
        for table in tables:
            conn.execute(f'CREATE TABLE "{table}"(id INTEGER PRIMARY KEY, tag TEXT)')
            conn.execute(f'INSERT INTO "{table}"(tag) VALUES(?)', (table,))
        if "generation" in tables:
            conn.execute("CREATE TABLE app_setting(key TEXT PRIMARY KEY, value TEXT)")
            if pause is not None:
                conn.execute("INSERT INTO app_setting VALUES('generation_deployment_paused', ?)", (pause,))
        conn.commit()


def _make_live(easy, data: Path) -> dict[str, Path]:
    live = easy.sm.role_live_paths(data)
    for role, tables in ROLE_TABLES.items():
        _make_db(live[role], tables)
    return live


def _tasks(easy, *, exists=True, enabled=True, running=True):
    return {
        name: {"exists": exists, "enabled": enabled, "running": running and name != "MVHub BackupCopy"}
        for name in easy.TASKS
    }


def _fence(safe: bool) -> dict:
    total = 0 if safe else 1
    return {
        "safe": safe,
        "non_terminal_request_total": total,
        "active_generation_total": 0,
        "non_terminal_request_counts": {} if safe else {"pending": 1},
        "active_generation_counts": {},
    }


def _out_args(data: Path) -> argparse.Namespace:
    return argparse.Namespace(data_dir=str(data), port=8010, fence_wait=1, yes=True)


@pytest.fixture
def easy(monkeypatch, tmp_path):
    for name in ("CONTENT_HUB_DATA", "CONTENT_HUB_DB", "CONTENT_HUB_SSL_CERTFILE", "CONTENT_HUB_SSL_KEYFILE"):
        monkeypatch.delenv(name, raising=False)  # 시험 격리 변수 — OUT·IN 은 이것이 있으면 멈춘다
    module = _module()
    monkeypatch.setattr(module, "_require_windows_admin", lambda: None)
    desktop = tmp_path / "Desktop"
    desktop.mkdir()
    monkeypatch.setattr(module, "desktop_dir", lambda: desktop)
    monkeypatch.setattr(module, "machine_env", lambda: {})
    monkeypatch.setattr(module.time, "sleep", lambda seconds: None)
    return module


# ------------------------------------------------------------ OUT


def test_out_records_undo_before_changing_anything(easy, tmp_path, monkeypatch):
    data = tmp_path / "data"
    _make_live(easy, data)
    monkeypatch.setattr(easy, "task_snapshot", lambda: _tasks(easy))

    def first_change_fails(db, value, **kwargs):
        raise RuntimeError("첫 변경에서 실패")

    monkeypatch.setattr(easy, "write_pause", first_change_fails)

    with pytest.raises(RuntimeError, match="첫 변경"):
        easy.cmd_out(_out_args(data))

    state = json.loads((data / easy.STATE_NAME).read_text(encoding="utf-8"))
    assert state["phase"] == "prepared"
    assert state["tasks"]["MVHub Server"]["running"] is True
    assert state["pause_original"] is None
    launcher = (tmp_path / "Desktop" / easy.UNDO_SHORTCUT).read_text(encoding="ascii")
    assert "server_move_UNDO.bat" in launcher


def test_out_does_not_export_when_the_final_check_finds_new_work(easy, tmp_path, monkeypatch):
    data = tmp_path / "data"
    live = _make_live(easy, data)
    monkeypatch.setattr(easy, "task_snapshot", lambda: _tasks(easy))
    checks = iter([_fence(True), _fence(False)])  # 대기 중엔 0, 정지 뒤 최종 확인에서 1
    monkeypatch.setattr(easy, "inspect_fence", lambda db: next(checks))
    monkeypatch.setattr(easy, "_schtasks", lambda *args, **kwargs: 0)
    monkeypatch.setattr(easy, "our_processes", lambda: [])
    monkeypatch.setattr(easy, "_confirm_stopped", lambda port: None)
    exported: list[int] = []
    monkeypatch.setattr(easy.sm, "cmd_export", lambda *args, **kwargs: exported.append(1))

    with pytest.raises(easy.MoveError, match="내보내지 않습니다"):
        easy.cmd_out(_out_args(data))

    assert exported == []
    assert easy.read_pause(live["content"]) == "1"  # 멈춤은 켜 둔 채 — UNDO 가 원래 값으로
    assert json.loads((data / easy.STATE_NAME).read_text(encoding="utf-8"))["phase"] == "stopped"


def test_out_package_carries_machine_settings_inside_the_manifest(easy, tmp_path, monkeypatch):
    data = tmp_path / "data"
    _make_live(easy, data)
    monkeypatch.setattr(easy, "task_snapshot", lambda: _tasks(easy))
    monkeypatch.setattr(easy, "inspect_fence", lambda db: _fence(True))
    monkeypatch.setattr(easy, "_schtasks", lambda *args, **kwargs: 0)
    monkeypatch.setattr(easy, "our_processes", lambda: [])
    monkeypatch.setattr(easy, "_confirm_stopped", lambda port: None)
    monkeypatch.setattr(easy.sm, "ensure_server_stopped", lambda port: {})
    monkeypatch.setattr(easy, "machine_env", lambda: {"CONTENT_HUB_ASSET_REGISTRY": "1"})
    monkeypatch.setattr(
        easy,
        "network_snapshot",
        lambda: [{"InterfaceAlias": "Ethernet", "IPv4": "192.168.1.199", "Prefix": 24, "Gateway": "192.168.1.1", "Dns": ["192.168.1.1"], "Dhcp": "Disabled"}],
    )
    monkeypatch.setattr(easy, "time_zone", lambda: KST)
    replica = tmp_path / "replica.txt"
    replica.write_text("\\\\nas\\backup\n", encoding="utf-8")
    monkeypatch.setattr(easy, "REPLICA_PATH", replica)

    assert easy.cmd_out(_out_args(data)) == 0

    [package] = list((tmp_path / "Desktop").glob(easy.PACKAGE_PREFIX + "*"))
    manifest = easy.sm.read_manifest(package)
    assert easy.SETTINGS_NAME in manifest["files"]
    easy.sm.verify_manifest_files(package, manifest)
    settings = json.loads((package / easy.SETTINGS_NAME).read_text(encoding="utf-8"))
    assert settings["server_url"] == "http://192.168.1.199:8010"
    assert settings["machine_env"] == {"CONTENT_HUB_ASSET_REGISTRY": "1"}
    assert settings["backup_replica_target"] == "\\\\nas\\backup"
    assert json.loads((data / easy.STATE_NAME).read_text(encoding="utf-8"))["phase"] == "exported"

    (package / easy.SETTINGS_NAME).write_text("{}", encoding="utf-8")  # 옮기다 깨진 설정 파일
    with pytest.raises(easy.MoveError):
        easy.sm.verify_manifest_files(package, manifest)


# ------------------------------------------------------------ IN


def _make_package(easy, package: Path, settings: dict) -> None:
    sm = easy.sm
    files = {}
    for role, tables in ROLE_TABLES.items():
        rel = f"db/{sm.BACKUP_SET_MEMBERS[role]['prefix']}20261001_120000_000000.db"
        _make_db(package / rel, tables, pause="1" if role == "content" else None)
        files[rel] = {"role": role, "bytes": (package / rel).stat().st_size, "sha256": sm._sha256(package / rel)}
    (package / easy.SETTINGS_NAME).write_text(json.dumps(settings), encoding="utf-8")
    target = package / easy.SETTINGS_NAME
    files[easy.SETTINGS_NAME] = {"role": "settings", "bytes": target.stat().st_size, "sha256": sm._sha256(target)}
    sm.write_manifest(package, {"kind": sm.PACKAGE_KIND, "format": sm.PACKAGE_FORMAT, "files": files})


def test_in_prechecks_stop_before_any_change(easy, tmp_path, monkeypatch):
    data = tmp_path / "data"
    db_dir = data / "db"
    db_dir.mkdir(parents=True)
    (db_dir / easy.sm.JOURNAL_NAME).write_text("{}", encoding="utf-8")
    (data / "db-backups").mkdir()
    (data / "db-backups" / "keep.db").write_bytes(b"x")
    package = tmp_path / "pkg"
    (package / "db-backups").mkdir(parents=True)
    monkeypatch.setattr(easy, "task_snapshot", lambda: _tasks(easy))
    monkeypatch.setattr(easy.sm, "port_listener_pids", lambda port: ([4321], True))
    monkeypatch.setattr(easy, "our_processes", lambda: [])
    monkeypatch.setattr(easy, "firewall_allows", lambda port: False)
    monkeypatch.setattr(easy, "time_zone", lambda: "UTC")

    problems = easy.precheck_in(package, {"machine_env": {"CONTENT_HUB_DB": "X:\\db.db"}}, data, 8010)

    text = "\n".join(problems)
    for expected in ("지난 설치 기록", "CONTENT_HUB_DB", "예약 작업", "다른 프로그램", "방화벽", "시간대", "db-backups"):
        assert expected in text, expected
    assert (data / "db-backups" / "keep.db").read_bytes() == b"x"


def test_in_installs_then_prepares_before_the_first_server_start(easy, tmp_path, monkeypatch):
    data = tmp_path / "data"
    data.mkdir()
    (data / easy.BOOTSTRAP_FILE).write_text("stale-secret\n", encoding="utf-8")
    package = tmp_path / "Desktop" / (easy.PACKAGE_PREFIX + "20261001_120000")
    settings = {
        "machine_env": {
            "CONTENT_HUB_ASSET_REGISTRY": "1",
            "CONTENT_HUB_ASSET_REGISTRY_DRIVES": "Z:=\\\\nas\\share",
            "CONTENT_HUB_AUTH_SECRET": "do-not-copy",
            "CONTENT_HUB_FFMPEG": "C:\\old\\ffmpeg.exe",
        },
        "backup_replica_target": "\\\\nas\\backup",
        "pause_original": None,
        "server_url": "http://192.168.1.199:8010",
        "network": [{"IPv4": "192.168.1.199", "Prefix": 24, "Gateway": "192.168.1.1", "Dns": ["192.168.1.1"]}],
    }
    _make_package(easy, package, settings)
    monkeypatch.setattr(easy, "task_snapshot", lambda: _tasks(easy, exists=False, enabled=False, running=False))
    monkeypatch.setattr(easy.sm, "port_listener_pids", lambda port: ([], True))
    monkeypatch.setattr(easy, "our_processes", lambda: [])
    monkeypatch.setattr(easy, "firewall_allows", lambda port: True)
    monkeypatch.setattr(easy, "time_zone", lambda: KST)
    monkeypatch.setattr(easy.sm, "check_drill_runtime", lambda: None)
    monkeypatch.setattr(
        easy.sm,
        "run_drill",
        lambda files, timeout: {
            "ok": True,
            "isolated_server": {"ready_checks": {role: "ok" for role in easy.sm.SET_ROLES}, "login": "ok", "process_stopped": True},
            "files": {},
        },
    )
    monkeypatch.setattr(easy.sm, "ensure_server_stopped", lambda port: {})
    applied: dict[str, str] = {}
    monkeypatch.setattr(easy, "set_machine_env", lambda name, value: applied.__setitem__(name, value))
    replica = tmp_path / "tools-replica.txt"
    monkeypatch.setattr(easy, "REPLICA_PATH", replica)
    runtime = tmp_path / "python.txt"
    runtime.write_text(sys.executable + "\n", encoding="utf-8")
    monkeypatch.setattr(easy, "RUNTIME_PYTHON_FILE", runtime)
    monkeypatch.setattr(easy, "wait_ready", lambda port, timeout=180.0: True)
    monkeypatch.setattr(easy, "backup_copy_result", lambda *args, **kwargs: "성공")
    monkeypatch.setattr(easy, "backup_task_run", lambda: (None, None))
    seen_at_start: dict[str, object] = {}

    def register():
        content = easy.sm.role_live_paths(data)["content"]
        seen_at_start["bootstrap"] = (data / easy.BOOTSTRAP_FILE).exists()
        seen_at_start["pause"] = easy.read_pause(content)

    monkeypatch.setattr(easy, "register_autostart", register)

    args = argparse.Namespace(package=str(package), data_dir=str(data), port=8010, server_timeout=5, yes=True)
    assert easy.cmd_in(args) == 0

    assert seen_at_start == {"bootstrap": False, "pause": None}  # 첫 시작 전에 지우고, 원래 값(없음)으로
    assert applied == {"CONTENT_HUB_ASSET_REGISTRY": "1", "CONTENT_HUB_ASSET_REGISTRY_DRIVES": "Z:=\\\\nas\\share"}
    assert replica.read_text(encoding="utf-8").strip() == "\\\\nas\\backup"
    for path in easy.sm.role_live_paths(data).values():
        assert path.is_file()


# ------------------------------------------------------------ UNDO


def test_undo_restores_only_what_was_on_before(easy, tmp_path, monkeypatch):
    data = tmp_path / "data"
    live = _make_live(easy, data)
    easy.write_pause(live["content"], "1")  # OUT 이 켜 둔 멈춤
    state = {
        "content_db": str(live["content"]),
        "pause_original": None,
        "port": 8010,
        "tasks": {
            "MVHub Watchdog": {"exists": True, "enabled": True, "running": True},
            "MVHub Server": {"exists": True, "enabled": True, "running": True},
            "MVHub BackupCopy": {"exists": True, "enabled": True, "running": False},
        },
    }
    monkeypatch.setattr(easy, "task_snapshot", lambda: _tasks(easy, enabled=False, running=False))
    calls: list[tuple[str, ...]] = []
    monkeypatch.setattr(easy, "_schtasks", lambda *args, **kwargs: calls.append(args) or 0)
    monkeypatch.setattr(easy, "wait_ready", lambda port, timeout=180.0: True)

    easy.undo_out(state)

    assert ("/Change", "/TN", "MVHub BackupCopy", "/ENABLE") in calls
    assert ("/Run", "/TN", "MVHub Server") in calls
    assert ("/Run", "/TN", "MVHub Watchdog") in calls
    assert not [call for call in calls if call[0] == "/Run" and call[2] == "MVHub BackupCopy"]
    assert easy.read_pause(live["content"]) is None


def test_undo_does_not_write_the_pause_when_it_is_already_the_original(easy, tmp_path, monkeypatch):
    data = tmp_path / "data"
    live = _make_live(easy, data)
    state = {"content_db": str(live["content"]), "pause_original": None, "port": 8010, "tasks": _tasks(easy, exists=False)}
    writes: list[object] = []
    monkeypatch.setattr(easy, "write_pause", lambda db, value, **kwargs: writes.append(value))
    monkeypatch.setattr(easy, "task_snapshot", lambda: _tasks(easy, exists=False))

    easy.undo_out(state)

    assert writes == []


# ------------------------------------------------------------ Codex 코드 리뷰(10-01) 회귀


def test_out_refuses_to_overwrite_an_unfinished_record(easy, tmp_path, monkeypatch):
    """첫 OUT 이 멈춘 뒤 다시 OUT 하면 '원래 상태'가 멈춘 값으로 바뀐다 — 덮어쓰지 않고 UNDO 를 먼저 하게 한다."""
    data = tmp_path / "data"
    _make_live(easy, data)
    state_path = data / easy.STATE_NAME
    state_path.write_text(json.dumps({"phase": "paused", "pause_original": None}), encoding="utf-8")
    monkeypatch.setattr(easy, "task_snapshot", lambda: pytest.fail("기록을 덮어쓰려 했다"))

    with pytest.raises(easy.MoveError, match="UNDO"):
        easy.cmd_out(_out_args(data))

    assert json.loads(state_path.read_text(encoding="utf-8"))["phase"] == "paused"


def test_out_refuses_path_overrides_before_any_change(easy, tmp_path, monkeypatch):
    """이 창에 CONTENT_HUB_DB 가 있으면 예약 서버와 다른 DB 를 멈추고 내보낼 수 있다 — 아무것도 바꾸기 전에 멈춘다."""
    data = tmp_path / "data"
    _make_live(easy, data)
    monkeypatch.setenv("CONTENT_HUB_DB", str(tmp_path / "other.db"))

    with pytest.raises(easy.MoveError, match="CONTENT_HUB_DB"):
        easy.cmd_out(_out_args(data))

    assert not (data / easy.STATE_NAME).exists()
    assert not list((tmp_path / "Desktop").iterdir())


def test_in_precheck_refuses_path_overrides_left_on_the_new_pc(easy, tmp_path, monkeypatch):
    data = tmp_path / "data"
    monkeypatch.setattr(easy, "machine_env", lambda: {"CONTENT_HUB_SSL_CERTFILE": "C:\\certs\\old.pem"})
    monkeypatch.setattr(easy, "task_snapshot", lambda: _tasks(easy, exists=False))
    monkeypatch.setattr(easy.sm, "port_listener_pids", lambda port: ([], True))
    monkeypatch.setattr(easy, "our_processes", lambda: [])
    monkeypatch.setattr(easy, "firewall_allows", lambda port: True)
    monkeypatch.setattr(easy, "time_zone", lambda: KST)

    problems = easy.precheck_in(tmp_path / "pkg", {"machine_env": {}}, data, 8010)

    assert len(problems) == 1 and "이 PC 에 CONTENT_HUB_SSL_CERTFILE" in problems[0]


def test_in_refuses_a_package_without_settings_in_the_manifest(easy, tmp_path):
    """OUT 이 설정 파일을 쓰고 manifest 를 다시 쓰기 전에 끊긴 폴더 — 설정을 대조할 수 없으니 받지 않는다."""
    package = tmp_path / "pkg"
    _make_package(easy, package, {"machine_env": {}})
    manifest = easy.sm.read_manifest(package)
    del manifest["files"][easy.SETTINGS_NAME]
    easy.sm.write_manifest(package, manifest)
    args = argparse.Namespace(package=str(package), data_dir=str(tmp_path / "data"), port=8010, server_timeout=5, yes=True)

    with pytest.raises(easy.MoveError, match="완전하지 않습니다"):
        easy.cmd_in(args)


def test_in_resumes_after_the_registration_failed(easy, tmp_path, monkeypatch):
    """설치 뒤 등록이 실패하면, 원인을 고치고 IN 을 다시 눌렀을 때 설치는 건너뛰고 이어서 끝낸다."""
    data = tmp_path / "data"
    data.mkdir()
    package = tmp_path / "pkg"
    _make_package(easy, package, {"machine_env": {}, "pause_original": "0", "network": []})
    monkeypatch.setattr(easy, "task_snapshot", lambda: _tasks(easy, exists=False, enabled=False, running=False))
    monkeypatch.setattr(easy.sm, "port_listener_pids", lambda port: ([], True))
    monkeypatch.setattr(easy, "our_processes", lambda: [])
    monkeypatch.setattr(easy, "firewall_allows", lambda port: True)
    monkeypatch.setattr(easy, "time_zone", lambda: KST)
    monkeypatch.setattr(easy.sm, "check_drill_runtime", lambda: None)
    monkeypatch.setattr(
        easy.sm,
        "run_drill",
        lambda files, timeout: {
            "ok": True,
            "isolated_server": {"ready_checks": {role: "ok" for role in easy.sm.SET_ROLES}, "login": "ok", "process_stopped": True},
            "files": {},
        },
    )
    monkeypatch.setattr(easy.sm, "ensure_server_stopped", lambda port: {})
    monkeypatch.setattr(easy, "set_machine_env", lambda name, value: None)
    monkeypatch.setattr(easy, "REPLICA_PATH", tmp_path / "replica.txt")
    runtime = tmp_path / "python.txt"
    runtime.write_text(sys.executable, encoding="utf-8")
    monkeypatch.setattr(easy, "RUNTIME_PYTHON_FILE", runtime)
    monkeypatch.setattr(easy, "wait_ready", lambda port, timeout=180.0: True)
    monkeypatch.setattr(easy, "backup_copy_result", lambda *args, **kwargs: "건너뜀")
    monkeypatch.setattr(easy, "backup_task_run", lambda: (None, None))
    args = argparse.Namespace(package=str(package), data_dir=str(data), port=8010, server_timeout=5, yes=True)

    def register_fails():
        raise easy.MoveError("register_autostart.bat 이 실패했습니다")

    monkeypatch.setattr(easy, "register_autostart", register_fails)
    with pytest.raises(easy.MoveError, match="register_autostart"):
        easy.cmd_in(args)
    assert json.loads((data / easy.IN_STATE_NAME).read_text(encoding="utf-8"))["phase"] == "installed"

    monkeypatch.setattr(easy.sm, "install_set", lambda *a, **k: pytest.fail("설치를 다시 했다"))
    registered: list[int] = []
    monkeypatch.setattr(easy, "register_autostart", lambda: registered.append(1))
    assert easy.cmd_in(args) == 0
    assert registered == [1]
    assert json.loads((data / easy.IN_STATE_NAME).read_text(encoding="utf-8"))["phase"] == "done"
    assert easy.read_pause(easy.sm.role_live_paths(data)["content"]) == "0"


def test_backup_copy_counts_only_this_scheduled_run(easy, tmp_path, monkeypatch):
    """상태 파일이 시작 뒤 '성공'이어도 예약 작업이 그 뒤에 돌지 않았다면(수동 실행 등) 이번 성공으로 보지 않는다."""
    from datetime import datetime, timedelta, timezone

    data = tmp_path / "data"
    data.mkdir()
    replica = tmp_path / "replica.txt"
    replica.write_text("\\\\nas\\backup", encoding="utf-8")
    monkeypatch.setattr(easy, "REPLICA_PATH", replica)
    started = datetime.now(timezone.utc)
    (data / "backup_replica_status.json").write_text(
        json.dumps({"state": "success", "last_attempt_at": (started + timedelta(seconds=5)).isoformat()}),
        encoding="utf-8",
    )
    monkeypatch.setattr(easy, "task_snapshot", lambda: _tasks(easy, running=False))
    monkeypatch.setattr(easy, "backup_task_run", lambda: (started - timedelta(days=1), 0))
    assert "확인하지 못했습니다" in easy.backup_copy_result(data, started, timeout=0.01)

    monkeypatch.setattr(easy, "backup_task_run", lambda: (started + timedelta(seconds=2), 0))
    assert easy.backup_copy_result(data, started, timeout=5) == "성공"
    # 등록 전에 이미 있던 실행(같은 시각)이면 이번 실행이 아니다.
    assert "확인하지 못했습니다" in easy.backup_copy_result(
        data, started, started + timedelta(seconds=2), timeout=0.01
    )


def _fake_in(easy, tmp_path, monkeypatch, *, extras: bool = False):
    """IN 을 이 PC 의 실제 설치 단계(drill 제외)로 돌리고 나머지 Windows 단계는 가짜로."""
    data = tmp_path / "data"
    data.mkdir(exist_ok=True)
    package = tmp_path / "pkg"
    _make_package(easy, package, {"machine_env": {}, "pause_original": "0", "network": []})
    if extras:
        (package / "db-backups" / "member").mkdir(parents=True)
        (package / "db-backups" / "member" / "b.db").write_bytes(b"backup")
    monkeypatch.setattr(easy, "task_snapshot", lambda: _tasks(easy, exists=False, enabled=False, running=False))
    monkeypatch.setattr(easy.sm, "port_listener_pids", lambda port: ([], True))
    monkeypatch.setattr(easy, "our_processes", lambda: [])
    monkeypatch.setattr(easy, "firewall_allows", lambda port: True)
    monkeypatch.setattr(easy, "time_zone", lambda: KST)
    monkeypatch.setattr(easy.sm, "check_drill_runtime", lambda: None)
    monkeypatch.setattr(
        easy.sm,
        "run_drill",
        lambda files, timeout: {
            "ok": True,
            "isolated_server": {"ready_checks": {role: "ok" for role in easy.sm.SET_ROLES}, "login": "ok", "process_stopped": True},
            "files": {},
        },
    )
    monkeypatch.setattr(easy.sm, "ensure_server_stopped", lambda port: {})
    monkeypatch.setattr(easy, "set_machine_env", lambda name, value: None)
    monkeypatch.setattr(easy, "REPLICA_PATH", tmp_path / "replica.txt")
    runtime = tmp_path / "python.txt"
    runtime.write_text(sys.executable, encoding="utf-8")
    monkeypatch.setattr(easy, "RUNTIME_PYTHON_FILE", runtime)
    monkeypatch.setattr(easy, "wait_ready", lambda port, timeout=180.0: True)
    monkeypatch.setattr(easy, "backup_copy_result", lambda *args, **kwargs: "건너뜀")
    monkeypatch.setattr(easy, "backup_task_run", lambda: (None, None))
    monkeypatch.setattr(easy, "register_autostart", lambda: None)
    args = argparse.Namespace(package=str(package), data_dir=str(data), port=8010, server_timeout=5, yes=True)
    return data, package, args


def test_in_resume_refuses_a_different_python(easy, tmp_path, monkeypatch):
    """색인은 처음 파이썬의 SQLite 로 다시 만들었다 — 다른 파이썬으로 이어 예약 서버가 되면 다시 어긋날 수 있다."""
    data, _package, args = _fake_in(easy, tmp_path, monkeypatch)
    monkeypatch.setattr(easy, "register_autostart", lambda: (_ for _ in ()).throw(easy.MoveError("등록 실패")))
    with pytest.raises(easy.MoveError, match="등록 실패"):
        easy.cmd_in(args)
    record = data / easy.IN_STATE_NAME
    state = json.loads(record.read_text(encoding="utf-8"))
    assert state["python"] == sys.executable
    state["python"] = "C:\\OtherPython\\python.exe"
    record.write_text(json.dumps(state), encoding="utf-8")

    with pytest.raises(easy.MoveError, match="같은 파이썬"):
        easy.cmd_in(args)


def _stop_after_install(easy, monkeypatch, args):
    """설치까지 하고 등록에서 멈춘 상태를 만든다 — 이어하기 기록(phase=installed)이 남는다."""
    monkeypatch.setattr(easy, "register_autostart", lambda: (_ for _ in ()).throw(easy.MoveError("등록 실패")))
    with pytest.raises(easy.MoveError, match="등록 실패"):
        easy.cmd_in(args)
    monkeypatch.setattr(easy, "register_autostart", lambda: None)


def test_in_resume_refuses_a_record_pointing_at_another_database(easy, tmp_path, monkeypatch):
    """manifest·파이썬이 같아도 기록이 다른 DB 를 가리키면 그 DB 를 바꾸게 된다 — 이어하지 않는다."""
    data, _package, args = _fake_in(easy, tmp_path, monkeypatch)
    _stop_after_install(easy, monkeypatch, args)
    record = data / easy.IN_STATE_NAME
    state = json.loads(record.read_text(encoding="utf-8"))
    state["targets"]["content"] = str(tmp_path / "elsewhere" / "content_hub.db")
    record.write_text(json.dumps(state), encoding="utf-8")

    with pytest.raises(easy.MoveError, match="완전하지 않습니다"):
        easy.cmd_in(args)


def test_in_resume_refuses_a_different_sqlite(easy, tmp_path, monkeypatch):
    data, _package, args = _fake_in(easy, tmp_path, monkeypatch)
    _stop_after_install(easy, monkeypatch, args)
    record = data / easy.IN_STATE_NAME
    state = json.loads(record.read_text(encoding="utf-8"))
    state["sqlite"] = "3.0.0"
    record.write_text(json.dumps(state), encoding="utf-8")

    with pytest.raises(easy.MoveError, match="같은 파이썬"):
        easy.cmd_in(args)


def test_undo_checks_the_whole_record_before_touching_anything(easy, tmp_path, monkeypatch):
    """작업 정보가 빠진 기록이면 멈춤 값만 되돌리고 작업 복구에서 깨진다 — 아무것도 바꾸기 전에 멈춘다."""
    data = tmp_path / "data"
    live = _make_live(easy, data)
    (data / easy.STATE_NAME).write_text(
        json.dumps({"phase": "stopped", "content_db": str(live["content"]), "pause_original": None, "tasks": {}}),
        encoding="utf-8",
    )
    monkeypatch.setattr(easy, "write_pause", lambda *a, **k: pytest.fail("기록을 확인하기 전에 썼다"))

    with pytest.raises(easy.MoveError, match="완전하지 않거나"):
        easy.cmd_undo_out(argparse.Namespace(state=None, data_dir=str(data), yes=True))


def test_undo_refuses_a_record_pointing_at_another_database(easy, tmp_path, monkeypatch):
    """기록이 다른 DB 를 가리키면 그 DB 의 멈춤만 풀고 실제 서버 DB 는 멈춘 채 작업만 다시 켜진다 — 멈춘다."""
    data = tmp_path / "data"
    _make_live(easy, data)
    other = tmp_path / "other" / "content_hub.db"
    _make_db(other, ROLE_TABLES["content"])
    (data / easy.STATE_NAME).write_text(
        json.dumps({"phase": "stopped", "content_db": str(other), "pause_original": None, "port": 8010, "tasks": _tasks(easy)}),
        encoding="utf-8",
    )
    monkeypatch.setattr(easy, "write_pause", lambda *a, **k: pytest.fail("다른 DB 에 썼다"))

    with pytest.raises(easy.MoveError, match="이 서버의 DB 와 다릅니다"):
        easy.cmd_undo_out(argparse.Namespace(state=None, data_dir=str(data), yes=True))


def test_in_resume_skips_worker_backups_it_already_copied_and_stops_on_different_ones(easy, tmp_path, monkeypatch):
    data, _package, args = _fake_in(easy, tmp_path, monkeypatch, extras=True)
    _stop_after_install(easy, monkeypatch, args)  # 작업자 백업까지 복사된 뒤 등록에서 멈춤
    copied = data / "db-backups" / "member" / "b.db"
    assert copied.read_bytes() == b"backup"

    copied.write_bytes(b"changed by someone")  # 지난번 것과 다르다 → 사람이 정해야 한다
    with pytest.raises(easy.MoveError, match="다릅니다"):
        easy.cmd_in(args)

    copied.write_bytes(b"backup")  # 지난번 그대로 → 조용히 넘어가고 끝까지
    monkeypatch.setattr(easy.sm, "_install_extras", lambda *a, **k: pytest.fail("이미 넣은 폴더를 다시 넣으려 했다"))
    assert easy.cmd_in(args) == 0


def test_in_reports_a_broken_record_instead_of_crashing(easy, tmp_path, monkeypatch):
    data, _package, args = _fake_in(easy, tmp_path, monkeypatch)
    (data / easy.IN_STATE_NAME).write_text("{not json", encoding="utf-8")

    with pytest.raises(easy.MoveError, match="읽지 못했습니다"):
        easy.cmd_in(args)


def test_in_resumes_when_copying_worker_backups_failed(easy, tmp_path, monkeypatch):
    """DB 설치 직후에 기록이 먼저 남는다 — 뒤의 작업자 백업 복사가 실패해도 다시 누르면 그 복사부터 이어진다."""
    data, _package, args = _fake_in(easy, tmp_path, monkeypatch, extras=True)
    real_extras = easy.sm._install_extras

    def copy_fails(*a, **k):
        raise OSError("복사 중 끊김")

    monkeypatch.setattr(easy.sm, "_install_extras", copy_fails)
    with pytest.raises(OSError, match="복사 중 끊김"):
        easy.cmd_in(args)
    assert json.loads((data / easy.IN_STATE_NAME).read_text(encoding="utf-8"))["phase"] == "installed"

    monkeypatch.setattr(easy.sm, "_install_extras", real_extras)
    monkeypatch.setattr(easy.sm, "install_set", lambda *a, **k: pytest.fail("설치를 다시 했다"))
    assert easy.cmd_in(args) == 0
    assert (data / "db-backups" / "member" / "b.db").read_bytes() == b"backup"
    assert json.loads((data / easy.IN_STATE_NAME).read_text(encoding="utf-8"))["phase"] == "done"


def test_move_bats_keep_their_arguments_when_asking_for_admin_rights():
    for name in ("server_move_OUT.bat", "server_move_IN.bat", "server_move_UNDO.bat"):
        text = (ROOT_DIR / name).read_text(encoding="ascii")
        assert 'set "MVHUB_ELEVATE_ARGS=%*"' in text, name
        assert "-ArgumentList $env:MVHUB_ELEVATE_ARGS" in text, name


# ------------------------------------------------------------ register_autostart.bat


def test_register_autostart_keeps_the_pinned_python_and_can_skip_every_pause():
    text = (ROOT_DIR / "register_autostart.bat").read_text(encoding="ascii")
    lines = [line.strip() for line in text.splitlines()]
    assert 'set "PYEXE=%MVHUB_SERVER_PYEXE%"' in lines  # 넘겨받은 파이썬 = 색인을 다시 만든 엔진
    assert 'set "MVHUB_CALLER_NO_PAUSE=%CONTENT_HUB_NO_PAUSE%"' in lines
    assert "pause" not in lines
    assert lines.count("if not defined MVHUB_CALLER_NO_PAUSE pause") >= 6

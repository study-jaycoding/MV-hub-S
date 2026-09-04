"""서버 이전 도구(tools/server_move.py) 계약.

가장 중요한 것은 '설치가 실패하면 기존 운영 DB 가 제자리에 그대로 있는가' 다.
그 다음이 '역할별 필수 테이블로 검사하는가'(기본값은 content 전용이라 trash·manage 를
잘못 통과시킨다)와 '서버가 멈춘 증거 없이는 진행하지 않는가' 다.
"""

from __future__ import annotations

import importlib.util
import json
import sqlite3
from contextlib import closing
from pathlib import Path

import pytest


def _module():
    path = Path(__file__).resolve().parents[2] / "tools" / "server_move.py"
    spec = importlib.util.spec_from_file_location("server_move", path)
    module = importlib.util.module_from_spec(spec)
    assert spec and spec.loader
    spec.loader.exec_module(module)
    return module


ROLE_TABLES = {
    "content": ("generation", "worker", "account", "project", "share"),
    "trash": ("trashed",),
    "manage": ("team_generation_fact",),
}


def _make_db(path: Path, tables: tuple[str, ...], rows: int = 1) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with closing(sqlite3.connect(path)) as conn:
        for table in tables:
            conn.execute(f'CREATE TABLE "{table}"(id INTEGER PRIMARY KEY, tag TEXT)')
            for i in range(rows):
                conn.execute(f'INSERT INTO "{table}"(tag) VALUES(?)', (f"{table}-{i}",))
        conn.commit()


def _make_live_set(db_dir: Path, tag: str = "old") -> dict[str, Path]:
    sm = _module()
    paths = {}
    for role, tables in ROLE_TABLES.items():
        name = str(sm.BACKUP_SET_MEMBERS[role]["restored_name"])
        target = db_dir / name
        _make_db(target, tables)
        with closing(sqlite3.connect(target)) as conn:
            conn.execute(f'UPDATE "{tables[0]}" SET tag = ?', (tag,))
            conn.commit()
        paths[role] = target
    return paths


def _make_package(package_dir: Path, stamp: str = "20260904_120000_000000") -> dict[str, Path]:
    sm = _module()
    files = {}
    for role, tables in ROLE_TABLES.items():
        name = f"{sm.BACKUP_SET_MEMBERS[role]['prefix']}{stamp}.db"
        target = package_dir / "db" / name
        _make_db(target, tables, rows=3)
        files[role] = target
    return files


def _tag_of(db_path: Path, table: str) -> str:
    with closing(sqlite3.connect(db_path)) as conn:
        return conn.execute(f'SELECT tag FROM "{table}" LIMIT 1').fetchone()[0]


def _sha(sm, package: dict[str, Path]) -> dict[str, str]:
    """드릴 직전에 기록하는 기대 해시."""
    return {role: sm._sha256(path) for role, path in package.items()}


# ------------------------------------------------------------ 역할별 필수 테이블


def test_required_tables_are_per_role_not_the_content_default():
    sm = _module()
    assert sm._required_tables("content") == {
        "generation",
        "worker",
        "account",
        "project",
        "share",
    }
    # trash/manage 에 content 기본값을 쓰면 정상 세트가 '필수 테이블 누락'으로 떨어진다.
    assert sm._required_tables("trash") == {"trashed"}
    assert sm._required_tables("manage") == {"team_generation_fact"}


def test_inspect_uses_role_tables_so_a_valid_trash_db_passes(tmp_path):
    sm = _module()
    trash = tmp_path / "content_hub_trash.db"
    _make_db(trash, ROLE_TABLES["trash"])
    info = sm.inspect_sqlite_database(trash, required_tables=sm._required_tables("trash"))
    assert info["table_counts"]["trashed"] == 1
    with pytest.raises(ValueError):
        sm.inspect_sqlite_database(trash, required_tables=sm._required_tables("content"))


# ------------------------------------------------------------ 경로 판정


def test_live_paths_follow_backup_set_member_names(tmp_path):
    sm = _module()
    paths = sm.role_live_paths(tmp_path)
    assert paths["content"].name == "content_hub.db"
    assert paths["trash"].name == "content_hub_trash.db"
    assert paths["manage"].name == "manage_hub.db"
    assert paths["content"].parent == tmp_path / "db"


def test_explicit_content_db_wins_over_environment(tmp_path, monkeypatch):
    sm = _module()
    monkeypatch.setenv("CONTENT_HUB_DB", str(tmp_path / "from-env.db"))
    chosen = sm.role_live_paths(tmp_path, content_db=tmp_path / "explicit.db")
    assert chosen["content"].name == "explicit.db"
    inherited = sm.role_live_paths(tmp_path)
    assert inherited["content"].name == "from-env.db"


def test_overlapping_package_and_data_dir_is_detected(tmp_path):
    sm = _module()
    data = tmp_path / "data"
    (data / "db").mkdir(parents=True)
    assert sm._overlaps(data / "sub", data) is True
    assert sm._overlaps(data, data / "sub") is True
    assert sm._overlaps(data, data) is True
    assert sm._overlaps(tmp_path / "elsewhere", data) is False


# ------------------------------------------------------------ manifest


def test_manifest_roundtrip_and_hash_mismatch_is_refused(tmp_path):
    sm = _module()
    package = tmp_path / "pkg"
    files = _make_package(package)
    payload = {
        "kind": sm.PACKAGE_KIND,
        "format": sm.PACKAGE_FORMAT,
        "files": {
            f"db/{path.name}": {
                "role": role,
                "bytes": path.stat().st_size,
                "sha256": sm._sha256(path),
            }
            for role, path in files.items()
        },
    }
    sm.write_manifest(package, payload)

    manifest = sm.read_manifest(package)
    resolved = sm.verify_manifest_files(package, manifest)
    assert set(resolved) == set(sm.SET_ROLES)

    # 한 바이트만 달라져도 설치로 넘어가지 않는다.
    victim = files["content"]
    with victim.open("r+b") as handle:
        handle.seek(victim.stat().st_size - 1)
        last = handle.read(1)
        handle.seek(victim.stat().st_size - 1)
        handle.write(bytes([last[0] ^ 0xFF]))
    with pytest.raises(sm.MoveError, match="SHA-256"):
        sm.verify_manifest_files(package, manifest)


def test_manifest_of_another_kind_is_refused(tmp_path):
    sm = _module()
    package = tmp_path / "pkg"
    package.mkdir()
    (package / sm.MANIFEST_NAME).write_text(
        json.dumps({"kind": "something-else", "format": 1}), encoding="utf-8"
    )
    with pytest.raises(sm.MoveError, match="서버 이전 패키지가 아닙니다"):
        sm.read_manifest(package)


def test_missing_manifest_points_at_the_backup_set_option(tmp_path):
    sm = _module()
    package = tmp_path / "pkg"
    package.mkdir()
    with pytest.raises(sm.MoveError, match="--backup-set"):
        sm.read_manifest(package)


# ------------------------------------------------------------ 서버 중지 판정


def _stub_stopped(sm, monkeypatch, *, tasks=None, procs=None, pids=None, ok=True):
    monkeypatch.setattr(sm.platform, "system", lambda: "Windows")
    monkeypatch.setattr(sm, "scheduled_task_states", lambda: (tasks or {}, ok))
    monkeypatch.setattr(sm, "running_server_processes", lambda: (procs or [], ok))
    monkeypatch.setattr(sm, "port_listener_pids", lambda port: (pids or [], ok))


def test_stopped_server_passes(monkeypatch):
    sm = _module()
    _stub_stopped(sm, monkeypatch, tasks={"MVHub Server": "Disabled"})
    report = sm.ensure_server_stopped(8010)
    assert report["processes"] == []


def test_enabled_scheduled_task_blocks_even_with_no_process(monkeypatch):
    sm = _module()
    _stub_stopped(sm, monkeypatch, tasks={"MVHub Server": "Ready"})
    with pytest.raises(sm.ServerActive, match="DISABLE"):
        sm.ensure_server_stopped(8010)


def test_live_process_blocks(monkeypatch):
    sm = _module()
    _stub_stopped(
        sm,
        monkeypatch,
        tasks={"MVHub Server": "Disabled"},
        procs=[{"pid": 42, "why": "serve.py", "command_line": "python serve.py"}],
    )
    with pytest.raises(sm.ServerActive, match="42"):
        sm.ensure_server_stopped(8010)


def test_failed_query_is_not_treated_as_stopped(monkeypatch):
    sm = _module()
    _stub_stopped(sm, monkeypatch, ok=False)
    with pytest.raises(sm.ServerActive, match="조회하지 못"):
        sm.ensure_server_stopped(8010)


def test_unknown_port_owner_blocks(monkeypatch):
    sm = _module()
    _stub_stopped(sm, monkeypatch, tasks={"MVHub Server": "Disabled"}, pids=[9999])
    with pytest.raises(sm.ServerActive, match="9999"):
        sm.ensure_server_stopped(8010)


# ------------------------------------------------------------ 설치와 롤백


def test_install_replaces_databases_and_keeps_the_old_ones(tmp_path, monkeypatch):
    sm = _module()
    data = tmp_path / "data"
    db_dir = data / "db"
    live = _make_live_set(db_dir, tag="old")
    package = _make_package(tmp_path / "pkg")
    monkeypatch.setattr(sm, "ensure_server_stopped", lambda port: {})

    result = sm.install_set(package, data, 8010, _sha(sm, package))

    assert _tag_of(live["content"], "generation") != "old"
    for role in sm.SET_ROLES:
        assert Path(result["targets"][role]).is_file()

    archive = Path(result["archive_dir"])
    assert archive.is_dir()
    assert (archive / "content_hub.db").is_file()
    assert _tag_of(archive / "content_hub.db", "generation") == "old"

    # 완료 기록은 db/ 에 남지 않는다 — 남으면 다음 실행을 막는다.
    assert not (db_dir / sm.JOURNAL_NAME).exists()
    assert json.loads((archive / "server_move.json").read_text(encoding="utf-8"))["state"] == (
        "committed"
    )


def test_install_into_a_fresh_pc_without_existing_databases(tmp_path, monkeypatch):
    sm = _module()
    data = tmp_path / "data"
    package = _make_package(tmp_path / "pkg")
    monkeypatch.setattr(sm, "ensure_server_stopped", lambda port: {})

    result = sm.install_set(package, data, 8010, _sha(sm, package))
    for role in sm.SET_ROLES:
        assert Path(result["targets"][role]).is_file()


def test_failed_verification_rolls_back_to_the_original_databases(tmp_path, monkeypatch):
    sm = _module()
    data = tmp_path / "data"
    db_dir = data / "db"
    live = _make_live_set(db_dir, tag="old")
    package = _make_package(tmp_path / "pkg")
    monkeypatch.setattr(sm, "ensure_server_stopped", lambda port: {})

    real_inspect = sm.inspect_sqlite_database
    calls = {"n": 0}

    def flaky(path, *, required_tables):
        calls["n"] += 1
        # 1~3 = staging 검사(통과), 4번째 = 설치 후 재검증에서 실패시킨다.
        if calls["n"] > len(sm.SET_ROLES):
            raise ValueError("강제 실패")
        return real_inspect(path, required_tables=required_tables)

    monkeypatch.setattr(sm, "inspect_sqlite_database", flaky)

    with pytest.raises(ValueError, match="강제 실패"):
        sm.install_set(package, data, 8010, _sha(sm, package))

    # 기존 DB 가 제자리에, 원래 내용 그대로 있어야 한다.
    for role, path in live.items():
        assert path.is_file(), f"{role} 이 사라졌다"
    assert _tag_of(live["content"], "generation") == "old"
    assert _tag_of(live["trash"], "trashed") == "old"
    assert _tag_of(live["manage"], "team_generation_fact") == "old"

    # 흔적을 남기지 않는다.
    assert not (db_dir / sm.JOURNAL_NAME).exists()
    assert not list(db_dir.glob(sm.STAGED_PREFIX + "*"))


def test_staging_failure_never_touches_the_live_databases(tmp_path, monkeypatch):
    sm = _module()
    data = tmp_path / "data"
    db_dir = data / "db"
    live = _make_live_set(db_dir, tag="old")
    package = _make_package(tmp_path / "pkg")
    monkeypatch.setattr(sm, "ensure_server_stopped", lambda port: {})

    # 패키지의 manage DB 를 SQLite 가 아닌 파일로 바꿔 staging 단계에서 깨뜨린다.
    package["manage"].write_bytes(b"not a database")

    with pytest.raises(Exception):
        sm.install_set(package, data, 8010, _sha(sm, package))

    assert _tag_of(live["content"], "generation") == "old"
    assert not (db_dir / sm.JOURNAL_NAME).exists()
    assert not list(db_dir.glob(sm.STAGED_PREFIX + "*"))
    assert not list(db_dir.glob(sm.ARCHIVE_PREFIX + "*"))


def test_leftover_journal_blocks_a_second_run(tmp_path, monkeypatch):
    sm = _module()
    data = tmp_path / "data"
    db_dir = data / "db"
    db_dir.mkdir(parents=True)
    (db_dir / sm.JOURNAL_NAME).write_text("{}", encoding="utf-8")
    package = _make_package(tmp_path / "pkg")
    monkeypatch.setattr(sm, "ensure_server_stopped", lambda port: {})

    with pytest.raises(sm.MoveError, match="끝나지 않았거나"):
        sm.install_set(package, data, 8010, _sha(sm, package))


def test_package_changed_after_the_drill_is_refused(tmp_path, monkeypatch):
    """검증한 바이트와 설치하는 바이트가 같아야 한다.

    드릴과 설치 사이에 NAS 동기화·다른 사람이 패키지를 바꾸면, 통과한 세트가 아니라
    다른 세트가 설치된다. 설치 후 검사는 새 staging 과 설치본만 비교하므로 못 잡는다.
    """
    sm = _module()
    data = tmp_path / "data"
    live = _make_live_set(data / "db", tag="old")
    package = _make_package(tmp_path / "pkg")
    monkeypatch.setattr(sm, "ensure_server_stopped", lambda port: {})

    expected = _sha(sm, package)
    # 드릴이 끝난 뒤 누군가 패키지를 바꾼 상황
    _make_db(package["content"].with_name("swapped.db"), ROLE_TABLES["content"], rows=99)
    package["content"].unlink()
    package["content"].with_name("swapped.db").rename(package["content"])

    with pytest.raises(sm.MoveError, match="검증 이후에 바뀌었습니다"):
        sm.install_set(package, data, 8010, expected)

    assert _tag_of(live["content"], "generation") == "old"
    assert not (data / "db" / sm.JOURNAL_NAME).exists()


def test_a_second_install_cannot_slip_past_the_journal_check(tmp_path, monkeypatch):
    """존재 확인과 생성이 따로면 두 설치가 동시에 통과한다. O_EXCL 로 선점한다."""
    sm = _module()
    data = tmp_path / "data"
    db_dir = data / "db"
    db_dir.mkdir(parents=True)
    package = _make_package(tmp_path / "pkg")
    monkeypatch.setattr(sm, "ensure_server_stopped", lambda port: {})

    sm._claim_journal(db_dir / sm.JOURNAL_NAME, {"state": "claimed", "stamp": "first"})
    with pytest.raises(sm.MoveError, match="다른 설치가 진행 중"):
        sm._claim_journal(db_dir / sm.JOURNAL_NAME, {"state": "claimed", "stamp": "second"})
    with pytest.raises(sm.MoveError):
        sm.install_set(package, data, 8010, _sha(sm, package))


def test_trash_follows_the_content_database_folder(tmp_path, monkeypatch):
    """휴지통은 data_dir 이 아니라 content DB 의 형제 파일이다(app/repo/trash.py)."""
    sm = _module()
    elsewhere = tmp_path / "elsewhere"
    elsewhere.mkdir()
    monkeypatch.setenv("CONTENT_HUB_DB", str(elsewhere / "content_hub.db"))
    paths = sm.role_live_paths(tmp_path / "data")
    assert paths["trash"].parent == elsewhere
    # manage 만은 DATA_DIR 기준이다(app/manage_db.py MANAGE_DB_PATH).
    assert paths["manage"].parent == tmp_path / "data" / "db"


def test_install_refuses_a_split_layout(tmp_path, monkeypatch):
    """세 DB 가 다른 폴더를 가리키면 일부만 교체되는 혼합 상태가 된다 — 아예 거부한다."""
    sm = _module()
    elsewhere = tmp_path / "elsewhere"
    elsewhere.mkdir()
    monkeypatch.setenv("CONTENT_HUB_DB", str(elsewhere / "content_hub.db"))
    package = _make_package(tmp_path / "pkg")
    monkeypatch.setattr(sm, "ensure_server_stopped", lambda port: {})

    with pytest.raises(sm.MoveError, match="다른 폴더"):
        sm.install_set(package, tmp_path / "data", 8010, _sha(sm, package))


def test_extras_are_actually_installed_not_just_carried(tmp_path):
    """export 가 담아 온 폴더를 설치하지 않으면 새 서버에서 비어 있다."""
    sm = _module()
    package = tmp_path / "pkg"
    (package / "db-backups" / "someone").mkdir(parents=True)
    (package / "db-backups" / "someone" / "a.db").write_bytes(b"x" * 10)
    data = tmp_path / "data"
    data.mkdir()

    assert sm._install_extras(package, data, True) == ["db-backups"]
    assert (data / "db-backups" / "someone" / "a.db").is_file()

    # 이미 있으면 덮어쓰지 않는다 — 합치는 규칙을 도구가 정하지 않는다.
    assert sm._install_extras(package, data, True) == []


# ------------------------------------------------------------ 드릴 판정


def test_drill_result_must_pass_every_check():
    sm = _module()
    good = {
        "ok": True,
        "isolated_server": {
            "ready_checks": {"content": "ok", "trash": "ok", "manage": "ok"},
            "login": "ok",
            "process_stopped": True,
        },
    }
    assert sm._drill_ok(good) is True

    for broken in (
        {**good, "ok": False},
        {**good, "isolated_server": {**good["isolated_server"], "login": "failed"}},
        {**good, "isolated_server": {**good["isolated_server"], "process_stopped": False}},
        {
            **good,
            "isolated_server": {
                **good["isolated_server"],
                "ready_checks": {"content": "ok", "trash": "failed", "manage": "ok"},
            },
        },
    ):
        assert sm._drill_ok(broken) is False

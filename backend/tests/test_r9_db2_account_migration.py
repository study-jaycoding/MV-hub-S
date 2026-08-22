"""R9 DB-2 — 기존 계정 DB 멱등 마이그레이션과 전환 공개 순서 계약."""

from __future__ import annotations

import sqlite3
import threading
from pathlib import Path

import pytest

from app import active_account, config, db
from app.routers import publish


EMAIL = "db2@example.com"
UID = "db2-uid"


@pytest.fixture
def isolated_accounts(tmp_path, monkeypatch):
    """실제 active.json·레거시 DB 와 분리된 로컬 계정 환경."""
    data_dir = tmp_path / "data"
    token = active_account.set_override(None)
    monkeypatch.delenv("CONTENT_HUB_DB", raising=False)
    monkeypatch.setattr(config, "AUTH_ENABLED", False)
    monkeypatch.setattr(config, "DATA_DIR", data_dir)
    monkeypatch.setattr(db, "DEFAULT_DB_PATH", data_dir / "db" / "content_hub.db")
    monkeypatch.setattr(db, "_LEGACY_DB_PATH", tmp_path / "missing-legacy.db")
    monkeypatch.setattr(active_account, "_POINTER", data_dir / "active.json")
    monkeypatch.setattr(active_account, "_cache", [False, None])
    monkeypatch.setattr(publish, "AUTH_ENABLED", False)
    monkeypatch.setattr(publish.agent_signals.agent_signals, "signal", lambda *_args: None)
    db.flush_pool()
    try:
        yield
    finally:
        db.flush_pool()
        active_account.reset_override(token)


def _create_legacy_account_db(path: Path) -> None:
    """초기 generation 스키마만 있고 후대 테이블·컬럼·기본 worker 가 없는 DB."""
    path.parent.mkdir(parents=True, exist_ok=True)
    with sqlite3.connect(path) as conn:
        conn.executescript(
            """
            CREATE TABLE worker (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                account_type TEXT NOT NULL DEFAULT 'personal'
            );
            CREATE TABLE generation (
                id TEXT PRIMARY KEY,
                worker_id TEXT NOT NULL REFERENCES worker(id),
                prompt TEXT NOT NULL,
                model TEXT,
                params TEXT,
                color TEXT,
                status TEXT NOT NULL DEFAULT 'pending',
                created_at TEXT NOT NULL DEFAULT (datetime('now'))
            );
            INSERT INTO worker(id, name, account_type)
            VALUES('legacy-worker', 'Legacy Worker', 'personal');
            INSERT INTO generation(id, worker_id, prompt, status)
            VALUES('legacy-generation', 'legacy-worker', 'keep me', 'done');
            """
        )


def _schema(path: Path) -> dict[str, set[str]]:
    with sqlite3.connect(path) as conn:
        tables = {
            row[0]
            for row in conn.execute(
                "SELECT name FROM sqlite_master "
                "WHERE type='table' AND name NOT LIKE 'sqlite_%'"
            )
        }
        return {
            table: {row[1] for row in conn.execute(f'PRAGMA table_info("{table}")')}
            for table in tables
        }


def test_existing_legacy_account_db_gets_full_schema_and_default_worker(
    isolated_accounts, tmp_path
):
    path = active_account.account_db_path(EMAIL)
    _create_legacy_account_db(path)
    expected_path = tmp_path / "expected-latest.db"
    db.init_db(expected_path)

    assert db.ensure_account_db(EMAIL, UID) == path

    expected_schema = _schema(expected_path)
    actual_schema = _schema(path)
    assert expected_schema.keys() <= actual_schema.keys()
    for table, expected_columns in expected_schema.items():
        assert expected_columns <= actual_schema[table], table

    with sqlite3.connect(path) as conn:
        assert conn.execute(
            "SELECT prompt, origin, workspace_scope FROM generation WHERE id=?",
            ("legacy-generation",),
        ).fetchone() == ("keep me", "local", "unknown")
        assert conn.execute(
            "SELECT name FROM worker WHERE id=?", (config.DEFAULT_WORKER_ID,)
        ).fetchone() == (config.DEFAULT_WORKER_NAME,)


def test_latest_account_db_reensure_preserves_data(isolated_accounts, monkeypatch):
    path = db.ensure_account_db(EMAIL, UID)
    with sqlite3.connect(path) as conn:
        conn.execute(
            "INSERT INTO app_setting(key, value) VALUES('db2-sentinel', 'preserved')"
        )
        conn.execute(
            "INSERT INTO worker(id, name, account_type) VALUES('custom', 'Custom', 'personal')"
        )

    init_paths: list[Path | None] = []
    real_init_db = db.init_db

    def observed_init(db_path=None):
        init_paths.append(db_path)
        return real_init_db(db_path)

    monkeypatch.setattr(db, "init_db", observed_init)
    assert db.ensure_account_db(EMAIL, UID) == path
    assert init_paths == [path]

    with sqlite3.connect(path) as conn:
        assert conn.execute(
            "SELECT value FROM app_setting WHERE key='db2-sentinel'"
        ).fetchone() == ("preserved",)
        assert conn.execute("SELECT name FROM worker WHERE id='custom'").fetchone() == (
            "Custom",
        )
        assert conn.execute(
            "SELECT COUNT(*) FROM worker WHERE id=?", (config.DEFAULT_WORKER_ID,)
        ).fetchone() == (1,)


def test_switch_migrates_under_lock_before_publishing_pointer(
    isolated_accounts, monkeypatch
):
    old_email = "old@example.com"
    active_account.set_active(old_email, "old-uid")
    target_path = active_account.account_db_path(EMAIL)
    _create_legacy_account_db(target_path)

    entered_migration = threading.Event()
    release_migration = threading.Event()
    migration_finished = threading.Event()
    switch_finished = threading.Event()
    errors: list[BaseException] = []
    real_init_db = db.init_db

    def blocking_init(db_path=None):
        entered_migration.set()
        if not release_migration.wait(2.0):
            raise TimeoutError("마이그레이션 해제 신호를 기다리다 시간 초과")
        result = real_init_db(db_path)
        migration_finished.set()
        return result

    monkeypatch.setattr(db, "init_db", blocking_init)

    def switch_account() -> None:
        try:
            publish._switch_account_db(EMAIL, UID)
        except BaseException as exc:  # 스레드 예외를 본 테스트로 전달
            errors.append(exc)
        finally:
            switch_finished.set()

    switcher = threading.Thread(target=switch_account)
    switcher.start()
    try:
        assert entered_migration.wait(2.0)
        assert active_account.account_key() == old_email
        assert db.get_db_path() == active_account.account_db_path(old_email)
        assert not switch_finished.is_set()
        assert not active_account.transition_lock.acquire(timeout=0.15)
    finally:
        release_migration.set()
        switcher.join(timeout=3.0)

    assert not switcher.is_alive()
    assert errors == []
    assert migration_finished.is_set()
    assert switch_finished.is_set()
    assert active_account.account_key() == EMAIL
    assert "share_state_intent" in _schema(target_path)
    with sqlite3.connect(target_path) as conn:
        assert conn.execute(
            "SELECT 1 FROM worker WHERE id=?", (config.DEFAULT_WORKER_ID,)
        ).fetchone() == (1,)

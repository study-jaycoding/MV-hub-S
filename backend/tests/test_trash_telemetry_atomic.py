"""TR-1/TR-2 — 휴지통 본체와 telemetry outbox의 단일 transaction-root 계약."""

from __future__ import annotations

import sqlite3

import pytest

from app import config, db, repo
from app.repo import manage, trash


@pytest.fixture
def trash_db(tmp_path, monkeypatch):
    monkeypatch.setenv("CONTENT_HUB_DB", str(tmp_path / "content_hub.db"))
    monkeypatch.setattr(config, "MANAGE_ENABLED", True)
    db.flush_pool()
    db.init_db()
    repo.ensure_default_worker()
    try:
        yield
    finally:
        db.flush_pool()


def _seed_generation(
    gen_id: str = "g1",
    *,
    job_id: str = "job-1",
    origin: str = "local",
    status: str = "done",
    sort_ts: float = 100.0,
) -> None:
    with db.get_connection() as conn:
        conn.execute(
            "INSERT INTO generation("
            "id, worker_id, prompt, model, status, created_at, sort_ts, job_id, origin"
            ") VALUES(?, 'me', 'prompt', 'model', ?, '1970-01-01 00:01:40', ?, ?, ?)",
            (gen_id, status, sort_ts, job_id, origin),
        )


def _ensure_outbox() -> None:
    with db.get_connection() as conn:
        manage._ensure_schema(conn)


def _fail_outbox_when(is_tombstone: int) -> None:
    """INSERT/UPSERT의 목표 상태에서 실제 SQLite 오류를 일으킨다."""
    with db.get_connection() as conn:
        conn.execute(
            "CREATE TRIGGER fail_telemetry_insert BEFORE INSERT ON telemetry_outbox "
            f"WHEN NEW.is_tombstone={is_tombstone} "
            "BEGIN SELECT RAISE(FAIL, 'injected telemetry upsert failure'); END"
        )
        conn.execute(
            "CREATE TRIGGER fail_telemetry_update BEFORE UPDATE ON telemetry_outbox "
            f"WHEN NEW.is_tombstone={is_tombstone} "
            "BEGIN SELECT RAISE(FAIL, 'injected telemetry upsert failure'); END"
        )


def _main_count(gen_id: str) -> int:
    with db.get_connection() as conn:
        return conn.execute(
            "SELECT COUNT(*) FROM generation WHERE id=?", (gen_id,)
        ).fetchone()[0]


def _outbox_row(gen_id: str):
    with db.get_connection() as conn:
        return conn.execute(
            "SELECT local_gen_id, dirty_rev, pushed_at, attempts, is_tombstone, "
            "tomb_job_id, tomb_snapshot FROM telemetry_outbox WHERE local_gen_id=?",
            (gen_id,),
        ).fetchone()


def _trash_ids() -> list[str]:
    return [item["id"] for item in trash.list_trash()]


def test_delete_tombstone_failure_rolls_back_generation_and_trash(trash_db):
    _seed_generation()
    _ensure_outbox()
    _fail_outbox_when(1)

    with pytest.raises(sqlite3.IntegrityError, match="injected telemetry upsert failure"):
        trash.move_to_trash("g1")

    assert _main_count("g1") == 1
    assert _trash_ids() == []
    assert _outbox_row("g1") is None


def test_delete_commits_generation_trash_and_tombstone_together(trash_db):
    _seed_generation()
    manage.mark_telemetry_dirty(["g1"])
    with db.get_connection() as conn:
        conn.execute(
            "UPDATE telemetry_outbox SET attempts=4, pushed_at='2026-08-22T00:00:00Z' "
            "WHERE local_gen_id='g1'"
        )

    assert trash.move_to_trash("g1") is True

    assert _main_count("g1") == 0
    assert _trash_ids() == ["g1"]
    row = _outbox_row("g1")
    assert row["is_tombstone"] == 1
    assert row["tomb_job_id"] == "job-1"
    assert row["dirty_rev"] == 2
    assert row["pushed_at"] is None
    assert row["attempts"] == 4


def test_stuck_synced_tombstone_failure_rolls_back_generation_and_trash(trash_db):
    _seed_generation(origin="synced", status="running")
    _ensure_outbox()
    _fail_outbox_when(1)

    with pytest.raises(sqlite3.IntegrityError, match="injected telemetry upsert failure"):
        trash.move_to_trash_if_stuck_synced("g1", "job-1", 200.0)

    assert _main_count("g1") == 1
    assert _trash_ids() == []
    assert _outbox_row("g1") is None


def test_restore_dirty_failure_rolls_back_generation_trash_and_tombstone(trash_db):
    _seed_generation()
    assert trash.move_to_trash("g1") is True
    before = tuple(_outbox_row("g1"))
    _fail_outbox_when(0)

    with pytest.raises(sqlite3.IntegrityError, match="injected telemetry upsert failure"):
        trash.restore_from_trash("g1")

    assert _main_count("g1") == 0
    assert _trash_ids() == ["g1"]
    assert tuple(_outbox_row("g1")) == before


def test_restore_commits_generation_and_tombstone_release_together(trash_db):
    _seed_generation()
    assert trash.move_to_trash("g1") is True
    with db.get_connection() as conn:
        conn.execute(
            "UPDATE telemetry_outbox SET attempts=7 WHERE local_gen_id='g1'"
        )

    assert trash.restore_from_trash("g1") is True

    assert _main_count("g1") == 1
    assert _trash_ids() == []
    row = _outbox_row("g1")
    assert row["is_tombstone"] == 0
    assert row["dirty_rev"] == 2
    assert row["pushed_at"] is None
    assert row["attempts"] == 7


def test_manage_off_delete_and_restore_do_not_create_sidecar(trash_db, monkeypatch):
    monkeypatch.setattr(config, "MANAGE_ENABLED", False)
    _seed_generation()

    with db.get_connection() as conn:
        assert conn.execute(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='telemetry_outbox'"
        ).fetchone() is None

    assert trash.move_to_trash("g1") is True
    assert trash.restore_from_trash("g1") is True

    with db.get_connection() as conn:
        assert conn.execute(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='telemetry_outbox'"
        ).fetchone() is None

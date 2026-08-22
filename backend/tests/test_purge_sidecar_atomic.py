"""P1: 휴지통 purge 선커밋 뒤 main DB 사이드카를 별도 정리하는 계약."""

from __future__ import annotations

import sqlite3

import pytest

from app import config, db, repo
from app.repo import manage, trash


@pytest.fixture
def purge_db(tmp_path, monkeypatch):
    monkeypatch.setenv("CONTENT_HUB_DB", str(tmp_path / "content_hub.db"))
    monkeypatch.setattr(config, "MANAGE_ENABLED", True)
    db.flush_pool()
    db.init_db()
    repo.ensure_default_worker()
    try:
        yield
    finally:
        db.flush_pool()


def _seed_trashed_generation_with_sidecar(gen_id: str = "g1") -> None:
    with db.get_connection() as conn:
        conn.execute(
            "INSERT INTO generation("
            "id, worker_id, prompt, model, status, created_at, sort_ts, job_id, origin"
            ") VALUES(?, 'me', 'prompt', 'model', 'done', "
            "'2026-08-22 00:00:00', 1, 'job-1', 'local')",
            (gen_id,),
        )
        manage._ensure_schema(conn)
        conn.execute(
            "INSERT INTO generation_metrics(gen_id, job_id) VALUES(?, 'job-1')",
            (gen_id,),
        )
        conn.execute(
            "INSERT INTO task_generation(task_id, gen_id) VALUES('task-1', ?)",
            (gen_id,),
        )
        conn.execute(
            "INSERT INTO final_export(gen_id, dest_path) VALUES(?, '/out/g1.png')",
            (gen_id,),
        )
    assert trash.move_to_trash(gen_id) is True


def _trash_count(gen_id: str = "g1") -> int:
    with sqlite3.connect(trash._trash_path()) as conn:
        return conn.execute(
            "SELECT COUNT(*) FROM trashed WHERE id=?", (gen_id,)
        ).fetchone()[0]


def _sidecar_counts(gen_id: str = "g1") -> tuple[int, int, int]:
    with db.get_connection() as conn:
        return tuple(
            conn.execute(
                f"SELECT COUNT(*) FROM {table} WHERE gen_id=?", (gen_id,)
            ).fetchone()[0]
            for table in ("generation_metrics", "task_generation", "final_export")
        )


def test_sidecar_delete_failure_keeps_trash_deleted_and_logs_warning(purge_db, caplog):
    _seed_trashed_generation_with_sidecar()
    with db.get_connection() as conn:
        # 마지막 DELETE에서 실패시켜 앞선 두 sidecar DELETE도 롤백됨을 검증한다.
        conn.execute(
            "CREATE TRIGGER fail_final_export_delete BEFORE DELETE ON final_export "
            "BEGIN SELECT RAISE(FAIL, 'injected sidecar delete failure'); END"
        )

    with caplog.at_level("WARNING", logger="mvhub.trash"):
        assert trash.purge_trashed_item("g1") is True

    assert _trash_count() == 0
    assert _sidecar_counts() == (1, 1, 1)
    assert "purge_sidecar_cleanup_failed gen_id=g1" in caplog.text


def test_purge_deletes_trash_then_all_sidecar(purge_db):
    _seed_trashed_generation_with_sidecar()

    assert trash.purge_trashed_item("g1") is True

    assert _trash_count() == 0
    assert _sidecar_counts() == (0, 0, 0)


def test_manage_off_purge_does_not_create_sidecar(purge_db, monkeypatch):
    monkeypatch.setattr(config, "MANAGE_ENABLED", False)
    with db.get_connection() as conn:
        assert conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name IN "
            "('generation_metrics','task_generation','final_export')"
        ).fetchall() == []
        conn.execute(
            "INSERT INTO generation("
            "id, worker_id, prompt, model, status, created_at, sort_ts, job_id, origin"
            ") VALUES('g-off', 'me', 'prompt', 'model', 'done', "
            "'2026-08-22 00:00:00', 1, 'job-off', 'local')"
        )

    assert trash.move_to_trash("g-off") is True
    assert trash.purge_trashed_item("g-off") is True

    with db.get_connection() as conn:
        assert conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name IN "
            "('generation_metrics','task_generation','final_export')"
        ).fetchall() == []

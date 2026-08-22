"""R9 웨이브 1의 취소·DB 스냅샷 계약 회귀 테스트."""

from __future__ import annotations

import asyncio
import io
import sqlite3
import threading
from contextlib import contextmanager
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock

import pytest
from fastapi import UploadFile

from app import db, main, manage_db
from app.routers import assets


def test_elapsed_lookup_missing_db_returns_empty_without_creating_file(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    missing = tmp_path / "not-created" / "manage_hub.db"
    missing.parent.mkdir()
    monkeypatch.setattr(manage_db, "MANAGE_DB_PATH", missing)

    assert manage_db.elapsed_by_job_ids(["job-missing"]) == {}
    assert not missing.exists()


def test_elapsed_lookup_existing_db_keeps_normal_query_behavior(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    path = tmp_path / "manage_hub.db"
    monkeypatch.setattr(manage_db, "MANAGE_DB_PATH", path)
    manage_db.init_manage_db()
    with manage_db.get_connection() as conn:
        conn.executemany(
            "INSERT INTO team_generation_fact"
            "(id,account_email,local_gen_id,job_id,workspace_scope,elapsed_seconds) "
            "VALUES(?,?,?,?,?,?)",
            [
                ("fact-1", "a@example.com", "gen-1", "job-a", "unknown", 3.5),
                ("fact-2", "b@example.com", "gen-2", "job-a", "unknown", 7.0),
                ("fact-3", "a@example.com", "gen-3", "job-null", "unknown", None),
            ],
        )

    assert manage_db.elapsed_by_job_ids(["job-a", "job-null", "job-a", ""]) == {
        "job-a": 7.0
    }


@pytest.mark.parametrize(
    ("route", "filename", "payload", "project"),
    [
        ("capture", "capture.png", b"capture-after-cancel", "captures"),
        ("reference-import", "reference.png", b"reference-after-cancel", "imports"),
    ],
)
def test_asset_commit_cancellation_still_invalidates_both_tree_caches(
    route: str,
    filename: str,
    payload: bytes,
    project: str,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    project_invalidate = Mock()
    combined_invalidate = Mock()

    async def commit_then_cancel(func, /, *args, **kwargs):
        target, reused = func(*args, **kwargs)
        assert target.is_file()
        assert reused is False
        raise asyncio.CancelledError

    monkeypatch.setattr(assets, "ASSETS_ROOT", tmp_path)
    monkeypatch.setattr(assets, "to_thread_non_abandon", commit_then_cancel)
    monkeypatch.setattr(assets.asset_tree, "invalidate_project_tree", project_invalidate)
    monkeypatch.setattr(assets.asset_tree, "invalidate_combined_tree", combined_invalidate)
    upload = UploadFile(filename=filename, file=io.BytesIO(payload))

    async def scenario() -> None:
        with pytest.raises(asyncio.CancelledError):
            if route == "capture":
                await assets.upload_capture(SimpleNamespace(), upload)
            else:
                await assets.upload_reference_import(SimpleNamespace(), files=[upload])

    asyncio.run(scenario())

    destination = tmp_path / project
    assert [path.read_bytes() for path in destination.iterdir()] == [payload]
    project_invalidate.assert_called_once_with(destination)
    combined_invalidate.assert_called_once_with(tmp_path, assets._INTERNAL_FOLDERS)


def test_worker_backup_bootstrap_survives_two_cancellations_until_work_finishes(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    started = threading.Event()
    release = threading.Event()
    worker_start = Mock()

    def slow_bootstrap() -> None:
        started.set()
        release.wait(timeout=2)

    monkeypatch.setattr(main, "queue_latest_local_backup", slow_bootstrap)
    monkeypatch.setattr(main.periodic_worker_backup, "start", worker_start)

    async def scenario() -> None:
        task = main._start_worker_backup_bootstrap()
        assert await asyncio.to_thread(started.wait, 1)
        task.cancel()
        await asyncio.sleep(0.01)
        assert not task.done()
        task.cancel()
        await asyncio.sleep(0.01)
        assert not task.done()
        release.set()
        with pytest.raises(asyncio.CancelledError):
            await task
        worker_start.assert_called_once_with()

    try:
        asyncio.run(scenario())
    finally:
        release.set()


@pytest.fixture
def pooled_db(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("CONTENT_HUB_DB", str(tmp_path / "content_hub.db"))
    db.flush_pool()
    monkeypatch.setattr(db, "_POOL_ENABLED", True)
    db.init_db()
    try:
        yield
    finally:
        db.flush_pool()


def test_pooled_connection_rolls_back_and_discards_on_cancelled_error(pooled_db) -> None:
    with pytest.raises(asyncio.CancelledError):
        with db.get_connection() as conn:
            conn.execute("BEGIN")
            conn.execute(
                "INSERT INTO app_setting(key,value) VALUES(?,?)",
                ("r9-cancelled", "must-rollback"),
            )
            raise asyncio.CancelledError

    with db.get_connection() as conn:
        assert conn.execute(
            "SELECT value FROM app_setting WHERE key=?", ("r9-cancelled",)
        ).fetchone() is None
        assert conn.in_transaction is False


def test_team_overview_uses_one_wal_snapshot_for_all_aggregates(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    path = tmp_path / "manage_hub.db"
    monkeypatch.setattr(manage_db, "MANAGE_DB_PATH", path)
    manage_db.init_manage_db()
    with manage_db.get_connection() as conn:
        conn.execute(
            "INSERT INTO team_generation_fact"
            "(id,account_email,local_gen_id,workspace_scope,creator_uid,project_id,"
            "folder_path,model,output_type,real_credits,is_final) "
            "VALUES(?,?,?,?,?,?,?,?,?,?,?)",
            (
                "before",
                "before@example.com",
                "gen-before",
                "unknown",
                "worker-before",
                "project-before",
                "ep01/sc01",
                "model-before",
                "image",
                1.0,
                1,
            ),
        )

    original_get_connection = manage_db.get_connection

    class InjectAfterFirstAggregate:
        def __init__(self, conn: sqlite3.Connection):
            self._conn = conn
            self.injected = False

        def execute(self, sql: str, parameters=()):
            cursor = self._conn.execute(sql, parameters)
            if not self.injected and "SELECT COUNT(*) AS count" in sql:
                self.injected = True
                with sqlite3.connect(path) as writer:
                    writer.execute(
                        "INSERT INTO team_generation_fact"
                        "(id,account_email,local_gen_id,workspace_scope,creator_uid,project_id,"
                        "folder_path,model,output_type,real_credits,is_final) "
                        "VALUES(?,?,?,?,?,?,?,?,?,?,?)",
                        (
                            "after",
                            "after@example.com",
                            "gen-after",
                            "unknown",
                            "worker-after",
                            "project-after",
                            "ep02/sc02",
                            "model-after",
                            "video",
                            2.0,
                            0,
                        ),
                    )
            return cursor

    @contextmanager
    def injecting_connection():
        with original_get_connection() as conn:
            yield InjectAfterFirstAggregate(conn)

    monkeypatch.setattr(manage_db, "get_connection", injecting_connection)
    overview = manage_db.team_overview()

    assert overview["totals"]["count"] == 1
    for key in (
        "by_worker",
        "by_project",
        "by_model",
        "by_output_type",
        "output_models",
        "worker_models",
        "project_models",
        "folder_efficiency",
        "matrix",
    ):
        assert sum(row["count"] for row in overview[key]) == 1
    with sqlite3.connect(path) as conn:
        assert conn.execute("SELECT COUNT(*) FROM team_generation_fact").fetchone()[0] == 2

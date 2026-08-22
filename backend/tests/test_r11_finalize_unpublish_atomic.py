"""R11 C1 — 서버 본체 finalize/unpublish 상태 전이의 원자성 계약."""

from __future__ import annotations

import importlib
import threading
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from types import SimpleNamespace

import pytest
from fastapi import HTTPException

from app import db, repo
from app.routers import share as share_router


share_repo = importlib.import_module("app.repo.share")


@pytest.fixture
def pooled_db(tmp_path, monkeypatch):
    """운영 기본인 스레드별 풀 ON에서 잠금·ROLLBACK·반납을 검증한다."""
    monkeypatch.setenv("CONTENT_HUB_DB", str(tmp_path / "content_hub.db"))
    db.flush_pool()
    monkeypatch.setattr(db, "_POOL_ENABLED", True)
    db.init_db()
    repo.ensure_default_worker()
    try:
        yield
    finally:
        db.flush_pool()


def _seed_generation(*, shared: bool) -> str:
    gen_id = repo.create_local_generation(
        {"model": "test-model", "prompt": "finalize/unpublish race"}, "me"
    )
    repo.set_status(gen_id, "done")
    if shared:
        repo.publish(gen_id, "me", "team")
    return gen_id


def _state(gen_id: str) -> tuple[bool, bool]:
    with db.get_connection() as conn:
        row = conn.execute(
            "SELECT g.is_final, "
            "EXISTS(SELECT 1 FROM share s WHERE s.generation_id=g.id) AS shared "
            "FROM generation g WHERE g.id=?",
            (gen_id,),
        ).fetchone()
    assert row is not None
    return bool(row["is_final"]), bool(row["shared"])


def _assert_pool_connection_clean() -> None:
    with db.get_connection() as conn:
        assert not conn.in_transaction


def _pause_after_locked_read(monkeypatch, sql_needle: str):
    """첫 root의 잠금 안 SELECT 직후 정지하고 둘째 BEGIN 시도를 관측한다."""
    original_get_connection = share_repo.get_connection
    read_reached = threading.Event()
    release_read = threading.Event()
    second_begin_attempted = threading.Event()
    state_lock = threading.Lock()
    state = {"begin_count": 0, "paused": False}

    class CursorProxy:
        def __init__(self, cursor, pause_on_fetch: bool):
            self._cursor = cursor
            self._pause_on_fetch = pause_on_fetch

        def fetchone(self):
            row = self._cursor.fetchone()
            if self._pause_on_fetch:
                with state_lock:
                    should_pause = not state["paused"]
                    state["paused"] = True
                if should_pause:
                    read_reached.set()
                    if not release_read.wait(5):
                        raise AssertionError("경합 테스트의 첫 transaction-root가 해제되지 않음")
            return row

        def __getattr__(self, name):
            return getattr(self._cursor, name)

    class ConnectionProxy:
        def __init__(self, conn):
            self._conn = conn

        def execute(self, sql, parameters=()):
            normalized = " ".join(sql.split())
            if normalized == "BEGIN IMMEDIATE":
                with state_lock:
                    state["begin_count"] += 1
                    if state["begin_count"] == 2:
                        second_begin_attempted.set()
            cursor = self._conn.execute(sql, parameters)
            return CursorProxy(cursor, sql_needle in normalized)

        def __getattr__(self, name):
            return getattr(self._conn, name)

    @contextmanager
    def intercepted_get_connection():
        with original_get_connection() as conn:
            yield ConnectionProxy(conn)

    monkeypatch.setattr(share_repo, "get_connection", intercepted_get_connection)
    return read_reached, release_read, second_begin_attempted


def _try_unpublish(gen_id: str) -> tuple[str, bool | None]:
    try:
        return "unpublished", repo.unpublish_generation_if_not_final(gen_id)
    except repo.FinalGenerationUnpublishError:
        return "blocked", None


def test_finalize_locked_read_serializes_unpublish(pooled_db, monkeypatch):
    """finalize가 먼저면 뒤의 unpublish는 최신 final을 보고 거절된다."""
    gen_id = _seed_generation(shared=True)
    read_reached, release_read, second_begin_attempted = _pause_after_locked_read(
        monkeypatch, "SELECT 1 FROM share WHERE generation_id=?"
    )

    with ThreadPoolExecutor(max_workers=2) as executor:
        finalize_future = executor.submit(
            repo.finalize_generation_with_share, gen_id, "me", "supervisor", "team"
        )
        assert read_reached.wait(2)
        unpublish_future = executor.submit(_try_unpublish, gen_id)
        assert second_begin_attempted.wait(2)
        assert not unpublish_future.done()
        release_read.set()
        assert finalize_future.result(timeout=5) is True
        assert unpublish_future.result(timeout=5) == ("blocked", None)

    assert _state(gen_id) == (True, True)


def test_unpublish_locked_read_serializes_finalize_and_share_is_recreated(
    pooled_db, monkeypatch
):
    """unpublish가 먼저면 삭제 커밋 뒤 finalize가 공유를 재생성하고 최종화한다."""
    gen_id = _seed_generation(shared=True)
    read_reached, release_read, second_begin_attempted = _pause_after_locked_read(
        monkeypatch, "SELECT g.is_final, EXISTS(SELECT 1 FROM share"
    )

    with ThreadPoolExecutor(max_workers=2) as executor:
        unpublish_future = executor.submit(_try_unpublish, gen_id)
        assert read_reached.wait(2)
        finalize_future = executor.submit(
            repo.finalize_generation_with_share, gen_id, "me", "supervisor", "team"
        )
        assert second_begin_attempted.wait(2)
        assert not finalize_future.done()
        release_read.set()
        assert unpublish_future.result(timeout=5) == ("unpublished", True)
        # 잠금 획득 뒤 share가 없음을 다시 읽고 재생성했다.
        assert finalize_future.result(timeout=5) is False

    assert _state(gen_id) == (True, True)


@pytest.mark.parametrize("operation", ["finalize", "unpublish"])
def test_transaction_roots_roll_back_and_leave_pool_clean(
    pooled_db, monkeypatch, operation
):
    """부분 쓰기 뒤 예외도 전부 ROLLBACK되고 풀 커넥션에 transaction이 남지 않는다."""
    gen_id = _seed_generation(shared=operation == "unpublish")
    original_get_connection = share_repo.get_connection

    class FailingConnectionProxy:
        def __init__(self, conn):
            self._conn = conn

        def execute(self, sql, parameters=()):
            normalized = " ".join(sql.split())
            if operation == "finalize" and "SET is_final=1" in normalized:
                # share INSERT 뒤 final UPDATE 직전에 실패한다.
                raise RuntimeError("injected finalize failure")
            cursor = self._conn.execute(sql, parameters)
            if operation == "unpublish" and normalized.startswith("DELETE FROM share"):
                # DELETE 실행 뒤 COMMIT 전에 실패한다.
                raise RuntimeError("injected unpublish failure")
            return cursor

        def __getattr__(self, name):
            return getattr(self._conn, name)

    @contextmanager
    def failing_get_connection():
        with original_get_connection() as conn:
            yield FailingConnectionProxy(conn)

    monkeypatch.setattr(share_repo, "get_connection", failing_get_connection)
    with pytest.raises(RuntimeError, match=f"injected {operation} failure"):
        if operation == "finalize":
            repo.finalize_generation_with_share(gen_id, "me", "supervisor")
        else:
            repo.unpublish_generation_if_not_final(gen_id)

    expected = (False, operation == "unpublish")
    assert _state(gen_id) == expected
    _assert_pool_connection_clean()


def test_local_unpublish_keeps_existing_final_409_contract(pooled_db, monkeypatch):
    gen_id = _seed_generation(shared=True)
    repo.set_final(gen_id, True, "supervisor")
    monkeypatch.setattr(share_router._proxy, "proxying", lambda: False)
    request = SimpleNamespace(state=SimpleNamespace(account=None))

    with pytest.raises(HTTPException) as raised:
        share_router.unpublish(gen_id, request)

    assert raised.value.status_code == 409
    assert raised.value.detail == share_router._FINAL_UNPUBLISH_DETAIL
    assert _state(gen_id) == (True, True)
    _assert_pool_connection_clean()


def test_transaction_roots_begin_before_their_first_select(pooled_db, monkeypatch):
    """R6 계약 회귀: 두 공개 root 모두 SELECT 전에 BEGIN IMMEDIATE를 실행한다."""
    gen_id = _seed_generation(shared=True)
    original_get_connection = share_repo.get_connection
    statements: list[str] = []

    class TracingConnectionProxy:
        def __init__(self, conn):
            self._conn = conn

        def execute(self, sql, parameters=()):
            statements.append(" ".join(sql.split()))
            return self._conn.execute(sql, parameters)

        def __getattr__(self, name):
            return getattr(self._conn, name)

    @contextmanager
    def tracing_get_connection():
        with original_get_connection() as conn:
            yield TracingConnectionProxy(conn)

    monkeypatch.setattr(share_repo, "get_connection", tracing_get_connection)
    repo.finalize_generation_with_share(gen_id, "me", "supervisor")
    assert statements[0] == "BEGIN IMMEDIATE"
    assert statements[1].startswith("SELECT 1 FROM share")

    statements.clear()
    repo.set_final(gen_id, False)
    repo.unpublish_generation_if_not_final(gen_id)
    assert statements[0] == "BEGIN IMMEDIATE"
    assert statements[1].startswith("SELECT g.is_final")
    _assert_pool_connection_clean()

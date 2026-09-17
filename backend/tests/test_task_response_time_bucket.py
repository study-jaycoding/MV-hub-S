"""조건부 작업 조회가 DB 변경 없이 지난 자동보관 시각도 다시 평가한다."""

from datetime import datetime, timezone
import gzip
import json
import sqlite3
from unittest.mock import Mock

import pytest
from fastapi import HTTPException
from starlette.requests import Request

from app import db
from app.repo import manage as repo_manage
from app.repo import manage_tasks
from app.routers import manage as manage_router


class VirtualClock:
    def __init__(self):
        self.elapsed = 1000.0
        self.sql_now_calls = {"datetime": 0, "date": 0}
        self.set("2026-01-30 23:59:10", elapsed=0)

    def set(self, value, *, elapsed=1):
        self.now = value
        self.epoch = datetime.strptime(value, "%Y-%m-%d %H:%M:%S").replace(tzinfo=timezone.utc).timestamp()
        self.elapsed += elapsed

    def time(self):
        return self.epoch

    def monotonic(self):
        return self.elapsed


@pytest.fixture
def clocked_tasks(tmp_path, monkeypatch):
    path = tmp_path / "content_hub.db"
    monkeypatch.setenv("CONTENT_HUB_DB", str(path))
    monkeypatch.setattr(manage_router, "AUTH_ENABLED", False)
    monkeypatch.setattr(manage_router, "_refresh_isolated_telemetry", lambda: None)
    monkeypatch.setattr(manage_router, "_TASK_RESPONSE_CACHE", {})
    monkeypatch.setattr(manage_tasks, "_TASK_READ_CACHE", {})
    # 기존 0.75초 TTL은 바꾸지 않고, 시각만 같은 가상 시계에서 공급한다.
    clock = VirtualClock()
    monkeypatch.setattr(manage_router, "time", clock)
    monkeypatch.setattr(manage_tasks, "time", clock)
    db.flush_pool()
    db.init_db()
    with db.get_connection() as conn:
        conn.execute("INSERT OR IGNORE INTO worker(id,name,account_type) VALUES('me','Synthetic worker','personal')")
        repo_manage._ensure_schema(conn)
        conn.execute("INSERT INTO project(id,name,kind,workspace_scope) VALUES('p1','Synthetic project','personal','personal')")
        conn.execute(
            "INSERT INTO generation(id,worker_id,prompt,status,creator_uid,project_id,folder_path,"
            "workspace_scope,created_at,sort_ts) VALUES('synthetic-gen','me','Synthetic prompt','done',"
            "'synthetic-uid','p1','before','personal','2026-01-01 00:00:00',1)"
        )
    db.flush_pool()
    reference = sqlite3.connect(":memory:")
    original_connect = db._connect

    def clocked_connect(*args, **kwargs):
        connection = original_connect(*args, **kwargs)
        for function in ("datetime", "date"):
            def call(*values, function=function):
                if "now" in values:
                    clock.sql_now_calls[function] += 1
                replaced = [clock.now if value == "now" else value for value in values]
                placeholders = ",".join("?" for _ in replaced)
                return reference.execute(f"SELECT {function}({placeholders})", replaced).fetchone()[0]
            connection.create_function(function, -1, call)
        return connection

    monkeypatch.setattr(db, "_connect", clocked_connect)
    try:
        yield clock
    finally:
        db.flush_pool()
        reference.close()


def request(etag=None, *, compressed=False):
    headers = [(b"host", b"127.0.0.1")]
    if etag:
        headers.append((b"if-none-match", etag.encode("ascii")))
    if compressed:
        headers.append((b"accept-encoding", b"gzip"))
    return Request({
        "type": "http", "method": "GET", "scheme": "http", "path": "/api/manage/tasks-batch",
        "query_string": b"", "headers": headers, "client": ("127.0.0.1", 1234), "server": ("127.0.0.1", 80),
    })


def fetch(etag=None, *, compressed=False, include_archived=False):
    return manage_router.list_tasks_batch(
        request(etag, compressed=compressed), ["p1"], include_archived=include_archived,
    )


def body(response):
    data = gzip.decompress(response.body) if response.headers.get("content-encoding") == "gzip" else response.body
    return json.loads(data)


def settled_response(**kwargs):
    # 최초 자동 폴더 작업 생성 자체가 DB를 변경하므로, 그 다음의 안정된 표식을 사용한다.
    fetch(**kwargs)
    return fetch(**kwargs)


def archived():
    with db.get_connection() as conn:
        return conn.execute("SELECT archived FROM project_task WHERE project_id='p1'").fetchone()[0]


def test_same_utc_minute_keeps_304_and_skips_task_read(clocked_tasks, monkeypatch):
    first = settled_response()
    before = manage_tasks._task_cache_stamp()
    clocked_tasks.set("2026-01-30 23:59:40", elapsed=30)
    read = Mock(side_effect=AssertionError("An unchanged conditional response must not rebuild tasks"))
    monkeypatch.setattr(repo_manage, "list_tasks_batch", read)
    response = fetch(first.headers["etag"])
    assert response.status_code == 304 and response.body == b""
    assert response.headers["etag"] == first.headers["etag"]
    assert manage_tasks._task_cache_stamp() == before
    read.assert_not_called()


def test_next_utc_minute_rechecks_without_database_write(clocked_tasks, monkeypatch):
    first = settled_response()
    before = manage_tasks._task_cache_stamp()
    clocked_tasks.set("2026-01-31 00:00:10", elapsed=60)
    assert manage_tasks._task_cache_stamp() == before
    read = Mock(wraps=repo_manage.list_tasks_batch)
    monkeypatch.setattr(repo_manage, "list_tasks_batch", read)
    response = fetch(first.headers["etag"])
    assert response.status_code == 200
    assert response.headers["etag"] != first.headers["etag"]
    read.assert_called_once()


def test_archive_deadline_really_updates_on_conditional_get(clocked_tasks):
    settled_response()
    with db.get_connection() as conn:
        # NULL 마감일은 date('now')를 건너뛰므로, 지난 마감일로 두 시계 함수 모두 검증한다.
        conn.execute("UPDATE project_task SET due_date='2026-01-30' WHERE project_id='p1'")
    first = settled_response()
    assert len(body(first)["p1"]) == 1 and archived() == 0
    before = manage_tasks._task_cache_stamp()
    clocked_tasks.sql_now_calls = {"datetime": 0, "date": 0}
    clocked_tasks.set("2026-01-31 00:00:10", elapsed=60)
    assert manage_tasks._task_cache_stamp() == before
    response = fetch(first.headers["etag"])
    assert response.status_code == 200
    assert body(response)["p1"] == [] and archived() == 1
    assert manage_tasks._task_cache_stamp() != before
    # 판정이 CURRENT_TIMESTAMP/strftime으로 바뀌어 실제 시계를 쓰면 조용히 통과하지 않는다.
    assert clocked_tasks.sql_now_calls["datetime"] > 0
    assert clocked_tasks.sql_now_calls["date"] > 0


def test_deadline_inside_same_minute_waits_for_next_bucket(clocked_tasks, monkeypatch):
    with db.get_connection() as conn:
        conn.execute("UPDATE generation SET created_at='2026-01-01 00:00:30' WHERE id='synthetic-gen'")
    # 보관 판정은 source + 30일 < now: 정확히 같은 시각에는 아직 보관하지 않는다.
    clocked_tasks.set("2026-01-31 00:00:30")
    first = settled_response()
    assert len(body(first)["p1"]) == 1 and archived() == 0
    before = manage_tasks._task_cache_stamp()
    read = Mock(wraps=repo_manage.list_tasks_batch)
    monkeypatch.setattr(repo_manage, "list_tasks_batch", read)

    clocked_tasks.set("2026-01-31 00:00:50", elapsed=20)
    response = fetch(first.headers["etag"])
    assert response.status_code == 304 and response.body == b""
    assert archived() == 0 and manage_tasks._task_cache_stamp() == before
    read.assert_not_called()

    clocked_tasks.set("2026-01-31 00:01:10", elapsed=20)
    response = fetch(first.headers["etag"])
    assert response.status_code == 200 and response.headers["etag"] != first.headers["etag"]
    assert body(response)["p1"] == [] and archived() == 1
    read.assert_called_once()


def test_database_write_invalidates_within_same_minute(clocked_tasks):
    first = settled_response()
    before = manage_tasks._task_cache_stamp()
    with db.get_connection() as conn:
        conn.execute("UPDATE project_task SET description='Synthetic immediate edit' WHERE project_id='p1'")
    assert manage_tasks._task_cache_stamp() != before
    response = fetch(first.headers["etag"])
    assert response.status_code == 200 and response.headers["etag"] != first.headers["etag"]
    assert body(response)["p1"][0]["description"] == "Synthetic immediate edit"


def test_wall_clock_backwards_reevaluates_and_reactivates(clocked_tasks):
    settled_response()
    clocked_tasks.set("2026-01-31 00:00:10", elapsed=60)
    first = settled_response()
    assert archived() == 1 and body(first)["p1"] == []
    before = manage_tasks._task_cache_stamp()
    clocked_tasks.set("2026-01-30 23:59:10", elapsed=1)
    assert manage_tasks._task_cache_stamp() == before
    response = fetch(first.headers["etag"])
    assert response.status_code == 200
    assert archived() == 0 and len(body(response)["p1"]) == 1


def test_gzip_and_short_task_cache_are_still_reused(clocked_tasks, monkeypatch):
    first = settled_response(compressed=True)
    read = Mock(wraps=manage_tasks._list_tasks_batch_uncached)
    monkeypatch.setattr(manage_tasks, "_list_tasks_batch_uncached", read)
    second = fetch(compressed=True)
    assert first.headers["content-encoding"] == "gzip"
    assert second.headers["cache-control"] == "private, no-cache"
    assert second.headers["vary"] == "Accept-Encoding"
    assert first.body is second.body
    assert body(first) == body(second)
    assert manage_tasks._TASK_READ_CACHE and manage_router._TASK_RESPONSE_CACHE
    read.assert_not_called()


def test_gzip_representation_has_its_own_etag(clocked_tasks):
    plain = settled_response()
    compressed = fetch(plain.headers["etag"], compressed=True)
    assert compressed.status_code == 200 and body(plain) == body(compressed)
    assert compressed.headers["etag"] != plain.headers["etag"]
    unchanged = fetch(compressed.headers["etag"], compressed=True)
    assert unchanged.status_code == 304 and "content-encoding" not in unchanged.headers


def test_archived_scope_has_its_own_etag(clocked_tasks):
    first = settled_response()
    response = fetch(first.headers["etag"], include_archived=True)
    assert response.status_code == 200
    assert response.headers["etag"] != first.headers["etag"]


@pytest.mark.parametrize("gate,status", [("_require_workspace_read", 401), ("_require_project_read", 403)])
def test_permission_checks_precede_conditional_response(clocked_tasks, monkeypatch, gate, status):
    first = settled_response()
    monkeypatch.setattr(manage_router, gate, Mock(side_effect=HTTPException(status, "Synthetic denied")))
    if status == 401:
        with pytest.raises(HTTPException) as error:
            fetch(first.headers["etag"])
        assert error.value.status_code == 401
    else:
        assert fetch(first.headers["etag"]) == {}

"""안쪽 연결 문맥은 자기가 열지 않은 트랜잭션을 끝내지 않는다(속도 점검 2-12).

요청 경로 연결은 스레드마다 같은 객체다. 바깥이 BEGIN IMMEDIATE 를 연 뒤 설정 읽기처럼 안쪽에서
get_connection() 을 쓰면, 예전에는 안쪽이 나가면서 바깥 트랜잭션을 COMMIT 해 버려 그 뒤의 확인·쓰기가
잠금 없이 문장마다 따로 커밋됐다(asset_backfill 의 _queue·_adopt_output).
"""
import sqlite3

import pytest

from app import active_account, db, repo
from app.services import asset_backfill, shared_connection
from app.shared_server_config import K_URL


@pytest.fixture
def content_db(tmp_path, monkeypatch):
    # 시험 기본값은 풀을 끈다(conftest) — 이 버그는 스레드별 풀 연결에서만 생기므로 여기서 켠다.
    monkeypatch.setattr(db, "_POOL_ENABLED", True)
    db.flush_pool()
    path = tmp_path / "content.db"
    monkeypatch.setenv("CONTENT_HUB_DB", str(path))
    db.init_db(path)
    yield path
    db.flush_pool()


def _value(path, key):
    # 다른 연결로 읽는다 — 커밋된 것만 보인다.
    with sqlite3.connect(str(path)) as other:
        row = other.execute("SELECT value FROM app_setting WHERE key=?", (key,)).fetchone()
    return row[0] if row else None


def test_inner_context_leaves_the_outer_transaction_open(content_db):
    with db.get_connection() as conn:
        conn.execute("BEGIN IMMEDIATE")
        conn.execute("INSERT INTO app_setting(key, value) VALUES('a', '1')")
        assert repo.get_setting("missing") is None  # 안쪽 get_connection
        assert conn.in_transaction  # 바깥 트랜잭션이 그대로다
        assert _value(content_db, "a") is None  # 아직 커밋 전
    assert _value(content_db, "a") == "1"  # 바깥이 끝낼 때 커밋


def test_outer_failure_rolls_back_writes_made_after_the_inner_call(content_db):
    with pytest.raises(RuntimeError):
        with db.get_connection() as conn:
            conn.execute("BEGIN IMMEDIATE")
            conn.execute("INSERT INTO app_setting(key, value) VALUES('before', '1')")
            repo.get_setting("missing")
            conn.execute("INSERT INTO app_setting(key, value) VALUES('after', '1')")
            raise RuntimeError("boom")
    assert _value(content_db, "before") is None
    assert _value(content_db, "after") is None


def test_inner_context_still_ends_a_transaction_it_opened(content_db):
    with db.get_connection() as outer:
        assert not outer.in_transaction
        repo.set_setting("inner", "1")  # 안쪽이 스스로 쓰고 끝낸다
        assert not outer.in_transaction
        assert _value(content_db, "inner") == "1"
        with db.get_connection() as inner:
            inner.execute("BEGIN IMMEDIATE")
            inner.execute("INSERT INTO app_setting(key, value) VALUES('own', '1')")
        assert not outer.in_transaction  # 안쪽이 연 트랜잭션은 안쪽이 커밋
        assert _value(content_db, "own") == "1"


def test_inner_failure_inside_the_outer_transaction_keeps_the_connection(content_db):
    with db.get_connection() as conn:
        conn.execute("BEGIN IMMEDIATE")
        conn.execute("INSERT INTO app_setting(key, value) VALUES('kept', '1')")
        with pytest.raises(ValueError):
            with db.get_connection() as inner:
                assert inner is conn
                raise ValueError("inner")
        # 안쪽은 롤백·연결 폐기를 하지 않았다 — 바깥이 같은 연결로 이어 쓴다.
        assert conn.in_transaction
        conn.execute("INSERT INTO app_setting(key, value) VALUES('later', '1')")
    assert _value(content_db, "kept") == "1"
    assert _value(content_db, "later") == "1"
    with db.get_connection() as again:
        assert again is conn  # 풀 연결이 버려지지 않았다


def test_backfill_queue_keeps_its_write_lock_after_reading_settings(content_db, monkeypatch):
    repo.set_setting(K_URL, "http://server")
    monkeypatch.setattr(active_account, "account_key", lambda: "acct")
    monkeypatch.setattr(active_account, "active_uid", lambda: "user_a")
    monkeypatch.setattr(shared_connection, "token", lambda: "tok")
    asset_backfill.reset()
    asset_backfill._scan.epoch = active_account.account_epoch()
    seen = []

    def queue(conn, gids, project_id, context):
        seen.append(conn.in_transaction)

    monkeypatch.setattr(asset_backfill.ledger, "queue_moved_outputs", queue)
    try:
        # _still() 이 base_url() → repo.get_setting(안쪽 연결)을 거친 뒤에도 BEGIN IMMEDIATE 안이어야 한다.
        assert asset_backfill._queue("g-1", "p-1", "user_a", "acct", "http://server")
    finally:
        asset_backfill.reset()
    assert seen == [True]

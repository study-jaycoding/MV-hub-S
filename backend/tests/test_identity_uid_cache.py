"""F-A-03 — 내 uid 캐시가 'DB 경로'와 'uid' 를 따로 적어, 계정 전환 경합에서 B 요청이 A 의 uid 를 받던 것.

임시 DB 두 개(A·B)만 쓴다. 요청마다 다른 DB 경로는 스레드별 get_db_path 로 흉내 낸다(계정 고정 라우트와 같은 꼴).
"""

import threading

import pytest

from app import db
from app.repo import identity


@pytest.fixture
def two_dbs(tmp_path, monkeypatch):
    paths = {}
    for name in ("A", "B"):
        path = tmp_path / f"{name}.db"
        db.init_db(path)
        with db.get_connection(path) as conn:
            conn.execute(
                "INSERT INTO app_setting(key, value) VALUES('my_creator_uid', ?)", (f"user_{name}",)
            )
        paths[name] = path
    tls = threading.local()
    monkeypatch.setattr(db, "get_db_path", lambda: tls.path)
    monkeypatch.setattr(identity, "_MY_UID_CACHE", [None])
    if hasattr(identity, "_MY_UID_PATH"):
        monkeypatch.setattr(identity, "_MY_UID_PATH", [None])
    return paths, tls


def test_uid_cache_never_pairs_one_db_with_another_uid(two_dbs, monkeypatch):
    paths, tls = two_dbs
    real_get_connection = identity.get_connection
    a_inside, b_done = threading.Event(), threading.Event()

    def gated(*args, **kwargs):
        # A 가 캐시 미스로 DB 를 읽기 직전에 멈추고, 그 사이 B 가 끝까지 돈다.
        if getattr(tls, "name", None) == "A" and not a_inside.is_set():
            a_inside.set()
            assert b_done.wait(5)
        return real_get_connection(*args, **kwargs)

    monkeypatch.setattr(identity, "get_connection", gated)
    results = {}

    def run(name):
        tls.path, tls.name = paths[name], name
        results[name] = identity.get_my_uid()

    thread_a = threading.Thread(target=run, args=("A",))
    thread_a.start()
    assert a_inside.wait(5)
    thread_b = threading.Thread(target=run, args=("B",))
    thread_b.start()
    thread_b.join(5)
    b_done.set()
    thread_a.join(5)
    assert results == {"A": "user_A", "B": "user_B"}

    # 뒤따르는 B 요청이 A 의 uid 를 받지 않는다
    tls.path, tls.name = paths["B"], "B-next"
    assert identity.get_my_uid() == "user_B"
    tls.path = paths["A"]
    assert identity.get_my_uid() == "user_A"


def test_uid_cache_invalidation_and_unknown_requery(two_dbs, tmp_path):
    paths, tls = two_dbs
    empty = tmp_path / "empty.db"
    db.init_db(empty)
    tls.path, tls.name = empty, "E"
    assert identity.get_my_uid() is None  # 미확정은 캐시하지 않는다
    identity.learn_my_creator_uid("user_E")
    assert identity.get_my_uid() == "user_E"

    tls.path = paths["A"]
    assert identity.get_my_uid() == "user_A"
    with db.get_connection(paths["A"]) as conn:
        conn.execute("UPDATE app_setting SET value='user_A2' WHERE key='my_creator_uid'")
    assert identity.get_my_uid() == "user_A"  # 확정값은 캐시
    identity._MY_UID_CACHE[0] = None  # 로그인·로그아웃·DB 복원이 쓰는 무효화 계약
    assert identity.get_my_uid() == "user_A2"

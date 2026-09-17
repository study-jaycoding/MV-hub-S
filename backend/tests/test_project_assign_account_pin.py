"""프로젝트 이동은 첫 프록시 판정부터 마지막 미러 요청까지 접수 계정에 고정한다."""
from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from types import SimpleNamespace

import pytest

from app import active_account, config, db, deps
from app.models import AssignProjectIn
from app.repo import manage as manage_repo
from app.routers import projects


A = "assign-a@example.test"
B = "assign-b@example.test"


@pytest.fixture
def accounts(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "AUTH_ENABLED", False)
    monkeypatch.setattr(deps, "AUTH_ENABLED", False)
    monkeypatch.setattr(projects, "AUTH_ENABLED", False)
    monkeypatch.setattr(projects, "MANAGE_ENABLED", False)
    pointer = [True, {"email": A, "uid": "a-uid"}]
    monkeypatch.setattr(active_account, "_cache", pointer)
    monkeypatch.setattr(active_account, "_POINTER", tmp_path / "unused-active.json")
    paths = {A: tmp_path / "a.db", B: tmp_path / "b.db"}
    key_token = active_account.set_override(None)
    # 공개 set_uid_override(None)은 '미로그인으로 고정'이다. 여기서는 고정 자체를 해제한다.
    uid_token = active_account._uid_override.set(None)
    try:
        for path in paths.values():
            db.init_db(path)
            with db.get_connection(path) as conn:
                manage_repo._ensure_schema(conn)
                conn.execute("INSERT OR IGNORE INTO worker(id,name,account_type) VALUES('me','Test','personal')")
                conn.execute("INSERT INTO project(id,name,kind,workspace_scope) VALUES('p1','Original','personal','personal')")
                conn.execute(
                    "INSERT INTO generation(id,worker_id,prompt,status,project_id,folder_path,workspace_scope) "
                    "VALUES('g1','me','Synthetic','done','p1','before','personal')"
                )
        monkeypatch.setattr(db, "get_db_path", lambda: paths[active_account.account_key()])
        yield pointer, paths
    finally:
        db.flush_pool()
        active_account.reset_uid_override(uid_token)
        active_account.reset_override(key_token)


def assert_transition_lock_is_free():
    # RLock이므로 요청과 다른 스레드에서 검사해야 '네트워크 대기 중 락 없음'을 증명한다.
    def try_lock():
        acquired = active_account.transition_lock.acquire(timeout=0.2)
        if acquired:
            active_account.transition_lock.release()
        return acquired

    with ThreadPoolExecutor(max_workers=1) as pool:
        assert pool.submit(try_lock).result(timeout=1)


@pytest.mark.parametrize("mirror_shared", [False, True])
def test_assign_stays_in_captured_account_across_both_proxy_requests(accounts, monkeypatch, mirror_shared):
    pointer, paths = accounts
    observed = []

    def proxying():
        observed.append(("proxying", active_account.account_key(), active_account.active_uid()))
        return True

    def proxy(method, endpoint, **kwargs):
        assert_transition_lock_is_free()
        observed.append((method, active_account.account_key(), active_account.active_uid()))
        if method == "GET":
            assert endpoint == "/api/projects"
            pointer[1] = {"email": B, "uid": "b-uid"}
            return {"projects": [{"id": "p1", "name": "A remote", "kind": "personal", "workspace_scope": "personal"}]}
        assert endpoint == "/api/projects/assign"
        return {"updated": 1}

    monkeypatch.setattr(projects._proxy, "proxying", proxying)
    monkeypatch.setattr(projects._proxy, "proxy_json", proxy)
    monkeypatch.setattr(projects.repo, "shared_generation_anchors", lambda ids: ["job1"] if mirror_shared else [])
    response = projects.assign_project(
        AssignProjectIn(generation_ids=["g1"], project_id="p1", folder_path="after"),
        SimpleNamespace(state=SimpleNamespace(account=None)),
    )

    assert response == {"ok": True, "updated": 1, "team_synced": True if mirror_shared else None}
    for stage, key, uid in observed:
        assert (key, uid) == (A, "a-uid"), stage
    with db.get_connection(paths[A]) as conn:
        assert conn.execute("SELECT folder_path FROM generation WHERE id='g1'").fetchone()[0] == "after"
        assert conn.execute("SELECT name FROM project WHERE id='p1'").fetchone()[0] == "A remote"
    with db.get_connection(paths[B]) as conn:
        assert conn.execute("SELECT folder_path FROM generation WHERE id='g1'").fetchone()[0] == "before"
        assert conn.execute("SELECT name FROM project WHERE id='p1'").fetchone()[0] == "Original"
    assert (active_account.account_key(), active_account.active_uid()) == (B, "b-uid")


@pytest.mark.parametrize("fails", [False, True])
def test_assign_team_early_return_or_exception_restores_outer_scope(accounts, monkeypatch, fails):
    pointer, _paths = accounts
    observed = []
    expected = {"ok": True, "updated": 1}

    def proxy(*args, **kwargs):
        assert_transition_lock_is_free()
        pointer[1] = {"email": B, "uid": "b-uid"}
        observed.append((active_account.account_key(), active_account.active_uid()))
        if fails:
            raise RuntimeError("synthetic proxy failure")
        return expected

    monkeypatch.setattr(projects._proxy, "proxying", lambda: True)
    monkeypatch.setattr(projects._proxy, "proxy_json", proxy)
    def assign():
        return projects.assign_project(
            AssignProjectIn(generation_ids=["g1"], project_id="p1"),
            SimpleNamespace(state=SimpleNamespace(account=None)), tab="team",
        )

    if fails:
        with pytest.raises(RuntimeError, match="synthetic"):
            assign()
    else:
        assert assign() is expected
    assert observed == [(A, "a-uid")]
    assert (active_account.account_key(), active_account.active_uid()) == (B, "b-uid")


def test_common_scope_nested_override_and_exception_restoration(accounts):
    pointer, _paths = accounts
    with active_account.pinned_account_scope() as captured:
        assert captured == A
        pointer[1] = {"email": B, "uid": "b-uid"}
        with pytest.raises(RuntimeError):
            with active_account.pinned_account_scope():
                assert active_account.capture_account_pin() == (A, "a-uid")
                raise RuntimeError("synthetic")
        assert active_account.capture_account_pin() == (A, "a-uid")
    assert active_account.capture_account_pin() == (B, "b-uid")


def test_common_scope_preserves_explicit_logged_out_override(accounts):
    with active_account.pinned_account_scope(("", None)):
        assert active_account.capture_account_pin() == ("", None)
        with active_account.pinned_account_scope():
            assert active_account.account_key() is None
            assert active_account.active_uid() is None
    assert active_account.capture_account_pin() == (A, "a-uid")


def test_common_scope_keeps_auth_server_single_database(accounts, monkeypatch):
    """서버 경로는 uid 포인터를 신원으로 읽지 않는다는 기존 assign 계약이 전제다."""
    monkeypatch.setattr(config, "AUTH_ENABLED", True)
    with active_account.pinned_account_scope():
        assert active_account.account_key() is None
        assert active_account.capture_account_pin() == ("", "a-uid")

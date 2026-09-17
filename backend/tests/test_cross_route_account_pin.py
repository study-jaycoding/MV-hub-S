"""공유·워크스페이스·렌더 폴더 쓰기는 첫 판정부터 응답까지 접수 계정을 쓴다.

원래 라우트/DB 선택자와 임시 SQLite를 사용한다. 전환 포인터와 원격 응답만 합성하며
AUTH-off 대조를 실서버 인증 또는 실제 네트워크 검증으로 확대하지 않는다.
"""
from concurrent.futures import ThreadPoolExecutor
import shutil
from types import SimpleNamespace

import pytest
from fastapi import HTTPException, Request

from app import active_account, config, db, db_paths, deps, repo
from app.repo import manage as repo_manage
from app.routers import generation, manage, publish
from app.services import project_folders


A = "cross-route-a@example.invalid"
B = "cross-route-b@example.invalid"
UIDS = {A: "a-uid", B: "b-uid"}
WORKSPACE = {"id": "new-workspace", "name": "New Workspace"}


def _request(path="/api/publish-to-shared", method="POST", account=None):
    request = Request({"type": "http", "method": method, "scheme": "http", "path": path,
                       "query_string": b"", "headers": [],
                       "client": ("127.0.0.1", 50001), "server": ("127.0.0.1", 8012)})
    request.state.account = account
    return request


def _lock_is_free():
    # RLock은 같은 스레드에서 다시 잡을 수 있으므로 별도 스레드로만 검사한다.
    def acquire():
        obtained = active_account.transition_lock.acquire(timeout=0.5)
        if obtained:
            active_account.transition_lock.release()
        return obtained
    with ThreadPoolExecutor(max_workers=1) as pool:
        assert pool.submit(acquire).result(timeout=2)


@pytest.fixture(scope="module")
def seed_db(tmp_path_factory):
    path = tmp_path_factory.mktemp("cross-route-seed") / "seed.db"
    db.init_db(path)
    with db.get_connection(path) as conn:
        repo_manage._ensure_schema(conn)
        for wid in ("me", *UIDS.values()):
            conn.execute("INSERT OR IGNORE INTO worker(id,name,account_type) VALUES(?,?,'personal')", (wid, wid))
    db.flush_pool()
    return path


@pytest.fixture
def hub(tmp_path, monkeypatch, seed_db):
    db.flush_pool()
    monkeypatch.setattr(config, "DATA_DIR", tmp_path / "data")
    monkeypatch.setattr(config, "AUTH_ENABLED", False)
    for module in (deps, publish, generation, manage):
        monkeypatch.setattr(module, "AUTH_ENABLED", False)
    monkeypatch.setattr(db_paths, "DEFAULT_DB_PATH", tmp_path / "single.db")
    monkeypatch.setattr(db, "_LEGACY_DB_PATH", tmp_path / "absent-legacy.db")
    monkeypatch.setenv("CONTENT_HUB_DB", "")
    monkeypatch.setattr(active_account, "_POINTER", tmp_path / "unused-pointer.json")
    pointer = [True, {"email": A, "uid": UIDS[A]}]
    monkeypatch.setattr(active_account, "_cache", pointer)
    key_token = active_account.set_override(None)
    uid_token = active_account._uid_override.set(None)
    paths = {email: active_account.account_db_path(email) for email in (A, B)}
    roots = {email: tmp_path / letter for email, letter in ((A, "a-root"), (B, "b-root"))}
    new_root = tmp_path / "new-root"
    for root, marker in [(roots[A], "A-old"), (roots[B], "B-old"), (new_root, "A-new")]:
        (root / "Render" / marker).mkdir(parents=True)
    for email, path in paths.items():
        path.parent.mkdir(parents=True)
        shutil.copyfile(seed_db, path)
        with db.get_connection(path) as conn:
            conn.execute("INSERT INTO project(id,name,kind,workspace_scope,render_root_path) VALUES('p1','Original','personal','personal',?)", (str(roots[email]),))
            conn.execute("INSERT INTO project(id,name,kind,workspace_scope,workspace_id,workspace_name) VALUES('target','Target','public','team',?,?)", (WORKSPACE["id"], WORKSPACE["name"]))
            conn.execute("INSERT INTO project_folder_link(project_id,root_path,selected_path) VALUES('p1',?,'before')", (str(roots[email]),))
            for gid in ("g1", "g2"):
                conn.execute("INSERT INTO generation(id,worker_id,prompt,status,project_id,folder_path,creator_uid,workspace_scope,job_id) "
                             "VALUES(?,'me',?,'done','p1','cuts',?,'personal',?)",
                             (gid, f"{email} {gid}", UIDS[email], f"job-{gid}"))
            conn.execute("INSERT INTO app_setting(key,value) VALUES('my_creator_uid',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", (UIDS[email],))

    def switch():
        with active_account.transition_lock:
            pointer[1] = {"email": B, "uid": UIDS[B]}

    def pair():
        return active_account.account_key(), active_account.active_uid()

    def snapshot(email):
        with db.get_connection(paths[email]) as conn:
            return {
                "generation": [dict(r) for r in conn.execute("SELECT id,prompt,creator_uid,workspace_scope,workspace_id,project_id,folder_path FROM generation ORDER BY id")],
                "share": [dict(r) for r in conn.execute("SELECT generation_id,shared_by FROM share ORDER BY generation_id")],
                "project": [dict(r) for r in conn.execute("SELECT id,render_root_path FROM project WHERE id='p1'")],
                "link": [dict(r) for r in conn.execute("SELECT project_id,root_path,selected_path FROM project_folder_link")],
            }

    def assert_outer(email):
        assert pair() == (email, UIDS[email])
        assert active_account._override.get() is None
        assert active_account._uid_override.get() is None
        assert db.get_db_path() == paths[email]  # 원래 DB selector: no monkeypatch.

    def no_network(*args, **kwargs):
        raise AssertionError("Unexpected real proxy call in isolated fixture")

    monkeypatch.setattr(publish._proxy, "proxy_json", no_network)
    monkeypatch.setattr(publish, "publish_bundle_to_server", no_network)
    monkeypatch.setattr(publish, "_touch_telemetry", lambda gid: None)
    monkeypatch.setattr(generation, "drain_isolated_telemetry", lambda: None)
    project_folders.invalidate_project_folder("p1")
    try:
        yield SimpleNamespace(paths=paths, roots=roots, new_root=new_root, pointer=pointer,
                              switch=switch, pair=pair, snapshot=snapshot, assert_outer=assert_outer)
    finally:
        project_folders.invalidate_project_folder("p1")
        db.flush_pool()
        active_account.reset_uid_override(uid_token)
        active_account.reset_override(key_token)


def _prepare(hub, kind, layout="same"):
    if kind == "workspace":
        for email, path in hub.paths.items():
            with db.get_connection(path) as conn:
                if email == B and layout != "foreign":
                    conn.execute("UPDATE generation SET creator_uid=?", (UIDS[A],))
                conn.execute("INSERT INTO share(id,generation_id,shared_by,visibility) VALUES('s1','g1','me','team')")
    if layout == "missing":
        with db.get_connection(hub.paths[B]) as conn:
            conn.execute("DELETE FROM share")
            conn.execute("DELETE FROM generation")
            conn.execute("DELETE FROM project_folder_link")
            conn.execute("DELETE FROM project")


def _invoke(kind, hub):
    if kind == "publish":
        return publish.publish_to_shared(publish.PublishToSharedIn(gen_ids=["g1", "g2"]), _request())
    if kind == "workspace":
        return generation.set_generation_workspace_batch(
            generation.GenerationWorkspaceBatchIn(generation_ids=["g1"], operation="assign", workspace_id=WORKSPACE["id"]),
            _request("/api/generations/workspace/batch", "PUT"))
    return manage.put_project_folder("p1", manage.ProjectFolderIn(root_path=str(hub.new_root), selected_path="A-new"),
                                     _request("/api/manage/project-folders/p1", "PUT"))


CASES = [("publish", "same"), ("publish", "missing"), ("workspace", "same"),
         ("workspace", "foreign"), ("workspace", "missing"), ("folder", "same"), ("folder", "missing")]


@pytest.mark.parametrize("kind,layout", CASES)
def test_transition_after_snapshot_or_proxy_only_writes_and_refetches_a(hub, monkeypatch, kind, layout):
    _prepare(hub, kind, layout)
    before_b = hub.snapshot(B)
    observed = []
    monkeypatch.setattr(publish._proxy, "proxying", lambda: kind != "publish")

    def transition(stage):
        _lock_is_free()
        observed.append((stage + "-before", hub.pair()))
        hub.switch()
        observed.append((stage + "-after", hub.pair()))

    def proxy(method, endpoint, **kwargs):
        _lock_is_free()
        if method == "GET":
            return dict(WORKSPACE)
        transition(method)
        return {"workspace": dict(WORKSPACE)} if kind == "workspace" else {"ok": True}

    def telemetry(gid):
        if gid == "g1":
            transition("first-publish")

    monkeypatch.setattr(publish._proxy, "proxy_json", proxy)
    monkeypatch.setattr(publish, "_touch_telemetry", telemetry)
    response = _invoke(kind, hub)
    assert hub.snapshot(B) == before_b
    after_a = hub.snapshot(A)
    if kind == "publish":
        assert [row["generation_id"] for row in after_a["share"]] == ["g1", "g2"]
        assert response == {"ok": True, "published": 2, "remote": {}}
    elif kind == "workspace":
        assert after_a["generation"][0]["workspace_id"] == WORKSPACE["id"]
        assert after_a["generation"][0]["project_id"] == "target"
        assert response["updates"][0]["generation"]["prompt"] == f"{A} g1"
        assert response["changed"] == ["g1"]
    else:
        assert after_a["project"][0]["render_root_path"] == str(hub.new_root)
        assert after_a["link"][0]["selected_path"] == "A-new"
        assert response["root_path"] == str(hub.new_root)
        if layout == "same":
            # 캐시는 pid 전역이다. saved_root 비교가 B 조회를 A 트리로 오염시키지 않음만 검사한다.
            b_state = project_folders.project_folder_state("p1")
            assert b_state["root_path"] == str(hub.roots[B])
            assert [node["name"] for node in b_state["tree"]["children"]] == ["B-old"]
    assert observed and all(pair == (A, UIDS[A]) for _, pair in observed)
    hub.assert_outer(B)


@pytest.mark.parametrize("kind", ["publish", "workspace", "folder"])
def test_normal_request_keeps_response_and_b_unchanged(hub, monkeypatch, kind):
    _prepare(hub, kind)
    before_a, before_b = hub.snapshot(A), hub.snapshot(B)
    monkeypatch.setattr(publish._proxy, "proxying", lambda: kind != "publish")

    def proxy(method, endpoint, **kwargs):
        _lock_is_free()
        assert hub.pair() == (A, UIDS[A])
        return dict(WORKSPACE) if method == "GET" else {"workspace": dict(WORKSPACE)}

    monkeypatch.setattr(publish._proxy, "proxy_json", proxy)
    response = _invoke(kind, hub)
    assert hub.snapshot(A) != before_a and hub.snapshot(B) == before_b
    assert (response.get("published") == 2 if kind == "publish" else
            response.get("changed") == ["g1"] if kind == "workspace" else
            response.get("root_path") == str(hub.new_root))
    hub.assert_outer(A)


@pytest.mark.parametrize("kind", ["publish", "workspace", "folder"])
def test_pair_is_pinned_before_the_first_dependency(hub, monkeypatch, kind):
    observed = []
    def first(*args, **kwargs):
        observed.append((active_account._override.get(), active_account._uid_override.get()))
        hub.switch()
        observed.append(hub.pair())
        raise RuntimeError("first dependency sentinel")
    module, attr = {"publish": (publish._proxy, "proxying"),
                    "workspace": (generation, "_resolve_workspace_target"),
                    "folder": (manage, "_require_project_manage")}[kind]
    monkeypatch.setattr(module, attr, first)
    with pytest.raises(RuntimeError, match="first dependency"):
        _invoke(kind, hub)
    assert observed == [(A, (UIDS[A],)), (A, UIDS[A])]
    hub.assert_outer(B)


@pytest.mark.parametrize("kind", ["publish", "workspace", "folder"])
@pytest.mark.parametrize("status", [401, 502])
def test_proxy_failure_has_no_local_write_and_restores_real_pointer(hub, monkeypatch, kind, status):
    _prepare(hub, kind)
    initial = {email: hub.snapshot(email) for email in (A, B)}
    observed = []
    monkeypatch.setattr(publish._proxy, "proxying", lambda: True)

    def fail():
        _lock_is_free()
        hub.switch()
        observed.append(hub.pair())
        raise HTTPException(status_code=status, detail="synthetic upstream failure")
    def proxy(method, endpoint, **kwargs):
        if method == "GET":
            return dict(WORKSPACE)
        return fail()
    monkeypatch.setattr(publish._proxy, "proxy_json", proxy)
    monkeypatch.setattr(publish, "publish_bundle_to_server", lambda ids: fail())
    with pytest.raises(HTTPException) as caught:
        _invoke(kind, hub)
    assert caught.value.status_code == status
    assert {email: hub.snapshot(email) for email in (A, B)} == initial
    assert observed == [(A, UIDS[A])]
    hub.assert_outer(B)


@pytest.mark.parametrize("invalid,status", [("foreign", 403), ("missing", 404)])
def test_workspace_rechecks_a_ownership_and_existence_without_remote_write(hub, monkeypatch, invalid, status):
    _prepare(hub, "workspace")
    with db.get_connection(hub.paths[B]) as conn:
        conn.execute("UPDATE generation SET creator_uid=?", (UIDS[B],))
    with db.get_connection(hub.paths[A]) as conn:
        if invalid == "foreign":
            conn.execute("UPDATE generation SET creator_uid=? WHERE id='g1'", (UIDS[B],))
        else:
            conn.execute("DELETE FROM share WHERE generation_id='g1'")
            conn.execute("DELETE FROM generation WHERE id='g1'")
    before = {email: hub.snapshot(email) for email in (A, B)}
    calls = []
    monkeypatch.setattr(publish._proxy, "proxying", lambda: True)
    def proxy(method, endpoint, **kwargs):
        calls.append(method)
        assert method == "GET"
        _lock_is_free()
        hub.switch()  # 실제 A 요청이 B의 유효한 행으로 권한 검사를 우회하면 안 된다.
        return dict(WORKSPACE)
    monkeypatch.setattr(publish._proxy, "proxy_json", proxy)
    with pytest.raises(HTTPException) as caught:
        _invoke("workspace", hub)
    assert caught.value.status_code == status
    assert calls == ["GET"]
    assert {email: hub.snapshot(email) for email in (A, B)} == before
    hub.assert_outer(B)


def test_real_folder_publish_nests_the_same_key_uid_pair(hub, monkeypatch):
    monkeypatch.setattr(publish._proxy, "proxying", lambda: False)
    monkeypatch.setattr(publish, "_FOLDER_SHARE_CHUNK", 1)
    before_b = hub.snapshot(B)
    observed = []
    def telemetry(gid):
        _lock_is_free()
        hub.switch()
        observed.append((gid, hub.pair()))
    monkeypatch.setattr(publish, "_touch_telemetry", telemetry)
    response = publish.publish_folder_to_shared(
        publish.PublishFolderToSharedIn(project_id="p1", folder_path="cuts"), _request())
    assert response["accepted"] == response["published"] == 2
    assert response["error"] is None
    assert len(observed) == 2 and all(pair == (A, UIDS[A]) for _, pair in observed)
    assert hub.snapshot(B) == before_b
    assert [r["generation_id"] for r in hub.snapshot(A)["share"]] == ["g1", "g2"]
    assert "p1\ncuts" not in publish._FOLDER_SHARE_INFLIGHT
    hub.assert_outer(B)


def test_local_publish_partial_success_and_exception_restore_scope(hub, monkeypatch):
    before_b = hub.snapshot(B)
    monkeypatch.setattr(publish._proxy, "proxying", lambda: False)
    def fail(gid):
        hub.switch()
        raise RuntimeError("synthetic telemetry failure")
    monkeypatch.setattr(publish, "_touch_telemetry", fail)
    with pytest.raises(RuntimeError, match="telemetry failure"):
        _invoke("publish", hub)
    assert [r["generation_id"] for r in hub.snapshot(A)["share"]] == ["g1"]
    assert hub.snapshot(B) == before_b
    hub.assert_outer(B)


def test_auth_on_uses_original_single_database_selector(hub, monkeypatch):
    db.flush_pool()
    shutil.copyfile(hub.paths[A], db_paths.DEFAULT_DB_PATH)
    for module in (config, deps, publish):
        monkeypatch.setattr(module, "AUTH_ENABLED", True)
    monkeypatch.setattr(publish._proxy, "proxying", lambda: False)
    initial = {email: hub.snapshot(email) for email in (A, B)}
    observed = []
    def telemetry(gid):
        hub.switch()
        observed.append((hub.pair(), db.get_db_path()))
    monkeypatch.setattr(publish, "_touch_telemetry", telemetry)
    response = publish.publish_to_shared(publish.PublishToSharedIn(gen_ids=["g1", "g2"]),
                                        _request(account={"creator_uid": UIDS[A]}))
    assert response["published"] == 2
    with db.get_connection(db_paths.DEFAULT_DB_PATH) as conn:
        assert conn.execute("SELECT COUNT(*) FROM share").fetchone()[0] == 2
    assert {email: hub.snapshot(email) for email in (A, B)} == initial
    assert all(pair == (None, UIDS[A]) and path == db_paths.DEFAULT_DB_PATH for pair, path in observed)
    assert active_account.account_key() is None and active_account.active_uid() == UIDS[B]
    assert active_account._override.get() is None and active_account._uid_override.get() is None
    assert hub.pointer[1] == {"email": B, "uid": UIDS[B]}


def test_key_only_outer_override_retains_the_documented_mixed_uid_limit(hub, monkeypatch):
    """상류는 반드시 key/uid를 함께 고정해야 한다. 이번 변경은 key-only 계약을 확장하지 않는다."""
    hub.switch()
    token = active_account.set_override(A)
    observed = []
    try:
        def proxying():
            observed.append((hub.pair(), db.get_db_path()))
            return False
        monkeypatch.setattr(publish._proxy, "proxying", proxying)
        result = publish.publish_to_shared(publish.PublishToSharedIn(gen_ids=[]), _request())
        assert result["published"] == 0
        assert observed == [((A, UIDS[B]), hub.paths[A])]
        assert active_account._override.get() == A and active_account._uid_override.get() is None
    finally:
        active_account.reset_override(token)
    hub.assert_outer(B)

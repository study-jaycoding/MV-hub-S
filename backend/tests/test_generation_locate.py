"""Resolve 라이브러리 따라보기 — 실제 임시 DB의 목록 가시성/ID 경계 및 HTTP 계약."""

from unittest.mock import Mock

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
from starlette.requests import Request

from app import active_account, config, db, deps, repo
from app.mutation_notify import notification_domains
from app.routers import _proxy, library
from app.usecases.generation_locate import _pick_location


@pytest.fixture
def catalog(tmp_path, monkeypatch):
    # 모듈 실행 환경도 임시 CONTENT_HUB_DATA다. 각 시험은 자기 tmp_path DB만 연다.
    path = tmp_path / "content_hub.db"
    monkeypatch.setattr(db, "get_db_path", lambda: path)
    monkeypatch.setattr(active_account, "_cache", [True, None])
    monkeypatch.setattr(_proxy, "proxying", lambda: False)
    monkeypatch.setattr(_proxy, "proxy_json", Mock(side_effect=AssertionError("unexpected network")))
    monkeypatch.setattr(library, "AUTH_ENABLED", True)
    monkeypatch.setattr(deps, "AUTH_ENABLED", True)
    db.flush_pool()
    db.init_db(path)
    repo.ensure_default_worker()
    with db.get_connection() as conn:
        conn.executemany(
            "INSERT INTO worker(id,name,account_type) VALUES(?,?,'team')",
            [("viewer", "Viewer"), ("other", "Other")],
        )
        conn.executemany(
            "INSERT INTO project(id,name,kind,archived) VALUES(?,?, 'team',0)",
            [("p", "Project"), ("q", "Other")],
        )
        conn.execute(
            "INSERT INTO project_member(project_id,creator_uid,project_role) VALUES('p','viewer','creator')"
        )

    def add(gen_id, *, owner="viewer", project="p", folder="e001/c0010", shared=False,
            deleted=False, final=False, sort=1.0, job_id=None, origin="local",
            workspace_scope="unknown", workspace_id=None):
        with db.get_connection() as conn:
            conn.execute(
                "INSERT INTO generation(id,worker_id,prompt,status,created_at,sort_ts,creator_uid,"
                "project_id,folder_path,job_id,origin,deleted_at,is_final) "
                "VALUES(?,'me',?,'done','2026-09-16',?,?,?,?,?,?,?,?)",
                (gen_id, gen_id, sort, owner, project, folder, job_id, origin,
                 "2026-09-16" if deleted else None, int(final)),
            )
            conn.execute(
                "UPDATE generation SET workspace_scope=?,workspace_id=? WHERE id=?",
                (workspace_scope, workspace_id, gen_id),
            )
            if shared:
                conn.execute(
                    "INSERT INTO share(id,generation_id,shared_by,visibility) VALUES(?,?,?,'team')",
                    ("s-" + gen_id, gen_id, owner or "me"),
                )
        return gen_id

    yield add
    db.flush_pool()


def request(role="member", uid="viewer"):
    req = Request({"type": "http", "method": "POST", "path": "/api/generations/locate"})
    req.state.account = {"email": "viewer@example.test", "creator_uid": uid, "global_role": role}
    return req


def locate(ids, *, tab="my", req=None, project_id=None, folder_path=None,
           workspace_ids=None, workspace_scope=None):
    return library.locate_generation_targets(
        library.GenerationLocateIn(
            tab=tab, gen_ids=ids, project_id=project_id, folder_path=folder_path,
            workspace_ids=workspace_ids or [], workspace_scope=workspace_scope,
        ),
        req or request(),
    )


@pytest.mark.parametrize("role", ["member", "admin", "product_manager", "production_director"])
def test_team_visibility_matches_existing_list_including_private_final_and_deleted(catalog, role):
    ids = [
        catalog("own", shared=True),
        catalog("own-unassigned", project=None, shared=True),
        catalog("own-nonmember", project="q", shared=True),
        catalog("member", owner="other", shared=True),
        catalog("nonmember", owner="other", project="q", shared=True),
        catalog("unassigned", owner="other", project=None, shared=True),
        catalog("private", owner="other", shared=False),
        catalog("own-private", shared=False),
        catalog("private-final", final=True),
        catalog("deleted", shared=True, deleted=True),
    ]
    memberships = ["p"] if role == "member" else None
    visible = {row["id"] for row in repo.list_generations(
        tab="team", account_uid="viewer", team_member_projects=memberships,
    )}
    # 단일 선택으로 각 행을 확인해 목적지 그룹 선택과 가시성 검사를 분리한다.
    for gen_id in ids:
        result = locate([gen_id], tab="team", req=request(role))
        assert result["focus_ids"] == ([gen_id] if gen_id in visible else [])
    assert "private-final" not in visible
    assert "own-private" not in visible
    assert "deleted" not in visible


def test_my_only_returns_viewer_rows_even_for_admin(catalog):
    own = catalog("own")
    other = catalog("other", owner="other", shared=True)
    deleted = catalog("deleted", deleted=True)
    assert locate([own, other, deleted], req=request("admin"))["focus_ids"] == [own]


@pytest.mark.parametrize("role", ["member", "admin"])
def test_personal_scope_keeps_existing_permissions_not_just_own_and_excludes_unknown(catalog, role):
    ids = [
        catalog("own-personal", workspace_scope="personal", shared=True),
        catalog("other-personal", owner="other", workspace_scope="personal", shared=True),
        catalog("hidden-personal", owner="other", project="q", workspace_scope="personal", shared=True),
        catalog("private-personal", workspace_scope="personal"),
        catalog("deleted-personal", workspace_scope="personal", shared=True, deleted=True),
        catalog("team", workspace_scope="team", workspace_id="ws-a", shared=True),
        catalog("unknown", shared=True),
    ]
    expected = {"own-personal", "other-personal"}
    if role == "admin":
        expected.add("hidden-personal")
    visible = repo.list_generations(
        tab="team", workspace_scope="personal", account_uid="viewer",
        team_member_projects=["p"] if role == "member" else None,
    )
    assert {row["id"] for row in visible} == expected
    # 그룹 우선순위와 무관하게 각 개인 카드 가시성이 목록과 일치한다.
    for gen_id in ids:
        result = locate([gen_id], tab="team", req=request(role), workspace_scope="personal")
        assert result["focus_ids"] == ([gen_id] if gen_id in expected else [])
        assert result["workspace_filter_applied"] is True


def test_workspace_filter_precedes_multiselection_folder_preference(catalog):
    wanted = catalog("wanted", shared=True, workspace_scope="team", workspace_id="ws-a", folder="a")
    other_a = catalog("other-a", shared=True, workspace_scope="team", workspace_id="ws-b", folder="b")
    other_b = catalog("other-b", shared=True, workspace_scope="team", workspace_id="ws-b", folder="b")
    result = locate(
        [wanted, other_a, other_b], tab="team", workspace_ids=["ws-a"],
        project_id="p", folder_path="b",
    )
    assert result["focus_ids"] == [wanted]
    assert result["folder_path"] == "a"
    assert result["workspace_filter_applied"] is True


def test_personal_scope_and_team_ids_are_intersection_not_union(catalog):
    # 잘못 섞인 요청도 개인 또는 팀 전체로 완화하면 안 된다.
    ids = [
        catalog("personal", shared=True, workspace_scope="personal", workspace_id="ws-a"),
        catalog("team", shared=True, workspace_scope="team", workspace_id="ws-a"),
    ]
    assert repo.list_generations(workspace_scope="personal", workspace_ids=["ws-a"]) == []
    result = locate(ids, tab="team", workspace_scope="personal", workspace_ids=["ws-a"])
    assert result["focus_ids"] == []
    assert result["workspace_filter_applied"] is True


def test_unlinked_account_does_not_relax_query_visibility(catalog):
    catalog("owned")
    assert locate(["owned"], req=request(uid=None))["focus_ids"] == []


def test_auth_off_preserves_legacy_local_visibility(catalog, monkeypatch):
    catalog("no-owner", owner=None)
    catalog("other", owner="other", shared=True)
    monkeypatch.setattr(library, "AUTH_ENABLED", False)
    monkeypatch.setattr(deps, "AUTH_ENABLED", False)
    req = request()
    req.state.account = None
    assert set(locate(["no-owner", "other"], req=req)["focus_ids"]) == {"no-owner", "other"}


def test_id_alias_maps_to_local_display_id_and_deduplicates(catalog):
    catalog("local-id", job_id="job-anchor")
    result = locate(["job-anchor", "local-id", " local-id "])
    assert result["focus_ids"] == ["local-id"]
    assert result["items"][0]["id"] == "local-id"
    assert result["items"][0]["job_id"] == "job-anchor"


def test_exact_id_wins_over_job_alias_collision(catalog):
    catalog("anchor", job_id="different-job", sort=1)
    catalog("other-id", job_id="anchor", sort=99)
    assert locate(["anchor"])["focus_ids"] == ["anchor"]


def test_local_origin_wins_over_synced_duplicate_anchor(catalog):
    catalog("copy", job_id="anchor", origin="synced", sort=99)
    catalog("original", job_id="anchor", origin="local", sort=1)
    assert locate(["anchor"])["focus_ids"] == ["original"]


def test_old_target_after_two_thousand_rows_does_not_scan_pages(catalog, monkeypatch):
    catalog("old-target", sort=0.123456789)
    with db.get_connection() as conn:
        conn.executemany(
            "INSERT INTO generation(id,worker_id,prompt,status,created_at,sort_ts,creator_uid,project_id,folder_path) "
            "VALUES(?,'me','','done','2026-09-16',?,'viewer','p','e001/c0010')",
            [(f"new-{i}", i + 1) for i in range(2100)],
        )
    query = Mock(wraps=repo.list_generations)
    monkeypatch.setattr(repo, "list_generations", query)
    result = locate(["old-target"])
    assert result["focus_ids"] == ["old-target"]
    assert result["items"][0]["sort_ts"] == 0.123456789
    query.assert_called_once()
    assert query.call_args.kwargs["generation_ids"] == ["old-target"]
    assert query.call_args.kwargs["limit"] == 200


def test_internal_empty_ids_cannot_accidentally_return_entire_library(catalog):
    catalog("ordinary")
    assert repo.list_generations(generation_ids=[]) == []
    assert locate(["missing"])["focus_ids"] == []


def test_two_hundred_targets_are_bounded_and_use_existing_list_order(catalog):
    for i in range(200):
        catalog(f"target-{i:03d}", sort=1.25)
    ids = [f"target-{i:03d}" for i in range(200)]
    result = locate(ids)
    assert len(result["items"]) == 200
    assert result["focus_ids"] == sorted(ids, reverse=True)
    assert all(row["sort_ts"] == 1.25 for row in result["items"])


def test_archived_visibility_stays_same_as_normal_library(catalog):
    catalog("cold")
    with db.get_connection() as conn:
        conn.execute("UPDATE project SET archived=1 WHERE id='p'")
    assert locate(["cold"])["focus_ids"] == []


def item(gen_id, project="p", folder="one", sort=1):
    return {"id": gen_id, "project_id": project, "folder_path": folder, "sort_ts": sort}


def test_single_target_uses_actual_folder_not_current_hint():
    result = _pick_location([item("a", folder="new")], "q", "old")
    assert (result["project_id"], result["folder_path"]) == ("p", "new")


def test_multiple_targets_prefer_current_folder_and_descendants():
    result = _pick_location([
        item("a", folder="one/child"), item("b", folder="two", sort=10),
        item("c", folder="two", sort=11), item("d", folder="one-other"),
    ], "p", "one")
    assert result["focus_ids"] == ["a"]
    assert result["folder_path"] == "one"


def test_project_root_hint_preserves_current_project_view():
    result = _pick_location([item("a", folder="one"), item("b", folder="two"), item("c", "q")], "p", None)
    assert result["focus_ids"] == ["b", "a"]
    assert result["folder_path"] is None


def test_unassigned_hint_is_explicit_none_sentinel():
    result = _pick_location([item("a", None, None), item("b", "p", "one", 10)], "none", None)
    assert result["focus_ids"] == ["a"]
    assert result["project_id"] is None


def test_group_most_targets_wins_then_latest_sort_and_id():
    values = [item("a", folder="one", sort=99), item("b", folder="two", sort=1), item("c", folder="two", sort=2)]
    assert _pick_location(values, None, None)["focus_ids"] == ["c", "b"]
    values = [item("a", folder="one", sort=2), item("b", folder="two", sort=2)]
    assert _pick_location(values, None, None)["focus_ids"] == ["b"]
    assert _pick_location(list(reversed(values)), None, None)["focus_ids"] == ["b"]
    assert _pick_location([item("z", sort=None), item("a", "q", sort=-1)], None, None)["focus_ids"] == ["a"]


@pytest.mark.parametrize("remote_shared", [True, False])
def test_team_uses_server_state_not_local_share_or_folder(catalog, monkeypatch, remote_shared):
    catalog("local", job_id="anchor", shared=not remote_shared, folder="stale")
    monkeypatch.setattr(_proxy, "proxying", lambda: True)
    remote_card = {
        **item("anchor", "server-project", "moved", 0.25),
        "worker_id": "me", "prompt": "", "status": "done", "created_at": "2026-09-16",
        "job_id": "anchor", "shared": True,
    }
    response = {
        "items": [remote_card] if remote_shared else [],
        "focus_ids": ["anchor"] if remote_shared else [],
        "project_id": "server-project" if remote_shared else None,
        "folder_path": "moved" if remote_shared else None,
    }
    fetch = Mock(return_value=response)
    monkeypatch.setattr(_proxy, "proxy_json", fetch)
    # 개인 overlay를 호출하는 경계는 유지하되 테스트에서 부가 IO를 하지 않는다.
    overlay = Mock()
    monkeypatch.setattr(library, "_overlay_personal_meta", overlay)
    result = locate(["local"], tab="team")
    assert result["focus_ids"] == response["focus_ids"]
    assert result["folder_path"] == response["folder_path"]
    assert result["project_id"] == response["project_id"]
    fetch.assert_called_once_with("POST", "/api/generations/locate", body={
        "tab": "team", "gen_ids": ["anchor"], "project_id": None, "folder_path": None,
    }, timeout=10)
    overlay.assert_called_once()


def test_my_does_not_fetch_remote_for_unknown_id(catalog, monkeypatch):
    monkeypatch.setattr(_proxy, "proxying", lambda: True)
    assert locate(["server-only"])["focus_ids"] == []
    _proxy.proxy_json.assert_not_called()


def test_empty_input_never_resolves_ids_or_calls_team_server(catalog, monkeypatch):
    monkeypatch.setattr(_proxy, "proxying", lambda: True)
    resolve = Mock(side_effect=AssertionError("no lookup for empty input"))
    monkeypatch.setattr(repo, "resolve_generation_meta_batch", resolve)
    monkeypatch.setattr(library, "_overlay_personal_meta", Mock())
    assert locate(["  "], tab="team")["focus_ids"] == []
    _proxy.proxy_json.assert_not_called()


@pytest.mark.parametrize("status", [401, 403, 404, 502, 503])
def test_remote_errors_never_fall_back_to_local_success(catalog, monkeypatch, status):
    catalog("local", job_id="anchor", shared=True)
    monkeypatch.setattr(_proxy, "proxying", lambda: True)
    monkeypatch.setattr(_proxy, "proxy_json", Mock(side_effect=HTTPException(status, "unavailable")))
    with pytest.raises(HTTPException) as error:
        locate(["local"], tab="team")
    assert error.value.status_code == status


@pytest.mark.parametrize("response", [None, {}, {"items": [], "focus_ids": ["wrong"], "project_id": None, "folder_path": None}])
def test_invalid_remote_contract_fails_closed(catalog, monkeypatch, response):
    catalog("local", job_id="anchor", shared=True)
    monkeypatch.setattr(_proxy, "proxying", lambda: True)
    monkeypatch.setattr(_proxy, "proxy_json", Mock(return_value=response))
    with pytest.raises(HTTPException) as error:
        locate(["local"], tab="team")
    assert error.value.status_code == 502


@pytest.mark.parametrize("filters", [{"workspace_ids": ["ws-a"]}, {"workspace_scope": "personal"}])
@pytest.mark.parametrize("marker", [None, False])
def test_scoped_team_locate_rejects_legacy_server_that_ignored_filter(catalog, monkeypatch, filters, marker):
    catalog("local", job_id="anchor", shared=True)
    monkeypatch.setattr(_proxy, "proxying", lambda: True)
    # 빈 응답도 서버가 범위 밖 폴더를 먼저 고른 결과일 수 있으므로 승인 표식이 필요하다.
    response = {"items": [], "focus_ids": [], "project_id": None, "folder_path": None}
    if marker is not None:
        response["workspace_filter_applied"] = marker
    fetch = Mock(return_value=response)
    monkeypatch.setattr(_proxy, "proxy_json", fetch)
    with pytest.raises(HTTPException) as error:
        locate(["local"], tab="team", **filters)
    assert error.value.status_code == 409
    assert "업데이트" in error.value.detail
    assert all(fetch.call_args.kwargs["body"][key] == value for key, value in filters.items())


@pytest.mark.parametrize("marker", [1, "true", "yes"])
def test_workspace_filter_marker_requires_actual_json_boolean(catalog, monkeypatch, marker):
    catalog("local", job_id="anchor", shared=True)
    monkeypatch.setattr(_proxy, "proxying", lambda: True)
    monkeypatch.setattr(_proxy, "proxy_json", Mock(return_value={
        "items": [], "focus_ids": [], "project_id": None, "folder_path": None,
        "workspace_filter_applied": marker,
    }))
    with pytest.raises(HTTPException) as error:
        locate(["local"], tab="team", workspace_scope="personal")
    assert error.value.status_code == 502


@pytest.mark.parametrize("filters,scope,workspace_id", [
    ({"workspace_ids": ["ws-a"]}, "team", "ws-a"),
    ({"workspace_scope": "personal"}, "personal", None),
])
def test_scoped_team_locate_accepts_verified_server_filter(catalog, monkeypatch, filters, scope, workspace_id):
    catalog("local", job_id="anchor", shared=True)
    monkeypatch.setattr(_proxy, "proxying", lambda: True)
    card = {
        **item("anchor"), "worker_id": "me", "prompt": "", "status": "done",
        "created_at": "2026-09-16", "shared": True,
        "workspace_scope": scope, "workspace_id": workspace_id,
    }
    monkeypatch.setattr(_proxy, "proxy_json", Mock(return_value={
        "items": [card], "focus_ids": ["anchor"], "project_id": "p", "folder_path": "one",
        "workspace_filter_applied": True,
    }))
    monkeypatch.setattr(library, "_overlay_personal_meta", Mock())
    result = locate(["local"], tab="team", **filters)
    assert result["focus_ids"] == ["anchor"]
    assert result["workspace_filter_applied"] is True
    # 필터 표식을 추가하면서 기존 GenerationOut 기본 필드가 사라지지 않는다.
    assert result["items"][0]["assets"] == []
    assert result["items"][0]["deleted"] is False


@pytest.mark.parametrize("filters,scope,workspace_id", [
    ({"workspace_ids": ["ws-a"]}, "team", "ws-b"),
    ({"workspace_ids": ["ws-a"]}, "personal", "ws-a"),
    ({"workspace_scope": "personal"}, "unknown", None),
    ({"workspace_scope": "personal"}, "team", "ws-a"),
])
def test_scoped_team_locate_marker_does_not_allow_out_of_scope_rows(catalog, monkeypatch, filters, scope, workspace_id):
    catalog("local", job_id="anchor", shared=True)
    monkeypatch.setattr(_proxy, "proxying", lambda: True)
    card = {
        **item("anchor"), "worker_id": "me", "prompt": "", "status": "done",
        "created_at": "2026-09-16", "shared": True,
        "workspace_scope": scope, "workspace_id": workspace_id,
    }
    monkeypatch.setattr(_proxy, "proxy_json", Mock(return_value={
        "items": [card], "focus_ids": ["anchor"], "project_id": "p", "folder_path": "one",
        "workspace_filter_applied": True,
    }))
    with pytest.raises(HTTPException) as error:
        locate(["local"], tab="team", **filters)
    assert error.value.status_code == 502


@pytest.mark.parametrize("shared,deleted", [(False, False), (True, True)])
def test_remote_private_or_deleted_target_cannot_be_injected(catalog, monkeypatch, shared, deleted):
    catalog("local", job_id="anchor", shared=True)
    monkeypatch.setattr(_proxy, "proxying", lambda: True)
    card = {
        **item("anchor"), "worker_id": "me", "prompt": "", "status": "done",
        "created_at": "2026-09-16", "shared": shared, "deleted": deleted,
    }
    monkeypatch.setattr(_proxy, "proxy_json", Mock(return_value={
        "items": [card], "focus_ids": ["anchor"], "project_id": "p", "folder_path": "one",
    }))
    with pytest.raises(HTTPException) as error:
        locate(["local"], tab="team")
    assert error.value.status_code == 502


@pytest.mark.parametrize("fail", [False, True])
def test_account_key_and_uid_stay_paired_during_remote_wait_then_restore(catalog, monkeypatch, fail):
    catalog("local", job_id="anchor", shared=True)
    monkeypatch.setattr(config, "AUTH_ENABLED", False)
    active_account._cache[:] = [True, {"email": "a@example.test", "uid": "a"}]

    def proxying():
        assert active_account.account_key() == "a@example.test"
        assert active_account.active_uid() == "a"
        # 원격 호출 직전 다른 창이 계정을 바꾸는 상황. 실제 active.json은 건드리지 않는다.
        active_account._cache[:] = [True, {"email": "b@example.test", "uid": "b"}]
        return True

    def fetch(*args, **kwargs):
        assert active_account.account_key() == "a@example.test"
        assert active_account.active_uid() == "a"
        if fail:
            raise HTTPException(502, "failed")
        return {"items": [], "focus_ids": [], "project_id": None, "folder_path": None}

    monkeypatch.setattr(_proxy, "proxying", proxying)
    monkeypatch.setattr(_proxy, "proxy_json", fetch)
    monkeypatch.setattr(library, "_overlay_personal_meta", Mock())
    if fail:
        with pytest.raises(HTTPException):
            locate(["local"], tab="team")
    else:
        locate(["local"], tab="team")
    assert active_account.account_key() == "b@example.test"
    assert active_account.active_uid() == "b"


def test_http_shape_limits_and_readonly_proxy_classification(catalog):
    app = FastAPI()
    app.include_router(library.router)

    @app.middleware("http")
    async def session(req, call_next):
        req.state.account = request().state.account
        return await call_next(req)

    catalog("target")
    with TestClient(app) as client:
        response = client.post("/api/generations/locate", json={"tab": "my", "gen_ids": ["target"]})
        assert response.status_code == 200
        assert set(response.json()) == {"items", "focus_ids", "project_id", "folder_path"}
        assert response.json()["focus_ids"] == ["target"]
        assert client.post("/api/generations/locate", json={"tab": "compose", "gen_ids": []}).status_code == 422
        assert client.post("/api/generations/locate", json={"tab": "my", "gen_ids": ["x"] * 201}).status_code == 422
        assert client.post("/api/generations/locate", json={"tab": "my", "gen_ids": ["x" * 201]}).status_code == 422
        assert client.post("/api/generations/locate", json={"tab": "my", "gen_ids": []}).json()["focus_ids"] == []
    assert _proxy.is_local_path("/api/generations/locate")
    assert notification_domains("POST", "/api/generations/locate", 200) == ()


def test_http_workspace_filter_shape_validation_and_personal_list(catalog):
    app = FastAPI()
    app.include_router(library.router)

    @app.middleware("http")
    async def session(req, call_next):
        req.state.account = request().state.account
        return await call_next(req)

    catalog("personal", workspace_scope="personal", shared=True)
    catalog("other-personal", owner="other", workspace_scope="personal", shared=True)
    catalog("unknown", shared=True)
    catalog("team", workspace_scope="team", workspace_id="ws-a", shared=True)
    with TestClient(app) as client:
        response = client.get("/api/generations?tab=team&workspace_scope=personal")
        assert response.status_code == 200
        assert {row["id"] for row in response.json()} == {"personal", "other-personal"}
        assert client.get("/api/generations?workspace_scope=unknown").status_code == 422
        assert client.get("/api/generations?workspace_scope=personal&workspace_ids=ws-a").json() == []
        for key in ("workspace_id", "workspace_ids"):
            for invalid_id in ("", "   ", "x" * 201):
                assert client.get("/api/generations", params={key: invalid_id}).status_code == 422
            response = client.get("/api/generations", params={"tab": "team", key: " ws-a "})
            assert response.status_code == 200
            assert [row["id"] for row in response.json()] == ["team"]
        response = client.get("/api/generations", params=[
            ("tab", "team"), ("workspace_ids", " ws-a "), ("workspace_ids", "ws-a"),
        ])
        assert [row["id"] for row in response.json()] == ["team"]
        assert [row["id"] for row in repo.list_generations(workspace_ids=[" ws-a ", "ws-a"])] == ["team"]
        for invalid_ids in ([""], ["   "], [1], ["x" * 201], ["x"] * 201):
            response = client.post("/api/generations/locate", json={
                "tab": "team", "gen_ids": ["team"], "workspace_ids": invalid_ids,
            })
            assert response.status_code == 422
        assert client.post("/api/generations/locate", json={
            "tab": "team", "gen_ids": ["personal"], "workspace_scope": "unknown",
        }).status_code == 422
        response = client.post("/api/generations/locate", json={
            "tab": "team", "gen_ids": ["team", "personal", "unknown"], "workspace_scope": "personal",
        })
        assert response.status_code == 200
        assert response.json()["focus_ids"] == ["personal"]
        assert response.json()["workspace_filter_applied"] is True
        response = client.post("/api/generations/locate", json={
            "tab": "team", "gen_ids": ["team", "personal"], "workspace_ids": [" ws-a ", "ws-a"],
        })
        assert response.status_code == 200
        assert response.json()["focus_ids"] == ["team"]

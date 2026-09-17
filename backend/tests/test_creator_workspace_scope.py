"""공유 생성자 집계는 카드와 같은 워크스페이스/프로젝트/권한 범위를 서버에서 센다."""

from collections import Counter
from urllib.parse import parse_qs, urlencode
from unittest.mock import Mock

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
from starlette.requests import Request

from app import active_account, config, db, deps, repo
from app.routers import _proxy, generation


@pytest.fixture
def catalog(tmp_path, monkeypatch):
    monkeypatch.setenv("CONTENT_HUB_DB", str(tmp_path / "content_hub.db"))
    monkeypatch.setattr(active_account, "_cache", [True, None])
    monkeypatch.setattr(_proxy, "proxying", lambda: False)
    monkeypatch.setattr(_proxy, "proxy_json", Mock(side_effect=AssertionError("unexpected network")))
    monkeypatch.setattr(generation, "AUTH_ENABLED", True)
    monkeypatch.setattr(deps, "AUTH_ENABLED", True)
    db.flush_pool()
    db.init_db()
    repo.ensure_default_worker()
    with db.get_connection() as conn:
        conn.executemany("INSERT INTO worker(id,name,account_type) VALUES(?,?,'team')", [
            ("viewer", "Viewer"), ("a", "Creator A"), ("b", "Creator B"), ("zero", "Zero"),
        ])
        conn.executemany("INSERT INTO creator(uid,name) VALUES(?,?)", [
            ("viewer", "Viewer"), ("a", "Creator A"), ("b", "Creator B"), ("zero", "Zero"),
        ])
        conn.executemany("INSERT INTO project(id,name,kind,archived) VALUES(?,?,'team',?)", [
            ("p", "Member", 0), ("q", "Other", 0), ("cold", "Archived", 1),
        ])
        conn.executemany(
            "INSERT INTO project_member(project_id,creator_uid,project_role) VALUES('p',?,'creator')",
            [("viewer",), ("zero",)],
        )

    def add(gen_id, *, owner="a", scope="team", workspace="ws-a", project="p", shared=True, deleted=False, folder=None):
        with db.get_connection() as conn:
            conn.execute(
                "INSERT INTO generation(id,worker_id,prompt,status,created_at,sort_ts,creator_uid,"
                "project_id,workspace_scope,workspace_id,deleted_at,folder_path) "
                "VALUES(:id,'me',:id,'done','2026-09-17',1,:owner,:project,:scope,:workspace,:deleted,:folder)",
                {"id": gen_id, "owner": owner, "project": project, "scope": scope,
                 "workspace": workspace if scope == "team" else None,
                 "deleted": "2026-09-17" if deleted else None, "folder": folder},
            )
            if shared:
                conn.execute(
                    "INSERT INTO share(id,generation_id,shared_by,visibility) VALUES(?,?,?,'team')",
                    ("s-" + gen_id, gen_id, owner),
                )
        return gen_id

    yield add
    db.flush_pool()


def request(*, role="member", uid="viewer", query="tab=team"):
    req = Request({"type": "http", "method": "GET", "path": "/api/creators",
                   "query_string": query.encode("ascii"), "headers": []})
    req.state.account = {"email": "viewer@example.test", "creator_uid": uid, "global_role": role}
    return req


def counts(items):
    return {row["uid"]: row["count"] for row in items}


@pytest.mark.parametrize("scope", [
    {}, {"workspace_ids": ["ws-a"]}, {"workspace_ids": ["ws-b"]},
    {"workspace_ids": [" ws-a ", "ws-b", "ws-a"]}, {"workspace_scope": "personal"},
    {"workspace_ids": ["ws-a"], "workspace_scope": "personal"},
])
@pytest.mark.parametrize("project_id", [None, "p", "q", "cold", "none"])
@pytest.mark.parametrize("members", [["p"], None])
def test_creator_counts_match_full_visible_generation_query(catalog, scope, project_id, members):
    catalog("a1")
    catalog("a2")
    catalog("b1", owner="b", workspace="ws-b")
    catalog("personal-a", scope="personal")
    catalog("personal-b", owner="b", scope="personal")
    catalog("unknown", owner="b", scope="unknown")
    catalog("private", shared=False)
    catalog("deleted", deleted=True)
    catalog("hidden", project="q")
    catalog("own-outside", owner="viewer", project="q")
    catalog("other-unassigned", project=None)
    catalog("own-unassigned", owner="viewer", project=None)
    catalog("archived", project="cold")
    expected_rows = repo.list_generations(
        tab="team", account_uid="viewer", team_member_projects=members, project_id=project_id, **scope,
    )
    creators = repo.list_creators(
        tab="team", account_uid="viewer", team_member_projects=members, project_id=project_id, **scope,
    )
    assert counts(creators) == Counter(row["creator_uid"] for row in expected_rows)
    assert all(row["count"] > 0 for row in creators)
    assert all(row["name"] in {"Viewer", "Creator A", "Creator B"} for row in creators)
    assert all(row["is_mine"] == (row["uid"] == "viewer") for row in creators)


def test_personal_includes_other_visible_creators_but_not_unknown(catalog):
    catalog("a", scope="personal")
    catalog("b", owner="b", scope="personal")
    catalog("unknown", owner="viewer", scope="unknown")
    catalog("hidden", owner="b", scope="personal", project="q")
    rows = repo.list_creators(tab="team", account_uid="viewer", team_member_projects=["p"], workspace_scope="personal")
    assert counts(rows) == {"a": 1, "b": 1}


def test_team_project_none_and_archived_rules(catalog):
    catalog("normal")
    catalog("cold", project="cold", owner="b")
    catalog("unassigned", project=None, owner="viewer")
    assert counts(repo.list_creators(tab="team", account_uid="viewer")) == {"a": 1, "viewer": 1}
    assert counts(repo.list_creators(tab="team", project_id="none", account_uid="viewer")) == {"viewer": 1}
    assert counts(repo.list_creators(tab="team", project_id="cold", account_uid="viewer")) == {"b": 1}


def test_my_project_union_and_zero_members_ignore_workspace_filters(catalog):
    # opt-in 없는 구 클라이언트의 배열/멤버 계약은 보존한다.
    catalog("a", shared=False, workspace="ws-b")
    result = repo.list_creators(
        tab="my", account_uid="viewer", project_id="p", workspace_ids=["ws-a"], workspace_scope="personal",
    )
    assert counts(result) == {"a": 1, "viewer": 0, "zero": 0}
    assert counts(repo.list_creators(tab="my", account_uid="viewer", workspace_ids=["ws-a"])) == {"viewer": 0}


@pytest.mark.parametrize("scope", [
    {}, {"workspace_ids": ["ws-a"]}, {"workspace_ids": ["ws-b", "ws-a"]},
    {"workspace_scope": "personal"}, {"workspace_ids": ["ws-a"], "workspace_scope": "personal"},
])
@pytest.mark.parametrize("project_id", [None, "p", "q", "cold", "none"])
@pytest.mark.parametrize("folder", [None, "", "ep", "ep/seq"])
def test_my_facet_matches_own_library_scope(catalog, scope, project_id, folder):
    catalog("mine", owner="viewer", folder="ep/seq", shared=False)
    catalog("nested", owner="viewer", folder="ep/seq/sub", workspace="ws-b")
    catalog("root", owner="viewer")
    catalog("other-folder", owner="viewer", folder="ep2/seq")
    catalog("other-project", owner="viewer", project="q", folder="ep/seq")
    catalog("personal", owner="viewer", scope="personal", folder="ep/seq")
    catalog("unknown", owner="viewer", scope="unknown", folder="ep/seq")
    catalog("unassigned", owner="viewer", project=None)
    catalog("archived", owner="viewer", project="cold", folder="ep/seq")
    catalog("deleted", owner="viewer", folder="ep/seq", deleted=True)
    catalog("other-creator", folder="ep/seq")
    expected = repo.list_generations(tab="my", account_uid="viewer", project_id=project_id,
                                     folder_path=folder, **scope)
    actual = repo.list_creators(tab="my", facet_scope="library", account_uid="viewer",
                               project_id=project_id, folder_path=folder, **scope)
    assert counts(actual) == {"viewer": len(expected)}
    assert actual[0]["is_mine"] is True


@pytest.mark.parametrize("folder", ["e_01", "e%01", "e\\01"])
def test_my_facet_treats_like_symbols_as_folder_names(catalog, folder):
    catalog("exact", owner="viewer", folder=folder)
    catalog("child", owner="viewer", folder=folder + "/seq")
    catalog("not-child", owner="viewer", folder=folder + "0/seq")
    catalog("wildcard", owner="viewer", folder="eX01/seq")
    assert counts(repo.list_creators(tab="my", facet_scope="library", account_uid="viewer",
                                    project_id="p", folder_path=folder)) == {"viewer": 2}


def test_my_facet_denies_unknown_login_and_has_no_page_limit(catalog, monkeypatch):
    catalog("mine", owner="viewer", folder="ep")
    with db.get_connection() as conn:
        conn.executemany(
            "INSERT INTO generation(id,worker_id,prompt,status,created_at,creator_uid,project_id,folder_path) "
            "VALUES(?,'me','','done','2026-09-17','viewer','p','ep')",
            [(f"many-{i}",) for i in range(501)],
        )
    assert repo.list_creators(tab="my", facet_scope="library", account_uid="\x00", project_id="p") == []
    monkeypatch.setattr(repo, "list_generations", Mock(side_effect=AssertionError("aggregate query only")))
    assert counts(repo.list_creators(tab="my", facet_scope="library", account_uid="viewer",
                                    project_id="p", folder_path="ep")) == {"viewer": 502}


def test_my_library_scope_opt_in_returns_confirmed_envelope_without_proxy(catalog, monkeypatch):
    catalog("mine", owner="viewer", folder="ep/seq", shared=False)
    catalog("other", folder="ep/seq")
    monkeypatch.setattr(_proxy, "proxying", lambda: True)
    result = generation.list_creators(request(role="admin", query="tab=my"), tab="my",
                                     facet_scope="library", project_id="p", folder_path="ep/seq",
                                     workspace_ids=["ws-a"])
    assert result["creator_scope_applied"] is True
    assert counts(result["items"]) == {"viewer": 1}


def test_my_library_scope_unidentified_login_does_not_fall_back_to_provider(catalog):
    catalog("other")
    req = request()
    req.state.account = None
    result = generation.list_creators(req, tab="my", facet_scope="library", project_id="p")
    assert result == {"creator_scope_applied": True, "items": []}


@pytest.mark.parametrize("pinned_uid,expected", [("viewer", {"viewer": 1}), (None, {})])
def test_my_library_scope_auth_off_proxy_uses_only_pinned_local_viewer(catalog, monkeypatch, pinned_uid, expected):
    catalog("mine", owner="viewer", folder="ep/seq", shared=False)
    catalog("other", owner="a", folder="ep/seq")
    monkeypatch.setattr(generation, "AUTH_ENABLED", False)
    monkeypatch.setattr(deps, "AUTH_ENABLED", False)
    monkeypatch.setattr(config, "AUTH_ENABLED", False)
    monkeypatch.setattr(_proxy, "proxying", lambda: True)
    active_account._cache[:] = [True, {"uid": pinned_uid}]
    req = request(query="tab=my")
    req.state.account = None  # 실제 로컬 허브는 AUTH off라 요청 계정이 채워지지 않는다.
    result = generation.list_creators(req, tab="my", facet_scope="library", project_id="p",
                                     folder_path="ep/seq", workspace_ids=["ws-a"])
    assert result["creator_scope_applied"] is True
    assert counts(result["items"]) == expected
    _proxy.proxy_json.assert_not_called()


@pytest.mark.parametrize("account", [None, {"creator_uid": None},
                                      {"creator_uid": None, "email": "unlinked@example.test"}])
def test_my_library_scope_auth_on_missing_identity_never_uses_active_proxy_viewer(catalog, monkeypatch, account):
    catalog("mine", owner="viewer", folder="ep/seq", shared=False)
    monkeypatch.setattr(_proxy, "proxying", lambda: True)
    active_account._cache[:] = [True, {"uid": "viewer"}]
    req = request(query="tab=my")
    req.state.account = account
    result = generation.list_creators(req, tab="my", facet_scope="library", project_id="p")
    assert result["creator_scope_applied"] is True
    assert "viewer" not in counts(result["items"])
    assert all(row["count"] == 0 for row in result["items"])


def test_counts_are_not_limited_to_a_card_page(catalog, monkeypatch):
    catalog("template")
    with db.get_connection() as conn:
        conn.executemany(
            "INSERT INTO generation(id,worker_id,prompt,status,created_at,creator_uid,workspace_scope,workspace_id,project_id) "
            "VALUES(?,'me','','done','2026-09-17','a','team','ws-a','p')",
            [(f"g-{i}",) for i in range(250)],
        )
        conn.executemany(
            "INSERT INTO share(id,generation_id,shared_by,visibility) VALUES(?,?,'a','team')",
            [(f"s-g-{i}", f"g-{i}") for i in range(250)],
        )
    monkeypatch.setattr(repo, "list_generations", Mock(side_effect=AssertionError("must use aggregate SQL")))
    result = repo.list_creators(tab="team", workspace_ids=["ws-a"])
    assert counts(result) == {"a": 251}


@pytest.mark.parametrize("scope", [{"workspace_ids": ["ws-a"]}, {"workspace_scope": "personal"}])
@pytest.mark.parametrize("remote", [[], {}, {"items": [], "workspace_filter_applied": False},
                                    {"items": [], "workspace_filter_applied": "true"}])
def test_scoped_proxy_rejects_legacy_or_unconfirmed_aggregates(catalog, monkeypatch, scope, remote):
    monkeypatch.setattr(_proxy, "proxying", lambda: True)
    fetch = Mock(return_value=remote)
    monkeypatch.setattr(_proxy, "proxy_json", fetch)
    with pytest.raises(HTTPException) as error:
        generation.list_creators(request(), tab="team", **scope)
    assert error.value.status_code == 409
    assert "업데이트" in error.value.detail


def test_scoped_proxy_normalizes_ids_and_preserves_project(catalog, monkeypatch):
    monkeypatch.setattr(_proxy, "proxying", lambda: True)
    result = {"items": [{"uid": "a", "name": "A", "count": 5, "is_mine": False}], "workspace_filter_applied": True}
    fetch = Mock(return_value=result)
    monkeypatch.setattr(_proxy, "proxy_json", fetch)
    req = request(query=urlencode([("tab", "team"), ("project_id", "none"),
                                   ("workspace_ids", " ws-a "), ("workspace_ids", "ws-a")]))
    assert generation.list_creators(req, tab="team", project_id="none", workspace_ids=[" ws-a ", "ws-a"]) == result
    query = parse_qs(fetch.call_args.kwargs["raw_query"])
    assert query == {"tab": ["team"], "project_id": ["none"], "workspace_ids": ["ws-a"]}


@pytest.mark.parametrize("items", [None, "bad", [1]])
def test_scoped_proxy_rejects_malformed_confirmed_response(catalog, monkeypatch, items):
    monkeypatch.setattr(_proxy, "proxying", lambda: True)
    monkeypatch.setattr(_proxy, "proxy_json", Mock(return_value={"items": items, "workspace_filter_applied": True}))
    with pytest.raises(HTTPException) as error:
        generation.list_creators(request(), tab="team", workspace_scope="personal")
    assert error.value.status_code == 502


def test_legacy_unscoped_proxy_returns_existing_array(catalog, monkeypatch):
    monkeypatch.setattr(_proxy, "proxying", lambda: True)
    rows = [{"uid": "a", "name": "A", "count": 2, "is_mine": False}]
    fetch = Mock(return_value=rows)
    monkeypatch.setattr(_proxy, "proxy_get", fetch)
    assert generation.list_creators(request(), tab="team") == rows
    fetch.assert_called_once()
    _proxy.proxy_json.assert_not_called()


@pytest.mark.parametrize("fail", [False, True])
def test_proxy_pins_captured_account_key_and_uid_and_restores(catalog, monkeypatch, fail):
    monkeypatch.setattr(config, "AUTH_ENABLED", False)
    monkeypatch.setattr(_proxy, "proxying", lambda: True)
    active_account._cache[:] = [True, {"email": "a@example.test", "uid": "a"}]
    req = request(uid="a")

    def fetch(*args, **kwargs):
        assert active_account.account_key() == "a@example.test"
        assert active_account.active_uid() == "a"
        active_account._cache[:] = [True, {"email": "b@example.test", "uid": "b"}]
        assert active_account.account_key() == "a@example.test"
        assert active_account.active_uid() == "a"
        if fail:
            raise HTTPException(502, "unavailable")
        return {"items": [], "workspace_filter_applied": True}

    monkeypatch.setattr(_proxy, "proxy_json", fetch)
    if fail:
        with pytest.raises(HTTPException):
            generation.list_creators(req, tab="team", workspace_ids=["ws-a"])
    else:
        assert generation.list_creators(req, tab="team", workspace_ids=["ws-a"])["items"] == []
    assert active_account.account_key() == "b@example.test"
    assert active_account.active_uid() == "b"


def test_http_contract_validation_permissions_and_unscoped_compatibility(catalog):
    app = FastAPI()
    app.include_router(generation.router)

    @app.middleware("http")
    async def session(req, call_next):
        req.state.account = request().state.account
        return await call_next(req)

    catalog("team")
    catalog("hidden", project="q")
    catalog("personal", owner="b", scope="personal")
    with TestClient(app) as client:
        assert isinstance(client.get("/api/creators?tab=team").json(), list)
        for invalid_id in ("", "  ", "x" * 201):
            assert client.get("/api/creators", params={"tab": "team", "workspace_ids": invalid_id}).status_code == 422
        assert client.get("/api/creators", params=[("workspace_ids", "x")] * 201).status_code == 422
        assert client.get("/api/creators?tab=team&workspace_scope=unknown").status_code == 422
        scoped = client.get("/api/creators", params={"tab": "team", "workspace_ids": " ws-a "}).json()
        assert scoped["workspace_filter_applied"] is True
        assert counts(scoped["items"]) == {"a": 1}
        personal = client.get("/api/creators?tab=team&workspace_scope=personal").json()
        assert counts(personal["items"]) == {"b": 1}
        assert isinstance(client.get("/api/creators?tab=my&workspace_scope=personal").json(), list)
        own = client.get("/api/creators", params={"tab": "my", "facet_scope": "library",
                          "project_id": "none", "folder_path": "e001", "workspace_ids": "ws-a"}).json()
        assert own["creator_scope_applied"] is True
        assert counts(own["items"]) == {"viewer": 0}
        assert client.get("/api/creators?tab=my&facet_scope=unknown").status_code == 422

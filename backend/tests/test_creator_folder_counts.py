"""생성자 선택 집계: 권한 교집합·루트/미분류·원자적 응답·구서버 호환."""

from contextlib import contextmanager
from unittest.mock import Mock

import pytest
from fastapi import Request

from app import db, deps, repo
from app.repo import projects as project_repo
from app.routers import projects as project_router


@pytest.fixture
def catalog(monkeypatch, tmp_path):
    monkeypatch.setenv("CONTENT_HUB_DATA", str(tmp_path))
    monkeypatch.setenv("CONTENT_HUB_DB", str(tmp_path / "content.db"))
    monkeypatch.setenv("CONTENT_HUB_NO_PROXY", "1")
    monkeypatch.setattr(db, "_POOL_ENABLED", False)
    monkeypatch.setattr(deps, "AUTH_ENABLED", True)
    monkeypatch.setattr(project_router, "AUTH_ENABLED", True)
    monkeypatch.setattr(project_router._proxy, "proxying", lambda: False)
    db.flush_pool()
    db.init_db()
    repo.ensure_default_worker()
    with db.get_connection() as conn:
        conn.executemany("INSERT INTO project(id, name) VALUES(?, ?)", [
            ("member", "member"), ("other", "other"), ("empty", "empty"),
        ])
        conn.execute(
            "INSERT INTO project_member(project_id, creator_uid, project_role) "
            "VALUES('member', 'viewer', 'creator')"
        )
    yield
    db.flush_pool()


def seed(gen_id, *, creator="a", project="member", folder="episode/shot",
         final=False, held=False, shared=True, deleted=False, shared_at="2026-01-02 00:00:00"):
    with db.get_connection() as conn:
        conn.execute(
            "INSERT INTO generation(id, worker_id, prompt, status, creator_uid, project_id, "
            "folder_path, is_final, is_held, deleted_at) "
            "VALUES(?, 'me', 'creator-count fixture', 'done', ?, ?, ?, ?, ?, ?)",
            (gen_id, creator, project, folder, int(final), int(held),
             "2026-01-01" if deleted else None),
        )
        if shared:
            conn.execute(
                "INSERT INTO share(id, generation_id, shared_by, visibility, shared_at) "
                "VALUES(?, ?, 'me', 'team', ?)", ("share-" + gen_id, gen_id, shared_at),
            )


def request(uid="viewer", role="", query=""):
    req = Request({
        "type": "http", "method": "GET", "path": "/api/projects/member/folder-counts",
        "headers": [], "query_string": query.encode(), "client": ("127.0.0.1", 50000),
    })
    req.state.account = {"email": "", "creator_uid": uid, "global_role": role}
    return req


def batch(ids=("member",), *, creator="a", tab="team", req=None):
    return project_router.project_folder_counts_batch(
        project_router.FolderCountsBatchIn(project_ids=list(ids), tab=tab, creator_uid=creator),
        req or request(),
    )


def test_selected_counts_include_roots_unassigned_and_exclude_other_creator(catalog):
    seed("a-final", final=True, held=True)
    seed("a-held", held=True)
    seed("a-shared")
    seed("b-shared", creator="b")
    seed("a-root-null", folder=None)
    seed("a-root-empty", folder="")
    seed("a-unassigned", project=None, folder=None)
    seed("a-unassigned-path", project=None, folder="stray/path")
    seed("b-unassigned", creator="b", project=None)
    seed("a-private", shared=False)
    seed("a-deleted", deleted=True)
    seed("a-outside", project="other")
    result = batch(("member", "empty", "member", ""), req=request(role="admin"))
    assert result == {
        "counts": {"member": {"episode/shot": 3}, "empty": {}},
        "review_counts": {
            "member": {"episode/shot": {"final": 1, "held": 1, "shared": 1}}, "empty": {},
        },
        "project_counts": {"member": 5, "empty": 0},
        "unassigned_count": 2, "creator_filter_uid": "a",
    }
    assert batch(creator="b", req=request(role="admin"))["counts"] == {
        "member": {"episode/shot": 1},
    }


@pytest.mark.parametrize("creator", ["missing", " a ", "' OR 1=1 --"])
def test_unknown_creator_is_zero_and_echo_is_exact_not_normalized(catalog, creator):
    seed("a")
    result = batch(("member", "missing"), creator=creator, req=request(role="admin"))
    assert result == {
        "counts": {"member": {}, "missing": {}},
        "review_counts": {"member": {}, "missing": {}},
        "project_counts": {"member": 0, "missing": 0},
        "unassigned_count": 0, "creator_filter_uid": creator,
    }


@pytest.mark.parametrize("uid,selected,tab,expected", [
    ("a", "a", "my", 1),
    ("a", "b", "my", 0),
    ("a", "b", "invalid", 0),
    ("a", "b", "", 0),
    (None, "a", "my", 0),
])
def test_my_account_scope_is_and_not_replaced_by_selected_creator(catalog, uid, selected, tab, expected):
    seed("a-private", shared=False)
    seed("b-private", creator="b", shared=False)
    seed("a-unassigned", project=None, shared=False)
    result = batch(creator=selected, tab=tab, req=request(uid=uid))
    assert result["project_counts"] == {"member": expected}
    assert result["unassigned_count"] == expected
    assert "review_counts" not in result
    single = project_router.project_folder_counts("member", request(uid=uid), tab, selected)
    assert single == {"counts": result["counts"]["member"], "creator_filter_uid": selected}


@pytest.mark.parametrize("uid,role,selected,member,other,unassigned", [
    ("viewer", "", "a", 1, 0, 0),
    ("viewer", "", "viewer", 1, 1, 1),
    ("outsider", "", "a", 0, 0, 0),
    (None, "", "a", 0, 0, 0),
    ("viewer", "admin", "a", 1, 1, 1),
])
def test_team_selection_keeps_member_own_read_all_and_sentinel_visibility(
    catalog, uid, role, selected, member, other, unassigned,
):
    for creator in ("a", "viewer"):
        for project in ("member", "other", None):
            seed(f"{creator}-{project}", creator=creator, project=project)
    result = batch(("member", "other"), creator=selected, req=request(uid=uid, role=role))
    assert result["project_counts"] == {"member": member, "other": other}
    assert result["unassigned_count"] == unassigned


def test_empty_selected_batch_still_queries_unassigned(catalog):
    seed("a-unassigned", project=None)
    seed("b-unassigned", creator="b", project=None)
    assert batch((), req=request(role="admin")) == {
        "counts": {}, "review_counts": {}, "project_counts": {},
        "unassigned_count": 1, "creator_filter_uid": "a",
    }


@pytest.mark.parametrize("tab", ["my", "team"])
def test_all_selected_aggregates_use_one_select(catalog, monkeypatch, tab):
    seed("a-final", final=True)
    seed("a-root", folder=None)
    seed("a-unassigned", project=None)
    statements = []
    original = project_repo.get_connection

    @contextmanager
    def traced():
        with original() as conn:
            conn.set_trace_callback(statements.append)
            try:
                yield conn
            finally:
                conn.set_trace_callback(None)

    monkeypatch.setattr(project_repo, "get_connection", traced)
    result = batch(tab=tab, req=request(uid="a", role="admin"))
    selects = [sql for sql in statements if sql.lstrip().upper().startswith("SELECT")]
    assert len(selects) == 1
    assert "GROUP BY g.project_id, g.folder_path" in selects[0]
    assert result["project_counts"]["member"] == 2
    assert result["unassigned_count"] == 1


def test_single_selected_response_excludes_unassigned_and_preserves_shape(catalog, monkeypatch):
    seed("a-final", final=True)
    seed("a-unassigned", project=None)
    spy = Mock(wraps=repo.creator_folder_counts_batch)
    monkeypatch.setattr(repo, "creator_folder_counts_batch", spy)
    assert project_router.project_folder_counts("member", request(role="admin"), "team", "a") == {
        "counts": {"episode/shot": 1},
        "review_counts": {"episode/shot": {"final": 1, "held": 0, "shared": 0}},
        "creator_filter_uid": "a",
    }
    assert spy.call_args.kwargs["include_unassigned"] is False


@pytest.mark.parametrize("creator", [None, ""])
@pytest.mark.parametrize("tab", ["my", "team"])
def test_absent_or_empty_selection_keeps_existing_contract_and_empty_fast_path(
    catalog, monkeypatch, creator, tab,
):
    seed("mine", creator="viewer")
    forbidden = Mock(side_effect=AssertionError("no selection must use original path"))
    monkeypatch.setattr(repo, "creator_folder_counts_batch", forbidden)
    result = batch(creator=creator, tab=tab)
    assert result["counts"] == {"member": {"episode/shot": 1}}
    assert set(result) == ({"counts", "review_counts"} if tab == "team" else {"counts"})
    # read_all avoids a membership SELECT; the old empty-ID aggregate must not connect.
    monkeypatch.setattr(project_repo, "get_connection", forbidden)
    assert batch((), creator=creator, tab=tab, req=request(role="admin")) == (
        {"counts": {}, "review_counts": {}} if tab == "team" else {"counts": {}}
    )
    forbidden.assert_not_called()


@pytest.mark.parametrize("creator", [None, "", "a"])
@pytest.mark.parametrize("updated_server", [False, True])
def test_proxy_sends_optional_creator_but_does_not_synthesize_echo(monkeypatch, creator, updated_server):
    response = {"counts": {"member": {"folder": 7}}}
    if updated_server and creator:
        response.update(creator_filter_uid=creator, project_counts={"member": 7}, unassigned_count=0)
    remote = Mock(return_value=response)
    monkeypatch.setattr(project_router._proxy, "proxying", lambda: True)
    monkeypatch.setattr(project_router._proxy, "proxy_json", remote)
    result = batch(creator=creator)
    assert result is response
    assert ("creator_filter_uid" in result) == bool(updated_server and creator)
    body = {"project_ids": ["member"], "tab": "team"}
    if creator:
        body["creator_uid"] = creator
    remote.assert_called_once_with("POST", "/api/projects/folder-counts/batch", body=body)


def test_single_proxy_retains_querystring_and_legacy_lack_of_echo(monkeypatch):
    # 실제 proxy_get의 raw_query 전달까지 검사한다. 네트워크 실행은 mock으로 막는다.
    remote = Mock(return_value={"counts": {"folder": 7}})
    monkeypatch.setattr(project_router._proxy, "proxying", lambda: True)
    monkeypatch.setattr(project_router._proxy, "proxy_json", remote)
    req = request(query="tab=team&creator_uid=a")
    result = project_router.project_folder_counts("member", req, "team", "a")
    assert result == {"counts": {"folder": 7}}
    remote.assert_called_once_with(
        "GET", "/api/projects/member/folder-counts", raw_query="tab=team&creator_uid=a",
    )


def test_fresh_items_add_creator_without_changing_order_cursor_or_visibility(catalog):
    seed("a-newer", shared_at="2026-01-03 00:00:00")
    seed("b-older", creator="b")
    seed("hidden", project="other")
    first = project_router.team_fresh(request(), "2026-01-01 00:00:00", limit=1)
    assert first["items"][0]["creator_uid"] == "a"
    assert first["items"][0]["id"] == "a-newer"
    assert first["next_cursor"] == {"shared_at": "2026-01-03 00:00:00", "id": "a-newer"}
    second = project_router.team_fresh(
        request(), "2026-01-01 00:00:00", cursor_shared_at=first["next_cursor"]["shared_at"],
        cursor_id=first["next_cursor"]["id"], limit=10,
    )
    assert [(row["id"], row["creator_uid"]) for row in second["items"]] == [("b-older", "b")]
    assert second["next_cursor"] is None

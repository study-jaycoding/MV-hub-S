"""공유 폴더 숫자 계약·상호 배타적 검토 집계·가시성·구서버 프록시 회귀."""

from __future__ import annotations

import sqlite3
from contextlib import contextmanager
from unittest.mock import Mock

import pytest
from fastapi import HTTPException, Request

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
        for pid in ("member", "other", "empty"):
            conn.execute("INSERT INTO project(id, name) VALUES(?, ?)", (pid, pid))
        conn.execute(
            "INSERT INTO project_member(project_id, creator_uid, project_role) "
            "VALUES('member', 'viewer', 'creator')"
        )
    yield
    db.flush_pool()


def seed(gen_id, *, project="member", folder="e001/c0010", creator="other-user",
         final=False, held=False, shared=True, deleted=False, workspace=None):
    with db.get_connection() as conn:
        conn.execute(
            "INSERT INTO generation(id, worker_id, prompt, status, creator_uid, project_id, "
            "folder_path, is_final, is_held, deleted_at, workspace_scope, workspace_id) "
            "VALUES(?, 'me', 'folder review fixture', 'done', ?, ?, ?, ?, ?, ?, ?, ?)",
            (gen_id, creator, project, folder, int(final), int(held),
             "2026-01-01" if deleted else None, "team" if workspace else "unknown", workspace),
        )
        if shared:
            conn.execute(
                "INSERT INTO share(id, generation_id, shared_by, visibility) VALUES(?, ?, 'me', 'team')",
                ("share-" + gen_id, gen_id),
            )


def request(*, uid="viewer", role="", query=""):
    req = Request({
        "type": "http", "method": "GET", "path": "/api/projects/member/folder-counts",
        "headers": [], "query_string": query.encode(), "client": ("127.0.0.1", 51000),
    })
    req.state.account = {"email": "viewer@example.test", "creator_uid": uid, "global_role": role}
    return req


def batch(ids, req=None, tab="team"):
    return project_router.project_folder_counts_batch(
        project_router.FolderCountsBatchIn(project_ids=ids, tab=tab), req or request()
    )


def test_exclusive_counts_match_legacy_total_and_ignore_nonshared_deleted_empty(catalog):
    seed("final", final=True)
    for index in range(2):
        seed(f"held-{index}", held=True)
    for index in range(5):
        seed(f"shared-{index}")
    seed("private-final", final=True, shared=False)
    seed("private-held", held=True, shared=False)
    seed("deleted", final=True, deleted=True)
    seed("no-folder", folder=None, held=True)
    seed("empty-folder", folder="", final=True)
    seed("different-project", project="other", final=True)
    result = repo.folder_review_counts_batch(["member"])
    assert result == {"member": {"e001/c0010": {"total": 8, "final": 1, "held": 2, "shared": 5}}}
    assert repo.folder_counts("member", shared_only=True) == {"e001/c0010": 8}
    assert repo.folder_counts_batch(["member"], shared_only=True) == {"member": {"e001/c0010": 8}}


def test_final_wins_over_held_and_paths_remain_exact(catalog):
    seed("both-flags", folder="e001", final=True, held=True)
    seed("child", held=True)
    seed("sibling", folder="e001/c00100")
    result = repo.folder_review_counts_batch(["member"])["member"]
    assert result == {
        "e001": {"total": 1, "final": 1, "held": 0, "shared": 0},
        "e001/c0010": {"total": 1, "final": 0, "held": 1, "shared": 0},
        "e001/c00100": {"total": 1, "final": 0, "held": 0, "shared": 1},
    }
    assert all(row["total"] == row["final"] + row["held"] + row["shared"] for row in result.values())


@pytest.mark.parametrize("member_projects,actor,expected", [
    (["member"], "viewer", {"member": 1, "other": 1}),
    ([], "viewer", {"member": 0, "other": 1}),
    (["member"], None, {"member": 1, "other": 0}),
    ([], "\x00", {"member": 0, "other": 0}),
    (None, None, {"member": 1, "other": 2}),
])
def test_visibility_matches_legacy_member_owner_read_all_and_sentinel(
    catalog, member_projects, actor, expected,
):
    seed("member-share", final=True)
    seed("own-nonmember", project="other", creator="viewer", held=True)
    seed("hidden-nonmember", project="other")
    scope = {"team_member_projects": member_projects, "actor_uid": actor}
    result = repo.folder_review_counts_batch(["member", "other"], **scope)
    assert {
        pid: sum(row["total"] for row in paths.values()) for pid, paths in result.items()
    } == expected
    assert {
        pid: {path: row["total"] for path, row in paths.items()} for pid, paths in result.items()
    } == repo.folder_counts_batch(["member", "other"], shared_only=True, **scope)


def test_duplicates_missing_projects_and_empty_input_are_stable(catalog, monkeypatch):
    seed("shared")
    assert list(repo.folder_review_counts_batch(["member", "", "member", "empty", "missing"])) == [
        "member", "empty", "missing",
    ]
    assert repo.folder_review_counts_batch(["empty", "missing"]) == {"empty": {}, "missing": {}}
    connection = Mock(side_effect=AssertionError("empty input must not query the DB"))
    monkeypatch.setattr(project_repo, "get_connection", connection)
    assert repo.folder_review_counts_batch([]) == {}
    assert repo.folder_review_counts_batch([""]) == {}
    connection.assert_not_called()


def test_project_scope_keeps_unknown_workspace_rows(catalog):
    with db.get_connection() as conn:
        conn.execute("UPDATE project SET workspace_scope='team', workspace_id='ws-a' WHERE id='member'")
    seed("legacy-unknown", held=True)
    seed("same-workspace", workspace="ws-a", final=True)
    assert repo.folder_review_counts_batch(["member"])["member"]["e001/c0010"] == {
        "total": 2, "final": 1, "held": 1, "shared": 0,
    }


def test_null_legacy_flags_are_zero_without_changing_real_schema(monkeypatch):
    # nullable 레거시 행은 독립 메모리 DB로 재현한다. 앱 스키마·마이그레이션은 건드리지 않는다.
    conn = sqlite3.connect(":memory:")
    conn.row_factory = sqlite3.Row
    try:
        conn.executescript(
            "CREATE TABLE generation(id TEXT, project_id TEXT, folder_path TEXT, deleted_at TEXT, "
            "creator_uid TEXT, is_final INTEGER, is_held INTEGER);"
            "CREATE TABLE share(generation_id TEXT);"
        )
        conn.executemany(
            "INSERT INTO generation VALUES(?, 'member', 'folder', NULL, 'viewer', ?, ?)",
            [("ordinary", None, None), ("held", None, 1), ("final", 1, None), ("both", 1, 1)],
        )
        conn.execute("INSERT INTO share SELECT id FROM generation")

        @contextmanager
        def isolated_connection():
            yield conn

        monkeypatch.setattr(project_repo, "get_connection", isolated_connection)
        assert repo.folder_review_counts_batch(["member"]) == {
            "member": {"folder": {"total": 4, "final": 2, "held": 1, "shared": 1}},
        }
    finally:
        conn.close()


@pytest.mark.parametrize("route", ["single", "batch"])
def test_team_response_is_additive_and_uses_one_aggregate_select(catalog, monkeypatch, route):
    seed("final", final=True)
    seed("held", held=True)
    seed("shared")
    statements = []
    get_connection = project_repo.get_connection

    @contextmanager
    def traced_connection():
        with get_connection() as conn:
            conn.set_trace_callback(statements.append)
            try:
                yield conn
            finally:
                conn.set_trace_callback(None)

    monkeypatch.setattr(project_repo, "get_connection", traced_connection)
    forbidden = Mock(side_effect=AssertionError("team must not read totals separately"))
    monkeypatch.setattr(repo, "folder_counts", forbidden)
    monkeypatch.setattr(repo, "folder_counts_batch", forbidden)
    req = request(role="admin")
    if route == "single":
        result = project_router.project_folder_counts("member", req, tab="team")
    else:
        result = batch(["member", "empty"], req)
        assert result["counts"]["empty"] == result["review_counts"]["empty"] == {}
        result = {key: result[key]["member"] for key in ("counts", "review_counts")}
    assert result == {
        "counts": {"e001/c0010": 3},
        "review_counts": {"e001/c0010": {"final": 1, "held": 1, "shared": 1}},
    }
    selects = [sql for sql in statements if sql.lstrip().upper().startswith("SELECT")]
    assert len(selects) == 1
    assert "COUNT(*)" in selects[0] and "SUM(" in selects[0]
    forbidden.assert_not_called()


def test_single_and_batch_routes_preserve_nonmember_owner_visibility(catalog):
    seed("owned", project="other", creator="viewer", held=True)
    seed("hidden", project="other", final=True)
    one = project_router.project_folder_counts("other", request(), tab="team")
    many = batch(["other", "member", "other"])
    assert one == {key: many[key]["other"] for key in ("counts", "review_counts")}
    assert one == {
        "counts": {"e001/c0010": 1},
        "review_counts": {"e001/c0010": {"final": 0, "held": 1, "shared": 0}},
    }


@pytest.mark.parametrize("tab", ["my", "invalid", ""])
def test_my_and_invalid_tab_keep_numeric_contract_without_proxy(catalog, monkeypatch, tab):
    seed("private-mine", creator="viewer", shared=False)
    seed("private-theirs", shared=False, folder="hidden")
    monkeypatch.setattr(project_router._proxy, "proxying", lambda: True)
    forbidden = Mock(side_effect=AssertionError("my must not use remote or review counts"))
    monkeypatch.setattr(project_router._proxy, "proxy_get", forbidden)
    monkeypatch.setattr(project_router._proxy, "proxy_json", forbidden)
    monkeypatch.setattr(repo, "folder_review_counts_batch", forbidden)
    assert project_router.project_folder_counts("member", request(), tab=tab) == {
        "counts": {"e001/c0010": 1},
    }
    assert batch(["member", "missing"], tab=tab) == {
        "counts": {"member": {"e001/c0010": 1}, "missing": {}},
    }
    forbidden.assert_not_called()


@pytest.mark.parametrize("new_server", [False, True])
def test_team_proxy_passes_through_old_and_new_responses_without_local_guessing(monkeypatch, new_server):
    response = {"counts": {"folder": 8}}
    if new_server:
        response["review_counts"] = {"folder": {"final": 1, "held": 2, "shared": 5}}
    remote_get = Mock(return_value=response)
    remote_post = Mock(return_value={key: {"member": value} for key, value in response.items()})
    forbidden = Mock(side_effect=AssertionError("team proxy must not read local counts"))
    monkeypatch.setattr(project_router._proxy, "proxying", lambda: True)
    monkeypatch.setattr(project_router._proxy, "proxy_get", remote_get)
    monkeypatch.setattr(project_router._proxy, "proxy_json", remote_post)
    monkeypatch.setattr(repo, "folder_counts", forbidden)
    monkeypatch.setattr(repo, "folder_counts_batch", forbidden)
    monkeypatch.setattr(repo, "folder_review_counts_batch", forbidden)
    req = request(query="tab=team")
    assert project_router.project_folder_counts("member", req, tab="team") is response
    assert batch(["member", "", "member"], req) is remote_post.return_value
    remote_get.assert_called_once_with("/api/projects/member/folder-counts", req)
    remote_post.assert_called_once_with(
        "POST", "/api/projects/folder-counts/batch", body={"project_ids": ["member"], "tab": "team"},
    )
    forbidden.assert_not_called()


def test_batch_limit_is_checked_before_proxy_and_after_deduplication(monkeypatch):
    remote = Mock(return_value={"counts": {}})
    monkeypatch.setattr(project_router._proxy, "proxying", lambda: True)
    monkeypatch.setattr(project_router._proxy, "proxy_json", remote)
    with pytest.raises(HTTPException) as error:
        batch([f"project-{index}" for index in range(101)])
    assert error.value.status_code == 413
    remote.assert_not_called()
    assert batch(["member"] * 101) == {"counts": {}}
    assert remote.call_args.kwargs["body"]["project_ids"] == ["member"]


def test_empty_team_batch_has_both_empty_maps(catalog):
    assert batch([]) == {"counts": {}, "review_counts": {}}

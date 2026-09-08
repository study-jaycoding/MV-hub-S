"""권한 경계 회귀 — 코덱스 레인C C1·C3 (2026-09-09).

C1: 계보 연결(add_history / derive-from)은 자식의 편집 권한만 봤다. 남의 비공개 생성물 id 를 부모로
    걸면 계보 응답으로 그 프롬프트·파라미터·에셋 URL 이 새어 나갔다. 부모는 '열람 가능한 것'만.
C3: 폴더 집계의 tab 이 my/team 이외면 스코프 변수가 전부 None 으로 떨어져 필터 없는 집계가 나갔다.
"""

from __future__ import annotations

import os
import tempfile
from pathlib import Path
from unittest.mock import patch

import pytest
from fastapi import HTTPException, Request

from app import db, deps, repo
from app.routers.generation import _require_parents_viewable
from app.routers.projects import project_folder_counts


def _request(account: dict, path: str = "/api/generations/x/history") -> Request:
    request = Request(
        {"type": "http", "method": "POST", "path": path, "headers": [], "client": ("127.0.0.1", 51000)}
    )
    request.state.account = account
    return request


USER_A = {"email": "a@example.com", "creator_uid": "user_a", "global_roles": []}


@pytest.fixture()
def seeded(monkeypatch):
    """A 의 비공개·B 의 비공개·B 의 공유(A 가 멤버인 프로젝트) 생성물 세 개."""
    with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp:
        old = os.environ.get("CONTENT_HUB_DB")
        os.environ["CONTENT_HUB_DB"] = str(Path(tmp) / "content_hub.db")
        db.flush_pool()
        try:
            monkeypatch.setattr(db, "_POOL_ENABLED", False)
            db.init_db()
            repo.ensure_default_worker()
            with db.get_connection() as conn:
                for uid, name in (("user_a", "A"), ("user_b", "B")):
                    conn.execute(
                        "INSERT INTO worker(id, name, account_type) VALUES(?,?,?) ON CONFLICT(id) DO NOTHING",
                        (uid, name, "team"),
                    )
                conn.execute("INSERT INTO project(id, name, kind, archived) VALUES('p_member','Member','team',0)")
                conn.execute("INSERT INTO project(id, name, kind, archived) VALUES('p_x','X','team',0)")
                conn.execute(
                    "INSERT INTO project_member(project_id, creator_uid, project_role) VALUES('p_member','user_a','creator')"
                )

                def gen(gen_id, creator_uid, project_id, folder_path=None):
                    conn.execute(
                        "INSERT INTO generation(id, worker_id, prompt, status, created_at, sort_ts, "
                        "creator_uid, project_id, folder_path) "
                        "VALUES(?, 'me', ?, 'done', '2026-06-30', '2026-06-30', ?, ?, ?)",
                        (gen_id, "prompt-" + gen_id, creator_uid, project_id, folder_path),
                    )

                gen("g_a", "user_a", "p_x", "mine")
                gen("g_b", "user_b", "p_x", "theirs")  # B 의 비공개 — A 가 보면 안 됨
                gen("g_b_shared", "user_b", "p_member")
                conn.execute(
                    "INSERT INTO share(id, generation_id, shared_by, visibility) VALUES('s1','g_b_shared','user_b','team')"
                )
            yield
        finally:
            db.flush_pool()
            if old is None:
                os.environ.pop("CONTENT_HUB_DB", None)
            else:
                os.environ["CONTENT_HUB_DB"] = old


# ── C1 ────────────────────────────────────────────────────────────────────────
def test_cannot_attach_others_private_generation_as_parent(seeded):
    with patch.object(deps, "AUTH_ENABLED", True):
        with pytest.raises(HTTPException) as ei:
            _require_parents_viewable(_request(USER_A), ["g_b"])
    assert ei.value.status_code == 404  # 존재 자체를 숨긴다(require_view_generation 규약)


def test_own_and_member_shared_parents_are_allowed(seeded):
    with patch.object(deps, "AUTH_ENABLED", True):
        _require_parents_viewable(_request(USER_A), ["g_a"])  # 내 것
        _require_parents_viewable(_request(USER_A), ["g_b_shared"])  # 내가 멤버인 프로젝트의 공유물
        _require_parents_viewable(_request(USER_A), ["g_a", "g_b_shared"])  # derive-from 의 복수 부모


def test_unknown_parent_is_left_to_repo(seeded):
    """로컬에 없는 id(프록시 팀 카드·동기화 전)는 여기서 막지 않는다 — 기존 저장소 판단 유지."""
    with patch.object(deps, "AUTH_ENABLED", True):
        _require_parents_viewable(_request(USER_A), ["not-local", ""])


def test_auth_off_does_not_restrict_parents(seeded):
    with patch.object(deps, "AUTH_ENABLED", False):
        _require_parents_viewable(_request(USER_A), ["g_b"])


# ── C3 ────────────────────────────────────────────────────────────────────────
def test_invalid_tab_is_scoped_like_my(seeded):
    """?tab=invalid 가 필터 없는 집계(남의 비공개 폴더 노출)로 떨어지지 않는다."""
    with patch.object(deps, "AUTH_ENABLED", True):
        req = _request(USER_A, "/api/projects/p_x/folder-counts")
        mine = project_folder_counts("p_x", req, tab="my")["counts"]
        invalid = project_folder_counts("p_x", req, tab="invalid")["counts"]
        empty = project_folder_counts("p_x", req, tab="")["counts"]
    assert "theirs" not in mine
    assert invalid == mine
    assert empty == mine

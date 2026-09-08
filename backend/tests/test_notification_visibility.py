"""알림 센터 가시성 회귀 — 코덱스 레인C C2 (2026-09-09).

알림 규칙의 '내 댓글에 달린 답글' 가지는 그 생성물이 지금도 내게 보이는지 보지 않았다.
프로젝트를 나갔거나 공유가 해제된 뒤 달린 답글의 본문·썸네일 URL 이 알림으로 계속 왔다.
알림 목록·모두 읽음 두 경로에 '내 생성물 OR (공유됨 AND 팀 가시성)' 을 덧붙인다.
카드 배지·통계·패널이 공유하는 ALERT_COMMENT_* 상수는 그대로다(회귀 범위 한정).
"""

from __future__ import annotations

import os
import tempfile
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import pytest

from app import db, deps, repo
from app.routers import notifications

ME = {"email": "me@example.com", "creator_uid": "user-me", "global_roles": []}


def _req(account=ME):
    return SimpleNamespace(state=SimpleNamespace(account=account), headers={}, client=None)


@pytest.fixture()
def seeded(monkeypatch):
    """남의 생성물 'other' 에 내 원글 + 남의 답글. 기본은 공유 안 됨·나는 project-1 멤버 아님."""
    with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp:
        old = os.environ.get("CONTENT_HUB_DB")
        os.environ["CONTENT_HUB_DB"] = str(Path(tmp) / "content_hub.db")
        db.flush_pool()
        try:
            monkeypatch.setattr(db, "_POOL_ENABLED", False)
            db.init_db()
            repo.ensure_default_worker()
            with db.get_connection() as conn:
                for uid, name in (("user-me", "Me"), ("user-someone", "Someone"), ("user-other", "Other")):
                    conn.execute(
                        "INSERT INTO worker(id, name, account_type) VALUES(?,?,?) ON CONFLICT(id) DO NOTHING",
                        (uid, name, "team"),
                    )
                conn.execute("INSERT INTO project(id, name, kind, archived) VALUES('project-1','P1','team',0)")
                conn.executemany(
                    "INSERT INTO generation(id, worker_id, prompt, creator_uid, project_id) VALUES(?, 'me', 'prompt', ?, 'project-1')",
                    [("mine", "user-me"), ("other", "user-someone")],
                )
                conn.execute(
                    "INSERT INTO asset(id, generation_id, type, file_path, thumbnail_path) "
                    "VALUES('a-other', 'other', 'image', '/media/secret.png', '/media/secret-thumb.png')"
                )
                conn.executemany(
                    "INSERT INTO generation_comment(id, gen_id, author, text, parent_id, is_private, created_at) "
                    "VALUES(?,?,?,?,?,0, datetime('now'))",
                    [
                        ("mine-new", "mine", "user-other", "내 생성물의 새 댓글", None),
                        ("other-root", "other", "user-me", "내 원글", None),
                        ("other-reply", "other", "user-other", "권한 잃은 뒤의 답글", "other-root"),
                    ],
                )
            yield
        finally:
            db.flush_pool()
            if old is None:
                os.environ.pop("CONTENT_HUB_DB", None)
            else:
                os.environ["CONTENT_HUB_DB"] = old


def _share_other():
    with db.get_connection() as conn:
        conn.execute("INSERT INTO share(id, generation_id, shared_by, visibility) VALUES('s1','other','user-someone','team')")


def _join_project():
    with db.get_connection() as conn:
        conn.execute("INSERT INTO project_member(project_id, creator_uid, project_role) VALUES('project-1','user-me','creator')")


def _ids(rows):
    return sorted(r["id"] for r in rows)


def test_auth_off_keeps_reply_alert(seeded):
    with patch.object(deps, "AUTH_ENABLED", False):
        rows = notifications.list_comment_notifications(_req(), limit=50)
    assert _ids(rows) == ["mine-new", "other-reply"]


def test_reply_on_invisible_generation_is_hidden_when_auth_on(seeded):
    """공유 안 된 남의 생성물 → 내 원글의 답글이라도 본문·썸네일이 알림으로 오면 안 된다."""
    with patch.object(deps, "AUTH_ENABLED", True):
        rows = notifications.list_comment_notifications(_req(), limit=50)
    assert _ids(rows) == ["mine-new"]
    assert all("secret" not in str(r.get("thumbnail_url") or "") for r in rows)


def test_shared_but_not_member_is_still_hidden(seeded):
    """공유돼 있어도 내가 그 프로젝트 멤버가 아니면 목록(team 탭)과 같은 경계로 안 보인다."""
    _share_other()
    with patch.object(deps, "AUTH_ENABLED", True):
        rows = notifications.list_comment_notifications(_req(), limit=50)
    assert _ids(rows) == ["mine-new"]


def test_shared_and_member_gets_reply_alert(seeded):
    _share_other()
    _join_project()
    with patch.object(deps, "AUTH_ENABLED", True):
        rows = notifications.list_comment_notifications(_req(), limit=50)
    assert _ids(rows) == ["mine-new", "other-reply"]


def test_read_all_role_sees_everything(seeded):
    admin = {"email": "admin@example.com", "creator_uid": "user-me", "global_roles": ["admin"]}
    with patch.object(deps, "AUTH_ENABLED", True), patch.object(
        notifications.rbac, "has_global_cap", lambda roles, cap: cap == "read_all"
    ):
        rows = notifications.list_comment_notifications(_req(admin), limit=50)
    assert _ids(rows) == ["mine-new", "other-reply"]


def test_stats_unread_count_matches_notification_visibility_and_clears(seeded):
    """전역 통계(벨 숫자)도 알림 센터와 같은 경계 — 아니면 '모두 읽음' 뒤에도 숨긴 답글이 1 로 남는다."""
    with patch.object(deps, "AUTH_ENABLED", True):
        stats = lambda ra: repo.generation_stats(viewer_id="user-me", account_uid="user-me", read_all=ra)["unread_count"]
        assert stats(False) == 1  # mine-new 만
        assert stats(True) == 2  # read_all 은 숨김 없음
        notifications.seen_all_comment_notifications(_req())
        assert stats(False) == 0  # 벨이 꺼진다


def test_seen_all_only_touches_visible_alerts(seeded):
    """모두 읽음도 같은 경계 — 보이지 않는 답글을 몰래 읽음 처리하지 않는다."""
    with patch.object(deps, "AUTH_ENABLED", True):
        out = notifications.seen_all_comment_notifications(_req())
    assert out["seen"] == 1  # mine-new 만
    with db.get_connection() as conn:
        seen = {r[0] for r in conn.execute("SELECT comment_id FROM generation_comment_seen WHERE worker_id='user-me'")}
    assert seen == {"mine-new"}

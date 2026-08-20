"""조회 경로 P2 회귀 — F11/F12/F13의 값·쿼리 계약을 고정한다."""

import os
import tempfile
import unittest
from unittest import mock

from fastapi import BackgroundTasks

from app import db, deps, repo
from app.routers import library


class _State:
    pass


class _Request:
    def __init__(self, account: dict | None = None):
        self.state = _State()
        self.state.account = account


class QueryPathP2Tests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(ignore_cleanup_errors=True)
        self.old_db = os.environ.get("CONTENT_HUB_DB")
        os.environ["CONTENT_HUB_DB"] = os.path.join(self.tmp.name, "content_hub.db")
        db.flush_pool()
        db.init_db()
        repo.ensure_default_worker()

    def tearDown(self):
        db.flush_pool()
        if self.old_db is None:
            os.environ.pop("CONTENT_HUB_DB", None)
        else:
            os.environ["CONTENT_HUB_DB"] = self.old_db
        db.flush_pool()
        self.tmp.cleanup()

    def test_shared_comment_anchor_uses_list_row_without_id_resolve_query(self):
        """F11: job_id 우선 앵커 값은 유지하면서 finalize_id_map 호출을 없앤다."""
        rows = [
            {"id": "local-1", "job_id": "server-1", "shared": True, "comment_count": 0},
            {"id": "local-2", "job_id": None, "shared": True, "comment_count": 0},
            {"id": "private-1", "job_id": "ignored", "shared": False, "comment_count": 3},
        ]
        with (
            mock.patch.object(library.repo, "list_generations", return_value=rows),
            mock.patch.object(library._proxy, "proxying", return_value=True),
            mock.patch.object(
                library._proxy,
                "proxy_json",
                return_value={
                    "server-1": {"comment_count": 7, "has_unread": True},
                    "local-2": {"comment_count": 2, "has_unread": False},
                },
            ) as proxy_json,
            mock.patch.object(
                library.repo,
                "finalize_id_map",
                side_effect=AssertionError("목록 앵커는 행의 job_id/id로 충분합니다"),
            ),
            mock.patch.object(
                library.repo,
                "private_generation_comment_counts",
                return_value={"local-1": 1},
            ) as private_counts,
        ):
            result = library.list_generations(
                _Request(),
                BackgroundTasks(),
                tab="my",
                colors=[],
                tags=[],
                auto_tags=[],
                limit=500,
            )

        proxy_json.assert_called_once_with(
            "POST",
            "/api/generations/comment-counts",
            body={"gen_ids": ["server-1", "local-2"]},
            timeout=5,
        )
        self.assertEqual(result[0]["comment_count"], 8)
        self.assertTrue(result[0]["has_unread"])
        self.assertEqual(result[1]["comment_count"], 2)
        self.assertFalse(result[1]["has_unread"])
        self.assertEqual(result[2]["comment_count"], 3)
        private_counts.assert_called_once_with(["local-1", "local-2"], "me")

    def test_batch_visibility_reuses_one_membership_lookup(self):
        """F12: 4개 카드의 기존 가시성 결과를 1회 멤버십 조회로 만든다."""
        request = _Request(
            {
                "email": "viewer@example.com",
                "status": "approved",
                "global_role": "member",
                "creator_uid": "user-viewer",
            }
        )
        local_items = {
            "own": {"id": "own", "creator_uid": "user-viewer", "shared": False},
            "allowed": {
                "id": "allowed",
                "creator_uid": "user-other",
                "shared": True,
                "project_id": "p-allowed",
            },
            "blocked": {
                "id": "blocked",
                "creator_uid": "user-other",
                "shared": True,
                "project_id": "p-blocked",
            },
            "private": {"id": "private", "creator_uid": "user-other", "shared": False},
        }
        local_materials = {gen_id: [f"material-{gen_id}"] for gen_id in local_items}
        with (
            mock.patch.object(library, "AUTH_ENABLED", True),
            mock.patch.object(deps, "AUTH_ENABLED", True),
            mock.patch.object(
                library.repo,
                "get_generations_with_materials",
                return_value=(local_items, local_materials),
            ),
            mock.patch.object(
                library.repo, "my_member_projects", return_value=["p-allowed"]
            ) as member_projects,
            mock.patch.object(library._proxy, "proxying", return_value=False),
        ):
            result = library.get_generations_batch(
                library.GenerationBatchIn(gen_ids=list(local_items)), request
            )

        member_projects.assert_called_once_with("user-viewer")
        self.assertEqual(set(result["items"]), {"own", "allowed"})
        self.assertEqual(result["materials"], {"own": ["material-own"], "allowed": ["material-allowed"]})
        self.assertEqual(result["missing"], ["blocked", "private"])

    def test_member_list_is_read_only_and_keeps_response_values(self):
        """F13: GET /members가 account/creator를 UPDATE하지 않고 기존 행을 그대로 직렬화한다."""
        repo.register("member@example.com", "password-123", "Member")
        with db.get_connection() as conn:
            conn.execute(
                "UPDATE account SET creator_uid='user-member', global_role='member' "
                "WHERE email='member@example.com'"
            )
            conn.execute(
                "INSERT INTO creator(uid, name, global_role) VALUES('user-member','Member','member') "
                "ON CONFLICT(uid) DO UPDATE SET name=excluded.name, global_role=excluded.global_role"
            )
            conn.execute(
                "INSERT INTO creator(uid, name, global_role) VALUES('user-external','External','member')"
            )
            for gen_id, uid, sort_ts in (
                ("member-job", "user-member", 3),
                ("external-1", "user-external", 2),
                ("external-2", "user-external", 1),
            ):
                conn.execute(
                    "INSERT INTO generation(id, worker_id, prompt, status, created_at, sort_ts, creator_uid) "
                    "VALUES(?, 'me', 'p', 'done', '2026-01-01', ?, ?)",
                    (gen_id, sort_ts, uid),
                )
        repo.set_setting("my_creator_uid", "user-member")

        statements: list[str] = []
        with db.get_connection() as conn:
            conn.set_trace_callback(statements.append)
            try:
                members = repo.list_members(viewer_uid="user-member")
            finally:
                conn.set_trace_callback(None)

        self.assertEqual(
            members,
            [
                {
                    "uid": "user-external",
                    "name": "External",
                    "global_roles": ["member"],
                    "is_mine": False,
                    "count": 2,
                    "email": None,
                    "status": None,
                },
                {
                    "uid": "user-member",
                    "name": "Member",
                    "global_roles": ["member"],
                    "is_mine": True,
                    "count": 1,
                    "email": "member@example.com",
                    "status": "approved",
                },
            ],
        )
        writes = [
            statement
            for statement in statements
            if statement.lstrip().upper().startswith(("INSERT", "UPDATE", "DELETE", "REPLACE"))
        ]
        self.assertEqual(writes, [], f"GET /members 중 쓰기 SQL이 실행됐습니다: {writes}")

    def test_account_creation_and_approval_link_creators_before_member_read(self):
        """F13: 연결 책임은 목록이 아니라 계정 생성·승인 쓰기 경로에 있다."""
        repo.register("owner@example.com", "password-123", "Owner")
        pending = repo.register("pending@example.com", "password-123", "Pending")
        self.assertEqual(pending["status"], "pending")
        self.assertEqual(pending["creator_uid"], "acct:pending@example.com")

        approved = repo.set_account_status("pending@example.com", "approved")
        self.assertEqual(approved["creator_uid"], "acct:pending@example.com")
        with db.get_connection() as conn:
            creator = conn.execute(
                "SELECT name FROM creator WHERE uid='acct:pending@example.com'"
            ).fetchone()
        self.assertIsNotNone(creator)
        self.assertEqual(creator["name"], "Pending")


if __name__ == "__main__":
    unittest.main()

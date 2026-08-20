"""알림 센터가 기존 코멘트 알림 판정·seen 모델과 일치하는지 검증."""

from __future__ import annotations

import os
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import patch

from app import db, repo
from app.routers import library, notifications


class NotificationTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory(ignore_cleanup_errors=True)
        self.old_db = os.environ.get("CONTENT_HUB_DB")
        os.environ["CONTENT_HUB_DB"] = os.path.join(self.tmp.name, "content_hub.db")
        db.flush_pool()
        db.init_db()
        repo.ensure_default_worker()
        self.request = SimpleNamespace(
            state=SimpleNamespace(account={"email": "me@example.com", "creator_uid": "user-me"})
        )
        self._seed()

    def tearDown(self) -> None:
        db.flush_pool()
        if self.old_db is None:
            os.environ.pop("CONTENT_HUB_DB", None)
        else:
            os.environ["CONTENT_HUB_DB"] = self.old_db
        db.flush_pool()
        self.tmp.cleanup()

    def _seed(self) -> None:
        with db.get_connection() as conn:
            conn.execute("INSERT INTO creator(uid, name) VALUES('user-other', '다른 팀원')")
            conn.executemany(
                "INSERT INTO generation(id, worker_id, prompt, creator_uid, project_id, deleted_at) "
                "VALUES(?, 'me', 'prompt', ?, 'project-1', ?)",
                [
                    ("mine", "user-me", None),
                    ("other", "user-someone", None),
                    ("deleted", "user-me", "2026-08-01"),
                ],
            )
            conn.execute(
                "INSERT INTO asset(id, generation_id, type, file_path, thumbnail_path) "
                "VALUES('asset-1', 'mine', 'image', '/media/full.png', '/media/thumb.png')"
            )
            comments = [
                ("mine-own", "mine", "user-me", "내가 쓴 글", None, 0, "datetime('now')"),
                ("mine-new", "mine", "user-other", "새 공개 코멘트", None, 0, "datetime('now')"),
                ("mine-read", "mine", "user-other", "읽은 공개 코멘트", None, 0, "datetime('now','-1 hour')"),
                ("mine-private", "mine", "user-other", "남의 비공개", None, 1, "datetime('now')"),
                ("deleted-new", "deleted", "user-other", "삭제물 코멘트", None, 0, "datetime('now')"),
                ("other-root", "other", "user-me", "내 원글", None, 0, "datetime('now','-2 hour')"),
                ("other-reply", "other", "user-other", "내 글의 답글", "other-root", 0, "datetime('now')"),
                ("other-unrelated", "other", "user-other", "무관한 글", None, 0, "datetime('now')"),
                ("mine-old", "mine", "user-other", "오래된 알림", None, 0, "datetime('now','-31 days')"),
            ]
            for cid, gen_id, author, text, parent_id, private, created_expr in comments:
                conn.execute(
                    "INSERT INTO generation_comment(id, gen_id, author, text, parent_id, is_private, created_at) "
                    f"VALUES(?,?,?,?,?,?,{created_expr})",
                    (cid, gen_id, author, text, parent_id, private),
                )
            conn.execute(
                "INSERT INTO generation_comment_seen(worker_id, comment_id) VALUES('user-me','mine-read')"
            )

    def test_list_uses_same_target_rules_and_keeps_read_items(self) -> None:
        items = repo.list_comment_notifications("user-me")
        by_id = {item["id"]: item for item in items}

        self.assertEqual(set(by_id), {"mine-new", "mine-read", "other-reply"})
        self.assertTrue(by_id["mine-new"]["unread"])
        self.assertFalse(by_id["mine-read"]["unread"])
        self.assertEqual(by_id["mine-new"]["author_name"], "다른 팀원")
        self.assertEqual(by_id["mine-new"]["thumbnail_url"], "/media/thumb.png")
        self.assertEqual(by_id["mine-new"]["project_id"], "project-1")

    def test_seen_all_marks_only_notification_targets_including_old(self) -> None:
        seen = repo.mark_all_comment_notifications_seen("user-me")
        self.assertEqual(seen, 3)  # mine-new, other-reply, 최근 목록 밖 mine-old

        with db.get_connection() as conn:
            ids = {
                row["comment_id"]
                for row in conn.execute(
                    "SELECT comment_id FROM generation_comment_seen WHERE worker_id='user-me'"
                ).fetchall()
            }
        self.assertEqual(ids, {"mine-read", "mine-new", "other-reply", "mine-old"})
        self.assertFalse(repo.generation_stats(viewer_id="user-me")["has_unread"])

    def test_local_routes_use_request_identity(self) -> None:
        items = notifications.list_comment_notifications(self.request, limit=50)
        self.assertEqual({item["id"] for item in items}, {"mine-new", "mine-read", "other-reply"})
        result = notifications.seen_all_comment_notifications(self.request)
        self.assertEqual(result, {"ok": True, "seen": 3})

    def test_proxy_stats_uses_server_comment_count_and_local_failures(self) -> None:
        with (
            patch.object(library, "_account_uid", return_value="user-me"),
            patch.object(library._proxy, "proxying", return_value=True),
            patch.object(
                library.repo,
                "generation_stats",
                return_value={"failed_count": 2, "has_unread": False, "unread_count": 0},
            ),
            patch.object(
                library._proxy,
                "proxy_json",
                return_value={"failed_count": 99, "has_unread": True, "unread_count": 4},
            ) as proxy_json,
        ):
            result = library.generation_stats(self.request)

        self.assertEqual(result, {"failed_count": 2, "has_unread": True, "unread_count": 4})
        proxy_json.assert_called_once_with("GET", "/api/generations-stats", timeout=5)


if __name__ == "__main__":
    unittest.main()

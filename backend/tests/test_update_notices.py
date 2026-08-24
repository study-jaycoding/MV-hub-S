"""관리자 릴리스 업데이트 목록·고정·공지·읽음 계약."""

from __future__ import annotations

import os
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import patch

from fastapi import HTTPException

from app import db, repo
from app.routers import update_notices


def _request(role: str = "admin", uid: str = "user-admin"):
    return SimpleNamespace(
        state=SimpleNamespace(
            account={
                "email": f"{uid}@example.com",
                "creator_uid": uid,
                "global_role": role,
            }
        )
    )


def _body(index: int) -> update_notices.ReleaseNoticeIn:
    digest = f"{index:064x}"
    return update_notices.ReleaseNoticeIn(
        version=f"1.0.{index}",
        file=f"MVHub-1.0.{index}.zip",
        sha256=digest,
        size=1000 + index,
        created_at=f"2026-08-{index + 1:02d}T00:00:00+09:00",
    )


class UpdateNoticeTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory(ignore_cleanup_errors=True)
        self.old_db = os.environ.get("CONTENT_HUB_DB")
        os.environ["CONTENT_HUB_DB"] = os.path.join(self.tmp.name, "content_hub.db")
        db.flush_pool()
        db.init_db()

    def tearDown(self) -> None:
        db.flush_pool()
        if self.old_db is None:
            os.environ.pop("CONTENT_HUB_DB", None)
        else:
            os.environ["CONTENT_HUB_DB"] = self.old_db
        db.flush_pool()
        self.tmp.cleanup()

    def _register(self, index: int) -> dict:
        return update_notices.register_update_notice(_body(index), _request())["item"]

    def test_latest_five_displace_only_unpinned_items(self) -> None:
        items = [self._register(index) for index in range(6)]
        repo.set_release_update_notice_pinned(items[0]["id"], True)

        visible = repo.list_release_update_notices_admin()
        ids = [item["id"] for item in visible]
        self.assertEqual(len(ids), 5)
        self.assertIn(items[0]["id"], ids)  # 가장 오래돼도 고정은 남는다.
        self.assertNotIn(items[1]["id"], ids)  # 가장 오래된 비고정만 밀린다.
        self.assertIn(items[5]["id"], ids)

    def test_pin_limit_is_transactionally_enforced(self) -> None:
        items = [self._register(index) for index in range(6)]
        for item in items[:4]:
            repo.set_release_update_notice_pinned(item["id"], True)
        with self.assertRaises(repo.ReleaseNoticePinnedLimitError):
            repo.set_release_update_notice_pinned(items[4]["id"], True)
        self.assertIn(
            items[0]["id"],
            [row["id"] for row in repo.list_release_update_notices_admin()],
        )
        # 네 자리가 고정돼도 가장 최신 비고정 릴리스 한 자리는 항상 남는다.
        self.assertIn(
            items[5]["id"],
            [row["id"] for row in repo.list_release_update_notices_admin()],
        )

    def test_announce_read_and_reannounce_create_a_new_unread_revision(self) -> None:
        item = self._register(1)
        first = update_notices.announce_update_notice(item["id"], _request())["item"]
        listed = update_notices.list_update_notices(_request(uid="user-viewer"))
        self.assertEqual(listed[0]["announcement_revision"], 1)
        self.assertTrue(listed[0]["unread"])

        update_notices.seen_update_notice(
            item["id"], update_notices.SeenIn(revision=1), _request(uid="user-viewer")
        )
        # 이미 읽은 공지를 다시 눌러도 오류가 아닌 멱등 성공이다.
        update_notices.seen_update_notice(
            item["id"], update_notices.SeenIn(revision=1), _request(uid="user-viewer")
        )
        self.assertFalse(update_notices.list_update_notices(_request(uid="user-viewer"))[0]["unread"])

        second = update_notices.announce_update_notice(item["id"], _request())["item"]
        self.assertEqual(second["announcement_revision"], first["announcement_revision"] + 1)
        self.assertTrue(update_notices.list_update_notices(_request(uid="user-viewer"))[0]["unread"])

    def test_management_routes_require_server_admin(self) -> None:
        with patch("app.deps.AUTH_ENABLED", True):
            with self.assertRaises(HTTPException) as caught:
                update_notices.register_update_notice(_body(1), _request(role="member"))
            allowed = update_notices.register_update_notice(_body(2), _request(role="admin"))
        self.assertEqual(caught.exception.status_code, 403)
        self.assertTrue(allowed["created"])

    def test_registration_is_idempotent_by_sha256(self) -> None:
        first = update_notices.register_update_notice(_body(2), _request())
        second = update_notices.register_update_notice(_body(2), _request())
        self.assertTrue(first["created"])
        self.assertFalse(second["created"])
        self.assertEqual(first["item"]["id"], second["item"]["id"])


if __name__ == "__main__":
    unittest.main()

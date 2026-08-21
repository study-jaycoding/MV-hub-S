"""배치 가시성 멤버십 1회 조회 규칙(deps.batch_view_member_projects) 계약."""

from __future__ import annotations

import unittest
from unittest import mock

from fastapi import Request

from app import deps


def _request() -> Request:
    return Request({"type": "http", "client": ("127.0.0.1", 1), "headers": []})


class BatchViewMemberProjectsTests(unittest.TestCase):
    def test_auth_off_returns_none(self):
        with mock.patch.object(deps, "AUTH_ENABLED", False):
            self.assertIsNone(
                deps.batch_view_member_projects(_request(), [{"shared": 1}])
            )

    def test_anonymous_viewer_returns_none(self):
        with (
            mock.patch.object(deps, "AUTH_ENABLED", True),
            mock.patch.object(deps, "account_actor_uid", return_value=None),
        ):
            self.assertIsNone(
                deps.batch_view_member_projects(_request(), [{"shared": 1}])
            )

    def test_read_all_holder_returns_none(self):
        with (
            mock.patch.object(deps, "AUTH_ENABLED", True),
            mock.patch.object(deps, "account_actor_uid", return_value="u1"),
            mock.patch.object(deps.rbac, "has_global_cap", return_value=True),
        ):
            self.assertIsNone(
                deps.batch_view_member_projects(_request(), [{"shared": 1, "creator_uid": "u2"}])
            )

    def test_without_foreign_shared_items_skips_membership_query(self):
        gens = [
            {"shared": 1, "creator_uid": "u1"},  # 내 공유물
            {"shared": 0, "creator_uid": "u2"},  # 남의 비공유물
        ]
        with (
            mock.patch.object(deps, "AUTH_ENABLED", True),
            mock.patch.object(deps, "account_actor_uid", return_value="u1"),
            mock.patch.object(deps.rbac, "has_global_cap", return_value=False),
            mock.patch("app.repo.my_member_projects") as membership,
        ):
            self.assertIsNone(deps.batch_view_member_projects(_request(), gens))
        membership.assert_not_called()

    def test_foreign_shared_item_fetches_membership_exactly_once(self):
        gens = [
            {"shared": 1, "creator_uid": "u1"},
            {"shared": 1, "creator_uid": "u2"},
            {"shared": 1, "creator_uid": None},  # 생성자 미상 공유물도 남의 것으로 취급(종전 규칙)
        ]
        with (
            mock.patch.object(deps, "AUTH_ENABLED", True),
            mock.patch.object(deps, "account_actor_uid", return_value="u1"),
            mock.patch.object(deps.rbac, "has_global_cap", return_value=False),
            mock.patch("app.repo.my_member_projects", return_value=["p1", "p2"]) as membership,
        ):
            result = deps.batch_view_member_projects(_request(), gens)
        self.assertEqual(result, {"p1", "p2"})
        membership.assert_called_once_with("u1")


if __name__ == "__main__":
    unittest.main()

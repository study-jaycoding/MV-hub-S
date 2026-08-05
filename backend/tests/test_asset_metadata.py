"""Assets 메타데이터 하위 라우터의 경계와 하위 호환 테스트."""

from __future__ import annotations

import unittest
from types import SimpleNamespace
from unittest.mock import patch

from app.routers import _assets_access, assets, assets_metadata
from app.services import asset_paths


class AssetMetadataTests(unittest.TestCase):
    def setUp(self) -> None:
        self.request = SimpleNamespace(state=SimpleNamespace(account=None))

    def test_metadata_routes_keep_original_paths_and_methods(self) -> None:
        actual = [
            (route.path, method)
            for route in assets.router.routes
            for method in (route.methods or set())
        ]
        expected = {
            ("/api/assets/meta", "GET"),
            ("/api/assets/comments", "GET"),
            ("/api/assets/comments", "POST"),
            ("/api/assets/comments/{comment_id}", "PUT"),
            ("/api/assets/comments/{comment_id}", "DELETE"),
            ("/api/assets/comments/read", "POST"),
            ("/api/assets/tags", "PUT"),
            ("/api/assets/comment", "PUT"),
            ("/api/assets/color", "PUT"),
        }
        for route_contract in expected:
            self.assertEqual(
                actual.count(route_contract),
                1,
                f"Assets 메타 라우트 등록 수가 다릅니다: {route_contract}",
            )

    def test_combined_project_meta_uses_real_folder_keys(self) -> None:
        with (
            patch.object(_assets_access, "AUTH_ENABLED", False),
            patch.object(assets_metadata, "actor_id", return_value="me"),
            patch.object(assets_metadata._proxy, "proxying", return_value=False),
            patch.object(
                assets_metadata.repo,
                "get_asset_meta",
                side_effect=[
                    {"cap.png": {"tags": ["capture"]}},
                    {"ref.png": {"tags": ["import"]}},
                ],
            ) as get_meta,
        ):
            result = assets_metadata.asset_meta(
                self.request,
                project=asset_paths.COMBINED_INTERNAL_PROJECT,
            )

        self.assertEqual(
            result,
            {
                "captures/cap.png": {"tags": ["capture"]},
                "imports/ref.png": {"tags": ["import"]},
            },
        )
        self.assertEqual(
            [call.args for call in get_meta.call_args_list],
            [("captures", "me"), ("imports", "me")],
        )

    def test_remote_comment_badges_do_not_overwrite_personal_meta(self) -> None:
        personal = {
            "frame.png": {
                "is_source": True,
                "source_name": "hero",
                "tags": ["keep"],
                "comment": "private note",
                "color": "r",
                "comment_count": 0,
                "has_unread": False,
            }
        }
        remote = {
            "frame.png": {"comment_count": 2, "has_unread": True},
            "remote-only.png": {"comment_count": 1, "has_unread": False},
        }
        with (
            patch.object(_assets_access, "AUTH_ENABLED", False),
            patch.object(assets_metadata, "actor_id", return_value="me"),
            patch.object(assets_metadata.repo, "get_asset_meta", return_value=personal),
            patch.object(assets_metadata._proxy, "proxying", return_value=True),
            patch.object(assets_metadata._proxy, "proxy_json", return_value=remote),
        ):
            result = assets_metadata.asset_meta(self.request, project="demo")

        self.assertEqual(result["frame.png"]["tags"], ["keep"])
        self.assertEqual(result["frame.png"]["comment"], "private note")
        self.assertEqual(result["frame.png"]["comment_count"], 2)
        self.assertTrue(result["frame.png"]["has_unread"])
        self.assertEqual(result["remote-only.png"]["comment_count"], 1)
        self.assertEqual(result["remote-only.png"]["tags"], [])

    def test_add_comment_ignores_payload_author_and_maps_combined_path(self) -> None:
        body = assets_metadata.CommentAddIn(
            project=asset_paths.COMBINED_INTERNAL_PROJECT,
            path="captures/frame.png",
            text="  review  ",
            author="spoofed",
        )
        with (
            patch.object(assets_metadata._proxy, "proxying", return_value=False),
            patch.object(
                _assets_access,
                "require_asset_comment_access",
            ) as require_access,
            patch.object(assets_metadata, "actor_id", return_value="real-user"),
            patch.object(
                assets_metadata.repo,
                "add_asset_comment",
                return_value="comment-1",
            ) as add_comment,
        ):
            result = assets_metadata.add_comment(body, self.request)

        self.assertEqual(result, {"id": "comment-1"})
        require_access.assert_called_once_with(
            "captures",
            self.request,
            write=True,
        )
        add_comment.assert_called_once_with(
            "captures",
            "frame.png",
            "real-user",
            "review",
            None,
            False,
        )


if __name__ == "__main__":
    unittest.main()

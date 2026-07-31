"""공유 Assets 경계 테스트."""

import unittest
from types import SimpleNamespace
from unittest import mock

from fastapi import HTTPException

from app.routers import assets


class AssetPermissionTests(unittest.TestCase):
    def setUp(self):
        self.request = SimpleNamespace(state=SimpleNamespace(account={"email": "u@example.com"}))

    def test_unknown_project_comments_are_rejected_on_shared_server(self):
        with (
            mock.patch.object(assets, "AUTH_ENABLED", True),
            mock.patch.object(assets.repo, "get_project_by_name", return_value=None),
        ):
            with self.assertRaises(HTTPException) as ctx:
                assets._require_asset_comment_access("unknown", self.request, write=False)
        self.assertEqual(ctx.exception.status_code, 403)

    def test_read_and_write_use_different_project_role_modes(self):
        project = {"id": "p1"}
        with (
            mock.patch.object(assets, "AUTH_ENABLED", True),
            mock.patch.object(assets.repo, "get_project_by_name", return_value=project),
            mock.patch.object(assets, "require_project_role") as require,
        ):
            assets._require_asset_comment_access("Project", self.request, write=False)
            self.assertTrue(require.call_args.kwargs["read_only"])
            assets._require_asset_comment_access("Project", self.request, write=True)
            self.assertFalse(require.call_args.kwargs["read_only"])

    def test_projects_and_mounts_routes_have_local_dependencies(self):
        guarded = set()
        for route in assets.router.routes:
            if route.path in ("/api/assets/projects", "/api/assets/mounts"):
                guarded.add(route.path)
                self.assertTrue(route.dependant.dependencies)
        self.assertEqual(
            guarded,
            {"/api/assets/projects", "/api/assets/mounts"},
        )


if __name__ == "__main__":
    unittest.main()

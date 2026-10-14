"""이름에 '/' 가 든 태그·전역 태그·Assets 등록을 지울 수 있다(서버셋 설계 ①, Jay 결정 9A 10-15).

브라우저는 이름을 encodeURIComponent 로 한 칸에 넣지만(`/` → %2F), 서버가 %2F 를 '/' 로 풀어 라우팅해 한 칸
라우트(`{tag}`)와 맞지 않았다 — 404/405 로 지울 길이 없었다. 라우터만 붙인 작은 앱으로 실제 라우팅을 거친다.
"""

import unittest
from unittest import mock

from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.routers import assets, generation, library

NAMES = {"a%2Fb": "a/b", "a%2F": "a/", "%2Fa": "/a", "plain": "plain"}


def _client(router, overrides=None) -> TestClient:
    app = FastAPI()
    app.include_router(router)
    app.dependency_overrides.update(overrides or {})
    return TestClient(app)


class SlashNameDeleteTests(unittest.TestCase):
    def test_tag_delete_reaches_handler_with_full_name(self):
        client = _client(generation.router)
        for raw, name in NAMES.items():
            with self.subTest(raw=raw), \
                    mock.patch.object(generation, "account_scope_uid", return_value=None), \
                    mock.patch.object(generation.repo, "delete_tag_everywhere", return_value=1) as delete:
                res = client.delete(f"/api/tags/{raw}")
                self.assertEqual(res.status_code, 200, res.text)
                delete.assert_called_once_with(name, account_uid=None)

    def test_auto_tag_delete_reaches_handler_with_full_name(self):
        client = _client(library.router)
        for raw, name in NAMES.items():
            with self.subTest(raw=raw), \
                    mock.patch.object(library, "_tag_owner", return_value="u1"), \
                    mock.patch.object(library.repo, "delete_auto_tag", return_value=1) as delete:
                res = client.delete(f"/api/auto-tags/{raw}")
                self.assertEqual(res.status_code, 200, res.text)
                delete.assert_called_once_with(name, "u1")

    def test_mount_delete_reaches_handler_with_full_name(self):
        client = _client(assets.router, {assets._require_mount_manager: lambda: None})
        for raw, name in NAMES.items():
            with self.subTest(raw=raw), \
                    mock.patch.object(assets, "actor_id", return_value="u1"), \
                    mock.patch.object(assets, "_mounts_file", return_value="mounts.json"), \
                    mock.patch.object(assets, "_mounts_payload", return_value={"mounts": []}), \
                    mock.patch.object(assets.asset_mounts, "remove") as remove, \
                    mock.patch.object(assets.asset_watcher, "unwatch"):
                res = client.delete(f"/api/assets/mounts/{raw}")
                self.assertEqual(res.status_code, 200, res.text)
                remove.assert_called_once_with("mounts.json", name=name, owner="u1")


if __name__ == "__main__":
    unittest.main()

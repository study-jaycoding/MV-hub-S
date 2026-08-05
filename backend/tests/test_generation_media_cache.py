"""생성물 원격 미디어 보관 흐름의 특성화 테스트.

다운로드 서비스와 repo를 가짜로 바꿔 실제 네트워크·파일·DB에는 접근하지 않는다.
"""

from types import SimpleNamespace
from unittest import IsolatedAsyncioTestCase
from unittest.mock import AsyncMock, call, patch


class GenerationMediaCacheTests(IsolatedAsyncioTestCase):
    async def test_cache_generation_updates_only_successful_remote_media(self):
        from app import repo
        from app.services import media_cache
        from app.usecases import generation_media_cache

        generation_row = {
            "assets": [
                {
                    "id": "asset-image",
                    "file_path": "https://cdn.example.com/image.png",
                    "type": "image",
                },
                {
                    "id": "asset-video",
                    "file_path": "https://cdn.example.com/video.mp4",
                    "type": "video",
                },
                {
                    "id": "asset-local",
                    "file_path": "/media/already.png",
                    "type": "image",
                },
            ],
            "references": [
                {
                    "id": "ref-image",
                    "file_path": "https://cdn.example.com/ref.png",
                    "type": "image",
                },
                {
                    "id": "ref-failed",
                    "file_path": "https://cdn.example.com/missing.mp4",
                    "type": "video",
                },
            ],
        }
        cached_paths = {
            "https://cdn.example.com/image.png": "/media/image.png",
            "https://cdn.example.com/video.mp4": "/media/video.mp4",
            "https://cdn.example.com/ref.png": "/media/ref.png",
            "https://cdn.example.com/missing.mp4": None,
        }

        with (
            patch.object(
                media_cache,
                "cache_url",
                new=AsyncMock(side_effect=lambda url: cached_paths[url]),
            ) as cache_url,
            patch.object(repo, "update_asset_cache") as update_asset_cache,
            patch.object(repo, "update_reference_cache") as update_reference_cache,
        ):
            result = await generation_media_cache.cache_generation_media(generation_row)

        self.assertEqual(
            cache_url.await_args_list,
            [
                call("https://cdn.example.com/image.png"),
                call("https://cdn.example.com/video.mp4"),
                call("https://cdn.example.com/ref.png"),
                call("https://cdn.example.com/missing.mp4"),
            ],
        )
        self.assertEqual(
            update_asset_cache.call_args_list,
            [
                call(
                    "asset-image",
                    "/media/image.png",
                    "/media/image.png",
                    "https://cdn.example.com/image.png",
                ),
                call(
                    "asset-video",
                    "/media/video.mp4",
                    None,
                    "https://cdn.example.com/video.mp4",
                ),
            ],
        )
        update_reference_cache.assert_called_once_with(
            "ref-image",
            "/media/ref.png",
            "/media/ref.png",
            "https://cdn.example.com/ref.png",
        )
        self.assertEqual(result, {"cached": 3, "failed": 1, "skipped": 0})

    async def test_cache_generation_skips_already_local_media_without_download(self):
        from app import repo
        from app.services import media_cache
        from app.usecases import generation_media_cache

        generation_row = {
            "assets": [
                {"id": "asset-local", "file_path": "/media/a.png", "type": "image"}
            ],
            "references": [
                {"id": "ref-local", "file_path": "/media/r.mp4", "type": "video"}
            ],
        }

        with (
            patch.object(media_cache, "cache_url", new=AsyncMock()) as cache_url,
            patch.object(repo, "update_asset_cache") as update_asset_cache,
            patch.object(repo, "update_reference_cache") as update_reference_cache,
        ):
            result = await generation_media_cache.cache_generation_media(generation_row)

        cache_url.assert_not_awaited()
        update_asset_cache.assert_not_called()
        update_reference_cache.assert_not_called()
        self.assertEqual(result, {"cached": 0, "failed": 0, "skipped": 0})

    async def test_cache_all_aggregates_success_failure_and_missing_generation(self):
        from app import deps, repo
        from app.routers import generation
        from app.services import media_cache

        generations = {
            "gen-ok": {
                "assets": [
                    {
                        "id": "asset-ok",
                        "file_path": "https://cdn.example.com/ok.png",
                        "type": "image",
                    }
                ],
                "references": [],
            },
            "gen-failed": {
                "assets": [],
                "references": [
                    {
                        "id": "ref-failed",
                        "file_path": "https://cdn.example.com/fail.mp4",
                        "type": "video",
                    }
                ],
            },
        }

        with (
            patch.object(deps, "require_admin") as require_admin,
            patch.object(
                repo,
                "all_generation_ids",
                return_value=["gen-ok", "gen-gone", "gen-failed"],
            ),
            patch.object(repo, "get_generation", side_effect=lambda gen_id: generations.get(gen_id)),
            patch.object(repo, "update_asset_cache") as update_asset_cache,
            patch.object(repo, "update_reference_cache") as update_reference_cache,
            patch.object(
                media_cache,
                "cache_url",
                new=AsyncMock(
                    side_effect=lambda url: (
                        "/media/ok.png" if url.endswith("ok.png") else None
                    )
                ),
            ),
        ):
            request = SimpleNamespace()
            result = await generation.cache_all(request)

        require_admin.assert_called_once_with(request)
        update_asset_cache.assert_called_once_with(
            "asset-ok",
            "/media/ok.png",
            "/media/ok.png",
            "https://cdn.example.com/ok.png",
        )
        update_reference_cache.assert_not_called()
        self.assertEqual(result, {"cached": 1, "failed": 1, "generations": 1})


if __name__ == "__main__":
    import unittest

    unittest.main()

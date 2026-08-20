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
            "https://cdn.example.com/image.png": media_cache.MediaCacheResult("/media/image.png", "cached", 10),
            "https://cdn.example.com/video.mp4": media_cache.MediaCacheResult("/media/video.mp4", "cached", 20),
            "https://cdn.example.com/ref.png": media_cache.MediaCacheResult("/media/ref.png", "cached", 5),
            "https://cdn.example.com/missing.mp4": media_cache.MediaCacheResult(
                None, "permanent", error_code="remote_unavailable"
            ),
            "/media/already.png": media_cache.MediaCacheResult("/media/already.png", "already"),
        }

        with (
            patch.object(
                media_cache,
                "cache_url_result",
                new=AsyncMock(side_effect=lambda url: cached_paths[url]),
            ) as cache_url_result,
            patch.object(media_cache, "local_media_exists", return_value=True),
            patch.object(repo, "update_asset_cache") as update_asset_cache,
            patch.object(repo, "update_reference_cache") as update_reference_cache,
        ):
            result = await generation_media_cache.cache_generation_media(generation_row)

        self.assertEqual(
            cache_url_result.await_args_list,
            [
                call("https://cdn.example.com/image.png"),
                call("https://cdn.example.com/video.mp4"),
                call("/media/already.png"),
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
        self.assertEqual(result["cached"], 3)
        self.assertEqual(result["already"], 1)
        self.assertEqual(result["failed"], 1)
        self.assertEqual(result["bytes_cached"], 35)
        self.assertEqual(result["failure_codes"], {"remote_unavailable": 1})

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
            patch.object(media_cache, "local_media_exists", return_value=True),
            patch.object(
                media_cache,
                "cache_url_result",
                new=AsyncMock(side_effect=lambda url: media_cache.MediaCacheResult(url, "already")),
            ) as cache_url_result,
            patch.object(repo, "update_asset_cache") as update_asset_cache,
            patch.object(repo, "update_reference_cache") as update_reference_cache,
        ):
            result = await generation_media_cache.cache_generation_media(generation_row)

        self.assertEqual(cache_url_result.await_count, 2)
        update_asset_cache.assert_not_called()
        update_reference_cache.assert_not_called()
        self.assertEqual(result["cached"], 0)
        self.assertEqual(result["already"], 2)
        self.assertEqual(result["failed"], 0)

    async def test_existing_cached_file_still_rewrites_remote_database_path(self):
        from app import repo
        from app.services import media_cache
        from app.usecases import generation_media_cache

        remote = "https://cdn.example.com/shared.png"
        generation_row = {
            "assets": [
                {"id": "asset-a", "file_path": remote, "type": "image"},
                {"id": "asset-b", "file_path": remote, "type": "image"},
            ],
            "references": [],
        }
        results = [
            media_cache.MediaCacheResult("/media/shared.png", "cached", 12),
            media_cache.MediaCacheResult("/media/shared.png", "already"),
        ]
        with (
            patch.object(media_cache, "local_media_exists", return_value=False),
            patch.object(
                media_cache,
                "cache_url_result",
                new=AsyncMock(side_effect=results),
            ),
            patch.object(repo, "update_asset_cache") as update_asset_cache,
        ):
            result = await generation_media_cache.cache_generation_media(generation_row)

        self.assertEqual(
            update_asset_cache.call_args_list,
            [
                call("asset-a", "/media/shared.png", "/media/shared.png", remote),
                call("asset-b", "/media/shared.png", "/media/shared.png", remote),
            ],
        )
        self.assertEqual(result["cached"], 1)
        self.assertEqual(result["already"], 1)

    async def test_cache_all_queues_bounded_background_preservation(self):
        from app import deps, repo
        from app.routers import generation

        with (
            patch.object(deps, "require_admin") as require_admin,
            patch.object(
                repo,
                "all_generation_ids",
                return_value=["gen-ok", "gen-gone", "gen-failed"],
            ),
            patch.object(
                repo,
                "get_generation",
                side_effect=lambda gen_id: None if gen_id == "gen-gone" else {"status": "done"},
            ),
            patch.object(
                repo, "request_media_preservation",
                side_effect=lambda gen_id, _reason, force=False: gen_id != "gen-gone",
            ) as request_preservation,
        ):
            request = SimpleNamespace()
            result = await generation.cache_all(request)

        require_admin.assert_called_once_with(request)
        self.assertEqual(request_preservation.call_count, 2)
        self.assertEqual(result["queued"], 2)


if __name__ == "__main__":
    import unittest

    unittest.main()

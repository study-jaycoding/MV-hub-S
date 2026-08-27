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
            patch.object(generation, "MEDIA_PRESERVATION_ENABLED", True),
            patch.object(
                repo, "request_media_preservation_for_all_done", return_value=2
            ) as batch,
        ):
            request = SimpleNamespace()
            result = await generation.cache_all(request)

        require_admin.assert_called_once_with(request)
        batch.assert_called_once_with()
        self.assertEqual(result["queued"], 2)


class CacheAllBatchEquivalenceTests(IsolatedAsyncioTestCase):
    """배치 등록이 종전 항목별 루프와 같은 최종 상태를 만드는지 — 실제 DB 오라클 비교."""

    # 타임스탬프(now 기록)는 실행 시각에 따라 달라 등가 비교에서 제외하고 의미만 별도 검증.
    _STABLE_COLS = "generation_id, reason, status, error_code, next_retry_at"

    def _seed(self, tmp_dir: str) -> None:
        import os

        from app import db, repo

        os.environ["CONTENT_HUB_DB"] = os.path.join(tmp_dir, "content_hub.db")
        db.flush_pool()
        db.init_db()
        repo.ensure_default_worker()
        with db.get_connection() as conn:
            rows = [
                ("g-new", "done", None),          # 보존 행 없음 → 신규 pending
                ("g-pending", "done", "pending"),
                ("g-running", "done", "running"),  # force 여도 건드리지 않음
                ("g-complete", "done", "complete"),
                ("g-failed", "done", "failed"),
                ("g-notdone", "pending", "pending"),  # done 아님 → 제외
            ]
            for gid, status, _mp in rows:
                conn.execute(
                    "INSERT INTO generation(id, worker_id, prompt, status, created_at, sort_ts) "
                    "VALUES(?, 'me', 'p', ?, '2026-01-01', 1)",
                    (gid, status),
                )
            # 휴지통(soft delete) done 행 — 종전 루프도 포함했으므로 배치도 포함해야 한다.
            conn.execute(
                "INSERT INTO generation(id, worker_id, prompt, status, created_at, sort_ts, deleted_at) "
                "VALUES('g-trashed', 'me', 'p', 'done', '2026-01-01', 1, '2026-02-01')"
            )
            seeds = [
                ("g-pending", "shared", "pending", None, None),      # admin 으로 승격
                ("g-running", "final", "running", "err", "2020-01-01 00:00:00"),
                ("g-complete", "final", "complete", None, None),     # final 유지(우선순위 높음)
                ("g-failed", "manual", "failed", "boom", "2020-01-01 00:00:00"),
                ("g-notdone", "shared", "failed", "keep", "2020-01-01 00:00:00"),
            ]
            for gid, reason, status, error, retry in seeds:
                conn.execute(
                    "INSERT INTO media_preservation(generation_id, reason, status, error_code, "
                    "next_retry_at, requested_at, updated_at) "
                    "VALUES(?,?,?,?,?, '2020-01-01 00:00:00', '2020-01-01 00:00:00')",
                    (gid, reason, status, error, retry),
                )

    def _dump(self):
        from app import db

        with db.get_connection() as conn:
            stable = conn.execute(
                f"SELECT {self._STABLE_COLS} FROM media_preservation ORDER BY generation_id"
            ).fetchall()
            stamps = conn.execute(
                "SELECT generation_id, requested_at='2020-01-01 00:00:00' AS requested_kept "
                "FROM media_preservation ORDER BY generation_id"
            ).fetchall()
        return [tuple(row) for row in stable], {r[0]: bool(r[1]) for r in stamps}

    async def test_batch_registration_outcomes(self):
        """현행 `request_media_preservation_for_all_done` 의 최종 상태 — running 은 보존, failed/complete 는 재장전,
        done 아님은 제외, 휴지통 done 은 포함. (종전에는 항목별 루프와 등가 비교했으나 그 루프는 호출자가 없어 제거.)"""
        import os
        import tempfile

        from app import db, repo

        old_db = os.environ.get("CONTENT_HUB_DB")
        try:
            with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp:
                self._seed(tmp)
                queued = repo.request_media_preservation_for_all_done()
                rows, stamps = self._dump()
                db.flush_pool()
        finally:
            if old_db is None:
                os.environ.pop("CONTENT_HUB_DB", None)
            else:
                os.environ["CONTENT_HUB_DB"] = old_db
            db.flush_pool()

        by_id = {row[0]: row for row in rows}
        self.assertGreaterEqual(queued, 1)
        # 보존 행이 없던 done 행(휴지통 포함)은 새로 pending 등록된다.
        self.assertEqual(by_id["g-new"][2], "pending")
        self.assertEqual(by_id["g-trashed"][2], "pending")
        # running 은 force 여도 건드리지 않는다(행·requested_at 그대로).
        self.assertEqual(by_id["g-running"], ("g-running", "final", "running", "err", "2020-01-01 00:00:00"))
        self.assertTrue(stamps["g-running"])
        # failed/complete 는 재장전 대상 — requested_at 이 갱신된다.
        self.assertFalse(stamps["g-complete"])
        self.assertFalse(stamps["g-failed"])
        # done 아님 행은 건드리지 않는다(기존 값 유지).
        self.assertTrue(stamps["g-notdone"])
        self.assertEqual(by_id["g-notdone"][2], "failed")


if __name__ == "__main__":
    import unittest

    unittest.main()

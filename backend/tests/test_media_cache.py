import asyncio
import os
import tempfile
import time
import unittest
import urllib.error
from pathlib import Path
from unittest import mock

from app.services import media_cache


class MediaCacheTests(unittest.TestCase):
    def test_failed_download_logs_reason_without_query_secret(self):
        with tempfile.TemporaryDirectory() as td:
            old_media_dir = media_cache.MEDIA_DIR
            media_cache.MEDIA_DIR = Path(td)
            try:
                with mock.patch.object(media_cache, "_download", side_effect=RuntimeError("boom")):
                    with self.assertLogs("app.services.media_cache", level="WARNING") as logs:
                        result = asyncio.run(
                            media_cache.cache_url("https://cdn.example.com/video.mp4?sig=secret")
                        )
                self.assertIsNone(result)
                joined = "\n".join(logs.output)
                self.assertIn("boom", joined)
                self.assertIn("https://cdn.example.com/video.mp4", joined)
                self.assertNotIn("sig=secret", joined)
            finally:
                media_cache.MEDIA_DIR = old_media_dir

    def test_same_url_concurrent_cache_uses_one_download(self):
        with tempfile.TemporaryDirectory() as td:
            old_media_dir = media_cache.MEDIA_DIR
            media_cache.MEDIA_DIR = Path(td)
            calls = 0

            def fake_download(url: str, target: Path) -> None:
                nonlocal calls
                calls += 1
                time.sleep(0.05)
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(b"media")

            async def run_two():
                with mock.patch.object(media_cache, "_download", side_effect=fake_download):
                    return await asyncio.gather(
                        media_cache.cache_url("https://cdn.example.com/a.mp4"),
                        media_cache.cache_url("https://cdn.example.com/a.mp4"),
                    )

            try:
                results = asyncio.run(run_two())
            finally:
                media_cache.MEDIA_DIR = old_media_dir

            self.assertEqual(results[0], results[1])
            self.assertEqual(calls, 1)

    def test_lock_table_is_emptied_after_use(self):
        # rel 별 락을 쓰고 나면 _LOCKS/_LOCK_REFS 에 잔재가 없어야 한다(장기구동 메모리 누적 방지).
        with tempfile.TemporaryDirectory() as td:
            old_media_dir = media_cache.MEDIA_DIR
            media_cache.MEDIA_DIR = Path(td)

            def ok_download(url: str, target: Path) -> None:
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(b"media")

            async def scenario():
                with mock.patch.object(media_cache, "_download", side_effect=ok_download):
                    await media_cache.cache_url("https://cdn.example.com/keep.mp4")
                # 실패 경로도 동일하게 정리되어야 함
                with mock.patch.object(media_cache, "_download", side_effect=RuntimeError("boom")):
                    await media_cache.cache_url("https://cdn.example.com/fail.mp4")

            try:
                asyncio.run(scenario())
                self.assertEqual(media_cache._LOCKS, {})
                self.assertEqual(media_cache._LOCK_REFS, {})
            finally:
                media_cache.MEDIA_DIR = old_media_dir

    def test_html_response_is_rejected(self):
        with self.assertRaises(media_cache.MediaCachePermanentError):
            media_cache._validate_response(
                "text/html; charset=utf-8",
                b"<!doctype html><html>expired</html>",
            )

    def test_thumb_source_cache_is_separate_and_lru_bounded(self):
        """썸네일 원격 원본만 지우며 영구 MEDIA 파일은 보존한다."""
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            persistent = root / "aa" / "keep.png"
            persistent.parent.mkdir(parents=True)
            persistent.write_bytes(b"p" * 100)

            source_dir = root / ".thumb-sources" / "bb"
            source_dir.mkdir(parents=True)
            old = source_dir / "old.png"
            fresh = source_dir / "fresh.png"
            old.write_bytes(b"o" * 100)
            fresh.write_bytes(b"f" * 100)
            old_time = time.time() - 86400
            old.touch()
            fresh.touch()
            os.utime(old, (old_time, old_time))

            with mock.patch.object(media_cache, "MEDIA_DIR", root):
                media_cache._THUMB_SOURCE_STATE.clear()
                removed = media_cache.evict_thumb_source_cache(max_bytes=100)
                self.assertEqual(removed, 1)
                self.assertFalse(old.exists())
                self.assertTrue(fresh.exists())
                self.assertTrue(persistent.exists())

    def test_thumb_source_url_uses_dedicated_directory(self):
        rel = media_cache.thumb_source_rel_for("https://cdn.example.com/image.png?sig=x")
        self.assertTrue(rel.startswith("/media/.thumb-sources/"))
        self.assertTrue(rel.endswith(".png"))

    def test_permanent_thumb_failure_is_negative_cached(self):
        with tempfile.TemporaryDirectory() as td:
            url = "https://cdn.example.com/expired.png"
            calls = 0

            def fail(*_args, **_kwargs):
                nonlocal calls
                calls += 1
                raise media_cache.MediaCachePermanentError("HTTP Error 403")

            with (
                mock.patch.object(media_cache, "MEDIA_DIR", Path(td)),
                mock.patch.object(media_cache, "_download", side_effect=fail),
            ):
                media_cache._THUMB_FAILURES.clear()
                self.assertIsNone(asyncio.run(media_cache.cache_thumb_source(url)))
                self.assertIsNone(asyncio.run(media_cache.cache_thumb_source(url)))
                self.assertEqual(calls, 1)
                media_cache._THUMB_FAILURES.clear()

    def test_temporary_thumb_failure_is_retried_next_call(self):
        with tempfile.TemporaryDirectory() as td:
            calls = 0

            def fail(*_args, **_kwargs):
                nonlocal calls
                calls += 1
                raise RuntimeError("temporary")

            with (
                mock.patch.object(media_cache, "MEDIA_DIR", Path(td)),
                mock.patch.object(media_cache, "_download", side_effect=fail),
            ):
                media_cache._THUMB_FAILURES.clear()
                asyncio.run(media_cache.cache_thumb_source("https://cdn.example.com/flaky.png"))
                asyncio.run(media_cache.cache_thumb_source("https://cdn.example.com/flaky.png"))
                self.assertEqual(calls, 2)

    def test_http_403_is_not_retried_inside_download(self):
        error = urllib.error.HTTPError(
            "https://cdn.example.com/expired.png", 403, "Forbidden", None, None
        )
        with mock.patch.object(media_cache, "_download_once", side_effect=error) as call:
            with self.assertRaises(media_cache.MediaCachePermanentError):
                media_cache._download(
                    "https://cdn.example.com/expired.png", Path("unused-target.png")
                )
        self.assertEqual(call.call_count, 1)

    def test_preserved_media_quota_rejects_only_new_file(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            old = root / "aa" / "old.mp4"
            new = root / "bb" / "new.mp4"
            old.parent.mkdir(parents=True)
            new.parent.mkdir(parents=True)
            old.write_bytes(b"o" * 8)
            new.write_bytes(b"n" * 8)
            with (
                mock.patch.object(media_cache, "MEDIA_DIR", root),
                mock.patch.object(media_cache, "PRESERVED_MEDIA_MAX_BYTES", 10),
            ):
                with self.assertRaises(media_cache.MediaCacheCapacityError):
                    media_cache._enforce_preserved_quota(new, newly_created=True)
            self.assertTrue(old.exists())
            self.assertFalse(new.exists())

    def test_detailed_cache_result_hides_capacity_error_details(self):
        with tempfile.TemporaryDirectory() as td:
            with (
                mock.patch.object(media_cache, "MEDIA_DIR", Path(td)),
                mock.patch.object(
                    media_cache,
                    "_download",
                    side_effect=media_cache.MediaCacheCapacityError("secret path and sizes"),
                ),
            ):
                result = asyncio.run(
                    media_cache.cache_url_result("https://cdn.example.com/a.mp4?sig=secret")
                )
            self.assertEqual(result.status, "capacity")
            self.assertEqual(result.error_code, "capacity")
            self.assertNotIn("secret", repr(result))


if __name__ == "__main__":
    unittest.main()

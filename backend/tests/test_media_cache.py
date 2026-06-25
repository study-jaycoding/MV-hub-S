import asyncio
import tempfile
import time
import unittest
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


if __name__ == "__main__":
    unittest.main()

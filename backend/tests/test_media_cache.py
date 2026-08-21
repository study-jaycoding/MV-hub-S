import asyncio
import os
import tempfile
import threading
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

    def test_account_thumb_source_updates_known_set_in_place(self):
        """R4 C-4: 새 원본 계상은 set 제자리 갱신(삽입마다 전체 복사 금지) + 중복 미계상."""
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            source_dir = root / ".thumb-sources"
            source_dir.mkdir(parents=True)
            f1 = source_dir / "a.png"
            f2 = source_dir / "b.png"
            f1.write_bytes(b"a" * 100)
            f2.write_bytes(b"b" * 250)
            with mock.patch.object(media_cache, "MEDIA_DIR", root):
                media_cache._THUMB_SOURCE_STATE.clear()
                key = str(media_cache._thumb_source_dir())
                original_known: set = set()
                media_cache._THUMB_SOURCE_STATE[key] = (0, original_known)
                media_cache._account_thumb_source(f1)
                media_cache._account_thumb_source(f2)
                total, known = media_cache._THUMB_SOURCE_STATE[key]
                self.assertIs(known, original_known)  # 제자리 갱신 — 복사본 교체 아님
                self.assertEqual(known, {str(f1), str(f2)})
                self.assertEqual(total, 350)
                media_cache._account_thumb_source(f1)  # 중복 — 총량·집합 불변
                total_after, known_after = media_cache._THUMB_SOURCE_STATE[key]
                self.assertEqual(total_after, 350)
                self.assertIs(known_after, original_known)
                # stat 실패(소실 파일)는 계상하지 않고 상태를 깨뜨리지 않는다.
                missing = source_dir / "gone.png"
                media_cache._account_thumb_source(missing)
                self.assertEqual(media_cache._THUMB_SOURCE_STATE[key][0], 350)
            media_cache._THUMB_SOURCE_STATE.clear()

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
                mock.patch.object(
                    media_cache,
                    "_PRESERVED_QUOTA_STATE",
                    media_cache._PreservedQuotaState(),
                ),
            ):
                with self.assertRaises(media_cache.MediaCacheCapacityError):
                    media_cache._enforce_preserved_quota(new, newly_created=True)
            self.assertTrue(old.exists())
            self.assertFalse(new.exists())

    def test_preserved_quota_scans_once_then_uses_incremental_total(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            state = media_cache._PreservedQuotaState()

            def fake_download(_url: str, target: Path) -> None:
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(b"media")

            async def scenario():
                first = await media_cache.cache_url_result("https://cdn.example.com/first.mp4")
                second = await media_cache.cache_url_result("https://cdn.example.com/second.mp4")
                return first, second

            real_scan = media_cache.preserved_media_usage_bytes
            with (
                mock.patch.object(media_cache, "MEDIA_DIR", root),
                mock.patch.object(media_cache, "PRESERVED_MEDIA_MAX_BYTES", 100),
                mock.patch.object(media_cache, "_PRESERVED_QUOTA_STATE", state),
                mock.patch.object(media_cache, "_download", side_effect=fake_download),
                mock.patch.object(
                    media_cache,
                    "preserved_media_usage_bytes",
                    wraps=real_scan,
                ) as scan,
            ):
                first, second = asyncio.run(scenario())

            self.assertEqual((first.status, second.status), ("cached", "cached"))
            self.assertEqual(scan.call_count, 1)
            self.assertTrue(state.initialized)
            self.assertEqual(state.total_bytes, 10)

    def test_preserved_quota_near_limit_rescans_and_absorbs_external_delete(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            old = root / "aa" / "old.mp4"
            old.parent.mkdir(parents=True)
            old.write_bytes(b"o" * 90)
            state = media_cache._PreservedQuotaState()

            with (
                mock.patch.object(media_cache, "MEDIA_DIR", root),
                mock.patch.object(media_cache, "PRESERVED_MEDIA_MAX_BYTES", 100),
                mock.patch.object(media_cache, "_PRESERVED_QUOTA_STATE", state),
            ):
                self.assertEqual(media_cache.recalculate_preserved_media_usage(), 90)
                old.unlink()  # 프로세스 밖 수동 삭제를 흉내 낸다.
                new = root / "bb" / "new.mp4"
                new.parent.mkdir(parents=True)
                new.write_bytes(b"n" * 10)
                real_scan = media_cache.preserved_media_usage_bytes
                with mock.patch.object(
                    media_cache,
                    "preserved_media_usage_bytes",
                    wraps=real_scan,
                ) as scan:
                    added = media_cache._enforce_preserved_quota(new, newly_created=True)

            self.assertEqual(added, 10)
            self.assertEqual(scan.call_count, 1)
            self.assertTrue(new.exists())
            self.assertEqual(state.total_bytes, 10)

    def test_preserved_quota_keeps_counter_when_rollback_delete_fails(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            old = root / "aa" / "old.mp4"
            old.parent.mkdir(parents=True)
            old.write_bytes(b"o" * 8)
            state = media_cache._PreservedQuotaState()

            with (
                mock.patch.object(media_cache, "MEDIA_DIR", root),
                mock.patch.object(media_cache, "PRESERVED_MEDIA_MAX_BYTES", 10),
                mock.patch.object(media_cache, "_PRESERVED_QUOTA_STATE", state),
            ):
                media_cache.recalculate_preserved_media_usage()
                new = root / "bb" / "new.mp4"
                new.parent.mkdir(parents=True)
                new.write_bytes(b"n" * 4)
                original_unlink = Path.unlink

                def fail_new_unlink(path: Path, *args, **kwargs):
                    if path == new:
                        raise OSError("locked")
                    return original_unlink(path, *args, **kwargs)

                with mock.patch.object(Path, "unlink", new=fail_new_unlink):
                    with self.assertRaises(media_cache.MediaCacheCapacityError):
                        media_cache._enforce_preserved_quota(new, newly_created=True)

            self.assertTrue(new.exists())
            self.assertEqual(state.total_bytes, 12)

    def test_concurrent_preserved_finalizes_do_not_exceed_quota(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            state = media_cache._PreservedQuotaState(total_bytes=0, initialized=True)
            finalized = threading.Barrier(2)

            def fake_download(_url: str, target: Path) -> None:
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(b"m" * 6)
                finalized.wait(timeout=2)

            async def scenario():
                return await asyncio.gather(
                    media_cache.cache_url_result("https://cdn.example.com/a.mp4"),
                    media_cache.cache_url_result("https://cdn.example.com/b.mp4"),
                )

            with (
                mock.patch.object(media_cache, "MEDIA_DIR", root),
                mock.patch.object(media_cache, "PRESERVED_MEDIA_MAX_BYTES", 10),
                mock.patch.object(media_cache, "_PRESERVED_QUOTA_STATE", state),
                mock.patch.object(media_cache, "_download", side_effect=fake_download),
            ):
                results = asyncio.run(scenario())

            self.assertEqual(sorted(result.status for result in results), ["cached", "capacity"])
            files = list(root.rglob("*.mp4"))
            self.assertEqual(sum(path.stat().st_size for path in files), 6)
            self.assertEqual(state.total_bytes, 6)

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


class DownloadSslContextTest(unittest.TestCase):
    """Python 3.13+ 기본 VERIFY_X509_STRICT 가 TLS 검사장비 사설 CA 를 거부해 운영 서버의
    미디어 캐시 다운로드가 전멸했던 회귀 — 검증은 유지하고 strict 만 해제하는 계약을 고정한다."""

    def test_keeps_verification_but_clears_strict_flag(self):
        import ssl

        from app.services.net_guard import download_ssl_context

        ctx = download_ssl_context()
        self.assertEqual(ctx.verify_mode, ssl.CERT_REQUIRED)
        self.assertTrue(ctx.check_hostname)
        strict = getattr(ssl, "VERIFY_X509_STRICT", None)
        if strict is not None:
            self.assertFalse(ctx.verify_flags & strict)


if __name__ == "__main__":
    unittest.main()

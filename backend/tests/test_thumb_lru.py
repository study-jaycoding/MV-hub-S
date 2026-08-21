"""썸네일 캐시 LRU — 서빙 touch(mark_thumb_used)와 evict 가 '안 본 지 오래된 것부터' 지우는 불변식."""

import asyncio
import os
import tempfile
import time
import unittest
from pathlib import Path
from unittest import mock

from app.services import thumbs


def _make_jpg(d: Path, name: str, size: int, age_seconds: float) -> Path:
    p = d / name
    p.write_bytes(b"x" * size)
    old = time.time() - age_seconds
    os.utime(p, (old, old))
    return p


class ThumbLruTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name)
        self._patch = mock.patch.object(thumbs, "THUMB_DIR", self.dir)
        self._patch.start()

    def tearDown(self):
        self._patch.stop()
        self.tmp.cleanup()

    def test_mark_thumb_used_touches_only_stale(self):
        stale = _make_jpg(self.dir, "stale.jpg", 10, 2 * 86400)  # 이틀 전 → touch 대상
        fresh = _make_jpg(self.dir, "fresh.jpg", 10, 60)  # 방금 → touch 안 함(쓰기 증폭 방지)
        fresh_mtime = fresh.stat().st_mtime
        thumbs.mark_thumb_used(stale)
        thumbs.mark_thumb_used(fresh)
        self.assertLess(time.time() - stale.stat().st_mtime, 60)  # 지금으로 갱신됨
        self.assertEqual(fresh.stat().st_mtime, fresh_mtime)  # 그대로
        thumbs.mark_thumb_used(None)  # None·없는 파일은 무해
        thumbs.mark_thumb_used(self.dir / "ghost.jpg")

    def test_evict_removes_least_recently_used_first(self):
        # 총 3KB, 상한 2.5KB → 1KB 하나만 지우면 충분. '안 본 지 가장 오래된' a 가 지워져야 한다.
        a = _make_jpg(self.dir, "a.jpg", 1024, 3 * 86400)
        b = _make_jpg(self.dir, "b.jpg", 1024, 2 * 86400)
        c = _make_jpg(self.dir, "c.jpg", 1024, 0)
        # a 는 오래 전에 만들어졌지만 '방금 서빙됨' → touch 후에는 b 가 최약체가 된다.
        thumbs.mark_thumb_used(a)
        removed = thumbs.evict_thumb_cache(max_bytes=2560)
        self.assertEqual(removed, 1)
        self.assertTrue(a.exists())  # 방금 본 것은 생존(LRU 의 핵심)
        self.assertFalse(b.exists())  # 안 본 지 가장 오래된 것이 삭제
        self.assertTrue(c.exists())

    def test_evict_noop_under_limit(self):
        _make_jpg(self.dir, "a.jpg", 100, 86400)
        self.assertEqual(thumbs.evict_thumb_cache(max_bytes=1024), 0)

    def test_ensure_thumb_maps_stat_race_to_missing(self):
        class VanishingImage:
            suffix = ".jpg"

            @staticmethod
            def is_file() -> bool:
                return True

            @staticmethod
            def stat():
                raise FileNotFoundError("replaced after is_file")

        self.assertIsNone(thumbs.ensure_thumb(VanishingImage(), 256))

    def test_evict_scan_guard_skips_repeat_but_force_rechecks(self):
        _make_jpg(self.dir, "a.jpg", 1024, 3 * 86400)
        _make_jpg(self.dir, "b.jpg", 1024, 2 * 86400)
        _make_jpg(self.dir, "c.jpg", 1024, 86400)
        self.assertEqual(thumbs.evict_thumb_cache(max_bytes=2560), 1)

        added = _make_jpg(self.dir, "new.jpg", 2048, 0)
        self.assertEqual(thumbs.evict_thumb_cache(max_bytes=2560), 0)
        self.assertTrue(added.exists())  # 같은 주기 안에는 평면 폴더를 다시 스캔하지 않는다.
        self.assertGreater(thumbs.evict_thumb_cache(max_bytes=2560, force=True), 0)
        self.assertLessEqual(
            sum(path.stat().st_size for path in self.dir.glob("*.jpg")), 2560
        )

    def test_remote_prewarm_concurrency_is_global_across_calls(self):
        """동시 목록 요청마다 제한이 복제되지 않고 프로세스 전체 상한을 공유한다."""
        from app.services import media_cache

        active = 0
        peak = 0

        async def fake_cache(_url: str):
            nonlocal active, peak
            active += 1
            peak = max(peak, active)
            await asyncio.sleep(0.01)
            active -= 1
            return None

        async def scenario():
            with (
                mock.patch.object(thumbs, "_REMOTE_PREWARM_SEM", asyncio.Semaphore(2)),
                mock.patch.object(media_cache, "cache_thumb_source", side_effect=fake_cache),
            ):
                await asyncio.gather(
                    thumbs.prewarm_remote_thumbs([f"https://cdn.example/a{i}.jpg" for i in range(4)]),
                    thumbs.prewarm_remote_thumbs([f"https://cdn.example/b{i}.jpg" for i in range(4)]),
                )

        asyncio.run(scenario())
        self.assertEqual(peak, 2)


class WarmMemoTests(unittest.TestCase):
    """R2 2-D warm-메모 계약 — 재검사 생략·실패 미기록·targeted 무효화·TTL·LRU 상한."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name)
        thumbs._warm_memo.clear()
        thumbs._warm_inflight.clear()
        self.source_calls: list[str] = []
        self.ensure_calls: list[tuple[str, int]] = []

    def tearDown(self):
        thumbs._warm_memo.clear()
        thumbs._warm_inflight.clear()
        self.tmp.cleanup()

    def _run(self, urls, *, ensure_ok=True):
        from app.services import media_cache

        async def fake_source(url: str):
            self.source_calls.append(url)
            rel = "/media/" + url.rsplit("/", 1)[-1]
            # cache_path 가 대상 파일을 stat 하므로 실제 파일을 만들어 둔다(원본 캐시 재현).
            source_file = self.dir / rel.rsplit("/", 1)[-1]
            if not source_file.exists():
                source_file.write_bytes(b"img")
            return rel

        def fake_ensure(target: Path, w: int):
            self.ensure_calls.append((target.name, w))
            return Path(str(target) + f".{w}.jpg") if ensure_ok else None

        with (
            mock.patch.object(media_cache, "cache_thumb_source", side_effect=fake_source),
            mock.patch.object(
                thumbs, "_media_target", side_effect=lambda rel: self.dir / rel.rsplit("/", 1)[-1]
            ),
            mock.patch.object(thumbs, "ensure_thumb", side_effect=fake_ensure),
            mock.patch.object(thumbs, "evict_thumb_cache", return_value=0),
        ):
            asyncio.run(thumbs.prewarm_remote_thumbs(urls))

    def test_second_prewarm_skips_source_check_and_workers(self):
        self._run(["https://cdn/u1.png"])
        self.assertEqual(len(self.source_calls), 1)
        self.assertEqual(len(self.ensure_calls), 2)  # 폭 2개(256/512)
        self._run(["https://cdn/u1.png"])  # 목록 폴링 재요청 재현
        self.assertEqual(len(self.source_calls), 1)  # 원본 확인 생략
        self.assertEqual(len(self.ensure_calls), 2)  # 워커·stat 생략

    def test_failed_ensure_is_not_recorded_and_retries(self):
        self._run(["https://cdn/u1.png"], ensure_ok=False)
        self._run(["https://cdn/u1.png"], ensure_ok=True)
        self.assertEqual(len(self.source_calls), 2)  # 실패는 warm 미기록 → 재시도
        self.assertEqual(len(self.ensure_calls), 4)
        self.assertEqual(thumbs._warm_inflight, set())  # 선점 누수 없음

    def test_targeted_eviction_invalidates_only_removed_width(self):
        self._run(["https://cdn/u1.png", "https://cdn/u2.png"])
        evicted = str(self.dir / "u1.png") + ".256.jpg"
        thumbs._warm_invalidate_paths({evicted})
        self.source_calls.clear()
        self.ensure_calls.clear()
        self._run(["https://cdn/u1.png", "https://cdn/u2.png"])
        self.assertEqual(self.source_calls, ["https://cdn/u1.png"])  # u2 는 전 폭 warm → 생략
        self.assertEqual(self.ensure_calls, [("u1.png", 256)])  # 지워진 폭만 재생성

    def test_ttl_expiry_rechecks(self):
        self._run(["https://cdn/u1.png"])
        base = thumbs.time.monotonic()
        with mock.patch.object(
            thumbs.time, "monotonic", return_value=base + thumbs._WARM_TTL_SECONDS + 1
        ):
            self._run(["https://cdn/u1.png"])
        self.assertEqual(len(self.source_calls), 2)  # TTL 만료 → 재검사

    def test_lru_cap_drops_oldest_key(self):
        with mock.patch.object(thumbs, "_WARM_MAX_KEYS", 2):
            self._run(["https://cdn/u1.png"])  # u1 의 (256,512) 중 오래된 키부터 밀림
            self._run(["https://cdn/u2.png"])
        self.assertLessEqual(len(thumbs._warm_memo), 2)
        self.source_calls.clear()
        self._run(["https://cdn/u1.png"])  # 밀려난 u1 은 재검사돼야 한다
        self.assertEqual(self.source_calls, ["https://cdn/u1.png"])


if __name__ == "__main__":
    unittest.main()

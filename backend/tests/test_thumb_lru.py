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


if __name__ == "__main__":
    unittest.main()

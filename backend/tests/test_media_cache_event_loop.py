"""미디어 보존의 DB 반영이 **서버 전체를 멈추지 않는다.**

★왜(2026-09-12 코덱스 감사): `_cache_generation_media_outcome` 은 `async def` 인데
 마지막 DB 반영을 동기로 직접 불렀다. 그 안은 `BEGIN IMMEDIATE`(`repo/generations.py`)이고
 SQLite 는 쓰기 잠금을 **동기로** 기다린다(`db.py` 의 `busy_timeout = 5000`).
 경합이 나면 그 대기 동안 **이 요청만이 아니라 이벤트 루프 위의 모든 요청이 선다.**
 코덱스 실측: 150ms 지연 주입 시 10ms 뒤 실행 예정이던 heartbeat 가 **150.58ms** 에 실행.

가짜는 두 경계에만 둔다 — 실제 다운로드(`media_cache.cache_url_result`)와
실제 DB 쓰기(`repo.apply_generation_media_cache_updates`). 그 사이 판정·취소 처리는
제품 코드 그대로 돈다.
"""

from __future__ import annotations

import asyncio
import unittest
from unittest.mock import patch

from app import repo
from app.services import media_cache
from app.services.media_cache import MediaCacheResult
from app.usecases import generation_media_cache

NEW_PATH = "/media/cached/new.png"


def _generation() -> dict:
    """보존 대상이 하나 있는 생성물 — 경로가 바뀌므로 DB 반영이 실제로 일어난다."""
    return {
        "id": "gen-1",
        "assets": [
            {
                "id": "asset-1",
                "file_path": "https://cdn.invalid/old.png",
                "type": "image",
            }
        ],
        "references": [],
    }


async def _fake_download(url):
    return MediaCacheResult(NEW_PATH, "cached", bytes_added=10)


class EventLoopStallTests(unittest.IsolatedAsyncioTestCase):
    async def _run_with_writer(self, writer):
        with (
            patch.object(media_cache, "cache_url_result", new=_fake_download),
            patch.object(generation_media_cache.media_cache, "cache_url_result", new=_fake_download),
            patch.object(repo, "apply_generation_media_cache_updates", new=writer),
        ):
            return await generation_media_cache._cache_generation_media_outcome(_generation())

    async def test_a_slow_db_write_does_not_delay_other_work(self):
        """★이 시험이 이 파일의 이유다 — 느린 쓰기 동안에도 다른 일이 제때 돌아야 한다."""
        BLOCK = 0.30
        seen: list = []

        def slow_writer(updates, **kwargs):
            import time

            seen.append(list(updates))
            time.sleep(BLOCK)  # 쓰기 잠금 대기를 흉내 낸다(동기 대기 — 루프를 잡는다면 여기서 잡힌다)

        loop = asyncio.get_running_loop()
        started = loop.time()
        heartbeat_lag: list[float] = []

        async def heartbeat():
            # 10ms 뒤에 깨어나야 한다. 루프가 막히면 BLOCK 만큼 밀린다.
            await asyncio.sleep(0.01)
            heartbeat_lag.append(loop.time() - started)

        beat = asyncio.create_task(heartbeat())
        await self._run_with_writer(slow_writer)
        await beat

        self.assertEqual(len(seen), 1)  # 쓰기가 실제로 일어났다
        self.assertTrue(heartbeat_lag, "heartbeat 가 아예 안 돌았다")
        self.assertLess(
            heartbeat_lag[0],
            BLOCK / 2,
            f"이벤트 루프가 막혔다 — heartbeat 가 {heartbeat_lag[0]:.3f}s 에 실행(기대 ≈0.01s)",
        )

    async def test_the_write_still_happens_and_carries_the_right_rows(self):
        """스레드로 옮기느라 반영 내용이 달라지면 안 된다."""
        captured: dict = {}

        def writer(updates, **kwargs):
            captured["updates"] = list(updates)
            captured["kwargs"] = kwargs

        out = await self._run_with_writer(writer)
        self.assertEqual(len(captured["updates"]), 1)
        kind, media_id, path, thumb, source = captured["updates"][0]
        self.assertEqual((kind, media_id, path), ("asset", "asset-1", NEW_PATH))
        self.assertEqual(thumb, NEW_PATH)  # 이미지라 썸네일도 같은 경로
        self.assertEqual(source, "https://cdn.invalid/old.png")
        # 기존 계약: 갱신 함수는 호출부가 주입한다(배치 문맥 유지)
        self.assertIs(captured["kwargs"]["asset_updater"], repo.update_asset_cache)
        self.assertIs(captured["kwargs"]["reference_updater"], repo.update_reference_cache)
        self.assertEqual(out.result["cached"], 1)

    async def test_nothing_to_write_does_not_touch_the_database(self):
        """반영할 게 없으면 스레드도 트랜잭션도 열지 않는다."""
        called: list = []

        async def already(url):
            return MediaCacheResult("https://cdn.invalid/old.png", "already")

        with (
            patch.object(generation_media_cache.media_cache, "cache_url_result", new=already),
            patch.object(
                repo,
                "apply_generation_media_cache_updates",
                new=lambda *a, **k: called.append(a),
            ),
        ):
            await generation_media_cache._cache_generation_media_outcome(_generation())
        self.assertEqual(called, [])

    async def test_a_writer_failure_still_surfaces(self):
        """스레드로 옮겼다고 예외가 삼켜지면 실패를 못 본다."""

        def boom(updates, **kwargs):
            raise RuntimeError("디스크 가득")

        with self.assertRaises(RuntimeError):
            await self._run_with_writer(boom)


if __name__ == "__main__":
    unittest.main()

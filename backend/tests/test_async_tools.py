"""R7(코덱스 P1) — to_thread_non_abandon: 취소 시 스레드 완료를 기다린 뒤 취소 전파."""
from __future__ import annotations

import asyncio
import threading
import unittest

from app.services.async_tools import to_thread_non_abandon


class ToThreadNonAbandonTests(unittest.TestCase):
    def test_cancellation_waits_for_thread_completion(self):
        started = threading.Event()
        finished = threading.Event()

        def slow_worker():
            started.set()
            # 스레드가 자원(임시파일 등)을 쓰는 구간 — 취소가 이걸 방치하면 안 된다
            threading.Event().wait(0.15)
            finished.set()
            return "done"

        async def scenario():
            task = asyncio.ensure_future(to_thread_non_abandon(slow_worker))
            await asyncio.to_thread(started.wait, 1.0)  # 스레드 진입 확인
            task.cancel()
            cancelled = False
            try:
                await task
            except asyncio.CancelledError:
                cancelled = True
            # ★핵심 계약: 취소가 전파된 시점에 스레드는 이미 완료돼 있다(non-abandon).
            #  순정 to_thread 는 여기서 finished 가 아직 False 였다(코덱스 재현).
            return cancelled, finished.is_set()

        cancelled, thread_done = asyncio.run(scenario())
        self.assertTrue(cancelled)
        self.assertTrue(thread_done)

    def test_repeated_cancellation_still_waits_for_thread(self):
        """코덱스 재확인 P1 — 대기 중 두 번째 취소가 와도 worker 를 방치하지 않는다."""
        started = threading.Event()
        finished = threading.Event()

        def slow_worker():
            started.set()
            threading.Event().wait(0.15)
            finished.set()

        async def scenario():
            task = asyncio.ensure_future(to_thread_non_abandon(slow_worker))
            await asyncio.to_thread(started.wait, 1.0)
            task.cancel()
            await asyncio.sleep(0.02)
            task.cancel()  # 반복 취소 — 종전엔 worker 가 취소돼 helper 가 먼저 반환했다
            await asyncio.sleep(0.02)
            task.cancel()
            cancelled = False
            try:
                await task
            except asyncio.CancelledError:
                cancelled = True
            return cancelled, finished.is_set()

        cancelled, thread_done = asyncio.run(scenario())
        self.assertTrue(cancelled)
        self.assertTrue(thread_done)

    def test_normal_path_returns_result_and_propagates_errors(self):
        async def scenario():
            result = await to_thread_non_abandon(lambda: "값")
            try:
                await to_thread_non_abandon(self._boom)
            except RuntimeError as exc:
                return result, str(exc)
            return result, None

        result, error = asyncio.run(scenario())
        self.assertEqual(result, "값")
        self.assertEqual(error, "스레드 오류")

    @staticmethod
    def _boom():
        raise RuntimeError("스레드 오류")


if __name__ == "__main__":
    unittest.main()

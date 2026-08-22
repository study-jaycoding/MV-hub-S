"""R7 2-E — 완료본 저장 프로젝트별 lock 레지스트리 계약(코덱스 확정).

같은 프로젝트만 직렬화(다른 프로젝트 병렬), 대기 취소=refcount 만 감소(release 금지),
마지막 사용자 종료 시 레지스트리에서 즉시 제거.
"""
from __future__ import annotations

import asyncio
import unittest

from app.routers import manage


class SaveFinalsLockTests(unittest.TestCase):
    def _run(self, coro):
        return asyncio.run(coro)

    def test_same_project_serializes_and_registry_is_reclaimed(self):
        order: list[str] = []

        async def scenario():
            async def worker(tag: str):
                async with manage._save_finals_lock("p1"):
                    order.append(f"{tag}-in")
                    await asyncio.sleep(0.01)
                    order.append(f"{tag}-out")

            await asyncio.gather(worker("a"), worker("b"))
            return dict(manage._SAVE_FINALS_LOCKS)

        registry = self._run(scenario())
        self.assertEqual(registry, {})  # 마지막 사용자 종료 → 즉시 회수
        # 직렬화 — in/out 이 교차하지 않는다
        self.assertIn(order[0].split("-")[0], ("a", "b"))
        self.assertEqual(order[0].split("-")[0], order[1].split("-")[0])
        self.assertEqual(order[2].split("-")[0], order[3].split("-")[0])

    def test_different_projects_run_in_parallel(self):
        async def scenario():
            entered = asyncio.Event()
            release = asyncio.Event()

            async def holder():
                async with manage._save_finals_lock("p1"):
                    entered.set()
                    await release.wait()

            async def other():
                await entered.wait()
                async with manage._save_finals_lock("p2"):
                    return True  # p1 보유 중에도 p2 는 즉시 진입

            holder_task = asyncio.create_task(holder())
            ok = await asyncio.wait_for(other(), timeout=1.0)
            release.set()
            await holder_task
            return ok

        self.assertTrue(self._run(scenario()))

    def test_waiting_cancellation_decrements_refcount_without_release(self):
        async def scenario():
            release = asyncio.Event()

            async def holder():
                async with manage._save_finals_lock("p1"):
                    await release.wait()
                    return "held"

            holder_task = asyncio.create_task(holder())
            await asyncio.sleep(0.01)  # holder 가 lock 보유

            async def waiter():
                async with manage._save_finals_lock("p1"):
                    return "acquired"

            waiter_task = asyncio.create_task(waiter())
            await asyncio.sleep(0.01)  # waiter 가 대기열 진입(refcount=2)
            waiter_task.cancel()
            await asyncio.gather(waiter_task, return_exceptions=True)
            # 대기 취소 후에도 holder 는 lock 을 정상 보유(오염 없음)
            still_registered = "p1" in manage._SAVE_FINALS_LOCKS
            release.set()
            result = await holder_task
            return still_registered, result, dict(manage._SAVE_FINALS_LOCKS)

        still_registered, result, registry = self._run(scenario())
        self.assertTrue(still_registered)  # holder 몫 refcount 유지
        self.assertEqual(result, "held")
        self.assertEqual(registry, {})  # 전원 종료 후 회수


if __name__ == "__main__":
    unittest.main()

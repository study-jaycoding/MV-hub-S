"""동기 라우트 스레드에서 메인 asyncio 루프로 전달되는 에이전트 신호 회귀."""

import asyncio
import unittest

from app.services.agent_signals import AgentSignals


class AgentSignalsThreadSafetyTests(unittest.IsolatedAsyncioTestCase):
    async def test_worker_thread_signal_and_touch_run_on_bound_loop(self):
        signals = AgentSignals()
        loop = asyncio.get_running_loop()
        signals.bind_loop(loop)

        await asyncio.to_thread(signals.touch, "Artist@Example.com")
        await asyncio.sleep(0)
        self.assertTrue(signals.connected("artist@example.com"))

        await asyncio.to_thread(signals.signal, "Artist@Example.com", "sync")
        self.assertEqual(
            await signals.wait("artist@example.com", timeout=0.2),
            "sync",
        )
        signals.unbind_loop(loop)


if __name__ == "__main__":
    unittest.main()

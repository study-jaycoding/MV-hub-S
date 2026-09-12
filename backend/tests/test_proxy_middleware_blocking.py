"""위임 여부 판정이 **서버 전체를 멈추지 않는다.**

★왜(2026-09-12 코덱스 지적): `data_proxy_middleware` 는 `async def` 인데 그 안의
 `proxying()` 이 설정을 DB 에서 읽고, 그 경로가 유지보수 게이트에 닿는다
 (`db.py` 의 `_enter_connection_context` → `_pool_condition.wait()`).
 그 대기는 **시한이 없는 동기 대기**다 — DB 복원·이관 중이면 이 요청만이 아니라
 **이벤트 루프 위의 모든 요청이 선다.**

★정상 조회는 실측 **0.189ms** 로 싸다. 스레드로 옮긴 것은 그 비용 때문이 아니라
 **막히는 동안 서버가 응답을 이어 가게** 하기 위해서다.

★서버 본체(AUTH on)는 `proxying()` 이 DB 를 보기 전에 짧게 끝나므로, 이 스레드 왕복은
 사실상 로컬 허브에서만 일어난다.

가짜는 판정 함수 하나에만 둔다 — 미들웨어의 분기·정리는 제품 코드 그대로 돈다.
"""

from __future__ import annotations

import asyncio
import unittest
from types import SimpleNamespace
from unittest.mock import patch

from app.mutation_notify import CLIENT_ID_HEADER, MUTATION_ID_HEADER
from app.routers import _proxy


def _request(path: str = "/api/generations", method: str = "GET", *, origin=True):
    # ★헤더를 실제로 넣는다. 비우면 설정되는 mutation origin 이 원래 None 이라
    #  '문맥 복원을 지웠다' 는 변이를 시험이 못 잡는다(되돌려 확인에서 걸렸다).
    headers = {CLIENT_ID_HEADER: "client-aaaaaaaa", MUTATION_ID_HEADER: "mutation-bbbbbbbb"} if origin else {}
    return SimpleNamespace(
        url=SimpleNamespace(path=path),
        method=method,
        headers=headers,
        query_params={},
    )


class ProxyDecisionDoesNotStallTests(unittest.IsolatedAsyncioTestCase):
    async def _run(self, *, proxying_seconds: float, decision: bool = False):
        import time as _time

        def slow_decision():
            _time.sleep(proxying_seconds)  # 유지보수 게이트의 동기 대기를 흉내 낸다
            return decision

        called = {"next": 0}

        async def call_next(_request):
            called["next"] += 1
            return "local-response"

        with patch.object(_proxy, "proxying", side_effect=slow_decision):
            result = await _proxy.data_proxy_middleware(_request(), call_next)
        return result, called

    async def test_a_stalled_decision_does_not_delay_other_work(self):
        """★이 시험이 이 파일의 이유다 — 판정이 막혀도 다른 요청은 제때 돌아야 한다."""
        BLOCK = 0.30
        loop = asyncio.get_running_loop()
        started = loop.time()
        lag: list[float] = []

        async def heartbeat():
            await asyncio.sleep(0.01)  # 10ms 뒤 깨어나야 한다
            lag.append(loop.time() - started)

        beat = asyncio.create_task(heartbeat())
        result, called = await self._run(proxying_seconds=BLOCK)
        await beat

        self.assertEqual(result, "local-response")
        self.assertEqual(called["next"], 1)
        self.assertTrue(lag, "heartbeat 가 아예 안 돌았다")
        self.assertLess(
            lag[0], BLOCK / 2,
            f"이벤트 루프가 막혔다 — heartbeat 가 {lag[0]:.3f}s 에 실행(기대 ≈0.01s)",
        )

    async def test_the_local_path_still_goes_to_the_next_handler(self):
        """스레드로 옮기느라 분기가 바뀌면 안 된다 — 위임 아님이면 로컬 처리."""
        result, called = await self._run(proxying_seconds=0.0, decision=False)
        self.assertEqual(result, "local-response")
        self.assertEqual(called["next"], 1)

    async def test_a_delegating_hub_forwards_instead(self):
        """위임 모드면 로컬로 내려보내지 않고 중계한다(기존 계약)."""
        called = {"next": 0, "forward": 0}

        async def call_next(_request):
            called["next"] += 1
            return "local-response"

        async def fake_forward(_request):
            called["forward"] += 1
            return "forwarded"

        with (
            patch.object(_proxy, "proxying", return_value=True),
            patch.object(_proxy, "_needs_shared_media_fallback", return_value=False),
            patch.object(_proxy, "is_local_path", return_value=False),
            patch.object(_proxy, "_forward", side_effect=fake_forward),
        ):
            result = await _proxy.data_proxy_middleware(_request(), call_next)
        self.assertEqual(result, "forwarded")
        self.assertEqual((called["next"], called["forward"]), (0, 1))

    async def test_the_mutation_origin_context_is_always_reset(self):
        """★판정이 예외를 내도 요청 문맥은 되돌려야 한다 — 남으면 **다음 요청이 남의
        mutation origin 을 물고 간다**(알림이 엉뚱한 클라이언트로 병합된다)."""
        async def call_next(_request):
            # 미들웨어 안에서는 실제로 설정돼 있어야 의미 있는 시험이다
            self.assertEqual(_proxy._REQUEST_MUTATION_ORIGIN.get(), ("client-aaaaaaaa", "mutation-bbbbbbbb"))
            return "local-response"

        before = _proxy._REQUEST_MUTATION_ORIGIN.get()
        with patch.object(_proxy, "proxying", return_value=False):
            await _proxy.data_proxy_middleware(_request(), call_next)
        self.assertEqual(_proxy._REQUEST_MUTATION_ORIGIN.get(), before)

        with patch.object(_proxy, "proxying", side_effect=RuntimeError("게이트 실패")):
            with self.assertRaises(RuntimeError):
                await _proxy.data_proxy_middleware(_request(), call_next)
        self.assertEqual(_proxy._REQUEST_MUTATION_ORIGIN.get(), before)


if __name__ == "__main__":
    unittest.main()

"""실시간(WS) 스코프 불변식 — 계정 스코프 broadcast 는 격리, broadcast_all 만 전체.

이번 세션에서 잡은 누출(계정 uid 가 None 이면 전체로 새던 것)과 회귀(syncer 전체 reload 가 끊기던 것)를
불변식으로 고정한다. realtime_scope 는 email 기반이라 creator_uid 리맵·NULL 에도 안정적이어야 한다.

전송 모델(배치 6): 연결별 단일 sender + 크기 제한 큐. broadcast 는 큐 적재 후 즉시 반환하고
전송 timeout 은 순수 send 에만 적용된다 — 겹친 broadcast 의 락 대기가 예산을 갉아먹어
정상 클라이언트가 억울하게 수거되던 문제의 회귀 테스트를 포함한다.
"""
import asyncio
import unittest
from unittest import mock

from app import deps as deps_mod
from app.ws import ConnectionManager


class FakeWS:
    def __init__(self):
        self.received: list[dict] = []
        self.accepted = False
        self.closed: tuple[int, str] | None = None

    async def accept(self):
        self.accepted = True

    async def send_json(self, message):
        self.received.append(message)

    async def close(self, code=1000, reason=""):
        self.closed = (code, reason)


class SlowWS(FakeWS):
    async def send_json(self, message):
        await asyncio.Event().wait()


class FailingWS(FakeWS):
    async def send_json(self, message):
        raise ConnectionError("client disconnected")


class SlowishWS(FakeWS):
    """전송마다 일정 시간이 걸리지만 timeout 안에는 항상 성공하는 '건강한 느린' 클라이언트."""

    def __init__(self, delay: float):
        super().__init__()
        self.delay = delay

    async def send_json(self, message):
        await asyncio.sleep(self.delay)
        self.received.append(message)


class GateWS(FakeWS):
    """첫 전송만 게이트에 막히는 클라이언트 — 그 사이 큐에 쌓인 병합 결과를 관찰한다."""

    def __init__(self):
        super().__init__()
        self.gate = asyncio.Event()
        self.blocked_once = False

    async def send_json(self, message):
        if not self.blocked_once:
            self.blocked_once = True
            await self.gate.wait()
        self.received.append(message)


class OverlapGuardWS(FakeWS):
    """전송이 게이트에 막혀 있는 동안 close 가 겹치면 실제 ASGI 처럼 거부하는 fake —
    수거가 sender 의 실제 종료를 기다리지 않고 close 하면 close 가 유실된다(코덱스 P0)."""

    def __init__(self):
        super().__init__()
        self.gate = asyncio.Event()
        self.sending = False
        self.close_during_send = False

    async def send_json(self, message):
        self.sending = True
        try:
            await self.gate.wait()
        finally:
            self.sending = False
        self.received.append(message)

    async def close(self, code=1000, reason=""):
        if self.sending:
            self.close_during_send = True
            raise RuntimeError("concurrent close during send")
        self.closed = (code, reason)


class SlowCloseWS(SlowWS):
    """전송은 영원히 막히고 close 도 느린 fake — 대량 수거가 broadcast 를 붙잡는지 검증."""

    async def close(self, code=1000, reason=""):
        await asyncio.sleep(0.05)
        self.closed = (code, reason)


async def drain(mgr: ConnectionManager, timeout: float = 2.0) -> None:
    """모든 연결의 큐가 비고 전송 중 메시지가 없을 때까지 기다린다.
    ★수거(close 완료)까지 보장하지 않는다 — closed 를 단언하려면 wait_until 로 기다릴 것."""
    loop = asyncio.get_event_loop()
    deadline = loop.time() + timeout
    while (await mgr.stats())["queued_messages"] > 0:
        if loop.time() > deadline:
            raise TimeoutError("WS 큐가 비워지지 않음")
        await asyncio.sleep(0.001)


async def wait_until(predicate, timeout: float = 2.0) -> None:
    loop = asyncio.get_event_loop()
    deadline = loop.time() + timeout
    while not predicate():
        if loop.time() > deadline:
            raise TimeoutError("조건이 제한시간 안에 참이 되지 않음")
        await asyncio.sleep(0.001)


class RealtimeScopeTests(unittest.TestCase):
    def test_realtime_scope_email_based_stable_across_uid(self):
        with mock.patch.object(deps_mod, "AUTH_ENABLED", True):
            # creator_uid 가 있든 NULL 이든 email 기반 acct:email — 리맵(acct:→user_)에도 스코프 불변.
            self.assertEqual(
                deps_mod.realtime_scope({"email": "A@X.com", "creator_uid": "user_A"}),
                "acct:a@x.com",
            )
            self.assertEqual(
                deps_mod.realtime_scope({"email": "A@X.com", "creator_uid": None}),
                "acct:a@x.com",
            )
            self.assertEqual(
                deps_mod.realtime_scope({"email": "c@x.com", "creator_uid": "acct:c"}),
                deps_mod.realtime_scope({"email": "c@x.com", "creator_uid": "user_C"}),
            )

    def test_realtime_scope_none_when_auth_off_or_no_account(self):
        with mock.patch.object(deps_mod, "AUTH_ENABLED", False):
            self.assertIsNone(deps_mod.realtime_scope({"email": "a@x.com", "creator_uid": "user_A"}))
        with mock.patch.object(deps_mod, "AUTH_ENABLED", True):
            self.assertIsNone(deps_mod.realtime_scope(None))


class WsBroadcastScopeTests(unittest.TestCase):
    def _run(self, coro):
        loop = asyncio.new_event_loop()
        try:
            return loop.run_until_complete(coro)
        finally:
            # 시나리오가 남긴 sender 태스크를 정리해 경고 없이 루프를 닫는다.
            pending = asyncio.all_tasks(loop)
            for task in pending:
                task.cancel()
            if pending:
                loop.run_until_complete(asyncio.gather(*pending, return_exceptions=True))
            loop.close()

    def test_scoped_broadcast_isolates_and_broadcast_all_reaches_everyone(self):
        async def scenario():
            mgr = ConnectionManager()
            a, b, none_sock = FakeWS(), FakeWS(), FakeWS()
            await mgr.connect(a, "acct:a")
            await mgr.connect(b, "acct:b")
            await mgr.connect(none_sock, None)

            # 계정 스코프 → 정확히 그 소켓만(진행률·result_url 누출 방지)
            await mgr.broadcast({"type": "progress", "url": "secretA"}, account_uid="acct:a")
            # account_uid=None 은 '전체'가 아니라 'None 스코프 소켓'만(AUTH off 소켓)
            await mgr.broadcast({"type": "progress", "url": "x"}, account_uid=None)
            # 전체 reload 신호는 broadcast_all 로만(syncer)
            await mgr.broadcast_all({"type": "synced"})
            await drain(mgr)

            return a.received, b.received, none_sock.received

        a_msgs, b_msgs, none_msgs = self._run(scenario())
        # A: 자기 progress + broadcast_all
        self.assertEqual([m["type"] for m in a_msgs], ["progress", "synced"])
        self.assertEqual(a_msgs[0]["url"], "secretA")
        # B: broadcast_all 만 (A 의 progress 누출 없음)
        self.assertEqual([m["type"] for m in b_msgs], ["synced"])
        # None 소켓: account_uid=None broadcast + broadcast_all
        self.assertEqual([m["type"] for m in none_msgs], ["progress", "synced"])

    def test_stats_count_unique_accounts_under_100_connections(self):
        async def scenario():
            mgr = ConnectionManager()
            for index in range(100):
                await mgr.connect(FakeWS(), f"acct:{index // 2}")
            await mgr.connect(FakeWS(), None)
            return await mgr.stats()

        stats = self._run(scenario())
        self.assertEqual(stats["connections"], 101)
        self.assertEqual(stats["authenticated_connections"], 100)
        self.assertEqual(stats["authenticated_accounts"], 50)
        self.assertEqual(stats["local_connections"], 1)
        self.assertEqual(stats["queued_messages"], 0)
        self.assertEqual(stats["send_timeouts"], 0)
        self.assertEqual(stats["send_failures"], 0)
        self.assertEqual(stats["send_overflows"], 0)

    def test_slow_client_does_not_block_fast_client_and_is_collected(self):
        async def scenario():
            mgr = ConnectionManager()
            slow, fast = SlowWS(), FakeWS()
            await mgr.connect(slow, "acct:a")
            await mgr.connect(fast, "acct:a")
            with mock.patch("app.ws._WS_SEND_TIMEOUT_SECONDS", 0.05):
                await mgr.broadcast({"type": "progress"}, account_uid="acct:a")
                # fast 는 slow 의 timeout(0.05s)을 기다리지 않고 즉시 받아야 한다.
                loop = asyncio.get_event_loop()
                deadline = loop.time() + 0.04
                while not fast.received and loop.time() < deadline:
                    await asyncio.sleep(0.001)
                delivered_before_slow_timeout = list(fast.received)
                await drain(mgr)  # slow 가 timeout 으로 수거될 때까지
                await wait_until(lambda: slow.closed is not None)
            return delivered_before_slow_timeout, slow.closed, await mgr.stats()

        fast_messages, slow_closed, stats = self._run(scenario())
        self.assertEqual(fast_messages, [{"type": "progress"}])
        self.assertEqual(slow_closed, (1011, "realtime send timeout"))
        self.assertEqual(stats["connections"], 1)
        self.assertEqual(stats["send_timeouts"], 1)
        self.assertEqual(stats["send_failures"], 0)

    def test_failed_client_does_not_hide_message_from_other_clients(self):
        async def scenario():
            mgr = ConnectionManager()
            failed, fast = FailingWS(), FakeWS()
            await mgr.connect(failed, None)
            await mgr.connect(fast, None)
            await mgr.broadcast_all({"type": "synced"})
            await drain(mgr)
            await wait_until(lambda: failed.closed is not None)
            return fast.received, failed.closed, await mgr.stats()

        fast_messages, failed_closed, stats = self._run(scenario())
        self.assertEqual(fast_messages, [{"type": "synced"}])
        self.assertEqual(failed_closed, (1011, "realtime send failed"))
        self.assertEqual(stats["connections"], 1)
        self.assertEqual(stats["send_timeouts"], 0)
        self.assertEqual(stats["send_failures"], 1)

    def test_overlapping_broadcasts_count_one_slow_client_only_once(self):
        async def scenario():
            mgr = ConnectionManager()
            slow = SlowWS()
            await mgr.connect(slow, None)
            with mock.patch("app.ws._WS_SEND_TIMEOUT_SECONDS", 0.02):
                await asyncio.gather(
                    mgr.broadcast_all({"type": "first"}),
                    mgr.broadcast_all({"type": "second"}),
                )
                await drain(mgr)
            return await mgr.stats()

        stats = self._run(scenario())
        self.assertEqual(stats["connections"], 0)
        self.assertEqual(stats["send_timeouts"], 1)
        self.assertEqual(stats["send_failures"], 0)

    def test_healthy_client_survives_overlapping_broadcasts(self):
        """★배치 6 핵심 회귀 — 예전엔 timeout 예산에 락 대기가 포함돼, 전송에 0.03s 걸리는
        건강한 클라이언트가 겹친 broadcast(0.03 대기 + 0.03 전송 > 0.05 예산)에서 수거됐다.
        단일 sender 큐에선 각 전송이 자기 시간만 계산되므로 살아남고, FIFO 순서도 보장된다."""

        async def scenario():
            mgr = ConnectionManager()
            client = SlowishWS(0.03)
            await mgr.connect(client, None)
            with mock.patch("app.ws._WS_SEND_TIMEOUT_SECONDS", 0.05):
                await asyncio.gather(
                    mgr.broadcast_all({"type": "progress", "n": 1}),
                    mgr.broadcast_all({"type": "progress", "n": 2}),
                )
                await drain(mgr)
            return client.received, client.closed, await mgr.stats()

        received, closed, stats = self._run(scenario())
        self.assertEqual([m["n"] for m in received], [1, 2])
        self.assertIsNone(closed)
        self.assertEqual(stats["connections"], 1)
        self.assertEqual(stats["send_timeouts"], 0)

    def test_queue_overflow_collects_only_that_connection(self):
        async def scenario():
            mgr = ConnectionManager()
            stuck, fast = SlowWS(), FakeWS()
            await mgr.connect(stuck, None)
            await mgr.connect(fast, None)
            with mock.patch("app.ws._WS_QUEUE_MAX", 4):
                # progress 는 병합되지 않으므로 상한을 넘기면 그 연결만 수거된다.
                for n in range(6):
                    await mgr.broadcast_all({"type": "progress", "n": n})
                await drain(mgr)
                await wait_until(lambda: stuck.closed is not None)
            return fast.received, stuck.closed, await mgr.stats()

        fast_messages, stuck_closed, stats = self._run(scenario())
        self.assertEqual([m["n"] for m in fast_messages], [0, 1, 2, 3, 4, 5])
        self.assertEqual(stuck_closed, (1011, "realtime queue overflow"))
        self.assertEqual(stats["connections"], 1)
        self.assertEqual(stats["send_overflows"], 1)

    def test_overflow_collect_waits_for_inflight_send_before_close(self):
        """★코덱스 P0 회귀 — 외부 수거(overflow)가 전송 중인 sender 를 기다리지 않고 같은
        소켓에 close 를 겹쳐 부르면 ASGI 가 거부해 close 가 유실된다(브라우저는 열린 줄 알고
        재연결을 안 함). 수거는 sender 의 실제 종료를 기다린 뒤 close 해야 한다."""

        async def scenario():
            mgr = ConnectionManager()
            ws = OverlapGuardWS()
            await mgr.connect(ws, None)
            with mock.patch("app.ws._WS_QUEUE_MAX", 1):
                await mgr.broadcast_all({"type": "progress", "n": 0})
                await wait_until(lambda: ws.sending)  # sender 가 첫 전송을 물고 막힘
                await mgr.broadcast_all({"type": "progress", "n": 1})  # 큐(상한 1) 채움
                await mgr.broadcast_all({"type": "progress", "n": 2})  # overflow → 수거
                await wait_until(lambda: ws.closed is not None)
            return ws.close_during_send, ws.closed, await mgr.stats()

        close_during_send, closed, stats = self._run(scenario())
        self.assertFalse(close_during_send)
        self.assertEqual(closed, (1011, "realtime queue overflow"))
        self.assertEqual(stats["connections"], 0)
        self.assertEqual(stats["send_overflows"], 1)

    def test_mass_overflow_does_not_block_broadcast(self):
        """여러 연결이 동시에 넘쳐도 broadcast 는 'enqueue 후 즉시 반환' — 수거(sender 대기
        + close)는 백그라운드로 넘어가 호출처(gen_requests·syncer)를 붙잡지 않는다."""

        async def scenario():
            mgr = ConnectionManager()
            stuck = [SlowCloseWS() for _ in range(3)]
            for sock in stuck:
                await mgr.connect(sock, None)
            with mock.patch("app.ws._WS_QUEUE_MAX", 1):
                for n in range(3):
                    await mgr.broadcast_all({"type": "progress", "n": n})
                # 마지막 broadcast 반환 시점엔 어느 close(0.05s)도 끝나 있으면 안 된다
                # (= 수거를 기다리지 않고 반환했다는 증거).
                closed_at_return = [sock.closed for sock in stuck]
                await wait_until(lambda: all(sock.closed is not None for sock in stuck))
            return closed_at_return, await mgr.stats()

        closed_at_return, stats = self._run(scenario())
        self.assertEqual(closed_at_return, [None, None, None])
        self.assertEqual(stats["connections"], 0)
        self.assertEqual(stats["send_overflows"], 3)

    def test_reload_signals_merge_in_queue(self):
        """전송이 막힌 동안 쌓인 reload 신호는 타입별로 병합된다 — origins 는 합집합,
        projects 는 합집합, 한쪽에만 있는 필드는 생략(=프론트가 안전한 전체 갱신으로 읽음)."""

        async def scenario():
            mgr = ConnectionManager()
            ws = GateWS()
            await mgr.connect(ws, None)
            await mgr.broadcast_all({"type": "progress", "n": 0})  # 게이트에 걸릴 첫 전송
            loop = asyncio.get_event_loop()
            deadline = loop.time() + 1.0
            while not ws.blocked_once and loop.time() < deadline:
                await asyncio.sleep(0.001)
            origin_1 = {"client_id": "c", "mutation_id": "m1"}
            origin_2 = {"client_id": "c", "mutation_id": "m2"}
            origin_3 = {"client_id": "c", "mutation_id": "m3"}
            await mgr.broadcast_all({"type": "synced", "origins": [origin_1]})
            await mgr.broadcast_all({"type": "synced", "origins": [origin_2]})
            await mgr.broadcast_all({"type": "assets_changed", "projects": ["A"]})
            await mgr.broadcast_all({"type": "assets_changed", "projects": ["B"]})
            await mgr.broadcast_all({"type": "assets_changed", "origins": [origin_3]})
            ws.gate.set()
            await drain(mgr)
            return ws.received, await mgr.stats()

        received, stats = self._run(scenario())
        self.assertEqual(
            received,
            [
                {"type": "progress", "n": 0},
                {
                    "type": "synced",
                    "origins": [
                        {"client_id": "c", "mutation_id": "m1"},
                        {"client_id": "c", "mutation_id": "m2"},
                    ],
                },
                # projects 병합([A,B]) 뒤 origins 만 있는 신호와 다시 병합 —
                # 서로 다른 필드는 생략되어 '전체 갱신·생략 불가'라는 안전한 상위집합이 된다.
                {"type": "assets_changed"},
            ],
        )
        self.assertEqual(stats["connections"], 1)
        self.assertEqual(stats["send_overflows"], 0)

    def test_merged_origins_beyond_cap_fall_back_to_full_reload(self):
        async def scenario():
            mgr = ConnectionManager()
            ws = GateWS()
            await mgr.connect(ws, None)
            await mgr.broadcast_all({"type": "progress"})
            loop = asyncio.get_event_loop()
            deadline = loop.time() + 1.0
            while not ws.blocked_once and loop.time() < deadline:
                await asyncio.sleep(0.001)
            first = [{"client_id": "c", "mutation_id": f"a{i}"} for i in range(20)]
            second = [{"client_id": "c", "mutation_id": f"b{i}"} for i in range(20)]
            await mgr.broadcast_all({"type": "synced", "origins": first})
            await mgr.broadcast_all({"type": "synced", "origins": second})
            ws.gate.set()
            await drain(mgr)
            return ws.received

        received = self._run(scenario())
        # 합집합 40 > 32(_MAX_NOTIFY_ORIGINS) → 출처 생략(전원 reload 가 안전).
        self.assertEqual(received[1], {"type": "synced"})

    def test_merge_treats_empty_arrays_as_full_refresh(self):
        """★코덱스 P1 회귀 — 빈 배열은 합집합의 항등원이 아니라 '전체'다. origins:[] 는
        '자기 알림 생략 불가(전부 reload)', projects:[] 는 '전체 프로젝트 갱신'이므로,
        병합이 이를 부분 갱신([own]·["A"])으로 축소하면 갱신 누락이 생긴다."""

        async def scenario():
            mgr = ConnectionManager()
            ws = GateWS()
            await mgr.connect(ws, None)
            await mgr.broadcast_all({"type": "progress"})
            await wait_until(lambda: ws.blocked_once)
            await mgr.broadcast_all({"type": "synced", "origins": []})
            await mgr.broadcast_all(
                {"type": "synced", "origins": [{"client_id": "c", "mutation_id": "m1"}]}
            )
            await mgr.broadcast_all({"type": "assets_changed", "projects": []})
            await mgr.broadcast_all({"type": "assets_changed", "projects": ["A"]})
            ws.gate.set()
            await drain(mgr)
            return ws.received

        received = self._run(scenario())
        self.assertEqual(received[1], {"type": "synced"})
        self.assertEqual(received[2], {"type": "assets_changed"})

    def test_connect_and_disconnect_return_anonymous_counts_once(self):
        async def scenario():
            mgr = ConnectionManager()
            first, second = FakeWS(), FakeWS()
            after_first = await mgr.connect(first, "acct:a")
            after_second = await mgr.connect(second, "acct:a")
            after_leave = await mgr.disconnect(first)
            duplicate_leave = await mgr.disconnect(first)
            return after_first, after_second, after_leave, duplicate_leave, first.accepted

        first, second, leave, duplicate, accepted = self._run(scenario())
        self.assertTrue(accepted)
        self.assertEqual(first["connections"], 1)
        self.assertEqual(first["authenticated_accounts"], 1)
        self.assertEqual(second["connections"], 2)
        self.assertEqual(second["authenticated_accounts"], 1)
        self.assertEqual(leave["connections"], 1)
        self.assertIsNone(duplicate)

    def test_mutation_notifications_coalesce_and_preserve_known_origins(self):
        async def scenario():
            mgr = ConnectionManager()
            sock = FakeWS()
            await mgr.connect(sock, "acct:a")
            with mock.patch("app.ws._NOTIFY_DEBOUNCE", 0):
                mgr.notify_mutation("acct:a", ("client_a_123", "mutation_001"))
                mgr.notify_mutation("acct:a", ("client_a_123", "mutation_002"))
                await mgr._pending_notify
                await drain(mgr)
            return sock.received

        messages = self._run(scenario())
        self.assertEqual(len(messages), 1)
        self.assertEqual(
            messages[0]["origins"],
            [
                {"client_id": "client_a_123", "mutation_id": "mutation_001"},
                {"client_id": "client_a_123", "mutation_id": "mutation_002"},
            ],
        )

    def test_unknown_origin_forces_safe_full_refresh_message(self):
        async def scenario():
            mgr = ConnectionManager()
            sock = FakeWS()
            await mgr.connect(sock, "acct:a")
            with mock.patch("app.ws._NOTIFY_DEBOUNCE", 0):
                mgr.notify_mutation("acct:a", ("client_a_123", "mutation_001"))
                mgr.notify_mutation("acct:a")
                await mgr._pending_notify
                await drain(mgr)
            return sock.received

        messages = self._run(scenario())
        self.assertEqual(messages, [{"type": "synced"}])

    def test_domain_notifications_coalesce_and_reach_independent_windows(self):
        async def scenario():
            mgr = ConnectionManager()
            a, b = FakeWS(), FakeWS()
            await mgr.connect(a, "acct:a")
            await mgr.connect(b, "acct:b")
            with mock.patch("app.ws._NOTIFY_DEBOUNCE", 0):
                mgr.notify_domain("assets_changed", ("client_a_123", "mutation_001"))
                mgr.notify_domain("assets_changed", ("client_a_123", "mutation_002"))
                mgr.notify_domain("manage_changed")
                await mgr._pending_notify
                await drain(mgr)
            return a.received, b.received

        a_messages, b_messages = self._run(scenario())
        self.assertEqual(a_messages, b_messages)
        self.assertEqual(
            a_messages,
            [
                {
                    "type": "assets_changed",
                    "origins": [
                        {"client_id": "client_a_123", "mutation_id": "mutation_001"},
                        {"client_id": "client_a_123", "mutation_id": "mutation_002"},
                    ],
                },
                {"type": "manage_changed"},
            ],
        )

    def test_same_origin_echo_is_suppressed_beyond_debounce_but_expires(self):
        async def scenario():
            mgr = ConnectionManager()
            sock = FakeWS()
            await mgr.connect(sock, None)
            origin = ("client_a_123", "mutation_001")
            with (
                mock.patch("app.ws._NOTIFY_DEBOUNCE", 0),
                mock.patch("app.ws.time.monotonic", return_value=100.0) as clock,
            ):
                mgr.notify_mutation(origin=origin)
                await mgr._pending_notify
                await drain(mgr)

                # 로컬 프록시 알림 뒤 원격 브리지가 같은 요청을 늦게 echo해도 두 번째 reload 없음.
                clock.return_value = 101.0
                mgr.notify_mutation(origin=origin, source="remote")
                await asyncio.sleep(0)

                # TTL 뒤 같은 식별자가 정말 재사용되면 새 변경으로 취급한다.
                clock.return_value = 131.0
                mgr.notify_mutation(origin=origin)
                await mgr._pending_notify
                await drain(mgr)
            return sock.received

        messages = self._run(scenario())
        self.assertEqual(len(messages), 2)
        self.assertTrue(all(message["type"] == "synced" for message in messages))

    def test_same_origin_on_same_transport_is_not_hidden(self):
        async def scenario():
            mgr = ConnectionManager()
            sock = FakeWS()
            await mgr.connect(sock, None)
            origin = ("client_a_123", "mutation_001")
            with mock.patch("app.ws._NOTIFY_DEBOUNCE", 0):
                mgr.notify_mutation(origin=origin)
                await mgr._pending_notify
                await drain(mgr)
                mgr.notify_mutation(origin=origin)
                await mgr._pending_notify
                await drain(mgr)
            return sock.received

        self.assertEqual(len(self._run(scenario())), 2)


class WsAccountIndexInvariantTests(unittest.TestCase):
    """R4 B-1 — 계정별 보조 인덱스(_by_account) 불변식.

    인덱스가 _clients 와 어긋나면 개인 데이터가 남의 스코프로 새거나(버킷 오염)
    알림이 조용히 유실된다(버킷 누락) — 모든 등록/해제 경로에서 두 구조의 일치를 고정한다.
    """

    def _run(self, coro):
        loop = asyncio.new_event_loop()
        try:
            return loop.run_until_complete(coro)
        finally:
            pending = asyncio.all_tasks(loop)
            for task in pending:
                task.cancel()
            if pending:
                loop.run_until_complete(asyncio.gather(*pending, return_exceptions=True))
            loop.close()

    def _assert_index_matches_clients(self, mgr: ConnectionManager) -> None:
        """_by_account 를 _clients 로부터 재구성한 기대값과 비교 + 빈 버킷 부재 확인."""
        expected: dict = {}
        for ws, client in mgr._clients.items():
            expected.setdefault(client.account_uid, set()).add(ws)
        self.assertEqual(mgr._by_account, expected)
        for bucket in mgr._by_account.values():
            self.assertTrue(bucket)  # 빈 버킷은 즉시 제거돼야 한다

    def test_scoped_broadcast_uses_index_and_isolates_among_decoys(self):
        """다계정 decoy·같은 계정 다탭·AUTH-off None 사이에서 스코프 정확 격리."""

        async def scenario():
            mgr = ConnectionManager()
            a1, a2 = FakeWS(), FakeWS()  # 같은 계정 두 탭
            decoy_b, decoy_c, none_sock = FakeWS(), FakeWS(), FakeWS()
            await mgr.connect(a1, "acct:a")
            await mgr.connect(a2, "acct:a")
            await mgr.connect(decoy_b, "acct:b")
            await mgr.connect(decoy_c, "acct:c")
            await mgr.connect(none_sock, None)
            self._assert_index_matches_clients(mgr)

            await mgr.broadcast({"type": "progress", "url": "secretA"}, account_uid="acct:a")
            await mgr.broadcast({"type": "progress", "url": "localOnly"}, account_uid=None)
            await drain(mgr)
            return a1.received, a2.received, decoy_b.received, decoy_c.received, none_sock.received

        a1_msgs, a2_msgs, b_msgs, c_msgs, none_msgs = self._run(scenario())
        # 같은 계정 두 탭 모두 수신
        self.assertEqual([m["url"] for m in a1_msgs], ["secretA"])
        self.assertEqual([m["url"] for m in a2_msgs], ["secretA"])
        # decoy 들은 아무것도 못 받음(누출 없음)
        self.assertEqual(b_msgs, [])
        self.assertEqual(c_msgs, [])
        # None 스코프는 None broadcast 만(전체 아님)
        self.assertEqual([m["url"] for m in none_msgs], ["localOnly"])

    def test_disconnect_removes_index_entry_and_empty_bucket(self):
        async def scenario():
            mgr = ConnectionManager()
            a1, a2, b = FakeWS(), FakeWS(), FakeWS()
            await mgr.connect(a1, "acct:a")
            await mgr.connect(a2, "acct:a")
            await mgr.connect(b, "acct:b")

            await mgr.disconnect(a1)
            self._assert_index_matches_clients(mgr)
            self.assertEqual(mgr._by_account.get("acct:a"), {a2})

            await mgr.disconnect(a2)  # 계정 a 마지막 연결 → 버킷 자체가 사라져야 한다
            self._assert_index_matches_clients(mgr)
            self.assertNotIn("acct:a", mgr._by_account)

            # 사라진 계정으로 broadcast 해도 조용히 무시(오류·누출 없음)
            await mgr.broadcast({"type": "progress"}, account_uid="acct:a")
            await drain(mgr)
            return b.received

        b_msgs = self._run(scenario())
        self.assertEqual(b_msgs, [])

    def test_same_socket_reregistration_moves_index_to_new_scope(self):
        """같은 소켓 재등록 — 옛 스코프 버킷에 유령이 남으면 새 주인에게 옛 계정 데이터가 샌다."""

        async def scenario():
            mgr = ConnectionManager()
            ws = FakeWS()
            await mgr.connect(ws, "acct:old")
            await mgr.connect(ws, "acct:new")  # 재등록(스코프 변경)
            self._assert_index_matches_clients(mgr)
            self.assertNotIn("acct:old", mgr._by_account)
            self.assertEqual(mgr._by_account.get("acct:new"), {ws})

            await mgr.broadcast({"type": "progress", "url": "oldSecret"}, account_uid="acct:old")
            await mgr.broadcast({"type": "progress", "url": "newData"}, account_uid="acct:new")
            await drain(mgr)
            return ws.received

        received = self._run(scenario())
        self.assertEqual([m["url"] for m in received], ["newData"])

    def test_stale_collect_after_reregistration_keeps_new_registration(self):
        """코덱스 P2 — 재등록 뒤 도착한 '옛 client'의 지연 수거는 identity 방어로 무시돼야
        한다. 옛 수거가 새 등록을 지우면 새 주인은 유령 연결이 되고 인덱스도 어긋난다."""

        async def scenario():
            mgr = ConnectionManager()
            ws = FakeWS()
            await mgr.connect(ws, "acct:old")
            stale = mgr._clients[ws]
            await mgr.connect(ws, "acct:new")  # 같은 소켓 재등록(새 client 인스턴스)
            await mgr._collect(stale, "timeout")  # 옛 client 의 지연 수거 도착
            self._assert_index_matches_clients(mgr)
            self.assertEqual(mgr._by_account.get("acct:new"), {ws})
            self.assertNotIn("acct:old", mgr._by_account)
            return await mgr.stats()

        stats = self._run(scenario())
        self.assertEqual(stats["connections"], 1)  # 새 등록 생존
        self.assertEqual(stats["send_timeouts"], 0)  # 무시된 수거는 집계도 안 된다

    def test_scoped_broadcast_does_not_scan_all_clients(self):
        """코덱스 P2 — 계정 스코프 broadcast 가 _clients.values() 전체 순회로 회귀하면
        전달 결과는 같아도 성능 계약(B-1)이 깨진다. 계측으로 직접 고정한다."""

        class ValuesSpyDict(dict):
            def __init__(self):
                super().__init__()
                self.values_calls = 0

            def values(self):
                self.values_calls += 1
                return super().values()

        async def scenario():
            mgr = ConnectionManager()
            spy = ValuesSpyDict()
            mgr._clients = spy
            a, b = FakeWS(), FakeWS()
            await mgr.connect(a, "acct:a")
            await mgr.connect(b, "acct:b")
            spy.values_calls = 0
            await mgr.broadcast({"type": "progress"}, account_uid="acct:a")
            scoped_calls = spy.values_calls
            await mgr.broadcast_all({"type": "synced"})
            all_calls = spy.values_calls - scoped_calls
            await drain(mgr)
            return scoped_calls, all_calls, a.received, b.received

        scoped_calls, all_calls, a_msgs, b_msgs = self._run(scenario())
        self.assertEqual(scoped_calls, 0)  # 스코프 경로는 버킷만 본다
        self.assertEqual(all_calls, 1)  # broadcast_all 만 전체 순회
        self.assertEqual([m["type"] for m in a_msgs], ["progress", "synced"])
        self.assertEqual([m["type"] for m in b_msgs], ["synced"])

    def test_timeout_collection_cleans_index(self):
        async def scenario():
            mgr = ConnectionManager()
            slow, healthy = SlowWS(), FakeWS()
            await mgr.connect(slow, "acct:a")
            await mgr.connect(healthy, "acct:a")
            with mock.patch("app.ws._WS_SEND_TIMEOUT_SECONDS", 0.05):
                await mgr.broadcast({"type": "progress"}, account_uid="acct:a")
                await drain(mgr)
                await wait_until(lambda: slow.closed is not None)
            self._assert_index_matches_clients(mgr)
            self.assertEqual(mgr._by_account.get("acct:a"), {healthy})
            return await mgr.stats()

        stats = self._run(scenario())
        self.assertEqual(stats["send_timeouts"], 1)
        self.assertEqual(stats["connections"], 1)

    def test_overflow_collection_cleans_index_and_removes_empty_bucket(self):
        async def scenario():
            mgr = ConnectionManager()
            stuck, other = SlowWS(), FakeWS()
            await mgr.connect(stuck, "acct:a")
            await mgr.connect(other, "acct:b")
            with mock.patch("app.ws._WS_QUEUE_MAX", 4):
                for n in range(6):
                    await mgr.broadcast({"type": "progress", "n": n}, account_uid="acct:a")
                await drain(mgr)
                await wait_until(lambda: stuck.closed is not None)
            self._assert_index_matches_clients(mgr)
            self.assertNotIn("acct:a", mgr._by_account)  # 계정 a 마지막 연결 수거 → 버킷 제거
            self.assertEqual(mgr._by_account.get("acct:b"), {other})
            return await mgr.stats()

        stats = self._run(scenario())
        self.assertEqual(stats["send_overflows"], 1)
        self.assertEqual(stats["connections"], 1)


if __name__ == "__main__":
    unittest.main()

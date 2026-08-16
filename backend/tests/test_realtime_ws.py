"""실시간(WS) 스코프 불변식 — 계정 스코프 broadcast 는 격리, broadcast_all 만 전체.

이번 세션에서 잡은 누출(계정 uid 가 None 이면 전체로 새던 것)과 회귀(syncer 전체 reload 가 끊기던 것)를
불변식으로 고정한다. realtime_scope 는 email 기반이라 creator_uid 리맵·NULL 에도 안정적이어야 한다.
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
        return asyncio.new_event_loop().run_until_complete(coro)

    def test_scoped_broadcast_isolates_and_broadcast_all_reaches_everyone(self):
        async def scenario():
            mgr = ConnectionManager()
            a, b, none_sock = FakeWS(), FakeWS(), FakeWS()
            mgr._active[a] = "acct:a"
            mgr._active[b] = "acct:b"
            mgr._active[none_sock] = None

            # 계정 스코프 → 정확히 그 소켓만(진행률·result_url 누출 방지)
            await mgr.broadcast({"type": "progress", "url": "secretA"}, account_uid="acct:a")
            # account_uid=None 은 '전체'가 아니라 'None 스코프 소켓'만(AUTH off 소켓)
            await mgr.broadcast({"type": "progress", "url": "x"}, account_uid=None)
            # 전체 reload 신호는 broadcast_all 로만(syncer)
            await mgr.broadcast_all({"type": "synced"})

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
                mgr._active[FakeWS()] = f"acct:{index // 2}"
            mgr._active[FakeWS()] = None
            return await mgr.stats()

        stats = self._run(scenario())
        self.assertEqual(stats["connections"], 101)
        self.assertEqual(stats["authenticated_connections"], 100)
        self.assertEqual(stats["authenticated_accounts"], 50)
        self.assertEqual(stats["local_connections"], 1)
        self.assertEqual(stats["send_timeouts"], 0)
        self.assertEqual(stats["send_failures"], 0)

    def test_slow_client_does_not_block_fast_client_and_is_collected(self):
        async def scenario():
            mgr = ConnectionManager()
            slow, fast = SlowWS(), FakeWS()
            mgr._active[slow] = "acct:a"
            mgr._active[fast] = "acct:a"
            with mock.patch("app.ws._WS_SEND_TIMEOUT_SECONDS", 0.05):
                sending = asyncio.create_task(
                    mgr.broadcast({"type": "progress"}, account_uid="acct:a")
                )
                await asyncio.sleep(0.005)
                delivered_before_slow_timeout = list(fast.received)
                self.assertFalse(sending.done())
                await sending
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
            mgr._active[failed] = None
            mgr._active[fast] = None
            await mgr.broadcast_all({"type": "synced"})
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
            mgr._active[slow] = None
            with mock.patch("app.ws._WS_SEND_TIMEOUT_SECONDS", 0.02):
                await asyncio.gather(
                    mgr.broadcast_all({"type": "first"}),
                    mgr.broadcast_all({"type": "second"}),
                )
            return await mgr.stats()

        stats = self._run(scenario())
        self.assertEqual(stats["connections"], 0)
        self.assertEqual(stats["send_timeouts"], 1)
        self.assertEqual(stats["send_failures"], 0)

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
            mgr._active[sock] = "acct:a"
            with mock.patch("app.ws._NOTIFY_DEBOUNCE", 0):
                mgr.notify_mutation("acct:a", ("client_a_123", "mutation_001"))
                mgr.notify_mutation("acct:a", ("client_a_123", "mutation_002"))
                await mgr._pending_notify
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
            mgr._active[sock] = "acct:a"
            with mock.patch("app.ws._NOTIFY_DEBOUNCE", 0):
                mgr.notify_mutation("acct:a", ("client_a_123", "mutation_001"))
                mgr.notify_mutation("acct:a")
                await mgr._pending_notify
            return sock.received

        messages = self._run(scenario())
        self.assertEqual(messages, [{"type": "synced"}])

    def test_domain_notifications_coalesce_and_reach_independent_windows(self):
        async def scenario():
            mgr = ConnectionManager()
            a, b = FakeWS(), FakeWS()
            mgr._active[a] = "acct:a"
            mgr._active[b] = "acct:b"
            with mock.patch("app.ws._NOTIFY_DEBOUNCE", 0):
                mgr.notify_domain("assets_changed", ("client_a_123", "mutation_001"))
                mgr.notify_domain("assets_changed", ("client_a_123", "mutation_002"))
                mgr.notify_domain("manage_changed")
                await mgr._pending_notify
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
            mgr._active[sock] = None
            origin = ("client_a_123", "mutation_001")
            with (
                mock.patch("app.ws._NOTIFY_DEBOUNCE", 0),
                mock.patch("app.ws.time.monotonic", return_value=100.0) as clock,
            ):
                mgr.notify_mutation(origin=origin)
                await mgr._pending_notify

                # 로컬 프록시 알림 뒤 원격 브리지가 같은 요청을 늦게 echo해도 두 번째 reload 없음.
                clock.return_value = 101.0
                mgr.notify_mutation(origin=origin, source="remote")
                await asyncio.sleep(0)

                # TTL 뒤 같은 식별자가 정말 재사용되면 새 변경으로 취급한다.
                clock.return_value = 131.0
                mgr.notify_mutation(origin=origin)
                await mgr._pending_notify
            return sock.received

        messages = self._run(scenario())
        self.assertEqual(len(messages), 2)
        self.assertTrue(all(message["type"] == "synced" for message in messages))

    def test_same_origin_on_same_transport_is_not_hidden(self):
        async def scenario():
            mgr = ConnectionManager()
            sock = FakeWS()
            mgr._active[sock] = None
            origin = ("client_a_123", "mutation_001")
            with mock.patch("app.ws._NOTIFY_DEBOUNCE", 0):
                mgr.notify_mutation(origin=origin)
                await mgr._pending_notify
                mgr.notify_mutation(origin=origin)
                await mgr._pending_notify
            return sock.received

        self.assertEqual(len(self._run(scenario())), 2)


if __name__ == "__main__":
    unittest.main()

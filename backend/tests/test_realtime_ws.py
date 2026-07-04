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

    async def send_json(self, message):
        self.received.append(message)


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


if __name__ == "__main__":
    unittest.main()

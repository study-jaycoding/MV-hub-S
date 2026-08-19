"""로그인 무차별 대입 방어 — 동시 요청이 실패 창을 우회하지 못하는 계약(합의 BE-P2-2).

실패는 해시 검증이 끝나야 기록되므로, '진행 중 예약(in-flight)' 없이는 같은 IP+이메일의
동시 요청 수백 건이 전부 검사를 통과해 PBKDF2 를 무제한으로 돌릴 수 있었다.
여기서 고정하는 성질: 예약이 창에 합산된다 · 해제는 슬롯만 풀고 실패 기록은 남는다 ·
성공은 실패 기록을 지운다 · 키(IP|이메일)별 격리.
"""

import unittest

from fastapi import HTTPException

from app.routers import auth


class LoginRateLimitTests(unittest.TestCase):
    def setUp(self):
        auth._rl_fails.clear()
        auth._rl_inflight.clear()

    def tearDown(self):
        auth._rl_fails.clear()
        auth._rl_inflight.clear()

    def test_concurrent_reservations_hit_the_window(self):
        """실패가 기록되기 전이라도 진행 중 검증이 창을 채우면 다음 요청은 429."""
        key = "1.2.3.4|a@b.c"
        for _ in range(auth._RL_MAX):
            auth._rl_reserve(key)
        with self.assertRaises(HTTPException) as ctx:
            auth._rl_reserve(key)
        self.assertEqual(ctx.exception.status_code, 429)

    def test_release_frees_slots_but_failures_still_count(self):
        """검증이 모두 끝나(예약 해제) 실패로 기록되면 여전히 창이 막는다."""
        key = "1.2.3.4|a@b.c"
        for _ in range(auth._RL_MAX):
            auth._rl_reserve(key)
        for _ in range(auth._RL_MAX):
            auth._rl_fail(key)
            auth._rl_release(key)
        self.assertEqual(auth._rl_inflight.get(key, 0), 0)
        with self.assertRaises(HTTPException):
            auth._rl_reserve(key)

    def test_success_clears_failures_and_slot(self):
        key = "1.2.3.4|a@b.c"
        auth._rl_reserve(key)
        auth._rl_fail(key)
        auth._rl_ok(key)
        auth._rl_release(key)
        auth._rl_reserve(key)  # 성공 뒤엔 즉시 다시 시도 가능해야 한다
        auth._rl_release(key)
        self.assertEqual(auth._rl_inflight, {})

    def test_keys_are_isolated(self):
        """공격자 IP 가 창을 채워도 다른 IP 의 같은 계정 로그인은 막히지 않는다."""
        for _ in range(auth._RL_MAX):
            auth._rl_reserve("attacker|x@y.z")
        auth._rl_reserve("victim-ip|x@y.z")
        auth._rl_release("victim-ip|x@y.z")


if __name__ == "__main__":
    unittest.main()

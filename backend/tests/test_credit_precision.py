"""크레딧은 소수다 — 견적부터 장부까지 어디서도 반올림하지 않는다.

배경(2026-09-11 실측, CLI 1.1.24 읽기 전용):
· 거래 금액이 소수다. `Nano Banana 2` = −1.5, `Higgsfield Soul V2` = −0.12,
  `Seedance 2.5` 기본 = −32.5, `Vision Video` = −0.31.
  MILLION VOLT 최근 100건 중 **58건**이 소수였다(Nano Banana 2 −1.5 가 42건).
· 견적도 소수다. `generate cost seedance_2_0` → **22.5 credits**.
· 그리고 견적은 실제 청구와 **정확히 같았다**(1.5=1.5, 1=1, 32.5=32.5).
  → 힉스필드는 처음부터 정확한 값을 줬고, 우리가 받아서 버리고 있었다.

종전 손실 지점(전부 이 시험이 지킨다):
  ① `manage_transactions` 매칭    `round(abs(credits))` → −1.5 를 2 로(33% 과대), −0.12 를 0 으로
  ② `cli_bridge` 견적 산출        `int(round(float(credits)))` → 22.5 를 22 로
  ③ `cli_bridge` 견적 캐시 로더   `int(v[0])` → 재시작하면 ②를 고쳐도 다시 22 로
  ④ `gen_requests` 요청 견적      `int(value) if value else None` → 절삭 + **정상 0 을 미상으로**
  ⑤ `manage_credit_plan` 이월     `round(...)` 를 **DB 에 저장** → 영구 손실
  ⑥ 실패 응답의 `{"credits": 0}`  → 조회 실패가 장부에 '무료'로 남음

시험은 제품 경로를 그대로 탄다(가짜는 DB·CLI 경계에만) — 조립식 시험은 고친 줄을 지워도
통과한다(2026-09-11 같은 날 실제로 밟은 전례).
"""

from __future__ import annotations

import asyncio
import os
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from unittest.mock import AsyncMock, patch

from app import db, repo
from app.repo import manage


BASE = datetime(2026, 8, 1, 10, 0, tzinfo=timezone.utc)

# (생성물 id, 거래 금액, 장부에 남아야 하는 값) — 금액은 전부 2026-09-11 실측값이다.
MEASURED = [
    ("g_nb2", -1.5, 1.5),  # Nano Banana 2 — 42건이 이 값이었다. round 면 2(33% 과대)
    ("g_soul", -0.12, 0.12),  # Higgsfield Soul V2 — round 면 0(전액 소실)
    ("g_seed", -32.5, 32.5),  # Seedance 2.5 기본 — round 면 32(짝수로 내려간다)
    ("g_vision", -0.31, 0.31),  # Vision Video
    ("g_whole", -52, 52.0),  # 정수 거래도 그대로여야 한다(회귀 감시)
]


class _ContentDbCase(unittest.TestCase):
    """임시 content DB 하나 — 가짜는 여기(DB 경계)까지만 둔다."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(ignore_cleanup_errors=True)
        self.old_db = os.environ.get("CONTENT_HUB_DB")
        os.environ["CONTENT_HUB_DB"] = os.path.join(self.tmp.name, "content_hub.db")
        db.flush_pool()
        db.init_db()
        repo.ensure_default_worker()
        with db.get_connection() as conn:
            conn.execute(
                "INSERT INTO creator(uid, name) VALUES('u_me','Artist') "
                "ON CONFLICT(uid) DO NOTHING"
            )

    def tearDown(self):
        db.flush_pool()
        if self.old_db is None:
            os.environ.pop("CONTENT_HUB_DB", None)
        else:
            os.environ["CONTENT_HUB_DB"] = self.old_db
        db.flush_pool()
        self.tmp.cleanup()

    def _add_generation(self, gen_id: str, when: datetime, model: str = "model-a") -> None:
        with db.get_connection() as conn:
            conn.execute(
                "INSERT INTO generation(id, worker_id, prompt, status, created_at, sort_ts, "
                "creator_uid, model) VALUES(?,'me','prompt','done',?,?,'u_me',?)",
                (gen_id, when.isoformat().replace("+00:00", "Z"), when.timestamp(), model),
            )

    def _real_credits(self, gen_id: str):
        with db.get_connection() as conn:
            row = conn.execute(
                "SELECT real_credits FROM generation_metrics WHERE gen_id=?", (gen_id,)
            ).fetchone()
        return None if row is None else row["real_credits"]


class TransactionAmountPrecisionTests(_ContentDbCase):
    def test_measured_fractional_amounts_land_in_the_ledger_intact(self):
        """★핵심 — 실측 금액 다섯이 반올림 없이 그대로 기록된다.

        생성물마다 한 시간씩 띄워 60초 윈도우가 서로 겹치지 않게 한다(이 시험이 보는 것은
        금액이지 배정이 아니다 — 배정은 [[test_manage_transactions]] 가 본다)."""
        transactions = []
        for index, (gen_id, credits, _expected) in enumerate(MEASURED):
            when = BASE + timedelta(hours=index)
            self._add_generation(gen_id, when)
            transactions.append(
                {
                    "created_at": when.isoformat().replace("+00:00", "Z"),
                    "credits": credits,
                    "action": "spend",
                    "display_name": "Model A",
                    "model": "model-a",
                }
            )

        result = manage.record_transactions("u_me", "me@example.com", transactions)

        self.assertEqual(result["matched"], len(MEASURED))
        for gen_id, credits, expected in MEASURED:
            with self.subTest(credits=credits):
                self.assertEqual(self._real_credits(gen_id), expected)

    def test_a_free_zero_spend_is_recorded_as_zero_not_as_unknown(self):
        """0 은 정상 금액이다 — 미상(NULL)과 섞으면 '무료'와 '모름'을 구별할 수 없다."""
        self._add_generation("g_free", BASE)
        manage.record_transactions(
            "u_me",
            "me@example.com",
            [
                {
                    "created_at": BASE.isoformat().replace("+00:00", "Z"),
                    "credits": 0,
                    "action": "spend",
                    "display_name": "Model A",
                    "model": "model-a",
                }
            ],
        )
        self.assertEqual(self._real_credits("g_free"), 0)

    def test_an_unreadable_amount_never_consumes_a_generation(self):
        """★금액을 못 읽는 거래는 **생성물을 소비하지 않는다**.

        종전엔 NULL 금액이어도 매칭이 성립해 그 생성물의 `real_credits` 를 NULL 로 확정하고
        (다시는 매칭되지 않는다) 거래까지 써 버렸다. 유료 생성이 장부에서 사라지는 자리다."""
        for gen_id, bad in (("g_null", None), ("g_text", "not-a-number")):
            with self.subTest(credits=bad):
                when = BASE + timedelta(hours=10 if bad is None else 20)
                self._add_generation(gen_id, when)
                result = manage.record_transactions(
                    "u_me",
                    "me@example.com",
                    [
                        {
                            "created_at": when.isoformat().replace("+00:00", "Z"),
                            "credits": bad,
                            "action": "spend",
                            "display_name": "Model A",
                            "model": "model-a",
                        }
                    ],
                )
                self.assertEqual(result["matched"], 0)
                self.assertIsNone(self._real_credits(gen_id))
                with db.get_connection() as conn:
                    linked = conn.execute(
                        "SELECT matched_gen_id FROM credit_txn WHERE matched_gen_id IS NOT NULL"
                    ).fetchall()
                self.assertEqual(linked, [])  # 거래도 소비되지 않았다(다음에 다시 볼 수 있다)


class EstimatePrecisionTests(unittest.IsolatedAsyncioTestCase):
    """견적 경로 — 가짜는 CLI 경계(`_run_json`)에만 둔다."""

    def setUp(self):
        from app.services import cli_bridge

        self.cli_bridge = cli_bridge
        cli_bridge._COST_CACHE.clear()
        cli_bridge._cost_loaded = True  # 파일 캐시를 읽지 않는다(시험 격리)
        cli_bridge._estimate_gates.clear()

    def tearDown(self):
        self.cli_bridge._COST_CACHE.clear()

    def _patched(self, payload):
        return patch.object(
            self.cli_bridge, "_param_args", new=AsyncMock(return_value=[])
        ), patch.object(self.cli_bridge, "_run_json", new=AsyncMock(return_value=payload))

    async def test_a_fractional_estimate_survives_and_is_cached_as_is(self):
        """★`generate cost seedance_2_0` 는 실제로 22.5 를 준다 — 22 로 깎지 않는다."""
        params, runner = self._patched({"credits": 22.5})
        with params, runner:
            result = await self.cli_bridge.estimate_cost("seedance_2_0")
        self.assertEqual(result, {"credits": 22.5})
        cached = self.cli_bridge._COST_CACHE["seedance_2_0|"][0]
        self.assertEqual(cached, 22.5)  # 캐시에도 소수로 — 안 그러면 재시작 뒤 22 로 굳는다

    async def test_credits_exact_wins_and_keeps_its_decimals(self):
        params, runner = self._patched({"credits_exact": 1.5, "credits": 2})
        with params, runner:
            result = await self.cli_bridge.estimate_cost("nano_banana_flash")
        self.assertEqual(result, {"credits": 1.5})  # 반올림된 credits(2)를 쓰면 안 된다

    async def test_a_broken_response_is_reported_not_priced_at_zero(self):
        """★조회 실패를 0 으로 지어내지 않는다 — 0 은 '무료'라는 뜻이고 장부에 그렇게 남는다."""
        for payload in ({"credits": None}, {"credits": "free"}, {}, []):
            with self.subTest(payload=payload):
                self.cli_bridge._COST_CACHE.clear()
                params, runner = self._patched(payload)
                with params, runner:
                    with self.assertRaises(self.cli_bridge.CLIError):
                        await self.cli_bridge.estimate_cost("model-x")

    async def test_a_negative_or_non_finite_price_is_refused(self):
        for payload in ({"credits": -5}, {"credits": float("nan")}, {"credits": float("inf")},
                        {"credits": True}):
            with self.subTest(payload=payload):
                self.cli_bridge._COST_CACHE.clear()
                params, runner = self._patched(payload)
                with params, runner:
                    with self.assertRaises(self.cli_bridge.CLIError):
                        await self.cli_bridge.estimate_cost("model-x")

    async def test_a_stale_cache_still_wins_over_a_broken_response(self):
        """옛 값이 있으면 그걸 쓴다(종전 계약 유지) — 없을 때만 실패를 알린다."""
        self.cli_bridge._COST_CACHE["model-a|"] = (32.5, 0.0)
        params, runner = self._patched({"credits": "broken"})
        with params, runner:
            result = await self.cli_bridge.estimate_cost("model-a")
        self.assertEqual(result, {"credits": 32.5})

    def test_the_persisted_cache_reloads_decimals(self):
        """★로더가 정수로 깎으면 위의 모든 수정이 재시작 한 번에 무효가 된다."""
        import json

        cli_bridge = self.cli_bridge
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp:
            path = os.path.join(tmp, "cost_cache_v2.json")
            with open(path, "w", encoding="utf-8") as handle:
                json.dump({"m|": [22.5, 1.0], "bad|": ["x", 1.0]}, handle)
            import pathlib

            with patch.object(cli_bridge, "_COST_CACHE_FILE", pathlib.Path(path)):
                cli_bridge._COST_CACHE.clear()
                cli_bridge._cost_loaded = False
                cli_bridge._load_cost_cache()
        self.assertEqual(cli_bridge._COST_CACHE["m|"][0], 22.5)
        self.assertNotIn("bad|", cli_bridge._COST_CACHE)  # 읽을 수 없는 값은 버린다
        cli_bridge._cost_loaded = True


class RequestEstimateStorageTests(unittest.IsolatedAsyncioTestCase):
    """요청에 붙는 견적(`generation_metrics.est_credits`) — 소수와 정상 0 을 지킨다."""

    async def _record(self, credits):
        from app.usecases import gen_requests

        seen: dict = {}

        async def fake_sync_io(func, call, *, operation, dirty_gen_id=None):
            class _Repo:
                @staticmethod
                def record_request(gen_id, est_credits=None):
                    seen["est"] = est_credits

            call(_Repo)

        with patch.object(gen_requests.cli_bridge, "cli_available", return_value=True), \
            patch.object(
                gen_requests.cli_bridge, "estimate_cost",
                new=AsyncMock(return_value={"credits": credits}),
            ), patch.object(gen_requests, "_sync_io", new=fake_sync_io):
            await gen_requests._record_request_estimate("g1", "me@example.com", {"model": "m"})
        return seen.get("est")

    async def test_a_fractional_estimate_is_stored_as_is(self):
        self.assertEqual(await self._record(22.5), 22.5)

    async def test_a_free_estimate_is_stored_as_zero_not_dropped(self):
        """★`if value` 는 0 을 거짓으로 봐서 **무료를 미상으로** 바꿨다."""
        self.assertEqual(await self._record(0), 0.0)

    async def test_a_missing_estimate_stays_unknown(self):
        self.assertIsNone(await self._record(None))


if __name__ == "__main__":
    unittest.main()

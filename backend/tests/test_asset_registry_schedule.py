"""에셋 리스트 정한 시간 자동 훑기(Jay 2026-10-02, 설계 r3 · Codex 조건부 승인) — 서버 시계 2분 창·회차당 한 곳·
로컬 모드에서 서버는 회차를 건드리지 않음·이벤트 루프는 잠금·DB 를 기다리지 않음."""

from __future__ import annotations

import asyncio
import json
import threading
import time
import unittest
from datetime import datetime, timedelta
from unittest.mock import patch

from fastapi.testclient import TestClient

from app import db
from app.db import init_db
from app.routers import asset_registry as api
from app.routers import registry_helper
from app.services import asset_registry as svc
from app.services import asset_registry_helper as helper_mod

KST = svc._KST


def at(day: int, hour: int, minute: int = 0, second: int = 0) -> datetime:
    return datetime(2026, 10, day, hour, minute, second, tzinfo=KST)  # 2026-10-05 = 월요일


class _Clock(datetime):
    fixed: datetime = at(1, 0)

    @classmethod
    def now(cls, tz=None):  # noqa: ANN001 — datetime.now 대역
        return cls.fixed


def sched(kind: str, **fields) -> dict:
    raw = {"kind": kind, "day": 1, "weekday": 0, "hour": 3, "saved_at": "2026-01-01T00:00:00+09:00", **fields}
    return svc.parse_schedule(json.dumps(raw))


class SlotMathTests(unittest.TestCase):
    def test_daily_weekly_monthly_latest_and_next(self) -> None:
        daily = sched("day", hour=3)
        self.assertEqual(svc.latest_slot(daily, at(5, 3)), at(5, 3))
        self.assertEqual(svc.latest_slot(daily, at(5, 2, 59)), at(4, 3))
        self.assertEqual(svc.next_slot(daily, at(5, 3)), at(6, 3))
        weekly = sched("week", weekday=0, hour=15)  # 월 오후 3시
        self.assertEqual(svc.latest_slot(weekly, at(8, 9)), at(5, 15))
        self.assertEqual(svc.next_slot(weekly, at(5, 15)), at(12, 15))
        monthly = sched("month", day=28, hour=0)
        self.assertEqual(svc.latest_slot(monthly, at(5, 0)), datetime(2026, 9, 28, tzinfo=KST))
        self.assertEqual(svc.next_slot(monthly, datetime(2026, 10, 28, 0, 0, 1, tzinfo=KST)),
                         datetime(2026, 11, 28, tzinfo=KST))
        self.assertEqual(svc.latest_slot(monthly, datetime(2026, 3, 1, tzinfo=KST)), datetime(2026, 2, 28, tzinfo=KST))

    def test_off_or_broken_is_off(self) -> None:
        for raw in (None, "", "{", json.dumps({"kind": "hourly"})):
            self.assertIsNone(svc.next_slot(svc.parse_schedule(raw), at(5, 3)))
        # 깨진 값은 다른 시각으로 고쳐 켜지 않고 끈다(Codex 코드 리뷰)
        for broken in ({"day": 31}, {"hour": 99}, {"weekday": 7}, {"saved_at": "bad"}, {"hour": "3"}, {"day": True}):
            self.assertEqual(sched("month", **broken)["kind"], "off", broken)
        self.assertEqual(sched("month", day=28)["kind"], "month")


class ConsumeTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        init_db()

    def setUp(self) -> None:
        for key in (svc._SCHEDULE_KEY, svc._MARK_KEY, svc._MODE_KEY):
            svc.repo.set_setting(key, None)
        self.clock = patch.object(svc, "datetime", _Clock)
        self.clock.start()
        self.addCleanup(self.clock.stop)
        _Clock.fixed = at(4, 12)
        svc.save_schedule("day", 1, 0, 3)  # 4일 낮에 '매일 3시' 저장

    def consume(self, now: datetime, runner: str = "server", mode: str = "server"):
        _Clock.fixed = now
        return svc.consume_slot(runner, mode)

    def test_two_minute_window_then_skipped(self) -> None:
        self.assertEqual(self.consume(at(5, 3, 2, 1))[:2], (False, "not_due"))  # 창 밖 — 따라잡지 않는다
        ok, reason, slot, mark_id = self.consume(at(6, 3, 2, 0))
        self.assertEqual((ok, reason, slot), (True, "", at(6, 3).isoformat()))
        self.assertTrue(mark_id)
        self.assertEqual(self.consume(at(6, 3, 2, 0))[:2], (False, "taken"))  # 회차당 한 번

    def test_no_slot_before_the_schedule_was_saved(self) -> None:
        _Clock.fixed = at(7, 3, 0, 30)
        svc.save_schedule("day", 1, 0, 3)  # 3시 넘어 저장 → 오늘 회차 없음
        self.assertEqual(self.consume(at(7, 3, 1))[:2], (False, "before_saved"))
        self.assertTrue(self.consume(at(8, 3, 1))[0])

    def test_local_mode_server_tick_leaves_the_slot_for_one_admin_pc(self) -> None:
        svc.repo.set_setting(svc._MODE_KEY, "local")
        self.assertEqual(self.consume(at(5, 3, 0, 10))[:2], (False, "mode"))  # 서버 틱이 먼저 와도
        self.assertIsNone(svc.repo.get_setting(svc._MARK_KEY))  # 표식 없음
        self.assertTrue(self.consume(at(5, 3, 0, 20), "pc:A", "local")[0])
        self.assertEqual(self.consume(at(5, 3, 0, 30), "pc:B", "local")[:2], (False, "taken"))

    def test_clock_going_back_does_not_rerun(self) -> None:
        self.assertTrue(self.consume(at(6, 3, 1))[0])
        self.assertEqual(self.consume(at(5, 3, 1))[:2], (False, "taken"))

    def test_outcome_only_updates_its_own_mark(self) -> None:
        _ok, _reason, _slot, mark_id = self.consume(at(5, 3, 1))
        self.assertTrue(svc.mark_outcome(mark_id, "not_started"))
        self.assertEqual(json.loads(svc.repo.get_setting(svc._MARK_KEY))["state"], "not_started")
        svc.repo.set_setting(svc._MARK_KEY, json.dumps({"id": "restored", "slot": at(5, 3).isoformat(), "state": "started"}))
        self.assertFalse(svc.mark_outcome(mark_id, "not_started"))  # 복원된 표식은 덮지 않는다
        self.assertEqual(json.loads(svc.repo.get_setting(svc._MARK_KEY))["state"], "started")

    def test_status_shows_schedule_next_run_and_last_mark(self) -> None:
        self.consume(at(5, 3, 1))
        state = svc.schedule_status()
        self.assertEqual(state["schedule"], {"kind": "day", "day": 1, "weekday": 0, "hour": 3})
        self.assertEqual(state["next_run_at"], at(6, 3).isoformat())
        self.assertEqual(state["schedule_mark"]["runner"], "server")


class NoWaitStartTests(unittest.TestCase):
    """정한 시간 자동 시작은 이벤트 루프에서 잠금·DB 를 기다리지 않는다(Codex r2·r3)."""

    @classmethod
    def setUpClass(cls) -> None:
        init_db()

    def _held(self, lock) -> threading.Event:
        release, held = threading.Event(), threading.Event()

        def hold() -> None:
            with lock:
                held.set()
                release.wait(5)

        threading.Thread(target=hold, daemon=True).start()
        held.wait(5)
        self.addCleanup(release.set)
        return release

    def test_busy_leases_lock_refuses_at_once(self) -> None:
        ctl = svc.AssetRegistryController()
        self._held(svc.leases.lock)
        started = time.monotonic()
        self.assertFalse(ctl.request_scan(mode="auto", wait=False))
        self.assertLess(time.monotonic() - started, 0.1)

    def test_mode_check_uses_only_a_current_cache(self) -> None:
        svc._mode_cache = (db.pool_epoch() - 1, "server")  # 복원 뒤 낡은 캐시
        with patch.object(svc.repo, "get_setting", side_effect=AssertionError("루프에서 DB 를 읽으면 안 된다")):
            self.assertIsNone(svc.registry_mode_nowait())
        svc._mode_cache = (db.pool_epoch(), "server")
        self.assertEqual(svc.registry_mode_nowait(), "server")
        self._held(db._pool_condition)
        self.assertIsNone(svc.registry_mode_nowait())  # DB 상태 잠금도 기다리지 않는다
        svc._mode_cache = None

    def test_server_tick_marks_not_started_when_it_could_not_start(self) -> None:
        ctl = svc.AssetRegistryController()
        calls: list = []

        async def one_tick() -> None:
            with patch.object(svc, "_STARTUP_DELAY_S", 0), patch.object(svc, "SCHEDULE_TICK_S", 0.05), \
                    patch.object(svc, "registry_mode", return_value="server"), \
                    patch.object(svc, "consume_slot", side_effect=lambda *a: (True, "", "slot", "mark-1")), \
                    patch.object(svc, "mark_outcome", side_effect=lambda *a: calls.append(("mark",) + a)), \
                    patch.object(ctl, "request_scan", side_effect=lambda **kw: calls.append(("scan", kw)) or False):
                task = asyncio.create_task(ctl._loop())
                await asyncio.sleep(0.12)
                ctl._stopping = True
                task.cancel()
                with self.assertRaises(asyncio.CancelledError):
                    await task

        asyncio.run(one_tick())
        self.assertIn(("scan", {"mode": "auto", "wait": False}), calls)
        self.assertIn(("mark", "mark-1", "not_started"), calls)


class RouteTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        init_db()
        from app.main import app

        cls.client = TestClient(app, client=("127.0.0.1", 50000))

    def setUp(self) -> None:
        enabled = patch.object(svc, "ASSET_REGISTRY_ENABLED", True)
        enabled.start()
        self.addCleanup(enabled.stop)
        for key in (svc._SCHEDULE_KEY, svc._MARK_KEY):
            svc.repo.set_setting(key, None)

    def test_save_validates_and_status_reports(self) -> None:
        self.assertEqual(self.client.post("/api/asset-registry/schedule", json={"kind": "month", "day": 29}).status_code, 422)
        saved = self.client.post("/api/asset-registry/schedule", json={"kind": "week", "weekday": 0, "hour": 15}).json()
        self.assertEqual(saved["schedule"], {"kind": "week", "day": 1, "weekday": 0, "hour": 15})
        self.assertTrue(saved["next_run_at"])
        status = self.client.get("/api/asset-registry/status").json()
        self.assertEqual(status["schedule"]["kind"], "week")
        self.assertEqual(status["interval_min"], 0)

    def test_claim_runs_once_per_slot_for_admin_pcs(self) -> None:
        svc.repo.set_setting(svc._MODE_KEY, "local")
        self.addCleanup(svc.repo.set_setting, svc._MODE_KEY, None)
        with patch.object(svc, "datetime", _Clock):
            _Clock.fixed = at(4, 12)
            self.client.post("/api/asset-registry/schedule", json={"kind": "day", "hour": 3})
            _Clock.fixed = at(5, 3, 0, 40)
            first = self.client.post("/api/asset-registry/schedule/claim", json={"runner": "FX-PC06\n"}).json()
            second = self.client.post("/api/asset-registry/schedule/claim", json={"runner": "AI-PC02"}).json()
        self.assertEqual((first["run"], second["run"]), (True, False))
        self.assertEqual(json.loads(svc.repo.get_setting(svc._MARK_KEY))["runner"], "pc:FX-PC06")


class LocalLoopTests(unittest.TestCase):
    def test_context_needs_proxying_and_a_stored_admin_role(self) -> None:
        with patch.object(registry_helper._proxy, "proxying", return_value=True), \
                patch.object(registry_helper.publish, "_is_admin", return_value=False):
            self.assertIsNone(registry_helper._capture_context())
        with patch.object(registry_helper._proxy, "proxying", return_value=True), \
                patch.object(registry_helper.publish, "_is_admin", return_value=True), \
                patch.object(registry_helper.shared_connection, "token", return_value="tok"), \
                patch.object(registry_helper.shared_connection, "base_url", return_value="http://server:8010"):
            self.assertEqual(registry_helper._capture_context(), ("http://server:8010", "tok"))

    def test_claimed_slot_begins_with_the_same_context(self) -> None:
        began: list = []

        async def one_tick() -> None:
            with patch.object(registry_helper, "SCHEDULE_TICK_S", 0.01), \
                    patch.object(registry_helper, "_capture_context", return_value=("http://s", "tok")), \
                    patch.object(registry_helper, "_claim", return_value=True), \
                    patch.object(registry_helper.helper, "busy", return_value=False), \
                    patch.object(registry_helper.helper, "begin",
                                 side_effect=lambda *a, **kw: began.append((a, kw)) or (True, "")):
                task = asyncio.create_task(registry_helper.schedule_loop())
                await asyncio.sleep(0.05)
                task.cancel()
                with self.assertRaises(asyncio.CancelledError):
                    await task

        asyncio.run(one_tick())
        self.assertEqual(began[0], ((None,), {"mode": "auto", "ctx": ("http://s", "tok")}))

    def test_helper_stops_when_the_server_address_changes(self) -> None:
        ctl = helper_mod.HelperController()
        ctl._base, ctl._token = "http://old:8010", "tok"
        with patch.object(helper_mod.shared_connection, "token", return_value="tok"), \
                patch.object(helper_mod.shared_connection, "base_url", return_value="http://new:8010"):
            with self.assertRaises(helper_mod._Abort):
                ctl._call("GET", "/api/asset-registry/helper/projects")


if __name__ == "__main__":
    unittest.main()

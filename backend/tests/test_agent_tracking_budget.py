"""추적 확인은 **몇 건**이 아니라 **얼마 동안**으로 자른다.

★왜(2026-09-12): `_poll_active_jobs` 가 한 번에 고정 8건만 확인했다. 이 함수는 롱폴
 사이클당 1회(약 25초)만 돌기 때문에, 잡이 64건이면 한 바퀴에 `ceil(64/8) × 25초 ≈ 200초`.
 의도한 확인 간격(`_DIRECT_CHECK_INTERVAL_SECONDS = 30초`)을 지킬 수 없었다.
 개별 조회 timeout 도 120초라, 8건이 모두 timeout 이면 한 패스가 16분 걸릴 수 있었다.

★실측(CLI 1.1.24, 정상 네트워크 n=20): `generate get` p50 **452ms** · p95 471ms · 최대 522ms.
 같은 10초 예산이면 정상 상황에서 20건 넘게 본다.

★예산은 **새 확인을 시작할지**만 가른다. 진행 중인 확인을 중간에 버리지 않는다 —
 확정 보고를 끊으면 카드가 어중간한 상태로 남는다(코덱스 조건).

시계는 가짜로 두되 판정·스케줄은 제품 코드 그대로 돈다. CLI 호출만 경계에서 가로챈다.
"""

from __future__ import annotations

import os
import unittest
from unittest.mock import patch

from test_agent_contracts import _load_agent


class FakeClock:
    """monotonic 대체 — CLI 호출이 '걸린 시간' 만큼 직접 흐르게 한다."""

    def __init__(self, start: float = 10_000.0):
        self.now = start

    def __call__(self) -> float:
        return self.now

    def advance(self, seconds: float) -> None:
        self.now += seconds


class TrackingBudgetTests(unittest.TestCase):
    def setUp(self):
        self.agent = _load_agent()
        self.clock = FakeClock()
        self.calls: list[tuple[str, float | None]] = []
        self.finished_at: dict[str, float] = {}

    def _tracked(self, n: int, *, due_from: float = 0.0) -> dict:
        """기한이 이미 지난 추적 잡 n 건. next_direct_check 가 이를수록 먼저 봐야 한다."""
        return {
            f"job-{i:03d}": {
                "rid": f"rid-{i:03d}",
                "job_id": f"job-{i:03d}",
                "expected_image_inputs": 0,
                "provider_status": "queued",
                "check_failures": 0,
                "next_direct_check": due_from + i,  # 오름차순 = 오래 밀린 순
                "deadline": self.clock.now + 3600,
            }
            for i in range(n)
        }

    def _run(self, active, *, get_seconds=0.45, status="queued", ack_seconds=0.0):
        """제품 `_poll_active_jobs` 를 태운다. CLI·서버 호출만 가짜로 두고 시간을 흐르게 한다."""

        def fake_cli(cli, *args, **kwargs):
            self.calls.append((args[2] if len(args) > 2 else "", kwargs.get("timeout")))
            self.clock.advance(get_seconds)
            job_id = args[2]
            self.finished_at[job_id] = self.clock.now  # 확인이 끝난 시각
            return {"id": job_id, "status": status, "job_type": "m", "params": {}}, None

        def fake_reconcile(*a, **k):
            self.clock.advance(ack_seconds)
            return 200, {}

        with (
            patch.object(self.agent.time, "monotonic", self.clock),
            patch.object(self.agent, "_run_cli_json", side_effect=fake_cli),
            patch.object(self.agent, "_report_reconcile", side_effect=fake_reconcile),
            patch.object(self.agent, "_tracked_save", return_value=None),
            patch.object(self.agent, "_tracked_remove", return_value=None),
        ):
            return self.agent._poll_active_jobs(
                "http://server", "tok", "hf", active, "me@example.com"
            )

    # ── 예산이 자른다 ────────────────────────────────────────────────────
    def test_far_more_than_eight_jobs_are_checked_in_one_pass(self):
        """★이 시험이 이 파일의 이유다 — 종전 고정 8건이면 여기서 걸린다."""
        self._run(self._tracked(64), get_seconds=0.45)
        self.assertGreater(len(self.calls), 8)
        # 10초 예산 ÷ 0.45초 ≈ 22건(마지막 한 건은 남은 시간 검사에서 잘린다)
        self.assertGreaterEqual(len(self.calls), 20)

    def test_a_slow_network_checks_fewer_jobs_but_still_stops_on_time(self):
        """조회가 느리면 건수는 줄되 패스가 끝없이 늘어지지 않는다."""
        started = self.clock.now
        self._run(self._tracked(64), get_seconds=3.0)
        self.assertLessEqual(len(self.calls), 4)  # 10초 ÷ 3초
        self.assertLess(self.clock.now - started, 15.0)

    def test_a_slow_server_ack_also_spends_the_budget(self):
        """★서버 ACK 대기도 예산에 들어간다 — 조회만 세면 패스가 두 배로 늘어진다."""
        self._run(self._tracked(64), get_seconds=0.45, ack_seconds=1.5)
        self.assertLessEqual(len(self.calls), 6)  # 10초 ÷ (0.45+1.5)

    def test_a_started_check_always_gets_a_usable_timeout(self):
        """★계약: 예산은 **새 조회를 시작할지**만 가르고, 시작한 조회엔 정상 timeout 을 준다.

        남은 예산으로 timeout 을 자르면 그 조회는 **끝낼 수 없는 시간**만 받고 실패한다
        (코덱스 재현: 남은 1.0~1.2초 구간에서 1.2초짜리 응답이 매번 timeout, 성공 0회).
        종전 120초가 문제였던 것은 상한이 없어서지, 짧을수록 좋아서가 아니다.
        """
        self._run(self._tracked(64), get_seconds=0.45)
        timeouts = [t for _, t in self.calls]
        self.assertTrue(timeouts)
        self.assertTrue(all(t == self.agent._DIRECT_CHECK_TIMEOUT_SECONDS for t in timeouts))
        self.assertLess(self.agent._DIRECT_CHECK_TIMEOUT_SECONDS, 120)  # 종전 값보다는 짧다

    def test_a_sliver_of_budget_does_not_start_another_check(self):
        """끝자락 수십 ms 로 새 조회를 시작하면 인위적인 timeout 만 만든다."""
        self._run(self._tracked(64), get_seconds=9.5)
        self.assertEqual(len(self.calls), 1)  # 남은 0.5초로는 시작하지 않는다

    # ── 못 본 잡을 망가뜨리지 않는다 ──────────────────────────────────────
    def test_jobs_left_unchecked_keep_their_schedule_untouched(self):
        """★예산이 없어 '확인 못 한 것' 을 '확인했는데 실패한 것' 으로 만들면 안 된다.

        `check_failures` 를 올리거나 `next_direct_check` 를 미루면 다음 패스가 그 잡을
        더 늦게 본다 — 밀린 잡일수록 더 밀리는 기아가 된다.
        """
        active = self._tracked(64)
        before = {
            job_id: (t["check_failures"], t["next_direct_check"]) for job_id, t in active.items()
        }
        self._run(active, get_seconds=0.45)
        checked = {job_id for job_id, _ in self.calls}
        untouched = [j for j in active if j not in checked]
        self.assertTrue(untouched)
        for job_id in untouched:
            self.assertEqual(
                (active[job_id]["check_failures"], active[job_id]["next_direct_check"]),
                before[job_id],
                job_id,
            )

    def test_the_longest_waiting_jobs_go_first(self):
        """기한이 이른 순서가 유지돼야 다음 패스가 이어서 볼 수 있다."""
        self._run(self._tracked(64), get_seconds=0.45)
        seen = [job_id for job_id, _ in self.calls]
        self.assertEqual(seen, sorted(seen))  # job-000, job-001, ... 순서

    def test_a_second_pass_continues_where_the_first_stopped(self):
        """★한 패스로 다 못 봐도 다음 패스가 같은 순서로 이어 본다(공정성)."""
        active = self._tracked(64)
        self._run(active, get_seconds=0.45)
        first = [job_id for job_id, _ in self.calls]
        self.calls.clear()
        self._run(active, get_seconds=0.45)
        second = [job_id for job_id, _ in self.calls]
        self.assertEqual(second[0], sorted(set(active) - set(first))[0])  # 멈춘 바로 다음부터
        self.assertFalse(set(first) & set(second))  # 같은 잡을 두 번 보지 않는다

    def test_two_hundred_fifty_six_jobs_do_not_starve_the_tail(self):
        """`_MAX_IN_FLIGHT_JOBS` 는 환경설정으로 256 까지 간다 — **끝쪽까지 실제로 본다.**

        4패스만 돌리면 앞 88건만 보고 끝나 '끝쪽이 굶는다' 를 못 잡는다(코덱스 지적).
        한 바퀴가 돌 만큼 충분히 반복하고, 마지막 잡까지 확인됐는지 본다.
        """
        active = self._tracked(256)
        seen: list[str] = []
        for _ in range(14):  # 패스당 약 20건 → 256건을 덮고도 남는다
            self.calls.clear()
            self._run(active, get_seconds=0.45)
            seen.extend(job_id for job_id, _ in self.calls)
            self.clock.advance(25)  # 패스 사이 롱폴 — 다음 확인 기한이 다시 온다
        self.assertEqual(len(set(seen)), 256)  # ★끝쪽까지 전부 확인됐다
        self.assertIn("job-255", seen)

    # ── 기존 계약 보존 ──────────────────────────────────────────────────
    def test_jobs_not_yet_due_are_skipped(self):
        """예산이 남아도 기한 전 잡은 보지 않는다(간격 계약)."""
        active = self._tracked(4, due_from=self.clock.now + 100)
        self._run(active, get_seconds=0.45)
        self.assertEqual(self.calls, [])

    def test_a_checked_job_is_pushed_by_the_configured_interval(self):
        """★확인한 잡은 **정해진 간격만큼** 뒤로 밀린다.

        `>= 지금−1` 같은 느슨한 검사는 **간격을 0 으로 바꿔도 통과한다**(코덱스 지적).
        확인이 끝난 시각을 기준으로 실제 간격을 잰다.
        """
        active = self._tracked(3)
        self._run(active, get_seconds=0.45)
        interval = self.agent._DIRECT_CHECK_INTERVAL_SECONDS
        self.assertEqual(len(self.finished_at), 3)
        for job_id, tracked in active.items():
            self.assertAlmostEqual(
                tracked["next_direct_check"] - self.finished_at[job_id], interval, places=6, msg=job_id
            )

    def test_nothing_active_costs_nothing(self):
        self.assertEqual(self._run({}), 0)
        self.assertEqual(self.calls, [])


class TrackingPassBudgetTests(unittest.TestCase):
    """한 패스의 **직접 확인 + 재조정**이 하나의 예산을 나눠 쓴다.

    ★왜(코덱스 지적): 두 루프가 각자 예산을 새로 가지면 패스 전체는 제한되지 않는다.
     그리고 직접 확인에 예산을 **전부** 주면 활성 잡이 많을 때 재조정이 0회가 된다
     (코덱스 재현: 활성 64건이 계속 queued 인 10패스에서 직접 190회·재조정 0회).
    """

    def setUp(self):
        self.agent = _load_agent()
        self.clock = FakeClock()
        self.tracked_calls: list[str] = []
        self.reconcile_calls: list[str] = []

    def _active(self, n: int) -> dict:
        return {
            f"job-{i:03d}": {
                "rid": f"rid-{i:03d}",
                "job_id": f"job-{i:03d}",
                "expected_image_inputs": 0,
                "provider_status": "queued",
                "check_failures": 0,
                "next_direct_check": float(i),
                "deadline": self.clock.now + 3600,
            }
            for i in range(n)
        }

    def _pass(self, active, cands, *, track_seconds=2.0, reconcile_seconds=0.45):
        def fake_run_cli(cli, *args, **kwargs):  # 직접 확인
            self.tracked_calls.append(args[2])
            self.clock.advance(track_seconds)
            return {"id": args[2], "status": "queued", "params": {}}, None

        def fake_cli_json(cli, *args, **kwargs):  # 재조정 조회
            self.reconcile_calls.append(args[2])
            self.clock.advance(reconcile_seconds)
            return {"id": args[2], "status": "queued"}

        with (
            patch.object(self.agent.time, "monotonic", self.clock),
            patch.object(self.agent, "_cycle_account_email", return_value="me@example.com"),
            patch.object(self.agent, "_runtime_active", return_value=active),
            patch.object(self.agent, "_run_cli_json", side_effect=fake_run_cli),
            patch.object(self.agent, "_report_reconcile", return_value=(200, {})),
            patch.object(self.agent, "_tracked_save", return_value=None),
            patch.object(self.agent, "_tracked_remove", return_value=None),
            patch.object(self.agent, "recovery_probe_pass", return_value=0),
            patch.object(self.agent, "replay_outbox", return_value=None),
            patch.object(
                self.agent, "_list_reconcile_candidates", return_value=(200, {"candidates": cands})
            ),
            patch.object(self.agent, "_cli_json", side_effect=fake_cli_json),
        ):
            started = self.clock.now
            self.agent.tracking_pass("http://server", "tok", "hf")
            return self.clock.now - started

    @staticmethod
    def _cands(n: int) -> list[dict]:
        return [{"rid": f"r-{i}", "job_id": f"cand-{i:03d}"} for i in range(n)]

    def test_the_whole_pass_stays_inside_one_budget(self):
        """★두 루프가 각자 예산을 새로 가지면 패스가 두 배로 늘어진다."""
        elapsed = self._pass(self._active(64), self._cands(50))
        self.assertLess(elapsed, self.agent._TRACK_PASS_BUDGET_SECONDS + 3.0)

    def test_reconcile_is_never_starved_by_direct_checks(self):
        """★활성 잡이 아무리 많아도 재조정이 0회가 되면 안 된다."""
        self._pass(self._active(64), self._cands(50))
        self.assertGreater(len(self.reconcile_calls), 0)
        self.assertGreater(len(self.tracked_calls), 0)

    def test_direct_checks_do_not_take_the_whole_budget(self):
        """직접 확인은 예산의 일부만 쓴다 — 나머지는 재조정 몫이다."""
        self._pass(self._active(64), self._cands(50), track_seconds=0.45)
        share = self.agent._DIRECT_CHECK_BUDGET_SHARE
        budget = self.agent._TRACK_PASS_BUDGET_SECONDS
        self.assertLessEqual(len(self.tracked_calls) * 0.45, budget * share + 0.5)
        self.assertGreater(len(self.reconcile_calls), 1)

    def test_repeated_passes_eventually_reach_every_candidate(self):
        """★조회 성공이 곧 완료는 아니다 — 앞쪽이 계속 queued 여도 뒤쪽을 봐야 한다.

        코덱스 재현: 후보 30건·4패스에서 뒤 10건이 **0회**였다.
        """
        active = self._active(64)
        cands = self._cands(30)
        for _ in range(8):
            self._pass(active, cands, track_seconds=0.45)
            self.clock.advance(25)  # 패스 사이 롱폴
        self.assertEqual(len(set(self.reconcile_calls)), 30)


class PassEntryWorkBudgetTests(unittest.TestCase):
    """패스 **진입부 작업**도 같은 예산을 나눠 쓴다.

    ★왜(코덱스 지적): `_poll_active_jobs` 만 막으면 패스 전체는 제한되지 않는다.
     `replay_outbox`·`recovery_probe_pass`·후보 조회 HTTP 가 예산 밖이면
     "패스가 제한된다" 는 말이 성립하지 않는다.

    ★계약: 예산은 **새 호출을 시작할지**만 가른다. 시작한 호출은 정상 timeout 을 온전히 받는다.
    ★예외: 재조정과 **복구 조사** 모두 '후보 조회와 첫 1건' 은 예산이 없어도 한다 — 그게
     없으면 '한 패스 최소 1건' 보장이 무력해져 그 경로가 영영 0회가 된다.
     복구 조사는 2026-09-13 에 이 예외를 받았다(그전엔 진입부에서 통째로 돌아갔고, 그것이
     앞 단계가 예산을 넘길 때 복구를 영구히 굶기는 회귀였다 — 코덱스 재현).
    """

    def setUp(self):
        self.agent = _load_agent()
        self.clock = FakeClock()
        self.anchored: list[str] = []

    def _outbox(self, n):
        return [{"rid": f"rid-{i:03d}", "job_id": f"job-{i:03d}"} for i in range(n)]

    def _replay(self, items, *, budget_end, anchor_seconds=0.5, ok=True):
        removed: list[str] = []

        def fake_anchor(server, token, rid, job_id, verifying=False):
            self.anchored.append(rid)
            self.clock.advance(anchor_seconds)
            return ok

        with (
            patch.object(self.agent.time, "monotonic", self.clock),
            patch.object(self.agent, "_outbox_load", return_value=items),
            patch.object(self.agent, "_anchor", side_effect=fake_anchor),
            patch.object(self.agent, "_outbox_remove", side_effect=lambda s, a, rid: removed.append(rid)),
        ):
            self.agent.replay_outbox("http://server", "tok", "me@example.com", budget_end)
        return removed

    def test_outbox_replay_stops_on_the_budget_and_keeps_the_rest(self):
        """★남은 것은 outbox 에 그대로 둔다 — 원래 '못 보낸 것을 보관해 다음에 재시도' 하는 구조다."""
        removed = self._replay(self._outbox(40), budget_end=self.clock.now + 3.0)
        self.assertGreater(len(self.anchored), 0)
        self.assertLess(len(self.anchored), 40)          # 다 보내지 않았다
        self.assertEqual(len(removed), len(self.anchored))  # 보낸 것만 지웠다

    def test_outbox_replay_sends_everything_when_there_is_time(self):
        removed = self._replay(self._outbox(5), budget_end=self.clock.now + 60.0)
        self.assertEqual(len(self.anchored), 5)
        self.assertEqual(len(removed), 5)

    def test_an_unsent_anchor_is_not_removed_from_the_outbox(self):
        """전송 실패는 보관한다(기존 계약) — 예산 때문에 안 보낸 것도 마찬가지다."""
        removed = self._replay(self._outbox(3), budget_end=self.clock.now + 60.0, ok=False)
        self.assertEqual(self.anchored, ["rid-000", "rid-001", "rid-002"])
        self.assertEqual(removed, [])

    def test_no_budget_replays_nothing(self):
        removed = self._replay(self._outbox(10), budget_end=self.clock.now - 1.0)
        self.assertEqual(self.anchored, [])
        self.assertEqual(removed, [])

    def test_recovery_probe_still_tries_one_without_budget(self):
        """★예산이 없어도 **후보 조회와 첫 1건의 시도**는 한다.

        종전엔 진입부에서 통째로 돌아갔고(`return 0`), 그게 **회귀**였다 — 직접 확인의 조회
        하나가 15초를 받으므로(`_DIRECT_CHECK_TIMEOUT_SECONDS` > 패스 예산 10초) 복구 차례엔
        예산이 이미 끝나 있는 일이 있고, 그러면 이 경로가 **매 패스 통째로** 건너뛰어진다.
        코덱스 재현(활성 64건·조회 15초·4패스): 예산 도입 전 앵커 1건 → 도입 후 **0건**.
        재조정도 같은 이유로 '후보 조회와 첫 1건' 예외를 이미 갖고 있다.
        """
        listed = {"n": 0}
        anchored: list[str] = []

        def fake_list(server, token):
            listed["n"] += 1
            return 200, {
                "requests": [
                    {"id": "r1", "recovery_probe_status": "unique", "recovery_probe_job_id": "job-1"},
                    {"id": "r2", "recovery_probe_status": "unique", "recovery_probe_job_id": "job-2"},
                ]
            }

        def fake_anchor(server, token, rid, job_id, verifying=False):
            anchored.append(rid)
            return True

        self.agent._RECOVERY_CURSOR.clear()
        with (
            patch.object(self.agent.time, "monotonic", self.clock),
            patch.object(self.agent, "_list_recovery_probes", side_effect=fake_list),
            patch.object(self.agent, "_anchor", side_effect=fake_anchor),
        ):
            self.assertEqual(
                self.agent.recovery_probe_pass("http://s", "tok", "hf", self.clock.now - 1.0), 1
            )
        self.assertEqual(listed["n"], 1)  # 후보 조회는 한다
        self.assertEqual(anchored, ["r1"])  # 딱 **한 건만** — 둘째는 예산에서 막힌다

    def test_reconcile_still_fetches_candidates_without_budget(self):
        """★진입부를 전부 막으면 '최소 1건' 보장이 무력해진다 — 후보 조회는 해야 한다."""
        listed = {"n": 0}
        looked = []

        def fake_candidates(server, token):
            listed["n"] += 1
            return 200, {"candidates": [{"rid": "r1", "job_id": "job-1"}]}

        def fake_cli(cli, *args, **kwargs):
            looked.append(args[2])
            return {"id": args[2], "status": "completed"}

        with (
            patch.object(self.agent.time, "monotonic", self.clock),
            patch.object(self.agent, "_cycle_account_email", return_value="me@example.com"),
            patch.object(self.agent, "replay_outbox", return_value=None),
            patch.object(self.agent, "_list_reconcile_candidates", side_effect=fake_candidates),
            patch.object(self.agent, "_cli_json", side_effect=fake_cli),
            patch.object(self.agent, "_report_reconcile", return_value=(200, {"applied": True})),
        ):
            self.agent.reconcile_pass(
                "http://s", "tok", "hf", "me@example.com", budget_end=self.clock.now - 1.0
            )
        self.assertEqual(listed["n"], 1)
        self.assertEqual(looked, ["job-1"])  # 최소 1건 보장이 살아 있다


class WholePassSharesOneBudgetTests(unittest.TestCase):
    """★진입부 작업까지 **하나의 예산**을 나눠 쓴다 — 계약 ③ 의 마지막 조건.

    위 `TrackingPassBudgetTests` 는 `replay_outbox`·`recovery_probe_pass` 를 **가짜로 두고**
    직접 확인과 재조정만 쟀다. 그래서 "tracking_pass 가 진입부에도 예산을 넘기는가" 는 안 봤다.
    여기서는 그 둘을 **실제로 돌려** 패스 전체 시간을 잰다.
    """

    def setUp(self):
        self.agent = _load_agent()
        self.clock = FakeClock()
        self.anchored: list[str] = []
        self.probed = 0
        self.reconciled: list[str] = []

    def _pass(self, *, outbox=100, anchor_seconds=0.4, probe_seconds=0.4, cands=30):
        def fake_anchor(server, token, rid, job_id, verifying=False):
            self.anchored.append(rid)
            self.clock.advance(anchor_seconds)
            return True

        def fake_probe_list(server, token):
            self.probed += 1
            self.clock.advance(probe_seconds)  # 느린 HTTP 한 번
            return 200, {"requests": []}

        def fake_cli_json(cli, *args, **kwargs):
            self.reconciled.append(args[2])
            self.clock.advance(0.45)
            return {"id": args[2], "status": "queued"}

        items = [{"rid": f"o-{i:03d}", "job_id": f"job-{i:03d}"} for i in range(outbox)]
        candidates = [{"rid": f"r-{i}", "job_id": f"cand-{i:03d}"} for i in range(cands)]

        with (
            patch.object(self.agent.time, "monotonic", self.clock),
            patch.object(self.agent, "_cycle_account_email", return_value="me@example.com"),
            patch.object(self.agent, "_runtime_active", return_value={}),
            patch.object(self.agent, "_outbox_load", return_value=items),
            patch.object(self.agent, "_anchor", side_effect=fake_anchor),
            patch.object(self.agent, "_outbox_remove", return_value=None),
            patch.object(self.agent, "_list_recovery_probes", side_effect=fake_probe_list),
            patch.object(
                self.agent,
                "_list_reconcile_candidates",
                return_value=(200, {"candidates": candidates}),
            ),
            patch.object(self.agent, "_cli_json", side_effect=fake_cli_json),
            patch.object(self.agent, "_report_reconcile", return_value=(200, {"applied": True})),
        ):
            started = self.clock.now
            self.agent.tracking_pass("http://server", "tok", "hf")
            return self.clock.now - started

    def test_slow_entry_work_does_not_stretch_the_pass(self):
        """★이 시험이 이 클래스의 이유다 — outbox 100건 × 0.4초 = **40초**어치 일이 앞에 있다.

        예산이 진입부까지 닿지 않으면 패스가 그 40초를 그대로 쓴다.
        """
        elapsed = self._pass()
        self.assertLess(
            elapsed,
            self.agent._TRACK_PASS_BUDGET_SECONDS + 3.0,
            f"패스가 {elapsed:.1f}초 — 진입부가 예산 밖이다",
        )
        self.assertGreater(len(self.anchored), 0)          # 일은 했다
        self.assertLess(len(self.anchored), 100)           # 다 하지는 않았다

    def test_entry_work_eating_the_budget_still_leaves_one_reconcile(self):
        """★진입부가 예산을 다 써도 재조정 바닥(최소 1건)은 남아야 한다."""
        self._pass()
        self.assertGreaterEqual(len(self.reconciled), 1)

    def test_a_quiet_entry_leaves_the_budget_to_the_rest(self):
        """할 일이 없으면 진입부는 예산을 쓰지 않는다 — 재조정이 여러 건을 본다."""
        self._pass(outbox=0, probe_seconds=0.05)
        self.assertEqual(self.anchored, [])
        self.assertGreater(len(self.reconciled), 5)

    def test_the_three_paths_get_one_shared_deadline(self):
        """전달 계약: 직접 확인은 **더 이른** 시한을, 복구와 재조정은 **같은** 시한을 받는다."""
        seen: dict[str, float | None] = {}

        def grab_poll(server, token, cli, active, email, budget_end=None):
            seen["direct"] = budget_end
            return 0

        def grab_probe(server, token, cli, budget_end=None, account_email=None):
            seen["recovery"] = budget_end
            seen["recovery_email"] = account_email
            return 0

        def grab_reconcile(server, token, cli, email=None, skip_job_ids=None, budget_end=None):
            seen["reconcile"] = budget_end

        with (
            patch.object(self.agent.time, "monotonic", self.clock),
            patch.object(self.agent, "_cycle_account_email", return_value="me@example.com"),
            patch.object(self.agent, "_runtime_active", return_value={"job-1": {}}),
            patch.object(self.agent, "_poll_active_jobs", side_effect=grab_poll),
            patch.object(self.agent, "recovery_probe_pass", side_effect=grab_probe),
            patch.object(self.agent, "reconcile_pass", side_effect=grab_reconcile),
        ):
            started = self.clock.now
            self.agent.tracking_pass("http://server", "tok", "hf")

        # ★복구 조사도 **이미 얻은 계정**을 받는다 — 커서를 (서버, 계정)으로 나누려고 거기서
        #  다시 `_cycle_account_email` 을 부르면 패스마다 CLI 호출이 하나 늘어난다.
        self.assertEqual(seen["recovery_email"], "me@example.com")
        self.assertEqual(
            set(seen), {"direct", "recovery", "recovery_email", "reconcile"}
        )
        for name in ("direct", "recovery", "reconcile"):
            self.assertIsNotNone(seen[name], f"{name} 가 예산을 못 받았다")
        # 복구와 재조정은 같은 패스 시한을 본다
        self.assertEqual(seen["recovery"], seen["reconcile"])
        # 직접 확인은 그보다 이르다 — 나머지가 재조정 몫이다
        self.assertLess(seen["direct"], seen["reconcile"])
        budget = self.agent._TRACK_PASS_BUDGET_SECONDS
        self.assertAlmostEqual(seen["reconcile"] - started, budget, places=6)
        self.assertAlmostEqual(
            seen["direct"] - started, budget * self.agent._DIRECT_CHECK_BUDGET_SHARE, places=6
        )


class ReconcileBackoffTests(unittest.TestCase):
    """서버가 준 '확인중' 후보를 백오프 없이 매 사이클 전량 재조회하던 것.

    ★왜: 후보 목록은 서버가 **매 사이클 같은 것**(오래된 순 최대 200건)을 준다.
     조회가 실패해도 기록이 없어 다음 사이클에 또 같은 잡을 부른다.
    """

    SERVER = "http://server"
    ACCOUNT = "me@example.com"

    def setUp(self):
        self.agent = _load_agent()
        self.clock = FakeClock()
        self.looked_up: list[str] = []
        self.timeouts: list[float] = []

    def _retries(self, server=None, account=None) -> dict:
        scope = self.agent._reconcile_scope(server or self.SERVER, account or self.ACCOUNT)
        return self.agent._RECONCILE_RETRY.get(scope, {})

    def _run(
        self,
        candidates,
        *,
        found=True,
        get_seconds=0.45,
        budget_end=None,
        server=None,
        account=None,
    ):
        def fake_cli(cli, *args, **kwargs):
            self.looked_up.append(args[2])
            self.timeouts.append(kwargs.get("timeout"))
            self.clock.advance(get_seconds)
            return {"id": args[2], "status": "completed"} if found else None

        with (
            patch.object(self.agent.time, "monotonic", self.clock),
            patch.object(self.agent, "_cycle_account_email", return_value=account or self.ACCOUNT),
            patch.object(self.agent, "replay_outbox", return_value=None),
            patch.object(
                self.agent,
                "_list_reconcile_candidates",
                return_value=(200, {"candidates": candidates}),
            ),
            patch.object(self.agent, "_cli_json", side_effect=fake_cli),
            patch.object(
                self.agent,
                "_report_reconcile",
                return_value=(200, {"applied": True, "status": "done"}),
            ),
        ):
            self.agent.reconcile_pass(
                server or self.SERVER,
                "tok",
                "hf",
                account or self.ACCOUNT,
                budget_end=budget_end,
            )

    @staticmethod
    def _cands(n: int) -> list[dict]:
        return [{"rid": f"rid-{i:03d}", "job_id": f"job-{i:03d}"} for i in range(n)]

    # ── 백오프 ──────────────────────────────────────────────────────────
    def test_a_failed_lookup_is_not_retried_next_cycle(self):
        """★이 시험이 이 클래스의 이유다 — 종전엔 매 사이클 같은 잡을 다시 불렀다."""
        cands = self._cands(1)
        self._run(cands, found=False)
        self.assertEqual(self.looked_up, ["job-000"])
        self.looked_up.clear()
        self.clock.advance(5)  # 백오프(최소 60초)보다 짧게
        self._run(cands, found=False)
        self.assertEqual(self.looked_up, [])

    def test_the_backoff_expires_and_the_job_is_tried_again(self):
        cands = self._cands(1)
        self._run(cands, found=False)
        self.looked_up.clear()
        self.clock.advance(self.agent._RECONCILE_RETRY_BASE_SECONDS + 1)
        self._run(cands, found=False)
        self.assertEqual(self.looked_up, ["job-000"])

    def test_repeated_failures_back_off_further_but_stay_capped(self):
        """★상한을 **예약된 그 시점에** 잰다 — 시계를 먼저 돌리면 상한 위반을 못 잡는다."""
        cands = self._cands(1)
        delays: list[float] = []
        failures = 0
        for _ in range(8):
            before = self.clock.now
            self._run(cands, found=False)
            retry_at, failures, _seen = self._retries()["job-000"]
            delays.append(retry_at - before)  # 시계를 돌리기 **전에** 잰다
            self.clock.advance(self.agent._RECONCILE_RETRY_MAX_SECONDS + 1)
        self.assertEqual(failures, 8)
        self.assertGreater(delays[1], delays[0])  # 늘어난다
        self.assertLessEqual(max(delays), self.agent._RECONCILE_RETRY_MAX_SECONDS + 1)

    def test_a_successful_lookup_clears_the_record(self):
        cands = self._cands(1)
        self._run(cands, found=False)
        self.assertIn("job-000", self._retries())
        self.clock.advance(self.agent._RECONCILE_RETRY_BASE_SECONDS + 1)
        self._run(cands, found=True)
        self.assertNotIn("job-000", self._retries())

    # ── 범위 분리 ───────────────────────────────────────────────────────
    def test_another_account_does_not_wipe_my_backoff(self):
        """★job_id 단독 전역 키면 다른 계정 후보를 한 번 처리하는 것만으로 백오프가 날아간다."""
        cands = self._cands(1)
        self._run(cands, found=False)
        self.assertIn("job-000", self._retries())
        self._run(self._cands(1), found=False, account="other@example.com")
        self.assertIn("job-000", self._retries())  # 내 기록은 그대로
        self.looked_up.clear()
        self.clock.advance(5)
        self._run(cands, found=False)
        self.assertEqual(self.looked_up, [])  # 여전히 백오프 중

    def test_an_empty_candidate_list_does_not_wipe_records(self):
        """후보가 잠깐 비는 것과 '그 잡이 사라진 것' 은 다르다."""
        cands = self._cands(1)
        self._run(cands, found=False)
        self._run([], found=False)
        self.assertIn("job-000", self._retries())

    def test_a_truncated_list_does_not_wipe_records_immediately(self):
        """서버 응답은 최대 200건이라 잘려 있을 수 있다 — 안 보인다고 바로 지우면 안 된다."""
        self._run(self._cands(3), found=False)
        self.assertEqual(len(self._retries()), 3)
        self._run([{"rid": "rid-000", "job_id": "job-000"}], found=False)
        self.assertEqual(len(self._retries()), 3)  # 아직 살아 있다

    def test_records_expire_after_a_long_absence(self):
        """그래도 영원히 들고 있지는 않는다."""
        self._run(self._cands(3), found=False)
        self.clock.advance(self.agent._RECONCILE_RETRY_TTL_SECONDS + 1)
        self._run([{"rid": "rid-000", "job_id": "job-000"}], found=False)
        self.assertEqual(set(self._retries()), {"job-000"})

    # ── 공정성 ──────────────────────────────────────────────────────────
    def test_the_next_pass_starts_after_where_the_last_one_stopped(self):
        """★서버는 매번 같은 순서로 준다 — 앞에서만 보면 뒤쪽은 영영 0회다."""
        cands = self._cands(30)
        self._run(cands, get_seconds=0.45)
        first = list(self.looked_up)
        self.looked_up.clear()
        self._run(cands, get_seconds=0.45)
        second = list(self.looked_up)
        self.assertTrue(first and second)
        self.assertNotEqual(first[0], second[0])
        self.assertEqual(second[0], cands[len(first)]["job_id"])

    def test_every_candidate_is_eventually_checked(self):
        cands = self._cands(60)
        seen: set[str] = set()
        for _ in range(8):
            self.looked_up.clear()
            self._run(cands, get_seconds=0.45)
            seen.update(self.looked_up)
            self.clock.advance(1)
        self.assertEqual(len(seen), 60)

    # ── 예산 ────────────────────────────────────────────────────────────
    def test_the_budget_stops_the_sweep(self):
        self._run(self._cands(200), get_seconds=0.45)
        self.assertLess(len(self.looked_up), 200)
        self.assertGreater(len(self.looked_up), 8)

    def test_candidates_left_unchecked_get_no_backoff(self):
        """예산이 없어 못 본 것은 '실패' 가 아니다."""
        self._run(self._cands(200), get_seconds=0.45)
        unchecked = [f"job-{i:03d}" for i in range(200) if f"job-{i:03d}" not in self.looked_up]
        self.assertTrue(unchecked)
        for job_id in unchecked:
            self.assertNotIn(job_id, self._retries())

    def test_at_least_one_candidate_is_checked_even_with_no_budget(self):
        """★예산을 직접 확인이 다 써도 재조정이 영영 0회가 되면 안 된다."""
        self._run(self._cands(50), budget_end=self.clock.now - 1.0)
        self.assertEqual(len(self.looked_up), 1)
        self.assertGreater(self.timeouts[0], 0)  # 음수 timeout 을 넘기지 않는다

    def test_the_forced_check_gets_a_usable_timeout_not_a_sliver(self):
        """★예산이 없을 때의 강제 1건에 남은 시간(≈0)을 주면 **매번 timeout** 나고 실패만 쌓인다.

        코덱스 재현: 40패스에서 재조정 시도 5번 전부 timeout=1초, 성공 0회, 실패 수만 5까지.
        가짜 CLI 가 **주어진 timeout 을 실제로 지키게** 해야 이 함정이 드러난다.
        """
        work_seconds = 1.2  # 정상 응답에 걸리는 시간 — 1초 timeout 이면 못 끝낸다

        def honest_cli(cli, *args, **kwargs):
            allowed = kwargs.get("timeout") or 0
            self.looked_up.append(args[2])
            self.timeouts.append(allowed)
            if allowed < work_seconds:
                self.clock.advance(allowed)
                return None  # timeout — 응답 없음
            self.clock.advance(work_seconds)
            return {"id": args[2], "status": "completed"}

        with (
            patch.object(self.agent.time, "monotonic", self.clock),
            patch.object(self.agent, "_cycle_account_email", return_value=self.ACCOUNT),
            patch.object(self.agent, "replay_outbox", return_value=None),
            patch.object(
                self.agent,
                "_list_reconcile_candidates",
                return_value=(200, {"candidates": self._cands(5)}),
            ),
            patch.object(self.agent, "_cli_json", side_effect=honest_cli),
            patch.object(
                self.agent, "_report_reconcile", return_value=(200, {"applied": True, "status": "done"})
            ),
        ):
            self.agent.reconcile_pass(
                self.SERVER, "tok", "hf", self.ACCOUNT, budget_end=self.clock.now - 1.0
            )
        self.assertEqual(len(self.looked_up), 1)
        self.assertGreaterEqual(self.timeouts[0], work_seconds)  # 실제로 끝낼 수 있는 시간
        self.assertEqual(self._retries(), {})  # 성공했으니 실패 기록이 없다

    def test_a_started_lookup_gets_a_usable_timeout_at_every_budget_boundary(self):
        """★경계 전체를 본다. 만료된 예산만 고치면 **1초 ≤ 남은 예산 < 작업시간** 구간이 남는다.

        코덱스 재현: 남은 1.0초·1.1초에서 1.2초짜리 응답이 매번 timeout, 성공 0회.
        계약은 '예산은 시작 여부만 가르고, 시작한 조회엔 정상 timeout' 이다.
        """
        work_seconds = 1.2

        def honest_cli(cli, *args, **kwargs):
            allowed = kwargs.get("timeout") or 0
            self.timeouts.append(allowed)
            if allowed < work_seconds:
                self.clock.advance(allowed)
                return None
            self.clock.advance(work_seconds)
            return {"id": args[2], "status": "completed"}

        for remaining in (-1.0, 0.99, 1.0, 1.1, 1.3, 5.0):
            with self.subTest(remaining=remaining):
                self.agent = _load_agent()  # 백오프 기록을 매번 새로
                self.timeouts.clear()
                with (
                    patch.object(self.agent.time, "monotonic", self.clock),
                    patch.object(self.agent, "_cycle_account_email", return_value=self.ACCOUNT),
                    patch.object(self.agent, "replay_outbox", return_value=None),
                    patch.object(
                        self.agent,
                        "_list_reconcile_candidates",
                        return_value=(200, {"candidates": self._cands(1)}),
                    ),
                    patch.object(self.agent, "_cli_json", side_effect=honest_cli),
                    patch.object(
                        self.agent,
                        "_report_reconcile",
                        return_value=(200, {"applied": True, "status": "done"}),
                    ),
                ):
                    self.agent.reconcile_pass(
                        self.SERVER, "tok", "hf", self.ACCOUNT,
                        budget_end=self.clock.now + remaining,
                    )
                self.assertEqual(len(self.timeouts), 1, remaining)
                self.assertGreaterEqual(self.timeouts[0], work_seconds, remaining)
                self.assertEqual(self._retries(), {}, remaining)  # 매번 성공한다

    def test_duplicate_job_ids_do_not_trap_the_cursor(self):
        """★후보는 **요청 단위**라 같은 job_id 가 둘일 수 있다.

        커서를 job_id 로 기억하면 회전이 첫 번째 위치만 찾아 두 요청 사이를 오가고,
        뒤쪽 후보는 영영 안 본다(코덱스 재현: A/J → B/J → B/J → ... K 는 0회).
        """
        cands = [
            {"rid": "req-A", "job_id": "job-J"},
            {"rid": "req-B", "job_id": "job-J"},  # 같은 잡, 다른 요청
            {"rid": "req-C", "job_id": "job-K"},
        ]
        seen: list[str] = []
        for _ in range(4):
            self.looked_up.clear()
            # 패스당 한 건만 보도록 예산을 바닥으로 준다(강제 1건 경로)
            self._run(cands, budget_end=self.clock.now - 1.0, get_seconds=0.45)
            seen.extend(self.looked_up)
        self.assertIn("job-K", seen)  # 뒤쪽 후보도 돌아온다

    def test_an_empty_candidate_list_still_expires_old_records(self):
        """★빈 목록에서 그냥 반환하면 후보가 없는 동안 기록이 **영원히** 남는다."""
        self._run(self._cands(1), found=False)
        self.assertIn("job-000", self._retries())
        self.clock.advance(self.agent._RECONCILE_RETRY_TTL_SECONDS + 1)
        self._run([], found=False)
        self.assertEqual(self._retries(), {})

    def test_the_cap_is_applied_after_this_pass_adds_records(self):
        """★추가 **전에만** 자르면 실패가 쌓인 패스가 상한을 넘긴 채 끝난다(코덱스 재현: 512 → 532).

        서버 후보 한도는 200건이라, 후보를 상한만큼 만드는 대신 **기존 기록 512 + 새 후보 20**
        으로 실제 회귀 조건을 만든다.
        """
        cap = self.agent._RECONCILE_RETRY_MAX_ENTRIES
        scope = self.agent._reconcile_scope(self.SERVER, self.ACCOUNT)
        now = self.clock.now
        self.agent._RECONCILE_RETRY[scope] = {
            f"old-{i:04d}": (now, 1, now) for i in range(cap)  # 방금 본 기존 기록 512개
        }
        fresh = [{"rid": f"new-rid-{i}", "job_id": f"new-{i:03d}"} for i in range(20)]
        self._run(fresh, found=False, get_seconds=0.45)
        retries = self._retries()
        self.assertEqual(len(retries), cap)  # 넘기지 않는다
        for i in range(20):  # 새 실패 기록은 보존된다(오래된 것부터 밀려난다)
            self.assertIn(f"new-{i:03d}", retries)

    def test_every_lookup_timeout_is_bounded(self):
        self._run(self._cands(20), get_seconds=0.45)
        self.assertLessEqual(max(self.timeouts), self.agent._DIRECT_CHECK_TIMEOUT_SECONDS)
        self.assertTrue(all(t > 0 for t in self.timeouts))

    def test_the_smallest_allowed_budget_still_checks_something(self):
        """★env 로 예산을 **허용 최소값까지 낮춰도** 조회가 멈추면 안 된다.

        하한이 최소 슬라이스와 같으면(둘 다 1초) 시각을 읽는 순간 남은 시간이 이미 1초
        미만이라 **한 건도 못 본다**(코덱스 재현: 5패스 전부 0회). 기본값만 보면 이 함정을
        못 잡으므로, env 를 최소값으로 두고 **다시 불러** 실제로 태운다.
        """
        with patch.dict(os.environ, {"MVHUB_CLI_TRACK_BUDGET": "1"}):
            self.agent = _load_agent()
        self.assertGreater(
            self.agent._DIRECT_CHECK_BUDGET_SECONDS, self.agent._DIRECT_CHECK_MIN_SLICE_SECONDS
        )
        self._run(
            self._cands(5),
            budget_end=self.clock.now + self.agent._DIRECT_CHECK_BUDGET_SECONDS,
            get_seconds=0.45,
        )
        self.assertGreaterEqual(len(self.looked_up), 2)


if __name__ == "__main__":
    unittest.main()

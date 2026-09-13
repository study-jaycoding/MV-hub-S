"""복구 조사(`recovery_probe_pass`)의 예산·진행 보장 계약 (2026-09-13).

★왜 이 파일이 생겼나: 패스 예산(`a73a5007`)을 넣으면서 이 경로에는 **진입부 가드만** 뒀다.
 그러면 앞 단계(직접 확인)가 예산을 넘겨 돌아올 때 복구가 **매 패스 통째로 건너뛰어진다** —
 `_DIRECT_CHECK_TIMEOUT_SECONDS`(15초)가 패스 예산(10초)보다 크므로 실제로 일어난다.
 코덱스 재현(활성 64건·조회 15초·4패스): 예산 도입 전 앵커 1건 → 도입 후 **0건**.

★그래서 계약이 셋이다.
 1. 예산이 없어도 **후보 조회 + 첫 1건의 처리 시도**는 한다(진행 보장).
 2. '첫 1건' 은 성공이 아니라 **시도**다 — 성공만 세면 서버 장애 때 16건을 전부 강제 보고한다.
 3. 처리 순서는 **회전 순서 그대로**이고, 커서는 **시도** 기준으로 옮긴다 — 안 그러면 서버가
    매 패스 같은 앞부분을 주므로(`ORDER BY updated_at`, 결과 기록은 그 값을 안 바꾼다)
    뒤쪽 요청이 영영 조사되지 않는다.

가짜는 **시계와 외부 호출**(후보 조회·CLI 목록·보고·앵커), 그리고 **지문 판정 함수**다 —
지문 대조 자체는 `test_agent_contracts.py` 가 맡고 여기서는 예산·순서만 본다. 다만 대조에
**걸리는 시간**은 예산 계약의 대상이라 가짜에서도 시계를 흘린다.
예산 계산·처리 순서·커서·보장 판단은 제품 코드가 그대로 돈다.
"""

from __future__ import annotations

import unittest
from unittest.mock import patch

from test_agent_contracts import _load_agent
from test_agent_tracking_budget import FakeClock


class RecoveryProbeHarness:
    """제품 `recovery_probe_pass` 를 돌리고 **외부 호출만** 가로챈다.

    각 가짜는 시계를 그만큼 흘려, 예산 판정이 실제와 같은 조건에서 일어나게 한다.
    """

    def __init__(
        self,
        agent,
        clock: FakeClock,
        requests: list[dict],
        *,
        jobs: list[dict] | None = None,
        candidates_seconds: float = 0.0,
        list_seconds: float = 0.0,
        report_seconds: float = 0.0,
        anchor_seconds: float = 0.0,
        report_ok: bool = True,
        anchor_ok: bool = True,
        jobs_ok: bool = True,
        match_seconds: float = 0.0,
        list_raises: BaseException | None = None,
    ):
        self.agent = agent
        self.clock = clock
        self.requests = requests
        self.jobs = jobs if jobs is not None else []
        self.candidates_seconds = candidates_seconds
        self.list_seconds = list_seconds
        self.report_seconds = report_seconds
        self.anchor_seconds = anchor_seconds
        self.report_ok = report_ok
        self.anchor_ok = anchor_ok
        self.jobs_ok = jobs_ok
        self.match_seconds = match_seconds  # 지문 대조에도 시간이 든다(루프 top ~ 보고 사이)
        self.list_raises = list_raises  # CLI **시작** 예외 — `_run_cli_json` 이 안 잡는 종류
        # 관측 기록 — 무엇을 **언제 시작**했나
        self.candidate_fetches = 0
        self.list_calls: list[float] = []
        self.list_timeouts: list[int] = []
        self.reports: list[tuple[str, str, float]] = []  # (rid, outcome, 시작 시각)
        self.anchors: list[tuple[str, str, float]] = []  # (rid, job_id, 시작 시각)

    # -- 가짜 외부 호출 -------------------------------------------------------
    def _list_recovery_probes(self, server, token):
        self.candidate_fetches += 1
        self.clock.advance(self.candidates_seconds)
        return 200, {"requests": [dict(r) for r in self.requests]}

    def _read_generate_json(self, cli, *args, timeout=None):
        self.list_calls.append(self.clock.now)
        self.list_timeouts.append(timeout)
        if self.list_raises is not None:
            raise self.list_raises
        self.clock.advance(self.list_seconds)
        return list(self.jobs) if self.jobs_ok else None

    def _matches(self, request, job):
        # 요청의 `want` 와 같은 id 의 잡만 후보로 본다 — 지문 대조 **자체**는 이 시험의 대상이
        # 아니다(그래서 판정 함수를 가로챈다). 다만 **걸리는 시간**은 예산 계약의 대상이다.
        self.clock.advance(self.match_seconds)
        return job.get("id") == request.get("want")

    def _report(self, server, token, rid, outcome, count, job_id):
        started = self.clock.now
        self.clock.advance(self.report_seconds)
        self.reports.append((rid, outcome, started))
        if not self.report_ok:
            return None
        return {"outcome": outcome, "candidate_count": count, "job_id": job_id}

    def _anchor(self, server, token, rid, job_id, verifying=False):
        started = self.clock.now
        self.clock.advance(self.anchor_seconds)
        self.anchors.append((rid, str(job_id), started))
        return self.anchor_ok

    # -- 실행 ----------------------------------------------------------------
    def run(
        self,
        budget_end: float | None,
        account_email: str | None = "me@example.com",
        server: str = "http://s",
    ) -> int:
        agent = self.agent
        with (
            patch.object(agent.time, "monotonic", self.clock),
            patch.object(agent, "_list_recovery_probes", side_effect=self._list_recovery_probes),
            patch.object(agent, "_read_generate_json", side_effect=self._read_generate_json),
            patch.object(agent, "_matches_submission_fingerprint", side_effect=self._matches),
            patch.object(agent, "_report_recovery_probe", side_effect=self._report),
            patch.object(agent, "_anchor", side_effect=self._anchor),
        ):
            return agent.recovery_probe_pass(
                server, "tok", "hf", budget_end, account_email
            )


def _unique(rid: str, job_id: str) -> dict:
    """이미 조사가 끝나 job_id 를 서버에 저장해 둔 요청 — CLI 없이 앵커만 다시 보낸다."""
    return {"id": rid, "recovery_probe_status": "unique", "recovery_probe_job_id": job_id}


def _pending(rid: str, want: str | None = None) -> dict:
    """아직 조사하지 않은 요청 — CLI 목록을 봐야 판정할 수 있다."""
    return {"id": rid, "want": want, "submission_started_at": None}


class RecoveryProbeBudgetTests(unittest.TestCase):
    def setUp(self):
        self.agent = _load_agent()
        self.agent._RECOVERY_CURSOR.clear()
        self.clock = FakeClock()

    # -- 1. 예산이 남았을 때: 시작한 만큼만 -----------------------------------

    def test_budget_cuts_the_anchor_run(self):
        """예산 10초·앵커 2초면 **5건**을 시작하고 멈춘다 — 시작 시각 0·2·4·6·8."""
        h = RecoveryProbeHarness(
            self.agent,
            self.clock,
            [_unique(f"r{i:02d}", f"job-{i:02d}") for i in range(16)],
            anchor_seconds=2.0,
        )
        started = self.clock.now
        self.assertEqual(h.run(started + 10.0), 5)
        self.assertEqual([rid for rid, _, _ in h.anchors], [f"r{i:02d}" for i in range(5)])
        self.assertEqual([at - started for _, _, at in h.anchors], [0.0, 2.0, 4.0, 6.0, 8.0])

    def test_none_budget_processes_everything(self):
        """`budget_end=None` 은 종전처럼 **무제한**이다 — 이 호환을 깨면 단독 호출이 잘린다."""
        h = RecoveryProbeHarness(
            self.agent,
            self.clock,
            [_unique(f"r{i:02d}", f"job-{i:02d}") for i in range(16)],
            anchor_seconds=2.0,
        )
        self.assertEqual(h.run(None), 16)
        self.assertEqual(len(h.anchors), 16)

    # -- 2. 진행 보장: 예산이 없어도 첫 1건 -----------------------------------

    def test_expired_budget_still_fetches_candidates_and_tries_one(self):
        """★회귀 방지의 핵심. 예산이 이미 끝나도 후보 조회 + 첫 1건은 한다."""
        h = RecoveryProbeHarness(
            self.agent,
            self.clock,
            [_unique("r1", "job-1"), _unique("r2", "job-2")],
            anchor_seconds=2.0,
        )
        self.assertEqual(h.run(self.clock.now - 1.0), 1)
        self.assertEqual(h.candidate_fetches, 1)
        self.assertEqual([rid for rid, _, _ in h.anchors], ["r1"])

    def test_slow_candidate_fetch_does_not_eat_the_guaranteed_try(self):
        """후보 조회가 느려도 **첫 1건**은 보장된다.

        ★코덱스 반례: 최소 몫을 '2초' 같은 시간으로 주면, 후보 조회가 1.2초를 먹는 순간
         남은 0.8초가 `_budget_allows` 의 최소 슬라이스(1초) 미만이라 **한 건도 못 한다**.
         그래서 보장을 시간이 아니라 **'첫 1건의 시도'** 로 뒀다.
        """
        h = RecoveryProbeHarness(
            self.agent,
            self.clock,
            [_unique("r1", "job-1"), _unique("r2", "job-2")],
            candidates_seconds=1.2,
            anchor_seconds=0.5,
        )
        self.assertEqual(h.run(self.clock.now + 1.0), 1)
        self.assertEqual([rid for rid, _, _ in h.anchors], ["r1"])

    def test_expired_budget_does_not_start_the_cli_for_the_second_request(self):
        """보장은 **첫 1건까지**다 — 둘째가 미조사여도 CLI 목록을 새로 시작하지 않는다."""
        h = RecoveryProbeHarness(
            self.agent,
            self.clock,
            [_unique("r1", "job-1"), _pending("r2", want="job-2")],
            jobs=[{"id": "job-2"}],
            anchor_seconds=0.5,
        )
        self.assertEqual(h.run(self.clock.now - 1.0), 1)
        self.assertEqual(h.list_calls, [])  # CLI 를 아예 안 불렀다

    # -- 3. 필수 보고 예외는 '시도 1회' ---------------------------------------

    def test_cli_list_eating_the_budget_still_reports_once(self):
        """CLI 목록이 예산을 다 먹어도 **보고 1회**는 한다 — 안 그러면 그 120초가 매번 헛돈다."""
        h = RecoveryProbeHarness(
            self.agent,
            self.clock,
            [_pending("r1"), _pending("r2"), _pending("r3")],
            jobs=[{"id": "other"}],
            list_seconds=12.0,
            report_seconds=1.0,
        )
        self.assertEqual(h.run(self.clock.now + 10.0), 0)
        self.assertEqual(len(h.list_calls), 1)  # 목록은 패스당 한 번
        self.assertEqual([rid for rid, _, _ in h.reports], ["r1"])  # 딱 한 건만 강제

    def test_a_failed_report_still_consumes_the_exception(self):
        """★보고가 **실패해도** 예외는 소비된다.

        성공만 세면 서버 장애 때 16건 전부를 강제 보고한다 — 단순 합산 CLI 120초 + 16x60초.
        """
        h = RecoveryProbeHarness(
            self.agent,
            self.clock,
            [_pending(f"r{i}") for i in range(5)],
            jobs=[{"id": "other"}],
            list_seconds=12.0,
            report_seconds=1.0,
            report_ok=False,
        )
        self.assertEqual(h.run(self.clock.now + 10.0), 0)
        self.assertEqual([rid for rid, _, _ in h.reports], ["r0"])

    def test_a_held_request_does_not_waste_the_cli_list(self):
        """★보장 2. CLI 목록을 산 직후의 요청이 '창 가득참' 으로 **보류**되면, 보고는 0건이다.

        보장이 '첫 1건의 시도' 뿐이면 그 보류가 시도 1건을 다 쓰고, 다음 요청은 예산에서 막혀
        **그 패스는 CLI 값(최대 120초)만 치르고 아무 결론도 못 남긴다**. 되돌려 확인에서 드러난
        구멍이다 — 목록을 샀으면 보고 1회는 보장한다.
        """
        jobs = [{"id": f"j{i}"} for i in range(99)] + [{"id": "job-1"}]  # 100건 = 창 포화
        h = RecoveryProbeHarness(
            self.agent,
            self.clock,
            [_pending("held"), _pending("r2", want="job-1")],
            jobs=jobs,
            list_seconds=12.0,
            report_seconds=1.0,
        )
        self.assertEqual(h.run(self.clock.now + 10.0), 0)
        self.assertEqual(len(h.list_calls), 1)
        # 보류된 'held' 는 보고가 없고, 그다음 r2 가 보고까지 간다
        self.assertEqual([(rid, outcome) for rid, outcome, _ in h.reports], [("r2", "unique")])

    def test_the_report_guarantee_does_not_license_saved_anchors(self):
        """★보장 2는 '첫 보고까지 가는 길' 이지 **앵커 허가가 아니다**.

        코덱스 재현: 목록을 산 뒤 첫 요청이 보류되면 `reported` 가 0으로 남는데, 그 뒤에
        저장된 unique 가 늘어서 있으면 **앵커가 전부 시작**됐다(15건 x 60초 = 912초).
        """
        saturated = [{"id": f"j{i}"} for i in range(100)]
        h = RecoveryProbeHarness(
            self.agent,
            self.clock,
            [_pending("held")] + [_unique(f"u{i}", f"job-{i}") for i in range(15)],
            jobs=saturated,
            list_seconds=12.0,
            anchor_seconds=60.0,
        )
        self.assertEqual(h.run(self.clock.now + 10.0), 0)
        self.assertEqual(h.anchors, [])  # 보류 뒤 앵커는 하나도 시작하지 않는다

    def test_fingerprint_matching_time_counts_before_a_new_report(self):
        """★루프 top 검사와 보고 사이의 **지문 대조**에도 시간이 흐른다(코덱스).

        "루프 top 한 곳이면 충분하다" 는 판단이 틀렸음을 못 박는다 — 새 HTTP 시작 직전에
        다시 봐야 예산 계약이 지켜진다. 첫 보고는 보장 2가 통과시키므로 여기 안 걸린다.
        """
        h = RecoveryProbeHarness(
            self.agent,
            self.clock,
            [_pending("r1"), _pending("r2")],
            jobs=[{"id": "other"}],
            match_seconds=6.0,
            report_seconds=1.0,
        )
        self.assertEqual(h.run(self.clock.now + 10.0), 0)
        self.assertEqual([rid for rid, _, _ in h.reports], ["r1"])

    def test_a_cli_start_exception_still_advances_the_cursor(self):
        """★CLI **시작** 예외는 `_run_cli_json` 이 안 잡는다 — 커서를 호출 **전에** 옮겨야 한다.

        `_run_cli_json` 이 잡는 것은 `TimeoutExpired` 뿐이다. 실행 파일이 없거나 권한이 없으면
        예외가 그대로 올라가는데, 커서를 호출 뒤에 옮기면 그 요청이 **매 패스 앞을 막는다**
        (코덱스 재현: 2패스에서 커서가 계속 빈 상태, 뒤의 unique 앵커 0회).
        """
        first = RecoveryProbeHarness(
            self.agent,
            self.clock,
            [_pending("r1"), _unique("u2", "job-2")],
            list_raises=FileNotFoundError("higgsfield"),
        )
        with self.assertRaises(FileNotFoundError):
            first.run(None)
        second = RecoveryProbeHarness(
            self.agent,
            self.clock,
            [_pending("r1"), _unique("u2", "job-2")],
            list_raises=FileNotFoundError("higgsfield"),
            anchor_seconds=0.5,
        )
        # 커서가 r1 을 지났으므로 u2 부터 본다 — CLI 를 다시 부르지 않고 앵커한다.
        # 예산은 앵커 한 건만 들어가게 좁힌다(회전이 한 바퀴 돌면 r1 을 또 만나 예외가 난다).
        self.assertEqual(second.run(self.clock.now + 1.0), 1)
        self.assertEqual([rid for rid, _, _ in second.anchors], ["u2"])
        self.assertEqual(second.list_calls, [])

    def test_anchor_is_deferred_when_the_budget_is_gone(self):
        """필수 보고 예외가 **앵커까지** 끌고 가지 않는다 — 그러면 한 패스가 60초를 더 쓴다."""
        h = RecoveryProbeHarness(
            self.agent,
            self.clock,
            [_pending("r1", want="job-1")],
            jobs=[{"id": "job-1"}],
            list_seconds=12.0,
            report_seconds=1.0,
        )
        self.assertEqual(h.run(self.clock.now + 10.0), 0)
        self.assertEqual([(rid, outcome) for rid, outcome, _ in h.reports], [("r1", "unique")])
        self.assertEqual(h.anchors, [])  # 보고는 했고 앵커는 다음 패스로

    def test_the_next_pass_anchors_the_saved_job_without_the_cli(self):
        """앵커를 미뤄도 손해가 없다 — 서버가 job_id 를 갖고 있어 다음 패스가 CLI 없이 앵커한다."""
        h = RecoveryProbeHarness(
            self.agent,
            self.clock,
            [_unique("r1", "job-1")],  # 앞 패스의 보고로 서버에 저장된 상태
            anchor_seconds=0.5,
        )
        self.assertEqual(h.run(self.clock.now + 10.0), 1)
        self.assertEqual(h.list_calls, [])
        self.assertEqual([(rid, job) for rid, job, _ in h.anchors], [("r1", "job-1")])

    # -- 4. 회전: 뒤쪽이 굶지 않는다 ------------------------------------------

    def test_rotation_reaches_every_request_across_passes(self):
        """앞 5건이 계속 `no_match` 여도 **다음 패스는 그 다음부터** 본다.

        서버는 매 패스 같은 16건을 같은 순서로 준다(`ORDER BY updated_at`, 조사 결과 기록은
        그 값을 **안 바꾼다**). 회전이 없으면 뒤 11건은 영영 조사되지 않는다.
        """
        requests = [_pending(f"r{i:02d}") for i in range(16)]
        seen: list[list[str]] = []
        for _ in range(4):
            h = RecoveryProbeHarness(
                self.agent, self.clock, requests, jobs=[{"id": "other"}], report_seconds=2.0
            )
            h.run(self.clock.now + 10.0)
            seen.append([rid for rid, _, _ in h.reports])
            self.clock.advance(25)  # 패스 사이 롱폴
        self.assertEqual([len(batch) for batch in seen], [5, 5, 5, 5])
        self.assertEqual(seen[0], [f"r{i:02d}" for i in range(5)])
        self.assertEqual(seen[1], [f"r{i:02d}" for i in range(5, 10)])
        self.assertEqual(seen[2], [f"r{i:02d}" for i in range(10, 15)])
        # 마지막 하나를 보고 처음으로 돌아온다 — 16건 전부가 4패스 안에 기회를 얻었다
        self.assertEqual(seen[3], ["r15", "r00", "r01", "r02", "r03"])
        self.assertEqual(sorted(set(sum(seen, []))), [f"r{i:02d}" for i in range(16)])

    def test_mixed_unique_and_pending_follow_rotation_order(self):
        """★코덱스 반례: 종류별로 나눠 처리하면 회전 커서를 둬도 미조사가 굶는다.

        후보가 [미조사 P, 저장된 U] 일 때 U 를 먼저 처리하면 P 는 늘 예산 밖으로 밀린다.
        처리 순서가 **목록 순서 그대로**여야 P 가 첫 기회를 받는다.
        """
        h = RecoveryProbeHarness(
            self.agent,
            self.clock,
            [_pending("P", want="job-p"), _unique("U", "job-u")],
            jobs=[{"id": "job-p"}],
            list_seconds=2.0,
            report_seconds=2.0,
            anchor_seconds=2.0,
        )
        # 예산 5초 = 목록 2 + 보고 2 뒤에 앵커를 시작할 1초가 딱 남는다. U 차례에는 남지 않는다.
        h.run(self.clock.now + 5.0)
        self.assertEqual([rid for rid, _, _ in h.reports], ["P"])  # 미조사가 먼저다
        self.assertEqual([rid for rid, _, _ in h.anchors], ["P"])
        # 다음 패스는 U 부터 — 커서가 P 에서 멈췄다
        h2 = RecoveryProbeHarness(
            self.agent, self.clock, [_pending("P", want="job-p"), _unique("U", "job-u")],
            jobs=[{"id": "job-p"}], anchor_seconds=0.5,
        )
        h2.run(self.clock.now + 10.0)
        self.assertEqual([rid for rid, _, _ in h2.anchors][0], "U")

    def test_a_held_request_advances_the_cursor_too(self):
        """'창 가득참' 보류도 **이 요청을 검토한 결과**다 — 커서를 안 옮기면 앞을 영영 막는다.

        관측 지점은 다음 패스의 **CLI 재구매**다. 커서가 보류를 건너뛰면 그다음이 저장된
        unique 라 CLI 없이 앵커만 하면 되는데, 안 옮기면 같은 보류를 또 조사하려고
        목록(최대 120초)을 **매 패스 다시 산다**.

        ★보류가 **둘 이상**이어야 이 줄이 검증된다(코덱스): 하나뿐이면 CLI 호출 직전에 찍는
        커서가 이미 그 요청을 기록해, 보류 지점의 갱신을 지워도 시험이 통과한다.
        """
        saturated = [{"id": f"j{i}"} for i in range(100)]
        requests = [_pending("h1"), _pending("h2"), _unique("u", "job-u")]
        first = RecoveryProbeHarness(
            self.agent, self.clock, requests, jobs=saturated, list_seconds=12.0
        )
        self.assertEqual(first.run(self.clock.now + 10.0), 0)
        self.assertEqual(first.reports, [])  # 둘 다 보류라 보고가 없다
        self.assertEqual(len(first.list_calls), 1)

        second = RecoveryProbeHarness(
            self.agent,
            self.clock,
            requests,
            jobs=saturated,
            list_seconds=12.0,
            anchor_seconds=0.5,
        )
        self.assertEqual(second.run(self.clock.now - 1.0), 1)
        self.assertEqual([rid for rid, _, _ in second.anchors], ["u"])
        self.assertEqual(second.list_calls, [])  # ★보류 둘을 건너뛰어 CLI 를 다시 안 산다

    def test_cli_list_failure_advances_the_cursor(self):
        """CLI 조회 실패도 **그 요청을 시도한 것**이다 — 안 그러면 같은 요청이 매 패스 앞을 막는다."""
        h = RecoveryProbeHarness(
            self.agent,
            self.clock,
            [_pending("r1"), _pending("r2")],
            jobs_ok=False,
            list_seconds=1.0,
        )
        self.assertEqual(h.run(self.clock.now + 10.0), 0)
        self.assertEqual(len(h.list_calls), 1)
        self.assertEqual(h.reports, [])
        # 다음 패스는 r2 부터 본다
        h2 = RecoveryProbeHarness(
            self.agent, self.clock, [_pending("r1"), _pending("r2")], jobs=[{"id": "other"}]
        )
        h2.run(self.clock.now + 10.0)
        self.assertEqual([rid for rid, _, _ in h2.reports][0], "r2")

    def test_the_cursor_is_split_by_server_and_account(self):
        """커서를 전역으로 두면 다른 계정·서버 한 번이 앞 자리를 지운다(재조정과 같은 규칙)."""
        requests = [_unique("r1", "job-1"), _unique("r2", "job-2")]

        def pass_once(**where) -> list[str]:
            h = RecoveryProbeHarness(self.agent, self.clock, requests, anchor_seconds=0.5)
            h.run(self.clock.now + 1.2, **where)
            return [rid for rid, _, _ in h.anchors]

        self.assertEqual(pass_once(account_email="a@x.com", server="http://s"), ["r1"])
        # 다른 **계정**, 다른 **서버** 는 각자 처음부터 본다
        self.assertEqual(pass_once(account_email="b@x.com", server="http://s"), ["r1"])
        self.assertEqual(pass_once(account_email="a@x.com", server="http://other"), ["r1"])
        # 원래 (서버, 계정) 의 자리는 그대로 남아 있다
        self.assertEqual(pass_once(account_email="a@x.com", server="http://s"), ["r2"])

    # -- 5. 시작한 호출은 정상 timeout 을 받는다 -------------------------------

    def test_a_started_cli_call_keeps_its_normal_timeout(self):
        """예산은 **시작할지**만 가른다 — 남은 시간으로 timeout 을 자르면 끝낼 수 없는 시간만 준다."""
        h = RecoveryProbeHarness(
            self.agent, self.clock, [_pending("r1")], jobs=[{"id": "other"}]
        )
        h.run(self.clock.now + 0.2)  # 예산이 사실상 없다
        self.assertEqual(h.list_timeouts, [120])


if __name__ == "__main__":
    unittest.main()

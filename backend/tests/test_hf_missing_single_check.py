"""원본 누락 정리에서 **같은 잡을 CLI 로 두 번 묻지 않는다.**

★왜(2026-09-12): 이 흐름은 두 단계다 — 로컬 생성물 확인, 그 다음 공유 서버가 준 후보 확인.
 두 목록이 겹치면 종전엔 `job_exists` 를 각각 불러 **CLI 프로세스를 두 번** 띄웠다
 (코덱스 재현: 겹침 32개 → 호출 64회). CLI 1회 기동은 실측 약 **470ms** 라
 겹침이 많을수록 그대로 지연이 된다.

가짜는 경계에만 둔다 — repo(DB)와 `cli_bridge.job_exists`(CLI 실행). 캐시·단일비행·
세마포어 같은 판정 로직은 제품 코드 그대로 돈다.
"""

from __future__ import annotations

import asyncio
from collections import Counter
from unittest import IsolatedAsyncioTestCase
from unittest.mock import patch


class SingleCheckPerJobTests(IsolatedAsyncioTestCase):
    def setUp(self):
        self.calls: Counter[str] = Counter()

    def _job_exists(self, outcomes: dict[str, bool | None], *, delay: float = 0.0):
        async def _fake(job_id: str, timeout: float = 30.0):
            self.calls[job_id] += 1
            if delay:
                await asyncio.sleep(delay)  # 동시 진입을 실제로 겹치게 한다
            return outcomes.get(job_id)

        return _fake

    async def _run(self, *, local, candidates, outcomes, delay=0.0):
        from app import repo
        from app.services import cli_bridge
        from app.usecases import hf_missing

        applied: list[list[dict]] = []
        with (
            patch.object(repo, "gens_with_job_id", return_value=local),
            patch.object(repo, "set_hf_missing_batch"),
            patch.object(repo, "delete_generation", return_value=True),
            patch.object(cli_bridge, "job_exists", new=self._job_exists(outcomes, delay=delay)),
        ):
            return await hf_missing.trash_missing_generations(
                "account-1",
                fetch_server_candidates=lambda: {"candidates": candidates},
                apply_server_results=lambda results: (
                    applied.append(results) or {"trashed": 0}
                ),
            ), applied

    async def test_a_job_shared_by_both_stages_is_asked_about_once(self):
        """★이 시험이 이 파일의 이유다."""
        out, _ = await self._run(
            local=[("gen-a", "job-1"), ("gen-b", "job-2")],
            candidates=[
                {"gen_id": "srv-a", "job_id": "job-1"},  # 로컬과 겹침
                {"gen_id": "srv-b", "job_id": "job-2"},  # 로컬과 겹침
                {"gen_id": "srv-c", "job_id": "job-3"},  # 서버만
            ],
            outcomes={"job-1": True, "job-2": False, "job-3": False},
        )
        self.assertEqual(dict(self.calls), {"job-1": 1, "job-2": 1, "job-3": 1})
        self.assertEqual(sum(self.calls.values()), 3)  # 종전엔 5회였다
        self.assertEqual(out["server_checked"], 3)

    async def test_an_unknown_result_is_reused_too_not_re_asked(self):
        """★None 도 '이미 물어봤다'이다. `dict.get()` 의 falsy 검사로 고치면 여기서 걸린다."""
        await self._run(
            local=[("gen-a", "job-x")],
            candidates=[{"gen_id": "srv-a", "job_id": "job-x"}],
            outcomes={"job-x": None},
        )
        self.assertEqual(self.calls["job-x"], 1)

    async def test_a_false_result_is_reused_too(self):
        """False 도 falsy 다 — None 과 같은 함정."""
        await self._run(
            local=[("gen-a", "job-y")],
            candidates=[{"gen_id": "srv-a", "job_id": "job-y"}],
            outcomes={"job-y": False},
        )
        self.assertEqual(self.calls["job-y"], 1)

    async def test_the_same_job_on_two_local_rows_is_asked_about_once(self):
        """한 잡이 여러 생성물에 붙어 있을 수 있다 — 같은 단계 안에서도 합쳐야 한다.

        두 호출이 **동시에** 출발하므로 단일비행이 없으면 둘 다 CLI 를 띄운다.
        """
        await self._run(
            local=[("gen-a", "job-dup"), ("gen-b", "job-dup"), ("gen-c", "job-dup")],
            candidates=[],
            outcomes={"job-dup": True},
            delay=0.02,
        )
        self.assertEqual(self.calls["job-dup"], 1)

    async def test_the_reused_answer_is_the_same_answer(self):
        """합치느라 답이 바뀌면 안 된다 — 서버 단계가 로컬과 같은 결론을 받는다."""
        _, applied = await self._run(
            local=[("gen-a", "job-1"), ("gen-b", "job-2")],
            candidates=[
                {"gen_id": "srv-a", "job_id": "job-1"},
                {"gen_id": "srv-b", "job_id": "job-2"},
            ],
            outcomes={"job-1": True, "job-2": False},
        )
        self.assertEqual(
            {r["job_id"]: r["exists"] for r in applied[0]},
            {"job-1": True, "job-2": False},
        )

    async def test_server_identifiers_are_passed_through_untouched(self):
        """확인 결과는 권한 증명이 아니다 — 서버가 준 gen_id 를 그대로 돌려보내 서버가 재검증한다."""
        _, applied = await self._run(
            local=[("gen-local", "job-1")],
            candidates=[{"gen_id": "srv-only-id", "job_id": "job-1"}],
            outcomes={"job-1": False},
        )
        self.assertEqual(applied[0], [{"gen_id": "srv-only-id", "job_id": "job-1", "exists": False}])

    async def test_unknown_results_are_not_sent_to_the_server(self):
        """확인불가는 서버 상태도 바꾸지 않는다(기존 계약 유지)."""
        _, applied = await self._run(
            local=[],
            candidates=[
                {"gen_id": "srv-a", "job_id": "job-none"},
                {"gen_id": "srv-b", "job_id": "job-gone"},
            ],
            outcomes={"job-none": None, "job-gone": False},
        )
        self.assertEqual([r["job_id"] for r in applied[0]], ["job-gone"])

    async def test_concurrency_is_still_capped(self):
        """합치기가 세마포어를 우회하면 CLI 프로세스가 한꺼번에 터진다."""
        peak = 0
        live = 0

        async def _fake(job_id: str, timeout: float = 30.0):
            nonlocal peak, live
            live += 1
            peak = max(peak, live)
            await asyncio.sleep(0.01)
            live -= 1
            return True

        from app import repo
        from app.services import cli_bridge
        from app.usecases import hf_missing

        with (
            patch.object(repo, "gens_with_job_id",
                         return_value=[(f"gen-{i}", f"job-{i}") for i in range(40)]),
            patch.object(repo, "set_hf_missing_batch"),
            patch.object(repo, "delete_generation", return_value=True),
            patch.object(cli_bridge, "job_exists", new=_fake),
        ):
            await hf_missing.trash_missing_generations("account-1")
        self.assertLessEqual(peak, 8)


if __name__ == "__main__":
    import unittest

    unittest.main()

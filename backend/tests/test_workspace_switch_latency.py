"""워크스페이스 전환이 응답을 CLI 동기화에 묶지 않는지, 반영 확인이 조회 실패를 성공으로 읽지 않는지.

배경(Jay 2026-09-11): 전환 한 번에 CLI 를 직렬로 세 번 쳐서 3.5~4초가 걸렸다. 실측으로
`workspace list` 0.7초, `generate list --size 100` 1.9초. 이 중 동기화는 전환이 끝나는 데
필요한 일이 아니라 응답 뒤로 뺐다. 이 파일은 그 계약을 못으로 박는다.
"""

from __future__ import annotations

import asyncio
import unittest
from unittest.mock import AsyncMock, Mock, patch

from fastapi import HTTPException

from app.routers import generation as gen_router
from app.services import syncer


WS = [
    {"id": "ws-b", "name": "뻘뻘뻘", "is_selected": True},
    {"id": "ws-c", "name": "R&D", "is_selected": False},
]


class WorkspaceSelectLatencyTests(unittest.TestCase):
    def test_select_schedules_sync_instead_of_awaiting_it(self):
        """★전환 응답이 `generate list`(실측 ≈1.9초) 를 기다리지 않는다."""
        request = Mock()
        request.state.account = None  # AUTH off — _require_house 통과

        with patch.object(
            gen_router.cli_bridge, "set_workspace", AsyncMock()
        ) as set_ws, patch.object(
            gen_router.cli_bridge, "list_workspaces", AsyncMock(return_value=WS)
        ), patch.object(
            gen_router.syncer.switch_sync, "schedule", AsyncMock()
        ) as schedule, patch.object(
            gen_router.syncer, "sync_now", AsyncMock()
        ) as sync_now:
            result = asyncio.run(
                gen_router.select_workspace(
                    gen_router.WorkspaceSelectIn(workspace_id="ws-b"), request
                )
            )

        set_ws.assert_awaited_once_with("ws-b")
        sync_now.assert_not_awaited()  # 요청 경로에서 직접 돌지 않는다
        schedule.assert_awaited_once_with(gen_router._schedule_switch_telemetry)
        self.assertEqual(result["workspaces"], WS)
        self.assertEqual(result["sync"], {"scheduled": 1})

    def test_unselect_also_schedules_sync(self):
        request = Mock()
        request.state.account = None
        personal = [{"id": "ws-p", "name": None, "is_selected": False}]

        with patch.object(
            gen_router.cli_bridge, "unset_workspace", AsyncMock()
        ), patch.object(
            gen_router.cli_bridge, "list_workspaces", AsyncMock(return_value=personal)
        ), patch.object(
            gen_router.syncer.switch_sync, "schedule", AsyncMock()
        ) as schedule, patch.object(
            gen_router.syncer, "sync_now", AsyncMock()
        ) as sync_now:
            result = asyncio.run(gen_router.unselect_workspace(request))

        sync_now.assert_not_awaited()
        schedule.assert_awaited_once()
        self.assertEqual(result["sync"], {"scheduled": 1})

    def test_telemetry_drain_is_scheduled_only_when_the_sync_marked_rows(self):
        """드레인 예약은 동기화 **뒤에** 걸린다 — 디바운스가 0.05초라 앞에 걸면 표시 전에 비운다."""
        with patch.object(gen_router._telemetry, "schedule_telemetry_drain") as drain:
            gen_router._schedule_switch_telemetry({"inserted": 0, "updated": 0})
            drain.assert_not_called()
            gen_router._schedule_switch_telemetry({"telemetry_pending": 2})
            drain.assert_called_once_with()


class VerifyWorkspaceStrictTests(unittest.TestCase):
    """★조회 실패가 '검증 통과'가 되던 구멍 — 해제(개인 복귀) 쪽만 열려 있었다.

    평소의 list_workspaces 는 CLI 실패를 빈 목록으로 삼킨다. 빈 목록에는 is_selected 가
    하나도 없으니 `any(...)` 가 False → '아무것도 선택 안 됨 = 해제 성공' 으로 읽혔다.
    실제로는 옛 공간을 그대로 물고 있는데 해제됐다고 답한 셈이다.
    """

    def test_unselect_verification_fails_loudly_when_the_cli_lookup_fails(self):
        with patch.object(
            gen_router.cli_bridge,
            "list_workspaces",
            AsyncMock(side_effect=gen_router.cli_bridge.CLIError("cli down")),
        ):
            with self.assertRaises(HTTPException) as caught:
                asyncio.run(gen_router._verify_workspace(None))

        self.assertEqual(caught.exception.status_code, 502)
        self.assertIn("확인할 수 없습니다", caught.exception.detail)

    def test_team_verification_also_fails_loudly(self):
        with patch.object(
            gen_router.cli_bridge,
            "list_workspaces",
            AsyncMock(side_effect=gen_router.cli_bridge.CLIError("cli down")),
        ):
            with self.assertRaises(HTTPException) as caught:
                asyncio.run(gen_router._verify_workspace("ws-b"))

        self.assertEqual(caught.exception.status_code, 502)

    def test_strict_wrapper_rejects_a_malformed_cli_answer(self):
        """★형식이 틀린 응답도 strict 에서는 오류다 — [] 로 바꾸면 '아무것도 선택 안 됨' 과
        구분되지 않아 해제 검증이 통과한다(코덱스 리뷰). 여기서는 래퍼를 실제로 통과시킨다."""
        for bad in ({"workspaces": []}, None, "oops"):
            with self.subTest(bad=bad):
                with patch.object(
                    gen_router.cli_bridge, "_run_json", AsyncMock(return_value=bad)
                ):
                    with self.assertRaises(gen_router.cli_bridge.CLIError):
                        asyncio.run(gen_router.cli_bridge.list_workspaces(strict=True))
                    # strict 가 아니면 종전처럼 관대하게 빈 목록
                    self.assertEqual(
                        asyncio.run(gen_router.cli_bridge.list_workspaces()), []
                    )

    def test_unselect_verification_rejects_a_malformed_answer_end_to_end(self):
        with patch.object(
            gen_router.cli_bridge, "_run_json", AsyncMock(return_value={"nope": 1})
        ):
            with self.assertRaises(HTTPException) as caught:
                asyncio.run(gen_router._verify_workspace(None))
        self.assertEqual(caught.exception.status_code, 502)

    def test_strict_list_still_returns_rows_when_the_cli_answers(self):
        with patch.object(
            gen_router.cli_bridge, "list_workspaces", AsyncMock(return_value=WS)
        ):
            rows = asyncio.run(gen_router._verify_workspace("ws-b"))
        self.assertEqual(rows, WS)


class SwitchSyncTests(unittest.TestCase):
    """배경 동기화 작업 — 합치기·알림·계정 범위·종료 회수.

    ★작업이 '끝난 것'을 이벤트로 기다린다. create_task 는 예약만 하므로, 곧바로 stop() 하면
     작업이 시작도 못 한 채 취소돼 아무것도 검증하지 못한다.
    """

    def test_concurrent_switches_merge_into_one_more_run(self):
        """빠른 연속 전환이 CLI 조회·DB 쓰기를 겹겹이 쌓지 않는다 — 한 번 더 도는 것으로 합친다."""
        worker = syncer.SwitchSync()
        worker.arm()
        calls: list[str] = []

        async def scenario():
            gate = asyncio.Event()      # 1회차를 붙잡아 그 사이 두 번 더 누르게 한다
            second_done = asyncio.Event()

            async def slow_sync(*_args, account_scope: str = "", **_kwargs):
                calls.append(account_scope)
                if len(calls) == 1:
                    await gate.wait()
                else:
                    second_done.set()
                return {"inserted": 0, "updated": 0}

            with patch.object(
                syncer, "sync_now", AsyncMock(side_effect=slow_sync)
            ), patch.object(
                syncer, "_capture_account_scope", side_effect=["a@x", "b@x", "c@x"]
            ):
                await worker.schedule()  # 1회차 시작 — gate 에서 멈춘다
                await asyncio.sleep(0)   # 작업이 실제로 시작해 gate 를 잡게 한다
                await worker.schedule()  # 진행 중 → 합류
                await worker.schedule()  # 또 합류 — 마지막 범위만 남는다
                gate.set()
                await second_done.wait()
                await worker.stop()

        asyncio.run(scenario())
        # 3번 눌렀지만 CLI 조회는 2번(진행 중 1 + 이어서 1), 그 2번째는 **마지막** 계정 범위로.
        self.assertEqual(calls, ["a@x", "c@x"])

    def test_synced_is_broadcast_even_when_a_newer_switch_already_happened(self):
        """★DB 에 들어간 변경 알림은 전환 순번으로 버리지 않는다.

        버리면 그 변경을 다시 읽을 계기가 사라진다 — 라이브러리 가시성은 선택 공간과 무관하므로
        나중에 어느 공간을 고르든 그 행들은 화면에 나와야 한다(코덱스 반례).
        """
        worker = syncer.SwitchSync()
        worker.arm()

        async def scenario():
            done = asyncio.Event()
            # ★완료 신호는 on_done 으로 받는다 — _run 에서 broadcast **뒤에** 불린다.
            #  sync_now 반환 시점에 신호를 주면 broadcast 전에 stop() 이 끼어들 수 있다.
            with patch.object(
                syncer, "sync_now", AsyncMock(return_value={"inserted": 3, "updated": 0})
            ), patch.object(
                syncer, "_capture_account_scope", return_value="a@x"
            ), patch.object(
                syncer.manager, "broadcast_all", AsyncMock()
            ) as broadcast:
                await worker.schedule(lambda _counts: done.set())
                await done.wait()
                await worker.stop()
                return broadcast

        broadcast = asyncio.run(scenario())
        broadcast.assert_awaited_once_with({"type": "synced"})

    def test_no_broadcast_when_nothing_changed(self):
        worker = syncer.SwitchSync()
        worker.arm()

        async def scenario():
            done = asyncio.Event()
            with patch.object(
                syncer, "sync_now", AsyncMock(return_value={"inserted": 0, "updated": 0})
            ), patch.object(
                syncer, "_capture_account_scope", return_value="a@x"
            ), patch.object(
                syncer.manager, "broadcast_all", AsyncMock()
            ) as broadcast:
                await worker.schedule(lambda _counts: done.set())
                await done.wait()
                await worker.stop()
                return broadcast

        broadcast = asyncio.run(scenario())
        broadcast.assert_not_awaited()

    def test_account_scope_is_captured_before_scheduling_not_inside_the_task(self):
        """★예약하는 쪽(요청)이 캡처해 넘긴다 — 실행 시점엔 계정이 바뀌었을 수 있다."""
        worker = syncer.SwitchSync()
        worker.arm()
        seen: list[str] = []

        async def scenario():
            done = asyncio.Event()

            async def record(*_args, account_scope: str = "", **_kwargs):
                seen.append(account_scope)
                done.set()
                return {"inserted": 0, "updated": 0}

            with patch.object(
                syncer, "sync_now", AsyncMock(side_effect=record)
            ), patch.object(
                syncer, "_capture_account_scope", side_effect=["요청시점@x", "나중에@x"]
            ):
                await worker.schedule()
                await done.wait()
                await worker.stop()

        asyncio.run(scenario())
        self.assertEqual(seen, ["요청시점@x"])

    def test_on_done_runs_after_the_sync_not_before(self):
        """텔레메트리 드레인 예약은 동기화가 끝난 뒤 그 카운트를 받아 걸린다."""
        worker = syncer.SwitchSync()
        worker.arm()
        order: list[str] = []

        async def scenario():
            done = asyncio.Event()

            async def counted(*_args, **_kwargs):
                order.append("sync")
                return {"inserted": 0, "updated": 0, "telemetry_pending": 2}

            def on_done(counts):
                order.append(f"on_done:{counts['telemetry_pending']}")
                done.set()

            with patch.object(
                syncer, "sync_now", AsyncMock(side_effect=counted)
            ), patch.object(
                syncer, "_capture_account_scope", return_value="a@x"
            ), patch.object(
                syncer.manager, "broadcast_all", AsyncMock()
            ):
                await worker.schedule(on_done)
                await done.wait()
                await worker.stop()

        asyncio.run(scenario())
        self.assertEqual(order, ["sync", "on_done:2"])

    def test_stop_during_the_account_capture_still_refuses_the_work(self):
        """★캡처를 기다리는 사이 stop() 이 끝나면, 회수된 뒤에 새 작업이 시작되면 안 된다.

        `_closing` 을 캡처 **전에만** 보면 이 순서로 빠져나간다(코덱스가 메모리 재현으로 확인).
        """
        worker = syncer.SwitchSync()
        worker.arm()

        async def scenario():
            released = asyncio.Event()   # 캡처가 시작됐다
            proceed = asyncio.Event()    # 그 사이 stop() 을 끝낸 뒤 캡처를 재개한다

            async def slow_capture(_fn):
                released.set()
                await proceed.wait()
                return "a@x"

            with patch.object(
                syncer, "sync_now", AsyncMock(return_value={"inserted": 0, "updated": 0})
            ) as sync_now, patch.object(
                syncer.asyncio, "to_thread", AsyncMock(side_effect=slow_capture)
            ):
                pending = asyncio.ensure_future(worker.schedule())
                await released.wait()
                await worker.stop()   # 캡처가 끝나기 전에 종료가 완료된다
                proceed.set()
                accepted = await pending
                await asyncio.sleep(0)
                return accepted, sync_now.await_count

        accepted, started = asyncio.run(scenario())
        self.assertFalse(accepted)  # 예약을 받지 않았다고 정직하게 답한다
        self.assertEqual(started, 0)

    def test_schedule_reports_whether_it_actually_took_the_work(self):
        """라우트가 `sync.scheduled` 에 그대로 싣는 값 — 안 받았는데 받았다고 답하지 않는다."""
        worker = syncer.SwitchSync()
        worker.arm()

        async def scenario():
            done = asyncio.Event()
            with patch.object(
                syncer, "sync_now", AsyncMock(return_value={"inserted": 0, "updated": 0})
            ), patch.object(syncer, "_capture_account_scope", return_value="a@x"):
                taken = await worker.schedule(lambda _counts: done.set())
                await done.wait()
                await worker.stop()
                refused = await worker.schedule()
                return taken, refused

        taken, refused = asyncio.run(scenario())
        self.assertTrue(taken)
        self.assertFalse(refused)

    def test_stop_refuses_new_work_until_armed_again(self):
        """종료 뒤에는 예약을 받지 않는다. arm 은 다음 lifespan 에서 다시 연다."""
        worker = syncer.SwitchSync()
        worker.arm()

        async def scenario():
            done = asyncio.Event()

            async def counted(*_args, **_kwargs):
                done.set()
                return {"inserted": 0, "updated": 0}

            with patch.object(
                syncer, "sync_now", AsyncMock(side_effect=counted)
            ) as sync_now, patch.object(
                syncer, "_capture_account_scope", return_value="a@x"
            ):
                await worker.stop()
                await worker.schedule()
                await asyncio.sleep(0)
                closed = sync_now.await_count
                worker.arm()
                await worker.schedule()
                await done.wait()
                await worker.stop()
                return closed, sync_now.await_count

        closed, after_arm = asyncio.run(scenario())
        self.assertEqual(closed, 0)
        self.assertEqual(after_arm, 1)


if __name__ == "__main__":
    unittest.main()

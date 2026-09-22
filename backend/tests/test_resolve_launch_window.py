"""앱이 Resolve 를 켜는 동안(켜기 창) 서버 전체가 Resolve API 를 부르지 않는다(Jay 2026-09-22 B안, Codex P1).

가짜는 바깥 경계에만 둔다 — 작업 목록(resolve_process_running), 검사·작업 자식 실행(subprocess.run·_probe_with),
Resolve.exe 켜기(os.startfile). 관문 자체는 제품 경로 그대로 지난다.
"""

from __future__ import annotations

import asyncio
import json
import os
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest import mock

from fastapi import HTTPException

from app.routers import assets, resolve_integration
from app.services import resolve_project_library as lib
from app.services import resolve_selection_monitor, resolve_status_runner as runner
from app.services import resolve_transfer
from app.services.resolve_project_open_worker import RESULT_PREFIX as OPEN_PREFIX
from app.services.resolve_selection_monitor import ResolveSelectionMonitor


def _completed(stdout: str = "") -> mock.Mock:
    return mock.Mock(stdout=stdout, stderr="", returncode=0)


class _WindowCase(unittest.TestCase):
    def setUp(self):
        runner.end_launch_window()
        self.addCleanup(runner.end_launch_window)
        runner._working_interpreter = None
        runner._last_selection = None

    def _started(self, seconds_ago: float) -> None:
        runner.begin_launch_window()
        runner._launch_started = time.monotonic() - seconds_ago


class LaunchWindowRunnerTests(_WindowCase):
    def test_status_during_window_is_starting_without_any_probe(self):
        runner.begin_launch_window()
        with (
            mock.patch.object(runner, "resolve_process_running", return_value=True),
            mock.patch.object(runner.subprocess, "run") as run,
        ):
            result = runner.resolve_connection_status_bounded()

        self.assertEqual(result["status"], "starting")
        self.assertEqual(result["message"], runner.LAUNCHING_MESSAGE)
        run.assert_not_called()

    def test_just_launched_resolve_not_yet_listed_is_still_starting(self):
        # 켠 직후엔 작업 목록에 아직 안 보일 수 있다 — 그 틈에 '꺼짐'이라 하지 않는다.
        self._started(seconds_ago=1)
        with mock.patch.object(runner, "resolve_process_running", return_value=False):
            result = runner.resolve_connection_status_bounded()

        self.assertEqual(result["status"], "starting")
        self.assertTrue(runner.launch_window_active())

    def test_resolve_that_died_while_booting_ends_the_window(self):
        self._started(seconds_ago=runner._LAUNCH_GRACE_SECONDS + 1)
        with mock.patch.object(runner, "resolve_process_running", return_value=False):
            result = runner.resolve_connection_status_bounded()

        self.assertEqual(result["status"], "not_running")
        self.assertFalse(runner.launch_window_active())

    def test_window_expires_by_itself(self):
        self._started(seconds_ago=runner.LAUNCH_WINDOW_SECONDS + 1)

        self.assertFalse(runner.launch_window_active())
        self.assertIsNone(runner._launch_started)

    def test_import_list_and_selection_monitor_do_not_touch_resolve_during_window(self):
        runner.begin_launch_window()
        with (
            mock.patch.object(runner, "resolve_process_running", return_value=True),
            mock.patch.object(runner.subprocess, "run") as run,
        ):
            imported = runner.run_resolve_import_isolated({"items": []})
            listed = runner.run_resolve_library_list_isolated()
            interpreter, failure = runner.resolve_compatible_interpreter()

        run.assert_not_called()
        self.assertEqual(imported["error_code"], "launching")
        self.assertEqual(listed, {"status": "failed", "error_code": "launching", "names": []})
        self.assertEqual((interpreter, failure), (None, runner.LAUNCHING_MESSAGE))

    def test_the_open_that_asked_for_the_launch_still_reaches_resolve(self):
        launch_id = runner.begin_launch_window()
        opened = {"status": "complete", "project_name": "Mud_Ai"}
        with (
            mock.patch.object(runner, "resolve_process_running", return_value=True),
            mock.patch.object(runner, "_probe_with", return_value=({"status": "ready"}, "")) as probe,
            mock.patch.object(runner, "_run_child", return_value=_completed(OPEN_PREFIX + json.dumps(opened) + "\n")),
        ):
            result = runner.run_resolve_project_open_isolated({"project_name": "Mud_Ai"}, launch_id=launch_id)

        self.assertEqual(result, opened)
        probe.assert_called()

    def test_other_opens_wait_while_someone_else_launches(self):
        # 다른 탭이 다른 카드를 눌러도 켜지는 Resolve 에 닿지 않는다 — 번호가 없거나 틀리면 기다린다(Codex P1).
        runner.begin_launch_window()
        with (
            mock.patch.object(runner, "resolve_process_running", return_value=True),
            mock.patch.object(runner.subprocess, "run") as run,
        ):
            for launch_id in ("", "someone-else"):
                with self.subTest(launch_id=launch_id):
                    result = runner.run_resolve_project_open_isolated({"project_name": "B"}, launch_id=launch_id)
                    self.assertEqual(result["error_code"], "launching")

        run.assert_not_called()

    def test_window_opens_only_after_a_probe_in_progress_finishes(self):
        # 이미 시작한 검사가 켜지는 Resolve 와 겹치지 않게 — 켜기는 검사와 같은 잠금으로 줄을 선다.
        runner._SELECT_LOCK.acquire()
        opener = threading.Thread(target=runner.begin_launch_window)
        try:
            opener.start()
            opener.join(timeout=0.3)
            self.assertTrue(opener.is_alive())
            self.assertFalse(runner.launch_window_active())
        finally:
            runner._SELECT_LOCK.release()
        opener.join(timeout=5)

        self.assertTrue(runner.launch_window_active())


class LaunchResolveWindowTests(_WindowCase):
    def _launch(self, running: bool = False, start_error: Exception | None = None):
        seen: list[bool] = []

        def start(_path):
            seen.append(runner.launch_window_active())
            if start_error:
                raise start_error

        with tempfile.NamedTemporaryFile(suffix=".exe", delete=False) as exe:
            executable = exe.name
        self.addCleanup(os.unlink, executable)
        with (
            mock.patch.object(lib, "resolve_process_running", return_value=running),
            mock.patch.object(lib, "_resolve_executable", return_value=executable),
            mock.patch.object(lib.os, "name", "nt"),
            mock.patch.object(lib.os, "startfile", create=True, side_effect=start),
        ):
            return lib.launch_resolve(), seen

    def test_window_is_open_before_resolve_starts(self):
        launched, seen = self._launch()

        self.assertEqual(launched["status"], "starting")
        self.assertEqual(launched["launch_id"], runner._launch_id)  # 켠 호출이 창의 번호를 받는다
        self.assertEqual(seen, [True])
        self.assertTrue(runner.launch_window_active())

    def test_failed_start_closes_the_window_and_says_so(self):
        with self.assertRaises(lib.ResolveProjectLibraryError) as raised:
            self._launch(start_error=OSError("denied"))

        self.assertEqual(raised.exception.code, "launch_failed")
        self.assertFalse(runner.launch_window_active())

    def test_running_resolve_opens_no_window(self):
        launched, seen = self._launch(running=True)

        self.assertEqual((launched, seen), ({"status": "running", "launch_id": ""}, []))
        self.assertFalse(runner.launch_window_active())

    def test_resolve_that_died_while_booting_can_be_started_again(self):
        self._started(seconds_ago=runner._LAUNCH_GRACE_SECONDS + 1)
        old_id = runner._launch_id
        launched, seen = self._launch()

        self.assertEqual((launched["status"], seen), ("starting", [True]))
        self.assertNotEqual(launched["launch_id"], old_id)

    def test_launch_route_reaps_the_selection_monitor_before_starting(self):
        # Resolve 가 막 꺼졌을 때 아직 살아 있던 감시 자식을 먼저 거둔다(Codex P1).
        paused: list[int] = []

        def launch():
            paused.append(resolve_selection_monitor.selection_monitor._pause_count)
            return {"status": "starting", "launch_id": "L1"}

        with (
            mock.patch.object(assets, "require_loopback_browser_request"),
            mock.patch.object(assets.resolve_project_library, "launch_resolve", side_effect=launch),
        ):
            result = asyncio.run(assets.launch_resolve_for_library(mock.Mock()))

        self.assertEqual(result, {"status": "starting", "launch_id": "L1"})
        self.assertEqual(paused, [1])


class SelectionMonitorWindowTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        runner.end_launch_window()
        self.addCleanup(runner.end_launch_window)

    async def test_monitor_stays_off_during_window_and_resumes_after(self):
        monitor = ResolveSelectionMonitor()
        runner.begin_launch_window()
        waits: list[float] = []

        async def sleep(delay):
            waits.append(delay)
            if len(waits) == 1:
                runner.end_launch_window()  # Resolve 가 준비됐다
            else:
                monitor._stopping = True

        launch = mock.AsyncMock(return_value=None)
        with (
            mock.patch.object(monitor, "_launch_process", launch),
            mock.patch.object(
                resolve_selection_monitor.manager, "stats", new=mock.AsyncMock(return_value={"connections": 1})
            ),
            mock.patch.object(resolve_selection_monitor.asyncio, "sleep", side_effect=sleep),
        ):
            await asyncio.wait_for(monitor._run(), 2)

        # 창 중엔 1초 쉬기만 했고 자식을 띄우지 않았다 → 창이 끝나자 한 번 띄우려 했다.
        self.assertEqual(waits[0], resolve_selection_monitor._CLIENT_CHECK_SECONDS)
        launch.assert_awaited_once()


class LaunchWindowRouteTests(_WindowCase):
    def _open(self, *, error: Exception | None = None, result: dict | None = None, launch_id: str = ""):
        body = assets.ResolveProjectOpenIn(project="뻘뻘뻘", dir="@davinci", name="Mud_Ai", launch_id=launch_id)
        with (
            mock.patch.object(assets, "require_loopback_browser_request"),
            mock.patch.object(assets, "_resolve_davinci_root", return_value=Path("Z:/x/@davinci")),
            mock.patch.object(
                assets.resolve_project_library, "open_disk_project", side_effect=error, return_value=result
            ) as self.open_project,
        ):
            try:
                return asyncio.run(assets.open_resolve_library_project(body, mock.Mock()))
            except HTTPException as exc:
                return exc

    def test_open_forwards_the_launch_number(self):
        self._open(result={"status": "complete"}, launch_id=" L1 ")

        self.assertEqual(self.open_project.call_args.args[-1], "L1")

    def test_resolve_answering_ends_the_window(self):
        answers = (
            {"result": {"status": "complete", "project_name": "Mud_Ai"}},
            {"error": lib.ResolveProjectLibraryError("저장 실패", code="save_failed")},
        )
        for answer in answers:
            with self.subTest(answer=answer):
                runner.begin_launch_window()
                self._open(**answer)
                self.assertFalse(runner.launch_window_active())

    def test_not_ready_busy_and_disk_failures_keep_the_window(self):
        for code in ("not_running", "api_unavailable", "manager_unavailable", "resolve_busy", "launching", ""):
            with self.subTest(code=code):
                runner.begin_launch_window()
                raised = self._open(error=lib.ResolveProjectLibraryError("아직", code=code))
                self.assertEqual(raised.status_code, 400 if code == "" else 503)
                self.assertTrue(runner.launch_window_active())

    def test_send_to_resolve_is_refused_while_launching(self):
        runner.begin_launch_window()
        calls = (
            lambda: resolve_integration.create_resolve_transfer(
                resolve_integration.ResolveTransferIn(gen_ids=["g"]), object()
            ),
            lambda: resolve_integration.retry_resolve_transfer(
                resolve_integration.ResolveRetryIn(project_id="p", transfer_id="t"), object()
            ),
        )
        with (
            mock.patch.object(resolve_integration, "_require_local_resolve"),
            mock.patch.object(resolve_integration, "_create_resolve_transfer_pinned", side_effect=AssertionError),
            mock.patch.object(resolve_integration, "load_manifest", side_effect=AssertionError),
        ):
            for call in calls:
                with self.subTest(call=call), self.assertRaises(HTTPException) as raised:
                    asyncio.run(call())
                self.assertEqual(raised.exception.status_code, 503)
                self.assertEqual(raised.exception.detail, runner.LAUNCHING_MESSAGE)
        self.assertEqual(resolve_transfer.active_transfer_count(), 0)


if __name__ == "__main__":
    unittest.main()

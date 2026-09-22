"""Resolve 검사·가져오기 러너의 제한 시간·인터프리터 폴백·결과 파싱 검증."""

from __future__ import annotations

import json
import subprocess
import sys
import unittest
from unittest import mock

from app.services import resolve_status_runner
from app.services.resolve_import_worker import RESULT_PREFIX as IMPORT_RESULT_PREFIX
from app.services.resolve_project_open_worker import (
    RESULT_PREFIX as PROJECT_OPEN_RESULT_PREFIX,
)
from app.services.resolve_probe import RESULT_PREFIX


def _completed(stdout: str = "", returncode: int = 0, stderr: str = "") -> subprocess.CompletedProcess:
    return subprocess.CompletedProcess(["python"], returncode, stdout=stdout, stderr=stderr)


def _probe_json(payload: dict) -> str:
    return RESULT_PREFIX + json.dumps(payload) + "\n"


class ResolveStatusRunnerTests(unittest.TestCase):
    def setUp(self):
        resolve_status_runner._working_interpreter = None
        resolve_status_runner._last_selection = None

    def test_timeout_returns_actionable_unavailable_status(self):
        with (
            mock.patch.object(resolve_status_runner, "resolve_process_running", return_value=True),
            mock.patch.object(
                resolve_status_runner.subprocess,
                "run",
                side_effect=subprocess.TimeoutExpired(["python"], 8),
            ),
        ):
            result = resolve_status_runner.resolve_connection_status_bounded()

        self.assertEqual(result["status"], "api_unavailable")
        self.assertIn("응답하지 않았습니다", result["message"])

    def test_probe_json_is_parsed_even_with_other_stdout(self):
        expected = {
            "status": "ready",
            "connected": True,
            "project_name": "편집 프로젝트",
        }
        completed = _completed("Resolve log\n" + _probe_json(expected))
        with (
            mock.patch.object(resolve_status_runner, "resolve_process_running", return_value=True),
            mock.patch.object(resolve_status_runner.subprocess, "run", return_value=completed),
        ):
            result = resolve_status_runner.resolve_connection_status_bounded()

        self.assertEqual(result, {**expected, "python_executable": sys.executable})

    def test_closed_resolve_returns_immediately_without_starting_probe(self):
        with (
            mock.patch.object(resolve_status_runner, "resolve_process_running", return_value=False),
            mock.patch.object(resolve_status_runner.subprocess, "run") as run,
        ):
            result = resolve_status_runner.resolve_connection_status_bounded()

        self.assertEqual(result["status"], "not_running")
        self.assertFalse(result["process_running"])
        run.assert_not_called()

    def test_incompatible_runtime_falls_back_to_system_python(self):
        # 내장 런타임(첫 후보)이 fusionscript 비호환이면 레지스트리 Python으로 재시도한다.
        incompatible = _completed(
            _probe_json({"status": "python_incompatible", "message": "fusionscript 비호환"})
        )
        ready = _completed(_probe_json({"status": "ready", "connected": True}))
        with (
            mock.patch.object(resolve_status_runner, "resolve_process_running", return_value=True),
            mock.patch.object(
                resolve_status_runner,
                "_candidate_interpreters",
                return_value=[r"C:\mvhub\python.exe", r"C:\Python311\python.exe"],
            ),
            mock.patch.object(
                resolve_status_runner.subprocess, "run", side_effect=[incompatible, ready]
            ) as run,
        ):
            result = resolve_status_runner.resolve_connection_status_bounded()

        self.assertEqual(result["status"], "ready")
        self.assertEqual(result["python_executable"], r"C:\Python311\python.exe")
        self.assertEqual(
            resolve_status_runner._working_interpreter, r"C:\Python311\python.exe"
        )
        self.assertEqual(run.call_count, 2)
        self.assertEqual(run.call_args_list[1].args[0][0], r"C:\Python311\python.exe")

    def test_hard_crash_without_json_also_rotates_interpreters(self):
        # Resolve 21 + 내장 3.14 실측: JSON 없이 0xC0000005 로 즉사한다.
        crashed = _completed("", returncode=3221225477)
        ready = _completed(_probe_json({"status": "ready", "connected": True}))
        with (
            mock.patch.object(resolve_status_runner, "resolve_process_running", return_value=True),
            mock.patch.object(
                resolve_status_runner,
                "_candidate_interpreters",
                return_value=[r"C:\mvhub\python.exe", r"C:\Python311\python.exe"],
            ),
            mock.patch.object(
                resolve_status_runner.subprocess, "run", side_effect=[crashed, ready]
            ),
        ):
            result = resolve_status_runner.resolve_connection_status_bounded()

        self.assertEqual(result["status"], "ready")
        self.assertEqual(result["python_executable"], r"C:\Python311\python.exe")

    def test_all_incompatible_interpreters_report_install_guidance(self):
        crashed = _completed("", returncode=3221225477)
        with (
            mock.patch.object(resolve_status_runner, "resolve_process_running", return_value=True),
            mock.patch.object(
                resolve_status_runner,
                "_candidate_interpreters",
                return_value=[r"C:\mvhub\python.exe", r"C:\Python311\python.exe"],
            ),
            mock.patch.object(
                resolve_status_runner.subprocess, "run", side_effect=[crashed, crashed]
            ),
        ):
            result = resolve_status_runner.resolve_connection_status_bounded()

        self.assertEqual(result["status"], "python_incompatible")
        self.assertFalse(result["connected"])
        self.assertIn("모든 사용자", result["message"])
        self.assertIn("64비트 Python", result["message"])
        self.assertIsNone(resolve_status_runner._working_interpreter)

    def test_cached_working_interpreter_is_tried_first(self):
        with mock.patch.object(
            resolve_status_runner,
            "_fallback_interpreters",
            return_value=[r"C:\Python311\python.exe"],
        ):
            resolve_status_runner._working_interpreter = r"C:\Python311\python.exe"
            candidates = resolve_status_runner._candidate_interpreters()

        self.assertEqual(candidates[0], r"C:\Python311\python.exe")
        self.assertIn(sys.executable, candidates)

    def test_burst_status_calls_reuse_recent_probe_result(self):
        # 상태 폴링이 짧은 간격으로 몰려도 검사 프로세스를 매번 새로 띄우지 않는다.
        ready = _completed(_probe_json({"status": "ready", "connected": True}))
        with (
            mock.patch.object(resolve_status_runner, "resolve_process_running", return_value=True),
            mock.patch.object(
                resolve_status_runner.subprocess, "run", return_value=ready
            ) as run,
        ):
            first = resolve_status_runner.resolve_connection_status_bounded()
            second = resolve_status_runner.resolve_connection_status_bounded()

        self.assertEqual(run.call_count, 1)
        self.assertEqual(first["status"], "ready")
        self.assertEqual(second["status"], "ready")

    def test_failing_cached_interpreter_is_forgotten(self):
        crashed = _completed("", returncode=3221225477)
        resolve_status_runner._working_interpreter = r"C:\Python311\python.exe"
        with (
            mock.patch.object(resolve_status_runner, "resolve_process_running", return_value=True),
            mock.patch.object(
                resolve_status_runner,
                "_candidate_interpreters",
                return_value=[r"C:\Python311\python.exe"],
            ),
            mock.patch.object(
                resolve_status_runner.subprocess, "run", return_value=crashed
            ),
        ):
            result = resolve_status_runner.resolve_connection_status_bounded()

        self.assertEqual(result["status"], "python_incompatible")
        self.assertIsNone(resolve_status_runner._working_interpreter)


class ResolveImportRunnerTests(unittest.TestCase):
    def setUp(self):
        resolve_status_runner._working_interpreter = None
        resolve_status_runner._last_selection = None
        # 열기·가져오기 앞에 'Resolve 켜져 있나' 관문이 생겼다 — 이 PC 의 Resolve 상태가 결과를 바꾸지 않게 고정한다.
        running = mock.patch.object(resolve_status_runner, "resolve_process_running", return_value=True)
        running.start()
        self.addCleanup(running.stop)

    def test_worker_result_json_is_returned(self):
        imported = {"status": "complete", "total": 1, "imported": 1}
        completed = _completed(
            "log line\n" + IMPORT_RESULT_PREFIX + json.dumps(imported) + "\n"
        )
        with (
            mock.patch.object(
                resolve_status_runner,
                "_select_interpreter",
                return_value=(r"C:\Python311\python.exe", {"status": "ready"}, ""),
            ),
            mock.patch.object(
                resolve_status_runner.subprocess, "run", return_value=completed
            ) as run,
        ):
            result = resolve_status_runner.run_resolve_import_isolated({"items": []})

        self.assertEqual(result, imported)
        command = run.call_args.args[0]
        self.assertEqual(command[0], r"C:\Python311\python.exe")
        self.assertEqual(command[-1], "app.services.resolve_import_worker")
        self.assertEqual(json.loads(run.call_args.kwargs["input"]), {"items": []})

    def test_no_compatible_interpreter_returns_unavailable_result(self):
        with mock.patch.object(
            resolve_status_runner,
            "_select_interpreter",
            return_value=(None, None, "3.14 크래시"),
        ):
            result = resolve_status_runner.run_resolve_import_isolated({"items": []})

        self.assertEqual(result["status"], "unavailable")
        self.assertIn("64비트 Python", result["error"])

    def test_worker_crash_without_json_is_reported_not_raised(self):
        crashed = _completed("", returncode=3221225477, stderr="")
        with (
            mock.patch.object(
                resolve_status_runner,
                "_select_interpreter",
                return_value=(r"C:\Python311\python.exe", {"status": "ready"}, ""),
            ),
            mock.patch.object(
                resolve_status_runner.subprocess, "run", return_value=crashed
            ),
        ):
            result = resolve_status_runner.run_resolve_import_isolated({"items": []})

        self.assertEqual(result["status"], "unavailable")
        self.assertIn("3221225477", result["error"])

    def test_import_worker_runs_without_time_limit(self):
        # 시간 초과로 워커를 강제 종료하면 Media Pool 재정렬 도중의 복구 코드가
        # 실행되지 못하므로, 가져오기 자식 프로세스에는 timeout을 걸지 않는다.
        imported = {"status": "complete", "total": 1, "imported": 1}
        completed = _completed(IMPORT_RESULT_PREFIX + json.dumps(imported) + "\n")
        with (
            mock.patch.object(
                resolve_status_runner,
                "_select_interpreter",
                return_value=(r"C:\Python311\python.exe", {"status": "ready"}, ""),
            ),
            mock.patch.object(
                resolve_status_runner.subprocess, "run", return_value=completed
            ) as run,
        ):
            resolve_status_runner.run_resolve_import_isolated({"items": []})

        self.assertIsNone(run.call_args.kwargs["timeout"])

    def test_long_worker_stderr_is_truncated_in_error_result(self):
        crashed = _completed("", returncode=1, stderr="x" * 10000)
        with (
            mock.patch.object(
                resolve_status_runner,
                "_select_interpreter",
                return_value=(r"C:\Python311\python.exe", {"status": "ready"}, ""),
            ),
            mock.patch.object(
                resolve_status_runner.subprocess, "run", return_value=crashed
            ),
        ):
            result = resolve_status_runner.run_resolve_import_isolated({"items": []})

        self.assertEqual(result["status"], "unavailable")
        self.assertLess(len(result["error"]), 2200)


class ResolveProjectOpenRunnerTests(unittest.TestCase):
    def setUp(self):
        resolve_status_runner._working_interpreter = None
        resolve_status_runner._last_selection = None
        # 열기·가져오기 앞에 'Resolve 켜져 있나' 관문이 생겼다 — 이 PC 의 Resolve 상태가 결과를 바꾸지 않게 고정한다.
        running = mock.patch.object(resolve_status_runner, "resolve_process_running", return_value=True)
        running.start()
        self.addCleanup(running.stop)

    def test_project_open_uses_isolated_worker_with_bounded_timeout(self):
        opened = {
            "status": "complete",
            "project_name": "Target",
            "already_open": False,
        }
        completed = _completed(PROJECT_OPEN_RESULT_PREFIX + json.dumps(opened) + "\n")
        payload = {
            "library_name": "MVHub - Test",
            "project_name": "Target",
            "folder_parts": [],
        }
        with (
            mock.patch.object(
                resolve_status_runner,
                "_select_interpreter",
                return_value=(r"C:\Python311\python.exe", {"status": "ready"}, ""),
            ),
            mock.patch.object(
                resolve_status_runner,
                "_run_child",
                return_value=completed,
            ) as run,
        ):
            result = resolve_status_runner.run_resolve_project_open_isolated(payload)

        self.assertEqual(result, opened)
        run.assert_called_once_with(
            r"C:\Python311\python.exe",
            "app.services.resolve_project_open_worker",
            timeout=120,
            input_text=json.dumps(payload, ensure_ascii=True),
        )

    def test_project_open_failure_does_not_include_import_counters(self):
        with mock.patch.object(
            resolve_status_runner,
            "_select_interpreter",
            return_value=(None, None, "incompatible"),
        ):
            result = resolve_status_runner.run_resolve_project_open_isolated({})

        self.assertEqual(result["status"], "unavailable")
        self.assertEqual(result["error_code"], "python_incompatible")
        self.assertNotIn("imported", result)

    def test_project_open_does_not_wait_behind_an_existing_resolve_mutation(self):
        self.assertTrue(resolve_status_runner._RESOLVE_MUTATION_LOCK.acquire(blocking=False))
        try:
            result = resolve_status_runner.run_resolve_project_open_isolated({})
        finally:
            resolve_status_runner._RESOLVE_MUTATION_LOCK.release()

        self.assertEqual(result["error_code"], "resolve_busy")


class ResolveClosedGateTests(unittest.TestCase):
    """Resolve 가 꺼져 있으면 검사 프로세스를 띄우지 않고 바로 이유를 돌려준다(2026-09-22).

    꺼진 상태의 검사 프로세스는 13초쯤 걸리는데 부모는 8초만 기다려, 진짜 이유 대신
    '8초 안에 응답하지 않았습니다' 가 나갔다.
    """

    def setUp(self):
        resolve_status_runner._working_interpreter = None
        resolve_status_runner._last_selection = None
        closed = mock.patch.object(resolve_status_runner, "resolve_process_running", return_value=False)
        closed.start()
        self.addCleanup(closed.stop)

    def test_project_open_reports_not_running_without_spawning(self):
        with mock.patch.object(resolve_status_runner.subprocess, "run") as run:
            result = resolve_status_runner.run_resolve_project_open_isolated({"library_names": ["X"]})

        run.assert_not_called()
        self.assertEqual(result["error_code"], "not_running")
        self.assertIn("실행 중이지 않습니다", result["error"])

    def test_import_reports_not_running_without_spawning(self):
        with mock.patch.object(resolve_status_runner.subprocess, "run") as run:
            result = resolve_status_runner.run_resolve_import_isolated({"items": []})

        run.assert_not_called()
        self.assertEqual(result["error_code"], "not_running")

    def test_library_list_reports_not_running_without_spawning(self):
        with mock.patch.object(resolve_status_runner.subprocess, "run") as run:
            result = resolve_status_runner.run_resolve_library_list_isolated()

        run.assert_not_called()
        self.assertEqual(result, {"status": "failed", "error_code": "not_running", "names": []})

    def test_unknown_process_state_still_tries_the_probe(self):
        # tasklist 자체가 실패하면(None) 꺼졌다고 단정하지 않는다 — 예전처럼 검사를 돌린다.
        with (
            mock.patch.object(resolve_status_runner, "resolve_process_running", return_value=None),
            mock.patch.object(resolve_status_runner, "_select_interpreter", return_value=(None, None, "x")),
        ):
            result = resolve_status_runner.run_resolve_project_open_isolated({"library_names": ["X"]})

        self.assertEqual(result["error_code"], "python_incompatible")


class ResolveLibraryListRunnerTests(unittest.TestCase):
    def setUp(self):
        resolve_status_runner._working_interpreter = None
        resolve_status_runner._last_selection = None
        running = mock.patch.object(resolve_status_runner, "resolve_process_running", return_value=True)
        running.start()
        self.addCleanup(running.stop)

    def test_list_worker_result_is_returned(self):
        from app.services.resolve_library_list_worker import RESULT_PREFIX as LIST_PREFIX

        listed = {"status": "complete", "names": ["FUSION", "MVHub - 뻘뻘뻘"]}
        with (
            mock.patch.object(resolve_status_runner, "_select_interpreter", return_value=(sys.executable, {}, "")),
            mock.patch.object(
                resolve_status_runner.subprocess,
                "run",
                return_value=_completed("noise\n" + LIST_PREFIX + json.dumps(listed) + "\n"),
            ) as run,
        ):
            result = resolve_status_runner.run_resolve_library_list_isolated()

        self.assertEqual(result, listed)
        self.assertEqual(run.call_args.args[0][-1], "app.services.resolve_library_list_worker")

    def test_list_does_not_take_the_mutation_slot(self):
        # 연결 창 쪽이 슬롯을 잡기 전에 묻는다 — 슬롯을 잡으면 다른 작업 중일 때 괜히 '모름'이 된다.
        with (
            resolve_status_runner.resolve_mutation_slot(),
            mock.patch.object(resolve_status_runner, "_select_interpreter", return_value=(sys.executable, {}, "")),
            mock.patch.object(resolve_status_runner.subprocess, "run", return_value=_completed("")),
        ):
            result = resolve_status_runner.run_resolve_library_list_isolated()

        self.assertEqual(result["error_code"], "invalid_child_result")


if __name__ == "__main__":
    unittest.main()

"""Resolve 검사·가져오기 러너의 제한 시간·인터프리터 폴백·결과 파싱 검증."""

from __future__ import annotations

import json
import subprocess
import sys
import unittest
from unittest import mock

from app.services import resolve_status_runner
from app.services.resolve_import_worker import RESULT_PREFIX as IMPORT_RESULT_PREFIX
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


if __name__ == "__main__":
    unittest.main()

"""Resolve 상태 검사 프로세스의 제한 시간과 결과 파싱 검증."""

from __future__ import annotations

import json
import subprocess
import unittest
from unittest import mock

from app.services import resolve_status_runner
from app.services.resolve_probe import RESULT_PREFIX


class ResolveStatusRunnerTests(unittest.TestCase):
    def test_timeout_returns_actionable_unavailable_status(self):
        with mock.patch.object(
            resolve_status_runner.subprocess,
            "run",
            side_effect=subprocess.TimeoutExpired(["python"], 8),
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
        completed = subprocess.CompletedProcess(
            ["python"],
            0,
            stdout="Resolve log\n" + RESULT_PREFIX + json.dumps(expected) + "\n",
            stderr="",
        )
        with mock.patch.object(
            resolve_status_runner.subprocess, "run", return_value=completed
        ):
            result = resolve_status_runner.resolve_connection_status_bounded()

        self.assertEqual(result, expected)


if __name__ == "__main__":
    unittest.main()

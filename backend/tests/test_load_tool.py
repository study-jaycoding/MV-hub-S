"""부하 테스트 순수 집계·판정 테스트."""

import importlib.util
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location(
    "load_test_100",
    ROOT / "tools" / "load_test_100.py",
)
assert SPEC and SPEC.loader
load_tool = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(load_tool)


class LoadToolTests(unittest.TestCase):
    def test_percentile(self):
        self.assertEqual(load_tool._percentile(list(range(1, 101)), 0.95), 95)
        self.assertEqual(load_tool._percentile([], 0.95), 0.0)

    def test_acceptance_requires_connections_latency_and_no_locks(self):
        report = {
            "workload": {"statuses": {200: 100}, "latency_ms": {"p95": 100}},
            "connections_during_load": {
                "websocket": {"connections": 10},
                "agents": {"long_poll_waiters": 10},
                "websocket_client_errors": [],
            },
            "server": {
                "after": {"requests": {"sqlite_locked_total": 0}},
                "memory_growth_percent_after_warmup": 5.0,
            },
        }
        args = SimpleNamespace(
            users=10,
            max_p95_ms=500,
            max_memory_growth_percent=20,
        )
        result = load_tool._evaluate(report, args)
        self.assertTrue(result["passed"])

        report["server"]["after"]["requests"]["sqlite_locked_total"] = 1
        self.assertFalse(load_tool._evaluate(report, args)["passed"])

        report["server"]["after"]["requests"]["sqlite_locked_total"] = 0
        report["workload"]["statuses"] = {200: 99, 404: 1}
        self.assertFalse(load_tool._evaluate(report, args)["passed"])

    def test_keep_alive_client_reuses_connection(self):
        class FakeResponse:
            status = 200

            def read(self):
                return b'{"ok": true}'

        class FakeConnection:
            instances = 0
            requests = 0

            def __init__(self, host, port, timeout):
                self.host = host
                self.port = port
                self.timeout = timeout
                FakeConnection.instances += 1

            def request(self, method, path, body=None, headers=None):
                FakeConnection.requests += 1

            def getresponse(self):
                return FakeResponse()

            def close(self):
                pass

        with mock.patch.object(
            load_tool.http.client,
            "HTTPConnection",
            FakeConnection,
        ):
            client = load_tool._KeepAliveJsonClient(
                "http://127.0.0.1:8010",
                token="test-token",
            )
            self.assertEqual(client.request("/api/ready")[0], 200)
            self.assertEqual(client.request("/api/ready")[0], 200)
            client.close()

        self.assertEqual(FakeConnection.instances, 1)
        self.assertEqual(FakeConnection.requests, 2)

    def test_temp_cleanup_retries_transient_windows_lock(self):
        transient_lock = PermissionError(32, "다른 프로세스가 파일을 사용 중입니다")
        with (
            mock.patch.object(
                load_tool.tempfile,
                "mkdtemp",
                return_value=r"C:\Temp\mvhub-load-test",
            ),
            mock.patch.object(
                load_tool.shutil,
                "rmtree",
                side_effect=[transient_lock, None],
            ) as remove_mock,
            mock.patch.object(load_tool.time, "sleep") as sleep_mock,
        ):
            with load_tool._temporary_load_root() as temp_name:
                self.assertEqual(temp_name, r"C:\Temp\mvhub-load-test")

        self.assertEqual(remove_mock.call_count, 2)
        sleep_mock.assert_called_once_with(0.25)


if __name__ == "__main__":
    unittest.main()

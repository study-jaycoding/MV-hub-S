"""부하 테스트 순수 집계·판정 테스트."""

import asyncio
import importlib.util
import json
import sys
import tempfile
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

    def test_reservoir_sampling_stays_bounded(self):
        samples = []
        rng = load_tool.random.Random(123)
        for seen in range(1, 10_001):
            load_tool._reservoir_add(samples, float(seen), seen, 100, rng)

        self.assertEqual(len(samples), 100)
        self.assertTrue(all(1 <= value <= 10_000 for value in samples))

    def test_operational_error_tail_keeps_only_latest_errors(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "runtime.jsonl"
            path.write_text(
                "\n".join(
                    (
                        json.dumps({"level": "INFO", "message": "ok"}),
                        "not-json",
                        json.dumps({"level": "ERROR", "message": "first"}),
                        json.dumps({"level": "CRITICAL", "message": "last"}),
                    )
                ),
                encoding="utf-8",
            )

            result = load_tool._operational_error_tail(path, limit=1)

        self.assertEqual(result, [{"level": "CRITICAL", "message": "last"}])

    def test_atomic_write_json_replaces_complete_document(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "progress.json"
            load_tool._atomic_write_json(path, {"state": "first"})
            load_tool._atomic_write_json(path, {"state": "completed", "cycle": 2})

            result = json.loads(path.read_text(encoding="utf-8"))
            temporary_files = list(path.parent.glob(".*.tmp"))

        self.assertEqual(result, {"state": "completed", "cycle": 2})
        self.assertEqual(temporary_files, [])

    def test_ssl_close_filter_only_suppresses_exact_cleanup_warning(self):
        close_record = load_tool.logging.LogRecord(
            "asyncio",
            load_tool.logging.WARNING,
            __file__,
            1,
            "SSL connection is closed",
            (),
            None,
        )
        error_record = load_tool.logging.LogRecord(
            "asyncio",
            load_tool.logging.ERROR,
            __file__,
            1,
            "TLS handshake failed",
            (),
            None,
        )
        close_filter = load_tool._ExpectedSslCloseFilter()
        self.assertFalse(close_filter.filter(close_record))
        self.assertTrue(close_filter.filter(error_record))

    def test_acceptance_requires_connections_latency_and_no_locks(self):
        report = {
            "login": {"p95_ms": 100},
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
            max_login_p95_ms=10_000,
            max_memory_growth_percent=20,
            max_rss_mb=512,
        )
        result = load_tool._evaluate(report, args)
        self.assertTrue(result["passed"])

        report["server"]["after"]["requests"]["sqlite_locked_total"] = 1
        self.assertFalse(load_tool._evaluate(report, args)["passed"])

        report["server"]["after"]["requests"]["sqlite_locked_total"] = 0
        report["workload"]["statuses"] = {200: 99, 404: 1}
        self.assertFalse(load_tool._evaluate(report, args)["passed"])

        report["workload"]["statuses"] = {200: 100}
        report["login"]["control_probe"] = {
            "samples": 2,
            "statuses": {200: 2},
            "p95_ms": 600,
        }
        result = load_tool._evaluate(report, args)
        self.assertFalse(result["passed"])
        self.assertFalse(result["checks"]["login_control_probe_healthy"])

    def test_acceptance_rejects_resource_peak_and_sampled_connection_drop(self):
        report = {
            "login": {"p95_ms": 100},
            "workload": {"statuses": {200: 100}, "latency_ms": {"p95": 100}},
            "connections_during_load": {
                "websocket": {"connections": 10},
                "agents": {"long_poll_waiters": 10},
                "websocket_client_errors": [],
                "long_poll_client_errors": [],
            },
            "server": {
                "after": {"requests": {"sqlite_locked_total": 0}},
                "memory_growth_percent_after_warmup": 5.0,
                "runtime_monitor_errors": [],
                "resource_summary": {
                    "max_rss_bytes": 600 * 1024 * 1024,
                    "min_websocket_connections": 9,
                    "min_agent_long_poll_waiters": 10,
                    "min_agent_connected_accounts": 10,
                },
            },
        }
        args = SimpleNamespace(
            users=10,
            max_p95_ms=500,
            max_login_p95_ms=10_000,
            max_memory_growth_percent=20,
            max_rss_mb=512,
        )

        result = load_tool._evaluate(report, args)

        self.assertFalse(result["passed"])
        self.assertFalse(result["checks"]["rss_within_target"])
        self.assertFalse(result["checks"]["sampled_websockets_healthy"])

    def test_acceptance_uses_connected_agents_not_transient_long_poll_waiters(self):
        report = {
            "login": {"p95_ms": 100},
            "workload": {"statuses": {200: 100}, "latency_ms": {"p95": 100}},
            "connections_during_load": {
                "websocket": {"connections": 10},
                "agents": {"long_poll_waiters": 10},
                "websocket_client_errors": [],
                "long_poll_client_errors": [],
            },
            "server": {
                "after": {"requests": {"sqlite_locked_total": 0}},
                "memory_growth_percent_after_warmup": 5.0,
                "runtime_monitor_errors": [],
                "resource_summary": {
                    "max_rss_bytes": 100 * 1024 * 1024,
                    "min_websocket_connections": 10,
                    "min_agent_long_poll_waiters": 0,
                    "min_agent_connected_accounts": 10,
                },
            },
        }
        args = SimpleNamespace(
            users=10,
            max_p95_ms=500,
            max_login_p95_ms=10_000,
            max_memory_growth_percent=20,
            max_rss_mb=512,
        )

        result = load_tool._evaluate(report, args)

        self.assertTrue(result["passed"])
        self.assertTrue(result["checks"]["sampled_agent_connections_healthy"])

    def test_apply_server_limits_uses_selected_affinity_and_low_priority(self):
        fake_process = mock.Mock()
        fake_process.cpu_affinity.side_effect = [
            [0, 1, 2, 3, 4, 5],
            None,
            [0, 1, 2, 3],
        ]
        fake_process.nice.return_value = "below"
        fake_psutil = SimpleNamespace(
            Process=mock.Mock(return_value=fake_process),
            BELOW_NORMAL_PRIORITY_CLASS=123,
        )

        with (
            mock.patch.dict(sys.modules, {"psutil": fake_psutil}),
            mock.patch.object(load_tool.os, "name", "nt"),
        ):
            result = load_tool._apply_server_limits(
                42,
                cpu_cores=4,
                priority="below-normal",
            )

        fake_process.cpu_affinity.assert_any_call([0, 1, 2, 3])
        fake_process.nice.assert_any_call(123)
        self.assertEqual(result["cpu_affinity"], [0, 1, 2, 3])
        self.assertEqual(result["priority"], "below-normal")

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

    def test_https_keep_alive_client_uses_verifying_context(self):
        ssl_context = mock.sentinel.ssl_context

        class FakeHttpsConnection:
            received_context = None

            def __init__(self, host, port, timeout, context):
                self.host = host
                self.port = port
                self.timeout = timeout
                FakeHttpsConnection.received_context = context

            def close(self):
                pass

        with mock.patch.object(
            load_tool.http.client,
            "HTTPSConnection",
            FakeHttpsConnection,
        ):
            client = load_tool._KeepAliveJsonClient(
                "https://127.0.0.1:8443",
                ssl_context=ssl_context,
            )
            client.close()

        self.assertIs(FakeHttpsConnection.received_context, ssl_context)

    def test_server_environment_adds_tls_only_when_configured(self):
        with mock.patch.dict(
            load_tool.os.environ,
            {
                "CONTENT_HUB_SSL_CERTFILE": r"C:\inherited\cert.pem",
                "CONTENT_HUB_SSL_KEYFILE": r"C:\inherited\key.pem",
            },
        ):
            plain = load_tool._server_environment(
                Path(r"C:\Temp\data"),
                Path(r"C:\Temp\load.db"),
                8443,
            )
        self.assertNotIn("CONTENT_HUB_SSL_CERTFILE", plain)
        self.assertNotIn("CONTENT_HUB_SSL_KEYFILE", plain)

        tls = load_tool._server_environment(
            Path(r"C:\Temp\data"),
            Path(r"C:\Temp\load.db"),
            8443,
            ssl_certfile=Path(r"C:\Temp\cert.pem"),
            ssl_keyfile=Path(r"C:\Temp\key.pem"),
        )
        self.assertEqual(tls["CONTENT_HUB_SSL_CERTFILE"], r"C:\Temp\cert.pem")
        self.assertEqual(tls["CONTENT_HUB_SSL_KEYFILE"], r"C:\Temp\key.pem")

    def test_websocket_client_matches_browser_keepalive(self):
        captured = {}

        class FakeConnection:
            async def __aenter__(self):
                return self

            async def __aexit__(self, exc_type, exc, traceback):
                return False

        def fake_connect(url, **kwargs):
            captured["url"] = url
            captured["kwargs"] = kwargs
            return FakeConnection()

        fake_websockets = SimpleNamespace(connect=fake_connect)

        async def run_worker():
            stop = asyncio.Event()
            stop.set()
            ready = asyncio.Event()
            errors = []
            with mock.patch.dict(sys.modules, {"websockets": fake_websockets}):
                await load_tool._websocket_worker(
                    "wss://127.0.0.1:8443",
                    "token",
                    stop,
                    ready,
                    errors,
                    mock.sentinel.ssl_context,
                )
            self.assertTrue(ready.is_set())
            self.assertEqual(errors, [])

        asyncio.run(run_worker())
        self.assertEqual(captured["url"], "wss://127.0.0.1:8443/ws?token=token")
        self.assertIsNone(captured["kwargs"]["ping_interval"])
        self.assertEqual(captured["kwargs"]["close_timeout"], 3)
        self.assertIs(
            captured["kwargs"]["ssl"],
            mock.sentinel.ssl_context,
        )

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

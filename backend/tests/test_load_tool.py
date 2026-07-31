"""부하 테스트 순수 집계·판정 테스트."""

import importlib.util
import unittest
from pathlib import Path
from types import SimpleNamespace

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


if __name__ == "__main__":
    unittest.main()

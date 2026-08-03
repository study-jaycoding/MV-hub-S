"""운영 지표의 고정 메모리·집계 계약 테스트."""

import unittest

from app.services.runtime_metrics import RuntimeMetrics


class RuntimeMetricsTests(unittest.TestCase):
    def test_request_percentiles_status_and_path_counts(self):
        metrics = RuntimeMetrics(sample_max=100)
        for i in range(1, 101):
            metrics.record_request(
                float(i),
                status=500 if i == 100 else 200,
                method="get",
                path="/api/test",
            )

        snapshot = metrics.request_snapshot()
        self.assertEqual(snapshot["total"], 100)
        self.assertEqual(snapshot["status"], {"2xx": 99, "5xx": 1})
        self.assertEqual(snapshot["methods"], {"GET": 100})
        self.assertEqual(snapshot["latency_ms"]["p95"], 95.0)
        self.assertEqual(snapshot["latency_ms"]["max"], 100.0)
        self.assertEqual(snapshot["top_paths"][0], {"path": "/api/test", "count": 100})

    def test_samples_are_bounded_and_db_lock_is_counted(self):
        metrics = RuntimeMetrics(sample_max=100)
        for i in range(250):
            metrics.record_request(float(i), status=200)
        metrics.record_db_locked()
        metrics.record_db_connection_opened()

        snapshot = metrics.request_snapshot()
        self.assertEqual(snapshot["total"], 250)
        self.assertEqual(snapshot["latency_sample_size"], 100)
        self.assertEqual(snapshot["sqlite_locked_total"], 1)
        self.assertEqual(snapshot["db_connections_opened_total"], 1)

    def test_unique_paths_are_bounded_and_overflow_is_aggregated(self):
        metrics = RuntimeMetrics(sample_max=100, path_max=32)
        for index in range(10_000):
            metrics.record_request(1.0, status=200, path=f"/random/{index}")

        snapshot = metrics.request_snapshot()
        self.assertLessEqual(len(metrics._path_counts), 32)
        self.assertEqual(metrics._path_counts["_other"], 10_000 - 31)
        self.assertEqual(snapshot["top_paths"][0]["path"], "_other")

    def test_unusual_method_and_status_share_bounded_buckets(self):
        metrics = RuntimeMetrics()
        for index in range(1000):
            metrics.record_request(
                1.0,
                status=10_000 + index,
                method=f"CUSTOM-{index}",
            )
        snapshot = metrics.request_snapshot()
        self.assertEqual(snapshot["methods"], {"OTHER": 1000})
        self.assertEqual(snapshot["status"], {"other": 1000})

    def test_process_snapshot_has_safe_cross_platform_shape(self):
        metrics = RuntimeMetrics()
        snapshot = metrics.process_snapshot()
        self.assertIn("cpu_percent_one_core", snapshot)
        self.assertIn("rss_bytes", snapshot)
        self.assertGreaterEqual(snapshot["threads"], 1)
        self.assertGreater(snapshot["pid"], 0)


if __name__ == "__main__":
    unittest.main()

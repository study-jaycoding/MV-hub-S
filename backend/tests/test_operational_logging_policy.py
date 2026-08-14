from app.services.operational_logging import (
    compact_runtime_snapshot,
    should_log_http_request,
)


def test_normal_agent_long_poll_is_not_logged_as_slow_request():
    assert not should_log_http_request(
        "/api/agent/wait", 200, 25_100, slow_request_ms=1_000
    )
    assert should_log_http_request(
        "/api/agent/wait", 200, 35_001, slow_request_ms=1_000
    )


def test_agent_long_poll_server_error_is_always_logged():
    assert should_log_http_request(
        "/api/agent/wait", 503, 10, slow_request_ms=1_000
    )


def test_regular_request_keeps_standard_slow_threshold():
    assert not should_log_http_request("/api/projects", 200, 999, slow_request_ms=1_000)
    assert should_log_http_request("/api/projects", 200, 1_000, slow_request_ms=1_000)


def test_runtime_log_snapshot_drops_high_cardinality_details_but_keeps_health():
    compact = compact_runtime_snapshot(
        {
            "requests": {
                "total": 10,
                "status": {"2xx": 9, "5xx": 1},
                "top_paths": [{"path": "/api/a", "count": 9}],
                "methods": {"GET": 10},
                "latency_ms": {"p95": 20},
            },
            "process": {"cpu_percent_one_core": 2, "rss_bytes": 3, "pid": 999},
            "disk": {"volume_free_bytes": 4, "data_root": "private-path"},
            "websocket": {"connections": 5, "authenticated_accounts": 2},
            "agents": {"connected_accounts": 1},
            "operations": {
                "generation_queue": {"active_total": 1},
                "telemetry": {"pending": 0, "failed": 0},
                "backups": {"set_count": 7},
                "databases": {"ready": True},
            },
        }
    )

    assert compact["requests"]["total"] == 10
    assert compact["operations"]["databases"]["ready"] is True
    assert "top_paths" not in compact["requests"]
    assert "methods" not in compact["requests"]
    assert "pid" not in compact["process"]
    assert "data_root" not in compact["disk"]

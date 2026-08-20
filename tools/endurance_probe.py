r"""시간 의존 안정성을 확인하는 MV Hub 격리 지구력 프로브.

운영 DB와 실행 중인 서버에는 접속하지 않는다. 임시 DB·data·media·backup·log 폴더와
127.0.0.1의 18092 이상 전용 포트에 서버를 띄우고, 시간 경과에 따른 상태만 낮은 빈도로 읽는다.

빠른 실행::

    python tools\endurance_probe.py --duration 20 --output endurance-result.json

실제 장기 관찰::

    python tools\endurance_probe.py --duration 28800 --sample-interval 30 ^
      --server-priority below-normal --output endurance-8h.json
"""

from __future__ import annotations

import argparse
import asyncio
import contextlib
import gc
import json
import math
import os
import re
import shutil
import sqlite3
import subprocess
import sys
import threading
import time
import urllib.parse
from pathlib import Path
from statistics import mean
from typing import Any

from fastapi import Request


ROOT = Path(__file__).resolve().parents[1]
BACKEND = ROOT / "backend"
TOOLS = ROOT / "tools"
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))

# 검증된 격리 기동·HTTP·프로세스 제한 구현을 한 곳에서 재사용한다.
from load_test_100 import (  # noqa: E402
    PASSWORD,
    _apply_server_limits,
    _atomic_write_json,
    _http_json,
    _listening_pid,
    _seed_database,
    _temporary_load_root,
    _wait_ready,
)


DEFAULT_PORT = 18092
MIN_PROBE_PORT = 18092
WS_CONNECTIONS = 4
WS_MESSAGES_PER_CYCLE = 8
WS_GHOST_SECONDS = 1.2
WS_RECV_TIMEOUT_SECONDS = 0.25
RECONCILE_INTERVAL_SECONDS = 1.0
BACKUP_INTERVAL_SECONDS = 4.0
BACKUP_POLL_SECONDS = 5.0  # 서비스 구현의 안전 하한과 동일하다.
BACKUP_KEEP = 2
METRICS_LOG_INTERVAL_SECONDS = 0.35
LOG_MAX_BYTES = 16 * 1024
LOG_KEEP = 2
LOG_RATE_LIMIT_BYTES_PER_MINUTE = 2 * 1024 * 1024

WAL_GROWTH_TOLERANCE_BYTES = 64 * 1024
DB_GROWTH_LIMIT_BYTES = 32 * 1024 * 1024
WAL_SIZE_LIMIT_BYTES = 64 * 1024 * 1024
RSS_GROWTH_LIMIT_BYTES = 64 * 1024 * 1024
RSS_RATE_LIMIT_BYTES_PER_MINUTE = 256 * 1024 * 1024
THREAD_GROWTH_LIMIT = 4
THREAD_RATE_LIMIT_PER_MINUTE = 12.0
HANDLE_GROWTH_LIMIT = 16
HANDLE_RATE_LIMIT_PER_MINUTE = 48.0

_BOUNDARY_BACKUPS = (
    "content_hub_20260819_235959_000000.db",
    "content_hub_20260820_000001_000000.db",
)


def _result(checks: dict[str, bool], summary: dict[str, Any]) -> dict[str, Any]:
    return {"passed": all(checks.values()), "checks": checks, "summary": summary}


def _numeric_summary(
    values: list[int | float | None], elapsed_seconds: list[float] | None = None
) -> dict[str, Any]:
    usable = [float(value) for value in values if value is not None]
    if not usable:
        return {
            "count": 0,
            "first": None,
            "last": None,
            "min": None,
            "max": None,
            "growth": None,
            "growth_per_minute": None,
        }
    growth = usable[-1] - usable[0]
    rate = None
    if elapsed_seconds and len(elapsed_seconds) >= 2:
        elapsed = max(0.001, float(elapsed_seconds[-1]) - float(elapsed_seconds[0]))
        rate = growth * 60.0 / elapsed
    return {
        "count": len(usable),
        "first": round(usable[0], 3),
        "last": round(usable[-1], 3),
        "min": round(min(usable), 3),
        "max": round(max(usable), 3),
        "growth": round(growth, 3),
        "growth_per_minute": round(rate, 3) if rate is not None else None,
    }


def _evaluate_survival(observation: dict[str, Any]) -> dict[str, Any]:
    health = observation.get("health_statuses", [])
    ready = observation.get("ready_statuses", [])
    shutdown = observation.get("shutdown", {})
    checks = {
        "multiple_samples": len(health) >= 2 and len(ready) == len(health),
        "health_always_200": bool(health) and all(status == 200 for status in health),
        "ready_always_200": bool(ready) and all(status == 200 for status in ready),
        "process_alive_during_probe": bool(observation.get("process_alive", False)),
        "listener_process_reaped": bool(shutdown.get("listener_exited", False)),
        "shutdown_was_graceful": not bool(shutdown.get("forced_kill", True)),
        "isolated_port_released_on_shutdown": bool(shutdown.get("port_released", False)),
        "shutdown_completed_within_limit": (
            shutdown.get("elapsed_seconds") is not None
            and float(shutdown["elapsed_seconds"]) <= 12.0
        ),
    }
    return _result(
        checks,
        {
            "samples": len(health),
            "health_status_counts": _counts(health),
            "ready_status_counts": _counts(ready),
            "shutdown": shutdown,
        },
    )


def _evaluate_websocket(observation: dict[str, Any]) -> dict[str, Any]:
    baseline = observation.get("baseline", {})
    final = observation.get("final", {})
    cycles = observation.get("cycles", [])
    expected = int(observation.get("connections_per_cycle") or WS_CONNECTIONS)
    baseline_connections = int(baseline.get("connections") or 0)
    baseline_queued = int(baseline.get("queued_messages") or 0)
    returned = [cycle.get("returned", {}) for cycle in cycles]
    checks = {
        "multiple_connect_disconnect_cycles": len(cycles) >= 2,
        "all_connections_observed": bool(cycles)
        and all(
            int(cycle.get("peak", {}).get("connections") or 0)
            >= baseline_connections + expected
            for cycle in cycles
        ),
        "connections_returned_to_baseline": bool(returned)
        and all(int(item.get("connections") or 0) == baseline_connections for item in returned)
        and int(final.get("connections") or 0) == baseline_connections,
        "queues_returned_to_baseline": bool(returned)
        and all(int(item.get("queued_messages") or 0) == baseline_queued for item in returned)
        and int(final.get("queued_messages") or 0) == baseline_queued,
        "single_sender_fifo_delivery_complete": bool(cycles)
        and all(
            cycle.get("delivery", {}).get("clients") == expected
            and cycle.get("delivery", {}).get("messages_per_client")
            == WS_MESSAGES_PER_CYCLE
            and cycle.get("delivery", {}).get("fifo") is True
            for cycle in cycles
        ),
        "ghost_collected_with_1001": bool(observation.get("ghost", {}).get("observed"))
        and observation.get("ghost", {}).get("close_code") == 1001,
        "client_errors_zero": not observation.get("errors", []),
    }
    return _result(
        checks,
        {
            "baseline": baseline,
            "final": final,
            "cycles": len(cycles),
            "max_connections": max(
                (int(cycle.get("peak", {}).get("connections") or 0) for cycle in cycles),
                default=baseline_connections,
            ),
            "max_queued_messages": max(
                (
                    int(cycle.get("peak", {}).get("queued_messages") or 0)
                    for cycle in cycles
                ),
                default=baseline_queued,
            ),
            "messages_per_cycle": expected * WS_MESSAGES_PER_CYCLE,
            "ghost": observation.get("ghost", {}),
            "errors": observation.get("errors", []),
        },
    )


def _evaluate_database_wal(
    observation: dict[str, Any], config: dict[str, Any]
) -> dict[str, Any]:
    series = observation.get("series", [])
    # 부팅 직후 변동은 워밍업으로 보고 뒤 절반을 명시적인 무쓰기 구간으로 판정한다.
    quiet = series[max(0, len(series) // 2) :]
    wal = [int(item.get("wal_bytes") or 0) for item in quiet]
    combined = [
        int(item.get("db_bytes") or 0) + int(item.get("wal_bytes") or 0)
        for item in quiet
    ]
    monotonic_growth = bool(len(wal) >= 4) and all(
        later >= earlier for earlier, later in zip(wal, wal[1:])
    ) and wal[-1] - wal[0] > WAL_GROWTH_TOLERANCE_BYTES
    checkpoint_observed = bool(wal) and (
        wal[-1] <= wal[0] + WAL_GROWTH_TOLERANCE_BYTES
        or any(later < earlier for earlier, later in zip(wal, wal[1:]))
    )
    backups = observation.get("backups", {})
    initial_names = set(backups.get("initial_names", []))
    seen_names = set(backups.get("seen_names", []))
    final_names = set(backups.get("final_names", []))
    generated = seen_names - initial_names
    keep = int(config.get("backup_keep") or BACKUP_KEEP)
    checks = {
        "quiet_window_has_samples": len(quiet) >= 4,
        "db_and_wal_growth_bounded": bool(combined)
        and max(combined) - combined[0] <= DB_GROWTH_LIMIT_BYTES,
        "wal_size_bounded": bool(wal) and max(wal) <= WAL_SIZE_LIMIT_BYTES,
        "wal_not_monotonically_growing": not monotonic_growth,
        "checkpoint_or_stable_wal_observed": checkpoint_observed,
        "multiple_periodic_backups_observed": len(generated) >= keep + 1,
        "backup_rotation_respects_keep": len(final_names) <= keep,
        "date_boundary_sets_rotated_in_order": set(_BOUNDARY_BACKUPS) <= initial_names
        and not (set(_BOUNDARY_BACKUPS) & final_names),
        "orphan_backup_sidecars_removed": not backups.get("final_orphan_sidecars", []),
    }
    elapsed = [float(item.get("elapsed_seconds") or 0.0) for item in quiet]
    return _result(
        checks,
        {
            "db_bytes": _numeric_summary(
                [item.get("db_bytes") for item in quiet], elapsed
            ),
            "wal_bytes": _numeric_summary(wal, elapsed),
            "combined_bytes": _numeric_summary(combined, elapsed),
            "quiet_window_samples": len(quiet),
            "backup_initial_names": sorted(initial_names),
            "backup_generated_sets": sorted(generated),
            "backup_final_names": sorted(final_names),
            "orphan_sidecars": backups.get("final_orphan_sidecars", []),
        },
    )


def _evaluate_logs(
    observation: dict[str, Any], config: dict[str, Any]
) -> dict[str, Any]:
    series = observation.get("series", [])
    totals = [int(item.get("total_bytes") or 0) for item in series]
    elapsed = [float(item.get("elapsed_seconds") or 0.0) for item in series]
    max_bytes = int(config.get("log_max_bytes") or LOG_MAX_BYTES)
    keep = int(config.get("log_keep") or LOG_KEEP)
    # RotatingFileHandler는 새 레코드를 쓰기 전에 회전하므로 한 레코드 크기만큼의 여유를 둔다.
    bounded_limit = (keep + 1) * (max_bytes + 8 * 1024)
    checks = {
        "multiple_samples": len(series) >= 4,
        "rotation_observed": any(int(item.get("file_count") or 0) > 1 for item in series),
        "rotated_file_count_bounded": all(
            int(item.get("file_count") or 0) <= keep + 1 for item in series
        ),
        "total_log_bytes_bounded": bool(totals) and max(totals) <= bounded_limit,
        "log_growth_rate_bounded": max(
            0.0,
            float(_numeric_summary(totals, elapsed).get("growth_per_minute") or 0.0),
        )
        <= LOG_RATE_LIMIT_BYTES_PER_MINUTE,
        "operational_errors_zero": not observation.get("error_events", []),
    }
    return _result(
        checks,
        {
            "bytes": _numeric_summary(totals, elapsed),
            "max_file_count": max(
                (int(item.get("file_count") or 0) for item in series), default=0
            ),
            "bounded_limit_bytes": bounded_limit,
            "growth_rate_limit_bytes_per_minute": LOG_RATE_LIMIT_BYTES_PER_MINUTE,
            "rotation_names_seen": sorted(observation.get("names_seen", [])),
            "error_events": observation.get("error_events", [])[-10:],
        },
    )


def _evaluate_reconciler(
    observation: dict[str, Any], config: dict[str, Any]
) -> dict[str, Any]:
    cycles = observation.get("cycles", [])
    timestamps = [
        float(item.get("monotonic", item["timestamp"]))
        for item in cycles
        if "monotonic" in item or "timestamp" in item
    ]
    intervals = [later - earlier for earlier, later in zip(timestamps, timestamps[1:])]
    configured_interval = float(
        config.get("reconcile_interval_seconds") or RECONCILE_INTERVAL_SECONDS
    )
    cpu_values = [
        float(value) for value in observation.get("cpu_percent_one_core", []) if value is not None
    ]
    initial_ledger = int(observation.get("initial_ledger_rows") or 0)
    final_ledger = int(observation.get("final_ledger_rows") or 0)
    checks = {
        "multiple_cycles_observed": len(cycles) >= 3,
        "cycle_counter_not_spinning": bool(intervals)
        and min(intervals) >= configured_interval * 0.5,
        "cycle_log_observed": int(observation.get("log_events") or 0) >= 1,
        "proxy_off_claimed_nothing": bool(cycles)
        and all(int(item.get("claimed") or 0) == 0 for item in cycles),
        "ledger_did_not_grow": final_ledger == initial_ledger == 0,
        "idle_cpu_bounded": bool(cpu_values) and mean(cpu_values) <= 35.0,
    }
    return _result(
        checks,
        {
            "cycles": len(cycles),
            "cycle_interval_seconds": _numeric_summary(intervals),
            "retained_log_events": int(observation.get("log_events") or 0),
            "initial_ledger_rows": initial_ledger,
            "final_ledger_rows": final_ledger,
            "cpu_percent_one_core": _numeric_summary(cpu_values),
        },
    )


def _evaluate_quota(observation: dict[str, Any]) -> dict[str, Any]:
    drift = [int(item.get("drift_bytes") or 0) for item in observation.get("steps", [])]
    checks = {
        "repeated_add_delete_observed": int(observation.get("iterations") or 0) >= 5,
        "every_reconciled_step_matches_disk": bool(drift) and all(value == 0 for value in drift),
        "final_counter_matches_disk": observation.get("final_accounted_bytes")
        == observation.get("final_actual_bytes"),
        "quota_errors_zero": not observation.get("errors", []),
    }
    return _result(
        checks,
        {
            "iterations": int(observation.get("iterations") or 0),
            "steps": len(drift),
            "max_absolute_drift_bytes": max((abs(value) for value in drift), default=None),
            "final_accounted_bytes": observation.get("final_accounted_bytes"),
            "final_actual_bytes": observation.get("final_actual_bytes"),
            "errors": observation.get("errors", []),
        },
    )


def _tail_resource_values(
    series: list[dict[str, Any]], key: str
) -> tuple[list[float], list[float]]:
    tail = series[max(0, len(series) // 4) :]
    values: list[float] = []
    elapsed: list[float] = []
    for item in tail:
        value = item.get(key)
        if value is None:
            continue
        values.append(float(value))
        elapsed.append(float(item.get("elapsed_seconds") or 0.0))
    return values, elapsed


def _evaluate_resources(observation: dict[str, Any]) -> dict[str, Any]:
    series = observation.get("series", [])
    rss, rss_elapsed = _tail_resource_values(series, "rss_bytes")
    threads, thread_elapsed = _tail_resource_values(series, "threads")
    handles, handle_elapsed = _tail_resource_values(series, "handles")
    rss_summary = _numeric_summary(rss, rss_elapsed)
    thread_summary = _numeric_summary(threads, thread_elapsed)
    handle_summary = _numeric_summary(handles, handle_elapsed)

    def growth(summary: dict[str, Any]) -> float:
        return max(0.0, float(summary.get("growth") or 0.0))

    def rate(summary: dict[str, Any]) -> float:
        return max(0.0, float(summary.get("growth_per_minute") or 0.0))

    checks = {
        "resource_samples_available": len(rss) >= 4
        and len(threads) == len(rss)
        and len(handles) == len(rss),
        "rss_growth_bounded": growth(rss_summary) <= RSS_GROWTH_LIMIT_BYTES
        and rate(rss_summary) <= RSS_RATE_LIMIT_BYTES_PER_MINUTE,
        "thread_growth_bounded": growth(thread_summary) <= THREAD_GROWTH_LIMIT
        and rate(thread_summary) <= THREAD_RATE_LIMIT_PER_MINUTE,
        "handle_growth_bounded": growth(handle_summary) <= HANDLE_GROWTH_LIMIT
        and rate(handle_summary) <= HANDLE_RATE_LIMIT_PER_MINUTE,
        "resource_ranges_bounded": bool(rss)
        and max(rss) - min(rss) <= 128 * 1024 * 1024
        and max(threads) - min(threads) <= 8
        and max(handles) - min(handles) <= 32,
    }
    return _result(
        checks,
        {
            "warmup_samples_excluded": len(series) - len(rss),
            "rss_bytes": rss_summary,
            "threads": thread_summary,
            "handles": handle_summary,
        },
    )


def _evaluate_observations(
    observations: dict[str, Any], config: dict[str, Any]
) -> dict[str, Any]:
    items = {
        "survival": _evaluate_survival(observations.get("survival", {})),
        "websocket_leak": _evaluate_websocket(observations.get("websocket", {})),
        "database_wal": _evaluate_database_wal(
            observations.get("database_wal", {}), config
        ),
        "log_rotation": _evaluate_logs(observations.get("logs", {}), config),
        "reconciler_idle": _evaluate_reconciler(
            observations.get("reconciler", {}), config
        ),
        "quota_accounting": _evaluate_quota(observations.get("quota", {})),
        "resources": _evaluate_resources(observations.get("resources", {})),
    }
    return {"passed": all(item["passed"] for item in items.values()), "items": items}


def _counts(values: list[Any]) -> dict[str, int]:
    counts: dict[str, int] = {}
    for value in values:
        key = str(value)
        counts[key] = counts.get(key, 0) + 1
    return counts


def _server_environment(data_dir: Path, db_path: Path, port: int) -> dict[str, str]:
    env = os.environ.copy()
    for name in (
        "CONTENT_HUB_SSL_CERTFILE",
        "CONTENT_HUB_SSL_KEYFILE",
        "CONTENT_HUB_SHARED_URL",
    ):
        env.pop(name, None)
    env.update(
        {
            "PYTHONUTF8": "1",
            "CONTENT_HUB_ENDURANCE_PROBE": "1",
            "CONTENT_HUB_DATA": str(data_dir),
            "CONTENT_HUB_DB": str(db_path),
            "CONTENT_HUB_MEDIA": str(data_dir / "media"),
            "CONTENT_HUB_BACKUP_DIR": str(data_dir / "backups"),
            "CONTENT_HUB_LOG_DIR": str(data_dir / "logs"),
            "CONTENT_HUB_AUTH": "1",
            "CONTENT_HUB_AUTH_SECRET": "endurance-probe-secret-not-for-production",
            "CONTENT_HUB_MANAGE": "1",
            "CONTENT_HUB_NO_PROXY": "1",
            "CONTENT_HUB_HOST": "127.0.0.1",
            "CONTENT_HUB_PORT": str(port),
            "CONTENT_HUB_SERVER_SYNC": "0",
            "CONTENT_HUB_ACCESS_LOG": "0",
            "CONTENT_HUB_FRONTEND_DIST": str(data_dir / "no-frontend"),
            "CONTENT_HUB_BACKUP_INTERVAL": str(BACKUP_INTERVAL_SECONDS),
            "CONTENT_HUB_BACKUP_POLL_INTERVAL": str(BACKUP_POLL_SECONDS),
            "CONTENT_HUB_BACKUP_KEEP": str(BACKUP_KEEP),
            "CONTENT_HUB_SHARE_RECONCILE_INTERVAL_SECONDS": str(
                RECONCILE_INTERVAL_SECONDS
            ),
            "CONTENT_HUB_METRICS_LOG_INTERVAL": str(METRICS_LOG_INTERVAL_SECONDS),
            "CONTENT_HUB_LOG_MAX_BYTES": str(LOG_MAX_BYTES),
            "CONTENT_HUB_LOG_KEEP": str(LOG_KEEP),
            "CONTENT_HUB_ENDURANCE_CYCLE_FILE": str(data_dir / "reconciler-cycles.jsonl"),
            "CONTENT_HUB_ENDURANCE_BACKUP_FILE": str(data_dir / "backup-cycles.jsonl"),
            "CONTENT_HUB_ENDURANCE_STOP_FILE": str(data_dir / "request-stop"),
            "CONTENT_HUB_ENDURANCE_WS_RECV_TIMEOUT": str(WS_RECV_TIMEOUT_SECONDS),
            "CONTENT_HUB_ENDURANCE_WS_GHOST_SECONDS": str(WS_GHOST_SECONDS),
        }
    )
    return env


def _run_isolated_server() -> int:
    """이 파일이 만든 임시 환경에서만 시간 가속 계측을 붙여 서버를 실행한다."""
    if os.environ.get("CONTENT_HUB_ENDURANCE_PROBE") != "1":
        raise RuntimeError("격리 지구력 프로브 표시가 없는 서버 실행을 거부합니다")
    if os.environ.get("CONTENT_HUB_NO_PROXY") != "1":
        raise RuntimeError("프록시가 꺼지지 않은 서버 실행을 거부합니다")
    if os.environ.get("CONTENT_HUB_HOST") != "127.0.0.1":
        raise RuntimeError("loopback이 아닌 서버 실행을 거부합니다")
    port = int(os.environ.get("CONTENT_HUB_PORT", "0"))
    if port < MIN_PROBE_PORT:
        raise RuntimeError(f"프로브 전용 포트({MIN_PROBE_PORT}+)가 아닙니다")
    data_dir = Path(os.environ["CONTENT_HUB_DATA"]).resolve()
    db_path = Path(os.environ["CONTENT_HUB_DB"]).resolve()
    if not db_path.is_relative_to(data_dir):
        raise RuntimeError("격리 DB가 격리 data 폴더 밖에 있습니다")

    if str(BACKEND) not in sys.path:
        sys.path.insert(0, str(BACKEND))
    from app import main as app_main
    from app.services import backup
    from app.services import share_state_reconciler as reconciler
    from app.deps import require_admin
    from app.services.operational_logging import log_event

    # 운영 상수는 건드리지 않는다. 이 별도 프로세스 메모리 안에서만 짧게 바꾼다.
    app_main._WS_RECV_TIMEOUT_SECONDS = float(
        os.environ["CONTENT_HUB_ENDURANCE_WS_RECV_TIMEOUT"]
    )
    app_main._WS_GHOST_SECONDS = float(
        os.environ["CONTENT_HUB_ENDURANCE_WS_GHOST_SECONDS"]
    )
    app_main._WS_AUTH_RECHECK_SECONDS = 0.5
    reconciler.periodic_share_state_reconciler._interval = RECONCILE_INTERVAL_SECONDS
    original_cycle = reconciler.run_share_state_reconciliation_cycle
    cycle_path = Path(os.environ["CONTENT_HUB_ENDURANCE_CYCLE_FILE"])

    async def measured_cycle(claim_token: str | None = None) -> dict[str, int]:
        started = time.perf_counter()
        counts = await original_cycle(claim_token)
        payload = {
            "timestamp": time.time(),
            "monotonic": time.monotonic(),
            "elapsed_ms": round((time.perf_counter() - started) * 1000.0, 3),
            "claimed": int(counts.get("claimed") or 0),
        }
        with cycle_path.open("a", encoding="utf-8") as output:
            output.write(json.dumps(payload, separators=(",", ":")) + "\n")
        log_event(
            reconciler._log,
            "endurance_reconciler_cycle",
            claimed=payload["claimed"],
            elapsed_ms=payload["elapsed_ms"],
        )
        return counts

    reconciler.run_share_state_reconciliation_cycle = measured_cycle
    original_backup_once = backup.periodic_backup._backup_once
    backup_cycle_path = Path(os.environ["CONTENT_HUB_ENDURANCE_BACKUP_FILE"])

    async def measured_backup_once() -> None:
        await original_backup_once()
        newest = backup.latest_backup_path()
        payload = {
            "timestamp": time.time(),
            "file": newest.name if newest is not None else None,
        }
        with backup_cycle_path.open("a", encoding="utf-8") as output:
            output.write(json.dumps(payload, separators=(",", ":")) + "\n")

    backup.periodic_backup._backup_once = measured_backup_once

    @app_main.app.post("/api/_endurance/ws-broadcast")
    async def endurance_ws_broadcast(request: Request) -> dict[str, Any]:
        require_admin(request)
        for sequence in range(WS_MESSAGES_PER_CYCLE):
            await app_main.manager.broadcast_all(
                {"type": "endurance_probe", "sequence": sequence}
            )
        return await app_main.manager.stats()

    import serve

    # Windows venv launcher PID와 실제 Python PID가 달라도 lifespan 종료를 거치도록 파일 기반의
    # 격리 전용 제어 신호를 Uvicorn Server.should_exit로 변환한다.
    stop_path = Path(os.environ["CONTENT_HUB_ENDURANCE_STOP_FILE"])
    original_server_factory = serve.uvicorn.Server

    def server_factory(config):
        server = original_server_factory(config)

        def watch_stop_file() -> None:
            while not server.should_exit:
                if stop_path.is_file():
                    server.should_exit = True
                    return
                time.sleep(0.1)

        threading.Thread(
            target=watch_stop_file,
            daemon=True,
            name="endurance-stop-watcher",
        ).start()
        return server

    serve.uvicorn.Server = server_factory

    serve.main()
    return 0


def _prepare_date_boundary_backups(db_path: Path, backup_dir: Path) -> list[str]:
    backup_dir.mkdir(parents=True, exist_ok=True)
    old_mtime = time.time() - 3600.0
    for index, name in enumerate(_BOUNDARY_BACKUPS):
        destination = backup_dir / name
        shutil.copy2(db_path, destination)
        os.utime(destination, (old_mtime + index, old_mtime + index))
    # 짝 DB가 없는 과거 WAL/SHM도 첫 회전에서 함께 수거돼야 한다.
    (backup_dir / "content_hub_20260818_120000_000000.db-wal").write_bytes(b"wal")
    (backup_dir / "content_hub_20260818_120000_000000.db-shm").write_bytes(b"shm")
    return list(_BOUNDARY_BACKUPS)


def _quota_probe(media_dir: Path, iterations: int = 12) -> dict[str, Any]:
    """격리 media 폴더에서 증분 추가와 삭제 뒤 재계산을 반복한다."""
    if str(BACKEND) not in sys.path:
        sys.path.insert(0, str(BACKEND))
    from app.services import media_cache

    old_media_dir = media_cache.MEDIA_DIR
    old_state = media_cache._PRESERVED_QUOTA_STATE
    state = media_cache._PreservedQuotaState()
    steps: list[dict[str, int | str]] = []
    errors: list[str] = []
    created: list[Path] = []
    media_dir.mkdir(parents=True, exist_ok=True)
    try:
        media_cache.MEDIA_DIR = media_dir
        media_cache._PRESERVED_QUOTA_STATE = state
        media_cache.recalculate_preserved_media_usage()
        for index in range(iterations):
            target = media_dir / f"{index:02x}" / f"endurance-{index:03d}.bin"
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(bytes([index % 251]) * (1024 + index * 17))
            media_cache._enforce_preserved_quota(target, newly_created=True)
            created.append(target)
            actual = media_cache.preserved_media_usage_bytes()
            steps.append(
                {
                    "operation": "add",
                    "accounted_bytes": state.total_bytes,
                    "actual_bytes": actual,
                    "drift_bytes": state.total_bytes - actual,
                }
            )
            if index % 2 == 1:
                deleted = created.pop(0)
                deleted.unlink()
                media_cache.recalculate_preserved_media_usage()
                actual = media_cache.preserved_media_usage_bytes()
                steps.append(
                    {
                        "operation": "delete_recalculate",
                        "accounted_bytes": state.total_bytes,
                        "actual_bytes": actual,
                        "drift_bytes": state.total_bytes - actual,
                    }
                )
    except Exception as exc:  # noqa: BLE001 — 판정 보고서에 진단을 남긴다.
        errors.append(f"{type(exc).__name__}: {exc}")
    finally:
        final_accounted = state.total_bytes
        final_actual = media_cache.preserved_media_usage_bytes()
        media_cache.MEDIA_DIR = old_media_dir
        media_cache._PRESERVED_QUOTA_STATE = old_state
    return {
        "iterations": iterations,
        "steps": steps,
        "final_accounted_bytes": final_accounted,
        "final_actual_bytes": final_actual,
        "errors": errors,
    }


def _file_size(path: Path) -> int:
    try:
        return path.stat().st_size
    except OSError:
        return 0


def _log_files_snapshot(log_dir: Path) -> dict[str, Any]:
    files = sorted(path for path in log_dir.glob("mvhub-runtime.jsonl*") if path.is_file())
    return {
        "file_count": len(files),
        "total_bytes": sum(_file_size(path) for path in files),
        "names": [path.name for path in files],
        "sizes": {path.name: _file_size(path) for path in files},
    }


def _backup_snapshot(backup_dir: Path) -> dict[str, Any]:
    names = sorted(path.name for path in backup_dir.glob("content_hub_*.db") if path.is_file())
    orphans: list[str] = []
    for sidecar in (*backup_dir.glob("*.db-wal"), *backup_dir.glob("*.db-shm")):
        base = backup_dir / sidecar.name.rsplit("-", 1)[0]
        if not base.is_file():
            orphans.append(sidecar.name)
    return {"names": names, "orphan_sidecars": sorted(orphans)}


def _read_json_lines(paths: list[Path]) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for path in paths:
        try:
            lines = path.read_text(encoding="utf-8", errors="replace").splitlines()
        except OSError:
            continue
        for line in lines:
            try:
                value = json.loads(line)
            except (TypeError, json.JSONDecodeError):
                continue
            if isinstance(value, dict):
                rows.append(value)
    return rows


def _redact_console_line(line: str) -> str:
    """Uvicorn WS handshake 로그의 query token을 실패 보고서에서 제거한다."""
    return re.sub(r"(?i)([?&]token=)[^\s\"']+", r"\1<redacted>", line)


def _ledger_rows(db_path: Path) -> int:
    try:
        # sqlite3.Connection의 context manager는 commit만 하고 close하지 않으므로 closing도 쓴다.
        with contextlib.closing(sqlite3.connect(str(db_path))) as connection:
            with connection:
                row = connection.execute("SELECT COUNT(*) FROM share_state_intent").fetchone()
        return int(row[0] if row else 0)
    except sqlite3.Error:
        return -1


async def _runtime_snapshot(base_url: str, token: str) -> dict[str, Any]:
    status, body, _ = await asyncio.to_thread(
        _http_json, base_url, "/api/admin/runtime", token=token, timeout=5.0
    )
    if status != 200 or not isinstance(body, dict):
        raise RuntimeError(f"런타임 지표 조회 실패(status={status}, body={body})")
    return body


async def _wait_ws_baseline(
    base_url: str,
    token: str,
    baseline: dict[str, Any],
    timeout: float = 3.0,
) -> dict[str, Any]:
    deadline = time.monotonic() + timeout
    last: dict[str, Any] = {}
    while time.monotonic() < deadline:
        snapshot = await _runtime_snapshot(base_url, token)
        last = snapshot.get("websocket", {})
        if (
            int(last.get("connections") or 0) == int(baseline.get("connections") or 0)
            and int(last.get("queued_messages") or 0)
            == int(baseline.get("queued_messages") or 0)
        ):
            return last
        await asyncio.sleep(0.1)
    return last


def _websocket_close_code(exc: BaseException) -> int | None:
    code = getattr(exc, "code", None)
    if isinstance(code, int):
        return code
    received = getattr(exc, "rcvd", None)
    code = getattr(received, "code", None)
    return int(code) if isinstance(code, int) else None


async def _websocket_churn(
    base_url: str,
    ws_url: str,
    token: str,
    stop: asyncio.Event,
    interval: float,
) -> dict[str, Any]:
    import websockets

    baseline_snapshot = await _runtime_snapshot(base_url, token)
    baseline = dict(baseline_snapshot.get("websocket", {}))
    result: dict[str, Any] = {
        "baseline": baseline,
        "final": baseline,
        "connections_per_cycle": WS_CONNECTIONS,
        "cycles": [],
        "ghost": {"observed": False, "close_code": None},
        "errors": [],
    }
    encoded = urllib.parse.quote(token, safe="")
    target = f"{ws_url}/ws?token={encoded}"
    ghost_done = False

    async def receive_cycle(socket: Any) -> list[int]:
        sequences: list[int] = []
        for _ in range(WS_MESSAGES_PER_CYCLE):
            raw = await asyncio.wait_for(socket.recv(), timeout=3.0)
            payload = json.loads(raw)
            if isinstance(payload, dict) and isinstance(payload.get("sequence"), int):
                sequences.append(payload["sequence"])
        return sequences

    while not stop.is_set():
        sockets: list[Any] = []
        delivery = {
            "clients": 0,
            "messages_per_client": 0,
            "fifo": False,
        }
        try:
            sockets = [
                await websockets.connect(
                    target, open_timeout=5, close_timeout=2, ping_interval=None
                )
                for _ in range(WS_CONNECTIONS)
            ]
            await asyncio.gather(*(socket.send("ping") for socket in sockets))
            broadcast_status, _broadcast_body, _ = await asyncio.to_thread(
                _http_json,
                base_url,
                "/api/_endurance/ws-broadcast",
                method="POST",
                token=token,
                timeout=5.0,
            )
            if broadcast_status != 200:
                raise RuntimeError(f"격리 WS broadcast 실패(status={broadcast_status})")
            received = await asyncio.gather(*(receive_cycle(socket) for socket in sockets))
            expected_sequence = list(range(WS_MESSAGES_PER_CYCLE))
            delivery = {
                "clients": len(received),
                "messages_per_client": min((len(item) for item in received), default=0),
                "fifo": all(item == expected_sequence for item in received),
            }
            active = await _runtime_snapshot(base_url, token)
            peak = dict(active.get("websocket", {}))
        except Exception as exc:  # noqa: BLE001
            result["errors"].append(f"connect_cycle:{type(exc).__name__}:{exc}")
            peak = {}
        finally:
            if sockets:
                await asyncio.gather(
                    *(socket.close(code=1000) for socket in sockets),
                    return_exceptions=True,
                )
        returned = await _wait_ws_baseline(base_url, token, baseline)
        result["cycles"].append(
            {"peak": peak, "returned": returned, "delivery": delivery}
        )

        if not ghost_done:
            ghost_done = True
            ghost = None
            try:
                ghost = await websockets.connect(
                    target, open_timeout=5, close_timeout=2, ping_interval=None
                )
                ghost_deadline = time.monotonic() + WS_GHOST_SECONDS + 2.0
                try:
                    # 다른 백그라운드 reload가 와도 그것은 클라이언트 heartbeat가 아니다.
                    # 서버 close를 받을 때까지 계속 읽어 유령 수거 신호 자체를 확인한다.
                    while True:
                        remaining = ghost_deadline - time.monotonic()
                        if remaining <= 0:
                            raise asyncio.TimeoutError
                        await asyncio.wait_for(ghost.recv(), timeout=remaining)
                except Exception as exc:  # 정상 1001 close도 예외 형태로 전달된다.
                    close_code = _websocket_close_code(exc)
                    result["ghost"] = {
                        "observed": close_code == 1001,
                        "close_code": close_code,
                    }
            except Exception as exc:  # noqa: BLE001
                result["errors"].append(f"ghost_cycle:{type(exc).__name__}:{exc}")
            finally:
                if ghost is not None:
                    with contextlib.suppress(Exception):
                        await ghost.close()
            await _wait_ws_baseline(base_url, token, baseline)

        try:
            await asyncio.wait_for(stop.wait(), timeout=max(0.5, interval))
        except asyncio.TimeoutError:
            pass
    result["final"] = await _wait_ws_baseline(base_url, token, baseline)
    return result


def _port_available(port: int) -> bool:
    import socket

    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        try:
            sock.bind(("127.0.0.1", port))
        except OSError:
            return False
    return True


def _wait_port_released(port: int, timeout: float = 5.0) -> bool:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if _port_available(port):
            return True
        time.sleep(0.1)
    return _port_available(port)


def _stop_process(
    process: subprocess.Popen[Any],
    port: int,
    listen_pid: int | None,
    stop_file: Path,
) -> dict[str, Any]:
    started = time.monotonic()
    forced = False
    graceful_signal = False
    if listen_pid is None:
        listen_pid = _listening_pid(port)
    listener_exited = listen_pid is None
    listener = None
    if listen_pid is not None:
        import psutil

        with contextlib.suppress(psutil.Error):
            listener = psutil.Process(listen_pid)
    if process.poll() is None:
        try:
            stop_file.write_text("stop\n", encoding="ascii")
            graceful_signal = True
        except OSError:
            process.terminate()
        try:
            process.wait(timeout=12)
        except subprocess.TimeoutExpired:
            forced = True
            if listener is not None:
                with contextlib.suppress(Exception):
                    listener.terminate()
                    listener.wait(timeout=5)
            if process.poll() is None:
                process.terminate()
                try:
                    process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait(timeout=5)
    if listener is not None:
        import psutil

        try:
            listener.wait(timeout=10)
            listener_exited = True
        except psutil.TimeoutExpired:
            forced = True
            with contextlib.suppress(psutil.Error):
                listener.terminate()
                listener.wait(timeout=5)
            try:
                listener_exited = not listener.is_running()
            except psutil.NoSuchProcess:
                listener_exited = True
        except psutil.NoSuchProcess:
            listener_exited = True
    return {
        "elapsed_seconds": round(time.monotonic() - started, 3),
        "return_code": process.returncode,
        "graceful_signal": graceful_signal,
        "forced_kill": forced,
        "listener_exited": listener_exited,
        "port_released": _wait_port_released(port),
    }


def _applied_cpu_cores(pid: int) -> int:
    import psutil

    available = psutil.Process(pid).cpu_affinity()
    return max(1, min(2, len(available)))


async def _collect_probe(args: argparse.Namespace) -> tuple[dict[str, Any], int]:
    if args.port < MIN_PROBE_PORT or args.port > 65535:
        raise ValueError(
            f"--port는 운영 포트와 분리된 {MIN_PROBE_PORT}~65535 범위여야 합니다"
        )
    if not _port_available(args.port):
        raise RuntimeError(f"프로브 전용 포트 {args.port}가 이미 사용 중입니다")

    base_url = f"http://127.0.0.1:{args.port}"
    ws_url = f"ws://127.0.0.1:{args.port}"
    config = {
        "duration_seconds": args.duration,
        "sample_interval_seconds": args.sample_interval,
        "base_url": base_url,
        "isolated_temp_data": True,
        "no_proxy": True,
        "server_priority": args.server_priority,
        "server_cpu_cores_max": 2,
        "ws_connections_per_cycle": WS_CONNECTIONS,
        "ws_ghost_seconds": WS_GHOST_SECONDS,
        "reconcile_interval_seconds": RECONCILE_INTERVAL_SECONDS,
        "backup_interval_seconds": BACKUP_INTERVAL_SECONDS,
        "backup_poll_seconds": BACKUP_POLL_SECONDS,
        "backup_keep": BACKUP_KEEP,
        "metrics_log_interval_seconds": METRICS_LOG_INTERVAL_SECONDS,
        "log_max_bytes": LOG_MAX_BYTES,
        "log_keep": LOG_KEEP,
    }
    with _temporary_load_root() as temporary_name:
        temp_root = Path(temporary_name)
        data_dir = temp_root / "data"
        db_path = data_dir / "content_hub.db"
        data_dir.mkdir(parents=True, exist_ok=True)
        # 시드 과정도 프록시 off와 임시 경로를 먼저 적용해 외부 접촉 가능성을 닫는다.
        os.environ.update(
            {
                "CONTENT_HUB_DATA": str(data_dir),
                "CONTENT_HUB_DB": str(db_path),
                "CONTENT_HUB_MEDIA": str(data_dir / "media"),
                "CONTENT_HUB_NO_PROXY": "1",
            }
        )
        accounts = _seed_database(data_dir, db_path, users=1, generations_per_user=1)
        backup_dir = data_dir / "backups"
        initial_backup_names = _prepare_date_boundary_backups(db_path, backup_dir)
        quota = _quota_probe(data_dir / "media")
        initial_ledger_rows = _ledger_rows(db_path)
        cycle_file = data_dir / "reconciler-cycles.jsonl"
        operational_log_dir = data_dir / "logs"
        console_log = temp_root / "server.log"
        creationflags = 0
        if os.name == "nt":
            creationflags = subprocess.CREATE_NO_WINDOW
        process: subprocess.Popen[Any] | None = None
        listen_pid: int | None = None
        shutdown: dict[str, Any] = {
            "elapsed_seconds": None,
            "return_code": None,
            "graceful_signal": None,
            "forced_kill": None,
            "listener_exited": False,
            "port_released": False,
        }
        samples: list[dict[str, Any]] = []
        websocket_observation: dict[str, Any] = {}
        limits: dict[str, Any] = {}
        token = ""
        seen_backup_names = set(initial_backup_names)
        seen_log_names: set[str] = set()
        process_alive = True
        with console_log.open("w", encoding="utf-8", errors="replace") as output:
            process = subprocess.Popen(
                [sys.executable, str(Path(__file__).resolve()), "--_isolated-server"],
                cwd=str(BACKEND),
                env=_server_environment(data_dir, db_path, args.port),
                stdout=output,
                stderr=subprocess.STDOUT,
                creationflags=creationflags,
            )
            try:
                await asyncio.to_thread(_wait_ready, base_url, process, timeout=45.0)
                listen_pid = _listening_pid(args.port)
                limited_pid = listen_pid or process.pid
                limits = _apply_server_limits(
                    limited_pid,
                    cpu_cores=_applied_cpu_cores(limited_pid),
                    priority=args.server_priority,
                )
                limits.update(
                    {
                        "launcher_pid": process.pid,
                        "listen_pid": listen_pid,
                        "limited_pid": limited_pid,
                    }
                )
                status, login_body, _ = await asyncio.to_thread(
                    _http_json,
                    base_url,
                    "/api/auth/login",
                    method="POST",
                    body={"email": accounts[0]["email"], "password": PASSWORD},
                    timeout=10.0,
                )
                token = login_body.get("token") if isinstance(login_body, dict) else ""
                if status != 200 or not token:
                    raise RuntimeError(f"격리 관리자 로그인 실패(status={status})")

                import psutil

                measured_process = psutil.Process(limited_pid)
                measured_process.cpu_percent(interval=None)
                stop_ws = asyncio.Event()
                ws_task = asyncio.create_task(
                    _websocket_churn(
                        base_url,
                        ws_url,
                        token,
                        stop_ws,
                        max(args.sample_interval, 0.5),
                    ),
                    name="endurance-ws-churn",
                )
                started = time.monotonic()
                deadline = started + args.duration
                try:
                    while True:
                        sample_started = time.monotonic()
                        elapsed = sample_started - started
                        health_result, ready_result = await asyncio.gather(
                            asyncio.to_thread(
                                _http_json, base_url, "/api/health", timeout=5.0
                            ),
                            asyncio.to_thread(
                                _http_json, base_url, "/api/ready", timeout=5.0
                            ),
                        )
                        runtime = await _runtime_snapshot(base_url, token)
                        disk = runtime.get("disk", {})
                        process_metrics = runtime.get("process", {})
                        logs = _log_files_snapshot(operational_log_dir)
                        backups = _backup_snapshot(backup_dir)
                        seen_log_names.update(logs["names"])
                        seen_backup_names.update(backups["names"])
                        try:
                            handles = measured_process.num_handles()
                            psutil_cpu = measured_process.cpu_percent(interval=None)
                        except (psutil.Error, AttributeError):
                            handles = None
                            psutil_cpu = None
                        process_alive = process_alive and process.poll() is None
                        samples.append(
                            {
                                "elapsed_seconds": round(elapsed, 3),
                                "health_status": int(health_result[0]),
                                "ready_status": int(ready_result[0]),
                                "db_bytes": _file_size(db_path),
                                "wal_bytes": _file_size(Path(str(db_path) + "-wal")),
                                "runtime_disk": {
                                    "db_bytes": disk.get("db_bytes"),
                                    "wal_bytes": disk.get("wal_bytes"),
                                },
                                "rss_bytes": process_metrics.get("rss_bytes"),
                                "threads": process_metrics.get("threads"),
                                "handles": handles,
                                "cpu_percent_one_core": psutil_cpu,
                                "websocket": runtime.get("websocket", {}),
                                "logs": logs,
                                "backups": backups,
                            }
                        )
                        if not args.quiet and (
                            len(samples) == 1
                            or int(elapsed) % max(5, int(args.sample_interval)) == 0
                        ):
                            print(
                                "[endurance] "
                                f"{elapsed:.1f}/{args.duration:.1f}s "
                                f"rss={process_metrics.get('rss_bytes')} "
                                f"wal={samples[-1]['wal_bytes']} "
                                f"ws={runtime.get('websocket', {}).get('connections', 0)}",
                                flush=True,
                            )
                        remaining = deadline - time.monotonic()
                        if remaining <= 0:
                            break
                        await asyncio.sleep(
                            min(remaining, max(0.0, args.sample_interval - (time.monotonic() - sample_started)))
                        )
                finally:
                    stop_ws.set()
                    try:
                        websocket_observation = await asyncio.wait_for(ws_task, timeout=8.0)
                    except Exception as exc:  # noqa: BLE001
                        ws_task.cancel()
                        with contextlib.suppress(asyncio.CancelledError):
                            await ws_task
                        websocket_observation = {
                            "baseline": {},
                            "final": {},
                            "connections_per_cycle": WS_CONNECTIONS,
                            "cycles": [],
                            "ghost": {"observed": False, "close_code": None},
                            "errors": [f"ws_task:{type(exc).__name__}:{exc}"],
                        }
            finally:
                shutdown = _stop_process(
                    process,
                    args.port,
                    listen_pid,
                    data_dir / "request-stop",
                )

        cycle_rows = _read_json_lines([cycle_file])
        backup_cycle_rows = _read_json_lines([data_dir / "backup-cycles.jsonl"])
        seen_backup_names.update(
            str(row["file"])
            for row in backup_cycle_rows
            if isinstance(row.get("file"), str) and row["file"]
        )
        operational_files = sorted(operational_log_dir.glob("mvhub-runtime.jsonl*"))
        operational_rows = _read_json_lines(operational_files)
        error_events = [
            row
            for row in operational_rows
            if row.get("level") in {"ERROR", "CRITICAL"}
        ]
        reconciler_log_events = sum(
            1 for row in operational_rows if row.get("event") == "endurance_reconciler_cycle"
        )
        final_backup = _backup_snapshot(backup_dir)
        final_ledger_rows = _ledger_rows(db_path)
        log_series = [
            {"elapsed_seconds": item["elapsed_seconds"], **item["logs"]}
            for item in samples
        ]
        observations = {
            "survival": {
                "health_statuses": [item["health_status"] for item in samples],
                "ready_statuses": [item["ready_status"] for item in samples],
                "process_alive": process_alive,
                "shutdown": shutdown,
            },
            "websocket": websocket_observation,
            "database_wal": {
                "series": [
                    {
                        "elapsed_seconds": item["elapsed_seconds"],
                        "db_bytes": item["db_bytes"],
                        "wal_bytes": item["wal_bytes"],
                    }
                    for item in samples
                ],
                "backups": {
                    "initial_names": initial_backup_names,
                    "seen_names": sorted(seen_backup_names),
                    "final_names": final_backup["names"],
                    "final_orphan_sidecars": final_backup["orphan_sidecars"],
                },
            },
            "logs": {
                "series": log_series,
                "names_seen": sorted(seen_log_names),
                "error_events": error_events,
            },
            "reconciler": {
                "cycles": cycle_rows,
                "log_events": reconciler_log_events,
                "initial_ledger_rows": initial_ledger_rows,
                "final_ledger_rows": final_ledger_rows,
                "cpu_percent_one_core": [
                    item["cpu_percent_one_core"] for item in samples
                ],
            },
            "quota": quota,
            "resources": {
                "series": [
                    {
                        "elapsed_seconds": item["elapsed_seconds"],
                        "rss_bytes": item["rss_bytes"],
                        "threads": item["threads"],
                        "handles": item["handles"],
                    }
                    for item in samples
                ]
            },
        }
        verdict = _evaluate_observations(observations, config)
        console_tail = []
        try:
            console_tail = console_log.read_text(
                encoding="utf-8", errors="replace"
            ).splitlines()[-80:]
            console_tail = [_redact_console_line(line) for line in console_tail]
        except OSError:
            pass
        report = {
            "verdict": verdict,
            "config": config,
            "server_limits": limits,
            "time_series": samples,
            "observations": {
                "websocket": websocket_observation,
                "quota": quota,
                "reconciler_cycles": cycle_rows,
                "backup_cycles": backup_cycle_rows,
                "shutdown": shutdown,
            },
        }
        if not verdict["passed"]:
            report["operational_error_events"] = error_events[-20:]
            report["server_log_tail"] = console_tail
        # 시드에 재사용한 부모 프로세스 DB 풀까지 닫아 Windows 임시 폴더 삭제를 막는 핸들을 없앤다.
        from app import db as parent_db

        parent_db.flush_pool()
        gc.collect()
        return report, 0 if verdict["passed"] else 2


def _parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="MV Hub 시간 의존 격리 지구력 프로브")
    parser.add_argument("--duration", type=float, default=20.0)
    parser.add_argument("--port", type=int, default=DEFAULT_PORT)
    parser.add_argument(
        "--server-priority",
        choices=("normal", "below-normal"),
        default="below-normal",
    )
    parser.add_argument("--sample-interval", type=float, default=1.0)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--quiet", action="store_true")
    args = parser.parse_args(argv)
    if not math.isfinite(args.duration) or args.duration < 3.0:
        parser.error("--duration은 3초 이상의 유한한 값이어야 합니다")
    if not math.isfinite(args.sample_interval) or args.sample_interval < 0.25:
        parser.error("--sample-interval은 0.25초 이상의 유한한 값이어야 합니다")
    return args


def _run_async(args: argparse.Namespace) -> tuple[dict[str, Any], int]:
    if os.name == "nt":
        with asyncio.Runner(loop_factory=asyncio.SelectorEventLoop) as runner:
            return runner.run(_collect_probe(args))
    return asyncio.run(_collect_probe(args))


def main(argv: list[str] | None = None) -> int:
    args = _parse_args(argv)
    try:
        report, exit_code = _run_async(args)
    except Exception as exc:  # noqa: BLE001 — 자동 실행기가 읽을 수 있는 실패 JSON을 남긴다.
        report = {
            "verdict": {"passed": False, "items": {}},
            "error": f"{type(exc).__name__}: {exc}",
        }
        exit_code = 1
    if args.output:
        _atomic_write_json(args.output.resolve(), report)
    if not args.quiet:
        if args.output:
            print(
                json.dumps(
                    {
                        "passed": report.get("verdict", {}).get("passed", False),
                        "output": str(args.output.resolve()),
                        "error": report.get("error"),
                    },
                    ensure_ascii=False,
                )
            )
        else:
            print(json.dumps(report, ensure_ascii=False, indent=2))
    return exit_code


if __name__ == "__main__":
    if sys.argv[1:] == ["--_isolated-server"]:
        raise SystemExit(_run_isolated_server())
    raise SystemExit(main())

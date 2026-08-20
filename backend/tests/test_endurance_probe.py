"""시간 의존 지구력 프로브의 순수 판정 계약."""

from __future__ import annotations

import copy
import importlib.util
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location(
    "endurance_probe",
    ROOT / "tools" / "endurance_probe.py",
)
assert SPEC and SPEC.loader
endurance = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(endurance)


def _healthy_contract():
    initial_backups = list(endurance._BOUNDARY_BACKUPS)
    generated = [
        "content_hub_20260820_120000_000001.db",
        "content_hub_20260820_120005_000002.db",
        "content_hub_20260820_120010_000003.db",
    ]
    elapsed = [float(index * 30) for index in range(8)]
    observations = {
        "survival": {
            "health_statuses": [200] * 8,
            "ready_statuses": [200] * 8,
            "process_alive": True,
            "shutdown": {
                "elapsed_seconds": 0.5,
                "return_code": 0,
                "listener_exited": True,
                "forced_kill": False,
                "port_released": True,
            },
        },
        "websocket": {
            "baseline": {"connections": 0, "queued_messages": 0},
            "final": {"connections": 0, "queued_messages": 0},
            "connections_per_cycle": 4,
            "cycles": [
                {
                    "peak": {"connections": 4, "queued_messages": 0},
                    "returned": {"connections": 0, "queued_messages": 0},
                    "delivery": {
                        "clients": 4,
                        "messages_per_client": 8,
                        "fifo": True,
                    },
                },
                {
                    "peak": {"connections": 4, "queued_messages": 0},
                    "returned": {"connections": 0, "queued_messages": 0},
                    "delivery": {
                        "clients": 4,
                        "messages_per_client": 8,
                        "fifo": True,
                    },
                },
            ],
            "ghost": {"observed": True, "close_code": 1001},
            "errors": [],
        },
        "database_wal": {
            "series": [
                {"elapsed_seconds": value, "db_bytes": 1_000_000, "wal_bytes": 4096}
                for value in elapsed
            ],
            "backups": {
                "initial_names": initial_backups,
                "seen_names": initial_backups + generated,
                "final_names": generated[-2:],
                "final_orphan_sidecars": [],
            },
        },
        "logs": {
            "series": [
                {
                    "elapsed_seconds": value,
                    "file_count": 2,
                    "total_bytes": 24_000 + index * 100,
                }
                for index, value in enumerate(elapsed)
            ],
            "names_seen": ["mvhub-runtime.jsonl", "mvhub-runtime.jsonl.1"],
            "error_events": [],
        },
        "reconciler": {
            "cycles": [
                {"timestamp": float(index), "claimed": 0} for index in range(6)
            ],
            "log_events": 3,
            "initial_ledger_rows": 0,
            "final_ledger_rows": 0,
            "cpu_percent_one_core": [1.0, 2.0, 1.5, 2.5],
        },
        "quota": {
            "iterations": 12,
            "steps": [{"drift_bytes": 0} for _ in range(18)],
            "final_accounted_bytes": 8192,
            "final_actual_bytes": 8192,
            "errors": [],
        },
        "resources": {
            "series": [
                {
                    "elapsed_seconds": value,
                    "rss_bytes": 128 * 1024 * 1024,
                    "threads": 11,
                    "handles": 270,
                }
                for value in elapsed
            ]
        },
    }
    config = {
        "backup_keep": 2,
        "log_max_bytes": 16 * 1024,
        "log_keep": 2,
        "reconcile_interval_seconds": 1.0,
    }
    return observations, config


def test_contract_accepts_stable_observations():
    observations, config = _healthy_contract()

    verdict = endurance._evaluate_observations(observations, config)

    assert verdict["passed"] is True
    assert all(item["passed"] for item in verdict["items"].values())


def test_contract_rejects_each_time_dependent_anomaly():
    observations, config = _healthy_contract()
    cases = {}

    bad = copy.deepcopy(observations)
    bad["survival"]["ready_statuses"][3] = 503
    cases["survival"] = bad

    # FIN 없는 연결을 인위적으로 남긴 것과 같은 통계/close 결과를 합성한다.
    bad = copy.deepcopy(observations)
    bad["websocket"]["ghost"] = {"observed": False, "close_code": None}
    bad["websocket"]["final"] = {"connections": 1, "queued_messages": 3}
    cases["websocket_leak"] = bad

    bad = copy.deepcopy(observations)
    quiet_wal = [100_000, 200_000, 300_000, 400_000]
    for item, wal_bytes in zip(bad["database_wal"]["series"][4:], quiet_wal):
        item["wal_bytes"] = wal_bytes
    cases["database_wal"] = bad

    bad = copy.deepcopy(observations)
    for item in bad["logs"]["series"]:
        item["file_count"] = 1
    cases["log_rotation"] = bad

    bad = copy.deepcopy(observations)
    bad["reconciler"]["cycles"] = [
        {"timestamp": index * 0.01, "claimed": 0} for index in range(20)
    ]
    bad["reconciler"]["final_ledger_rows"] = 5
    cases["reconciler_idle"] = bad

    bad = copy.deepcopy(observations)
    bad["quota"]["steps"][-1]["drift_bytes"] = 4096
    bad["quota"]["final_accounted_bytes"] += 4096
    cases["quota_accounting"] = bad

    bad = copy.deepcopy(observations)
    for index, item in enumerate(bad["resources"]["series"]):
        item["rss_bytes"] += index * 80 * 1024 * 1024
        item["threads"] += index * 3
        item["handles"] += index * 20
    cases["resources"] = bad

    for expected_failed_item, candidate in cases.items():
        verdict = endurance._evaluate_observations(candidate, config)
        assert verdict["passed"] is False, expected_failed_item
        assert verdict["items"][expected_failed_item]["passed"] is False


def test_isolated_environment_overrides_only_temp_paths_and_safe_port():
    data_dir = Path(r"C:\Temp\mvhub-endurance\data")
    db_path = data_dir / "content_hub.db"

    env = endurance._server_environment(data_dir, db_path, 18092)

    assert env["CONTENT_HUB_NO_PROXY"] == "1"
    assert env["CONTENT_HUB_HOST"] == "127.0.0.1"
    assert env["CONTENT_HUB_PORT"] == "18092"
    assert Path(env["CONTENT_HUB_DB"]) == db_path
    assert Path(env["CONTENT_HUB_MEDIA"]).is_relative_to(data_dir)
    assert Path(env["CONTENT_HUB_BACKUP_DIR"]).is_relative_to(data_dir)
    assert Path(env["CONTENT_HUB_LOG_DIR"]).is_relative_to(data_dir)

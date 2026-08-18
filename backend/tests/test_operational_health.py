from __future__ import annotations

import os
import json
import tempfile
from pathlib import Path

from app import db, repo
from app.services import operational_health


def test_generation_queue_snapshot_reports_stalled_work_without_identity():
    with tempfile.TemporaryDirectory() as tmp:
        old = os.environ.get("CONTENT_HUB_DB")
        os.environ["CONTENT_HUB_DB"] = str(Path(tmp) / "content_hub.db")
        db.flush_pool()
        try:
            db.init_db()
            repo.ensure_default_worker()
            gen_id = repo.create_local_generation(
                {"model": "test-model", "prompt": "secret prompt"}, "me"
            )
            request_id = repo.create_gen_request(
                "private@example.com", None, gen_id, "create", {"model": "test-model"}
            )
            with db.get_connection() as conn:
                conn.execute(
                    "UPDATE gen_request SET status='submitting', "
                    "updated_at=datetime('now','-11 minutes'), check_failures=2 WHERE id=?",
                    (request_id,),
                )

            snapshot = operational_health.generation_queue_snapshot()
            assert snapshot["phase_counts"]["submitting"] == 1
            assert snapshot["active_total"] == 1
            assert snapshot["unanchored_over_10m"] == 1
            assert snapshot["recovery_required_total"] == 0
            assert snapshot["check_failures_total"] == 2
            assert "private@example.com" not in repr(snapshot)
            assert "secret prompt" not in repr(snapshot)
        finally:
            db.flush_pool()
            if old is None:
                os.environ.pop("CONTENT_HUB_DB", None)
            else:
                os.environ["CONTENT_HUB_DB"] = old
            db.flush_pool()


def test_database_readiness_checks_core_tables(monkeypatch):
    with tempfile.TemporaryDirectory() as tmp:
        old = os.environ.get("CONTENT_HUB_DB")
        os.environ["CONTENT_HUB_DB"] = str(Path(tmp) / "content_hub.db")
        db.flush_pool()
        try:
            db.init_db()
            monkeypatch.setattr(operational_health, "MANAGE_ENABLED", False)
            result = operational_health.database_readiness()
            assert result["ready"] is True
            assert result["checks"]["content"] == "ok"
            assert result["checks"]["manage"] == "disabled"

            with db.get_connection() as conn:
                conn.execute("DROP TABLE audit_event")
            result = operational_health.database_readiness()
            assert result["ready"] is False
            assert result["checks"]["content"] == "OperationalError"
        finally:
            db.flush_pool()
            if old is None:
                os.environ.pop("CONTENT_HUB_DB", None)
            else:
                os.environ["CONTENT_HUB_DB"] = old
            db.flush_pool()


def test_ready_endpoint_reports_maintenance_without_waiting_for_database(monkeypatch):
    from app import main as app_main

    monkeypatch.setattr(app_main, "maintenance_active", lambda: True)
    monkeypatch.setattr(
        app_main,
        "database_readiness",
        lambda: (_ for _ in ()).throw(AssertionError("maintenance must not probe the DB")),
    )

    response = app_main.ready()
    assert response.status_code == 503
    assert response.headers["retry-after"] == "5"
    assert response.body == b'{"status":"maintenance","retry_after_seconds":5}'


def test_database_maintenance_flag_is_scoped_to_the_gate():
    assert db.maintenance_active() is False
    with db.maintenance_gate():
        assert db.maintenance_active() is True
    assert db.maintenance_active() is False


def test_telemetry_snapshot_exposes_backlog_without_error_text(monkeypatch):
    with tempfile.TemporaryDirectory() as tmp:
        old = os.environ.get("CONTENT_HUB_DB")
        os.environ["CONTENT_HUB_DB"] = str(Path(tmp) / "content_hub.db")
        db.flush_pool()
        try:
            monkeypatch.setattr(operational_health, "AUTH_ENABLED", False)
            db.init_db()
            repo.ensure_default_worker()
            gen_id = repo.create_local_generation(
                {"model": "test-model", "prompt": "private"}, "me"
            )
            from app.repo import manage

            manage.mark_telemetry_dirty([gen_id])
            with db.get_connection() as conn:
                conn.execute(
                    "UPDATE telemetry_outbox SET dirty_at=datetime('now','-20 minutes'), "
                    "last_error='https://private.example failed for person@example.com' "
                    "WHERE local_gen_id=?",
                    (gen_id,),
                )
            result = operational_health.telemetry_snapshot()
            assert result["pending"] == 1
            assert result["failed"] == 1
            assert result["oldest_age_seconds"] >= 1190
            assert "private.example" not in repr(result)
            assert "person@example.com" not in repr(result)
        finally:
            db.flush_pool()
            if old is None:
                os.environ.pop("CONTENT_HUB_DB", None)
            else:
                os.environ["CONTENT_HUB_DB"] = old
            db.flush_pool()


def test_shared_server_ignores_legacy_local_telemetry_outbox(monkeypatch):
    monkeypatch.setattr(operational_health, "AUTH_ENABLED", True)
    monkeypatch.delenv("CONTENT_HUB_NO_PROXY", raising=False)
    monkeypatch.setattr(
        operational_health,
        "telemetry_outbox_status",
        lambda: (_ for _ in ()).throw(AssertionError("shared server must not read local outbox")),
    )

    assert operational_health.telemetry_snapshot() == {
        "pending": 0,
        "failed": 0,
        "oldest_age_seconds": None,
        "applicable": False,
    }


def test_shared_server_ignores_local_generation_queue(monkeypatch):
    monkeypatch.setattr(operational_health, "AUTH_ENABLED", True)
    monkeypatch.delenv("CONTENT_HUB_NO_PROXY", raising=False)
    monkeypatch.setattr(
        operational_health,
        "get_connection",
        lambda: (_ for _ in ()).throw(AssertionError("shared server must not read local queue")),
    )

    assert operational_health.generation_queue_snapshot() == {
        "phase_counts": {},
        "active_total": 0,
        "oldest_active_age_seconds": 0,
        "overdue_checks": 0,
        "check_failures_total": 0,
        "unanchored_over_10m": 0,
        "recovery_required_total": 0,
        "applicable": False,
    }


def test_media_preservation_snapshot_exposes_only_safe_counts(monkeypatch):
    monkeypatch.setattr(
        operational_health,
        "media_preservation_counts",
        lambda: {"pending": 3, "running": 1, "partial": 2, "failed": 1, "capacity": 4},
    )

    assert operational_health.media_preservation_snapshot() == {
        "status_counts": {
            "pending": 3,
            "running": 1,
            "partial": 2,
            "failed": 1,
            "capacity": 4,
        },
        "active": 4,
        "attention": 7,
    }


def test_replica_snapshot_exposes_structured_status_without_paths(tmp_path, monkeypatch):
    status_file = tmp_path / "backup_replica_status.json"
    status_file.write_text(
        json.dumps(
            {
                "format": "mvhub-backup-replica-status",
                "state": "failed",
                "configured": True,
                "last_attempt_at": "2026-08-17T00:00:00+00:00",
                "last_success_at": None,
                "error_code": "target_unavailable",
                "failed": 2,
                "private_path": r"\\NAS\private\person@example.com",
            }
        ),
        encoding="utf-8",
    )
    monkeypatch.setattr(operational_health, "AUTH_ENABLED", True)
    # 공식 전체 테스트 명령은 외부 서버 차단을 위해 NO_PROXY=1로 실행한다. 이 테스트는
    # 공유 서버 런타임 자체를 검증하므로 자신의 조건을 완전히 설정해 외부 env에 의존하지 않는다.
    monkeypatch.delenv("CONTENT_HUB_NO_PROXY", raising=False)
    monkeypatch.setattr(operational_health, "_REPLICA_STATUS_FILE", status_file)

    result = operational_health.backup_replica_snapshot()
    assert result["state"] == "failed"
    assert result["error_code"] == "target_unavailable"
    assert result["failed"] == 2
    assert "private" not in repr(result).lower()
    assert "person@example.com" not in repr(result)


def test_worker_backup_snapshot_reports_only_safe_counts(monkeypatch):
    from app.services import worker_backup

    monkeypatch.setattr(operational_health, "AUTH_ENABLED", False)
    monkeypatch.delenv("CONTENT_HUB_NO_PROXY", raising=False)
    monkeypatch.setattr(
        worker_backup,
        "status_snapshot",
        lambda: {
            "state": "failed",
            "pending": 3,
            "failed": 1,
            "last_error_code": "network_unavailable",
            "oldest_pending_at": "2026-08-17T00:00:00+00:00",
            "private_path": r"C:\Users\Person\secret.db",
        },
    )

    result = operational_health.worker_backup_snapshot()
    assert result["state"] == "failed"
    assert result["pending"] == 3
    assert result["last_error_code"] == "network_unavailable"
    assert "secret.db" not in repr(result)


def test_backup_attention_includes_login_wait_and_replica_never_run():
    tracker = operational_health.OperationalAlertTracker(repeat_seconds=100)
    snapshot = {
        "operations": {
            "generation_queue": {},
            "telemetry": {},
            "media_preservation": {},
            "worker_backup": {
                "applicable": True,
                "state": "login_required",
                "pending": 2,
                "failed": 0,
            },
            "backup_replica": {
                "applicable": True,
                "state": "never_run",
                "configured": False,
                "failed": 0,
            },
            "databases": {"ready": True},
        }
    }

    assert {row["event"] for row in tracker.events(snapshot, now=0)} == {
        "worker_backup_attention",
        "backup_replica_attention",
    }


def test_operational_alert_tracker_suppresses_repeated_noise_and_rearms_after_clear():
    tracker = operational_health.OperationalAlertTracker(repeat_seconds=100)
    bad = {
        "operations": {
            "generation_queue": {
                "overdue_checks": 1,
                "check_failures_total": 2,
                "unanchored_over_10m": 0,
            },
            "telemetry": {"pending": 4, "failed": 1, "oldest_age_seconds": 800},
            "media_preservation": {
                "attention": 2,
                "status_counts": {"partial": 1, "failed": 0, "capacity": 1},
            },
            "databases": {"ready": True},
        }
    }
    first = tracker.events(bad, now=0)
    assert {row["event"] for row in first} == {
        "generation_queue_attention",
        "telemetry_backlog",
        "media_preservation_attention",
    }
    assert tracker.events(bad, now=10) == []
    aging = {
        "operations": {
            **bad["operations"],
            "telemetry": {"pending": 4, "failed": 1, "oldest_age_seconds": 801},
        }
    }
    assert tracker.events(aging, now=11) == []
    assert len(tracker.events(bad, now=101)) == 3

    healthy = {
        "operations": {
            "generation_queue": {},
            "telemetry": {"pending": 0, "failed": 0, "oldest_age_seconds": None},
            "databases": {"ready": True},
        }
    }
    assert tracker.events(healthy, now=102) == []
    assert len(tracker.events(bad, now=103)) == 3

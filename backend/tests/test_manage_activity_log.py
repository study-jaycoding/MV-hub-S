from types import SimpleNamespace

from app import manage_db
from app.routers import manage as manage_router
from app.routers.manage import TelemetryFactIn, TelemetryPushIn, _telemetry_activity_summary


def test_telemetry_activity_summary_groups_statuses_without_identity():
    items = [
        {"status": "running", "creator_name": "private"},
        {"status": "done", "creator_name": "private"},
        {"status": "failed", "creator_name": "private"},
    ]
    result = _telemetry_activity_summary(items, upserted=2, skipped=["hidden-id"])

    assert result == {
        "received_items": 3,
        "upserted_items": 2,
        "skipped_items": 1,
        "active_items": 1,
        "completed_items": 1,
        "failed_items": 1,
    }
    assert "private" not in repr(result) and "hidden-id" not in repr(result)


def test_telemetry_push_logs_only_aggregate_activity(monkeypatch):
    captured = {}
    monkeypatch.setattr(
        manage_router,
        "_push_acc",
        lambda _request: {
            "email": "private@example.com",
            "creator_uid": "private-uid",
            "name": "Paul",
        },
    )
    monkeypatch.setattr(manage_db, "upsert_facts", lambda *_args: (1, []))

    def capture(_logger, event, **fields):
        captured.update({"event": event, **fields})

    monkeypatch.setattr(manage_router, "log_event", capture)
    body = TelemetryPushIn(
        items=[
            TelemetryFactIn(
                local_gen_id="private-generation-id",
                creator_name="Private Person",
                status="done",
            )
        ]
    )

    assert manage_router.telemetry_push(body, SimpleNamespace()) == {
        "upserted": 1,
        "skipped": [],
    }
    assert captured == {
        "event": "worker_telemetry_received",
        "worker_name": "Paul",
        "received_items": 1,
        "upserted_items": 1,
        "skipped_items": 0,
        "active_items": 0,
        "completed_items": 1,
        "failed_items": 0,
    }
    assert "private" not in repr(captured).lower()

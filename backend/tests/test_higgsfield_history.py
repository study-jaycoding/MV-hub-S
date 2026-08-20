from __future__ import annotations

import asyncio
import json
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from unittest import mock

import pytest

from app import db, repo
from app.models import IngestIn, IngestOut
from app.routers import ingest
from app.services import cli_bridge, higgsfield_history, syncer
from app.services import history_autofill as autofill


@pytest.fixture
def history_db(tmp_path, monkeypatch):
    monkeypatch.setenv("CONTENT_HUB_DB", str(tmp_path / "content_hub.db"))
    db.flush_pool()
    db.init_db()
    try:
        yield
    finally:
        autofill._HISTORY_STATES.clear()
        autofill._HISTORY_TASKS.clear()
        db.flush_pool()


def test_decode_sse_and_parse_history_page() -> None:
    rpc = {
        "jsonrpc": "2.0",
        "id": 1,
        "result": {
            "content": [{"type": "text", "text": "gallery"}],
            "structuredContent": {
                "items": [{"id": "job-1", "status": "completed"}],
                "next_cursor": 123.5,
            },
        },
    }
    raw = f"event: message\ndata: {json.dumps(rpc)}\n\n".encode()

    decoded = higgsfield_history._decode_response(raw, "text/event-stream")
    page = higgsfield_history._page_from_rpc(decoded)

    assert [item["id"] for item in page.items] == ["job-1"]
    assert page.next_cursor == 123.5


def test_fetch_page_sends_cursor_without_exposing_token() -> None:
    received = {}

    def fake_post(token, payload, timeout):
        received.update(token=token, payload=payload, timeout=timeout)
        return {
            "result": {
                "structuredContent": {"items": [], "next_cursor": None},
                "content": [],
            }
        }

    with mock.patch.object(higgsfield_history, "_post", side_effect=fake_post):
        page = asyncio.run(higgsfield_history.fetch_page("private-token", "42", size=999))

    assert page.items == []
    assert received["payload"]["params"]["arguments"] == {"size": 100, "cursor": "42"}
    assert "private-token" not in json.dumps(received["payload"])


def test_cli_auth_token_accepts_plain_and_json_shapes() -> None:
    async def plain(*_args, **_kwargs):
        return "opaque-token\n"

    async def as_json(*_args, **_kwargs):
        return '{"access_token":"json-token"}'

    with mock.patch.object(cli_bridge, "_run", side_effect=plain):
        assert asyncio.run(cli_bridge.get_auth_token()) == "opaque-token"
    with mock.patch.object(cli_bridge, "_run", side_effect=as_json):
        assert asyncio.run(cli_bridge.get_auth_token()) == "json-token"


def test_history_import_walks_all_pages_and_accumulates_counts() -> None:
    key = "worker@example.com"
    autofill._HISTORY_STATES[key] = {
        **autofill._history_idle(),
        "state": "running",
    }
    pages = iter(
        [
            higgsfield_history.HistoryPage([{"id": "one"}], 10),
            higgsfield_history.HistoryPage([{"id": "two"}], None),
        ]
    )

    async def account_status(*_args, **_kwargs):
        return {"connected": True, "email": key, "credits": 1, "plan": "test"}

    async def auth_token(*_args, **_kwargs):
        return "secret"

    async def fetch(*_args, **_kwargs):
        return next(pages)

    applied = iter(
        [
            SimpleNamespace(inserted=1, updated=0, unchanged=0, skipped=0, errors=0),
            SimpleNamespace(inserted=0, updated=1, unchanged=0, skipped=0, errors=0),
        ]
    )
    with (
        mock.patch.object(cli_bridge, "get_account_status", side_effect=account_status),
        mock.patch.object(cli_bridge, "get_auth_token", side_effect=auth_token),
        mock.patch.object(higgsfield_history, "fetch_page", side_effect=fetch),
        mock.patch.object(autofill, "mcp_item_to_cli", side_effect=lambda item: item),
        mock.patch.object(autofill, "_INGEST_RUNNER", side_effect=lambda *_args: next(applied)),
        mock.patch.object(autofill.repo, "complete_history_import"),
        mock.patch.object(autofill, "MANAGE_ENABLED", False),
    ):
        asyncio.run(autofill._run_history_import(key, {"email": "local"}))

    state = autofill._HISTORY_STATES.pop(key)
    assert state["state"] == "complete"
    assert state["pages"] == 2
    assert state["received"] == 2
    assert state["inserted"] == 1
    assert state["updated"] == 1
    assert "secret" not in json.dumps(state)


def test_gap_persists_auto_starts_and_redetection_obeys_cooldown(history_db) -> None:
    email = "worker@example.com"
    first = datetime(2026, 8, 20, 0, 0, tzinfo=timezone.utc)
    repo.mark_history_gap(email, detected_at=first)

    async def scenario() -> tuple[bool, bool]:
        with (
            mock.patch.object(autofill, "AUTH_ENABLED", False),
            mock.patch.object(autofill, "LOCAL_AGENT_PAIR_SECRET", ""),
            mock.patch.object(autofill, "EXTERNAL_RECOVERY_ENABLED", True),
            mock.patch.object(autofill, "HISTORY_AUTO_COOLDOWN_SECONDS", 6 * 60 * 60),
            mock.patch.object(autofill, "_history_key", return_value=email),
            mock.patch.object(autofill, "_start_history_task", return_value=True) as start,
        ):
            started = await autofill.auto_start_history_import(
                email, reason="gap", started_at=first
            )
            repo.complete_history_import(email, completed_at=first + timedelta(minutes=1))
            repo.mark_history_gap(email, detected_at=first + timedelta(minutes=2))
            restarted = await autofill.auto_start_history_import(
                email, reason="gap", started_at=first + timedelta(minutes=2)
            )
        assert start.call_count == 1
        return started, restarted

    assert asyncio.run(scenario()) == (True, False)
    audit = repo.get_history_import_audit(email)
    assert audit["gap_detected_at"] == (first + timedelta(minutes=2)).isoformat()
    assert audit["gap_resolved_at"] is None
    snapshot = autofill._history_snapshot(email)
    assert snapshot["gap_detected_at"] == audit["gap_detected_at"]
    assert snapshot["gap_resolved"] is False
    assert snapshot["gap_auto_started"] is False


def test_server_mode_never_auto_starts_history(history_db) -> None:
    email = "worker@example.com"
    repo.mark_history_gap(email)

    async def scenario() -> bool:
        with (
            mock.patch.object(autofill, "AUTH_ENABLED", True),
            mock.patch.object(autofill, "LOCAL_AGENT_PAIR_SECRET", ""),
            mock.patch.object(autofill, "EXTERNAL_RECOVERY_ENABLED", True),
            mock.patch.object(autofill, "_start_history_task") as start,
        ):
            result = await autofill.auto_start_history_import(email, reason="gap")
        start.assert_not_called()
        return result

    assert asyncio.run(scenario()) is False
    assert repo.get_history_import_audit(email)["last_auto_started_at"] is None


def test_startup_audit_skips_recent_success(history_db) -> None:
    email = "worker@example.com"
    repo.complete_history_import(email)

    async def account_status(*_args, **_kwargs):
        return {"connected": True, "email": email}

    async def scenario() -> bool:
        with (
            mock.patch.object(autofill, "AUTH_ENABLED", False),
            mock.patch.object(autofill, "LOCAL_AGENT_PAIR_SECRET", ""),
            mock.patch.object(autofill, "EXTERNAL_RECOVERY_ENABLED", True),
            mock.patch.object(cli_bridge, "get_account_status", side_effect=account_status),
            mock.patch.object(autofill, "auto_start_history_import") as start,
        ):
            result = await autofill.startup_history_audit()
        start.assert_not_called()
        return result

    assert asyncio.run(scenario()) is False


def test_startup_audit_prioritizes_unresolved_gap_over_recent_success(history_db) -> None:
    email = "worker@example.com"
    repo.complete_history_import(email)
    repo.mark_history_gap(email)

    async def account_status(*_args, **_kwargs):
        return {"connected": True, "email": email}

    async def scenario() -> bool:
        with (
            mock.patch.object(autofill, "AUTH_ENABLED", False),
            mock.patch.object(autofill, "LOCAL_AGENT_PAIR_SECRET", ""),
            mock.patch.object(autofill, "EXTERNAL_RECOVERY_ENABLED", True),
            mock.patch.object(cli_bridge, "get_account_status", side_effect=account_status),
            mock.patch.object(
                autofill, "auto_start_history_import", mock.AsyncMock(return_value=True)
            ) as start,
        ):
            result = await autofill.startup_history_audit()
        start.assert_awaited_once_with(email, reason="startup")
        return result

    assert asyncio.run(scenario()) is True


def test_worker_push_uses_pre_diff_window_size_to_persist_gap(history_db) -> None:
    body = IngestIn(
        jobs=[{"id": f"job-{index}"} for index in range(85)],
        list_fetched=100,
        account_status={"email": "worker@example.com"},
    )
    out = IngestOut(inserted=85)
    request = SimpleNamespace()

    with (
        mock.patch.object(ingest, "_agent_acc", return_value={"email": "local"}),
        mock.patch.object(ingest, "_ingest_core", return_value=out),
        mock.patch.object(ingest, "MANAGE_ENABLED", False),
        mock.patch.object(ingest._proxy, "proxying", return_value=False),
        mock.patch.object(ingest.repo, "mark_history_gap", wraps=repo.mark_history_gap) as mark,
        mock.patch.object(ingest, "schedule_history_auto_start") as schedule,
    ):
        assert ingest.ingest(body, request) is out

    mark.assert_called_once_with("worker@example.com")
    schedule.assert_called_once_with("worker@example.com")
    assert repo.get_history_import_audit("worker@example.com")["gap_detected_at"]


def test_syncer_house_gap_persists_and_requests_local_auto_start(history_db) -> None:
    jobs = [{"id": f"job-{index}"} for index in range(100)]
    counts = {"inserted": 85, "updated": 0, "unchanged": 15, "errors": 0}

    async def scenario() -> dict[str, int]:
        with (
            mock.patch.object(syncer.cli_bridge, "list_jobs", mock.AsyncMock(return_value=jobs)),
            mock.patch.object(syncer.repo, "apply_synced_jobs", return_value=dict(counts)),
            mock.patch.object(syncer.repo, "reconcile_duplicates", return_value=0),
            mock.patch.object(
                syncer, "_house_account_email", mock.AsyncMock(return_value="house@example.com")
            ),
            mock.patch.object(syncer, "AUTH_ENABLED", False),
            mock.patch.object(syncer, "LOCAL_AGENT_PAIR_SECRET", ""),
            mock.patch.object(autofill, "auto_start_history_import", mock.AsyncMock(return_value=True)) as start,
            mock.patch.object(syncer, "MANAGE_ENABLED", False),
        ):
            result = await syncer.sync_now()
        start.assert_awaited_once_with("house@example.com", reason="gap")
        return result

    assert asyncio.run(scenario())["gap_warning"] == 1
    assert repo.get_history_import_audit("house@example.com")["gap_detected_at"]

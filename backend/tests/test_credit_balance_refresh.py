"""계정/공간 실패는 숨기지 않고, 잔액 갱신은 변경된 계정에만 보낸다."""

import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import pytest
from fastapi import BackgroundTasks, HTTPException

from app.models import AccountReportIn, IngestIn, IngestOut
from app.routers import generation, ingest
from app.services import cli_bridge


@pytest.mark.parametrize("error,expected", [
    ("Error: Not authenticated. Hint: Run: hf auth login", "auth"),
    ("Error: Your access token has expired", "auth"),
    ("Error: HTTP status code: 401", "auth"),
    ("Error: HTTP 403 Forbidden", "permission"),
    ("Error: connect ETIMEDOUT", "network"),
    ("Error: HTTP 503", "network"),
    ("Error: Too many requests", "network"),
    ("response is not JSON", "invalid"),
])
def test_account_failures_are_classified_without_secret_output(monkeypatch, error, expected):
    secret = "Bearer do-not-publish-token"
    log = Mock()
    monkeypatch.setattr(cli_bridge, "log_event", log)
    monkeypatch.setattr(cli_bridge, "_run_json", AsyncMock(side_effect=cli_bridge.CLIError(error + " " + secret)))
    result = asyncio.run(cli_bridge._get_account_status_uncached(1))
    assert result == {"connected": False, "credits": None, "email": "", "plan": "", "error_kind": expected}
    assert secret not in repr(log.call_args)
    assert secret not in repr(result)
    assert log.call_args.kwargs["error_kind"] == expected
    assert log.call_args.kwargs["action"]


def test_successful_account_shape_stays_compatible(monkeypatch):
    monkeypatch.setattr(cli_bridge, "_run_json", AsyncMock(return_value={
        "email": "artist@example.test", "credits_exact": 2.5, "subscription_plan_type": "team",
    }))
    assert asyncio.run(cli_bridge._get_account_status_uncached(1)) == {
        "connected": True, "credits": 2.5, "email": "artist@example.test", "plan": "team",
    }


def test_workspace_failure_is_not_empty_success_or_hub_unauthorized(monkeypatch):
    monkeypatch.setattr(cli_bridge, "_run_json", AsyncMock(side_effect=cli_bridge.CLIError("Error: HTTP 401 Unauthorized")))
    monkeypatch.setattr(cli_bridge, "log_event", Mock())
    with pytest.raises(HTTPException) as exc:
        asyncio.run(generation.list_workspaces())
    assert exc.value.status_code == 502
    assert "Higgsfield" in exc.value.detail
    monkeypatch.setattr(cli_bridge, "_run_json", AsyncMock(return_value=[]))
    assert asyncio.run(generation.list_workspaces()) == []


def test_overlapping_workspace_queries_share_one_cli_call(monkeypatch):
    async def run():
        release = asyncio.Event()

        async def slow(*args, **kwargs):
            await release.wait()
            return [{"id": "workspace-a", "credits": 20}]

        probe = AsyncMock(side_effect=slow)
        monkeypatch.setattr(cli_bridge, "_run_json", probe)
        queries = [asyncio.create_task(cli_bridge.list_workspaces()) for _ in range(4)]
        await asyncio.sleep(0)
        release.set()
        assert len(await asyncio.gather(*queries)) == 4
        assert probe.await_count == 1

    asyncio.run(run())


@pytest.mark.parametrize("route", ["ingest", "report"])
@pytest.mark.parametrize("inserted,matched,notifications", [(0, 0, 0), (1, 0, 1), (0, 1, 1)])
def test_only_changed_transactions_notify_the_same_account(monkeypatch, route, inserted, matched, notifications):
    from app import deps
    from app.repo import manage

    account = {"email": "artist@example.test", "creator_uid": "user_artist"}
    monkeypatch.setattr(deps, "AUTH_ENABLED", True)
    monkeypatch.setattr(ingest, "MANAGE_ENABLED", True)
    monkeypatch.setattr(ingest, "_agent_acc", lambda request: account)
    monkeypatch.setattr(ingest, "_ingest_core", lambda *args, **kwargs: IngestOut(linked_uid="user_artist"))
    monkeypatch.setattr(ingest._proxy, "proxying", lambda: False)
    monkeypatch.setattr(ingest, "schedule_telemetry_drain", lambda: None)
    monkeypatch.setattr(manage, "record_transactions", lambda *args: {
        "stored": 1, "rejected": 0, "inserted": inserted, "matched": matched,
    })
    broadcast = AsyncMock()
    monkeypatch.setattr(ingest.manager, "broadcast", broadcast)
    tasks = BackgroundTasks()
    values = {"account_status": {"email": account["email"], "credits": 100},
              "account_transactions": [{"created_at": "2026-09-05T08:50:12Z", "credits": -2, "action": "spend"}]}
    if route == "ingest":
        ingest.ingest(IngestIn(**values), SimpleNamespace(), tasks)
    else:
        ingest.ingest_account_report(AccountReportIn(**values), SimpleNamespace(), tasks)
    assert len(tasks.tasks) == notifications
    asyncio.run(tasks())
    assert broadcast.await_count == notifications
    if notifications:
        broadcast.assert_awaited_once_with({"type": "credits_changed"}, account_uid="acct:artist@example.test")


@pytest.mark.parametrize("shared,worker,remote,required,status", [
    (True, False, None, "1.2.3", "ok"),
    (False, True, "1.2.2", "1.2.2", "code_stale"),
    (False, True, None, None, "ok"),
    (False, False, None, None, "ok"),
])
def test_cli_check_required_version_keeps_original_policy(monkeypatch, shared, worker, remote, required, status):
    from app import main

    monkeypatch.setattr(main, "_pinned_cli_version", lambda: "1.2.3")
    monkeypatch.setattr(main._proxy, "is_shared_team_server", lambda: shared)
    monkeypatch.setattr(main._proxy, "is_worker_hub", lambda: worker)
    monkeypatch.setattr(main._proxy, "base_url", lambda: "http://127.0.0.1:1")
    monkeypatch.setattr(main._proxy, "token", lambda: "test-token-not-transmitted")
    monkeypatch.setattr(main._proxy, "raw_request", lambda *args, **kwargs: (200, {"cli_version": remote}))
    assert main.cli_check() == {"pin": "1.2.3", "server": remote, "required": required, "status": status}

from __future__ import annotations

import asyncio
import json
from types import SimpleNamespace
from unittest import mock

from app.routers import ingest
from app.services import cli_bridge, higgsfield_history


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
    ingest._HISTORY_STATES[key] = {
        **ingest._history_idle(),
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
        mock.patch.object(ingest, "mcp_item_to_cli", side_effect=lambda item: item),
        mock.patch.object(ingest, "_ingest_core", side_effect=lambda *_args: next(applied)),
        mock.patch.object(ingest, "MANAGE_ENABLED", False),
    ):
        asyncio.run(ingest._run_history_import(key, {"email": "local"}))

    state = ingest._HISTORY_STATES.pop(key)
    assert state["state"] == "complete"
    assert state["pages"] == 2
    assert state["received"] == 2
    assert state["inserted"] == 1
    assert state["updated"] == 1
    assert "secret" not in json.dumps(state)

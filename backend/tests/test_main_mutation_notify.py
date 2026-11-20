import asyncio
from types import SimpleNamespace
from unittest import mock

from starlette.requests import Request
from starlette.responses import Response

from app import deps as deps_mod
from app import main


def test_external_screen_is_unchanged_but_panel_hidden_still_notifies(monkeypatch):
    from app.routers import mcp_v2 as api
    async def done(*_):
        return {"ok": True}
    monkeypatch.setattr(api, "_external_screen_action", done)
    monkeypatch.setattr(api, "_panel_screen_action", done)
    for name, expected in (("codex", 0), (api.PANEL_CLIENT, 1)):
        request = _request("POST", "/api/mcp/v2/client/action")
        ctx = SimpleNamespace(request=request, client={"name": name, "id": "client"})
        args = {"name": "library.set_hidden", "args": {"generation_ids": ["g"], "hidden": True}}
        if name == "codex":
            args["screen_context"] = "x" * 43
        async def route(_):
            await api.action(api.mcp.ActionIn(method="screen_action", args=args), ctx)
            return Response(status_code=200)
        with mock.patch.object(main, "manager") as manager:
            asyncio.run(main.mutation_notify(request, route))
            assert manager.notify_mutation.call_count == expected


def test_screen_presence_claim_result_do_not_broadcast_synced():
    for path in ("/api/mcp/v2/app/screen-presence", "/api/mcp/v2/app/screen-actions/id/claim", "/api/mcp/v2/app/screen-actions/id/result"):
        with mock.patch.object(main, "manager") as manager:
            asyncio.run(main.mutation_notify(_request("POST", path), _success))
            manager.notify_mutation.assert_not_called()
from app.mutation_notify import (
    CLIENT_ID_HEADER,
    MUTATION_DOMAINS_HEADER,
    MUTATION_ID_HEADER,
)


def _request(method: str, path: str) -> Request:
    headers = [
        (CLIENT_ID_HEADER.lower().encode(), b"client_test_123"),
        (MUTATION_ID_HEADER.lower().encode(), b"mutation_test_123"),
    ]
    request = Request(
        {
            "type": "http",
            "asgi": {"version": "3.0"},
            "http_version": "1.1",
            "method": method,
            "scheme": "http",
            "path": path,
            "raw_path": path.encode(),
            "query_string": b"",
            "headers": headers,
            "client": ("127.0.0.1", 1234),
            "server": ("127.0.0.1", 8010),
        }
    )
    request.state.account = {"email": "A@X.com", "creator_uid": "user_a"}
    return request


async def _success(_request: Request) -> Response:
    return Response(status_code=200)


def test_main_middleware_scopes_library_and_emits_asset_domain():
    with mock.patch.object(deps_mod, "AUTH_ENABLED", True), mock.patch.object(
        main, "manager"
    ) as manager:
        library_response = asyncio.run(
            main.mutation_notify(_request("PUT", "/api/generations/g1/tags"), _success)
        )
        asset_response = asyncio.run(
            main.mutation_notify(_request("PUT", "/api/assets/color"), _success)
        )

    manager.notify_mutation.assert_called_once_with(
        "acct:a@x.com", ("client_test_123", "mutation_test_123")
    )
    manager.notify_domain.assert_called_once_with(
        "assets_changed", ("client_test_123", "mutation_test_123")
    )
    assert library_response.headers[MUTATION_DOMAINS_HEADER] == "library"
    assert asset_response.headers[MUTATION_DOMAINS_HEADER] == "assets"
    assert asset_response.headers[MUTATION_ID_HEADER] == "mutation_test_123"

import asyncio
from unittest import mock

from starlette.requests import Request
from starlette.responses import Response

from app import deps as deps_mod
from app import main
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

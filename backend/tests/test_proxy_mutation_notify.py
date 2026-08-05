import asyncio
from unittest import mock

from starlette.requests import Request

from app.mutation_notify import CLIENT_ID_HEADER, MUTATION_ID_HEADER
from app.routers import _proxy


def _request(path: str, *, with_origin: bool = False) -> Request:
    headers = [(b"content-type", b"application/json")]
    if with_origin:
        headers.extend(
            [
                (CLIENT_ID_HEADER.lower().encode(), b"client_test_123"),
                (MUTATION_ID_HEADER.lower().encode(), b"mutation_test_123"),
            ]
        )
    delivered = False

    async def receive():
        nonlocal delivered
        if delivered:
            return {"type": "http.disconnect"}
        delivered = True
        return {"type": "http.request", "body": b"{}", "more_body": False}

    return Request(
        {
            "type": "http",
            "asgi": {"version": "3.0"},
            "http_version": "1.1",
            "method": "POST",
            "scheme": "http",
            "path": path,
            "raw_path": path.encode(),
            "query_string": b"",
            "headers": headers,
            "client": ("127.0.0.1", 1234),
            "server": ("127.0.0.1", 8012),
        },
        receive,
    )


def _forward(request: Request):
    with (
        mock.patch.object(
            _proxy.asyncio,
            "to_thread",
            new=mock.AsyncMock(return_value=(200, b"{}", "application/json")),
        ),
        mock.patch.object(_proxy, "base_url", return_value="http://server.test"),
        mock.patch.object(_proxy, "token", return_value=None),
        mock.patch("app.ws.manager.notify_mutation") as notify,
    ):
        response = asyncio.run(_proxy._forward(request))
    return response, notify


def test_proxy_read_only_post_uses_shared_contract_and_does_not_notify():
    response, notify = _forward(_request("/api/generations/batch", with_origin=True))
    assert response.status_code == 200
    assert MUTATION_ID_HEADER not in response.headers
    notify.assert_not_called()


def test_proxy_real_mutation_echoes_origin_and_notifies_once():
    response, notify = _forward(_request("/api/generations/g1/tags", with_origin=True))
    assert response.headers[MUTATION_ID_HEADER] == "mutation_test_123"
    notify.assert_called_once_with(origin=("client_test_123", "mutation_test_123"))

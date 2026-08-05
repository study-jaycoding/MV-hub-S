import asyncio
from unittest import mock

from starlette.requests import Request
from starlette.responses import Response

from app.mutation_notify import (
    CLIENT_ID_HEADER,
    MUTATION_DOMAINS_HEADER,
    MUTATION_ID_HEADER,
)
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
        mock.patch("app.ws.manager") as manager,
    ):
        response = asyncio.run(_proxy._forward(request))
    return response, manager


def test_proxy_read_only_post_uses_shared_contract_and_does_not_notify():
    response, manager = _forward(_request("/api/generations/batch", with_origin=True))
    assert response.status_code == 200
    assert MUTATION_ID_HEADER not in response.headers
    assert MUTATION_DOMAINS_HEADER not in response.headers
    manager.notify_mutation.assert_not_called()
    manager.notify_domain.assert_not_called()


def test_proxy_real_mutation_echoes_origin_and_notifies_once():
    response, manager = _forward(_request("/api/generations/g1/tags", with_origin=True))
    assert response.headers[MUTATION_ID_HEADER] == "mutation_test_123"
    assert response.headers[MUTATION_DOMAINS_HEADER] == "library"
    manager.notify_mutation.assert_called_once_with(
        origin=("client_test_123", "mutation_test_123")
    )
    manager.notify_domain.assert_not_called()


def test_proxy_asset_mutation_uses_asset_channel_only():
    response, manager = _forward(_request("/api/assets/upload", with_origin=True))
    assert response.headers[MUTATION_DOMAINS_HEADER] == "assets"
    manager.notify_mutation.assert_not_called()
    manager.notify_domain.assert_called_once_with(
        "assets_changed", ("client_test_123", "mutation_test_123")
    )


def test_proxy_manage_library_mutation_uses_both_channels():
    response, manager = _forward(_request("/api/manage/hf-missing-apply", with_origin=True))
    assert response.headers[MUTATION_DOMAINS_HEADER] == "library,manage"
    manager.notify_mutation.assert_called_once_with(
        origin=("client_test_123", "mutation_test_123")
    )
    manager.notify_domain.assert_called_once_with(
        "manage_changed", ("client_test_123", "mutation_test_123")
    )


def test_route_level_proxy_json_preserves_request_origin_and_resets_context():
    request = _request("/api/projects", with_origin=True)
    raw_request = mock.Mock(return_value=(200, {"ok": True}))

    async def call_next(_request):
        _proxy.proxy_json("POST", "/api/projects", body={"name": "p"})
        return Response(status_code=200)

    with (
        mock.patch.object(_proxy, "proxying", return_value=True),
        mock.patch.object(_proxy, "base_url", return_value="http://server.test"),
        mock.patch.object(_proxy, "token", return_value="token"),
        mock.patch.object(_proxy, "raw_request", raw_request),
    ):
        asyncio.run(_proxy.data_proxy_middleware(request, call_next))
        # 요청이 끝난 뒤 별도 호출에는 이전 요청 출처가 남지 않아야 한다.
        _proxy.proxy_json("POST", "/api/projects", body={"name": "outside"})

    assert raw_request.call_args_list[0].kwargs["mutation_origin"] == (
        "client_test_123",
        "mutation_test_123",
    )
    assert raw_request.call_args_list[1].kwargs["mutation_origin"] is None

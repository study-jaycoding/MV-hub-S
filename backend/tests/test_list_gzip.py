"""생성물 목록만 압축한다 — 그리고 **목록만**.

★왜(2026-09-12 실측, C-14): `/api/generations?limit=200` 이 **1,664,434 B** 인데 지금까지
 압축을 전혀 안 했다. 팀 탭은 유휴 15초·활성 잡이 있으면 **3초**마다 이 목록을 다시 받는다.
 gzip -6 이면 **85,501 B (5.1%)** — 유휴 6.35 → 0.33 MB/분, 활성 31.75 → **1.63 MB/분**.

★전역으로 켜면 안 되는 이유(코덱스가 재현): 표준 `GZipMiddleware` 는 미디어를 MIME 으로
 걸러 주지 않아 **`206 video/mp4` 도 압축하면서 `Content-Range` 를 그대로 남긴다** —
 부분 다운로드 계약이 깨진다. 그래서 경로·메서드를 좁혀 감쌌다.

★프록시 구간은 영향받지 않는다(실측): `_proxy` 가 쓰는 `urllib.request` 는
 `Accept-Encoding: identity` 를 보내므로 압축 대상이 아니다. 그 구간을 줄이는 것은 2단계(별건)다.
"""

from __future__ import annotations

import gzip
import json

import pytest
from starlette.applications import Starlette
from starlette.responses import JSONResponse, Response
from starlette.routing import Route
from starlette.testclient import TestClient

from app.list_gzip import ListGzipMiddleware, accepts_gzip

BIG = [{"id": f"g{i}", "prompt": "고양이가 춤춘다" * 8} for i in range(200)]


def _app() -> TestClient:
    async def generations(request):
        return JSONResponse(BIG)

    async def one(request):
        return JSONResponse({"id": "g1", "prompt": "x" * 5000})

    async def media(request):
        # 부분 다운로드 응답 — 압축되면 `Content-Range` 와 어긋난다
        body = b"\x00\x01\x02" * 4000
        return Response(
            body,
            status_code=206,
            media_type="video/mp4",
            headers={"Content-Range": f"bytes 0-{len(body) - 1}/999999", "Accept-Ranges": "bytes"},
        )

    app = Starlette(routes=[
        Route("/api/generations", generations),
        Route("/api/generations/g1", one),
        Route("/api/generations/g1/media", media),
    ])
    app.add_middleware(ListGzipMiddleware)
    return TestClient(app)


@pytest.fixture()
def client():
    return _app()


def _get(client, path, **kwargs):
    headers = {"Accept-Encoding": "gzip, deflate"}
    headers.update(kwargs.pop("headers", {}))
    # TestClient 가 자동 해제하지 않도록 원시 응답을 본다
    return client.get(path, headers=headers, **kwargs)


def test_the_list_comes_back_compressed(client):
    """★이 시험이 이 파일의 이유다."""
    r = _get(client, "/api/generations")
    assert r.headers.get("content-encoding") == "gzip"
    assert json.loads(r.content) == BIG  # httpx 가 풀어 준 내용이 원문과 같다


def test_the_compressed_bytes_are_much_smaller(client):
    packed = _get(client, "/api/generations")
    plain = client.get("/api/generations", headers={"Accept-Encoding": "identity"})
    assert plain.headers.get("content-encoding") is None
    # httpx 는 자동 해제하므로 헤더의 길이로 비교한다
    assert int(packed.headers["content-length"]) < int(plain.headers["content-length"]) // 4


def test_the_content_is_identical_either_way(client):
    packed = _get(client, "/api/generations")
    plain = client.get("/api/generations", headers={"Accept-Encoding": "identity"})
    assert packed.json() == plain.json()


def test_a_client_that_does_not_ask_gets_plain_bytes(client):
    r = client.get("/api/generations", headers={"Accept-Encoding": "identity"})
    assert r.headers.get("content-encoding") is None


def test_an_explicit_refusal_is_honoured(client):
    """★표준 미들웨어는 `gzip;q=0` 에도 압축한다 — 우리는 안 한다."""
    r = client.get("/api/generations", headers={"Accept-Encoding": "gzip;q=0, identity"})
    assert r.headers.get("content-encoding") is None


def test_media_and_detail_paths_are_never_touched(client):
    """★부분 다운로드가 압축되면 `Content-Range` 와 어긋난다."""
    r = client.get("/api/generations/g1/media", headers={"Accept-Encoding": "gzip"})
    assert r.status_code == 206
    assert r.headers.get("content-encoding") is None
    assert r.headers.get("content-range", "").startswith("bytes 0-")
    assert r.headers.get("accept-ranges") == "bytes"

    detail = client.get("/api/generations/g1", headers={"Accept-Encoding": "gzip"})
    assert detail.headers.get("content-encoding") is None  # 하위 경로는 대상이 아니다


def test_a_range_request_on_the_list_is_left_alone(client):
    r = client.get(
        "/api/generations", headers={"Accept-Encoding": "gzip", "Range": "bytes=0-99"}
    )
    assert r.headers.get("content-encoding") is None


def test_head_is_left_alone(client):
    r = client.head("/api/generations", headers={"Accept-Encoding": "gzip"})
    assert r.headers.get("content-encoding") is None


def test_a_tiny_response_is_not_worth_compressing(client):
    async def small(request):
        return JSONResponse([{"id": "g1"}])

    app = Starlette(routes=[Route("/api/generations", small)])
    app.add_middleware(ListGzipMiddleware)
    r = TestClient(app).get("/api/generations", headers={"Accept-Encoding": "gzip"})
    assert r.headers.get("content-encoding") is None  # minimum_size 미만


def test_the_bytes_on_the_wire_really_are_gzip():
    """★헤더만 보고 믿지 않는다 — ASGI 를 직접 태워 **회선에 나가는 바이트**를 푼다.

    (HTTP 클라이언트는 gzip 을 자동으로 풀어 주므로 그 경로로는 확인할 수 없다.)
    """
    import asyncio

    async def generations(request):
        return JSONResponse(BIG)

    app = Starlette(routes=[Route("/api/generations", generations)])
    app.add_middleware(ListGzipMiddleware)

    chunks: list[bytes] = []
    start: dict = {}

    async def send(message):
        if message["type"] == "http.response.start":
            start.update(message)
        elif message["type"] == "http.response.body":
            chunks.append(message.get("body", b""))

    async def receive():
        return {"type": "http.request", "body": b"", "more_body": False}

    scope = {
        "type": "http", "asgi": {"version": "3.0"}, "http_version": "1.1",
        "method": "GET", "path": "/api/generations", "raw_path": b"/api/generations",
        "query_string": b"", "root_path": "", "scheme": "http",
        "headers": [(b"accept-encoding", b"gzip")], "client": ("127.0.0.1", 1), "server": ("t", 80),
    }
    asyncio.run(app(scope, receive, send))

    headers = {k.decode().lower(): v.decode() for k, v in start["headers"]}
    assert headers.get("content-encoding") == "gzip"
    wire = b"".join(chunks)
    assert json.loads(gzip.decompress(wire)) == BIG          # 진짜 gzip 이고 내용이 같다
    assert len(wire) < len(json.dumps(BIG).encode()) // 4     # 실제로 훨씬 작다


@pytest.mark.parametrize(
    "header,expected",
    [
        (None, False),
        ("", False),
        ("identity", False),
        ("gzip", True),
        ("gzip, deflate, br", True),
        ("deflate, gzip;q=1.0", True),
        ("gzip;q=0", False),
        ("gzip;q=0.0", False),
        ("gzip;q=0, deflate", False),
        ("*", True),
        ("*;q=0", False),
        ("*, gzip;q=0", False),          # gzip 을 콕 집어 거부하면 `*` 보다 우선
        ("gzip;q=0, *", False),          # ★거부가 **앞**에 와도 마찬가지 — `*` 가 이기면 안 된다
        ("gzip;q=0, *;q=1.0", False),    #  (되돌려 확인이 이 빈틈을 찾아 추가했다)
        ("br, *;q=0, gzip", True),
        ("GZIP", True),                   # 대소문자 무관
        ("gzip;q=쓰레기", False),          # 못 읽는 q 는 거부로 본다
    ],
)
def test_accept_encoding_is_parsed_properly(header, expected):
    assert accepts_gzip(header) is expected

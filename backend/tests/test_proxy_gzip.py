"""프록시(허브 → 공유 서버)가 gzip 을 협상하고 **푼다**.

★왜(2026-09-12 실측, C-14 2단계): 로컬 허브 사용자의 가장 비싼 구간은 **허브 ↔ 공유 서버**
 (인터넷)다. 브라우저 구간은 1단계(`app/list_gzip.py`)로 줄었지만 이 구간은 `urllib` 이
 `Accept-Encoding: identity` 를 보내 그대로였다. 목록 실측 1,664,434 B → gzip **85,501 B(5.1%)**.

★**pass-through 가 아니라 허브가 푼다** — 허브가 개인 색·태그를 덧씌우려면 JSON 을 만져야 한다
 (`routers/library.py` 의 `_overlay_personal_meta`).

★스트리밍·미디어 경로는 **identity 를 유지**한다. 그쪽은 바이트를 그대로 파일에 쓰거나
 `Content-Range` 와 함께 되돌려주므로 압축이 섞이면 깨진다.
"""

from __future__ import annotations

import email.message
import gzip
import io
import json
import urllib.error
import urllib.request
from unittest.mock import patch

import pytest
from fastapi import HTTPException

from app.routers import _proxy


class _Resp(io.BytesIO):
    """`urlopen` 이 돌려주는 것과 같은 모양의 최소 가짜 — 바깥 경계에만 둔다.

    ★헤더는 `dict` 가 아니라 **`email.message.Message`** 다 — 제품이 `get_content_type()` 을
     부른다(dict 로 두니 그 자리에서 깨졌다). 가짜라도 타입은 실제와 같아야 한다.
    """

    def __init__(self, payload: bytes, headers: dict[str, str], status: int = 200):
        super().__init__(payload)
        self.status = status
        message = email.message.Message()
        for key, value in headers.items():
            message[key] = value
        self.headers = message

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False


def _gz(data: bytes) -> bytes:
    return gzip.compress(data, compresslevel=6, mtime=0)


# ── 해제 함수 자체 ──────────────────────────────────────────────────────────
def test_plain_bytes_pass_through_untouched():
    assert _proxy.decode_proxy_body(b"hello", None) == b"hello"
    assert _proxy.decode_proxy_body(b"hello", "") == b"hello"
    assert _proxy.decode_proxy_body(b"hello", "identity") == b"hello"
    assert _proxy.decode_proxy_body(b"hello", "IDENTITY") == b"hello"


def test_gzip_is_unpacked():
    body = json.dumps([{"id": "g1"}] * 100).encode()
    assert _proxy.decode_proxy_body(_gz(body), "gzip") == body
    assert _proxy.decode_proxy_body(_gz(body), " GZIP ") == body


def test_an_encoding_we_cannot_handle_is_a_controlled_502():
    """★구버전·다른 서버가 br 로 주면 조용히 깨지지 말고 진단이 나와야 한다."""
    with pytest.raises(HTTPException) as caught:
        _proxy.decode_proxy_body(b"\x00\x01", "br")
    assert caught.value.status_code == 502
    assert "br" in str(caught.value.detail)


def test_broken_gzip_is_a_controlled_502_without_leaking_the_body():
    with pytest.raises(HTTPException) as caught:
        _proxy.decode_proxy_body(b"not actually gzip at all", "gzip")
    assert caught.value.status_code == 502
    assert "not actually gzip" not in str(caught.value.detail)  # 본문을 새로 노출하지 않는다


def test_a_compression_bomb_is_refused(monkeypatch):
    """★압축 폭탄 — 푼 뒤 크기로 막아야 의미가 있다."""
    monkeypatch.setattr(_proxy, "_MAX_DECOMPRESSED_BYTES", 1024)
    with pytest.raises(HTTPException) as caught:
        _proxy.decode_proxy_body(_gz(b"a" * 100_000), "gzip")
    assert caught.value.status_code == 502
    assert "해제 후" in str(caught.value.detail)


def test_an_oversized_compressed_body_is_refused(monkeypatch):
    monkeypatch.setattr(_proxy, "_MAX_COMPRESSED_BYTES", 10)
    with pytest.raises(HTTPException) as caught:
        _proxy.decode_proxy_body(_gz(b"a" * 100_000), "gzip")
    assert caught.value.status_code == 502
    assert "압축분" in str(caught.value.detail)


# ── raw_request 통합 ────────────────────────────────────────────────────────
def _call(payload: bytes, headers: dict[str, str], status: int = 200):
    sent: dict = {}

    def fake_urlopen(req, timeout=None):
        sent["headers"] = {k.lower(): v for k, v in req.headers.items()}
        return _Resp(payload, headers, status)

    with patch.object(urllib.request, "urlopen", side_effect=fake_urlopen):
        result = _proxy.raw_request("GET", "http://server/api/generations", token="t")
    return result, sent


def test_the_proxy_asks_for_gzip():
    """★이 시험이 이 파일의 이유다 — 요청하지 않으면 서버가 압축해 주지 않는다."""
    _, sent = _call(b"[]", {})
    assert sent["headers"].get("accept-encoding") == "gzip"


def test_a_compressed_list_comes_back_as_parsed_json():
    rows = [{"id": f"g{i}"} for i in range(50)]
    (status, parsed), _ = _call(_gz(json.dumps(rows).encode()), {"Content-Encoding": "gzip"})
    assert status == 200
    assert parsed == rows


def test_an_uncompressed_answer_is_still_normal():
    """★gzip 을 요청해도 **무압축 응답이 정상**이다(구버전 공유 서버·압축 미적용 경로)."""
    rows = [{"id": "g1"}]
    (status, parsed), _ = _call(json.dumps(rows).encode(), {})
    assert (status, parsed) == (200, rows)


def test_a_compressed_error_body_is_still_readable():
    """★오류 본문도 압축돼 올 수 있다 — 안 풀면 401/403 진단이 깨진다."""
    detail = {"detail": "토큰이 만료되었습니다"}

    def fake_urlopen(req, timeout=None):
        raise urllib.error.HTTPError(
            "http://server", 401, "Unauthorized",
            {"Content-Encoding": "gzip"},          # type: ignore[arg-type]
            io.BytesIO(_gz(json.dumps(detail).encode())),
        )

    with patch.object(urllib.request, "urlopen", side_effect=fake_urlopen):
        status, body = _proxy.raw_request("GET", "http://server/api/x", token="t")
    assert status == 401
    assert body == detail


def test_a_plain_error_body_still_works():
    def fake_urlopen(req, timeout=None):
        raise urllib.error.HTTPError(
            "http://server", 403, "Forbidden", {},
            io.BytesIO(json.dumps({"detail": "권한 없음"}).encode()),
        )

    with patch.object(urllib.request, "urlopen", side_effect=fake_urlopen):
        status, body = _proxy.raw_request("GET", "http://server/api/x", token="t")
    assert (status, body) == (403, {"detail": "권한 없음"})


def test_a_portal_page_is_still_diagnosed_as_502():
    """압축을 더하면서 기존 진단(캡티브 포털 200+HTML)이 사라지면 안 된다."""
    with pytest.raises(HTTPException) as caught:
        _call(b"<html>login</html>", {})
    assert caught.value.status_code == 502
    assert "JSON" in str(caught.value.detail)


def test_a_compressed_portal_page_is_also_diagnosed():
    with pytest.raises(HTTPException) as caught:
        _call(_gz(b"<html>login</html>"), {"Content-Encoding": "gzip"})
    assert caught.value.status_code == 502
    assert "JSON" in str(caught.value.detail)


def test_the_write_path_is_not_retried_after_a_decode_failure():
    """★해제 실패로 원 요청을 자동 재전송하면 **쓰기가 두 번** 일어난다."""
    calls = {"n": 0}

    def fake_urlopen(req, timeout=None):
        calls["n"] += 1
        return _Resp(b"broken", {"Content-Encoding": "gzip"})

    with patch.object(urllib.request, "urlopen", side_effect=fake_urlopen):
        with pytest.raises(HTTPException):
            _proxy.raw_request("POST", "http://server/api/x", token="t", body={"a": 1})
    assert calls["n"] == 1


# ── 스트리밍·미디어 경로는 절대 압축을 받지 않는다 ──────────────────────────
BINARY = bytes(range(32)) * 4


def test_the_file_download_path_asks_for_identity(tmp_path):
    """★이 경로는 바이트를 **그대로 파일에 쓴다** — 압축본을 받으면 파일이 깨진다."""
    sent: dict = {}

    def fake_urlopen(req, timeout=None):
        sent["headers"] = {k.lower(): v for k, v in req.headers.items()}
        return _Resp(BINARY, {"Content-Length": str(len(BINARY))})

    with (
        patch.object(_proxy, "token", return_value="t"),
        patch.object(_proxy, "base_url", return_value="http://server"),
        patch.object(urllib.request, "urlopen", side_effect=fake_urlopen),
    ):
        written = _proxy.stream_download("/api/x", tmp_path / "out.bin")

    assert sent["headers"].get("accept-encoding") == "identity"
    assert written == len(BINARY)
    assert (tmp_path / "out.bin").read_bytes() == BINARY  # 바이트가 그대로 남았다


def test_the_media_stream_never_copies_the_browser_encoding():
    """★브라우저의 `Accept-Encoding` 을 그대로 넘기면 `Content-Range`·길이와 어긋난다."""
    import asyncio

    from starlette.requests import Request

    sent: dict = {}

    def fake_urlopen(req, timeout=None):
        sent["headers"] = {k.lower(): v for k, v in req.headers.items()}
        return _Resp(BINARY, {"Content-Length": str(len(BINARY)), "Content-Type": "video/mp4"})

    scope = {
        "type": "http",
        "method": "GET",
        "path": "/api/media",
        "raw_path": b"/api/media",
        "query_string": b"src=x",
        "headers": [
            (b"accept-encoding", b"gzip, deflate, br"),  # 브라우저가 보낸 것
            (b"range", b"bytes=0-63"),
        ],
        "client": ("127.0.0.1", 1),
        "server": ("t", 80),
        "scheme": "http",
        "root_path": "",
        "http_version": "1.1",
        "app": None,
    }

    async def receive():
        return {"type": "http.request", "body": b"", "more_body": False}

    with (
        patch.object(_proxy, "token", return_value="t"),
        patch.object(_proxy, "base_url", return_value="http://server"),
        patch.object(urllib.request, "urlopen", side_effect=fake_urlopen),
    ):
        asyncio.run(_proxy._forward_stream(Request(scope, receive)))

    assert sent["headers"].get("accept-encoding") == "identity"
    assert sent["headers"].get("range") == "bytes=0-63"  # Range 는 그대로 넘긴다

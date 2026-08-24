"""공유 서버 보존 미디어를 로컬 허브가 안전하게 중계하는 회귀 테스트."""

import asyncio
import tempfile
from email.message import Message
from pathlib import Path
from unittest import mock

from starlette.requests import Request
from starlette.responses import Response

from app.routers import _proxy, library


def _request(path: str, *, query: str = "", method: str = "GET", headers=None) -> Request:
    raw_headers = [
        (str(k).lower().encode("latin-1"), str(v).encode("latin-1"))
        for k, v in (headers or {}).items()
    ]
    return Request(
        {
            "type": "http",
            "asgi": {"version": "3.0"},
            "http_version": "1.1",
            "method": method,
            "scheme": "http",
            "path": path,
            "raw_path": path.encode("latin-1"),
            "query_string": query.encode("latin-1"),
            "headers": raw_headers,
            "client": ("127.0.0.1", 1234),
            "server": ("127.0.0.1", 8012),
        }
    )


def test_missing_shared_media_uses_stream_fallback_but_local_file_stays_local():
    async def call_next(_request):
        return Response(content=b"local", status_code=200)

    with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as temp_dir:
        media_dir = Path(temp_dir)
        local_file = media_dir / "aa" / "local.png"
        local_file.parent.mkdir(parents=True)
        local_file.write_bytes(b"local")
        forward = mock.AsyncMock(return_value=Response(content=b"remote", status_code=200))
        with (
            mock.patch.object(_proxy, "MEDIA_DIR", media_dir),
            mock.patch.object(_proxy, "proxying", return_value=True),
            mock.patch.object(_proxy, "_forward_stream", forward),
        ):
            local_response = asyncio.run(
                _proxy.data_proxy_middleware(_request("/media/aa/local.png"), call_next)
            )
            remote_response = asyncio.run(
                _proxy.data_proxy_middleware(_request("/media/aa/missing.png"), call_next)
            )

    assert local_response.body == b"local"
    assert remote_response.body == b"remote"
    forward.assert_awaited_once()


def test_missing_shared_media_thumbnail_is_forwarded_to_server():
    async def call_next(_request):
        return Response(content=b"local", status_code=200)

    query = "src=%2Fmedia%2Faa%2Fmissing.mp4&w=512"
    forward = mock.AsyncMock(return_value=Response(content=b"jpeg", status_code=200))
    with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as temp_dir:
        with (
            mock.patch.object(_proxy, "MEDIA_DIR", Path(temp_dir)),
            mock.patch.object(_proxy, "proxying", return_value=True),
            mock.patch.object(_proxy, "_forward_stream", forward),
        ):
            response = asyncio.run(
                _proxy.data_proxy_middleware(
                    _request("/api/media-thumb", query=query), call_next
                )
            )

    assert response.body == b"jpeg"
    forward.assert_awaited_once()


def test_media_fallback_rejects_path_escape_instead_of_forwarding_it():
    async def call_next(_request):
        return Response(content=b"rejected-locally", status_code=400)

    query = "src=%2Fmedia%2F..%2F..%2Foutside.db&w=512"
    forward = mock.AsyncMock(return_value=Response(content=b"unsafe", status_code=200))
    with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as temp_dir:
        with (
            mock.patch.object(_proxy, "MEDIA_DIR", Path(temp_dir)),
            mock.patch.object(_proxy, "proxying", return_value=True),
            mock.patch.object(_proxy, "_forward_stream", forward),
        ):
            response = asyncio.run(
                _proxy.data_proxy_middleware(
                    _request("/api/media-thumb", query=query), call_next
                )
            )

    assert response.status_code == 400
    forward.assert_not_awaited()


class _FakeUpstream:
    def __init__(self):
        self.status = 206
        self.headers = Message()
        self.headers["Content-Type"] = "video/mp4"
        self.headers["Content-Length"] = "3"
        self.headers["Content-Range"] = "bytes 10-12/100"
        self.headers["Accept-Ranges"] = "bytes"
        self._chunks = [b"abc", b""]
        self.closed = False

    def read(self, _size=-1):
        return self._chunks.pop(0)

    def close(self):
        self.closed = True


def test_stream_proxy_forwards_range_and_preserves_partial_response_headers():
    upstream = _FakeUpstream()
    captured = {}

    def urlopen(req, timeout):
        captured["request"] = req
        captured["timeout"] = timeout
        return upstream

    request = _request("/media/aa/video.mp4", headers={"Range": "bytes=10-12"})
    with (
        mock.patch.object(_proxy, "base_url", return_value="http://server.test"),
        mock.patch.object(_proxy, "token", return_value="secret-token"),
        mock.patch.object(_proxy.urllib.request, "urlopen", side_effect=urlopen),
    ):
        response = asyncio.run(_proxy._forward_stream(request))
        body = asyncio.run(_collect_body(response.body_iterator))

    assert body == b"abc"
    assert response.status_code == 206
    assert response.headers["content-range"] == "bytes 10-12/100"
    assert response.headers["accept-ranges"] == "bytes"
    assert captured["request"].get_header("Range") == "bytes=10-12"
    assert captured["request"].get_header("Authorization") == "Bearer secret-token"
    assert upstream.closed is True


async def _collect_body(iterator) -> bytes:
    chunks = []
    async for chunk in iterator:
        chunks.append(chunk)
    return b"".join(chunks)


def test_remote_generation_uses_preserved_image_thumb_and_video_first_frame():
    rows = [
        {
            "id": "g1",
            "creator_uid": "other",
            "assets": [
                {
                    "file_path": "/media/aa/result.mp4",
                    "type": "video",
                    "thumbnail_path": "https://expired.example/poster.jpg",
                    "cached": False,
                }
            ],
            "references": [
                {
                    "file_path": "/media/bb/reference.png",
                    "type": "image",
                    "thumbnail_path": "https://expired.example/reference.jpg",
                    "cached": False,
                }
            ],
        }
    ]
    request = _request("/api/generations")
    with (
        mock.patch.object(_proxy, "proxying", return_value=True),
        mock.patch.object(library.repo, "color_overlay_by_anchors", return_value={}),
        mock.patch.object(library.repo, "tags_overlay_by_anchors", return_value={}),
    ):
        result = library._overlay_personal_meta(rows, request)

    assert result[0]["assets"][0]["thumbnail_path"] is None
    assert result[0]["references"][0]["thumbnail_path"] == "/media/bb/reference.png"
    assert result[0]["assets"][0]["cached"] is True

"""D1/D2: 실제 루프백 HTTP 전송과 합성 파일만으로 불완전 결과 확정을 막는다."""
from __future__ import annotations

import asyncio
import io
import threading
import urllib.request
from collections import Counter
from http.server import BaseHTTPRequestHandler, HTTPServer
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import pytest
from fastapi import HTTPException
from PIL import Image

from app.routers import library
from app.services import media_cache


@pytest.fixture
def png():
    with io.BytesIO() as buffer, Image.new("RGB", (16, 16), (17, 81, 142)) as image:
        image.save(buffer, format="PNG")
        return buffer.getvalue()


@pytest.fixture
def http_fixture(png, monkeypatch):
    requests = Counter()
    # 임시 MEDIA_DIR의 사용량이 다른 테스트/실행의 전역 원장에 남지 않게 한다.
    monkeypatch.setattr(media_cache, "_PRESERVED_QUOTA_STATE", media_cache._PreservedQuotaState())

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            requests[self.path] += 1
            self.send_response(200)
            self.send_header("Content-Type", "image/png")
            if self.path != "/unknown.png":
                self.send_header("Content-Length", str(len(png)))
            self.end_headers()
            self.wfile.write(png[:40] if self.path == "/short.png" else png)

        def log_message(self, *args):
            pass

    server = HTTPServer(("127.0.0.1", 0), Handler)
    base = f"http://127.0.0.1:{server.server_address[1]}"
    thread = threading.Thread(target=server.serve_forever, kwargs={"poll_interval": 0.01}, daemon=True)

    def allow_fixture_only(url):
        assert url in {base + path for path in ("/normal.png", "/short.png", "/unknown.png")}

    monkeypatch.setattr(media_cache, "assert_public_http_url", allow_fixture_only)
    monkeypatch.setattr(media_cache, "guarded_opener",
                        lambda: urllib.request.build_opener(urllib.request.ProxyHandler({})))
    monkeypatch.setattr(media_cache, "_RETRY_BACKOFF", 0)
    # 상수는 함수 기본 인자로 이미 캡처돼 있다. 실제 대기 경계에 명시적으로 0을 준다.
    wait_for_file = media_cache._wait_for_complete_file
    monkeypatch.setattr(media_cache, "_wait_for_complete_file", lambda path: wait_for_file(path, timeout=0))
    thread.start()
    try:
        yield base, requests
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)
        assert not thread.is_alive()


@pytest.mark.parametrize("endpoint", ["/normal.png", "/unknown.png"])
def test_complete_or_unknown_length_is_cached_once(tmp_path, png, http_fixture, monkeypatch, endpoint):
    base, requests = http_fixture
    monkeypatch.setattr(media_cache, "MEDIA_DIR", tmp_path)

    async def run():
        result = await media_cache.cache_url_result(base + endpoint)
        assert result.status == "cached"
        stored = media_cache._local_path(result.path)
        assert stored.read_bytes() == png
        with Image.open(stored) as image:
            image.verify()
        again = await media_cache.cache_url_result(base + endpoint)
        assert again.status == "already"

    asyncio.run(run())
    assert requests[endpoint] == 1
    assert not list(tmp_path.rglob("*.part"))


def test_short_http_body_retries_without_committing_any_file(tmp_path, http_fixture, monkeypatch):
    base, requests = http_fixture
    monkeypatch.setattr(media_cache, "MEDIA_DIR", tmp_path)
    result = asyncio.run(media_cache.cache_url_result(base + "/short.png"))
    assert result.status == "transient"
    assert result.error_code == "network_error"
    assert result.path is None
    assert requests["/short.png"] == 3
    assert not [path for path in tmp_path.rglob("*") if path.is_file()]


@pytest.mark.parametrize("raw,expected", [(None, None), ("bad", None), ("-1", None), ("0", 0), ("92", 92)])
def test_content_length_nonnegative_or_unknown(raw, expected):
    assert media_cache._content_length(SimpleNamespace(headers={"Content-Length": raw})) == expected


def test_oversized_stream_relative_to_declared_length_is_rejected(tmp_path, png, monkeypatch):
    # urllib은 보통 선언 길이에서 읽기를 멈춘다. 이 검사는 더 많은 바이트를 반환하는 stream 경계만 검증한다.
    stream = io.BytesIO(png)
    stream.headers = {"Content-Type": "image/png", "Content-Length": str(len(png) - 1)}
    monkeypatch.setattr(media_cache, "assert_public_http_url", lambda url: None)
    monkeypatch.setattr(media_cache, "guarded_opener", lambda: SimpleNamespace(open=lambda *args, **kwargs: stream))
    with pytest.raises(media_cache.MediaCacheError) as raised:
        media_cache._download_once("https://fixture.invalid/image.png", tmp_path / "image.png")
    assert not isinstance(raised.value, media_cache.MediaCachePermanentError)
    assert not list(tmp_path.iterdir())


@pytest.mark.parametrize("failed", [[2], [0, 2], list(range(12))])
def test_merge_rejects_missing_inputs_before_encoder_or_workdir(tmp_path, monkeypatch, failed):
    count = max(failed) + 2
    resolver = AsyncMock(side_effect=[None if i in failed else (tmp_path / f"{i}.png", True) for i in range(count)])
    encoder = Mock(side_effect=AssertionError("partial encoding forbidden"))
    mkdir = Mock(side_effect=AssertionError("partial workdir forbidden"))
    monkeypatch.setattr(library, "_resolve_local_media", resolver)
    monkeypatch.setattr(library, "_merge_clips_sync", encoder)
    monkeypatch.setattr(library.tempfile, "mkdtemp", mkdir)
    with pytest.raises(HTTPException) as raised:
        asyncio.run(library.merge_videos(library.MergeReq(srcs=[f"private-{i}" for i in range(count)])))
    assert raised.value.status_code == 400
    assert f"{failed[0] + 1}번째" in raised.value.detail
    assert "private" not in raised.value.detail
    if len(failed) > 10:
        assert "외 2개" in raised.value.detail
        assert "12번째" not in raised.value.detail
    assert resolver.await_count == count
    encoder.assert_not_called()
    mkdir.assert_not_called()


@pytest.mark.parametrize("srcs,expected", [([], "병합할 항목이 없습니다"), (["a", "b"], "병합할 로컬 미디어를 찾을 수 없습니다")])
def test_merge_empty_and_all_missing_keep_existing_error(monkeypatch, srcs, expected):
    monkeypatch.setattr(library, "_resolve_local_media", AsyncMock(return_value=None))
    with pytest.raises(HTTPException) as raised:
        asyncio.run(library.merge_videos(library.MergeReq(srcs=srcs)))
    assert raised.value.status_code == 400
    assert raised.value.detail == expected


def test_merge_valid_order_and_response_cleanup(tmp_path, png, monkeypatch):
    monkeypatch.setattr(library.thumbs, "MEDIA_DIR", tmp_path)
    for index in (1, 2):
        (tmp_path / f"{index}.png").write_bytes(png)
    original_mkdtemp = library.tempfile.mkdtemp
    workdirs = []

    def make_workdir(*args, **kwargs):
        directory = original_mkdtemp(*args, dir=tmp_path, **kwargs)
        workdirs.append(directory)
        return directory

    def encode(items, workdir):
        assert [item[0].name for item in items] == ["2.png", "1.png"]
        output = workdir / "merged.mp4"
        output.write_bytes(b"synthetic output")
        return output

    monkeypatch.setattr(library.tempfile, "mkdtemp", make_workdir)
    monkeypatch.setattr(library, "_merge_clips_sync", encode)

    async def run():
        result = await library.merge_videos(library.MergeReq(srcs=["/media/2.png", "/media/1.png"]))
        assert result.status_code == 200
        assert result.media_type == "video/mp4"
        assert result.background is not None
        await result.background()

    asyncio.run(run())
    from pathlib import Path
    assert len(workdirs) == 1 and not Path(workdirs[0]).exists()


def test_merge_limit_keeps_413_without_resolving(monkeypatch):
    resolver = AsyncMock()
    monkeypatch.setattr(library, "_resolve_local_media", resolver)
    with pytest.raises(HTTPException) as raised:
        asyncio.run(library.merge_videos(library.MergeReq(srcs=["a"] * (library.MERGE_MAX_CLIPS + 1))))
    assert raised.value.status_code == 413
    resolver.assert_not_called()

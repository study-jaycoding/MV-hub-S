"""URL-only 미디어 계약: 서버 원본 저장이 기본 경로로 부활하지 않는지 검증."""

from __future__ import annotations

import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest
from fastapi import HTTPException
from fastapi.responses import FileResponse, RedirectResponse

from app.routers import generation, library


def test_cached_rows_are_serialized_back_to_their_remote_source() -> None:
    rows = [
        {
            "assets": [
                {
                    "type": "image",
                    "file_path": "/media/aa/image.png",
                    "thumbnail_path": "/media/aa/image.png",
                    "source_url": "https://cdn.example/image.png",
                    "cached": True,
                },
                {
                    "type": "video",
                    "file_path": "/media/bb/video.mp4",
                    "thumbnail_path": None,
                    "source_url": "https://cdn.example/video.mp4",
                    "cached": True,
                },
            ],
            "references": [
                {
                    "type": "image",
                    "file_path": "/media/cc/ref.png",
                    "thumbnail_path": "/media/cc/ref.png",
                    "source_url": "https://cdn.example/ref.png",
                    "cached": True,
                }
            ],
        }
    ]

    library._prefer_remote_source_urls(rows)

    image, video = rows[0]["assets"]
    reference = rows[0]["references"][0]
    assert image["file_path"] == image["thumbnail_path"] == "https://cdn.example/image.png"
    assert video["file_path"] == "https://cdn.example/video.mp4"
    assert video["thumbnail_path"] is None
    assert reference["file_path"] == "https://cdn.example/ref.png"
    assert image["cached"] is video["cached"] is reference["cached"] is False


def test_remote_media_thumb_uses_bounded_thumbnail_cache(monkeypatch, tmp_path) -> None:
    source = tmp_path / "source.jpg"
    source.write_bytes(b"source")
    cached = tmp_path / "thumb.jpg"
    cached.write_bytes(b"thumb")

    cache_source = AsyncMock(return_value="/media/.thumb-sources/source.jpg")
    monkeypatch.setattr(library._proxy, "is_shared_team_server", lambda: False)
    monkeypatch.setattr(library.media_cache, "cache_thumb_source", cache_source)
    monkeypatch.setattr(library.thumbs, "_media_target", lambda _rel: source)
    monkeypatch.setattr(library.thumbs, "ensure_thumb", lambda _target, _width: cached)
    monkeypatch.setattr(library.thumbs, "mark_thumb_used", lambda _path: None)

    response = asyncio.run(library.media_thumb("https://cdn.example/image.png", 256))

    assert isinstance(response, FileResponse)
    cache_source.assert_awaited_once_with("https://cdn.example/image.png")


def test_shared_server_redirects_remote_thumb_without_writing_cache(monkeypatch) -> None:
    cache_source = AsyncMock()
    monkeypatch.setattr(library._proxy, "is_shared_team_server", lambda: True)
    monkeypatch.setattr(library, "assert_public_http_url", lambda _url: None)
    monkeypatch.setattr(library.media_cache, "cache_thumb_source", cache_source)

    response = asyncio.run(library.media_thumb("https://cdn.example/image.png", 256))

    assert isinstance(response, RedirectResponse)
    assert response.headers["location"] == "https://cdn.example/image.png"
    cache_source.assert_not_awaited()


def test_remote_thumb_prewarm_skips_video_originals() -> None:
    rows = [
        {"assets": [{"type": "video", "file_path": "https://cdn.example/video.mp4"}]},
        {
            "assets": [
                {
                    "type": "video",
                    "file_path": "https://cdn.example/video-2.mp4",
                    "thumbnail_path": "https://cdn.example/poster.jpg",
                }
            ]
        },
        {"assets": [{"type": "image", "file_path": "https://cdn.example/image.jpg"}]},
    ]

    assert library._remote_thumb_urls(rows) == [
        "https://cdn.example/poster.jpg",
        "https://cdn.example/image.jpg",
    ]


def test_shared_server_does_not_schedule_remote_thumb_prewarm(monkeypatch) -> None:
    background = MagicMock()
    rows = [{"assets": [{"type": "image", "file_path": "https://cdn.example/image.jpg"}]}]
    monkeypatch.setattr(library._proxy, "is_shared_team_server", lambda: True)

    assert library._schedule_remote_thumb_prewarm(background, rows) is False
    background.add_task.assert_not_called()


def test_worker_hub_schedules_remote_thumb_prewarm(monkeypatch) -> None:
    background = MagicMock()
    rows = [{"assets": [{"type": "image", "file_path": "https://cdn.example/image.jpg"}]}]
    monkeypatch.setattr(library._proxy, "is_shared_team_server", lambda: False)

    assert library._schedule_remote_thumb_prewarm(background, rows) is True
    background.add_task.assert_called_once_with(
        library.thumbs.prewarm_remote_thumbs,
        ["https://cdn.example/image.jpg"],
    )


def test_manual_cache_is_blocked_in_default_url_only_mode(monkeypatch) -> None:
    monkeypatch.setattr(generation, "MEDIA_PRESERVATION_ENABLED", False)
    queued = AsyncMock()
    monkeypatch.setattr(generation.repo, "request_media_preservation_for_all_done", queued)

    with pytest.raises(HTTPException) as exc_info:
        asyncio.run(generation.cache_all(SimpleNamespace()))

    assert exc_info.value.status_code == 409
    queued.assert_not_awaited()

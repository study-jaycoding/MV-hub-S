from __future__ import annotations

from typing import Optional

IMAGE_EXTENSIONS = (".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp")
VIDEO_EXTENSIONS = (".mp4", ".mov", ".webm", ".mkv", ".avi")
AUDIO_EXTENSIONS = (".mp3", ".wav", ".ogg", ".flac", ".m4a", ".aac")
CACHE_MEDIA_EXTENSIONS = IMAGE_EXTENSIONS + VIDEO_EXTENSIONS


def asset_media_type(name: str, *, include_audio: bool = False) -> Optional[str]:
    low = name.lower()
    if low.endswith(IMAGE_EXTENSIONS):
        return "image"
    if low.endswith(VIDEO_EXTENSIONS):
        return "video"
    if include_audio and low.endswith(AUDIO_EXTENSIONS):
        return "audio"
    return None


def media_type_from_url(url: Optional[str]) -> str:
    if not url:
        return "image"
    low = url.lower().split("?", 1)[0]
    return "video" if low.endswith(VIDEO_EXTENSIONS) else "image"

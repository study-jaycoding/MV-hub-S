from __future__ import annotations

from typing import Optional

IMAGE_EXTENSIONS = (".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp")
VIDEO_EXTENSIONS = (".mp4", ".mov", ".webm", ".mkv", ".avi")
AUDIO_EXTENSIONS = (".mp3", ".wav", ".ogg", ".flac", ".m4a", ".aac")
CACHE_MEDIA_EXTENSIONS = IMAGE_EXTENSIONS + VIDEO_EXTENSIONS

# 브라우저에 파일을 돌려줄 때 ``mimetypes``나 Windows 레지스트리 추정값을 사용하지 않는다.
# 허용한 미디어 확장자만 고정 MIME으로 응답해야 이름만 바꾼 HTML도 같은 오리진 문서로
# 실행되지 않는다. 새 형식을 추가할 때는 분류 튜플과 이 표를 함께 갱신한다.
ASSET_CONTENT_TYPES = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".gif": "image/gif",
    ".bmp": "image/bmp",
    ".mp4": "video/mp4",
    ".mov": "video/quicktime",
    ".webm": "video/webm",
    ".mkv": "video/x-matroska",
    ".avi": "video/x-msvideo",
    ".mp3": "audio/mpeg",
    ".wav": "audio/wav",
    ".ogg": "audio/ogg",
    ".flac": "audio/flac",
    ".m4a": "audio/mp4",
    ".aac": "audio/aac",
}


def asset_media_type(name: str, *, include_audio: bool = False) -> Optional[str]:
    low = name.lower()
    if low.endswith(IMAGE_EXTENSIONS):
        return "image"
    if low.endswith(VIDEO_EXTENSIONS):
        return "video"
    if include_audio and low.endswith(AUDIO_EXTENSIONS):
        return "audio"
    return None


def asset_content_type(name: str) -> Optional[str]:
    """지원 Assets 파일의 고정 HTTP Content-Type을 반환한다."""
    low = name.lower()
    for extension, content_type in ASSET_CONTENT_TYPES.items():
        if low.endswith(extension):
            return content_type
    return None


def media_type_from_url(url: Optional[str]) -> str:
    if not url:
        return "image"
    low = url.lower().split("?", 1)[0]
    return "video" if low.endswith(VIDEO_EXTENSIONS) else "image"

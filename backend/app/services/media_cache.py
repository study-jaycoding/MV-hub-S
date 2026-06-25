"""미디어 로컬 캐시 — 출처 영속화 (provenance hardening).

설계 근거: project_content_hub_provenance — 소스·결과물이 원격 URL(Higgsfield
cloudfront, 계정 귀속·만료 가능)에만 있으면 나중에 재사용이 깨진다. 바이트를
로컬 MEDIA_DIR 로 내려받아 보관하고, 원본 URL 은 별도 컬럼(source_url)에 보존한다.

- 콘텐츠 주소화: URL 의 sha1 으로 파일명을 만들어 중복 다운로드를 피한다(dedupe).
- 비차단: 다운로드는 asyncio.to_thread 로 수행, 호출부에서 동시성 제한(gather).
- 실패 시 None 반환 → 호출부는 원격 URL 을 그대로 유지(출처는 source_url 로 보존).
"""

from __future__ import annotations

import asyncio
import hashlib
import logging
import os
import shutil
import time
import urllib.request
import uuid
from pathlib import Path
from typing import Optional
from urllib.parse import urlsplit, urlunsplit

from ..config import MEDIA_DIR

log = logging.getLogger(__name__)

_TIMEOUT = 30
_CHUNK_SIZE = 65536
_ATTEMPTS = 3
_RETRY_BACKOFF = 0.4
_MAX_BYTES = int(os.getenv("CONTENT_HUB_MEDIA_CACHE_MAX_BYTES", str(1024 * 1024 * 1024)))
_MIN_FREE_BYTES = int(os.getenv("CONTENT_HUB_MEDIA_CACHE_MIN_FREE_BYTES", str(1024 * 1024 * 1024)))
_EXTS = (".png", ".jpg", ".jpeg", ".webp", ".gif", ".mp4", ".mov", ".webm")
_TEXT_ERROR_TYPES = {
    "application/json",
    "application/problem+json",
    "application/xml",
    "text/html",
    "text/plain",
    "text/xml",
}
_HTMLISH_PREFIXES = (b"<!doctype", b"<html", b"<?xml")
_LOCKS: dict[str, asyncio.Lock] = {}
_LOCKS_GUARD = asyncio.Lock()


class MediaCacheError(RuntimeError):
    """미디어 캐시 다운로드 실패."""


class MediaCachePermanentError(MediaCacheError):
    """재시도해도 의미 없는 응답/환경 문제."""


def _ext_of(url: str) -> str:
    path = url.split("?", 1)[0]
    for e in _EXTS:
        if path.lower().endswith(e):
            return e
    return ".bin"


def local_rel_for(url: str) -> str:
    """URL 에 대응하는 로컬 상대 경로(/media/<2>/<sha>.<ext>). 다운로드 여부와 무관.

    sha 앞 2글자로 2단계 샤딩 → 한 폴더에 수만 파일이 쌓여 FS 조회가 느려지는 걸 방지(최대 256 버킷)."""
    sha = hashlib.sha1(url.encode("utf-8")).hexdigest()[:20]
    return f"/media/{sha[:2]}/{sha}{_ext_of(url)}"


def _local_path(rel: str) -> Path:
    return MEDIA_DIR / rel.removeprefix("/media/")


def is_cached(url: str) -> bool:
    return _local_path(local_rel_for(url)).exists()


def _safe_url_for_log(url: str) -> str:
    parts = urlsplit(url)
    return urlunsplit((parts.scheme, parts.netloc, parts.path, "", ""))


def _content_length(resp) -> Optional[int]:
    raw = resp.headers.get("Content-Length")
    if not raw:
        return None
    try:
        return int(raw)
    except (TypeError, ValueError):
        return None


def _ensure_disk_space(path: Path, incoming_bytes: int = 0) -> None:
    free = shutil.disk_usage(path).free
    if free - max(0, incoming_bytes) < _MIN_FREE_BYTES:
        raise MediaCachePermanentError(
            f"insufficient free disk space: free={free}, incoming={incoming_bytes}, reserve={_MIN_FREE_BYTES}"
        )


def _validate_response(content_type: str, head: bytes) -> None:
    ctype = (content_type or "").split(";", 1)[0].strip().lower()
    if ctype in _TEXT_ERROR_TYPES or ctype.startswith("text/"):
        raise MediaCachePermanentError(f"unexpected content-type for media: {content_type or '(missing)'}")
    stripped = head.lstrip().lower()
    if any(stripped.startswith(prefix) for prefix in _HTMLISH_PREFIXES):
        raise MediaCachePermanentError("response body looks like HTML/XML, not media")


async def _lock_for(rel: str) -> asyncio.Lock:
    async with _LOCKS_GUARD:
        lock = _LOCKS.get(rel)
        if lock is None:
            lock = asyncio.Lock()
            _LOCKS[rel] = lock
        return lock


def _download_once(url: str, target: Path) -> None:
    # 청크 스트리밍 — 큰 mp4 를 통째로 메모리에 read 하지 않는다(동시 다운로드 시 메모리 스파이크 방지).
    req = urllib.request.Request(url, headers={"User-Agent": "content-hub/0.1"})
    tmp = target.with_suffix(target.suffix + f".{uuid.uuid4().hex}.part")
    written = 0
    try:
        with urllib.request.urlopen(req, timeout=_TIMEOUT) as resp, open(tmp, "wb") as f:
            length = _content_length(resp)
            if length is not None and length > _MAX_BYTES:
                raise MediaCachePermanentError(f"media too large: content_length={length}, max={_MAX_BYTES}")
            _ensure_disk_space(target.parent, length or 0)
            content_type = resp.headers.get("Content-Type") or ""
            saw_head = False
            while True:
                chunk = resp.read(_CHUNK_SIZE)
                if not chunk:
                    break
                if not saw_head:
                    _validate_response(content_type, chunk[:512])
                    saw_head = True
                written += len(chunk)
                if written > _MAX_BYTES:
                    raise MediaCachePermanentError(f"media too large while streaming: bytes={written}, max={_MAX_BYTES}")
                if written == len(chunk) or written % (16 * 1024 * 1024) < len(chunk):
                    _ensure_disk_space(target.parent, 0)
                f.write(chunk)
        if written <= 0:
            raise MediaCachePermanentError("empty media response")
        tmp.replace(target)  # 원자적 교체(부분 파일 방지)
    except Exception:
        try:
            tmp.unlink(missing_ok=True)
        except OSError:
            pass
        raise


def _download(url: str, target: Path) -> None:
    last: Optional[BaseException] = None
    for attempt in range(1, _ATTEMPTS + 1):
        try:
            _download_once(url, target)
            return
        except MediaCachePermanentError:
            raise
        except Exception as e:  # noqa: BLE001 — 네트워크/CloudFront 일시 오류는 재시도 후 최종 로깅
            last = e
            if attempt < _ATTEMPTS:
                time.sleep(_RETRY_BACKOFF * attempt)
    raise MediaCacheError(f"download failed after {_ATTEMPTS} attempts: {last}") from last


async def cache_url(url: Optional[str]) -> Optional[str]:
    """원격 URL 을 로컬로 내려받고 /media 상대경로 반환. 이미 로컬이거나 실패 시 처리.

    - url 이 비었거나 이미 /media/.. 면 그대로(또는 None).
    - http(s) 가 아니면 캐시 대상 아님 → None.
    - 성공: /media/<sha>.<ext> 반환. 실패: None.
    """
    if not url:
        return None
    if url.startswith("/media/"):
        return url
    if not url.startswith(("http://", "https://")):
        return None

    rel = local_rel_for(url)
    target = _local_path(rel)
    if target.exists():
        return rel
    lock = await _lock_for(rel)
    async with lock:
        if target.exists():
            return rel
        try:
            target.parent.mkdir(parents=True, exist_ok=True)  # 샤딩 서브디렉터리(/media/<2>/) 보장
            await asyncio.to_thread(_download, url, target)
            return rel
        except Exception as e:  # noqa: BLE001 — 호출부 동작 보존: 실패 시 원격 URL 유지
            log.warning("media cache download failed url=%s target=%s reason=%s", _safe_url_for_log(url), target, e)
            return None


def migrate_sharding() -> int:
    """기존 평면 /media/<sha>.ext → 2단계 샤딩(/media/<2>/<sha>.ext)으로 1회 이전 + DB 경로 갱신.

    멱등: 평면 파일이 없으면 즉시 종료(샤딩 후 top-level 은 서브디렉터리뿐 → 매 부팅 빠르게 통과).
    자기치유 순서: DB 경로를 먼저 갱신하고 파일을 옮긴다 → 이동 직전 크래시 시 재부팅의 재시도가
    남은 평면 파일을 마저 옮겨 복구한다(반대 순서면 DB 가 새 경로를 가리키는데 파일은 평면에 남아 영구 손상).
    """
    if not MEDIA_DIR.exists():
        return 0
    from ..db import get_connection  # 지연 import — db 는 media_cache 를 모름(순환 없음)

    _COLS = (("asset", "file_path"), ("asset", "thumbnail_path"),
             ("reference", "file_path"), ("reference", "thumbnail_path"))
    moved = 0
    for entry in list(MEDIA_DIR.iterdir()):
        if not entry.is_file() or entry.name.endswith(".part"):
            continue  # 이미 샤딩된 서브디렉터리·미완성 다운로드 잔재는 건너뜀
        name = entry.name
        old_rel, new_rel = f"/media/{name}", f"/media/{name[:2]}/{name}"
        target = MEDIA_DIR / name[:2] / name
        # 1) DB 경로 먼저 갱신(4개 컬럼) — 자기치유 순서
        with get_connection() as conn:
            for table, col in _COLS:
                conn.execute(f"UPDATE {table} SET {col}=? WHERE {col}=?", (new_rel, old_rel))
        # 2) 파일 이동(같은 볼륨 → 원자적). 이미 존재(내용주소 중복)면 평면본 제거.
        target.parent.mkdir(parents=True, exist_ok=True)
        if target.exists():
            entry.unlink()
        else:
            entry.replace(target)
        moved += 1
    return moved

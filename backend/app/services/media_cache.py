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
import threading
import time
import urllib.request
import uuid
from pathlib import Path
from typing import Optional
from urllib.parse import urlsplit, urlunsplit

from ..config import MEDIA_DIR
from .media_types import CACHE_MEDIA_EXTENSIONS
from .net_guard import BlockedURLError, assert_public_http_url, guarded_opener

log = logging.getLogger(__name__)

_TIMEOUT = 30
_CHUNK_SIZE = 65536
_ATTEMPTS = 3
_RETRY_BACKOFF = 0.4
_CONCURRENT_CACHE_WAIT = float(os.getenv("CONTENT_HUB_MEDIA_CACHE_WAIT_SECONDS", "3.0"))
_MAX_BYTES = int(os.getenv("CONTENT_HUB_MEDIA_CACHE_MAX_BYTES", str(1024 * 1024 * 1024)))
_MIN_FREE_BYTES = int(os.getenv("CONTENT_HUB_MEDIA_CACHE_MIN_FREE_BYTES", str(1024 * 1024 * 1024)))
# 팀 목록 썸네일을 만들기 위해 잠깐 보관하는 원격 원본은 영구 보존 미디어와 분리한다. 예전에는
# MEDIA_DIR 본 경로에 계속 쌓여 .thumbs 1GB 상한과 무관하게 디스크가 증가했다.
THUMB_SOURCE_CACHE_MAX_BYTES = max(1, int(
    os.getenv("CONTENT_HUB_THUMB_SOURCE_CACHE_MAX_BYTES", str(2 * 1024 * 1024 * 1024))
))
THUMB_SOURCE_FILE_MAX_BYTES = max(1, int(
    os.getenv("CONTENT_HUB_THUMB_SOURCE_FILE_MAX_BYTES", str(128 * 1024 * 1024))
))
_THUMB_SOURCE_TOUCH_MIN_AGE = 86400.0
_THUMB_SOURCE_STATE_LOCK = threading.Lock()
_THUMB_SOURCE_STATE: dict[str, tuple[int, set[str]]] = {}
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
_LOCK_REFS: dict[str, int] = {}  # rel -> 사용 중 코루틴 수. 0 이 되면 _LOCKS 에서 제거(락 누적 방지).
_LOCKS_GUARD = asyncio.Lock()


class MediaCacheError(RuntimeError):
    """미디어 캐시 다운로드 실패."""


class MediaCachePermanentError(MediaCacheError):
    """재시도해도 의미 없는 응답/환경 문제."""


def _ext_of(url: str) -> str:
    path = url.split("?", 1)[0]
    for e in CACHE_MEDIA_EXTENSIONS:
        if path.lower().endswith(e):
            return e
    return ".bin"


def local_rel_for(url: str) -> str:
    """URL 에 대응하는 로컬 상대 경로(/media/<2>/<sha>.<ext>). 다운로드 여부와 무관.

    sha 앞 2글자로 2단계 샤딩 → 한 폴더에 수만 파일이 쌓여 FS 조회가 느려지는 걸 방지(최대 256 버킷)."""
    sha = hashlib.sha1(url.encode("utf-8")).hexdigest()[:20]
    return f"/media/{sha[:2]}/{sha}{_ext_of(url)}"


def thumb_source_rel_for(url: str) -> str:
    """썸네일 생성 전용 원격 원본 경로 — 영구 MEDIA 파일과 분리해 안전하게 LRU 정리한다."""
    sha = hashlib.sha1(url.encode("utf-8")).hexdigest()[:20]
    return f"/media/.thumb-sources/{sha[:2]}/{sha}{_ext_of(url)}"


def _local_path(rel: str) -> Path:
    return MEDIA_DIR / rel.removeprefix("/media/")


def is_cached(url: str) -> bool:
    return _is_complete_file(_local_path(local_rel_for(url)))


def _is_complete_file(path: Path) -> bool:
    try:
        return path.is_file() and path.stat().st_size > 0
    except OSError:
        return False


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


async def _wait_for_complete_file(path: Path, timeout: float = _CONCURRENT_CACHE_WAIT) -> bool:
    """다른 prewarm/워커가 같은 URL 캐시를 완성 중이면 잠깐 기다렸다가 재확인."""
    if _is_complete_file(path):
        return True
    deadline = time.monotonic() + max(0.0, timeout)
    while time.monotonic() < deadline:
        await asyncio.sleep(min(0.05, max(0.0, deadline - time.monotonic())))
        if _is_complete_file(path):
            return True
    return _is_complete_file(path)


def _validate_response(content_type: str, head: bytes) -> None:
    ctype = (content_type or "").split(";", 1)[0].strip().lower()
    if ctype in _TEXT_ERROR_TYPES or ctype.startswith("text/"):
        raise MediaCachePermanentError(f"unexpected content-type for media: {content_type or '(missing)'}")
    stripped = head.lstrip().lower()
    if any(stripped.startswith(prefix) for prefix in _HTMLISH_PREFIXES):
        raise MediaCachePermanentError("response body looks like HTML/XML, not media")


async def _acquire_lock(rel: str) -> asyncio.Lock:
    # rel 별 직렬화 락을 얻고 참조수 +1. 참조수>0 인 동안 항목이 유지되므로 같은 URL
    # 동시 호출자는 반드시 같은 Lock 객체를 공유한다(가드 안에서 get→증가 사이 await 없음 = 원자적).
    async with _LOCKS_GUARD:
        lock = _LOCKS.get(rel)
        if lock is None:
            lock = asyncio.Lock()
            _LOCKS[rel] = lock
        _LOCK_REFS[rel] = _LOCK_REFS.get(rel, 0) + 1
        return lock


async def _release_lock(rel: str) -> None:
    # 참조수 -1. 0 이 되면 더 기다리는 코루틴이 없으므로 락을 제거한다(메모리 누적 방지).
    async with _LOCKS_GUARD:
        remaining = _LOCK_REFS.get(rel, 0) - 1
        if remaining <= 0:
            _LOCK_REFS.pop(rel, None)
            _LOCKS.pop(rel, None)
        else:
            _LOCK_REFS[rel] = remaining


def _download_once(url: str, target: Path, max_bytes: int = _MAX_BYTES) -> None:
    # SSRF 방어 — 내부/사설 대역·리다이렉트 우회 차단(공개 CDN 만 허용). 차단은 영구 오류(재시도 안 함).
    try:
        assert_public_http_url(url)
    except BlockedURLError as e:
        raise MediaCachePermanentError(str(e))
    # 청크 스트리밍 — 큰 mp4 를 통째로 메모리에 read 하지 않는다(동시 다운로드 시 메모리 스파이크 방지).
    req = urllib.request.Request(url, headers={"User-Agent": "content-hub/0.1"})
    opener = guarded_opener()  # 3xx 리다이렉트로 내부망 우회 방지
    tmp = target.with_suffix(target.suffix + f".{uuid.uuid4().hex}.part")
    written = 0
    try:
        with opener.open(req, timeout=_TIMEOUT) as resp, open(tmp, "wb") as f:
            length = _content_length(resp)
            if length is not None and length > max_bytes:
                raise MediaCachePermanentError(f"media too large: content_length={length}, max={max_bytes}")
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
                if written > max_bytes:
                    raise MediaCachePermanentError(f"media too large while streaming: bytes={written}, max={max_bytes}")
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


def _download(url: str, target: Path, max_bytes: int = _MAX_BYTES) -> None:
    last: Optional[BaseException] = None
    for attempt in range(1, _ATTEMPTS + 1):
        try:
            _download_once(url, target, max_bytes)
            return
        except (MediaCachePermanentError, BlockedURLError):
            raise  # 내부망/사설·리다이렉트 차단은 영구 오류 — 재시도해도 소용없다
        except Exception as e:  # noqa: BLE001 — 네트워크/CloudFront 일시 오류는 재시도 후 최종 로깅
            last = e
            if attempt < _ATTEMPTS:
                time.sleep(_RETRY_BACKOFF * attempt)
    raise MediaCacheError(f"download failed after {_ATTEMPTS} attempts: {last}") from last


def _thumb_source_dir() -> Path:
    return MEDIA_DIR / ".thumb-sources"


def _thumb_source_entries(root: Path) -> list[tuple[float, int, Path]]:
    """전용 캐시 파일만 열거. 심링크/정션은 외부 파일 삭제 위험 때문에 순회하지 않는다."""
    if not root.exists() or root.is_symlink():
        return []
    entries: list[tuple[float, int, Path]] = []
    try:
        for shard in root.iterdir():
            if shard.is_symlink() or not shard.is_dir():
                continue
            for path in shard.iterdir():
                if path.is_symlink() or not path.is_file() or path.name.endswith(".part"):
                    continue
                try:
                    st = path.stat()
                except OSError:
                    continue
                entries.append((st.st_mtime, st.st_size, path))
    except OSError:
        return []
    return entries


def _evict_thumb_sources_locked(root: Path, max_bytes: int) -> int:
    entries = _thumb_source_entries(root)
    total = sum(size for _mtime, size, _path in entries)
    removed = 0
    if total > max_bytes:
        entries.sort(key=lambda item: item[0])
        for _mtime, size, path in entries:
            if total <= max_bytes:
                break
            try:
                path.unlink()
                total -= size
                removed += 1
            except OSError:
                continue
    existing = {str(path) for _mtime, _size, path in _thumb_source_entries(root)}
    actual_total = 0
    for path_text in existing:
        try:
            actual_total += Path(path_text).stat().st_size
        except OSError:
            pass
    _THUMB_SOURCE_STATE[str(root)] = (actual_total, existing)
    return removed


def evict_thumb_source_cache(max_bytes: int = THUMB_SOURCE_CACHE_MAX_BYTES) -> int:
    """썸네일 원본 전용 캐시를 LRU(mtime)로 제한. 영구 MEDIA 원본은 절대 대상이 아니다."""
    root = _thumb_source_dir()
    with _THUMB_SOURCE_STATE_LOCK:
        return _evict_thumb_sources_locked(root, max(1, max_bytes))


def _account_thumb_source(target: Path) -> None:
    """새 파일을 메모리 총량에 반영하고 상한 초과 때만 디렉터리를 스캔·정리한다."""
    root = _thumb_source_dir()
    key = str(root)
    target_key = str(target)
    with _THUMB_SOURCE_STATE_LOCK:
        state = _THUMB_SOURCE_STATE.get(key)
        if state is None:
            _evict_thumb_sources_locked(root, THUMB_SOURCE_CACHE_MAX_BYTES)
            return
        total, known = state
        if target_key not in known:
            try:
                total += target.stat().st_size
                known = {*known, target_key}
            except OSError:
                return
        _THUMB_SOURCE_STATE[key] = (total, known)
        if total > THUMB_SOURCE_CACHE_MAX_BYTES:
            _evict_thumb_sources_locked(root, THUMB_SOURCE_CACHE_MAX_BYTES)


def _mark_thumb_source_used(path: Path) -> None:
    try:
        if time.time() - path.stat().st_mtime > _THUMB_SOURCE_TOUCH_MIN_AGE:
            os.utime(path)
    except OSError:
        pass


async def _cache_http_url(url: str, rel: str, max_bytes: Optional[int] = None) -> Optional[str]:
    """검증·락·다운로드 공용 구현. max_bytes=None이면 영구 미디어 기본 상한을 쓴다."""
    target = _local_path(rel)
    if _is_complete_file(target):
        return rel
    lock = await _acquire_lock(rel)
    try:
        async with lock:
            if _is_complete_file(target):
                return rel
            try:
                target.parent.mkdir(parents=True, exist_ok=True)
                if max_bytes is None:
                    await asyncio.to_thread(_download, url, target)
                else:
                    await asyncio.to_thread(_download, url, target, max_bytes)
                return rel if _is_complete_file(target) else None
            except Exception as e:  # noqa: BLE001 — 호출부 동작 보존: 실패 시 원격 URL 유지
                if await _wait_for_complete_file(target):
                    log.info(
                        "media cache reused concurrently completed file url=%s target=%s",
                        _safe_url_for_log(url),
                        target,
                    )
                    return rel
                log.warning(
                    "media cache download failed url=%s target=%s reason=%s",
                    _safe_url_for_log(url), target, e,
                )
                return None
    finally:
        await _release_lock(rel)


async def cache_url(url: Optional[str]) -> Optional[str]:
    """보존용 원격 URL 을 로컬로 내려받고 /media 상대경로 반환. 이미 로컬이거나 실패 시 처리.

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

    return await _cache_http_url(url, local_rel_for(url))


async def cache_thumb_source(url: Optional[str]) -> Optional[str]:
    """원격 썸네일 생성용 원본을 bounded 전용 캐시에 저장한다.

    영구 보존용 cache_url과 경로를 분리해 LRU 정리가 실제 생성 결과·최종본을 지우지 못하게 한다.
    """
    if not url or not url.startswith(("http://", "https://")):
        return None
    rel = thumb_source_rel_for(url)
    target = _local_path(rel)
    result = await _cache_http_url(url, rel, THUMB_SOURCE_FILE_MAX_BYTES)
    if not result:
        return None
    await asyncio.to_thread(_mark_thumb_source_used, target)
    await asyncio.to_thread(_account_thumb_source, target)
    return result if _is_complete_file(target) else None


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

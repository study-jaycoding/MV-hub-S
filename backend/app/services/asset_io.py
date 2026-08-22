"""Assets 파일 입출력 공용 서비스.

라우터는 대상 프로젝트와 HTTP 오류만 결정한다. 큰 업로드의 청크 저장, 내용 지문,
중복 파일 탐색, 충돌 없는 최종 파일 확정처럼 디스크 일관성에 직접 관계된 로직은
이 모듈에서 한 번만 구현한다.
"""

from __future__ import annotations

import hashlib
import os
import threading
import uuid
from contextlib import contextmanager
from pathlib import Path
from typing import Optional, Protocol

from . import media_cache
from .async_tools import to_thread_non_abandon
from .media_types import asset_media_type
from .path_safety import safe_join


UPLOAD_CHUNK_SIZE = media_cache._CHUNK_SIZE
UPLOAD_MAX_BYTES = int(
    os.getenv("CONTENT_HUB_UPLOAD_MAX_BYTES", str(media_cache._MAX_BYTES))
)
UPLOAD_MAX_FILES = 500
ZIP_MAX_FILES = 1000


class AsyncUpload(Protocol):
    async def read(self, size: int = -1) -> bytes: ...


class UploadTooLarge(Exception):
    """업로드가 ``UPLOAD_MAX_BYTES``를 넘었다."""


def media_type(name: str) -> Optional[str]:
    return asset_media_type(name, include_audio=True)


def sha256_file(path: Path) -> Optional[str]:
    try:
        digest = hashlib.sha256()
        with path.open("rb") as source:
            for chunk in iter(lambda: source.read(1024 * 1024), b""):
                digest.update(chunk)
        return digest.hexdigest()
    except OSError:
        return None


def find_same_media(
    dest: Path,
    digest: str,
    media_kind: str,
    size: Optional[int] = None,
) -> Optional[Path]:
    """폴더 안에서 같은 종류·크기·내용의 미디어를 찾는다."""
    try:
        for path in dest.iterdir():
            if not path.is_file() or media_type(path.name) != media_kind:
                continue
            if size is not None:
                try:
                    if path.stat().st_size != size:
                        continue
                except OSError:
                    continue
            if sha256_file(path) == digest:
                return path
    except OSError:
        return None
    return None


# 같은 내용의 동시 업로드는 기존 파일 재검색부터 새 파일 확정까지 직렬화한다.
# refcount 는 잠금 대기자까지 포함하고 마지막 사용자가 키를 회수해 목적지 수만큼 누적되지 않는다.
# ★단일 프로세스 범위다. 다중 프로세스의 동일 내용 중복 생성은 이 계약의 범위 밖이며,
# 파일명 충돌 자체는 종전의 commit_unique_tmp hardlink/O_EXCL 규칙으로 계속 방어한다.
_MEDIA_COMMIT_LOCKS: dict[
    tuple[str, str, str, int],
    tuple[threading.Lock, int],
] = {}
_MEDIA_COMMIT_LOCKS_GUARD = threading.Lock()


@contextmanager
def _media_commit_lock(key: tuple[str, str, str, int]):
    with _MEDIA_COMMIT_LOCKS_GUARD:
        entry = _MEDIA_COMMIT_LOCKS.get(key)
        lock = entry[0] if entry else threading.Lock()
        users = entry[1] if entry else 0
        _MEDIA_COMMIT_LOCKS[key] = (lock, users + 1)
    try:
        with lock:
            yield
    finally:
        with _MEDIA_COMMIT_LOCKS_GUARD:
            current, users = _MEDIA_COMMIT_LOCKS[key]
            if users <= 1:
                _MEDIA_COMMIT_LOCKS.pop(key, None)
            else:
                _MEDIA_COMMIT_LOCKS[key] = (current, users - 1)


async def stream_upload_tmp(
    upload: AsyncUpload,
    dest_dir: Path,
    *,
    max_bytes: int = UPLOAD_MAX_BYTES,
) -> tuple[Path, int, str]:
    """업로드를 목적 폴더의 임시 파일로 스트리밍하고 내용 지문을 반환한다.

    전체 파일을 메모리에 올리지 않으며 실패하거나 상한을 넘으면 임시 파일을 지운다.
    ``max_bytes``는 테스트와 정책별 호출을 위해 주입 가능하게 둔다.
    """
    tmp = dest_dir / f".upload-{uuid.uuid4().hex}.part"
    digest = hashlib.sha256()
    written = 0
    try:
        with tmp.open("xb") as target:
            while True:
                chunk = await upload.read(UPLOAD_CHUNK_SIZE)
                if not chunk:
                    break
                written += len(chunk)
                if written > max_bytes:
                    raise UploadTooLarge()
                digest.update(chunk)
                await to_thread_non_abandon(target.write, chunk)
        return tmp, written, digest.hexdigest()
    except BaseException:
        tmp.unlink(missing_ok=True)
        raise


def commit_unique_tmp(tmp: Path, dest_dir: Path, raw_name: str) -> Path:
    """임시 파일을 덮어쓰기 없이 고유한 최종 이름으로 원자 확정한다."""
    stem, ext = Path(raw_name).stem, Path(raw_name).suffix
    index = 1
    try:
        while True:
            name = raw_name if index == 1 else f"{stem}_{index}{ext}"
            target = safe_join(dest_dir, name)
            if target is None:
                raise ValueError("안전하지 않은 파일명")
            try:
                os.link(tmp, target)
                tmp.unlink(missing_ok=True)
                return target
            except FileExistsError:
                index += 1
                continue
            except OSError:
                # 하드링크를 지원하지 않는 파일시스템에서도 O_EXCL로 이름을 먼저 선점한다.
                try:
                    fd = os.open(
                        str(target),
                        os.O_CREAT | os.O_EXCL | os.O_WRONLY,
                    )
                    os.close(fd)
                except FileExistsError:
                    index += 1
                    continue
                try:
                    os.replace(tmp, target)
                except BaseException:
                    try:
                        os.unlink(target)
                    except OSError:
                        pass
                    raise
                return target
    except BaseException:
        tmp.unlink(missing_ok=True)
        raise


def find_or_commit_media(
    tmp: Path,
    dest: Path,
    raw_name: str,
    digest: str,
    kind: str,
    size: int,
) -> tuple[Path, bool]:
    """같은 미디어 재검색과 고유 이름 확정을 한 프로세스 안에서 원자화한다.

    반환 bool 은 기존 파일 재사용 여부다. 해시·종류·크기 판정과 파일명 충돌 규칙은
    각각 ``find_same_media``와 ``commit_unique_tmp``의 기존 계약을 그대로 사용한다.
    """
    try:
        normalized_dest = dest.resolve()
        key = (
            os.path.normcase(str(normalized_dest)),
            digest,
            kind,
            size,
        )
        with _media_commit_lock(key):
            existing = find_same_media(normalized_dest, digest, kind, size)
            if existing is not None:
                tmp.unlink(missing_ok=True)
                return existing, True
            return commit_unique_tmp(tmp, normalized_dest, raw_name), False
    except BaseException:
        tmp.unlink(missing_ok=True)
        raise

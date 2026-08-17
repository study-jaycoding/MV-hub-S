"""HTTP 업로드의 파일 수·개별 크기·요청 전체 크기 계약.

FastAPI가 ``UploadFile``을 라우터에 넘길 때는 Starlette가 multipart 본문을 이미 메모리나
임시파일에 spool한 뒤다. 라우터에서 파일 크기만 검사하면 거대한 요청이 입구를 통과하는 문제를
막지 못한다. ``UploadBodyLimitMiddleware``는 파싱 전 원시 ASGI 바이트를 세고, 라우터는
Starlette가 계산한 실제 파일 크기를 다시 검사해 multipart 경계 오버헤드까지 구분한다.
"""

from __future__ import annotations

import logging
import os
from dataclasses import dataclass
from typing import BinaryIO, Iterable, Protocol

from starlette.responses import JSONResponse
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from .operational_logging import log_event


MIB = 1024 * 1024
KIB = 1024
_MULTIPART_OVERHEAD_BYTES = 2 * MIB
# comfy /run 은 파일 외에 워크플로우 JSON(content)·param_values·media_meta 폼 필드가 함께
# 실린다 — 대형 워크플로우 + 상한 근접 배치 조합에서 파일은 규정 이내인데 경계 413 이 나지
# 않게 여유를 더 준다(파일 합계는 라우터 validate_upload_batch 가 정확히 다시 강제한다).
_COMFY_FORM_OVERHEAD_BYTES = 16 * MIB
UPLOAD_LIMIT_HEADER = "X-MVHub-Upload-Limit"


def _positive_env(name: str, default: int) -> int:
    """잘못된 환경값이 상한을 꺼버리지 않도록 안전한 기본값으로 돌아간다."""
    try:
        value = int(os.environ.get(name, str(default)))
    except (TypeError, ValueError):
        return default
    return value if value > 0 else default


ASSET_UPLOAD_TOTAL_MAX_BYTES = _positive_env(
    "CONTENT_HUB_ASSET_UPLOAD_TOTAL_MAX_BYTES", 1024 * MIB
)
COMFY_UPLOAD_TOTAL_MAX_BYTES = _positive_env(
    "CONTENT_HUB_COMFY_UPLOAD_TOTAL_MAX_BYTES", 512 * MIB
)
COMFY_UPLOAD_FILE_MAX_BYTES = _positive_env(
    "CONTENT_HUB_COMFY_UPLOAD_FILE_MAX_BYTES", 256 * MIB
)
COMFY_UPLOAD_MAX_FILES = _positive_env("CONTENT_HUB_COMFY_UPLOAD_MAX_FILES", 64)
DB_UPLOAD_FILE_MAX_BYTES = _positive_env(
    "CONTENT_HUB_DB_UPLOAD_FILE_MAX_BYTES", 512 * MIB
)

# 브라우저 multipart 경계·파일명·작은 폼 필드가 실제 파일 바이트와 함께 들어온다. 원시 HTTP
# 본문은 2MiB 여유를 주고, 아래 validate_upload_batch가 파일 합계를 정확히 다시 강제한다.
UPLOAD_REQUEST_LIMITS: dict[str, int] = {
    "/api/assets/upload": ASSET_UPLOAD_TOTAL_MAX_BYTES + _MULTIPART_OVERHEAD_BYTES,
    "/api/assets/capture": ASSET_UPLOAD_TOTAL_MAX_BYTES + _MULTIPART_OVERHEAD_BYTES,
    "/api/assets/reference-import": ASSET_UPLOAD_TOTAL_MAX_BYTES + _MULTIPART_OVERHEAD_BYTES,
    "/api/comfy/run": COMFY_UPLOAD_TOTAL_MAX_BYTES + _COMFY_FORM_OVERHEAD_BYTES,
    "/api/db/import": DB_UPLOAD_FILE_MAX_BYTES + _MULTIPART_OVERHEAD_BYTES,
    "/api/db-backup": DB_UPLOAD_FILE_MAX_BYTES + _MULTIPART_OVERHEAD_BYTES,
    "/api/db-backup/sets": DB_UPLOAD_FILE_MAX_BYTES * 2 + _MULTIPART_OVERHEAD_BYTES,
}

_log = logging.getLogger("mvhub.upload")


class UploadLike(Protocol):
    size: int | None
    file: BinaryIO


@dataclass(frozen=True)
class UploadLimitExceeded(ValueError):
    """라우터 수준 파일 정책 위반. 파일명은 로그에 남기지 않고 순번만 보존한다."""

    kind: str
    limit: int
    actual: int
    index: int | None = None


class RequestBodyTooLarge(Exception):
    """Content-Length가 없거나 거짓인 요청이 수신 중 상한을 넘었다."""

    def __init__(self, limit: int, actual: int) -> None:
        super().__init__(limit, actual)
        self.limit = limit
        self.actual = actual


class InvalidContentLength(Exception):
    """모호하거나 음수인 Content-Length."""


def _known_upload_size(upload: UploadLike) -> int | None:
    size = getattr(upload, "size", None)
    if isinstance(size, int) and size >= 0:
        return size
    stream = getattr(upload, "file", None)
    if stream is None:
        return None
    try:
        position = stream.tell()
        stream.seek(0, os.SEEK_END)
        size = stream.tell()
        stream.seek(position, os.SEEK_SET)
        return size if isinstance(size, int) and size >= 0 else None
    except (AttributeError, OSError):
        return None


def validate_upload_batch(
    uploads: Iterable[UploadLike],
    *,
    max_files: int,
    max_file_bytes: int,
    max_total_bytes: int,
) -> int | None:
    """파싱된 실제 파일 크기를 검사한다. 모두 알 수 있으면 합계를 반환한다.

    Starlette의 ``UploadFile.size``는 클라이언트 헤더가 아니라 실제로 받은 바이트를 세므로 우선
    사용한다. 직접 호출 테스트처럼 size가 없으면 seek 가능한 spool의 길이를 보조로 구한다.
    """
    items = list(uploads)
    if len(items) > max_files:
        raise UploadLimitExceeded("file_count", max_files, len(items))

    total = 0
    all_known = True
    for index, upload in enumerate(items):
        size = _known_upload_size(upload)
        if size is None:
            all_known = False
            continue
        if size > max_file_bytes:
            raise UploadLimitExceeded("file_size", max_file_bytes, size, index)
        total += size
        if total > max_total_bytes:
            raise UploadLimitExceeded("total_size", max_total_bytes, total)
    return total if all_known else None


def copy_stream_limited(
    source: BinaryIO,
    target: BinaryIO,
    *,
    max_bytes: int,
    chunk_bytes: int = MIB,
) -> int:
    """동기 스트림을 제한된 메모리로 복사한다. 호출부는 필요하면 스레드에서 실행한다."""
    total = 0
    while True:
        chunk = source.read(chunk_bytes)
        if not chunk:
            return total
        total += len(chunk)
        if total > max_bytes:
            raise UploadLimitExceeded("file_size", max_bytes, total)
        target.write(chunk)


def format_byte_limit(value: int) -> str:
    """운영 기본 MB뿐 아니라 테스트·사용자 설정의 KB/바이트 상한도 0 없이 표시한다."""
    if value >= MIB:
        amount = value / MIB
        return f"{amount:g}MB"
    if value >= KIB:
        amount = value / KIB
        return f"{amount:g}KB"
    return f"{value}바이트"


def limit_headers(limit: int) -> dict[str, str]:
    return {UPLOAD_LIMIT_HEADER: str(limit)}


def _content_length(scope: Scope) -> int | None:
    values = [
        value.decode("latin-1").strip()
        for key, value in scope.get("headers", [])
        if key.lower() == b"content-length"
    ]
    if not values:
        return None
    if len(set(values)) != 1:
        raise InvalidContentLength
    try:
        parsed = int(values[0], 10)
    except ValueError as exc:
        raise InvalidContentLength from exc
    if parsed < 0:
        raise InvalidContentLength
    return parsed


def _normalise_path(path: str) -> str:
    return path.rstrip("/") or "/"


class UploadBodyLimitMiddleware:
    """선별된 업로드 POST 요청을 multipart 파싱 전에 차단하는 순수 ASGI 미들웨어."""

    def __init__(
        self,
        app: ASGIApp,
        *,
        limits: dict[str, int] | None = None,
    ) -> None:
        self.app = app
        self.limits = dict(UPLOAD_REQUEST_LIMITS if limits is None else limits)

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http" or scope.get("method", "").upper() != "POST":
            await self.app(scope, receive, send)
            return
        path = _normalise_path(str(scope.get("path") or ""))
        limit = self.limits.get(path)
        if limit is None:
            await self.app(scope, receive, send)
            return

        try:
            declared = _content_length(scope)
        except InvalidContentLength:
            await self._reject(
                scope,
                receive,
                send,
                400,
                "Content-Length가 올바르지 않습니다",
                path,
                limit,
                None,
            )
            return
        if declared is not None and declared > limit:
            await self._reject(scope, receive, send, 413, self._detail(limit), path, limit, declared)
            return

        received = 0
        response_started = False
        too_large: RequestBodyTooLarge | None = None
        replacement_sent = False

        async def limited_receive() -> Message:
            nonlocal received, too_large
            message = await receive()
            if message["type"] == "http.request":
                received += len(message.get("body", b""))
                if received > limit:
                    too_large = RequestBodyTooLarge(limit, received)
                    raise too_large
            return message

        async def tracked_send(message: Message) -> None:
            nonlocal response_started, replacement_sent
            # FastAPI의 multipart 파서는 receive 예외를 일반 본문 파싱 400으로 바꿀 수 있다.
            # 상한 초과가 이미 확인됐다면 그 내부 응답을 내보내지 않고 정확한 413 한 건으로 교체한다.
            if too_large is not None:
                if not replacement_sent:
                    replacement_sent = True
                    await self._reject(
                        scope,
                        receive,
                        send,
                        413,
                        self._detail(limit),
                        path,
                        limit,
                        too_large.actual,
                    )
                return
            if message["type"] == "http.response.start":
                response_started = True
            await send(message)

        try:
            await self.app(scope, limited_receive, tracked_send)
        except RequestBodyTooLarge as exc:
            too_large = exc
            if response_started:
                raise
        if too_large is not None and not replacement_sent:
            await self._reject(
                scope,
                receive,
                send,
                413,
                self._detail(limit),
                path,
                limit,
                too_large.actual,
            )

    @staticmethod
    def _detail(limit: int) -> str:
        payload_limit = (
            limit - _MULTIPART_OVERHEAD_BYTES
            if limit > _MULTIPART_OVERHEAD_BYTES
            else limit
        )
        return f"업로드 요청 전체가 너무 큽니다(최대 {format_byte_limit(payload_limit)})"

    @staticmethod
    async def _reject(
        scope: Scope,
        receive: Receive,
        send: Send,
        status: int,
        detail: str,
        path: str,
        limit: int,
        actual: int | None,
    ) -> None:
        log_event(
            _log,
            "upload_rejected",
            level=logging.WARNING,
            path=path,
            status=status,
            limit_bytes=limit,
            received_bytes=actual,
        )
        response = JSONResponse(
            {"detail": detail},
            status_code=status,
            headers=limit_headers(limit),
        )
        await response(scope, receive, send)

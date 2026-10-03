"""결과 파일 부분 지문 수집기(docs/RESULT_FINGERPRINT.md).

작업자 PC 허브에서만 돈다. 내 생성물의 결과 파일(원본)마다 **전체 크기 + 앞 64KiB sha256** 을 한 번 구해
asset 에 적고 텔레메트리 dirty 를 찍는다 — 다음 push 에 실려 팀 장부(team_generation_fact)로 간다.
URL 은 장부로 보내지 않는다(장부는 '프롬프트·미디어 제외'). 이 쌍은 **부분 지문**이라 같은 파일 확정이
아니라 '관측된 일치' 근거로만 쓴다.

원본이 이 PC 캐시에 있으면 그 파일을 읽고(네트워크 없음), 없으면 원본 URL 에 `Range: bytes=0-65535`
요청 하나 — 206 의 Content-Range 에서 전체 크기를, 본문에서 앞 64KiB 를 함께 얻는다(10-03 실측 3/3).
"""

from __future__ import annotations

import asyncio
import contextlib
import hashlib
import logging
import re
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any, Callable, Optional

from .. import active_account, repo
from ..repo import result_fingerprint as repo_fp
from . import shared_connection
from .async_tools import to_thread_non_abandon
from .media_cache import MediaCachePermanentError, _local_path, _validate_response, local_media_exists
from .net_guard import BlockedURLError, assert_public_http_url, guarded_opener
from .operational_logging import log_event

_log = logging.getLogger("mvhub.result_probe")

HEAD_BYTES = 65536
_INTERVAL_SECONDS = 300.0
_STARTUP_DELAY_SECONDS = 120.0
_BATCH = 20
_RESEND_EVERY_SECONDS = 24 * 3600.0
_RESEND_BATCH = 200
_IO_TIMEOUT = 15  # 연결·읽기 한 번
_TOTAL_TIMEOUT = 30.0  # 한 건 전체
_CONTENT_RANGE_RE = re.compile(r"^bytes (\d+)-(\d+)/(\d+)$")


class ProbeError(Exception):
    """이번 건은 지문을 못 구했다(실패 수 +1)."""


def fingerprint_local(path: Path) -> tuple[int, str]:
    size = path.stat().st_size
    if size <= 0:
        raise ProbeError("empty file")
    with open(path, "rb") as fh:
        head = fh.read(HEAD_BYTES)
    if len(head) != min(HEAD_BYTES, size):
        raise ProbeError("short local read")
    return size, hashlib.sha256(head).hexdigest()


def _read_exact(resp, want: int, deadline: float, clock: Callable[[], float]) -> bytes:
    """앞 want 바이트만 읽는다. read1 은 호출당 소켓 recv 한 번(각 recv 는 _IO_TIMEOUT)이라, 조금씩
    흘러드는 응답도 '상한 + recv 한 번'을 넘기지 않는다(read(n) 은 n 이 찰 때까지 recv 를 반복한다)."""
    read_some = getattr(resp, "read1", None) or resp.read
    chunks: list[bytes] = []
    got = 0
    while got < want:
        if clock() > deadline:
            raise ProbeError("timeout")
        chunk = read_some(min(16384, want - got))
        if not chunk:
            break
        chunks.append(chunk)
        got += len(chunk)
    if clock() > deadline:
        raise ProbeError("timeout")
    if got != want:
        raise ProbeError("short body")
    return b"".join(chunks)


def fingerprint_remote(
    url: str,
    *,
    opener: Optional[urllib.request.OpenerDirector] = None,
    clock: Callable[[], float] = time.monotonic,
) -> tuple[int, str]:
    """원본 URL 에서 (전체 크기, 앞 64KiB sha256). 응답이 계약과 조금이라도 다르면 ProbeError."""
    try:
        assert_public_http_url(url)  # 사설망·리다이렉트 우회 차단 — media_cache 와 같은 방어
    except BlockedURLError as exc:
        raise ProbeError(f"blocked url: {exc}") from exc
    request = urllib.request.Request(
        url,
        headers={
            "Range": f"bytes=0-{HEAD_BYTES - 1}",
            "Accept-Encoding": "identity",
            "User-Agent": "content-hub/0.1",
        },
    )
    deadline = clock() + _TOTAL_TIMEOUT
    try:
        with (opener or guarded_opener()).open(request, timeout=_IO_TIMEOUT) as resp:
            encoding = (resp.headers.get("Content-Encoding") or "").strip().lower()
            if encoding not in ("", "identity"):
                raise ProbeError(f"encoded body: {encoding}")
            status = resp.getcode()
            if status == 206:
                match = _CONTENT_RANGE_RE.match((resp.headers.get("Content-Range") or "").strip())
                if not match:
                    raise ProbeError("bad Content-Range")
                start, end, total = (int(part) for part in match.groups())
                want = min(HEAD_BYTES, total)
                if start != 0 or total <= 0 or end != want - 1:
                    raise ProbeError("unexpected range")
            elif status == 200:  # 범위를 무시한 서버 — 전체 길이를 믿을 수 있을 때만, 앞부분만 읽고 끊는다
                raw = (resp.headers.get("Content-Length") or "").strip()
                if not raw.isdigit() or int(raw) <= 0:
                    raise ProbeError("no Content-Length")
                total = int(raw)
                want = min(HEAD_BYTES, total)
            else:
                raise ProbeError(f"status {status}")
            head = _read_exact(resp, want, deadline, clock)
            _validate_response(resp.headers.get("Content-Type") or "", head[:64])
    except ProbeError:
        raise
    except MediaCachePermanentError as exc:
        raise ProbeError(str(exc)) from exc
    except (urllib.error.URLError, OSError, ValueError) as exc:
        raise ProbeError(type(exc).__name__) from exc
    return total, hashlib.sha256(head).hexdigest()


def fingerprint_target(target: dict[str, Any]) -> tuple[int, str]:
    """캐시된 완성 파일이 있으면 그것, 없으면 원본 URL."""
    file_path = target.get("file_path") or ""
    if file_path.startswith("/media/") and local_media_exists(file_path):
        try:
            return fingerprint_local(_local_path(file_path))
        except OSError as exc:
            raise ProbeError(type(exc).__name__) from exc
    url = repo_fp.original_key(file_path, target.get("source_url"))
    if not url.lower().startswith(("http://", "https://")):
        raise ProbeError("no original url")
    return fingerprint_remote(url)


# ── 회차(스레드에서 도는 DB 작업은 계정을 고정한 범위 안에서) ─────────────────────────


def _my_uid(pin: tuple[str, Optional[str]]) -> Optional[str]:
    with active_account.pinned_account_scope(pin):
        return repo.get_my_uid()


def _targets(pin, uid: str) -> list[dict[str, Any]]:
    with active_account.pinned_account_scope(pin):
        return repo_fp.probe_targets(uid, _BATCH)


def _record(pin, target: dict[str, Any], uid: str, size: int, head_sha: str) -> bool:
    with active_account.pinned_account_scope(pin):
        return repo_fp.record_probe_success(target, uid, size, head_sha)


def _fail(pin, target: dict[str, Any], uid: str) -> None:
    with active_account.pinned_account_scope(pin):
        repo_fp.record_probe_failure(target, uid)


def _resend(pin, uid: str) -> int:
    with active_account.pinned_account_scope(pin):
        return repo_fp.mark_resend(uid, shared_connection.base_url(), _RESEND_BATCH)


class PeriodicResultProbe:
    """5분마다 최대 20건, 하루 한 번 미확인 지문 재전송. 기록이 생기면 텔레메트리 드레인을 예약한다."""

    def __init__(self, interval: float = _INTERVAL_SECONDS) -> None:
        self._interval = interval
        self._task: Optional[asyncio.Task] = None
        self._last_resend: Optional[float] = None
        self._on_dirty: Callable[[], Any] = lambda: None

    def start(self, on_dirty: Optional[Callable[[], Any]] = None) -> None:
        # 계층 경계(services→routers 금지) — 드레인 예약 함수는 시작 지점(main)이 넘긴다.
        if on_dirty is not None:
            self._on_dirty = on_dirty
        if self._task is None or self._task.done():
            self._task = asyncio.create_task(self._run(), name="result-probe")

    async def stop(self) -> None:
        if self._task:
            self._task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._task
            self._task = None

    async def run_cycle(self) -> dict[str, int]:
        pin = await to_thread_non_abandon(active_account.capture_account_pin)
        uid = await to_thread_non_abandon(_my_uid, pin)
        if not uid:  # 로그인 전 — 이번 회차는 쉰다
            return {"recorded": 0, "failed": 0, "resent": 0}
        recorded = failed = 0
        for target in await to_thread_non_abandon(_targets, pin, uid):
            try:
                # 네트워크·파일 읽기는 취소해도 된다(기록 전) — 끝나지 않은 스레드는 자기 timeout 으로 끝난다.
                size, head_sha = await asyncio.to_thread(fingerprint_target, target)
            except ProbeError:
                failed += 1
                await to_thread_non_abandon(_fail, pin, target, uid)
                continue
            if await to_thread_non_abandon(_record, pin, target, uid, size, head_sha):
                recorded += 1
        resent = 0
        now = time.monotonic()
        if self._last_resend is None or now - self._last_resend >= _RESEND_EVERY_SECONDS:
            resent = await to_thread_non_abandon(_resend, pin, uid)
            self._last_resend = now
        if recorded or resent:
            self._on_dirty()
        return {"recorded": recorded, "failed": failed, "resent": resent}

    async def _run(self) -> None:
        await asyncio.sleep(_STARTUP_DELAY_SECONDS)
        while True:
            try:
                result = await self.run_cycle()
                if any(result.values()):
                    log_event(_log, "result_probe_batch", **result)
            except asyncio.CancelledError:
                raise
            except Exception:  # noqa: BLE001 - 한 회차 실패가 수집기를 멈추지 않게
                log_event(_log, "result_probe_loop_failed", level=logging.WARNING, exc_info=True)
            await asyncio.sleep(self._interval)


periodic_result_probe = PeriodicResultProbe()

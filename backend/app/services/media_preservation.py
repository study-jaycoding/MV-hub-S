"""공유·최종 생성물 원본 보존 백그라운드 처리기.

보존 요청은 DB에 먼저 기록한다. 이 처리기는 작업을 원자적으로 선점해 다운로드하고,
프로세스가 중단돼도 다음 시작 때 stale running을 복구한다.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import os
from typing import Any, Optional

from .. import active_account, repo
from ..usecases import generation_media_cache
from .operational_logging import log_event


_log = logging.getLogger("mvhub.media_preservation")
_INTERVAL_SECONDS = max(
    5.0, float(os.getenv("CONTENT_HUB_MEDIA_PRESERVATION_INTERVAL_SECONDS", "30"))
)
_STARTUP_DELAY_SECONDS = max(
    0.0, float(os.getenv("CONTENT_HUB_MEDIA_PRESERVATION_STARTUP_DELAY_SECONDS", "10"))
)
_MAX_ATTEMPTS = max(1, int(os.getenv("CONTENT_HUB_MEDIA_PRESERVATION_MAX_ATTEMPTS", "5")))
_RETRY_DELAYS = (60, 300, 1800, 7200, 21600)


def _dominant_error(result: dict[str, Any]) -> Optional[str]:
    codes = result.get("failure_codes") or {}
    if codes.get("capacity"):
        return "capacity"
    if codes.get("network_error") or codes.get("incomplete_download"):
        return "network_error"
    if codes.get("missing_local_file"):
        return "missing_local_file"
    if codes:
        return sorted(codes, key=lambda key: (-int(codes[key]), key))[0]
    return None


async def _process_claim(claim: dict[str, Any]) -> dict[str, Any]:
    gen_id = claim["generation_id"]
    generation = await asyncio.to_thread(repo.get_generation, gen_id)
    if not generation:
        await asyncio.to_thread(
            repo.finish_media_preservation,
            gen_id,
            status="failed",
            cached_count=0,
            failed_count=1,
            skipped_count=0,
            bytes_cached=0,
            error_code="missing_generation",
        )
        return {"status": "failed", "error_code": "missing_generation"}

    unexpected_error: Exception | None = None
    try:
        result = await generation_media_cache.cache_generation_media(generation)
    except asyncio.CancelledError:
        raise
    except Exception as exc:  # noqa: BLE001
        outcome = generation_media_cache._outcome_from_error(exc)
        if outcome is None:
            raise
        result = outcome.result
        unexpected_error = exc
        log_event(
            _log,
            "media_preservation_partial_internal_error",
            level=logging.WARNING,
            exc_info=True,
        )

    failed = int(result.get("failed") or 0)
    saved = int(result.get("cached") or 0) + int(result.get("already") or 0)
    error_code = _dominant_error(result)
    attempts = int(claim.get("attempts") or 1)
    retry_after: Optional[int] = None

    if unexpected_error is not None:
        error_code = "internal_error"
        if attempts < _MAX_ATTEMPTS:
            status = "partial"
            retry_after = _RETRY_DELAYS[min(attempts - 1, len(_RETRY_DELAYS) - 1)]
        else:
            status = "partial" if saved else "failed"
    elif failed == 0:
        status = "complete"
        error_code = None
    elif error_code == "capacity":
        status = "capacity"
        if attempts < _MAX_ATTEMPTS:
            retry_after = 3600
    elif int(result.get("retryable") or 0) > 0 and attempts < _MAX_ATTEMPTS:
        status = "partial"
        retry_after = _RETRY_DELAYS[min(attempts - 1, len(_RETRY_DELAYS) - 1)]
    else:
        status = "partial" if saved else "failed"

    await asyncio.to_thread(
        repo.finish_media_preservation,
        gen_id,
        status=status,
        cached_count=saved,
        failed_count=failed,
        skipped_count=int(result.get("skipped") or 0),
        bytes_cached=int(result.get("bytes_cached") or 0),
        error_code=error_code,
        retry_after_seconds=retry_after,
    )
    return {**result, "status": status, "error_code": error_code}


async def preserve_generation_now(gen_id: str) -> Optional[dict[str, Any]]:
    """등록된 특정 작업을 즉시 한 번 처리한다. 이미 실행 중/완료면 None."""
    return await _claim_and_process_non_abandon(gen_id)


async def _process_claim_safely(claim: dict[str, Any]) -> dict[str, Any]:
    """주기 워커의 예외도 running 고아로 남기지 않고 실패 상태로 닫는다."""
    try:
        return await _process_claim(claim)
    except asyncio.CancelledError:
        raise
    except Exception:  # noqa: BLE001
        await asyncio.to_thread(
            repo.finish_media_preservation,
            claim["generation_id"],
            status="partial" if int(claim.get("cached_count") or 0) else "failed",
            cached_count=int(claim.get("cached_count") or 0),
            failed_count=max(1, int(claim.get("failed_count") or 0)),
            skipped_count=int(claim.get("skipped_count") or 0),
            bytes_cached=0,
            error_code="internal_error",
        )
        log_event(_log, "media_preservation_failed", level=logging.WARNING, exc_info=True)
        return {"status": "failed", "error_code": "internal_error"}


def _capture_account_scope() -> str:
    """claim 직전 계정을 캡처한다. 긴 보존 작업 동안 전환 lock은 보유하지 않는다."""
    with active_account.transition_lock:
        return active_account.account_key() or ""


async def _claim_and_process(
    gen_id: Optional[str], account_key: str
) -> Optional[dict[str, Any]]:
    """캡처한 계정 DB에서 claim부터 finish까지 처리한다."""
    account_token = active_account.set_override(account_key)
    try:
        if gen_id is None:
            claim = await asyncio.to_thread(repo.claim_media_preservation)
        else:
            claim = await asyncio.to_thread(repo.claim_media_preservation, gen_id)
        if not claim:
            return None
        return await _process_claim_safely(claim)
    finally:
        active_account.reset_override(account_token)


async def _claim_and_process_non_abandon(
    gen_id: Optional[str] = None,
) -> Optional[dict[str, Any]]:
    """호출 task가 취소돼도 이미 시작한 claim~finish 단위는 끝낸 뒤 취소를 전파한다."""
    account_key = _capture_account_scope()
    worker = asyncio.create_task(_claim_and_process(gen_id, account_key))
    try:
        return await asyncio.shield(worker)
    except asyncio.CancelledError:
        # 첫 취소와 대기 중 반복 취소를 모두 흡수한다. 다운로드 task를 살려야 내부
        # to_thread가 파일을 쓰는 동안 lock/상태 확정 흐름이 먼저 유기되지 않는다.
        while not worker.done():
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await asyncio.shield(worker)
        if not worker.cancelled():
            # 호출자 취소를 우선하되 내부 예외도 회수해 "Task exception was never retrieved"
            # 경고를 남기지 않는다. claim 이후 예외는 _process_claim_safely가 finish한다.
            with contextlib.suppress(Exception):
                worker.result()
        raise


class PeriodicMediaPreservation:
    def __init__(self, interval: float = _INTERVAL_SECONDS) -> None:
        self._interval = interval
        self._task: Optional[asyncio.Task] = None

    def start(self) -> None:
        if self._task is None or self._task.done():
            self._task = asyncio.create_task(self._run(), name="media-preservation")

    async def stop(self) -> None:
        if self._task:
            self._task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._task
            self._task = None

    async def _run(self) -> None:
        await asyncio.to_thread(repo.recover_stale_media_preservations)
        await asyncio.to_thread(repo.backfill_required_media_preservations)
        await asyncio.sleep(_STARTUP_DELAY_SECONDS)
        while True:
            processed = 0
            try:
                # 한 주기에 두 건만 처리해 저사양 서버의 네트워크·디스크 폭주를 막는다.
                for _ in range(2):
                    result = await _claim_and_process_non_abandon()
                    if result is None:
                        break
                    processed += 1
                if processed:
                    log_event(_log, "media_preservation_batch", processed=processed)
            except asyncio.CancelledError:
                raise
            except Exception:  # noqa: BLE001
                log_event(_log, "media_preservation_loop_failed", level=logging.WARNING, exc_info=True)
            await asyncio.sleep(self._interval)


periodic_media_preservation = PeriodicMediaPreservation()

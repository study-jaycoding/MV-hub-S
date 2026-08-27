"""생성물 원격 미디어를 로컬에 보관하는 업무 흐름.

한 생성물의 asset/reference 다운로드와 DB 경로 갱신, 전체 생성물의 제한된 병렬
처리를 조율한다. FastAPI와 HTTP 요청에는 의존하지 않는다.
"""

from __future__ import annotations

import asyncio
from collections import Counter
from typing import Any, NamedTuple

from .. import repo
from ..services import media_cache


MediaTarget = tuple[str, str, str, bool, str | None]
MediaCacheUpdate = tuple[str, str, str, str | None, str | None]
_DOWNLOAD_CONCURRENCY = 6
_DOWNLOAD_LIMITER_ATTR = "_mvhub_generation_media_download_limiter"
_OUTCOME_ERROR_ATTR = "_mvhub_generation_media_cache_outcome"


class _GenerationMediaCacheOutcome(NamedTuple):
    result: dict[str, Any]
    unexpected_error: BaseException | None


def _download_limiter() -> asyncio.Semaphore:
    """현재 event loop에서 모든 생성물 다운로드가 공유하는 상한을 반환한다."""
    loop = asyncio.get_running_loop()
    limiter = getattr(loop, _DOWNLOAD_LIMITER_ATTR, None)
    if limiter is None:
        limiter = asyncio.Semaphore(_DOWNLOAD_CONCURRENCY)
        setattr(loop, _DOWNLOAD_LIMITER_ATTR, limiter)
    return limiter


async def _cache_generation_media_outcome(
    generation: dict,
) -> _GenerationMediaCacheOutcome:
    """성공분을 반영하고 부분 결과와 재전파할 예외를 함께 반환한다."""
    targets: list[MediaTarget] = []  # (kind, id, current_path, is_image, source_url)
    for asset in generation.get("assets", []):
        targets.append(
            (
                "asset",
                asset["id"],
                asset.get("file_path") or "",
                asset.get("type") == "image",
                asset.get("source_url"),
            )
        )
    for reference in generation.get("references", []):
        targets.append(
            (
                "ref",
                reference["id"],
                reference.get("file_path") or "",
                reference.get("type") == "image",
                reference.get("source_url"),
            )
        )

    if not targets:
        return _GenerationMediaCacheOutcome(
            {
                "cached": 0, "already": 0, "failed": 0, "skipped": 0,
                "bytes_cached": 0, "failure_codes": {}, "retryable": 0,
            },
            None,
        )

    # 로컬 보존 경로가 DB에 있으나 파일만 유실됐으면 source_url로 자기치유한다.
    urls = [
        source_url
        if current_path.startswith("/media/") and source_url and not media_cache.local_media_exists(current_path)
        else current_path
        for _kind, _id, current_path, _is_image, source_url in targets
    ]
    download_sem = _download_limiter()

    async def cache_one(url: str | None):
        async with download_sem:
            return await media_cache.cache_url_result(url)

    download_batch = asyncio.gather(
        *(cache_one(url) for url in urls),
        return_exceptions=True,
    )
    caller_cancelled: asyncio.CancelledError | None = None
    while True:
        try:
            # 호출 task 취소가 gather와 형제 다운로드까지 취소하지 않게 한다.
            results = await asyncio.shield(download_batch)
            break
        except asyncio.CancelledError as exc:
            if caller_cancelled is None:
                caller_cancelled = exc
            # 반복 취소에도 파일 작업을 유기하지 않고 완료될 때까지 계속 회수한다.
            if download_batch.done():
                results = download_batch.result()
                break

    cached = 0
    failed = 0
    already = 0
    skipped = 0
    bytes_cached = 0
    retryable = 0
    failure_codes: Counter[str] = Counter()
    cache_updates: list[MediaCacheUpdate] = []
    unexpected_error: BaseException | None = caller_cancelled
    for (kind, media_id, current_path, is_image, source_url), requested_url, result in zip(
        targets, urls, results
    ):
        if isinstance(result, BaseException):
            failed += 1
            failure_codes["internal_error"] += 1
            if unexpected_error is None:
                unexpected_error = result
            continue
        if result.status == "skipped":
            skipped += 1
            continue
        if not result.path:
            failed += 1
            if result.retryable:
                retryable += 1
            failure_codes[result.error_code or "unknown"] += 1
            continue

        if result.status == "cached":
            cached += 1
            bytes_cached += result.bytes_added
        else:
            already += 1

        # 같은 URL을 여러 에셋이 공유하거나 파일이 이전 실행에서 이미 내려받아졌어도,
        # DB가 아직 원격 URL이면 모든 행을 로컬 경로로 바꿔야 CDN 만료 뒤에도 실제로 살아남는다.
        if current_path != result.path:
            thumb_path = result.path if is_image else None
            preserved_source = source_url or (requested_url if requested_url.startswith(("http://", "https://")) else None)
            cache_updates.append(
                (kind, media_id, result.path, thumb_path, preserved_source)
            )

    # 네트워크 작업이 모두 끝난 뒤에만 쓰기 트랜잭션을 열고 성공 행만 한 번에 반영한다.
    repo.apply_generation_media_cache_updates(
        cache_updates,
        asset_updater=repo.update_asset_cache,
        reference_updater=repo.update_reference_cache,
    )

    return _GenerationMediaCacheOutcome(
        {
            "cached": cached,
            "already": already,
            "failed": failed,
            "skipped": skipped,
            "bytes_cached": bytes_cached,
            "failure_codes": dict(failure_codes),
            "retryable": retryable,
        },
        unexpected_error,
    )


def _outcome_from_error(
    error: BaseException,
) -> _GenerationMediaCacheOutcome | None:
    """공개 함수가 재전파한 원예외에서 내부 부분 결과를 안전하게 꺼낸다."""
    outcome = getattr(error, _OUTCOME_ERROR_ATTR, None)
    if not isinstance(outcome, _GenerationMediaCacheOutcome):
        return None
    return outcome if outcome.unexpected_error is error else None


async def cache_generation_media(generation: dict) -> dict[str, Any]:
    """한 생성물의 원격 asset/reference를 내려받고 성공한 경로만 DB에 반영한다."""
    outcome = await _cache_generation_media_outcome(generation)
    if outcome.unexpected_error is not None:
        # 보존 서비스는 원예외를 그대로 받으면서도 성공분을 정확히 정산할 수 있다.
        # 예외를 감싸지 않아 직접 호출자의 타입·인스턴스·취소 계약을 바꾸지 않는다.
        try:
            setattr(outcome.unexpected_error, _OUTCOME_ERROR_ATTR, outcome)
        except Exception:  # noqa: BLE001
            # 사용자 정의 예외가 속성 추가를 막아도 원예외 재전파가 항상 우선이다.
            pass
        raise outcome.unexpected_error
    return outcome.result

"""생성물 원격 미디어를 로컬에 보관하는 업무 흐름.

한 생성물의 asset/reference 다운로드와 DB 경로 갱신, 전체 생성물의 제한된 병렬
처리를 조율한다. FastAPI와 HTTP 요청에는 의존하지 않는다.
"""

from __future__ import annotations

import asyncio

from .. import repo
from ..services import media_cache


MediaTarget = tuple[str, str, str, bool]


async def cache_generation_media(generation: dict) -> dict[str, int]:
    """한 생성물의 원격 asset/reference를 내려받고 성공한 경로만 DB에 반영한다."""
    targets: list[MediaTarget] = []  # (kind, id, url, is_image)
    for asset in generation.get("assets", []):
        if not asset["file_path"].startswith("/media/"):
            targets.append(
                (
                    "asset",
                    asset["id"],
                    asset["file_path"],
                    asset["type"] == "image",
                )
            )
    for reference in generation.get("references", []):
        if not reference["file_path"].startswith("/media/"):
            targets.append(
                (
                    "ref",
                    reference["id"],
                    reference["file_path"],
                    reference["type"] == "image",
                )
            )

    if not targets:
        return {"cached": 0, "failed": 0, "skipped": 0}

    results = await asyncio.gather(*(media_cache.cache_url(target[2]) for target in targets))

    cached = 0
    failed = 0
    for (kind, media_id, source_url, is_image), local_path in zip(targets, results):
        if not local_path:
            failed += 1
            continue

        thumb_path = local_path if is_image else None
        if kind == "asset":
            repo.update_asset_cache(media_id, local_path, thumb_path, source_url)
        else:
            repo.update_reference_cache(media_id, local_path, thumb_path, source_url)
        cached += 1

    return {"cached": cached, "failed": failed, "skipped": 0}


async def cache_all_generation_media() -> dict[str, int]:
    """모든 생성물의 미보관 원격 미디어를 생성물 단위 최대 6개씩 병렬 보관한다."""
    total = {"cached": 0, "failed": 0, "generations": 0}
    sem = asyncio.Semaphore(6)

    async def cache_one(gen_id: str) -> dict[str, int] | None:
        async with sem:
            generation = repo.get_generation(gen_id)
            if not generation:
                return None
            return await cache_generation_media(generation)

    results = await asyncio.gather(*(cache_one(gen_id) for gen_id in repo.all_generation_ids()))
    for result in results:
        if not result:
            continue
        total["cached"] += result["cached"]
        total["failed"] += result["failed"]
        if result["cached"]:
            total["generations"] += 1

    return total

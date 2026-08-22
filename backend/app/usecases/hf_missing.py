"""Higgsfield 원본 누락 생성물 정리 업무 흐름.

라우터가 인증으로 확정한 계정 범위와 선택적인 서버 통신 함수를 넘기면, 이 모듈이
원본 존재 확인·로컬 휴지통 처리·공유 서버 반영을 조율한다. FastAPI와 HTTP 경로에는
의존하지 않는다.
"""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Callable
from typing import Any

from .. import repo
from ..services import cli_bridge


logger = logging.getLogger(__name__)

ServerCandidateFetcher = Callable[[], dict[str, Any] | None]
ServerResultApplier = Callable[[list[dict[str, Any]]], dict[str, Any] | None]


async def trash_missing_generations(
    account_uid: str | None,
    *,
    fetch_server_candidates: ServerCandidateFetcher | None = None,
    apply_server_results: ServerResultApplier | None = None,
) -> dict[str, int]:
    """Higgsfield에서 삭제가 확정된 생성물을 로컬과 공유 서버의 휴지통으로 보낸다.

    ``job_exists``가 ``None``을 반환하면 일시적인 확인 실패이므로 아무것도 변경하지
    않는다. 공유 서버 점검 실패도 로컬 처리 결과를 되돌리지 않는다.
    """
    # 전체 행 스캔·SQLite busy 대기가 이벤트 루프를 막지 않게 스레드로(R7 1-I).
    gens = await asyncio.to_thread(repo.gens_with_job_id, account_uid=account_uid)
    sem = asyncio.Semaphore(8)

    async def check(gen_id: str, job_id: str) -> tuple[str, bool | None]:
        async with sem:
            return gen_id, await cli_bridge.job_exists(job_id)

    results = await asyncio.gather(*(check(gen_id, job_id) for gen_id, job_id in gens))

    def apply_local(checked: list[tuple[str, bool | None]]) -> int:
        trashed = 0
        reappeared: list[tuple[str, bool]] = []
        for gen_id, exists in checked:
            if exists is None:
                continue
            if exists:
                reappeared.append((gen_id, False))
            elif repo.delete_generation(gen_id):
                trashed += 1
        repo.set_hf_missing_batch(reappeared)
        return trashed

    trashed = await asyncio.to_thread(apply_local, results)
    server_checked = 0
    server_trashed = 0

    if fetch_server_candidates is not None and apply_server_results is not None:
        try:
            response = await asyncio.to_thread(fetch_server_candidates)
            candidates = (response or {}).get("candidates", [])
            server_checked = len(candidates)

            async def check_server(candidate: dict[str, Any]) -> dict[str, Any]:
                async with sem:
                    return {
                        "gen_id": candidate["gen_id"],
                        "job_id": candidate["job_id"],
                        "exists": await cli_bridge.job_exists(candidate["job_id"]),
                    }

            server_results = await asyncio.gather(
                *(check_server(candidate) for candidate in candidates if candidate.get("job_id"))
            )
            definitive_results = [
                result for result in server_results if result["exists"] is not None
            ]
            if definitive_results:
                apply_response = await asyncio.to_thread(
                    apply_server_results,
                    definitive_results,
                )
                server_trashed = (apply_response or {}).get("trashed", 0)
        except Exception as exc:  # noqa: BLE001 — 서버 실패가 로컬 정리를 막으면 안 된다.
            logger.warning("서버측 hf-missing 검토 실패(로컬 결과는 정상): %s", exc)

    return {
        "checked": len(gens),
        "trashed": trashed,
        "server_checked": server_checked,
        "server_trashed": server_trashed,
    }

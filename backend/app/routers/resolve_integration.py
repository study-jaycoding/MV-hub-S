"""MV Hub ↔ DaVinci Resolve 로컬 연동 API."""

from __future__ import annotations

import asyncio
import urllib.parse

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

from . import _proxy
from .. import repo
from ..deps import account_scope_uid, require_view_generation
from ..services.resolve_transfer import ResolveTransferError, transfer_generations


router = APIRouter(prefix="/api/resolve", tags=["resolve"])


class ResolveTransferIn(BaseModel):
    gen_ids: list[str] = Field(min_length=1, max_length=500)


async def _generation_for_transfer(gen_id: str, request: Request) -> dict:
    """로컬 생성물을 우선하고, 로컬에 없는 팀 공유물만 서버에서 조회한다."""
    gen = repo.get_generation(gen_id, account_uid=account_scope_uid(request))
    if gen:
        require_view_generation(request, gen)
        return gen
    if _proxy.proxying():
        encoded = urllib.parse.quote(gen_id, safe="")
        # 공유 서버 조회는 동기 urllib 기반이므로 이벤트 루프 밖에서 실행한다.
        remote = await asyncio.to_thread(
            _proxy.proxy_json, "GET", f"/api/generations/{encoded}"
        )
        if isinstance(remote, dict):
            return remote
    raise HTTPException(status_code=404, detail=f"생성물을 찾을 수 없습니다: {gen_id}")


@router.post("/transfers")
async def create_resolve_transfer(body: ResolveTransferIn, request: Request):
    """선택한 완료본을 ResolveSource 폴더 트리로 순차 다운로드한다.

    아직 Resolve Media Pool은 변경하지 않는다. 반환되는 manifest를 다음 단계의
    Resolve 가져오기 스크립트가 사용한다.
    """
    ids = list(dict.fromkeys(gen_id.strip() for gen_id in body.gen_ids if gen_id.strip()))
    if not ids:
        raise HTTPException(status_code=400, detail="전송할 생성물을 선택하세요")
    # 순차 조회 — 서버에 대량 동시 요청을 만들지 않는다. 로컬 항목은 DB 단건 조회라 즉시 끝난다.
    generations = []
    for gen_id in ids:
        generations.append(await _generation_for_transfer(gen_id, request))
    project_ids = {str(gen.get("project_id") or "") for gen in generations}
    if "" in project_ids:
        raise HTTPException(status_code=400, detail="프로젝트에 배정된 생성물만 전송할 수 있습니다")
    if len(project_ids) != 1:
        raise HTTPException(status_code=400, detail="한 번에 하나의 프로젝트만 전송할 수 있습니다")
    try:
        return await transfer_generations(next(iter(project_ids)), generations)
    except ResolveTransferError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

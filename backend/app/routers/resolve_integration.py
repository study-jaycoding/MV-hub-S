"""MV Hub ↔ DaVinci Resolve 로컬 연동 API."""

from __future__ import annotations

import asyncio
import urllib.parse

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

from . import _proxy
from .. import repo
from ..deps import account_scope_uid, require_view_generation
from ..services.resolve_bridge import (
    import_manifest_to_current_project,
)
from ..services.resolve_status_runner import resolve_connection_status_bounded
from ..services.request_guards import require_local_machine_request
from ..services.resolve_script_installer import (
    ResolveScriptInstallError,
    install_resolve_script,
    resolve_script_status,
)
from ..services.resolve_transfer import (
    ResolveTransferError,
    load_manifest,
    save_manifest,
    transfer_generations,
)


router = APIRouter(prefix="/api/resolve", tags=["resolve"])


class ResolveTransferIn(BaseModel):
    gen_ids: list[str] = Field(min_length=1, max_length=500)
    resolve_project_id: str = Field(default="", max_length=200)
    resolve_project_name: str = Field(default="", max_length=500)


class ResolveRetryIn(BaseModel):
    project_id: str = Field(min_length=1, max_length=200)
    transfer_id: str = Field(min_length=1, max_length=80)


def _require_local_resolve(request: Request) -> None:
    require_local_machine_request(
        request, "DaVinci Resolve 연동은 이 PC의 로컬 MV Hub에서만 사용할 수 있습니다"
    )


@router.get("/script")
def get_resolve_script_status(request: Request):
    """현재 PC의 Resolve 사용자 스크립트 설치 상태."""
    _require_local_resolve(request)
    try:
        return resolve_script_status()
    except ResolveScriptInstallError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.post("/script/install")
def post_resolve_script_install(request: Request):
    """MV Hub에 포함된 최신 Clip Exporter를 현재 Windows 사용자에게 설치한다."""
    _require_local_resolve(request)
    try:
        return install_resolve_script()
    except ResolveScriptInstallError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.get("/status")
async def get_resolve_connection_status(request: Request):
    """현재 PC의 Resolve 연결과 열린 프로젝트를 확인한다."""
    _require_local_resolve(request)
    return await asyncio.to_thread(resolve_connection_status_bounded)


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
    """완료본을 로컬에 준비하고 현재 Resolve Media Pool로 가져온다."""
    _require_local_resolve(request)
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
        manifest = await transfer_generations(next(iter(project_ids)), generations)
        if body.resolve_project_id or body.resolve_project_name:
            manifest["resolve_target"] = {
                "project_id": body.resolve_project_id.strip(),
                "project_name": body.resolve_project_name.strip(),
            }
            # Resolve 연결이 바로 끊겨도 재가져오기가 같은 프로젝트를 검증할 수 있게 먼저 기록한다.
            await save_manifest(manifest)
        manifest["resolve_import"] = await asyncio.to_thread(
            import_manifest_to_current_project, manifest
        )
        await save_manifest(manifest)
        return manifest
    except ResolveTransferError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.post("/transfers/retry")
async def retry_resolve_transfer(body: ResolveRetryIn, request: Request):
    """이미 준비된 원본 manifest를 다시 읽어 Resolve 가져오기만 재실행한다."""
    _require_local_resolve(request)
    try:
        manifest = await load_manifest(body.project_id.strip(), body.transfer_id.strip())
        manifest["resolve_import"] = await asyncio.to_thread(
            import_manifest_to_current_project, manifest
        )
        await save_manifest(manifest)
        return manifest
    except ResolveTransferError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

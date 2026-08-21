"""MV Hub ↔ DaVinci Resolve 로컬 연동 API."""

from __future__ import annotations

import asyncio
import urllib.parse
from datetime import datetime, timezone
from typing import Literal

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

from . import _proxy
from .. import repo
from ..deps import account_scope_uid, require_view_generation
from ..services.resolve_status_runner import (
    resolve_connection_status_bounded,
    run_resolve_import_isolated,
)
from ..services.resolve_diagnostics import resolve_environment_diagnostics
from ..services.resolve_python_installer import (
    ResolvePythonInstallError,
    start_python_installer,
)
from ..services.request_guards import require_local_machine_request
from ..services.resolve_script_installer import (
    ResolveScriptInstallError,
    install_resolve_script,
    resolve_script_status,
)
from ..services.resolve_transfer import (
    ResolveTransferError,
    list_pending_manifests,
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


class ResolveManualResultIn(BaseModel):
    project_id: str = Field(min_length=1, max_length=200)
    transfer_id: str = Field(min_length=1, max_length=80)
    status: Literal["complete", "partial", "failed"]
    total: int = Field(ge=1, le=500)
    imported: int = Field(ge=0, le=500)
    skipped: int = Field(ge=0, le=500)
    error_count: int = Field(ge=0, le=500)
    error: str | None = Field(default=None, max_length=1000)


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
    """MV Hub Resolve 가져오기·내보내기 메뉴를 공식 경로에 설치한다."""
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


@router.get("/diagnostics")
async def get_resolve_environment_diagnostics(request: Request):
    """설치·Python·API·실제 연결을 분리해 현재 PC의 Resolve 환경을 진단한다."""
    _require_local_resolve(request)
    return await asyncio.to_thread(resolve_environment_diagnostics)


@router.post("/python-install")
async def post_resolve_python_install(request: Request):
    """호환 Python이 없는 PC에서 공식 Python 설치를 반자동으로 시작한다."""
    _require_local_resolve(request)
    try:
        return await asyncio.to_thread(start_python_installer)
    except ResolvePythonInstallError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


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
        # fusionscript 는 비호환 시 프로세스를 즉시 죽일 수 있어 백엔드 안에서 직접
        # 부르지 않고, 호환 인터프리터를 고른 자식 프로세스로 실행한다.
        manifest["resolve_import"] = await asyncio.to_thread(
            run_resolve_import_isolated, manifest
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
            run_resolve_import_isolated, manifest
        )
        await save_manifest(manifest)
        return manifest
    except ResolveTransferError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.get("/transfers/pending")
async def pending_resolve_transfers(request: Request):
    """Resolve 내부 메뉴 스크립트가 가져올 준비 완료 전송 목록."""
    _require_local_resolve(request)
    projects = repo.list_projects(include_archived=True).get("projects") or []
    project_ids = [str(project.get("id") or "") for project in projects]
    manifests = await asyncio.to_thread(list_pending_manifests, project_ids)
    return {"items": manifests}


@router.post("/transfers/manual-result")
async def record_manual_resolve_result(body: ResolveManualResultIn, request: Request):
    """Resolve 내부 Importer의 완료 결과를 기록해 중복 가져오기를 막는다."""
    _require_local_resolve(request)
    if body.imported + body.skipped + body.error_count != body.total:
        raise HTTPException(status_code=400, detail="Resolve 가져오기 집계가 올바르지 않습니다")
    successful = body.imported + body.skipped
    expected_status = (
        "complete"
        if body.error_count == 0
        else ("partial" if successful else "failed")
    )
    if body.status != expected_status:
        raise HTTPException(status_code=400, detail="Resolve 가져오기 상태가 집계와 일치하지 않습니다")
    try:
        manifest = await load_manifest(body.project_id, body.transfer_id)
        manifest["resolve_import"] = {
            "status": body.status,
            "method": "resolve_menu_script",
            "project_name": "",
            "target_root": "MV Hub",
            "total": body.total,
            "imported": body.imported,
            "skipped": body.skipped,
            "error_count": body.error_count,
            "error": body.error,
            "items": [],
            "completed_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        }
        await save_manifest(manifest)
        return {"ok": True, "resolve_import": manifest["resolve_import"]}
    except ResolveTransferError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

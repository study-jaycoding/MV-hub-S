"""MV Hub ↔ DaVinci Resolve 로컬 연동 API."""

from __future__ import annotations

import asyncio
from datetime import datetime, timezone
from typing import Literal

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

from . import _proxy
from .. import active_account, repo
from ..deps import (
    account_scope_uid,
    batch_view_member_projects,
    can_view_generation_with_member_projects,
    current_account,
)
from ..services import resolve_queue, resolve_queue_worker
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
    # v2 동기 준비 경로. 접수는 더 이상 직접 호출하지 않지만(전담 워커가 준비한다)
    # "접수가 복사를 하지 않는다"를 확인하는 기존 계약 테스트가 이 이름을 참조한다.
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


def _accept_account_scope(request: Request) -> dict:
    """재시작 뒤에도 같은 계정으로만 재개하도록 접수 시점 계정을 고정한다(명세 §1.6)."""
    account = current_account(request) or {}
    return resolve_queue.build_account_scope(
        account_key=active_account.account_key() or "",
        account_email=str(account.get("email") or active_account.active_email() or ""),
        creator_uid=str(account_scope_uid(request) or ""),
        server_origin=_proxy.base_url() if _proxy.proxying() else "",
    )


def _remote_generation_lookup(gen_id: str) -> dict | None:
    """워커가 로컬에 없는 생성물을 다시 찾을 때 쓰는 위임 조회(계층 경계 주입)."""
    if not gen_id or not _proxy.proxying():
        return None
    remote = _proxy.proxy_json("GET", f"/api/generations/{gen_id}")
    return remote if isinstance(remote, dict) else None


resolve_queue_worker.set_remote_lookup(_remote_generation_lookup)


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


@router.post("/transfers", status_code=202)
async def create_resolve_transfer(body: ResolveTransferIn, request: Request):
    """전송을 큐에 접수만 한다(원본 복사·Resolve 가져오기는 전담 워커가 수행).

    종전엔 이 요청 하나가 대용량 복사와 Resolve 조작까지 끝낼 때까지 붙잡혀 있었다.
    이제는 권한 판정 → 대상 Resolve 프로젝트 고정 → v3 manifest 원자 기록까지만 하고
    ``202 Accepted`` 로 즉시 돌려준다(명세 §1.7).
    """
    _require_local_resolve(request)
    ids = list(dict.fromkeys(gen_id.strip() for gen_id in body.gen_ids if gen_id.strip()))
    if not ids:
        raise HTTPException(status_code=400, detail="전송할 생성물을 선택하세요")
    # 최대 500건 판정 배치화(R7 2-D) — 종전엔 ID 마다 로컬 단건 DB 조회(이벤트 루프 위)
    # 와 원격 단건 GET 을 순차 반복했다. 로컬 1회+멤버십 1회+원격 batch 1회로 줄이고
    # 입력 순서대로 재조립한다. ★로컬에 존재하지만 열람 불가(숨김)인 ID 는 원격 폴백
    # 금지 — 단건 경로와 동일하게 404(존재 은닉). 진짜 부재만 원격 batch 로 간다.
    def _local_lookup() -> tuple[dict, "object"]:
        local = repo.get_generations_batch(ids, account_uid=account_scope_uid(request))
        members = batch_view_member_projects(request, local.values())
        return local, members

    local_gens, member_projects = await asyncio.to_thread(_local_lookup)
    # 로컬 권한 판정을 원격 batch '전'에(코덱스 P2 — 오류 우선순위 동등성): 종전 단건
    # 순차는 [열람불가 로컬, 원격 missing] 에서 즉시 404 였다 — 원격 장애(401/502)가
    # 먼저 나지 않게 입력 순서로 로컬 실패를 먼저 확정한다.
    for gen_id in ids:
        gen = local_gens.get(gen_id)
        if gen and not can_view_generation_with_member_projects(
            request, gen, member_projects
        ):
            raise HTTPException(status_code=404, detail="generation 없음")
    missing = [gen_id for gen_id in ids if gen_id not in local_gens]
    remote_cards: dict[str, dict] = {}
    if missing and _proxy.proxying():
        remote = await asyncio.to_thread(
            _proxy.proxy_json,
            "POST",
            "/api/generations/batch",
            body={"gen_ids": missing},
        )
        items = remote.get("items") if isinstance(remote, dict) else None
        if isinstance(items, dict):
            remote_cards = {
                requested: card
                for requested, card in items.items()
                if isinstance(requested, str) and isinstance(card, dict)
            }
    generations = []
    for gen_id in ids:  # 입력 순서 재조립 — 첫 실패가 단건 경로와 같은 404 를 낸다
        gen = local_gens.get(gen_id)
        if gen:
            generations.append(gen)  # 권한은 위에서 원격 호출 전에 이미 판정
            continue
        card = remote_cards.get(gen_id)
        if card is not None:
            generations.append(card)
            continue
        raise HTTPException(
            status_code=404, detail=f"생성물을 찾을 수 없습니다: {gen_id}"
        )
    project_ids = {str(gen.get("project_id") or "") for gen in generations}
    if "" in project_ids:
        raise HTTPException(status_code=400, detail="프로젝트에 배정된 생성물만 전송할 수 있습니다")
    if len(project_ids) != 1:
        raise HTTPException(status_code=400, detail="한 번에 하나의 프로젝트만 전송할 수 있습니다")
    try:
        manifest, ahead = await resolve_queue.accept_transfer(
            next(iter(project_ids)),
            generations,
            resolve_target={
                "project_id": body.resolve_project_id.strip(),
                "project_name": body.resolve_project_name.strip(),
            },
            account_scope=_accept_account_scope(request),
        )
    except ResolveTransferError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    queue = resolve_queue.queue_block(manifest)
    return {
        "transfer_id": str(manifest.get("transfer_id") or ""),
        "project_id": str(manifest.get("project_id") or ""),
        "project_name": str(manifest.get("project_name") or ""),
        "queued": True,
        "ahead": ahead,
        "queue": {
            "state": queue.get("state"),
            "dispatch_policy": queue.get("dispatch_policy"),
        },
        "resolve_target": manifest.get("resolve_target") or {},
        "status": manifest.get("status"),
        "total": int(manifest.get("total") or 0),
        "worker_enabled": resolve_queue_worker.worker_enabled(),
    }


@router.post("/transfers/retry")
async def retry_resolve_transfer(body: ResolveRetryIn, request: Request):
    """이미 준비된 v2 원본 manifest를 다시 읽어 Resolve 가져오기만 재실행한다."""
    _require_local_resolve(request)
    try:
        manifest = await load_manifest(body.project_id.strip(), body.transfer_id.strip())

        async def _import_and_save() -> dict:
            # ★가져오기 실행과 결과 저장은 한 단위다. 둘 사이가 끊기면 Resolve 는 바뀌었는데
            # manifest 에는 흔적이 남지 않아 다음 실행이 같은 작업을 또 한다.
            result = await asyncio.to_thread(run_resolve_import_isolated, manifest)
            manifest["resolve_import"] = result
            await save_manifest(manifest)
            return result

        await resolve_queue.run_non_abandon(_import_and_save())
        return manifest
    except ResolveTransferError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.get("/queue")
async def get_resolve_queue(request: Request):
    """v3 큐 목록 — 상태·앞 대기 건수(ahead)·마지막 오류 코드."""
    _require_local_resolve(request)
    projects_payload = await asyncio.to_thread(repo.list_projects, include_archived=True)
    project_ids = [
        str(project.get("id") or "") for project in (projects_payload.get("projects") or [])
    ]
    items = await asyncio.to_thread(resolve_queue.queue_snapshot, project_ids)
    return {"items": items, "worker_enabled": resolve_queue_worker.worker_enabled()}


@router.get("/transfers/pending")
async def pending_resolve_transfers(request: Request):
    """Resolve 내부 메뉴 스크립트가 가져올 준비 완료 전송 목록."""
    _require_local_resolve(request)
    # 프로젝트 목록 조회도 스레드로(R7 2-D) — async 라우트 위 동기 DB 호출 제거.
    projects_payload = await asyncio.to_thread(repo.list_projects, include_archived=True)
    projects = projects_payload.get("projects") or []
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

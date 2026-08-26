"""MV Hub ↔ DaVinci Resolve 로컬 연동 API."""

from __future__ import annotations

import asyncio
import contextlib
from datetime import datetime, timezone
from typing import AsyncIterator, Literal

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
from ..services import resolve_lock, resolve_queue, resolve_queue_worker
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
    # Send to Resolve의 직접 준비 경로.
    transfer_generations,
)


router = APIRouter(prefix="/api/resolve", tags=["resolve"])


class ResolveTransferIn(BaseModel):
    gen_ids: list[str] = Field(min_length=1, max_length=500)
    resolve_project_id: str = Field(default="", max_length=200)
    resolve_project_name: str = Field(default="", max_length=500)
    # 같은 클릭의 재요청이 두 번째 전송을 만들지 않게 하는 접수 키(§1.7 202 전 크래시).
    idempotency_key: str = Field(default="", max_length=120)


class ResolveRetryIn(BaseModel):
    project_id: str = Field(min_length=1, max_length=200)
    transfer_id: str = Field(min_length=1, max_length=80)


class ResolveQueueCancelIn(BaseModel):
    # 강제 중단은 Resolve 조작을 도중에 끊는다. 화면에서 2차 확인을 받은 경우만 true.
    force: bool = False


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


def _capture_account_pin() -> tuple[str, str | None]:
    """계정 DB 키와 그 계정의 uid 를 **같은 전환 락 구간**에서 한 쌍으로 캡처한다.

    둘을 따로 읽으면 그 사이에 낀 전환이 'A DB 를 읽으면서 소유자는 B' 조합을 만든다
    (share.py 의 _capture_account_pin 과 같은 규율 — 그 모듈은 건드리지 않는다).
    """
    with active_account.transition_lock:
        return active_account.account_key() or "", active_account.active_uid()


@contextlib.asynccontextmanager
async def _pinned_account_scope() -> AsyncIterator[str]:
    """라우트 전체를 접수 시점 계정으로 고정한다(R11~13 패턴의 async 판).

    접수는 로컬 배치 조회 → 멤버십 판정 → (위임이면) 원격 batch → manifest 기록으로
    이어지고, 이 단계들은 전부 **호출 시점의** 활성 계정 DB 를 읽는다. 원격 왕복을
    기다리는 사이 다른 창에서 A→B 로 전환하면 'A 로 판정하고 B 로 기록'이 조용히 생기고,
    그 계정 scope 가 manifest 에 박혀 워커가 잘못된 계정으로 재개한다.

    ★async 라우트라 전환 락은 워커 스레드에서 잡는다 — 이벤트 루프에서 기다리면
    로그인 마이그레이션·DB 복원이 초 단위로 서버 전체를 세운다.
    """
    account_key, account_uid = await asyncio.to_thread(_capture_account_pin)
    account_token = active_account.set_override(account_key)
    uid_token = active_account.set_uid_override(account_uid)
    try:
        yield account_key
    finally:
        active_account.reset_uid_override(uid_token)
        active_account.reset_override(account_token)


def _accept_account_scope(request: Request, account_key: str) -> dict:
    """재시작 뒤에도 같은 계정·같은 서버에서만 재개하도록 접수 시점을 고정한다(§1.6)."""
    account = current_account(request) or {}
    return resolve_queue.build_account_scope(
        account_key=account_key,
        account_email=str(account.get("email") or active_account.active_email() or ""),
        creator_uid=str(account_scope_uid(request) or ""),
        server_origin=_current_server_origin(),
        host_id=resolve_lock.host_id(),
    )


def _current_server_origin() -> str:
    """지금 붙어 있는 공유 서버 origin(위임 모드가 아니면 빈 문자열)."""
    return _proxy.base_url() if _proxy.proxying() else ""


def _remote_generation_lookup(gen_id: str) -> dict | None:
    """워커가 로컬에 없는 생성물을 다시 찾을 때 쓰는 위임 조회(계층 경계 주입)."""
    if not gen_id or not _proxy.proxying():
        return None
    remote = _proxy.proxy_json("GET", f"/api/generations/{gen_id}")
    return remote if isinstance(remote, dict) else None


resolve_queue_worker.set_remote_lookup(_remote_generation_lookup)
resolve_queue_worker.set_server_origin(_current_server_origin)


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


def _status_with_queue_reevaluation() -> dict:
    """연결 상태를 확인하고, 열린 프로젝트가 바뀌었으면 blocked 큐를 즉시 재평가한다.

    보류 재시도는 최대 15분까지 백오프한다. 사용자가 대상 프로젝트를 방금 열었는데도
    그만큼 기다리면 큐가 멈춘 것처럼 보이므로, '상태 조회 성공'을 §B 의 재평가 트리거로
    쓴다(관측 값이 직전과 같으면 아무 파일도 읽지 않는다).
    """
    status = resolve_connection_status_bounded()
    with contextlib.suppress(Exception):
        resolve_queue_worker.note_resolve_project(status)
    return status


@router.get("/status")
async def get_resolve_connection_status(request: Request):
    """현재 PC의 Resolve 연결과 열린 프로젝트를 확인한다."""
    _require_local_resolve(request)
    return await asyncio.to_thread(_status_with_queue_reevaluation)


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


@router.post("/transfers")
async def create_resolve_transfer(body: ResolveTransferIn, request: Request):
    """완료본을 준비하고 현재 열린 Resolve로 직접 가져온 뒤 결과를 반환한다.

    서버 영구 큐는 사용하지 않는다. 브라우저의 짧은 직렬화만 남겨 Resolve API를
    동시에 호출하지 않으며, 이 요청 한 건 안에서 준비·가져오기·결과 저장을 끝낸다.
    """
    _require_local_resolve(request)
    async with _pinned_account_scope() as account_key:
        return await _create_resolve_transfer_pinned(body, request, account_key)


async def _create_resolve_transfer_pinned(
    body: ResolveTransferIn, request: Request, account_key: str
):
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
    async def _transfer_and_import() -> dict:
        manifest = await transfer_generations(next(iter(project_ids)), generations)
        if body.resolve_project_id or body.resolve_project_name:
            manifest["resolve_target"] = {
                "project_id": body.resolve_project_id.strip(),
                "project_name": body.resolve_project_name.strip(),
            }
            # 가져오기 전에 대상 프로젝트를 먼저 기록해 연결이 끊겨도 재시도할 수 있게 한다.
            await save_manifest(manifest)
        manifest["resolve_import"] = await asyncio.to_thread(
            run_resolve_import_isolated, manifest
        )
        await save_manifest(manifest)
        return manifest

    try:
        return await resolve_queue.run_non_abandon(_transfer_and_import())
    except ResolveTransferError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


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


async def _queue_project_ids() -> list[str]:
    projects_payload = await asyncio.to_thread(repo.list_projects, include_archived=True)
    return [
        str(project.get("id") or "") for project in (projects_payload.get("projects") or [])
    ]


@router.get("/queue")
async def get_resolve_queue(request: Request):
    """v3 큐 목록 — 상태·앞 대기 건수(ahead)·경고·마지막 오류 코드."""
    _require_local_resolve(request)
    project_ids = await _queue_project_ids()
    items = await asyncio.to_thread(
        resolve_queue.queue_snapshot,
        project_ids,
        owner_host_id=resolve_lock.host_id(),
    )
    return {
        "items": items,
        "worker_enabled": resolve_queue_worker.worker_active(),
        "worker_detail": resolve_queue_worker.worker_detail(),
    }


async def _find_queued_transfer(transfer_id: str) -> dict:
    project_ids = await _queue_project_ids()
    try:
        return await asyncio.to_thread(
            resolve_queue.find_manifest,
            project_ids,
            transfer_id,
            owner_host_id=resolve_lock.host_id(),
        )
    except resolve_queue.ResolveQueueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@router.post("/queue/{transfer_id}/cancel")
async def cancel_resolve_queue_transfer(
    transfer_id: str, body: ResolveQueueCancelIn, request: Request
):
    """전송을 폐기한다.

    - ``queued``·``ready``·``blocked`` 등 실행 전: 그 자리에서 ``cancelled``.
    - ``preparing``: 협력적 취소 — 워커가 **항목 사이**에서 멈춘 뒤 확정한다.
    - ``importing``: ``force=true`` 로 2차 확인을 받은 경우에만 자식을 끊는다. 부수효과
      범위를 알 수 없으므로 결과는 항상 ``recovery_required`` 다(§D).
    """
    _require_local_resolve(request)
    manifest = await _find_queued_transfer(transfer_id.strip())
    state = resolve_queue.queue_state(manifest)
    actor = str(account_scope_uid(request) or "")
    try:
        outcome = await asyncio.to_thread(
            resolve_queue.cancel_sync,
            manifest,
            force=body.force,
            requested_by=actor,
        )
    except resolve_queue.ResolveQueueError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    stopped = False
    if body.force and state == resolve_queue.STATE_IMPORTING and not outcome["applied"]:
        # 워커가 아직 자식을 기다리는 중 — 그 자식만 끊는다(§D 2차 확인 전용 경로).
        stopped = await asyncio.to_thread(
            resolve_queue_worker.force_stop_import, manifest
        )
    return {
        "ok": True,
        "transfer_id": str(manifest.get("transfer_id") or ""),
        "previous_state": state,
        **outcome,
        "child_stopped": stopped,
    }


@router.post("/queue/{transfer_id}/resume")
async def resume_resolve_queue_transfer(transfer_id: str, request: Request):
    """사용자가 확인한 뒤의 수동 재시도(자동 재실행은 계속 금지).

    - ``interrupted``: 누락분만 다시 가져올 수 있게 ``ready`` 로 되돌린다(누락 0이면 완료).
    - ``recovery_required``: Bin·DRP 를 확인했다는 뜻으로 ``interrupted`` 까지만 내린다.
    - ``failed``·``blocked``: 준비분이 있으면 ``ready``, 없으면 ``queued``.
    """
    _require_local_resolve(request)
    manifest = await _find_queued_transfer(transfer_id.strip())
    previous = resolve_queue.queue_state(manifest)
    try:
        outcome = await asyncio.to_thread(resolve_queue.resume_sync, manifest)
    except resolve_queue.ResolveQueueError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    return {
        "ok": True,
        "transfer_id": str(manifest.get("transfer_id") or ""),
        "previous_state": previous,
        **outcome,
    }


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


@router.get("/locks")
def get_resolve_lock_paths(request: Request):
    """메뉴 Importer 가 push 워커와 **같은 락 파일**에 참여하도록 경로를 알려 준다.

    프로젝트 락은 manifest_root 에서 유도할 수 있지만 PC 공용 락은 허브의 데이터 폴더
    안이라 Resolve 안에서 알 수 없다. 이 경로 없이 프로젝트 락만 잡으면 '워커=프로젝트 B,
    메뉴=프로젝트 A'가 같은 Resolve 를 동시에 변형한다.
    """
    _require_local_resolve(request)
    return {
        "machine_lock_path": str(resolve_lock.machine_lock_path()),
        "project_lock_relative": ".mvhub/locks/project-import.lock",
    }


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

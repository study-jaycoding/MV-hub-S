"""작업자 PC 릴리스 업데이트 API — 로컬 요청만 허용한다."""

from __future__ import annotations

import asyncio

from fastapi import APIRouter, Header, HTTPException, Request
from pydantic import BaseModel

from . import comfy
from ..config import PORT
from ..services.operational_health import generation_queue_snapshot
from ..services.resolve_transfer import active_transfer_count
from ..services.release_update import (
    APP_ROOT,
    ReleaseUpdateBusyError,
    ReleaseUpdateError,
    fetch_latest,
    get_status,
    install_mode,
    start_update,
)
from ..services.request_guards import require_local_machine_request

router = APIRouter(prefix="/api/release-update", tags=["release-update"])


class UpdateStartIn(BaseModel):
    confirm: bool


def _require_local(request: Request) -> None:
    require_local_machine_request(
        request,
        "프로그램 업데이트는 해당 작업자 PC에서만 실행할 수 있습니다",
    )


def _activity() -> dict[str, int]:
    generation = int(generation_queue_snapshot().get("active_total") or 0)
    comfy_count = comfy.active_run_job_count()
    # 진행 중 직접 전송(요청 안에서 준비·반입·저장). 전송 쪽은 카운터를 올린 뒤 update_in_progress
    # 게이트를 보고, 이쪽은 checking 기록 뒤 재확인한다(services/release_update.start_update).
    resolve_count = active_transfer_count()
    return {
        "generation_active": generation,
        "comfy_active": comfy_count,
        "resolve_active": resolve_count,
        "active_total": generation + comfy_count + resolve_count,
    }


def _with_activity(status: dict) -> dict:
    activity = _activity()
    return {
        **status,
        **activity,
        "can_update": bool(status.get("can_update")) and activity["active_total"] == 0,
    }


@router.get("/status")
async def release_update_status(request: Request, refresh: bool = False):
    _require_local(request)
    status = await asyncio.to_thread(get_status, refresh=refresh)
    # _with_activity 는 generation_queue_snapshot(SQLite 집계)을 부른다 — async 라우트
    # 위에서 직접 돌리면 이벤트 루프가 멈춘다(R5 ops-1) → 스레드로 내린다.
    return await asyncio.to_thread(_with_activity, status)


@router.get("/latest-metadata")
async def release_update_latest_metadata(request: Request):
    """관리자 업데이트 등록용 최신 릴리스 메타데이터(로컬 설치 원본에서 읽음)."""
    _require_local(request)
    if install_mode(APP_ROOT) != "release":
        raise HTTPException(
            status_code=400,
            detail="릴리스 설치본에서만 최신 업데이트 파일을 확인할 수 있습니다",
        )
    try:
        latest = await asyncio.to_thread(fetch_latest, APP_ROOT)
    except ReleaseUpdateError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    # INSTALL_SOURCE 같은 로컬 경로는 브라우저·공유 서버로 내보내지 않는다.
    return {
        "version": latest["version"],
        "file": latest["file"],
        "sha256": latest["sha256"],
        "size": latest["size"],
        "created_at": latest["created_at"],
    }


@router.post("/start", status_code=202)
async def release_update_start(
    body: UpdateStartIn,
    request: Request,
    x_mvhub_update: str | None = Header(default=None),
):
    _require_local(request)
    if not body.confirm or x_mvhub_update != "1":
        raise HTTPException(status_code=400, detail="업데이트 확인값이 올바르지 않습니다")

    def active_total() -> int:
        return _activity()["active_total"]

    ready_url = f"http://127.0.0.1:{PORT}/api/ready"
    try:
        result = await asyncio.to_thread(
            start_update,
            activity_check=active_total,
            ready_url=ready_url,
        )
    except ReleaseUpdateBusyError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except ReleaseUpdateError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return await asyncio.to_thread(_with_activity, result)  # SQL 집계 — 루프 밖(R5 ops-1)

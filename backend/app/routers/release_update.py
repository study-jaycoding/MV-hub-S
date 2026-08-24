"""작업자 PC 릴리스 업데이트 API — 로컬 요청만 허용한다."""

from __future__ import annotations

import asyncio

from fastapi import APIRouter, Header, HTTPException, Request
from pydantic import BaseModel

from .. import repo
from . import comfy
from ..config import PORT
from ..services.operational_health import generation_queue_snapshot
from ..services import resolve_queue
from ..services.release_update import (
    ReleaseUpdateBusyError,
    ReleaseUpdateError,
    get_status,
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
    projects = repo.list_projects(include_archived=True).get("projects") or []
    project_ids = [str(project.get("id") or "") for project in projects]
    resolve_count = len(
        resolve_queue.scan_projects(project_ids, states=resolve_queue.ACTIVE_STATES)
    )
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

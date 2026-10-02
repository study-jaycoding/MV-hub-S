"""작업자 PC 릴리스 업데이트 API — 로컬 요청만 허용한다."""

from __future__ import annotations

import asyncio
import logging

from fastapi import APIRouter, Header, HTTPException, Request
from pydantic import BaseModel

from . import _proxy, comfy
from .. import active_account
from ..config import PORT
from ..services.operational_health import generation_queue_snapshot
from ..services.operational_logging import log_event
from ..services.resolve_transfer import active_transfer_count
from ..services.release_update import (
    APP_ROOT,
    ReleasePromoteError,
    ReleaseUpdateBusyError,
    ReleaseUpdateError,
    get_status,
    install_mode,
    promote_candidate,
    release_overview,
    start_update,
)
from ..services.request_guards import require_local_machine_request

router = APIRouter(prefix="/api/release-update", tags=["release-update"])
_log = logging.getLogger("mvhub.release_update")


class UpdateStartIn(BaseModel):
    confirm: bool
    # 실제 진행 중 작업 검사를 건너뛰는 비상 우회. 정상 버튼의 오집계 해소 수단으로 쓰지 않는다.
    force: bool = False


def _require_local(request: Request) -> None:
    require_local_machine_request(
        request,
        "프로그램 업데이트는 해당 작업자 PC에서만 실행할 수 있습니다",
    )


def _activity() -> dict[str, int]:
    generation = int(generation_queue_snapshot().get("update_blocking_total") or 0)
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


def _admin_candidate_version(status: dict) -> str | None:
    """관리자 PC 설정 화면에만 보이는 '새 후보' 한 줄(B안) — 상태 파일에는 쓰지 않는다. 역할은 로그인 때
    저장한 값이라 표시용일 뿐이다(설치·공지 권한과 무관)."""
    from .publish import _is_admin

    if status.get("install_mode") != "release" or not _is_admin():
        return None
    try:
        overview = release_overview(APP_ROOT)
    except ReleaseUpdateError:
        return None
    version = overview["version"]
    if overview["source"] != "candidate" or not overview["pending"]:
        return None
    return None if version in (status.get("latest_version"), status.get("current_version")) else version


@router.get("/status")
async def release_update_status(request: Request, refresh: bool = False):
    _require_local(request)
    status = await asyncio.to_thread(get_status, refresh=refresh)
    if refresh:  # 후보는 NAS 를 한 번 더 읽으므로 '다시 확인'·주기 확인 때만
        candidate = await asyncio.to_thread(_admin_candidate_version, status)
        if candidate:
            status = {**status, "candidate_version": candidate}
    # _with_activity 는 generation_queue_snapshot(SQLite 집계)을 부른다 — async 라우트
    # 위에서 직접 돌리면 이벤트 루프가 멈춘다(R5 ops-1) → 스레드로 내린다.
    return await asyncio.to_thread(_with_activity, status)


@router.get("/latest-metadata")
async def release_update_latest_metadata(request: Request):
    """관리자 업데이트 탭용 — NAS 의 후보(없으면 공개 표지)와 공개 상태(B안 r4 §4)."""
    _require_local(request)
    if install_mode(APP_ROOT) != "release":
        raise HTTPException(
            status_code=400,
            detail="릴리스 설치본에서만 최신 업데이트 파일을 확인할 수 있습니다",
        )
    try:
        # INSTALL_SOURCE 같은 로컬 경로는 브라우저·공유 서버로 내보내지 않는다(release_overview 도 안 담는다).
        return await asyncio.to_thread(release_overview, APP_ROOT)
    except ReleaseUpdateError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


class PromoteIn(BaseModel):
    notice_id: str
    sha256: str


@router.post("/promote")
def release_update_promote(body: PromoteIn, request: Request):
    """[공지]한 후보를 팀에 배포 — NAS 표지(latest.json)를 후보로 바꾼다(B안 r4).

    동기 def(스레드풀): 서버 단건 조회·NAS 읽기·zip 검증·잠금이 이벤트 루프를 막지 않게 한 덩어리로 돈다.
    '공지됐나'는 공유 서버가 판정한다(관리자만 단건 조회 가능). 서버 오류는 그대로 중단 — 로컬 판단으로
    대신하지 않는다. 최종 쓰기 권한은 NAS 의 릴리스 폴더 권한이다.
    """
    _require_local(request)
    if install_mode(APP_ROOT) != "release":
        raise HTTPException(status_code=400, detail="릴리스 설치본(관리자 PC)에서만 배포할 수 있습니다")
    if not _proxy.proxying():
        raise HTTPException(status_code=400, detail="공유 서버에 연결된 관리자 PC 에서만 배포할 수 있습니다")
    digest = body.sha256.strip().lower()
    with active_account.pinned_account_scope():
        try:
            item = _proxy.proxy_json(
                "GET", "/api/update-notices/admin/item", params={"sha256": digest}, timeout=20
            )
        except HTTPException as exc:
            if exc.status_code == 404:
                detail = (
                    "공유 서버를 업데이트한 뒤 배포할 수 있습니다"
                    if exc.detail == "Not Found"  # 라우트가 없는 옛 서버(새 서버의 '없음'은 한국어 문구)
                    else "목록에 등록·공지된 후보만 배포할 수 있습니다"
                )
                raise HTTPException(status_code=409, detail=detail) from exc
            raise
        if not isinstance(item, dict) or item.get("id") != body.notice_id:
            raise HTTPException(status_code=409, detail="업데이트 항목이 바뀌었습니다 — 업데이트 탭을 다시 열어 확인하세요")
        if int(item.get("announcement_revision") or 0) < 1:
            raise HTTPException(status_code=409, detail="공지된 업데이트만 팀에 배포할 수 있습니다")
        try:
            result = promote_candidate(item, APP_ROOT)
        except ReleasePromoteError as exc:
            raise HTTPException(status_code=exc.status, detail=str(exc)) from exc
        except ReleaseUpdateError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
    log_event(_log, "release_promoted", version=result["version"], sha256=digest[:12], already=result["already"])
    return result


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
    if body.force:
        forced_activity = await asyncio.to_thread(_activity)
        log_event(
            _log,
            "release_update_force_requested",
            level=logging.WARNING,
            **forced_activity,
        )
    try:
        result = await asyncio.to_thread(
            start_update,
            activity_check=(lambda: 0) if body.force else active_total,
            ready_url=ready_url,
            force=body.force,
        )
    except ReleaseUpdateBusyError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except ReleaseUpdateError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return await asyncio.to_thread(_with_activity, result)  # SQL 집계 — 루프 밖(R5 ops-1)

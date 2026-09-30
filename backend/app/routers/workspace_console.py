"""워크스페이스 콘솔(서브스페이스 탭) — 메인·서브 표식과 메인 조율 개요. 설계: docs/WORKSPACE_CONSOLE_DESIGN.md.

서버 권위: 로컬 허브에서는 프록시 미들웨어가 `/api/manage/console/*` 를 공유 서버로 넘긴다(로컬 목록에 없음).
할당·그룹·참가자 쓰기는 여기 없다 — 기존 `PUT /api/manage/credit-plan/{ws}` 를 그대로 쓴다.
"""

from typing import Optional

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

from .. import rbac
from ..config import AUTH_ENABLED
from ..deps import account_global_roles, actor_id, require_global_cap
from ..repo import workspace_console as repo_console
from ..services.telemetry_drain import drain_isolated_telemetry

router = APIRouter()


class ConsoleLinkIn(BaseModel):
    workspace_id: str = Field(min_length=1, max_length=128)


class ConsolePatchIn(BaseModel):
    archived: Optional[bool] = None
    status: Optional[str] = Field(default=None, max_length=16)  # active | inactive | done (표시용)


def _run(fn, *args):
    try:
        return fn(*args)
    except LookupError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except repo_console.ConsoleConflict as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc


@router.get("/console/overview")
def console_overview(request: Request):
    """메인·서브 집계 숫자만(이메일·이름 없음) — 그래서 read_all 로 연다. 상세는 credit-plan settings(create_project)."""
    require_global_cap(request, "read_all")
    try:
        drain_isolated_telemetry()
    except Exception:  # noqa: BLE001 - 복구 실패가 조회까지 막지 않게(대시보드와 같은 규칙)
        pass
    # 프로젝트 1회 채우기는 **생성 권한(create_project)** 이 있는 사람이 볼 때만 — 보기 권한(read_all)만으로 조회가
    # 프로젝트를 만들면 안 된다(Codex 코드 리뷰).
    can_create = not AUTH_ENABLED or rbac.has_global_cap(account_global_roles(request), "create_project")
    return repo_console.overview(backfill_projects=can_create)


@router.post("/console/workspaces")
def console_link(body: ConsoleLinkIn, request: Request):
    """'워크스페이스 만들기' = 보고된 워크스페이스를 서브로 연결(힉스필드 생성은 앱이 못 한다)."""
    require_global_cap(request, "create_project")
    workspace_id = body.workspace_id.strip()
    result = _run(repo_console.link_sub, workspace_id, actor_id(request))
    # 서브 1개 = 프로젝트 1개 — 연결(재연결 포함)할 때마다 다시 시도한다. 실패해도 연결은 유지하고 이유를 돌려준다(Codex 2차).
    try:
        created = repo_console.ensure_sub_project(workspace_id, actor_id(request))
        result = {**result, "project_created": bool(created), "project_error": None}
    except Exception as exc:  # noqa: BLE001
        result = {**result, "project_created": False, "project_error": str(exc)}
    return result


@router.patch("/console/workspaces/{workspace_id}")
def console_patch(workspace_id: str, body: ConsolePatchIn, request: Request):
    require_global_cap(request, "create_project")
    if body.archived is None and body.status is None:
        raise HTTPException(status_code=400, detail="바꿀 값이 없습니다")
    try:
        if body.status is not None:
            result = _run(repo_console.set_status, workspace_id, body.status, actor_id(request))
        if body.archived is not None:
            result = _run(repo_console.set_archived, workspace_id, body.archived, actor_id(request))
    except ValueError as exc:  # 상태 값 검증(충돌은 _run 이 409 로 이미 바꾼다)
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return result


class AllocBaseIn(BaseModel):
    credits: Optional[float] = Field(default=None, ge=0)  # null = 기준값 지우기(기록 기준 추정으로)
    day: Optional[str] = Field(default=None, max_length=10)


@router.put("/console/allocation-base")
def console_alloc_base(body: AllocBaseIn, request: Request):
    """메인의 '할당된 크레딧' 기준값(힉스필드 화면 값) — 크레딧 설정 권한(create_project)."""
    require_global_cap(request, "create_project")
    try:
        return _run(repo_console.set_alloc_base, body.credits, body.day, actor_id(request))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.put("/console/main")
def console_set_main(body: ConsoleLinkIn, request: Request):
    """메인 최초 지정 — admin(grant_global)만."""
    require_global_cap(request, "grant_global")
    return _run(repo_console.set_main, body.workspace_id.strip(), actor_id(request))

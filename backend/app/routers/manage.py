"""PM 대시보드(매니징먼트) 라우터 — 분리형 사이드카 모듈.

설계: PM_DASHBOARD_DESIGN.md. 요청 모델도 여기 인라인으로 둔다(공용 models.py 무수정 → 격리).
★main.py 는 CONTENT_HUB_MANAGE=1 일 때만 이 라우터를 등록한다 → 기본 off 면 엔드포인트
자체가 없어 운영 동작에 영향 0(올려도 꺼진 채, 플래그만 켜면 활성).
"""

from __future__ import annotations

from typing import Optional

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

from .. import rbac, repo
from ..config import AUTH_ENABLED
from ..deps import (
    account_global_roles,
    account_scope_uid,
    project_roles_of,
    require_global_cap,
    require_project_role,
    require_view_generation,
)
from ..repo import manage as repo_manage
from ..services import cli_bridge, project_folders

router = APIRouter(prefix="/api/manage", tags=["manage"])


_PROJECT_READ_ROLES = (rbac.PROJECT_MANAGER, rbac.SUPERVISOR, rbac.CREATOR)


def _require_manage_read(request: Request) -> None:
    """전사 PM 집계 열람. admin/PM/PD 같은 read_all 보유자만."""
    require_global_cap(request, "read_all")


def _require_project_read(request: Request, pid: str) -> None:
    if not repo.get_project(pid):
        raise HTTPException(status_code=404, detail="없는 프로젝트")
    require_project_role(request, pid, *_PROJECT_READ_ROLES, read_only=True)


def _require_project_manage(request: Request, pid: str) -> None:
    if not repo.get_project(pid):
        raise HTTPException(status_code=404, detail="없는 프로젝트")
    if not AUTH_ENABLED:
        return
    roles = account_global_roles(request)
    if (
        rbac.has_global_cap(roles, "system")
        or rbac.has_global_cap(roles, "create_project")
        or rbac.has_global_cap(roles, "grant_project_role")
    ):
        return
    project_roles = project_roles_of(request, pid)
    if rbac.has_project_cap(project_roles, "schedule") or rbac.has_project_cap(
        project_roles, "manage_members"
    ):
        return
    raise HTTPException(status_code=403, detail="프로젝트 관리 권한이 없습니다")


def _task_project_or_404(tid: str) -> str:
    pid = repo_manage.task_project_id(tid)
    if not pid:
        raise HTTPException(status_code=404, detail="없는 작업")
    return pid


@router.get("/summary")
async def summary(request: Request):
    """프로젝트별·작업자별 생성수·크레딧·시간 + 출력타입·영상길이·환불·워크스페이스 요약.
    출력타입 정확화를 위해 CLI model list 로 (job_set_type→type) 맵을 만들어 넘긴다 —
    CLI 없으면(공유 서버) 빈 맵 → asset.type 추측으로 폴백(graceful)."""
    _require_manage_read(request)
    type_map: dict = {}
    try:
        for m in await cli_bridge.list_models():
            jt, t = m.get("job_set_type"), m.get("type")
            if jt and t:
                type_map[jt] = t
    except Exception:  # noqa: BLE001 — 모델목록 실패해도 요약은 폴백으로 동작
        type_map = {}
    return repo_manage.dashboard_summary(type_map)


# ── 프로젝트 일정/예산 ────────────────────────────────────────────────────────
class PlanningIn(BaseModel):
    status: Optional[str] = None        # active | done | hold
    start_date: Optional[str] = None
    due_date: Optional[str] = None
    budget_credits: Optional[int] = None
    note: Optional[str] = None


class ProjectFolderIn(BaseModel):
    root_path: Optional[str] = None
    selected_path: Optional[str] = None


@router.get("/project-folders")
def project_folder_links(request: Request):
    links = repo_manage.list_project_folders()
    if not AUTH_ENABLED or rbac.has_global_cap(account_global_roles(request), "read_all"):
        return {"links": links}
    uid = account_scope_uid(request)
    if not uid:
        return {"links": {}}
    visible = repo.list_projects(include_archived=True, member_uid=uid).get("projects") or []
    visible_ids = {p.get("id") for p in visible if isinstance(p, dict)}
    return {"links": {pid: link for pid, link in links.items() if pid in visible_ids}}


@router.get("/project-folders/{pid}")
def get_project_folder(pid: str, request: Request):
    _require_project_read(request, pid)
    return project_folders.project_folder_state(pid)


@router.put("/project-folders/{pid}")
def put_project_folder(pid: str, body: ProjectFolderIn, request: Request):
    _require_project_manage(request, pid)
    repo_manage.set_project_folder(pid, body.root_path, body.selected_path)
    return project_folders.project_folder_state(pid)


@router.get("/planning/{pid}")
def get_planning(pid: str, request: Request):
    _require_project_read(request, pid)
    return repo_manage.get_planning(pid) or {}


@router.put("/planning/{pid}")
def put_planning(pid: str, body: PlanningIn, request: Request):
    _require_project_manage(request, pid)
    return repo_manage.set_planning(pid, **body.model_dump())


# ── 작업(Task) ────────────────────────────────────────────────────────────────
class TaskIn(BaseModel):
    project_id: str
    name: str
    status: Optional[str] = None
    assignee_uid: Optional[str] = None
    start_date: Optional[str] = None
    due_date: Optional[str] = None
    sort_order: Optional[int] = None
    note: Optional[str] = None
    sequence: Optional[str] = None  # 전역 태그명(Notion 시퀀스)
    description: Optional[str] = None


class TaskPatch(BaseModel):
    name: Optional[str] = None
    status: Optional[str] = None
    assignee_uid: Optional[str] = None
    start_date: Optional[str] = None
    due_date: Optional[str] = None
    sort_order: Optional[int] = None
    note: Optional[str] = None
    sequence: Optional[str] = None
    description: Optional[str] = None


class TaskLinkIn(BaseModel):
    gen_ids: list[str]


@router.get("/tasks")
def list_tasks(project_id: str, request: Request):
    _require_project_read(request, project_id)
    return repo_manage.list_tasks(project_id)


@router.post("/tasks", status_code=201)
def create_task(body: TaskIn, request: Request):
    _require_project_manage(request, body.project_id)
    name = (body.name or "").strip()
    if not name:
        raise HTTPException(status_code=400, detail="빈 작업 이름")
    data = body.model_dump()
    data.pop("project_id")
    data.pop("name")
    return repo_manage.create_task(body.project_id, name, **data)


@router.patch("/tasks/{tid}")
def patch_task(tid: str, body: TaskPatch, request: Request):
    _require_project_manage(request, _task_project_or_404(tid))
    fields = {k: v for k, v in body.model_dump().items() if v is not None}
    r = repo_manage.update_task(tid, fields)
    if not r:
        raise HTTPException(status_code=404, detail="없는 작업(또는 변경 필드 없음)")
    return r


@router.delete("/tasks/{tid}")
def remove_task(tid: str, request: Request):
    _require_project_manage(request, _task_project_or_404(tid))
    return {"ok": repo_manage.delete_task(tid)}


@router.post("/tasks/{tid}/generations")
def link_generations(tid: str, body: TaskLinkIn, request: Request):
    _require_project_manage(request, _task_project_or_404(tid))
    for gid in body.gen_ids:
        gen = repo.get_generation(gid)
        if gen:
            require_view_generation(request, gen)
    return {"linked": repo_manage.link_generations(tid, body.gen_ids)}


@router.delete("/tasks/{tid}/generations/{gen_id}")
def unlink_generation(tid: str, gen_id: str, request: Request):
    """컷(생성물) 연결 해제 — 드래그로 뺀 컷 제거."""
    _require_project_manage(request, _task_project_or_404(tid))
    return {"ok": repo_manage.unlink_generation(tid, gen_id)}


# ── 분석(시각화) ──────────────────────────────────────────────────────────────
@router.get("/timeseries")
def timeseries(request: Request, bucket: str = "day"):
    """일/주별 생성수·크레딧 추이(추이 차트용)."""
    _require_manage_read(request)
    return repo_manage.timeseries("week" if bucket == "week" else "day")


@router.get("/matrix")
def matrix(request: Request):
    """작업자 × 프로젝트 매트릭스(건수·크레딧)."""
    _require_manage_read(request)
    return repo_manage.matrix()

"""PM 대시보드(매니징먼트) 라우터 — 분리형 사이드카 모듈.

설계: PM_DASHBOARD_DESIGN.md. 요청 모델도 여기 인라인으로 둔다(공용 models.py 무수정 → 격리).
★main.py 는 CONTENT_HUB_MANAGE=1 일 때만 이 라우터를 등록한다 → 기본 off 면 엔드포인트
자체가 없어 운영 동작에 영향 0(올려도 꺼진 채, 플래그만 켜면 활성).
"""

from __future__ import annotations

import asyncio
import os
import shutil
import uuid
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, HTTPException, Query, Request
from pydantic import BaseModel, Field

from . import _proxy
from .. import rbac, repo
from ..config import AUTH_ENABLED, MEDIA_DIR
from ..deps import (
    account_actor_uid,
    account_global_roles,
    account_scope_uid,
    actor_id,
    project_roles_of,
    require_agent_account,
    require_global_cap,
    require_project_role,
    require_view_generation,
)
from ..repo import manage as repo_manage
from ..services import cli_bridge, media_cache, project_folders
from ..services.net_guard import BlockedURLError, assert_public_http_url, guarded_opener
from ..services.path_safety import safe_join

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


# ── 팀 매니징 텔레메트리(manage-T2) — 요청 모델 인라인(models.py 무수정 → 격리) ──────
class TelemetryFactIn(BaseModel):
    """작업자 로컬 생성물 1건의 매니징 메타(미디어·프롬프트 없음). 로컬이 만들어 서버로 push.
    account_email·creator_uid 는 서버가 인증 세션값으로 강제/검증한다(payload 값 불신)."""

    local_gen_id: str
    job_id: Optional[str] = None
    creator_uid: Optional[str] = None  # 서버가 세션 uid 와 대조(다르면 스킵)
    creator_name: Optional[str] = None
    project_id: Optional[str] = None
    project_name: Optional[str] = None
    folder_path: Optional[str] = None
    model: Optional[str] = None
    output_type: Optional[str] = None
    status: Optional[str] = None
    real_credits: Optional[float] = None
    est_credits: Optional[float] = None
    credit_source: Optional[str] = None
    elapsed_seconds: Optional[float] = None
    created_at: Optional[str] = None
    started_at: Optional[str] = None
    completed_at: Optional[str] = None
    sort_ts: Optional[float] = None
    is_final: bool = False
    is_shared: bool = False
    is_deleted: bool = False
    deleted_at: Optional[str] = None


class TelemetryPushIn(BaseModel):
    items: list[TelemetryFactIn] = Field(default_factory=list)


def _push_acc(request: Request) -> dict:
    """텔레메트리 push 신원. 공용 require_agent_account 로 단일화(신원 규칙 분산 방지)."""
    return require_agent_account(request)


@router.post("/telemetry/push")
def telemetry_push(body: TelemetryPushIn, request: Request):
    """작업자 로컬 → 팀 매니징 저장소(manage_hub.db) 메타 upsert. 순수 수신자(재프록시 안 함) —
    보낼 곳 결정은 클라이언트(로컬 드레이너)가 한다. 작성자=세션 신원으로 강제/검증."""
    acc = _push_acc(request)
    from ..manage_db import upsert_facts

    items = [it.model_dump() for it in body.items]
    n, skipped = upsert_facts(acc.get("email") or "local", acc.get("creator_uid"), items)
    # skipped = 서버가 반영 안 한 항목(미링크 전체·남의 것). 클라가 이것만 재시도로 남기고 나머지는 정리.
    return {"upserted": n, "skipped": skipped}


@router.get("/team-overview")
def team_overview(
    request: Request,
    date_from: Optional[str] = None,
    date_to: Optional[str] = None,
    project_id: Optional[str] = None,
    creator_uid: Optional[str] = None,
):
    """팀 전체 집계(합계+작업자별+프로젝트별+매트릭스). 집계는 서버 manage_hub.db 에 있으므로
    로컬 허브는 서버로 위임(프록시), 서버 본체는 로컬 manage_hub.db 를 읽는다. 권한=read_all(매니저)."""
    if _proxy.proxying():
        return _proxy.proxy_get("/api/manage/team-overview", request)
    _require_manage_read(request)
    from ..manage_db import team_overview as _ov

    return _ov(date_from, date_to, project_id, creator_uid)


@router.get("/team-timeseries")
def team_timeseries(
    request: Request,
    date_from: Optional[str] = None,
    date_to: Optional[str] = None,
    project_id: Optional[str] = None,
    creator_uid: Optional[str] = None,
    bucket: str = "day",
):
    """팀 전체 기간별 추이(일/주/월 버킷). 프록시/권한 규칙은 team-overview 와 동일."""
    if _proxy.proxying():
        return _proxy.proxy_get("/api/manage/team-timeseries", request)
    _require_manage_read(request)
    from ..manage_db import team_timeseries as _ts

    return {"buckets": _ts(date_from, date_to, project_id, creator_uid, bucket)}


# ── 서버 공유본 HF 삭제 검토(서버가 CLI 없이, 로컬이 검증 결과를 올린다) ──────────────
class HfCheckResult(BaseModel):
    gen_id: str
    job_id: str
    exists: bool  # 로컬 CLI 판정(True=존재, False=HF 삭제됨). None(확인불가)은 로컬이 안 보냄.


class HfMissingApplyIn(BaseModel):
    results: list[HfCheckResult] = Field(default_factory=list)


@router.get("/hf-missing-candidates")
def hf_missing_candidates(request: Request):
    """내 서버 공유본 중 job_id 있는 것(HF 삭제 검증 후보). 서버는 CLI 가 없으므로 목록만 주고,
    로컬 허브(원 작성자 CLI 보유)가 각 job_id 를 검증한다. 내 creator_uid 것만 반환(남의 잡 오판 방지).
    /api/manage/* 는 미들웨어가 로컬→서버로 프록시하므로, 이 핸들러는 서버에서 실행된다."""
    acc = _push_acc(request)
    uid = acc.get("creator_uid")
    if not uid:
        return {"candidates": []}
    return {
        "candidates": [
            {"gen_id": gid, "job_id": jid} for gid, jid in repo.gens_with_job_id(account_uid=uid)
        ]
    }


@router.post("/hf-missing-apply")
def hf_missing_apply(body: HfMissingApplyIn, request: Request):
    """로컬 CLI 검증 결과 반영 — exists=False(HF 삭제 확정)만 서버 휴지통으로. 작성자·job_id 를 서버가
    재검증해 남의 것/불일치는 건드리지 않는다. exists=True 면 흐림(hf_missing) 해제. 반환 {trashed}."""
    acc = _push_acc(request)
    my_uid = acc.get("creator_uid")
    if not my_uid:
        return {"trashed": 0}
    identities = repo.get_generation_identities_batch(
        [result.gen_id for result in body.results]
    )
    trashed = 0
    reappeared: list[tuple[str, bool]] = []
    for r in body.results:
        # ★재검증: 내 것이고 job_id 가 일치할 때만(로컬이 보낸 값을 그대로 믿지 않음).
        # get_generation 공개 dict 엔 job_id 가 없어 identity 를 직접 조회한다(코덱스).
        creator_uid, job_id = identities.get(r.gen_id, (None, None))
        if creator_uid != my_uid or (job_id or "") != r.job_id:
            continue
        if r.exists:
            reappeared.append((r.gen_id, False))  # 재등장 → 흐림 해제
        elif repo.delete_generation(r.gen_id):  # HF 삭제 확정 → 서버 휴지통(soft delete)
            trashed += 1
    repo.set_hf_missing_batch(reappeared)
    return {"trashed": trashed}


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


class ProjectFolderSelectionIn(BaseModel):
    selected_path: str = ""


@router.get("/project-folders")
def project_folder_links(request: Request):
    links = repo_manage.list_project_folders()  # 로컬 링크(selected_path·레거시 root)
    read_all = not AUTH_ENABLED or rbac.has_global_cap(account_global_roles(request), "read_all")
    if read_all:
        projects = repo.list_projects(include_archived=True).get("projects") or []
    else:
        uid = account_scope_uid(request)
        if not uid:
            return {"links": {}}
        projects = repo.list_projects(include_archived=True, member_uid=uid).get("projects") or []
    # 팀 공유 렌더 루트(project.render_root_path)를 병합 — 로컬 링크가 없어도 '연결됨'으로 노출해
    # 다른 PC(로컬 링크 없음)에서도 폴더가 보이게 한다. selected_path 는 로컬 것(개인) 유지.
    for p in projects:
        if not isinstance(p, dict):
            continue
        pid = p.get("id")
        shared = (p.get("render_root_path") or "").strip()
        if pid and shared:
            cur = links.get(pid) or {
                "project_id": pid, "root_path": "", "selected_path": "", "updated_at": None,
            }
            links[pid] = {**cur, "root_path": shared}  # 공유 루트 우선
    if read_all:
        return {"links": links}
    visible_ids = {p.get("id") for p in projects if isinstance(p, dict)}
    return {"links": {pid: link for pid, link in links.items() if pid in visible_ids}}


@router.get("/project-folders/{pid}")
def get_project_folder(pid: str, request: Request):
    _require_project_read(request, pid)
    return project_folders.project_folder_state(pid)


@router.put("/project-folders/{pid}")
def put_project_folder(pid: str, body: ProjectFolderIn, request: Request):
    _require_project_manage(request, pid)
    # 렌더 루트 경로는 팀 공유(서버 프로젝트 정의). selected_path(내가 보는 하위폴더)는 개인 로컬.
    # ★루트가 '실제로 바뀔 때만' 서버에 저장한다 — 하위폴더만 클릭(selected 변경)해도 프론트가 같은
    # root_path 를 함께 보내는데, 매번 서버 PATCH 를 쏘면 (1) 불필요한 쓰기 (2) create_project 없는
    # 매니저가 폴더 탐색만 해도 403 이 난다. 값이 같으면 서버를 건드리지 않는다.
    current_root = project_folders.effective_root_path(pid)
    root_changed = False
    if body.root_path is not None:
        new_root = body.root_path.strip()
        root_changed = new_root != current_root
        if root_changed:  # 루트가 실제 변경됨
            # 위임 모드: 공유 서버에 먼저 저장(실패 시 예외 전파 → 로컬 미변경으로 불일치 방지) → 로컬 미러.
            if _proxy.proxying():
                _proxy.proxy_json(
                    "PATCH", f"/api/projects/{pid}", body={"render_root_path": new_root}
                )
            repo.set_render_root(pid, new_root)  # 로컬 미러(즉시 반영) / 서버 본체면 이게 진실
    # root_path 를 생략한 구형 호출도 기존 루트를 지우지 않도록 보존한다.
    root_for_local = body.root_path if body.root_path is not None else current_root
    repo_manage.set_project_folder(pid, root_for_local, body.selected_path)
    if root_changed:
        project_folders.invalidate_project_folder(pid)
    return project_folders.project_folder_state(pid, fresh=root_changed)


@router.patch("/project-folders/{pid}/selection")
def patch_project_folder_selection(pid: str, body: ProjectFolderSelectionIn, request: Request):
    """개인 선택 경로만 저장한다. 디스크 트리를 읽거나 큰 트리 JSON을 되돌려주지 않는다."""
    _require_project_read(request, pid)
    root = project_folders.effective_root_path(pid)
    meta = repo_manage.set_project_folder(pid, root, body.selected_path)
    return {**meta, "root_path": root}


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
    start_date: Optional[str] = None
    due_date: Optional[str] = None
    sort_order: Optional[int] = None
    note: Optional[str] = None
    sequence: Optional[str] = None  # 전역 태그명(Notion 시퀀스)
    description: Optional[str] = None


class TaskPatch(BaseModel):
    # 담당(assignee)은 여기서 다루지 않는다 — 대시보드의 /tasks/{tid}/assignees 로 배정한다.
    name: Optional[str] = None
    status: Optional[str] = None
    start_date: Optional[str] = None
    due_date: Optional[str] = None
    sort_order: Optional[int] = None
    note: Optional[str] = None
    sequence: Optional[str] = None
    description: Optional[str] = None


class TaskLinkIn(BaseModel):
    gen_ids: list[str]


class TaskOrderItem(BaseModel):
    task_id: str
    sort_order: int


class TaskOrderBatchIn(BaseModel):
    # 신형 계약: 보드 전체 순서 스냅샷(ordered_task_ids — 위치가 곧 순서). delta(items)는
    # 대기 중 합침(latest-merge)과 조합 시 중간 드래그가 유실돼 전체 상태 전송으로 전환했다.
    # 구형 프론트 호환을 위해 items 도 계속 받는다(스냅샷이 있으면 우선).
    items: list[TaskOrderItem] = Field(default_factory=list)
    ordered_task_ids: Optional[list[str]] = None


class TaskIdsIn(BaseModel):
    task_ids: list[str] = Field(default_factory=list)


def _require_tasks_manage(
    task_ids: list[str], request: Request, *, reject_duplicates: bool = True, limit: int = 500
) -> list[str]:
    """배치 쓰기 전에 모든 작업 존재와 프로젝트별 manage 권한을 확인한다."""
    unique_ids = list(dict.fromkeys(task_ids))
    if reject_duplicates and len(unique_ids) != len(task_ids):
        raise HTTPException(status_code=400, detail="중복 작업 id가 있습니다")
    if len(unique_ids) > limit:
        raise HTTPException(status_code=400, detail=f"한 번에 최대 {limit}개 작업까지 변경할 수 있습니다")
    projects = repo_manage.task_projects(unique_ids)
    missing = [task_id for task_id in unique_ids if task_id not in projects]
    if missing:
        raise HTTPException(status_code=404, detail=f"없는 작업: {missing[0]}")
    for project_id in dict.fromkeys(projects.values()):
        _require_project_manage(request, project_id)
    return unique_ids


@router.get("/tasks")
def list_tasks(project_id: str, request: Request):
    _require_project_read(request, project_id)
    return repo_manage.list_tasks(project_id)


@router.get("/tasks-batch")
def list_tasks_batch(request: Request, project_id: list[str] = Query(default_factory=list)):
    """여러 프로젝트의 작업을 한 번에 반환 — WorkBoard 가 프로젝트 수만큼 GET /tasks 하던 fan-out 을
    1요청으로. ★GET(읽기)이라 mutation 알림을 유발하지 않는다(POST 였으면 폴링마다 라이브러리 reload).
    pid 별로 기존 read 게이트(_require_project_read)를 그대로 적용해 **접근 가능한 프로젝트만**
    {pid:[tasks]} 로 반환. 접근불가/없는 pid·내부오류는 생략 = 부분성공(기존 per-project catch 와 동일 의미)."""
    allowed: list[str] = []
    for pid in list(dict.fromkeys(project_id))[:500]:  # 중복제거·순서보존·소프트캡
        try:
            _require_project_read(request, pid)
            allowed.append(pid)
        except HTTPException:
            continue
    if not allowed:
        return {}
    try:
        return repo_manage.list_tasks_batch(allowed)
    except Exception:  # noqa: BLE001 — 구 데이터 한 프로젝트 오류에도 기존 부분성공 의미 유지
        out: dict[str, list] = {}
        for pid in allowed:
            try:
                out[pid] = repo_manage.list_tasks(pid)
            except Exception:  # noqa: BLE001
                continue
        return out


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
    pid = _task_project_or_404(tid)
    fields = body.model_dump(exclude_unset=True)
    # 배정된 작업자는 자기 배분 작업을 '진행'(상태·설명·메모)할 수 있다. 그 외 관리 필드는 PM 권한.
    actor = account_actor_uid(request) or actor_id(request)
    if fields and set(fields) <= {"status", "note", "description"} and repo_manage.is_assignee(tid, actor):
        _require_project_read(request, pid)
    else:
        _require_project_manage(request, pid)
    r = repo_manage.update_task(tid, fields)
    if not r:
        raise HTTPException(status_code=404, detail="없는 작업(또는 변경 필드 없음)")
    return r


@router.delete("/tasks/{tid}")
def remove_task(tid: str, request: Request):
    _require_project_manage(request, _task_project_or_404(tid))
    return {"ok": repo_manage.delete_task(tid)}


@router.patch("/tasks-batch/order")
def update_task_order_batch(body: TaskOrderBatchIn, request: Request):
    if body.ordered_task_ids is not None:
        # 전체 스냅샷 모드 — 리스트 위치로 순번(i*10)을 서버가 한 트랜잭션에 부여한다.
        # 보드 전체가 오므로 상한은 delta(500)보다 넉넉히 2000(권한 조회는 단일 IN 쿼리).
        ids = _require_tasks_manage(body.ordered_task_ids, request, limit=2000)
        count = repo_manage.bulk_update_task_orders(
            [(task_id, index * 10) for index, task_id in enumerate(ids)]
        )
        return {"ok": True, "count": count}
    task_ids = [item.task_id for item in body.items]
    _require_tasks_manage(task_ids, request)
    count = repo_manage.bulk_update_task_orders(
        [(item.task_id, item.sort_order) for item in body.items]
    )
    return {"ok": True, "count": count}


@router.post("/tasks-batch/delete")
def delete_tasks_batch(body: TaskIdsIn, request: Request):
    task_ids = _require_tasks_manage(body.task_ids, request)
    count = repo_manage.bulk_delete_tasks(task_ids)
    return {"ok": True, "count": count}


@router.post("/tasks/{tid}/generations")
def link_generations(tid: str, body: TaskLinkIn, request: Request):
    _require_project_manage(request, _task_project_or_404(tid))
    for gid in body.gen_ids:
        gen = repo.get_generation(gid)
        if gen:
            require_view_generation(request, gen)
    return {"linked": repo_manage.link_generations(tid, body.gen_ids)}


@router.post("/tasks/{tid}/assignees/{uid}")
def add_assignee(tid: str, uid: str, request: Request):
    """작업에 담당(배정) 추가 — PM 이 대시보드에서 작업자를 배정(=컷 분배). manage 권한."""
    pid = _task_project_or_404(tid)
    _require_project_manage(request, pid)
    repo_manage.add_assignment(tid, uid, actor_id(request))
    return {"ok": True}


@router.delete("/tasks/{tid}/assignees/{uid}")
def remove_assignee(tid: str, uid: str, request: Request):
    """작업 담당(배정)에서 특정 작업자 제거 — manage 권한."""
    pid = _task_project_or_404(tid)
    _require_project_manage(request, pid)
    return {"removed": repo_manage.remove_assignment(tid, uid)}


class BulkAssignItem(BaseModel):
    task_id: str
    assignee_uids: list[str] = Field(default_factory=list)


class BulkAssignIn(BaseModel):
    mode: str = "replace"  # replace | add | remove
    items: list[BulkAssignItem] = Field(default_factory=list)


@router.patch("/tasks/assignees/bulk")
def bulk_set_assignments(body: BulkAssignIn, request: Request):
    """여러 작업의 담당(배정)을 한 번에 설정 — 전부 PM(manage) 권한."""
    if body.mode not in ("replace", "add", "remove"):
        raise HTTPException(status_code=400, detail="mode 는 replace, add 또는 remove")
    # 상한 초과는 무음 절단([:500]) 대신 명시 거절 — 잘린 뒤쪽 작업의 배정이 조용히
    # 유실되는 것을 막는다. 프론트가 500 단위로 나눠 보낸다(batching.ts).
    if len(body.items) > 500:
        raise HTTPException(status_code=400, detail="한 번에 최대 500개 작업까지 배정할 수 있습니다")
    items = [item.model_dump() for item in body.items]
    if not items:
        return {"ok": True, "count": 0}
    actor = actor_id(request)
    # 방어적 상한 — 작업당 담당 20명.
    for it in items:
        it["assignee_uids"] = [u for u in (it.get("assignee_uids") or [])][:20]
    # task→project도 한 번에 조회한다. 예전에는 저장만 배치고 여기서 작업 수만큼 DB를 다시 열었다.
    # 같은 task를 여러 줄로 보낸 기존 입력 순서 의미는 유지하므로 이 경로만 중복을 허용한다.
    task_ids = [it["task_id"] for it in items]
    _require_tasks_manage(task_ids, request, reject_duplicates=False)
    n = repo_manage.bulk_set_assignments(items, body.mode, actor)
    return {"ok": True, "count": n}


@router.delete("/tasks/{tid}/generations/{gen_id}")
def unlink_generation(tid: str, gen_id: str, request: Request):
    """컷(생성물) 연결 해제 — 드래그로 뺀 컷 제거."""
    _require_project_manage(request, _task_project_or_404(tid))
    return {"ok": repo_manage.unlink_generation(tid, gen_id)}


# ── 완료본 렌더폴더 저장(Phase 3 + 위임 모드) ────────────────────────────────
# 역할 분리(코덱스 합의): 서버 = 저장 '대상 판정' 권위(팀원 최종본·folder_path·task done 은 서버
# DB 에만 있음) / 로컬 허브 = NAS 저장 권위(렌더 폴더는 이 PC 디스크). 위임 모드의 로컬 GET/POST
# 는 서버 targets 를 받아 로컬 디스크 판정(saved·render 연결)과 조합한다.


def _save_finals_targets_facts(project_id: str) -> list[dict]:
    """저장 대상 '사실'만 — render_path/saved 등 디스크 판정 절대 미포함(그건 저장하는 PC 의 몫).
    filename 은 원본 확장자가 필요해 여기(사실 보유측)서 계산한다."""
    out: list[dict] = []
    for f in repo_manage.finals_to_export(project_id):
        fp = f.get("folder_path")
        file_path = f.get("file_path")
        reason: Optional[str] = None
        filename = ""
        if not fp:
            reason = "폴더 경로 없음"
        elif not file_path:
            reason = "원본 파일 없음"
        else:
            filename = project_folders.export_filename(
                fp, f["gen_id"], file_path, f.get("media_type")
            )
        out.append(
            {
                "gen_id": f["gen_id"],
                "folder_path": fp,
                "media_type": f.get("media_type"),
                "filename": filename,
                "reason": reason,  # None=저장 가능(사실 측면), 값 있으면 불가 사유
            }
        )
    return out


@router.get("/save-finals/targets")
def save_finals_targets(project_id: str, request: Request):
    """위임 모드의 판정 권위 API — 로컬 허브가 프록시 미들웨어로 이 경로를 서버에 위임한다
    (_LOCAL_EXACT 는 /save-finals 본체만이라 하위 경로는 자동 프록시). 서버 DB 기준 사실만."""
    _require_project_read(request, project_id)
    return {"targets": _save_finals_targets_facts(project_id)}


@router.get("/save-finals/content/{gen_id}")
def save_finals_content(gen_id: str, request: Request):
    """저장 대상 1건의 원본 바이트 스트리밍(위임 다운로드용) — manage 권한 재검증 후
    '그 프로젝트의 저장 대상'인 생성물만. 서버 /media 파일 또는 원격(CDN) URL 만 중계하고
    임의 절대경로는 다루지 않는다(파일시스템 노출 금지)."""
    from fastapi.responses import FileResponse, StreamingResponse

    gen = repo.get_generation(gen_id)
    if not gen or not gen.get("project_id"):
        raise HTTPException(status_code=404, detail="없는 생성물(또는 프로젝트 미배정)")
    _require_project_manage(request, gen["project_id"])
    fin = next(
        (f for f in repo_manage.finals_to_export(gen["project_id"]) if f["gen_id"] == gen_id),
        None,
    )
    if not fin:
        raise HTTPException(status_code=404, detail="저장 대상이 아닙니다")
    file_path = fin.get("file_path") or ""
    if file_path.startswith("/media/"):
        src = safe_join(MEDIA_DIR, file_path.removeprefix("/media/"))
        if src is None or not src.exists():
            raise HTTPException(status_code=404, detail="서버에 원본이 없습니다")
        return FileResponse(src)
    if file_path.startswith(("http://", "https://")):
        import urllib.error
        import urllib.request

        try:
            # 발행 번들의 file_path 는 외부 입력이다. 문자열이 http(s)라는 이유만으로 신뢰하면
            # 프로젝트 관리자가 이 중계 API를 통해 127.0.0.1·사설망·클라우드 메타데이터를 읽는
            # SSRF 경로가 된다. 공용 미디어 캐시와 같은 공개 IP+리다이렉트 차단 규칙을 적용한다.
            assert_public_http_url(file_path)
            req = urllib.request.Request(
                file_path, headers={"User-Agent": "content-hub/0.1"}
            )
            upstream = guarded_opener().open(req, timeout=60)
        except BlockedURLError as e:
            raise HTTPException(status_code=400, detail=f"허용되지 않는 원본 URL: {e}")
        except (urllib.error.URLError, TimeoutError, OSError) as e:
            raise HTTPException(status_code=502, detail=f"원본(CDN) 조회 실패: {e}")

        def _iter():
            try:
                while True:
                    chunk = upstream.read(1024 * 1024)
                    if not chunk:
                        break
                    yield chunk
            finally:
                upstream.close()

        headers = {}
        cl = upstream.headers.get("Content-Length")
        if cl:
            headers["Content-Length"] = cl  # 로컬 허브가 크기 대조(불완전 다운로드 검출)에 쓴다
        media_type = upstream.headers.get("Content-Type") or "application/octet-stream"
        return StreamingResponse(_iter(), media_type=media_type, headers=headers)
    raise HTTPException(status_code=404, detail="원본 파일 없음")


def _save_finals_facts(project_id: str) -> tuple[list[dict], bool]:
    """저장 대상 사실 목록 — 위임 모드면 서버 targets(판정 권위), 아니면 로컬 DB.
    반환: (facts, server_outdated). 구서버(라우트 없음 404)는 0건으로 숨기지 않고 표식을 올린다."""
    if _proxy.proxying():
        try:
            r = _proxy.proxy_json(
                "GET", "/api/manage/save-finals/targets", params={"project_id": project_id}
            )
            return (r or {}).get("targets") or [], False
        except HTTPException as e:
            # 구서버 판별은 '라우트 없음'의 표준 본문("Not Found")만 — 프로젝트 404("없는 프로젝트"
            # 등 상세 사유)까지 구서버로 오인하면 진짜 오류가 "서버 업데이트 필요"로 가려진다(코덱스 P2).
            if e.status_code == 404 and str(e.detail).strip() == "Not Found":
                return [], True  # 구서버 — UI 가 "서버 업데이트 필요"로 표시(완료조건 ①)
            raise
    return _save_finals_targets_facts(project_id), False


@router.get("/save-finals")
def save_finals_status(project_id: str, request: Request):
    """저장 대상(최종본) 미리보기 + 저장 이력(대장). 읽기 전용 — 다운로드/복사 없음.
    targets: 사실(서버/로컬) + 이 PC 디스크 판정(saved·렌더 연결) 조합. history: 대장(파일 존재)."""
    _require_project_read(request, project_id)
    state = project_folders.render_root_state(project_id)
    render_path = state.get("render_path") or ""
    render = Path(render_path) if render_path else None
    facts, server_outdated = _save_finals_facts(project_id)
    targets: list[dict] = []
    for t in facts:
        reason = t.get("reason")
        filename = t.get("filename") or ""
        saved = False
        # 저장 불가 사유를 미리 알려 헛클릭 방지(POST 와 같은 판정 순서).
        if not reason:
            if render is None:
                reason = "렌더 폴더 미연결"
            else:
                dest = project_folders.safe_dest(render, t.get("folder_path") or "", filename)
                if dest is None:
                    reason = "경로 안전성 위반"
                else:
                    saved = bool(dest.exists())
        targets.append(
            {
                "gen_id": t["gen_id"],
                "folder_path": t.get("folder_path"),
                "filename": filename,
                "saved": saved,
                "reason": reason,  # None=저장 가능, 값 있으면 저장 불가 사유
            }
        )
    history = [
        {**e, "exists": Path(e["dest_path"]).exists()}
        for e in repo_manage.list_exports(project_id)
    ]
    return {
        "render_path": render_path,
        "error": state.get("error"),
        "server_outdated": server_outdated,
        "targets": targets,
        "history": history,
    }


@router.post("/save-finals")
async def save_finals(project_id: str, request: Request):
    """완료 작업의 최종본만 렌더 폴더 경로 구조 그대로 물리 저장(멱등).
    로컬 전용(_proxy 로컬 목록) — render_root 는 이 PC 의 디스크(Z:\\…).
    위임 모드: 대상은 서버 targets(판정 권위), 바이트는 content 스트림으로 받아 이 PC 가 저장."""
    _require_project_manage(request, project_id)
    state = project_folders.render_root_state(project_id)
    if state.get("error"):
        raise HTTPException(status_code=400, detail=state["error"])
    render_path = state.get("render_path")
    if not render_path:
        raise HTTPException(status_code=400, detail="렌더 폴더가 연결되지 않았습니다")
    render = Path(render_path)

    if _proxy.proxying():
        facts, server_outdated = _save_finals_facts(project_id)
        if server_outdated:
            raise HTTPException(
                status_code=400,
                detail="공유 서버 업데이트가 필요합니다(완료본 저장 API 없음) — 서버를 먼저 배포하세요",
            )
        saved, skipped = 0, 0
        errors: list[dict[str, str]] = []
        # 순차 처리 — NAS 대역폭·서버 부하를 한 줄로(동시 다운로드 폭주 방지).
        for t in facts:
            gen_id = t["gen_id"]
            try:
                if t.get("reason"):
                    errors.append({"gen_id": gen_id, "reason": t["reason"]})
                    continue
                dest = project_folders.safe_dest(
                    render, t.get("folder_path") or "", t.get("filename") or ""
                )
                if dest is None:
                    errors.append({"gen_id": gen_id, "reason": "경로 안전성 위반(트래버설)"})
                    continue
                if dest.exists():  # 멱등 — 이미 저장됨
                    repo_manage.record_export(gen_id, str(dest), project_id)
                    skipped += 1
                    continue
                dest.parent.mkdir(parents=True, exist_ok=True)
                # NAS '같은 폴더'에 .part 로 받고 원자 교체 — 로컬 경로와 동일 규율.
                tmp = dest.with_name(dest.name + f".{uuid.uuid4().hex}.part")
                try:
                    await asyncio.to_thread(
                        _proxy.stream_download,
                        f"/api/manage/save-finals/content/{gen_id}",
                        tmp,
                    )
                    os.replace(tmp, dest)
                except OSError:
                    try:
                        tmp.unlink(missing_ok=True)
                    except OSError:
                        pass
                    raise
                repo_manage.record_export(gen_id, str(dest), project_id)
                saved += 1
            except HTTPException as e:  # stream_download 의 상태별 사유를 그대로 노출
                errors.append({"gen_id": gen_id, "reason": str(e.detail)})
            except Exception as e:  # noqa: BLE001 — 파일 1건 실패 격리
                errors.append({"gen_id": gen_id, "reason": str(e)})
        return {"saved": saved, "skipped": skipped, "errors": errors}

    finals = repo_manage.finals_to_export(project_id)
    saved, skipped = 0, 0
    errors: list[dict[str, str]] = []
    for f in finals:
        gen_id = f["gen_id"]
        # 파일 1건 처리 전체를 격리 — 한 건 실패(경로/DB/OS)가 나머지 저장을 막지 않게(코덱스 #7).
        try:
            folder_path = f.get("folder_path")
            file_path = f.get("file_path")
            if not folder_path:
                errors.append({"gen_id": gen_id, "reason": "폴더 경로 없음(저장 위치 불명)"})
                continue
            if not file_path:
                errors.append({"gen_id": gen_id, "reason": "원본 파일 없음"})
                continue
            filename = project_folders.export_filename(folder_path, gen_id, file_path, f.get("media_type"))
            dest = project_folders.safe_dest(render, folder_path, filename)
            if dest is None:
                errors.append({"gen_id": gen_id, "reason": "경로 안전성 위반(트래버설)"})
                continue
            # 멱등: 목적지 파일이 이미 있으면 skip(사용자가 지웠으면 재복사 — 자기치유).
            if dest.exists():
                repo_manage.record_export(gen_id, str(dest), project_id)
                skipped += 1
                continue
            rel = await media_cache.cache_url(file_path)
            if not rel:
                errors.append({"gen_id": gen_id, "reason": "원본 다운로드 실패"})
                continue
            # 원본도 MEDIA_DIR 밖으로 나가지 못하게 검증(코덱스 #3 — /media/../.. 방어).
            src = safe_join(MEDIA_DIR, rel.removeprefix("/media/"))
            if src is None:
                errors.append({"gen_id": gen_id, "reason": "원본 경로 안전성 위반"})
                continue
            if not src.exists():
                errors.append({"gen_id": gen_id, "reason": "로컬 원본 없음"})
                continue
            dest.parent.mkdir(parents=True, exist_ok=True)
            # 원자적 저장(코덱스 #2) — 임시 .part 로 복사 후 교체. 복사 중 크래시/드라이브 끊김이
            # 나도 불완전 파일이 목적지에 남아 영구 skip 되는 일이 없다.
            # 임시명에 uuid — 동시 실행/재실행 시 같은 .part 를 두 요청이 다투지 않게.
            # 대용량·NAS 복사는 to_thread 로 오프로딩해 이벤트 루프(백엔드 응답성)를 막지 않는다.
            tmp = dest.with_name(dest.name + f".{uuid.uuid4().hex}.part")
            try:
                await asyncio.to_thread(shutil.copy2, src, tmp)
                os.replace(tmp, dest)
            except OSError:
                try:
                    tmp.unlink(missing_ok=True)
                except OSError:
                    pass
                raise
            repo_manage.record_export(gen_id, str(dest), project_id)
            saved += 1
        except Exception as e:  # noqa: BLE001 — 파일 1건 실패 격리(위 주석)
            errors.append({"gen_id": gen_id, "reason": str(e)})
    return {"saved": saved, "skipped": skipped, "errors": errors}


# ── 분석(시각화) ──────────────────────────────────────────────────────────────
@router.get("/timeseries")
def timeseries(
    request: Request,
    bucket: str = "day",
    project_id: str | None = None,
    creator_uid: str | None = None,
):
    """일/주별 생성수·크레딧 추이(추이 차트용). project_id/creator_uid 주면 그 범위만."""
    _require_manage_read(request)
    return repo_manage.timeseries(
        "week" if bucket == "week" else "day",
        project_id=project_id or None,
        creator_uid=creator_uid or None,
    )


@router.get("/matrix")
def matrix(request: Request):
    """작업자 × 프로젝트 매트릭스(건수·크레딧)."""
    _require_manage_read(request)
    return repo_manage.matrix()


@router.get("/breakdown")
def breakdown(request: Request, project_id: str):
    """프로젝트 세부 분석 — (folder_path × 작업자)별 생성/게시/완료/크레딧 플랫 행."""
    _require_manage_read(request)
    return repo_manage.breakdown(project_id)

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

from fastapi import APIRouter, HTTPException, Request
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
    require_global_cap,
    require_project_role,
    require_view_generation,
)
from ..repo import manage as repo_manage
from ..services import cli_bridge, media_cache, project_folders
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
    """텔레메트리 push 신원 — 인증 세션 계정. AUTH off 로컬 허브에선 내 신원으로 폴백
    (ingest._agent_acc 와 동일 계약). 반환 {email, creator_uid}."""
    acc = getattr(request.state, "account", None)
    if acc:
        return acc
    if not AUTH_ENABLED:
        return {"email": "local", "creator_uid": repo.get_my_uid()}
    raise HTTPException(status_code=401, detail="로그인이 필요합니다")


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
    trashed = 0
    for r in body.results:
        # ★재검증: 내 것이고 job_id 가 일치할 때만(로컬이 보낸 값을 그대로 믿지 않음).
        # get_generation 공개 dict 엔 job_id 가 없어 identity 를 직접 조회한다(코덱스).
        creator_uid, job_id = repo.get_generation_identity(r.gen_id)
        if creator_uid != my_uid or (job_id or "") != r.job_id:
            continue
        if r.exists:
            repo.set_hf_missing(r.gen_id, False)  # 재등장 → 흐림 해제
        elif repo.delete_generation(r.gen_id):  # HF 삭제 확정 → 서버 휴지통(soft delete)
            trashed += 1
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
    # exclude_unset: 보낸 필드만 반영 — 명시적 null(예: assignee_uid=null)로 담당 해제 가능.
    # (기존 'v is not None' 은 null 을 버려 담당 해제가 안 됐다.)
    fields = body.model_dump(exclude_unset=True)
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


@router.post("/tasks/{tid}/planned-creators/me")
def add_me_as_planned(tid: str, request: Request):
    """작업 예정 생성자에 '나' 추가(self-assign) — 내가 이 작업을 하겠다고 정한다.
    ★uid 는 서버가 account_actor_uid 로 계산(신원 위조 방지). 프로젝트 접근권만 있으면 가능."""
    pid = _task_project_or_404(tid)
    _require_project_read(request, pid)
    uid = account_actor_uid(request) or actor_id(request)
    repo_manage.add_planned_creator(tid, uid, uid)
    return {"ok": True, "uid": uid}


@router.delete("/tasks/{tid}/planned-creators/me")
def remove_me_from_planned(tid: str, request: Request):
    """작업 예정 생성자에서 '나' 제거."""
    pid = _task_project_or_404(tid)
    _require_project_read(request, pid)
    uid = account_actor_uid(request) or actor_id(request)
    return {"removed": repo_manage.remove_planned_creator(tid, uid)}


@router.post("/tasks/{tid}/planned-creators/{uid}")
def add_planned_creator(tid: str, uid: str, request: Request):
    """PM/관리가 다른 멤버를 예정 생성자로 지정. 남을 넣는 건 manage 권한 필요."""
    pid = _task_project_or_404(tid)
    _require_project_manage(request, pid)
    repo_manage.add_planned_creator(tid, uid, actor_id(request))
    return {"ok": True}


@router.delete("/tasks/{tid}/planned-creators/{uid}")
def remove_planned_creator(tid: str, uid: str, request: Request):
    """예정 생성자에서 특정 멤버 제거 — manage 권한."""
    pid = _task_project_or_404(tid)
    _require_project_manage(request, pid)
    return {"removed": repo_manage.remove_planned_creator(tid, uid)}


@router.delete("/tasks/{tid}/generations/{gen_id}")
def unlink_generation(tid: str, gen_id: str, request: Request):
    """컷(생성물) 연결 해제 — 드래그로 뺀 컷 제거."""
    _require_project_manage(request, _task_project_or_404(tid))
    return {"ok": repo_manage.unlink_generation(tid, gen_id)}


# ── 완료본 렌더폴더 저장(Phase 3) ─────────────────────────────────────────────
@router.get("/save-finals")
def save_finals_status(project_id: str, request: Request):
    """저장 대상(최종본) 미리보기 + 저장 이력(대장). 읽기 전용 — 다운로드/복사 없음.
    targets: 저장 대상 컷(이미 저장됐는지 saved 로 표시). history: 대장(파일 존재 exists)."""
    _require_project_read(request, project_id)
    state = project_folders.render_root_state(project_id)
    render_path = state.get("render_path") or ""
    render = Path(render_path) if render_path else None
    targets: list[dict] = []
    for f in repo_manage.finals_to_export(project_id):
        fp = f.get("folder_path")
        file_path = f.get("file_path")
        filename, saved, reason = "", False, None
        # 저장 불가 사유를 미리 알려 헛클릭 방지(POST 와 같은 판정 순서).
        if not fp:
            reason = "폴더 경로 없음"
        elif not file_path:
            reason = "원본 파일 없음"
        elif render is None:
            reason = "렌더 폴더 미연결"
        else:
            filename = project_folders.export_filename(fp, f["gen_id"], file_path, f.get("media_type"))
            dest = project_folders.safe_dest(render, fp, filename)
            if dest is None:
                reason = "경로 안전성 위반"
            else:
                saved = bool(dest.exists())
        targets.append(
            {
                "gen_id": f["gen_id"],
                "folder_path": fp,
                "filename": filename,
                "saved": saved,
                "reason": reason,  # None=저장 가능, 값 있으면 저장 불가 사유
            }
        )
    history = [
        {**e, "exists": Path(e["dest_path"]).exists()}
        for e in repo_manage.list_exports(project_id)
    ]
    return {"render_path": render_path, "error": state.get("error"), "targets": targets, "history": history}


@router.post("/save-finals")
async def save_finals(project_id: str, request: Request):
    """완료 작업의 최종본만 렌더 폴더 경로 구조 그대로 물리 저장(멱등).
    로컬 전용(_proxy 로컬 목록) — render_root 는 이 PC 의 디스크(Z:\\…)."""
    _require_project_manage(request, project_id)
    state = project_folders.render_root_state(project_id)
    if state.get("error"):
        raise HTTPException(status_code=400, detail=state["error"])
    render_path = state.get("render_path")
    if not render_path:
        raise HTTPException(status_code=400, detail="렌더 폴더가 연결되지 않았습니다")
    render = Path(render_path)

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
                repo_manage.record_export(gen_id, str(dest))
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
            repo_manage.record_export(gen_id, str(dest))
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

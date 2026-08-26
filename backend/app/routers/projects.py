"""프로젝트(작업 묶음) 라우터 — 로드맵 §0-4/§4-4.

프로젝트는 공유·이동의 단위. 생성·목록·이름변경·보관·삭제 + 결과물 귀속(assign).
로그인·등급 도입 전이므로 권한 검증은 아직 없다(식별 먼저, 차단은 나중).
"""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, Query, Request
from pydantic import BaseModel, Field

from . import _proxy
from .. import rbac, repo
from ..deps import (
    account_actor_uid,
    account_global_roles,
    account_scope_uid,
    actor_id,
    project_roles_of,
    require_global_cap,
    require_project_role,
)
from ..config import AUTH_ENABLED, MANAGE_ENABLED
from ..models import (
    AssignProjectIn,
    ProjectCreate,
    ProjectMemberOut,
    ProjectOut,
    ProjectRolesIn,
    ProjectsOut,
    ProjectUpdate,
    ReorderProjectsIn,
)
from ..services import asset_watcher
from ..services.event_journal import journal_audit_event
from ..services.telemetry_drain import drain_isolated_telemetry

router = APIRouter(prefix="/api/projects", tags=["projects"])


_PROJECT_READ_ROLES = (rbac.PROJECT_MANAGER, rbac.SUPERVISOR, rbac.CREATOR)


class FolderCountsBatchIn(BaseModel):
    project_ids: list[str] = Field(default_factory=list)
    tab: str = "my"


def _has_read_all(request: Request) -> bool:
    return (not AUTH_ENABLED) or rbac.has_global_cap(account_global_roles(request), "read_all")


def _require_project_read(request: Request, pid: str) -> None:
    require_project_role(request, pid, *_PROJECT_READ_ROLES, read_only=True)


def _require_assign_target(request: Request, pid: str | None) -> None:
    if not pid or _has_read_all(request):
        return
    _require_project_read(request, pid)


@router.get("", response_model=ProjectsOut)
def list_projects(
    request: Request,
    include_archived: bool = False,
    tab: str = "my",
    workspace_id: str | None = None,
):
    # 로컬 우선 하이브리드: 프로젝트 '정의'는 서버(팀 공유). 카운트 기준은 탭마다 다르다 —
    #  · 내 작업(my): 내 로컬 DB 기준(내 미분류·내 프로젝트 수). 서버 정의에 로컬 카운트를 덮어씀.
    #  · 팀 공유(team): 팀 공유물의 프로젝트 귀속은 서버에 있으므로 서버 카운트를 그대로 쓴다.
    if _proxy.proxying():
        data = _proxy.proxy_get("/api/projects", request)
        if isinstance(data, dict):
            repo.cache_projects(data.get("projects") or [])  # 정의 미러(assign 검증·project_name 해석)
            if tab != "team":  # 내 작업 탭만 로컬 카운트로 덮어씀
                counts = repo.local_project_counts()
                for p in data.get("projects") or []:
                    if isinstance(p, dict):
                        p["count"] = counts.get(p.get("id"), 0)
                data["unassigned"] = repo.local_unassigned_count()
        return data
    # 가시성(§5-3): 전역 read_all(admin·PM·PD)은 전체 프로젝트, 그 외(일반 멤버)는 배정된 것만.
    # AUTH off 면 enforcement 없이 전체(기존 동작).
    viewer_uid = account_scope_uid(request)  # 카운트(미분류·프로젝트 수)를 내 작업 기준으로
    read_all = _has_read_all(request)
    member_uid = None if read_all else (viewer_uid or "\x00")  # 신원 없으면 매칭 0 → 빈 목록
    if tab == "team":
        # 팀 공유 탭(서버 본체·단독 모두): 카운트 모집단 = '공유물'(EXISTS share) — 그리드와 동일.
        # 생성자(viewer) 스코프를 풀어 팀 전체 공유물을 센다(미분류·프로젝트별). 가시성만 멤버십 제한.
        # 예전엔 viewer 본인 작업물을 세 미분류·프로젝트 수가 화면의 공유물과 어긋났다.
        data = repo.list_projects(
            include_archived=include_archived, member_uid=member_uid,
            viewer_uid=None, shared_only=True,
            own_shared_uid=None if read_all else viewer_uid,
            workspace_id=workspace_id,
        )
        return data
    # 내 작업(my): 카운트는 항상 내 작업만(viewer 스코프).
    return repo.list_projects(
        include_archived=include_archived,
        member_uid=member_uid,
        viewer_uid=viewer_uid,
        workspace_id=workspace_id,
    )


@router.get("/my-finalize-roles")
def my_finalize_roles(request: Request):
    """내가 최종(골드) 지정 가능한 project_id 목록 — 그 프로젝트의 SUPERVISOR 인 것(PM 제외).
    전역 admin 은 ['*'](전체 가능). 프론트가 카드 더블클릭(최종) 활성 여부를 판단한다.
    AUTH off(전역 모드)면 ['*']."""
    if _proxy.proxying():  # 역할은 서버가 가짐
        return _proxy.proxy_get("/api/projects/my-finalize-roles", request)
    if not AUTH_ENABLED:
        return {"project_ids": ["*"]}
    uid = account_actor_uid(request)
    if not uid:
        return {"project_ids": []}
    # 전역 admin 은 모든 항목 골드 가능. 그 외에는 SUPERVISOR 인 프로젝트만(PM 은 생성·배치 역할).
    if rbac.has_any_global_role(account_global_roles(request), rbac.ADMIN):
        return {"project_ids": ["*"]}
    return {"project_ids": repo.projects_where_role(uid, [rbac.SUPERVISOR])}


@router.get("/workspace-options")
def workspace_options(request: Request):
    """에이전트 보고로 검증된 팀 워크스페이스 목록 — 프로젝트 생성/대시보드 공용."""
    if _proxy.proxying():
        return _proxy.proxy_get("/api/projects/workspace-options", request)
    require_global_cap(request, "create_project")
    return {"workspaces": repo.list_workspace_options()}


@router.get("/workspace-options/{workspace_id}/members")
def workspace_option_members(workspace_id: str, request: Request):
    """선택한 워크스페이스에 접근 가능한 프로젝트 배정 후보."""
    if _proxy.proxying():
        return _proxy.proxy_get(f"/api/projects/workspace-options/{workspace_id}/members", request)
    require_global_cap(request, "create_project")
    if not any(item["id"] == workspace_id for item in repo.list_workspace_options()):
        raise HTTPException(status_code=404, detail="확인되지 않은 워크스페이스")
    return {"members": repo.list_workspace_members(workspace_id)}


@router.get("/team-fresh")
def team_fresh(
    request: Request,
    since: str,
    cursor_shared_at: str | None = None,
    cursor_id: str | None = None,
    limit: int = Query(500, ge=1, le=500),
):
    """기준선(since, UTC "YYYY-MM-DD HH:MM:SS") 이후 공유된 항목의 {id, project_id, folder_path} 목록.
    사이드바 '+N'(신규 라임 배지)용 — 클라가 '내가 확인(클릭)한 항목'을 제외하고 정확히 센다.
    (서버 개수−확인 개수 '빼기' 방식은 확인 항목이 공유해제·삭제되면 차감이 남아 배지를 잡아먹는다.)
    가시성은 팀 목록(tab=team)과 동일 규약. 위임 모드는 서버로 프록시. 구버전 서버는 404 → 배지 숨김."""
    if _proxy.proxying():
        return _proxy.proxy_get("/api/projects/team-fresh", request)
    if (cursor_shared_at is None) != (cursor_id is None):
        raise HTTPException(status_code=400, detail="cursor_shared_at과 cursor_id를 함께 보내세요")
    read_all = (not AUTH_ENABLED) or rbac.has_global_cap(
        account_global_roles(request), "read_all"
    )
    team_member_projects = None
    actor_uid = None
    if not read_all:
        actor_uid = account_scope_uid(request)
        team_member_projects = repo.my_member_projects(actor_uid or "\x00")
    items = repo.team_fresh_items(
        since,
        team_member_projects=team_member_projects,
        actor_uid=actor_uid,
        limit=limit,
        cursor_shared_at=cursor_shared_at,
        cursor_id=cursor_id,
    )
    # 정확히 limit건이면 다음 요청이 한 번 더 갈 수 있지만, 데이터가 끝났다면 빈 페이지로 종료된다.
    # 별도 COUNT(*)를 매 페이지 실행하는 것보다 싸고 키셋이라 뒤 페이지도 일정한 비용이다.
    last = items[-1] if len(items) == limit else None
    return {
        "items": items,
        "next_cursor": (
            {"shared_at": last["shared_at"], "id": last["id"]} if last else None
        ),
    }


@router.get("/{pid}/folder-counts")
def project_folder_counts(pid: str, request: Request, tab: str = "my"):
    """프로젝트의 폴더별 생성물 개수 {counts: {folder_path: n}} — 사이드바 폴더 트리 뱃지·필터용.
    내 작업(my)은 내 생성물만, 팀(team)은 서버 위임(프록시)."""
    if _proxy.proxying() and tab == "team":
        return _proxy.proxy_get(f"/api/projects/{pid}/folder-counts", request)
    account_uid = account_scope_uid(request) if tab == "my" else None
    # 팀 탭은 목록(EXISTS share + 멤버십 가시성)과 동일하게 센다 — 서버가 이 경로로 집계(위 프록시가 위임).
    # read_all(admin/PM/PD·단독)은 전체 공유물, 아니면 내 공유물+내 멤버 프로젝트만(목록 규약과 동일).
    team_member_projects = None
    actor_uid = None
    if tab == "team":
        read_all = (not AUTH_ENABLED) or rbac.has_global_cap(
            account_global_roles(request), "read_all"
        )
        if not read_all:
            actor_uid = account_scope_uid(request)
            team_member_projects = repo.my_member_projects(actor_uid or "\x00")
    return {
        "counts": repo.folder_counts(
            pid,
            account_uid=account_uid,
            shared_only=(tab == "team"),
            team_member_projects=team_member_projects,
            actor_uid=actor_uid,
        )
    }


@router.post("/folder-counts/batch")
def project_folder_counts_batch(body: FolderCountsBatchIn, request: Request):
    """사이드바의 활성·고정 프로젝트 폴더 개수를 한 요청·한 SQL로 반환한다."""
    project_ids = list(dict.fromkeys(pid for pid in body.project_ids if pid))
    if len(project_ids) > 100:
        raise HTTPException(status_code=413, detail="프로젝트는 최대 100개까지 조회할 수 있습니다")
    tab = "team" if body.tab == "team" else "my"
    if _proxy.proxying() and tab == "team":
        return _proxy.proxy_json(
            "POST",
            "/api/projects/folder-counts/batch",
            body={"project_ids": project_ids, "tab": "team"},
        )
    account_uid = account_scope_uid(request) if tab == "my" else None
    team_member_projects = None
    actor_uid = None
    if tab == "team":
        read_all = (not AUTH_ENABLED) or rbac.has_global_cap(
            account_global_roles(request), "read_all"
        )
        if not read_all:
            actor_uid = account_scope_uid(request)
            team_member_projects = repo.my_member_projects(actor_uid or "\x00")
    return {
        "counts": repo.folder_counts_batch(
            project_ids,
            account_uid=account_uid,
            shared_only=(tab == "team"),
            team_member_projects=team_member_projects,
            actor_uid=actor_uid,
        )
    }


def _validated_project_workspace(workspace, *, explicit: bool) -> dict:
    """프로젝트에 지정하는 워크스페이스의 정책 검증(규격 규칙 8·10).

    - team: 등록부(workspace_registry)에 존재해야 하고, 이름은 등록부의 정식 이름으로
      교체해 저장한다(오래되거나 조작된 이름 저장 방지). 임의 UUID 저장 차단이 목적.
    - unknown: 명시적 전달(PATCH)이면 400 — 제거는 personal 로 보내야 한다. unknown 은
      동기화가 재보강할 수 있는 레거시 상태라 제거 용도로 쓰면 팀 귀속이 되살아난다.
      (create 의 기본값 unknown 은 "미지정" 의미라 explicit=False 로 허용.)
    """
    ctx = workspace.model_dump()
    if ctx.get("scope") == "unknown" and explicit:
        raise HTTPException(
            status_code=400,
            detail="워크스페이스 제거는 personal 로 보내세요 — unknown 으로는 지정할 수 없습니다",
        )
    if ctx.get("scope") == "team":
        entry = repo.get_registry_workspace(ctx.get("id") or "")
        if not entry:
            raise HTTPException(
                status_code=400,
                detail="등록부에 없는 워크스페이스입니다 — 에이전트 보고(동기화) 후 다시 시도하세요",
            )
        ctx["name"] = entry["name"]
    return ctx


@router.post("", response_model=ProjectOut)
def create_project(body: ProjectCreate, request: Request):
    # 프로젝트 정의는 팀 공유 → 서버에서 생성·관리(로컬 우선에서도 프로젝트는 서버 권위).
    if _proxy.proxying():
        return _proxy.proxy_json("POST", "/api/projects", body=body.model_dump())
    # 프로젝트 생성 = 전역 create_project 역량(product_manager). AUTH off 면 통과.
    require_global_cap(request, "create_project")
    try:
        created = repo.create_project(
            body.name,
            kind=body.kind,
            workspace=_validated_project_workspace(body.workspace, explicit=False),
        )
    except repo.ProjectNameConflictError as e:
        raise HTTPException(status_code=409, detail=str(e))
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    journal_audit_event(
        "project.created",
        actor_uid=actor_id(request),
        target_type="project",
        target_id=created.get("id"),
        project_id=created.get("id"),
        fields=["name", "kind", "workspace"],
        details={"kind": body.kind, "workspace_scope": created.get("workspace_scope")},
    )
    return created


@router.post("/reorder")
def reorder_projects(body: ReorderProjectsIn, request: Request):
    """관리자 탭에서 정한 프로젝트 표시 순서를 저장(create_project 역량 = product_manager/admin)."""
    if _proxy.proxying():
        return _proxy.proxy_json("POST", "/api/projects/reorder", body=body.model_dump())
    require_global_cap(request, "create_project")
    repo.reorder_projects(body.project_ids)
    journal_audit_event(
        "project.order_changed",
        actor_uid=actor_id(request),
        target_type="project_collection",
        fields=["sort_order"],
        details={"project_count": len(body.project_ids)},
    )
    return {"ok": True}


@router.patch("/{pid}", response_model=ProjectOut)
def update_project(pid: str, body: ProjectUpdate, request: Request):
    if _proxy.proxying():
        updated = _proxy.proxy_json("PATCH", f"/api/projects/{pid}", body=body.model_dump())
        if body.name is not None or body.archived is not None or body.render_root_path is not None:
            asset_watcher.unwatch(asset_watcher.auto_registration_id(pid))
        return updated
    require_global_cap(request, "create_project")  # 이름변경·보관도 생성/삭제와 같은 역량으로 게이트
    if not repo.get_project(pid):
        raise HTTPException(status_code=404, detail="없는 프로젝트")
    try:
        if body.name is not None or body.archived is not None:
            # 이름과 보관 상태를 함께 보낸 PATCH 는 최종 상태 기준으로 한 트랜잭션에서 판정한다.
            repo.update_project_identity(pid, name=body.name, archived=body.archived)
        if body.render_root_path is not None:
            repo.set_render_root(pid, body.render_root_path)  # 팀 공유 렌더 폴더 경로
        if body.workspace is not None:
            repo.set_project_workspace(pid, _validated_project_workspace(body.workspace, explicit=True))
    except repo.ProjectNameConflictError as e:
        raise HTTPException(status_code=409, detail=str(e))
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    updated = repo.get_project(pid)
    if body.name is not None or body.archived is not None or body.render_root_path is not None:
        # 성공한 이름·보관·루트 변경 뒤에만 끊는다. 실패한 PATCH가 정상 감시를 잃지 않게 하고,
        # 다음 Assets 조회가 새 경로와 라벨로 다시 등록하게 한다.
        asset_watcher.unwatch(asset_watcher.auto_registration_id(pid))
    changed_fields = list(body.model_dump(exclude_none=True).keys())
    journal_audit_event(
        "project.updated",
        actor_uid=actor_id(request),
        target_type="project",
        target_id=pid,
        project_id=pid,
        fields=changed_fields,
        details={
            "archived": body.archived,
            "workspace_scope": (updated or {}).get("workspace_scope"),
        },
    )
    return updated


@router.delete("/{pid}")
def delete_project(pid: str, request: Request):
    """프로젝트 삭제 — 귀속 결과물은 미분류로 되돌리고 프로젝트만 제거."""
    if _proxy.proxying():
        result = _proxy.proxy_json("DELETE", f"/api/projects/{pid}")
        asset_watcher.unwatch(asset_watcher.auto_registration_id(pid))
        return result
    require_global_cap(request, "create_project")  # 생성·삭제는 같은 역량(product_manager)
    removed = repo.delete_project(pid)
    if not removed:
        raise HTTPException(status_code=404, detail="없는 프로젝트")
    asset_watcher.unwatch(asset_watcher.auto_registration_id(pid))
    journal_audit_event(
        "project.deleted",
        actor_uid=actor_id(request),
        target_type="project",
        target_id=pid,
        project_id=pid,
        fields=["deleted"],
    )
    return {"ok": True}


@router.post("/assign")
def assign_project(body: AssignProjectIn, request: Request, tab: str = "my"):
    """결과물들을 프로젝트에 귀속(project_id=None 이면 미분류로 해제).
    탭 인지: 팀 공유(team) 탭의 항목은 서버에 사는 팀 공유물이라 서버에 위임해야 팀 전체에 반영되고
    팀 탭 카운트·필터가 맞는다. 내 작업(my)은 내 로컬 생성물의 project_id 를 바꾸는 로컬 작업."""
    if _proxy.proxying() and tab == "team":
        # 팀 귀속은 서버에 위임 — tab=team 을 그대로 넘겨 서버가 '공유물 조직' 모드로 처리하게 한다.
        return _proxy.proxy_json(
            "POST", "/api/projects/assign", params={"tab": "team"}, body=body.model_dump()
        )
    # 내 작업(로컬) 귀속 — 프로젝트 정의는 서버에 있으므로 검증 통과를 위해 먼저 미러(캐시).
    if _proxy.proxying() and body.project_id:
        try:
            data = _proxy.proxy_json("GET", "/api/projects")
            repo.cache_projects(data.get("projects") or [] if isinstance(data, dict) else [])
        except Exception:  # noqa: BLE001
            pass
    _require_assign_target(request, body.project_id)
    try:
        if tab == "team":
            # 팀 공유 탭 귀속(서버 본체): 공유물을 프로젝트로 조직하는 팀 작업이다. read_all(admin·PM·PD)
            # 은 생성자 무관하게 묶을 수 있게 스코프를 풀되, shared_only 로 '공유물'만 건드린다(남의
            # 사적 작업물은 불가). 일반 멤버는 기존대로 본인 공유물만.
            read_all = (not AUTH_ENABLED) or rbac.has_global_cap(
                account_global_roles(request), "read_all"
            )
            account_uid = None if read_all else account_scope_uid(request)
            n = repo.assign_to_project(
                body.generation_ids, body.project_id,
                account_uid=account_uid, shared_only=True,
                folder_path=body.folder_path,
            )
        else:
            # 내 작업: AUTH on 이면 내 생성물만 귀속(남의 작업물 이동 차단). 단독/AUTH off 는 None → 제약 없음.
            n = repo.assign_to_project(
                body.generation_ids, body.project_id,
                account_uid=account_scope_uid(request), folder_path=body.folder_path,
            )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    # 팀 매니징: 귀속(프로젝트·폴더)이 바뀐 내 생성물을 텔레메트리 dirty 표시 → 다음 drain 에 반영.
    if MANAGE_ENABLED and tab != "team":
        try:
            from ..repo import manage as _m

            _m.mark_telemetry_dirty(body.generation_ids)
            drain_isolated_telemetry()
        except Exception:  # noqa: BLE001
            pass
    # 이동 양방향 동기(#2 Phase3): 내 작업에서 옮긴 게 이미 공유된 것이면 서버에도 같은 이동을
    # 반영해 팀 공유 뷰가 안 어긋나게 한다. best-effort — 실패해도 로컬 이동은 유효(team_synced=False).
    team_synced: Optional[bool] = None
    if tab != "team" and _proxy.proxying():
        anchors = repo.shared_generation_anchors(body.generation_ids)
        if anchors:
            try:
                resp = _proxy.proxy_json(
                    "POST", "/api/projects/assign", params={"tab": "team"},
                    body={
                        "generation_ids": anchors,  # 서버 앵커(job_id) — 로컬 uuid 아님
                        "project_id": body.project_id,
                        "folder_path": body.folder_path,
                    },
                )
                # 서버가 실제로 매칭·반영했는지(updated>0)까지 확인해야 진짜 동기 성공.
                team_synced = ((resp or {}).get("updated") or 0) > 0
            except Exception:  # noqa: BLE001 — 서버 미연결·오프라인 시 로컬만 반영(추후 재동기 필요)
                team_synced = False
    return {"ok": True, "updated": n, "team_synced": team_synced}


# ── 프로젝트 멤버·역할 (v02 RBAC PART 1) ───────────────────────────────────
def _can_manage_members(request: Request, pid: str) -> bool:
    """멤버 역할 관리 권한 — 전역 grant_project_role(product_manager) 또는
    그 프로젝트의 manage_members(project_manager). AUTH off 면 항상 허용."""
    if not AUTH_ENABLED:
        return True
    if rbac.has_global_cap(account_global_roles(request), "grant_project_role"):
        return True
    return rbac.has_project_cap(project_roles_of(request, pid), "manage_members")


@router.get("/members-all", response_model=dict[str, list[ProjectMemberOut]])
def list_all_members(request: Request):
    """모든 프로젝트의 멤버를 한 번에 {pid: [...]} — 관리자 창이 1회로 prefetch."""
    if _proxy.proxying():
        return _proxy.proxy_get("/api/projects/members-all", request)
    require_global_cap(request, "read_all")
    return repo.list_all_project_members()


@router.get("/members-visible", response_model=dict[str, list[ProjectMemberOut]])
def list_visible_members(request: Request):
    """현재 사용자가 읽을 수 있는 프로젝트들의 멤버만 한 번에 반환한다."""
    if _proxy.proxying():
        return _proxy.proxy_get("/api/projects/members-visible", request)
    read_all = _has_read_all(request)
    member_uid = None if read_all else (account_scope_uid(request) or "\x00")
    visible = repo.list_projects(include_archived=False, member_uid=member_uid)
    project_ids = [
        project.get("id")
        for project in visible.get("projects") or []
        if isinstance(project, dict) and project.get("id")
    ]
    if not read_all:
        readable_ids = set(
            repo.projects_where_role(member_uid, list(_PROJECT_READ_ROLES))
        )
        project_ids = [pid for pid in project_ids if pid in readable_ids]
    return repo.list_project_members_for_projects(project_ids)


@router.get("/{pid}/members", response_model=list[ProjectMemberOut])
def list_members(pid: str, request: Request):
    """그 프로젝트의 멤버·역할 목록(역할 관리 UI 용)."""
    if _proxy.proxying():
        return _proxy.proxy_get(f"/api/projects/{pid}/members", request)
    if not repo.get_project(pid):
        raise HTTPException(status_code=404, detail="없는 프로젝트")
    _require_project_read(request, pid)
    return repo.list_project_members(pid)


@router.patch("/{pid}/members", response_model=list[ProjectMemberOut])
def set_member_roles(pid: str, body: ProjectRolesIn, request: Request):
    """그 프로젝트에 멤버를 추가하거나 역할(복수) 지정(project_manager/supervisor/editor).
    멤버 행이 없으면 만든다(부여=곧 추가). project_roles 빈 리스트면 역할만 비운 채 멤버 유지."""
    if _proxy.proxying():
        return _proxy.proxy_json("PATCH", f"/api/projects/{pid}/members", body=body.model_dump())
    if not repo.get_project(pid):
        raise HTTPException(status_code=404, detail="없는 프로젝트")
    if not _can_manage_members(request, pid):
        raise HTTPException(status_code=403, detail="멤버 역할을 관리할 권한이 없습니다")
    # 역할을 보냈는데 하나도 유효하지 않으면(구 역할명·오타) 400 — 조용히 '역할 없는 멤버'로
    # 저장되던 것을 막는다. 빈 리스트([])는 '역할만 비운 채 멤버 유지'라는 명시 의도라 통과.
    if body.project_roles and not rbac.parse_project_roles(body.project_roles):
        raise HTTPException(status_code=400, detail=f"알 수 없는 프로젝트 역할: {body.project_roles}")
    try:
        repo.set_project_roles(pid, body.creator_uid, body.project_roles)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    journal_audit_event(
        "project.member_roles_changed",
        actor_uid=actor_id(request),
        target_type="project_member",
        target_id=body.creator_uid,
        project_id=pid,
        fields=["project_roles"],
        details={"roles": body.project_roles},
    )
    return repo.list_project_members(pid)


@router.delete("/{pid}/members/{uid}", response_model=list[ProjectMemberOut])
def remove_member(pid: str, uid: str, request: Request):
    """프로젝트에서 멤버를 제거(project_member 행 삭제). 갱신된 멤버 목록 반환."""
    if _proxy.proxying():
        return _proxy.proxy_json("DELETE", f"/api/projects/{pid}/members/{uid}")
    if not repo.get_project(pid):
        raise HTTPException(status_code=404, detail="없는 프로젝트")
    if not _can_manage_members(request, pid):
        raise HTTPException(status_code=403, detail="멤버를 관리할 권한이 없습니다")
    repo.remove_project_member(pid, uid)
    journal_audit_event(
        "project.member_removed",
        actor_uid=actor_id(request),
        target_type="project_member",
        target_id=uid,
        project_id=pid,
        fields=["membership"],
    )
    return repo.list_project_members(pid)

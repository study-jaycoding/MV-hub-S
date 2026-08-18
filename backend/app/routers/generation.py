"""생성 메타데이터·재활용 라우터.

⚠️ 생성/재생성 '실행'은 더는 서버가 하지 않는다(push 모델 — project_content_hub_push_model).
   허브 버튼은 `POST /api/gen-requests`(routers/gen_requests.py)로 로컬 실행을 요청하고,
   요청자 PC의 에이전트가 자기 CLI로 실행한다. 이 라우터에 남은 CLI 호출은 **계정 무관
   공유 메타데이터**(모델 목록·params·비용)와 동기화·검증·워크스페이스 등 보조 기능뿐.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Any, Optional
from urllib.parse import quote

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel, Field

from . import _proxy, _telemetry
from .. import rbac, repo
from ..config import AUTH_ENABLED, DEFAULT_WORKER_ID
from ..deps import (
    account_global_roles,
    account_scope_uid,
    actor_id,
    require_edit_generation,
    require_view_generation,
)
from ..models import (
    AutoTagsIn,
    ColorIn,
    CommentIn,
    GenerationOut,
    HistoryEdgeIn,
    HistoryGraphOut,
    HistoryOut,
    ModelOut,
    SourceIn,
    TagsIn,
)
from ..services import cli_bridge, syncer
from ..services.media_preservation import preserve_generation_now
from ..services.telemetry_drain import drain_isolated_telemetry
from ..usecases import generation_personal_meta, hf_missing

logger = logging.getLogger(__name__)

# 구서버 단건 폴백의 순차 왕복 상한 — 이 수를 넘는 팀 카드 선택은 폴백에서 실패로 남긴다
# (서버 업데이트가 정식 경로. 폴백은 롤아웃 과도기 안전망일 뿐이다).
_LEGACY_FANOUT_LIMIT = 100

router = APIRouter(prefix="/api", tags=["generation"])


# ── 계정 무관 공유 메타데이터(서버 CLI 제공) — 모델 목록·params·비용. 모두에게 동일한
#    데이터라 서버의 힉스필드 CLI 가 대표로 제공한다(생성 '실행'과 달리 계정별 분리 불필요).
@router.get("/models", response_model=list[ModelOut])
async def list_models():
    """생성 모달용 모델 목록(CLI). 네트워크 호출이므로 명시적 엔드포인트."""
    try:
        return await cli_bridge.list_models()
    except cli_bridge.CLIError as e:
        raise HTTPException(status_code=502, detail=str(e))


@router.get("/models/{job_set_type}/params")
async def model_params(job_set_type: str):
    """모델의 CLI 조절 가능 파라미터 스키마(동적 옵션 렌더용)."""
    try:
        return await cli_bridge.get_model_params(job_set_type)
    except cli_bridge.CLIError as e:
        raise HTTPException(status_code=502, detail=str(e))


class CostIn(BaseModel):
    model: str
    prompt: str = ""
    params: dict[str, Any] = {}


@router.get("/account")
async def account_status():
    """계정 상태(연결·크레딧·이메일) — 하단 상태줄 클릭 시 수동 조회."""
    return await cli_bridge.get_account_status()


@router.get("/creators")
def list_creators(
    request: Request,
    tab: str = Query("my", pattern="^(my|team)$"),
    project_id: str | None = None,
):
    """생성자 목록 — project_id 가 오면 그 프로젝트 참여 인원(멤버), 아니면 My=본인/Team=공유물 작성자."""
    # 로컬 우선: team 생성자(공유물 작성자)는 서버에 있으므로 위임.
    if tab == "team" and _proxy.proxying():
        return _proxy.proxy_get("/api/creators", request)
    # ★스코프 가드: tab='my' 에서 account_uid 가 None 이면 list_creators 가 필터를 안 걸어 '전체
    # 생성자'(팀 전원 이름)를 노출한다. 미링크 AUTH-on 계정은 '\x00' 로 스코프해 빈 목록이 되게 한다.
    account_uid = account_scope_uid(request)
    team_member_projects = None
    if tab == "team":
        read_all = (not AUTH_ENABLED) or rbac.has_global_cap(
            account_global_roles(request), "read_all"
        )
        if not read_all:
            team_member_projects = repo.my_member_projects(account_uid or "\x00")
    return repo.list_creators(
        account_uid=account_uid,
        tab=tab,
        project_id=project_id,
        team_member_projects=team_member_projects,
    )


def _require_house(request: Request) -> None:
    """워크스페이스 전환은 서버 CLI(=하우스 계정) 전역 상태만 바꾼다 → 다른 사용자가 토글하면
    하우스 컨텍스트가 바뀐다. 그래서 로그인 계정의 creator_uid 가 서버 힉스필드(my_creator_uid)와
    같은 '하우스 계정'만 허용. AUTH off(account 없음)면 단독 모드라 통과."""
    acc = getattr(request.state, "account", None)
    if not acc:
        return
    if acc.get("creator_uid") and acc.get("creator_uid") == repo.get_my_uid():
        return
    raise HTTPException(
        status_code=403,
        detail="워크스페이스 전환은 서버에 연결된 힉스필드 계정(하우스)만 가능합니다.",
    )


async def _verify_workspace(expect_id: str | None) -> list[dict[str, Any]]:
    """set/unset 후 실제 컨텍스트가 의도대로 바뀌었는지 검증. expect_id=None=개인(아무것도 선택 안 됨)."""
    workspaces = await cli_bridge.list_workspaces()
    if expect_id is None:
        if any(w.get("is_selected") for w in workspaces):
            raise HTTPException(status_code=502, detail="워크스페이스 해제가 반영되지 않았습니다(CLI 상태 불일치).")
    else:
        sel = next((w for w in workspaces if w.get("id") == expect_id), None)
        if not sel or not sel.get("is_selected"):
            raise HTTPException(status_code=502, detail="워크스페이스 전환이 반영되지 않았습니다(CLI 상태 불일치).")
    return workspaces


@router.get("/workspaces")
async def list_workspaces():
    """워크스페이스 목록(개인/팀). is_selected 로 현재 컨텍스트 표시.
    ⚠️ 서버 CLI(하우스 계정) 기준 — 모든 로그인 사용자에게 같은 목록이 보인다."""
    return await cli_bridge.list_workspaces()


def _workspace_account_email(request: Request) -> str | None:
    """워크스페이스 접근 목록을 제한할 현재 계정 이메일."""
    account = getattr(request.state, "account", None)
    if account and account.get("email"):
        return str(account["email"])
    if _proxy.proxying():
        from ..active_account import active_email

        return active_email()
    return None


def _resolve_workspace_target(name: str, request: Request) -> dict[str, str]:
    """로컬 프록시는 로그인된 본 서버의 목록을, 그 외에는 현재 DB 등록부를 사용한다."""
    if _proxy.proxying():
        result = _proxy.proxy_json(
            "GET", f"/api/workspaces/resolve?name={quote(name, safe='')}", timeout=15
        )
        if not isinstance(result, dict) or not result.get("id") or not result.get("name"):
            raise HTTPException(status_code=502, detail="서버의 워크스페이스 확인 응답이 올바르지 않습니다")
        return {"id": str(result["id"]), "name": str(result["name"])}
    try:
        return repo.resolve_workspace_name(
            name,
            account_email=_workspace_account_email(request),
        )
    except repo.WorkspaceNameNotFound as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    except repo.WorkspaceNameAmbiguous as exc:
        raise HTTPException(status_code=409, detail=str(exc))


@router.get("/workspaces/available")
def available_workspaces(request: Request):
    """현재 계정이 카드 귀속 명령에 사용할 수 있는 등록 워크스페이스 목록."""
    if _proxy.proxying():
        return _proxy.proxy_get("/api/workspaces/available", request)
    account_email = _workspace_account_email(request)
    rows = (
        repo.list_workspace_registry(account_email, available_only=True)
        if account_email
        else repo.list_workspace_options()
    )
    workspaces: list[dict[str, str]] = []
    seen: set[str] = set()
    for row in rows:
        workspace_id = str(row.get("id") or "").strip()
        workspace_name = str(row.get("name") or "").strip()
        if not workspace_id or not workspace_name or workspace_id in seen:
            continue
        seen.add(workspace_id)
        workspaces.append({"id": workspace_id, "name": workspace_name})
    return {"workspaces": workspaces}


@router.get("/workspaces/resolve")
def resolve_workspace_by_name(
    request: Request,
    name: str = Query(..., min_length=1, max_length=200),
):
    """입력한 표시명이 현재 계정이 접근 가능한 실제 팀 워크스페이스인지 확인한다."""
    return _resolve_workspace_target(name, request)


class WorkspaceSelectIn(BaseModel):
    workspace_id: str


@router.post("/workspaces/select")
async def select_workspace(body: WorkspaceSelectIn, request: Request):
    """워크스페이스 선택(팀 공유 UUID 공간으로 전환) 후 검증·재동기화. 하우스 계정만."""
    _require_house(request)
    try:
        await cli_bridge.set_workspace(body.workspace_id)
    except cli_bridge.CLIError as e:
        raise HTTPException(status_code=502, detail=f"워크스페이스 전환 실패: {e}")
    workspaces = await _verify_workspace(body.workspace_id)  # 반영 확인(불일치면 502)
    counts = await syncer.sync_now()  # 새 컨텍스트의 잡을 즉시 반영
    if counts.get("telemetry_pending") or counts.get("telemetry_dirty"):
        _telemetry.schedule_telemetry_drain()
    return {"workspaces": workspaces, "sync": counts}


@router.post("/workspaces/unselect")
async def unselect_workspace(request: Request):
    """워크스페이스 해제 → 개인 계정 컨텍스트 복귀 후 검증·재동기화. 하우스 계정만."""
    _require_house(request)
    try:
        await cli_bridge.unset_workspace()
    except cli_bridge.CLIError as e:
        raise HTTPException(status_code=502, detail=f"워크스페이스 해제 실패: {e}")
    workspaces = await _verify_workspace(None)
    counts = await syncer.sync_now()
    if counts.get("telemetry_pending") or counts.get("telemetry_dirty"):
        _telemetry.schedule_telemetry_drain()
    return {"workspaces": workspaces, "sync": counts}


@router.post("/cost")
async def estimate_cost(body: CostIn):
    """예상 크레딧 추정(잡 생성 안 함). Generate 버튼에 표시."""
    try:
        return await cli_bridge.estimate_cost(body.model, body.params, body.prompt)
    except cli_bridge.CLIError as e:
        raise HTTPException(status_code=502, detail=str(e))


def _viewer_scope(request: Request) -> tuple[str | None, bool]:
    """(viewer_uid, read_all) — 계보 관련 노드 가시성 판정용.
    read_all = 단독 모드(AUTH off) 또는 전역 read_all(admin/PM/PD) 보유."""
    acc = getattr(request.state, "account", None)
    viewer_uid = acc.get("creator_uid") if acc else None
    read_all = (not AUTH_ENABLED) or rbac.has_global_cap(
        account_global_roles(request), "read_all"
    )
    return viewer_uid, read_all


# 생성물 id 참조(gen_id) 를 한 번만 해석해 라우트에 주입하는 dependency. 팀 탭 카드·동기화 항목은
# focusId 가 서버 job_id 라 get_generation(id 전용)으론 못 찾으므로, resolve_and_get 으로 id·job_id 둘 다
# 해석한다. ★dependency 는 'id 해석'만 — '로컬 처리냐 서버 위임이냐'는 각 라우트가 계속 결정한다.
@dataclass(frozen=True)
class ResolvedGen:
    requested_id: str  # 원 요청 id(로컬 id 또는 서버 job_id)
    gen: Optional[dict[str, Any]]  # 직렬화된 generation(로컬에 없으면 None)
    local_id: Optional[str]  # 로컬 generation.id(남의 팀 카드면 None)
    server_id: str  # 서버 앵커(job_id; 없으면 로컬 id; 행 자체가 없으면 requested_id)


def resolve_gen_ref(gen_id: str) -> ResolvedGen:
    gen, local_id, server_id = repo.resolve_and_get(gen_id)
    return ResolvedGen(gen_id, gen, local_id, server_id)


@router.get("/generations/{gen_id}/history", response_model=HistoryOut)
def get_history(request: Request, ref: ResolvedGen = Depends(resolve_gen_ref)):
    """한 결과물의 가계(재료⬆/파생⬇/사용처/약한형제) — 카드 히스토리 뱃지 클릭 시 패널 표시용."""
    if not ref.gen:
        if _proxy.proxying():  # 로컬에 없으면 팀(서버) 항목 → 서버 가계 위임
            return _proxy.proxy_get(f"/api/generations/{ref.server_id}/history", request)
        raise HTTPException(status_code=404, detail="generation 없음")
    require_view_generation(request, ref.gen)  # GET /{id} 와 동일 가시성(비공개는 본인/공유만)
    viewer_uid, read_all = _viewer_scope(request)
    data = repo.get_history(ref.local_id, viewer_uid=viewer_uid, read_all=read_all)
    if not data:
        raise HTTPException(status_code=404, detail="generation 없음")
    return data


@router.get("/generations/{gen_id}/metrics")
def gen_metrics(request: Request, ref: ResolvedGen = Depends(resolve_gen_ref)):
    """생성물의 실제 크레딧·소요시간(정보 팝업용). 로컬에 없으면 팀(서버) 항목이라 위임한다."""
    if not ref.gen:
        if _proxy.proxying():
            return _proxy.proxy_get(f"/api/generations/{ref.server_id}/metrics", request)
        return {}
    require_view_generation(request, ref.gen)  # GET /{id} 와 동일 가시성
    return repo.get_generation_metrics(ref.local_id) or {}


@router.get("/generations/{gen_id}/history-tree", response_model=HistoryGraphOut)
def get_history_tree(request: Request, ref: ResolvedGen = Depends(resolve_gen_ref)):
    """연결된 가계 전체 그래프(노드+엣지+루트) — 구성탭 히스토리 트리 렌더용."""
    if not ref.gen:
        if _proxy.proxying():
            return _proxy.proxy_get(f"/api/generations/{ref.server_id}/history-tree", request)
        raise HTTPException(status_code=404, detail="generation 없음")
    require_view_generation(request, ref.gen)
    viewer_uid, read_all = _viewer_scope(request)
    data = repo.get_history_graph(ref.local_id, viewer_uid=viewer_uid, read_all=read_all)
    if not data:
        raise HTTPException(status_code=404, detail="generation 없음")
    return data


@router.post("/generations/{gen_id}/history", response_model=HistoryOut, status_code=201)
def add_history(body: HistoryEdgeIn, request: Request, ref: ResolvedGen = Depends(resolve_gen_ref)):
    """수동 히스토리 연결 — 이 결과물의 부모를 손으로 지정(동기화 잡 등). 갱신된 가계 반환."""
    if not ref.gen:
        raise HTTPException(status_code=404, detail="generation 없음")
    require_edit_generation(request, ref.gen)  # 히스토리 수정은 본인/admin 만
    try:
        repo.add_history_edge(body.parent_gen_id, ref.local_id, body.relation)
    except ValueError as e:
        raise HTTPException(status_code=409, detail=str(e))
    return repo.get_history(ref.local_id)


@router.delete("/generations/{gen_id}/history/{parent_gen_id}", response_model=HistoryOut)
def remove_history(parent_gen_id: str, request: Request, ref: ResolvedGen = Depends(resolve_gen_ref)):
    """히스토리 엣지 해제 — 이 결과물과 그 부모의 연결을 푼다. 갱신된 가계 반환."""
    if not ref.gen:
        raise HTTPException(status_code=404, detail="generation 없음")
    require_edit_generation(request, ref.gen)  # 히스토리 수정은 본인/admin 만
    repo.remove_history_edge(parent_gen_id, ref.local_id)
    return repo.get_history(ref.local_id)


class DeriveFromIn(BaseModel):
    parent_ids: list[str]


@router.post("/generations/{gen_id}/derive-from", response_model=HistoryOut)
def derive_from(body: DeriveFromIn, request: Request, ref: ResolvedGen = Depends(resolve_gen_ref)):
    """생성 직후 파생 부모(들)를 'derived' 엣지로 일괄 기록 — **전이 축소** 적용.
    후보 중 다른 후보(또는 child)의 조상인 것은 잉여(자손을 거쳐 도달)라 빼고 가장 가까운 부모만 남긴다.
    (드래그 부모 + 보드 포커스/선택이 합쳐져 들어와도 원본→중간→자식 체인이 평탄해지지 않게 한다.)"""
    if not ref.gen:
        raise HTTPException(status_code=404, detail="generation 없음")
    require_edit_generation(request, ref.gen)  # 본인/admin 만 — 계보 기록도 수정 가드와 동일
    repo.record_derived_parents(ref.local_id, body.parent_ids)
    viewer_uid, read_all = _viewer_scope(request)
    return repo.get_history(ref.local_id, viewer_uid=viewer_uid, read_all=read_all)


def _resolve_local_or_reclaim(gen_id, request: Request):
    """(gen, local_id, server_id) — 로컬 우선, 프록시 팀 카드(서버 UUID)는 서버에서 job_id 로 되찾기.

    Phase 0b 이후 팀 탭 카드 id = 서버 UUID(≠ 로컬 id ≠ job_id)라 resolve_and_get 의 'id/job_id'
    로컬 매칭이 실패한다. 이때 프록시 모드면 서버 단건을 조회해 그 카드의 job_id 를 얻고, 그 job_id 로
    로컬 행을 되찾는다([share.py] _local_id_from_out 과 동형). color/tags 처럼 '로컬이 진실'인 개인메타를
    팀 탭에서 편집할 때 404 를 없앤다. 내 로컬 행이 아니면(남의 카드) 그대로 (None, None, gen_id)."""
    gen, local_id, server_id = repo.resolve_and_get(gen_id)
    if gen or not _proxy.proxying():
        return gen, local_id, server_id
    try:
        srv = _proxy.proxy_get(f"/api/generations/{gen_id}", request)
    except HTTPException as e:
        if e.status_code == 404:
            return gen, local_id, server_id  # 서버에도 없음 → 원래 결과(404 유발) 유지
        raise  # 서버 다운·권한·만료(502/403/401)는 그대로 전파(오해 소지 404 로 뭉개지 않음)
    job_id = srv.get("job_id") if isinstance(srv, dict) else None
    if job_id:
        return repo.resolve_and_get(job_id)  # 서버 앵커로 로컬 행 재해석
    return gen, local_id, server_id


def _set_meta(gen_id, request, apply, *, mirror_suffix: str | None = None, mirror_body=None):
    """color/tags/source/comment 개인메타 setter 공통 셰이프.

    팀 탭 카드는 서버 job_id 로 표시되므로 resolve_and_get 으로 한 번에 로컬 행을 해석(단일 커넥션)
    → 404/권한 → 로컬 적용 → (지정 시) 공유본이면 서버에도 미러.

    ★ 미러는 '팀이 보는' 공유 필드(source/comment)만 한다. color/tags 는 작성자 전용(마스킹 대상)이라
    서버에 두지 않고 로컬 전용으로 두며, 팀 탭에는 허브가 오버레이(library._overlay_personal_meta)로
    합친다 — 개인 메타를 공유 컬럼에 미러하던 dual-storage 불일치(미러 실패·낙관 레이스)를 원천 제거."""
    gen, local_id, server_id = _resolve_local_or_reclaim(gen_id, request)
    if not gen:
        raise HTTPException(status_code=404, detail="generation 없음")
    require_edit_generation(request, gen)  # 본인/admin 만 수정
    # 공유 필드(source/comment)는 팀이 보는 값이라 서버가 진실 → 서버 먼저. 실패(권한 403·서버 502
    # 등)면 로컬도 안 바꿔 "로컬만 바뀌고 팀엔 옛값"인 무음 불일치를 막는다(unpublish 와 동형).
    # 404(서버에 아직 항목 없음)는 목표상 무해 → 삼키고 로컬 적용(로컬이 유일 보관처).
    if mirror_suffix and _proxy.proxying() and gen.get("shared"):
        try:
            _proxy.proxy_json("PUT", f"/api/generations/{server_id}/{mirror_suffix}", body=mirror_body)
        except HTTPException as e:
            if e.status_code != 404:
                raise
    apply(local_id)
    return repo.get_generation(local_id)


@router.put("/generations/{gen_id}/tags", response_model=GenerationOut)
def set_tags(gen_id: str, body: TagsIn, request: Request):
    """태그 — 내 카드=gen_tag / 남의 팀 카드=로컬 shadow(gen_tag_overlay). 색과 동형, 서버 미러 없음."""
    return _set_personal_shadow(
        gen_id, request,
        local_apply=lambda i: repo.set_tags(i, body.tags),
        shadow_apply=lambda a: repo.set_tags_overlay(a, body.tags),
        result_key="tags", result_value=body.tags,
    )


@router.put("/generations/{gen_id}/auto-tags", response_model=GenerationOut)
def set_gen_auto_tags(gen_id: str, body: AutoTagsIn, request: Request):
    # 전역(auto) 태그를 카드에 부여/해제 — 일반태그와 동형(개인 전용, 미러 안 함).
    # repo 가 작성자 소유의 '기존' 전역 태그만 부여(신규 생성은 사이드바 전용).
    return _set_meta(gen_id, request, lambda i: repo.set_gen_auto_tags(i, body.auto_tags))


class GenerationTagsBatchItem(BaseModel):
    id: str
    tags: list[str] = Field(default_factory=list)


class GenerationTagsBatchIn(BaseModel):
    items: list[GenerationTagsBatchItem] = Field(default_factory=list)
    auto: bool = False


class GenerationWorkspaceBatchIn(BaseModel):
    generation_ids: list[str] = Field(min_length=1, max_length=500)
    operation: str = Field(pattern="^(assign|remove)$")
    workspace_name: str = Field(min_length=1, max_length=200)


def _workspace_assignment_error(exc: repo.WorkspaceAssignmentError) -> HTTPException:
    if isinstance(exc, repo.WorkspaceGenerationNotFound):
        return HTTPException(status_code=404, detail=str(exc))
    if isinstance(exc, repo.WorkspaceOwnershipError):
        return HTTPException(status_code=403, detail=str(exc))
    return HTTPException(status_code=409, detail=str(exc))


@router.put("/generations/workspace/batch")
def set_generation_workspace_batch(body: GenerationWorkspaceBatchIn, request: Request):
    """선택한 내 카드의 현재 워크스페이스 귀속을 이름 명령으로 일괄 변경한다.

    일반/전역 태그 테이블은 건드리지 않는다. 공유본은 팀 서버를 먼저 갱신하고, 실패하면
    로컬 변경을 시작하지 않아 양쪽에 서로 다른 귀속이 남는 경우를 최소화한다.
    """
    workspace = _resolve_workspace_target(body.workspace_name, request)
    owner_uid = _my_uid(request)
    if _proxy.proxying() and not owner_uid:
        raise HTTPException(
            status_code=409,
            detail="로그인 계정의 생성자 정보를 확인한 뒤 다시 시도하세요",
        )
    try:
        preview = repo.plan_generation_workspace_batch(
            body.generation_ids,
            body.operation,
            workspace,
            owner_uid=owner_uid,
        )
    except repo.WorkspaceAssignmentError as exc:
        raise _workspace_assignment_error(exc)

    # 공유된 내 카드는 팀 탭의 서버 복사본도 같은 값이어야 한다. 변경 여부와 관계없이 선택된
    # 공유본 전부를 보내 재시도만으로 불일치가 수렴하게 한다(서버 연산은 멱등).
    shared_server_ids: list[str] = []
    if _proxy.proxying():
        for row in preview["resolved"]:
            if row.get("shared"):
                _local_id, server_id = repo.finalize_id_map(str(row["id"]))
                if server_id and server_id not in shared_server_ids:
                    shared_server_ids.append(server_id)
        if shared_server_ids:
            remote = _proxy.proxy_json(
                "PUT",
                "/api/generations/workspace/batch",
                body={
                    "generation_ids": shared_server_ids,
                    "operation": body.operation,
                    "workspace_name": workspace["name"],
                },
                timeout=30,
            )
            remote_workspace = remote.get("workspace") if isinstance(remote, dict) else None
            if not isinstance(remote_workspace, dict) or remote_workspace.get("id") != workspace["id"]:
                raise HTTPException(
                    status_code=409,
                    detail="로컬과 서버의 워크스페이스 정보가 일치하지 않습니다. 계정 상태를 새로고침하세요",
                )

    try:
        result = repo.set_generation_workspace_batch(
            body.generation_ids,
            body.operation,
            workspace,
            owner_uid=owner_uid,
        )
    except repo.WorkspaceAssignmentError as exc:
        logger.error(
            "워크스페이스 원격 검증 뒤 로컬 재검증 실패: operation=%s workspace=%s error=%s",
            body.operation,
            workspace["id"],
            exc,
        )
        raise _workspace_assignment_error(exc)

    # 격리 test_dev에서는 운영 서버 대신 로컬 manage_hub.db까지 같은 요청에서 갱신한다.
    # 실패해도 workspace 변경은 완료되며 outbox가 남아 다음 대시보드 조회에서 재시도된다.
    try:
        drain_isolated_telemetry()
    except Exception:  # noqa: BLE001
        pass

    updates = []
    for row in result["resolved"]:
        generation = repo.get_generation(str(row["id"]))
        if generation:
            updates.append(
                {"requested_id": str(row["requested_id"]), "generation": generation}
            )
    return {
        "workspace": workspace,
        "operation": body.operation,
        "changed": [str(row["requested_id"]) for row in result["changed"]],
        "unchanged": [str(row["requested_id"]) for row in result["unchanged"]],
        "updates": updates,
    }


def _batch_meta_callbacks(request: Request):
    """FastAPI 권한·프록시 예외를 usecase가 소비할 수 있는 값 콜백으로 변환한다."""
    def can_edit(ref: dict[str, Any]) -> bool:
        try:
            require_edit_generation(request, ref)
            return True
        except HTTPException:
            return False

    def _fetch_server_cards_fanout(gen_ids: list[str]) -> dict[str, dict[str, Any]]:
        """구서버(배치 라우트 없음) 폴백 — 단건 조회 fan-out. 서버 GET /generations/{id} 는
        id_resolve 로 job_id 앵커도 해석하므로 배치와 같은 키로 카드를 되찾는다.
        대량 선택의 순차 왕복 폭주를 막기 위해 상한을 두고, 초과분은 실패로 남긴다."""
        cards: dict[str, dict[str, Any]] = {}
        limited = gen_ids[:_LEGACY_FANOUT_LIMIT]
        if len(gen_ids) > len(limited):
            logger.warning(
                "구서버 단건 폴백 상한 초과 — %d개 중 %d개만 조회(나머지는 실패 처리)",
                len(gen_ids),
                len(limited),
            )
        for gen_id in limited:
            try:
                card = _proxy.proxy_json(
                    "GET", f"/api/generations/{quote(gen_id, safe='')}", timeout=15
                )
            except HTTPException as exc:
                # 개별 404(서버에 없음)·403(열람권한 없음)은 그 항목만 실패로 남긴다.
                if exc.status_code in (404, 403):
                    continue
                raise
            if isinstance(card, dict):
                cards[gen_id] = card
        return cards

    def fetch_server_cards(gen_ids: list[str]) -> dict[str, dict[str, Any]]:
        if not gen_ids:
            return {}
        try:
            result = _proxy.proxy_json(
                "POST",
                "/api/generations/batch",
                body={"gen_ids": gen_ids},
                timeout=15,
            )
        except HTTPException as exc:
            # 404/405만 구서버(배치 라우트 없음) — 단건 폴백. 401/403/5xx 를 여기서 삼키면
            # 인증 만료·서버 장애가 "팀 카드 N건 실패"로 뭉개져 원인이 보이지 않는다(합의 설계).
            if exc.status_code not in (404, 405):
                raise
            return _fetch_server_cards_fanout(gen_ids)
        items = result.get("items") if isinstance(result, dict) else None
        if not isinstance(items, dict):
            return {}
        return {
            requested_id: card
            for requested_id, card in items.items()
            if isinstance(requested_id, str) and isinstance(card, dict)
        }

    return can_edit, fetch_server_cards


@router.put("/generations/tags/batch")
def set_tags_batch(body: GenerationTagsBatchIn, request: Request):
    """다중 태그를 로컬/팀 shadow별 한 트랜잭션으로 저장한다. 항목별 부분 성공은 유지한다."""
    if len(body.items) > 500:
        raise HTTPException(status_code=400, detail="한 번에 최대 500개 생성물까지 변경할 수 있습니다")
    can_edit, fetch_server_cards = _batch_meta_callbacks(request)
    result = generation_personal_meta.set_tags_batch(
        [(item.id, item.tags) for item in body.items],
        auto=body.auto,
        proxying=_proxy.proxying(),
        my_uid=_my_uid(request),
        can_edit=can_edit,
        fetch_server_cards=fetch_server_cards,
    )
    return {"succeeded": result.succeeded, "failed": result.failed}


@router.delete("/tags/{tag}")
def delete_tag(tag: str, request: Request):
    """태그를 generation 에서 삭제(에셋 T 패널 ✕ 와 동일). AUTH on 이면 내 생성물에서만(남의 태그 보존)."""
    return {"removed": repo.delete_tag_everywhere(tag, account_uid=account_scope_uid(request))}


@router.post("/generations/clear-failed")
def clear_failed(request: Request):
    """비정상 종료(성공/진행중 아님) 생성물을 휴지통으로. AUTH on 이면 내 것만(남의 실패본 보존)."""
    return {"removed": repo.delete_failed_orphans(account_uid=account_scope_uid(request))}


@router.post("/generations/trash-hf-missing")
async def trash_hf_missing(request: Request):
    """내 생성물 중 힉스필드에서 삭제된 것(generate get 실패)을 찾아 휴지통으로 보낸다.
    무료 호출(생성 아님). 확인 불가(None)는 건드리지 않는다 — 일시적 오류로 멀쩡한 걸 지우지 않게.
    재등장한 항목은 흐림(hf_missing) 표시만 해제. 반환: {checked, trashed}.
    AUTH on 이면 내 생성물만 검증 대상(남의 잡을 다른 신원 CLI 로 오판·삭제 방지)."""
    fetch_server_candidates = None
    apply_server_results = None
    if _proxy.proxying():
        fetch_server_candidates = lambda: _proxy.proxy_json(
            "GET", "/api/manage/hf-missing-candidates"
        )
        apply_server_results = lambda results: _proxy.proxy_json(
            "POST",
            "/api/manage/hf-missing-apply",
            body={"results": results},
        )

    return await hf_missing.trash_missing_generations(
        account_scope_uid(request),
        fetch_server_candidates=fetch_server_candidates,
        apply_server_results=apply_server_results,
    )


@router.delete("/generations/{gen_id}")
def delete_generation(gen_id: str, request: Request):
    """generation 1건 휴지통행(soft delete). 우리 카탈로그에서만 숨김 —
    힉스필드 원본엔 영향 없음. '지운 생성물 보기' 토글로 흐리게 재표시·복구 가능.
    ★공유 중(팀 발행)인 항목은 삭제 불가 — 팀이 보는 걸 몰래 지우지 못하게. 먼저 공유 해제(S) 후 삭제."""
    gen, local_id, _ = repo.resolve_and_get(gen_id)  # 팀 탭 카드(서버 UUID)→로컬 행(단일 커넥션)
    if not gen and _proxy.proxying():  # 남의/내 팀 카드(로컬 미해석) — 공유물이라 여기선 삭제 불가
        raise HTTPException(
            status_code=403,
            detail="팀 공유물은 삭제할 수 없습니다. 공유 해제 후 내 작업 탭에서 삭제하세요.",
        )
    gen_id = local_id or gen_id  # 못 찾으면 원본 유지(비프록시 no-op 동작 보존)
    if gen:
        require_edit_generation(request, gen)  # 본인/admin 만 삭제(권한 먼저 — 존재·공유 정보 안 새게)
        if gen.get("shared"):  # 본인 것이라도 공유 중이면 차단(먼저 공유 해제) — '함부로 안 지워짐'
            raise HTTPException(
                status_code=409,
                detail="공유 중인 항목은 삭제할 수 없습니다. 먼저 공유 해제(S)한 뒤 삭제하세요.",
            )
    return {"deleted": repo.delete_generation(gen_id)}


@router.post("/generations/{gen_id}/restore")
def restore_generation(gen_id: str, request: Request):
    """휴지통에서 복구 — 카탈로그에 정상 표시로 되돌림. 본인(또는 admin)만.
    휴지통 항목은 메인 DB 에 없어 require_edit 가 통하지 않으므로, 복구 함수에 소유권 게이트를 건다."""
    gen, local_id, _ = repo.resolve_and_get(gen_id)  # 메인에 있으면 로컬 행(단일 커넥션), 휴지통 id 는 그대로
    gen_id = local_id or gen_id
    if gen:  # 드물게 메인에 있으면 기존 편집 가드
        require_edit_generation(request, gen)
        return {"restored": repo.restore_generation(gen_id)}
    # 휴지통 항목: AUTH off 또는 admin → 게이트 없음, 그 외엔 본인 것만(남의 삭제물 복구 차단).
    is_admin = rbac.has_any_global_role(account_global_roles(request), rbac.ADMIN)
    owner = None if (not AUTH_ENABLED or is_admin) else actor_id(request)
    try:
        return {"restored": repo.restore_generation(gen_id, account_uid=owner)}
    except PermissionError as e:
        raise HTTPException(status_code=403, detail=str(e))


def _my_uid(request: Request) -> Optional[str]:
    """'내 카드' 판정용 uid — AUTH on 이면 로그인 계정, AUTH off 프록시(에이전트)면 활성 계정(서버 로그인)."""
    uid = account_scope_uid(request)
    if not uid and _proxy.proxying():
        from ..active_account import active_uid
        uid = active_uid()
    return uid


def _set_personal_shadow(gen_id, request, *, local_apply, shadow_apply, result_key, result_value):
    """개인메타(색/태그) setter 공통 — 서버 미러 안 함.
    · 내 카드(로컬 행 + 내 것, 또는 단독/local-only)이면 로컬 행에 저장(local_apply).
    · 남의 팀 카드(프록시 + 타인 소유거나 로컬 행 없음)이면 내 로컬 shadow 에만(shadow_apply).
      공유 카드 자체는 안 바꾸므로 require_edit 불필요·서버 미러 없음.
    ★서버 단건 GET 은 프론트가 준 gen_id(팀 카드 서버 UUID)로 — server_id(=job_id)로는 서버가 404."""
    gen, local_id, server_id = _resolve_local_or_reclaim(gen_id, request)
    my = _my_uid(request)
    is_other = (
        bool(gen) and _proxy.proxying()
        and bool(gen.get("creator_uid")) and gen.get("creator_uid") != my
    )
    if gen and not is_other:
        require_edit_generation(request, gen)  # 본인/admin 만
        local_apply(local_id)
        return repo.get_generation(local_id)
    if _proxy.proxying():
        srv = _proxy.proxy_get(f"/api/generations/{gen_id}", request)
        anchor = (srv.get("job_id") or srv.get("id") or gen_id) if isinstance(srv, dict) else gen_id
        shadow_apply(anchor)
        if isinstance(srv, dict):
            srv[result_key] = result_value
            return srv
    raise HTTPException(status_code=404, detail="generation 없음")


@router.put("/generations/{gen_id}/color", response_model=GenerationOut)
def set_color(gen_id: str, body: ColorIn, request: Request):
    """색 — 내 카드=generation.color / 남의 팀 카드=로컬 shadow(gen_color_overlay). 서버 미러 없음."""
    return _set_personal_shadow(
        gen_id, request,
        local_apply=lambda i: repo.set_color(i, body.color),
        shadow_apply=lambda a: repo.set_color_overlay(a, body.color),
        result_key="color", result_value=body.color,
    )


class GenerationColorBatchItem(BaseModel):
    id: str
    color: Optional[str] = None


class GenerationColorsBatchIn(BaseModel):
    items: list[GenerationColorBatchItem] = Field(default_factory=list)


@router.put("/generations/colors/batch")
def set_colors_batch(body: GenerationColorsBatchIn, request: Request):
    """다중 색상을 로컬/팀 shadow별 한 트랜잭션으로 저장한다. 권한·존재 실패는 항목별 반환한다."""
    if len(body.items) > 500:
        raise HTTPException(status_code=400, detail="한 번에 최대 500개 생성물까지 변경할 수 있습니다")
    can_edit, fetch_server_cards = _batch_meta_callbacks(request)
    result = generation_personal_meta.set_colors_batch(
        [(item.id, item.color) for item in body.items],
        proxying=_proxy.proxying(),
        my_uid=_my_uid(request),
        can_edit=can_edit,
        fetch_server_cards=fetch_server_cards,
    )
    return {"succeeded": result.succeeded, "failed": result.failed}


@router.put("/generations/{gen_id}/source", response_model=GenerationOut)
def set_source(gen_id: str, body: SourceIn, request: Request):
    """소스 라이브러리 등록/해제(@이름). 등록하면 @ 피커에 노출된다."""
    # source 는 공유 필드(마스킹 안 함) → 공유본이면 서버에도 미러.
    return _set_meta(
        gen_id, request, lambda i: repo.set_source(i, body.name, body.is_source),
        mirror_suffix="source", mirror_body=body.model_dump(),
    )


@router.get("/sources", response_model=list[GenerationOut])
def list_sources(
    request: Request,
    query: str | None = None,
    tag: str | None = None,
    asset_project: str | None = None,
    asset_dir: str | None = None,
):
    """스포트라이트 @/# 피커: 소스 등록된 생성본을 이름/태그로 검색.
    asset_project 가 오면 에셋 파트 소스(현재 폴더 asset_dir 로 스코프)도 함께 반환.
    에셋 소스는 계정별 개인화라 내(actor_id) 것만 합류한다."""
    viewer_uid, read_all = _viewer_scope(request)
    member = repo.my_member_projects(viewer_uid) if (viewer_uid and not read_all) else []
    return repo.search_sources(
        query=query,
        tag=tag,
        asset_project=asset_project,
        asset_dir=asset_dir,
        owner_uid=actor_id(request),
        viewer_uid=viewer_uid,
        read_all=read_all,
        member_projects=member,
    )


@router.put("/generations/{gen_id}/comment", response_model=GenerationOut)
def set_comment(gen_id: str, body: CommentIn, request: Request):
    """gen 자체 코멘트 필드 수정 — 본인/admin 만(스레드 코멘트와 별개)."""
    # comment 는 공유 필드(마스킹 안 함) → 공유본이면 서버에도 미러.
    return _set_meta(
        gen_id, request, lambda i: repo.set_comment(i, body.comment),
        mirror_suffix="comment", mirror_body=body.model_dump(),
    )


# ── 생성본 코멘트 스레드(공유, 에셋과 별개) ───────────────────────────────
class GenCommentAddIn(BaseModel):
    text: str
    author: str | None = None
    parent_id: str | None = None
    muted: bool = False  # [구] '내 알림 끄기' — private 로 대체, 구클라 호환용으로만 받는다
    private: bool = False  # 비공개 — 내 로컬 DB 에만 저장, 서버로 절대 안 보냄


class GenCommentEditIn(BaseModel):
    text: str
    worker_id: str | None = None


class GenCommentReadIn(BaseModel):
    worker_id: str | None = None


# 로컬 우선에서 '공유 코멘트'는 팀이 한 스레드를 봐야 하므로 서버에 둔다 — 발행된(shared) 내
# 생성물이거나, 로컬에 없는 팀 항목이면 코멘트는 서버로 위임한다. 비공개(미발행) 로컬 작업만 로컬.
def _comments_on_server(gen: dict | None) -> bool:
    return _proxy.proxying() and (gen is None or bool(gen.get("shared")))


class CommentCountsIn(BaseModel):
    gen_ids: list[str] = Field(default_factory=list, max_length=500)


@router.post("/generations/comment-counts")
def gen_comment_counts(body: CommentCountsIn, request: Request):
    """주어진 gen_id 들의 코멘트 수·미확인 여부(배치). 로컬 우선에서 발행본(서버 공유) 카드의
    코멘트 뱃지를 서버 기준으로 보강할 때 로컬 허브가 이걸 서버로 위임해 받아온다."""
    if _proxy.proxying():
        # 로컬 id ↔ 서버 id(job_id) 변환: 요청은 서버 id 로 보내고 응답 키를 로컬 id 로 되돌린다
        # (로컬 카드 id 로 그대로 위임하면 서버가 못 찾아 공유본 C 뱃지가 0 으로 떴다).
        requested = list(dict.fromkeys(gid for gid in (body.gen_ids or []) if gid))
        srv_of = {gid: repo.finalize_id_map(gid)[1] for gid in requested}
        resp = _proxy.proxy_json(
            "POST", "/api/generations/comment-counts", body={"gen_ids": list(srv_of.values())}
        )
        remote = resp if isinstance(resp, dict) else {}
        private = repo.private_generation_comment_counts(requested, actor_id(request))
        merged: dict[str, dict[str, Any]] = {}
        for gid, sid in srv_of.items():
            value = remote.get(sid)
            slot = value.copy() if isinstance(value, dict) else {}
            slot["comment_count"] = int(slot.get("comment_count") or 0) + private.get(gid, 0)
            slot["has_unread"] = bool(slot.get("has_unread"))
            merged[gid] = slot
        return merged
    viewer_uid, read_all = _viewer_scope(request)
    member = repo.my_member_projects(viewer_uid) if (viewer_uid and not read_all) else []
    return repo.generation_comment_counts(
        body.gen_ids, actor_id(request), read_all=read_all, member_projects=member
    )


@router.get("/generations/{gen_id}/comments")
def list_gen_comments(gen_id: str, request: Request):
    """생성본 코멘트 스레드(작성자·시각 포함, 오래된→최신). 공유 스레드에 내 비공개(로컬)를 합친다."""
    gen = repo.get_generation(gen_id)
    if _comments_on_server(gen):
        _, server_id = repo.finalize_id_map(gen_id)  # 공유본은 서버가 job_id 로 안다
        shared = _proxy.proxy_get(f"/api/generations/{server_id}/comments", request)
        # 비공개는 서버에 없다 — 로컬(작성 시와 같은 앵커: 로컬 행 있으면 로컬 id)에서 합친다.
        anchor = gen["id"] if gen else gen_id
        mine = repo.list_private_generation_comments(anchor, actor_id(request))
        merged = ([*shared, *mine] if isinstance(shared, list) else mine)
        merged.sort(key=lambda c: (str(c.get("created_at") or ""), str(c.get("id") or "")))
        return merged
    if not gen:
        raise HTTPException(status_code=404, detail="generation 없음")
    require_view_generation(request, gen)  # 비공개 남의 코멘트 열람 차단(공유/본인만)
    return repo.list_generation_comments(gen_id, actor_id(request))


@router.post("/generations/{gen_id}/comments")
def add_gen_comment(gen_id: str, body: GenCommentAddIn, request: Request):
    gen = repo.get_generation(gen_id)
    # ★비공개는 프록시를 타지 않는다 — 공유 생성물에 단 것이어도 내 로컬 DB 에만 남는다.
    #  앵커는 목록과 같은 규칙(로컬 행 있으면 로컬 id) — 어디서 열어도 같은 스레드에 보이게.
    if body.private:
        anchor = gen["id"] if gen else gen_id
        text = (body.text or "").strip()
        if not text:
            raise HTTPException(status_code=400, detail="빈 코멘트")
        cid = repo.add_generation_comment(
            anchor, actor_id(request), text, body.parent_id, body.muted, is_private=True
        )
        return {"id": cid}
    if _comments_on_server(gen):
        _, server_id = repo.finalize_id_map(gen_id)
        return _proxy.proxy_json(
            "POST", f"/api/generations/{server_id}/comments", body=body.model_dump()
        )
    if not gen:
        raise HTTPException(status_code=404, detail="generation 없음")
    require_view_generation(request, gen)  # 볼 수 있는 것(공유/본인)에만 코멘트 작성
    text = (body.text or "").strip()
    if not text:
        raise HTTPException(status_code=400, detail="빈 코멘트")
    # 작성자는 로그인 신원(creator_uid)으로 귀속 — body.author 는 무시(클라가 'me' 로 보내던
    # 값을 더는 신뢰하지 않는다). AUTH off 면 actor_id 가 'me' 로 떨어져 기존 단독 동작 유지.
    cid = repo.add_generation_comment(
        gen_id, actor_id(request), text, body.parent_id, body.muted
    )
    return {"id": cid}


# by-id 코멘트 연산(수정/삭제/확인) 라우팅: 공유본(share 있음)에 달린 코멘트는 — 로컬에 같은 id 가
# 있어도(발행 번들이 같은 id 로 서버에 심음) — 서버 단일 스레드가 정답이므로 서버로 위임한다.
# 내 비공개 작업 코멘트(share 없음)만 로컬에서 처리. comment_gen_shared: None=서버전용/True=공유본/False=비공개.
def _comment_local(comment_id: str) -> bool:
    if not _proxy.proxying():
        return True
    # 비공개는 공유 생성물에 달렸어도 로컬이 정답(서버에 애초에 없다) — shared 판정보다 먼저.
    if repo.generation_comment_is_private(comment_id) is True:
        return True
    return repo.comment_gen_shared(comment_id) is False


@router.put("/generation-comments/{comment_id}")
def edit_gen_comment(comment_id: str, body: GenCommentEditIn, request: Request):
    text = (body.text or "").strip()
    if not text:
        raise HTTPException(status_code=400, detail="빈 코멘트")
    if not _comment_local(comment_id):
        return _proxy.proxy_json(
            "PUT", f"/api/generation-comments/{comment_id}", body=body.model_dump()
        )
    try:
        repo.edit_generation_comment(comment_id, actor_id(request), text)
    except PermissionError as e:
        raise HTTPException(status_code=403, detail=str(e))
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))
    return {"ok": True}


@router.delete("/generation-comments/{comment_id}")
def delete_gen_comment(comment_id: str, request: Request):
    if not _comment_local(comment_id):
        return _proxy.proxy_json("DELETE", f"/api/generation-comments/{comment_id}")
    try:
        repo.delete_generation_comment(comment_id, actor_id(request))
    except PermissionError as e:
        raise HTTPException(status_code=403, detail=str(e))
    return {"ok": True}


@router.post("/generations/{gen_id}/comments/read")
def read_gen_comments(gen_id: str, body: GenCommentReadIn, request: Request):
    gen = repo.get_generation(gen_id)
    if _comments_on_server(gen):
        _, server_id = repo.finalize_id_map(gen_id)
        return _proxy.proxy_json(
            "POST", f"/api/generations/{server_id}/comments/read", body=body.model_dump()
        )
    if not gen:
        raise HTTPException(status_code=404, detail="generation 없음")
    require_view_generation(request, gen)
    repo.mark_generation_comments_read(actor_id(request), gen_id)
    return {"ok": True}


@router.post("/generation-comments/{comment_id}/seen")
def seen_gen_comment(comment_id: str, request: Request):
    """코멘트 한 건 확인 처리(패널에서 NEW 코멘트 클릭). 개인 상태라 멱등·가벼운 처리."""
    if not _comment_local(comment_id):  # 공유본(서버) 코멘트 확인은 서버 seen 으로
        return _proxy.proxy_json("POST", f"/api/generation-comments/{comment_id}/seen")
    repo.mark_generation_comment_seen(actor_id(request), comment_id)
    return {"ok": True}


@router.post("/generations/{gen_id}/cache")
async def cache_one(gen_id: str, request: Request):
    gen, gen_id, _ = _resolve_local_or_reclaim(gen_id, request)  # 팀 탭 카드(서버 UUID)→로컬 행
    if not gen:
        raise HTTPException(status_code=404, detail="generation 없음")
    require_view_generation(request, gen)  # 남의 비공개 프롬프트·params·에셋 URL 열람 차단(공유/본인만)
    repo.request_media_preservation(gen_id, "manual", force=True)
    res = await preserve_generation_now(gen_id)
    if res is None:
        res = {"status": (repo.get_media_preservation(gen_id) or {}).get("status", "running")}
    res["generation"] = repo.get_generation(gen_id)
    return res


@router.post("/cache-all")
async def cache_all(request: Request):
    """모든 생성물의 미보관 원격 미디어를 관리자 권한으로 일괄 보관한다."""
    from ..deps import require_admin

    require_admin(request)  # 전 계정 미디어 일괄 캐시 — AUTH on 이면 admin 만(AUTH off 면 통과)
    queued = 0
    for gen_id in repo.all_generation_ids():
        generation = repo.get_generation(gen_id)
        if not generation or generation.get("status") != "done":
            continue
        if repo.request_media_preservation(gen_id, "admin", force=True):
            queued += 1
    return {"queued": queued, "message": "용량 한도 안에서 백그라운드 보존을 시작했습니다"}

"""생성 메타데이터·재활용 라우터.

⚠️ 생성/재생성 '실행'은 더는 서버가 하지 않는다(push 모델 — project_content_hub_push_model).
   허브 버튼은 `POST /api/gen-requests`(routers/gen_requests.py)로 로컬 실행을 요청하고,
   요청자 PC의 에이전트가 자기 CLI로 실행한다. 이 라우터에 남은 CLI 호출은 **계정 무관
   공유 메타데이터**(모델 목록·params·비용)와 동기화·검증·워크스페이스 등 보조 기능뿐.
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException, Query, Request
from pydantic import BaseModel

from . import _proxy
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
import asyncio

from ..services import cli_bridge, media_cache, syncer

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
    return repo.list_creators(
        account_uid=account_scope_uid(request), tab=tab, project_id=project_id
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


@router.get("/generations/{gen_id}/history", response_model=HistoryOut)
def get_history(gen_id: str, request: Request):
    """한 결과물의 가계(재료⬆/파생⬇/사용처/약한형제) — 카드 히스토리 뱃지 클릭 시 패널 표시용."""
    gen = repo.get_generation(gen_id)
    if not gen:
        if _proxy.proxying():  # 로컬에 없으면 팀(서버) 항목 → 서버 가계 위임
            return _proxy.proxy_get(f"/api/generations/{gen_id}/history", request)
        raise HTTPException(status_code=404, detail="generation 없음")
    require_view_generation(request, gen)  # GET /{id} 와 동일 가시성(비공개는 본인/공유만)
    viewer_uid, read_all = _viewer_scope(request)
    data = repo.get_history(gen_id, viewer_uid=viewer_uid, read_all=read_all)
    if not data:
        raise HTTPException(status_code=404, detail="generation 없음")
    return data


@router.get("/generations/{gen_id}/history-tree", response_model=HistoryGraphOut)
def get_history_tree(gen_id: str, request: Request):
    """연결된 가계 전체 그래프(노드+엣지+루트) — 구성탭 히스토리 트리 렌더용."""
    gen = repo.get_generation(gen_id)
    if not gen:
        if _proxy.proxying():
            return _proxy.proxy_get(f"/api/generations/{gen_id}/history-tree", request)
        raise HTTPException(status_code=404, detail="generation 없음")
    require_view_generation(request, gen)
    viewer_uid, read_all = _viewer_scope(request)
    data = repo.get_history_graph(gen_id, viewer_uid=viewer_uid, read_all=read_all)
    if not data:
        raise HTTPException(status_code=404, detail="generation 없음")
    return data


@router.post("/generations/{gen_id}/history", response_model=HistoryOut, status_code=201)
def add_history(gen_id: str, body: HistoryEdgeIn, request: Request):
    """수동 히스토리 연결 — 이 결과물(gen_id)의 부모를 손으로 지정(동기화 잡 등). 갱신된 가계 반환."""
    gen, gen_id, _ = repo.resolve_and_get(gen_id)  # 팀 탭 카드(서버 job_id)→로컬 행(단일 커넥션)
    if not gen:
        raise HTTPException(status_code=404, detail="generation 없음")
    require_edit_generation(request, gen)  # 히스토리 수정은 본인/admin 만
    try:
        repo.add_history_edge(body.parent_gen_id, gen_id, body.relation)
    except ValueError as e:
        raise HTTPException(status_code=409, detail=str(e))
    return repo.get_history(gen_id)


@router.delete("/generations/{gen_id}/history/{parent_gen_id}", response_model=HistoryOut)
def remove_history(gen_id: str, parent_gen_id: str, request: Request):
    """히스토리 엣지 해제 — 이 결과물과 그 부모의 연결을 푼다. 갱신된 가계 반환."""
    gen, gen_id, _ = repo.resolve_and_get(gen_id)  # 팀 탭 카드(서버 job_id)→로컬 행(단일 커넥션)
    if not gen:
        raise HTTPException(status_code=404, detail="generation 없음")
    require_edit_generation(request, gen)  # 히스토리 수정은 본인/admin 만
    repo.remove_history_edge(parent_gen_id, gen_id)
    return repo.get_history(gen_id)


class DeriveFromIn(BaseModel):
    parent_ids: list[str]


@router.post("/generations/{gen_id}/derive-from", response_model=HistoryOut)
def derive_from(gen_id: str, body: DeriveFromIn, request: Request):
    """생성 직후 파생 부모(들)를 'derived' 엣지로 일괄 기록 — **전이 축소** 적용.
    후보 중 다른 후보(또는 child)의 조상인 것은 잉여(자손을 거쳐 도달)라 빼고 가장 가까운 부모만 남긴다.
    (드래그 부모 + 보드 포커스/선택이 합쳐져 들어와도 원본→중간→자식 체인이 평탄해지지 않게 한다.)"""
    gen, gen_id, _ = repo.resolve_and_get(gen_id)  # 팀 탭 카드(서버 job_id)→로컬 행(단일 커넥션)
    if not gen:
        raise HTTPException(status_code=404, detail="generation 없음")
    require_edit_generation(request, gen)  # 본인/admin 만 — 계보 기록도 수정 가드와 동일
    repo.record_derived_parents(gen_id, body.parent_ids)
    viewer_uid, read_all = _viewer_scope(request)
    return repo.get_history(gen_id, viewer_uid=viewer_uid, read_all=read_all)


def _set_meta(gen_id, request, apply, suffix: str, mirror_body):
    """color/tags/source/comment 개인메타 setter 공통 셰이프.

    팀 탭 카드는 서버 job_id 로 표시되므로 resolve_and_get 으로 한 번에 로컬 행을 해석(단일 커넥션)
    → 404/권한 → 로컬 적용 → 공유본이면 서버에도 미러(팀 탭은 서버 데이터를 그리므로 '보이는 건
    실시간'을 만족). 비공유/비프록시면 미러는 no-op, 404(서버에 아직 없음)는 무시."""
    gen, local_id, server_id = repo.resolve_and_get(gen_id)
    if not gen:
        raise HTTPException(status_code=404, detail="generation 없음")
    require_edit_generation(request, gen)  # 본인/admin 만 수정
    apply(local_id)
    if _proxy.proxying() and gen.get("shared"):
        try:
            _proxy.proxy_json("PUT", f"/api/generations/{server_id}/{suffix}", body=mirror_body)
        except HTTPException as e:
            if e.status_code != 404:
                raise
    return repo.get_generation(local_id)


@router.put("/generations/{gen_id}/tags", response_model=GenerationOut)
def set_tags(gen_id: str, body: TagsIn, request: Request):
    return _set_meta(gen_id, request, lambda i: repo.set_tags(i, body.tags), "tags", body.model_dump())


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
    gens = repo.gens_with_job_id(account_uid=account_scope_uid(request))
    sem = asyncio.Semaphore(8)  # 동시 CLI 호출 제한

    async def check(gen_id: str, job_id: str):
        async with sem:
            exists = await cli_bridge.job_exists(job_id)
            return gen_id, exists  # True/False/None(확인불가)

    results = await asyncio.gather(*(check(g, j) for g, j in gens))
    trashed = 0
    for gen_id, exists in results:
        if exists is None:
            continue  # 확인 불가 → 그대로 둠
        if exists:
            repo.set_hf_missing(gen_id, False)  # 재등장 → 흐림 해제
        else:
            repo.delete_generation(gen_id)  # 힉스에서 삭제됨 → 휴지통행(soft delete)
            trashed += 1
    return {"checked": len(gens), "trashed": trashed}


@router.delete("/generations/{gen_id}")
def delete_generation(gen_id: str, request: Request):
    """generation 1건 휴지통행(soft delete). 우리 카탈로그에서만 숨김 —
    힉스필드 원본엔 영향 없음. '지운 생성물 보기' 토글로 흐리게 재표시·복구 가능."""
    gen, local_id, _ = repo.resolve_and_get(gen_id)  # 팀 탭 카드(서버 job_id)→로컬 행(단일 커넥션)
    gen_id = local_id or gen_id  # 못 찾으면 원본 유지(서버 id no-op 동작 보존)
    if gen:
        require_edit_generation(request, gen)  # 본인/admin 만 삭제
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


@router.put("/generations/{gen_id}/color", response_model=GenerationOut)
def set_color(gen_id: str, body: ColorIn, request: Request):
    return _set_meta(gen_id, request, lambda i: repo.set_color(i, body.color), "color", body.model_dump())


@router.put("/generations/{gen_id}/source", response_model=GenerationOut)
def set_source(gen_id: str, body: SourceIn, request: Request):
    """소스 라이브러리 등록/해제(@이름). 등록하면 @ 피커에 노출된다."""
    return _set_meta(
        gen_id, request, lambda i: repo.set_source(i, body.name, body.is_source), "source", body.model_dump()
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
    return repo.search_sources(
        query=query,
        tag=tag,
        asset_project=asset_project,
        asset_dir=asset_dir,
        owner_uid=actor_id(request),
    )


@router.put("/generations/{gen_id}/comment", response_model=GenerationOut)
def set_comment(gen_id: str, body: CommentIn, request: Request):
    """gen 자체 코멘트 필드 수정 — 본인/admin 만(스레드 코멘트와 별개)."""
    return _set_meta(gen_id, request, lambda i: repo.set_comment(i, body.comment), "comment", body.model_dump())


# ── 생성본 코멘트 스레드(공유, 에셋과 별개) ───────────────────────────────
class GenCommentAddIn(BaseModel):
    text: str
    author: str | None = None
    parent_id: str | None = None
    muted: bool = False  # 작성 시점 '내 알림 끄기' 상태(코멘트별 캡처)


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
    gen_ids: list[str] = []


@router.post("/generations/comment-counts")
def gen_comment_counts(body: CommentCountsIn, request: Request):
    """주어진 gen_id 들의 코멘트 수·미확인 여부(배치). 로컬 우선에서 발행본(서버 공유) 카드의
    코멘트 뱃지를 서버 기준으로 보강할 때 로컬 허브가 이걸 서버로 위임해 받아온다."""
    if _proxy.proxying():
        # 로컬 id ↔ 서버 id(job_id) 변환: 요청은 서버 id 로 보내고 응답 키를 로컬 id 로 되돌린다
        # (로컬 카드 id 로 그대로 위임하면 서버가 못 찾아 공유본 C 뱃지가 0 으로 떴다).
        srv_of = {gid: repo.finalize_id_map(gid)[1] for gid in (body.gen_ids or [])}
        local_of = {sid: gid for gid, sid in srv_of.items()}
        resp = _proxy.proxy_json(
            "POST", "/api/generations/comment-counts", body={"gen_ids": list(srv_of.values())}
        )
        return {local_of.get(k, k): v for k, v in (resp or {}).items()}
    return repo.generation_comment_counts(body.gen_ids, actor_id(request))


@router.get("/generations/{gen_id}/comments")
def list_gen_comments(gen_id: str, request: Request):
    """생성본 코멘트 스레드(작성자·시각 포함, 오래된→최신)."""
    gen = repo.get_generation(gen_id)
    if _comments_on_server(gen):
        _, server_id = repo.finalize_id_map(gen_id)  # 공유본은 서버가 job_id 로 안다
        return _proxy.proxy_get(f"/api/generations/{server_id}/comments", request)
    if not gen:
        raise HTTPException(status_code=404, detail="generation 없음")
    require_view_generation(request, gen)  # 비공개 남의 코멘트 열람 차단(공유/본인만)
    return repo.list_generation_comments(gen_id, actor_id(request))


@router.post("/generations/{gen_id}/comments")
def add_gen_comment(gen_id: str, body: GenCommentAddIn, request: Request):
    gen = repo.get_generation(gen_id)
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


# ── 출처 영속화 (byte-cache): 소스·결과물을 로컬로 보관 ───────────────────
async def cache_generation_media(gen: dict) -> dict[str, int]:
    """한 generation 의 asset·reference 원격 URL 을 로컬로 내려받고 경로를 갱신.

    원본 URL 은 repo 헬퍼가 source_url 에 보존한다(출처 영속).
    동시 다운로드, 실패는 건너뛰고(원격 URL 유지) 카운트만 집계.
    """
    targets: list[tuple[str, str, str, bool]] = []  # (kind, id, url, is_image)
    for a in gen.get("assets", []):
        if not a["file_path"].startswith("/media/"):
            targets.append(("asset", a["id"], a["file_path"], a["type"] == "image"))
    for r in gen.get("references", []):
        if not r["file_path"].startswith("/media/"):
            targets.append(("ref", r["id"], r["file_path"], r["type"] == "image"))

    if not targets:
        return {"cached": 0, "failed": 0, "skipped": 0}

    results = await asyncio.gather(*(media_cache.cache_url(t[2]) for t in targets))

    cached = failed = 0
    for (kind, rid, url, is_image), local in zip(targets, results):
        if not local:
            failed += 1
            continue
        thumb = local if is_image else None
        if kind == "asset":
            repo.update_asset_cache(rid, local, thumb, url)
        else:
            repo.update_reference_cache(rid, local, thumb, url)
        cached += 1
    return {"cached": cached, "failed": failed, "skipped": 0}


@router.post("/generations/{gen_id}/cache")
async def cache_one(gen_id: str, request: Request):
    gen, gen_id, _ = repo.resolve_and_get(gen_id)  # 팀 탭 카드(서버 job_id)→로컬 행(단일 커넥션)
    if not gen:
        raise HTTPException(status_code=404, detail="generation 없음")
    require_view_generation(request, gen)  # 남의 비공개 프롬프트·params·에셋 URL 열람 차단(공유/본인만)
    res = await cache_generation_media(gen)
    res["generation"] = repo.get_generation(gen_id)
    return res


@router.post("/cache-all")
async def cache_all(request: Request):
    from ..deps import require_admin

    require_admin(request)  # 전 계정 미디어 일괄 캐시 — AUTH on 이면 admin 만(AUTH off 면 통과)
    """모든 generation 의 소스·결과물을 로컬로 보관(미보관분만). 출처 영속화 일괄.
    gen 단위로 병렬 처리(동시성 캡)해 일괄 보관 속도를 높인다 — 각 gen 내부 미디어도 gather."""
    total = {"cached": 0, "failed": 0, "generations": 0}
    sem = asyncio.Semaphore(6)  # 동시 다운로드 상한(서버 과부하·레이트리밋 방지)

    async def _one(gid: str) -> dict[str, int] | None:
        async with sem:
            gen = repo.get_generation(gid)
            if not gen:
                return None
            return await cache_generation_media(gen)

    for r in await asyncio.gather(*(_one(g) for g in repo.all_generation_ids())):
        if not r:
            continue
        total["cached"] += r["cached"]
        total["failed"] += r["failed"]
        if r["cached"]:
            total["generations"] += 1
    return total

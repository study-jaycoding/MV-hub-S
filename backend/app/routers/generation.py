"""생성 메타데이터·재활용 라우터.

⚠️ 생성/재생성 '실행'은 더는 서버가 하지 않는다(push 모델 — project_content_hub_push_model).
   허브 버튼은 `POST /api/gen-requests`(routers/gen_requests.py)로 로컬 실행을 요청하고,
   요청자 PC의 에이전트가 자기 CLI로 실행한다. 이 라우터에 남은 CLI 호출은 **계정 무관
   공유 메타데이터**(모델 목록·params·비용)와 동기화·검증·워크스페이스 등 보조 기능뿐.
"""

from __future__ import annotations

import subprocess
import sys
from typing import Any

from fastapi import APIRouter, HTTPException, Query, Request
from pydantic import BaseModel

from . import _proxy
from .. import rbac, repo
from ..config import AUTH_ENABLED, DEFAULT_WORKER_ID, MEDIA_DIR
from ..deps import (
    account_global_roles,
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
from .assets import _safe_resolve

router = APIRouter(prefix="/api", tags=["generation"])


class RevealMediaIn(BaseModel):
    path: str  # /media/<file> 형태(로컬 보관된 결과물/소스)


@router.post("/reveal-media")
def reveal_media(body: RevealMediaIn):
    """로컬 보관된 결과물·소스(/media/...)의 원본 위치를 탐색기에서 열고 선택."""
    rel = body.path.split("?", 1)[0]
    if rel.startswith("/media/"):
        rel = rel[len("/media/"):]
    rel = rel.lstrip("/")
    if not rel:
        raise HTTPException(status_code=400, detail="로컬 보관 파일이 아닙니다(원격 URL)")
    target = _safe_resolve(MEDIA_DIR, rel)
    if not target or not target.exists():
        raise HTTPException(status_code=404, detail="로컬 파일 없음")
    try:
        if sys.platform == "win32":
            # explorer 는 성공해도 종료코드 1 을 반환하므로 검사하지 않음
            subprocess.Popen(["explorer", f"/select,{target}"])
        elif sys.platform == "darwin":
            subprocess.Popen(["open", "-R", str(target)])
        else:
            subprocess.Popen(["xdg-open", str(target.parent)])
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=f"탐색기 열기 실패: {e}")
    return {"ok": True}


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


@router.post("/import-jobs")
def import_jobs(jobs: list[dict[str, Any]]):
    """외부 JSON(다른 작업자의 generate list export)을 가져와 업서트.
    UUID 키로 중복 없이 병합 + result_url 의 user_<id> 로 생성자 자동 구분.
    팀 공유(각자 json export 교환) 모델의 핵심 입구."""
    counts = {"inserted": 0, "updated": 0, "unchanged": 0, "skipped": 0}
    for j in jobs:
        if not isinstance(j, dict) or not j.get("id"):
            counts["skipped"] += 1
            continue
        parsed = cli_bridge.parse_job(j)
        counts[repo.upsert_synced_generation(parsed, DEFAULT_WORKER_ID)] += 1
    return counts


@router.get("/export-bundle")
def export_bundle(creator_uid: str | None = None, mine: bool = False):
    """로컬 DB 를 '사실 + 오버레이' 번들로 내보낸다(팀 공유 입구, >100 제약 우회).
    mine=true 면 내 생성자(creator_uid) 것만. 받는 쪽은 /import-bundle 로 병합."""
    uid = creator_uid
    if mine and not uid:
        uid = repo.get_my_uid()
    return repo.export_bundle(creator_uid=uid)


@router.post("/import-bundle")
def import_bundle(bundle: dict[str, Any]):
    """content-hub 번들(사실 + 오버레이)을 가져와 병합.
    사실은 uuid 멱등 upsert, 태그 union, 코멘트 id dedup append, 레퍼런스 위치 보존."""
    if not isinstance(bundle.get("generations"), list):
        raise HTTPException(status_code=400, detail="번들 형식 오류: generations 배열 없음")
    # import_bundle_payload 로 위임 — provider/creators 이름 맵까지 적용(작성자가 user_xxx 아닌
    # 이름으로 뜨게). 파일 가져오기(import_share_file)와 동일 경로 → 표기 일관성 보장.
    return repo.import_bundle_payload(bundle, DEFAULT_WORKER_ID)


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
    acc = getattr(request.state, "account", None)
    account_uid = acc.get("creator_uid") if acc else None
    return repo.list_creators(account_uid=account_uid, tab=tab, project_id=project_id)


class CreatorNameIn(BaseModel):
    name: str


@router.put("/creators/{uid}")
def rename_creator(uid: str, body: CreatorNameIn):
    """생성자 uid 에 이름 부여(CLI 가 uid→이름을 안 주므로 직접 라벨)."""
    repo.set_creator_name(uid, body.name)
    return {"ok": True}


@router.post("/creators/{uid}/claim")
def claim_creator(uid: str):
    """이 생성자 uid 를 '나'로 지정 — 이후 그 작성자의 작업이 내 작업(is_mine)으로 잡히고
    제공자 이름이 표시된다. 팀 워크스페이스 동기화 데이터만으론 내 작업을 못 가르므로 1회 지정."""
    return repo.set_my_creator(uid)


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
    gen = repo.get_generation(gen_id)
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
    gen = repo.get_generation(gen_id)
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
    gen = repo.get_generation(gen_id)
    if not gen:
        raise HTTPException(status_code=404, detail="generation 없음")
    require_edit_generation(request, gen)  # 본인/admin 만 — 계보 기록도 수정 가드와 동일
    repo.record_derived_parents(gen_id, body.parent_ids)
    viewer_uid, read_all = _viewer_scope(request)
    return repo.get_history(gen_id, viewer_uid=viewer_uid, read_all=read_all)


@router.put("/generations/{gen_id}/tags", response_model=GenerationOut)
def set_tags(gen_id: str, body: TagsIn, request: Request):
    gen = repo.get_generation(gen_id)
    if not gen:
        raise HTTPException(status_code=404, detail="generation 없음")
    require_edit_generation(request, gen)  # 본인/admin 만 수정
    repo.set_tags(gen_id, body.tags)
    return repo.get_generation(gen_id)


@router.delete("/tags/{tag}")
def delete_tag(tag: str):
    """태그를 모든 generation 에서 전역 삭제(에셋 T 패널 ✕ 와 동일)."""
    return {"removed": repo.delete_tag_everywhere(tag)}


@router.post("/generations/clear-failed")
def clear_failed():
    """힉스필드에 안 올라간 로컬 유령 실패(failed + job_id 없음)만 일괄 삭제."""
    return {"removed": repo.delete_failed_orphans()}


@router.post("/generations/verify-higgsfield")
async def verify_higgsfield():
    """job_id 가진 모든 generation 을 generate get 으로 검증 → 힉스필드에서 삭제된 것
    (hf_missing=1) 표시. '로컬 보기'/흐림 처리에 반영. 무료 호출(생성 아님)."""
    gens = repo.gens_with_job_id()
    sem = asyncio.Semaphore(8)  # 동시 CLI 호출 제한

    async def check(gen_id: str, job_id: str):
        async with sem:
            exists = await cli_bridge.job_exists(job_id)
            return gen_id, exists  # True/False/None(확인불가)

    results = await asyncio.gather(*(check(g, j) for g, j in gens))
    missing = 0
    for gen_id, exists in results:
        if exists is None:
            continue  # 확인 불가 → 상태 변경 안 함
        repo.set_hf_missing(gen_id, not exists)
        if not exists:
            missing += 1
    return {"checked": len(gens), "missing": missing}


@router.delete("/generations/{gen_id}")
def delete_generation(gen_id: str, request: Request):
    """generation 1건 휴지통행(soft delete). 우리 카탈로그에서만 숨김 —
    힉스필드 원본엔 영향 없음. '지운 생성물 보기' 토글로 흐리게 재표시·복구 가능."""
    gen = repo.get_generation(gen_id)
    if gen:
        require_edit_generation(request, gen)  # 본인/admin 만 삭제
    return {"deleted": repo.delete_generation(gen_id)}


@router.post("/generations/{gen_id}/restore")
def restore_generation(gen_id: str, request: Request):
    """휴지통에서 복구 — 카탈로그에 정상 표시로 되돌림."""
    gen = repo.get_generation(gen_id)
    if gen:
        require_edit_generation(request, gen)
    return {"restored": repo.restore_generation(gen_id)}


@router.put("/generations/{gen_id}/color", response_model=GenerationOut)
def set_color(gen_id: str, body: ColorIn, request: Request):
    gen = repo.get_generation(gen_id)
    if not gen:
        raise HTTPException(status_code=404, detail="generation 없음")
    require_edit_generation(request, gen)  # 본인/admin 만 수정
    repo.set_color(gen_id, body.color)
    return repo.get_generation(gen_id)


@router.put("/generations/{gen_id}/source", response_model=GenerationOut)
def set_source(gen_id: str, body: SourceIn, request: Request):
    """소스 라이브러리 등록/해제(@이름). 등록하면 @ 피커에 노출된다."""
    gen = repo.get_generation(gen_id)
    if not gen:
        raise HTTPException(status_code=404, detail="generation 없음")
    require_edit_generation(request, gen)  # 본인/admin 만 수정
    repo.set_source(gen_id, body.name, body.is_source)
    return repo.get_generation(gen_id)


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
    gen = repo.get_generation(gen_id)
    if not gen:
        raise HTTPException(status_code=404, detail="generation 없음")
    require_edit_generation(request, gen)  # gen 자체 코멘트 필드 수정 — 본인/admin 만
    repo.set_comment(gen_id, body.comment)
    return repo.get_generation(gen_id)


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


@router.get("/generations/{gen_id}/comments")
def list_gen_comments(gen_id: str, request: Request):
    """생성본 코멘트 스레드(작성자·시각 포함, 오래된→최신)."""
    gen = repo.get_generation(gen_id)
    if not gen:
        raise HTTPException(status_code=404, detail="generation 없음")
    require_view_generation(request, gen)  # 비공개 남의 코멘트 열람 차단(공유/본인만)
    return repo.list_generation_comments(gen_id, actor_id(request))


@router.post("/generations/{gen_id}/comments")
def add_gen_comment(gen_id: str, body: GenCommentAddIn, request: Request):
    gen = repo.get_generation(gen_id)
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


@router.put("/generation-comments/{comment_id}")
def edit_gen_comment(comment_id: str, body: GenCommentEditIn, request: Request):
    text = (body.text or "").strip()
    if not text:
        raise HTTPException(status_code=400, detail="빈 코멘트")
    try:
        repo.edit_generation_comment(comment_id, actor_id(request), text)
    except PermissionError as e:
        raise HTTPException(status_code=403, detail=str(e))
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))
    return {"ok": True}


@router.delete("/generation-comments/{comment_id}")
def delete_gen_comment(comment_id: str, request: Request):
    try:
        repo.delete_generation_comment(comment_id, actor_id(request))
    except PermissionError as e:
        raise HTTPException(status_code=403, detail=str(e))
    return {"ok": True}


@router.post("/generations/{gen_id}/comments/read")
def read_gen_comments(gen_id: str, body: GenCommentReadIn, request: Request):
    gen = repo.get_generation(gen_id)
    if not gen:
        raise HTTPException(status_code=404, detail="generation 없음")
    require_view_generation(request, gen)
    repo.mark_generation_comments_read(actor_id(request), gen_id)
    return {"ok": True}


@router.post("/generation-comments/{comment_id}/seen")
def seen_gen_comment(comment_id: str, request: Request):
    """코멘트 한 건 확인 처리(패널에서 NEW 코멘트 클릭). 개인 상태라 멱등·가벼운 처리."""
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
async def cache_one(gen_id: str):
    gen = repo.get_generation(gen_id)
    if not gen:
        raise HTTPException(status_code=404, detail="generation 없음")
    res = await cache_generation_media(gen)
    res["generation"] = repo.get_generation(gen_id)
    return res


@router.post("/cache-all")
async def cache_all():
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

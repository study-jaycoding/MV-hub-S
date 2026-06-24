"""공유·가져오기 라우터 (Phase 5, 로컬 구현).

⚠️ 스코프: 원격 공유 서버(PostgreSQL + MinIO)는 의도적으로 보류했다.
publish/import + history 를 로컬 단일 SQLite 에 구현해 전체 루프
(발행 → 팀 공유 탭 → 가져오기 → history)가 로컬에서 동작하게 한다.
원격 서버 연동은 이 라우터의 구현만 교체하면 되도록 repo 계층 뒤에 격리돼 있다.

CLAUDE.md 원칙 2(명시적 발행만), 3(원본 보존), 4(history 기록).
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException, Request

from . import _proxy
from .. import rbac, repo
from ..config import DEFAULT_WORKER_ID
from ..deps import (
    account_global_roles,
    current_account,
    require_edit_generation,
    require_project_role,
)
from ..models import GenerationOut, ImportIn, PublishIn

router = APIRouter(prefix="/api", tags=["share"])


@router.post("/generations/{gen_id}/publish", response_model=GenerationOut)
def publish(gen_id: str, body: PublishIn, request: Request):
    """generation 을 팀에 발행한다(명시적). 한 generation 은 0~1개의 share.
    발행 = share-set 에 추가(서버 발행은 publish-to-shared 번들 경로가 담당)."""
    gen = repo.get_generation(gen_id)
    if not gen:
        raise HTTPException(status_code=404, detail="generation 없음")
    require_edit_generation(request, gen)  # 공유는 본인(또는 admin)만 — 남의 작업 공유 불가
    if gen["status"] != "done":
        raise HTTPException(status_code=409, detail="완료된 생성만 발행할 수 있음")
    shared_by = body.shared_by or gen["worker_id"] or DEFAULT_WORKER_ID
    repo.publish(gen_id, shared_by, body.visibility)
    return repo.get_generation(gen_id)


@router.post("/generations/{gen_id}/unpublish", response_model=GenerationOut)
def unpublish(gen_id: str, request: Request):
    """팀 공유 해제 — share 행을 제거한다(내가 공유한 것을 되돌림).
    ⚠️ 최종(골드)인 항목은 공유 해제 불가 — '최종인데 공유 안 됨' 모순 차단(먼저 최종 해제)."""
    gen = repo.get_generation(gen_id)
    if not gen:
        raise HTTPException(status_code=404, detail="generation 없음")
    require_edit_generation(request, gen)  # 공유 해제는 본인(또는 admin)만
    if gen.get("is_final"):
        raise HTTPException(
            status_code=409, detail="최종(골드)으로 지정된 항목은 공유를 해제할 수 없습니다 (먼저 최종 해제)"
        )
    # 로컬 우선: 발행은 번들로 서버에 올라가 있으므로 '서버 해제'가 진실이다. 서버를 먼저 호출해
    # 성공해야 로컬도 해제한다 — 실패(서버 다운/권한/만료)를 삼키면 "로컬은 해제됨, 팀엔 그대로
    # 노출"이라는 프라이버시 누수가 무음으로 생긴다. 단 404(서버에 이미 없음)는 목표 달성으로 간주.
    if _proxy.proxying():
        # 서버는 번들 앵커(job_id)로 안다 → 로컬 id 그대로 위임하면 항상 404 가 떠
        # "서버에 이미 없음=성공"으로 오인, 로컬만 해제되고 팀엔 노출이 남는 누수가 났다.
        local_id, server_id = repo.finalize_id_map(gen_id)
        try:
            _proxy.proxy_json("POST", f"/api/generations/{server_id}/unpublish")
        except HTTPException as e:
            if e.status_code != 404:
                raise  # 서버 전파 실패 → 로컬도 해제하지 않아 상태 불일치를 막는다
    repo.unpublish(gen_id)
    return repo.get_generation(gen_id)


# ── v02 CMS — Supervisor 최종(골드) 선별 (로드맵 PART 2) ────────────────────
def _finalizer_uid(request: Request) -> str | None:
    """최종 지정자 uid — 로그인 계정의 creator_uid, 없으면 제공자(나) uid."""
    acc = current_account(request)
    if acc and acc.get("creator_uid"):
        return acc["creator_uid"]
    try:
        return repo.get_provider().get("uid")
    except Exception:  # noqa: BLE001
        return None


@router.post("/generations/{gen_id}/finalize", response_model=GenerationOut)
def finalize(gen_id: str, request: Request):
    """생성본을 최종(골드)으로 지정 — 그 프로젝트의 Supervisor 만(검수권). AUTH off 면 통과.
    최종은 곧 후보 확정이므로 공유(share)가 없으면 함께 발행한다(게이트 아님: 공유는 이미 자유).
    로컬 우선: 골드는 '공유된 항목의 서버 상태'다. 프록시 모드면 (필요시 번들 발행 후) 서버에
    finalize 를 위임하고 — 역할 검증·골드 상태는 서버가 가진다 — 내 로컬 카드에도 골드를 미러한다."""
    gen = repo.get_generation(gen_id)
    if _proxy.proxying():
        # 로컬 id ↔ 서버 id(번들 앵커=job_id)가 다르다 → 변환.
        # 내 작업·히스토리(로컬 id)로 finalize 하면 서버는 job_id 로 알기에 그대로 위임 시 404 가 났다.
        local_id, server_id = repo.finalize_id_map(gen_id)
        # 내 비공개 로컬 항목이면 먼저 번들 발행(서버에 올라가야 팀이 보고 골드도 거기 남음).
        newly_published = False
        if gen is not None and not gen.get("shared"):
            if gen["status"] != "done":
                raise HTTPException(status_code=409, detail="완료된 생성만 최종 지정할 수 있음")
            from .publish import publish_bundle_to_server

            publish_bundle_to_server([local_id or gen_id])
            newly_published = True
        try:
            out = _proxy.proxy_json("POST", f"/api/generations/{server_id}/finalize")
        except Exception:
            # 부분 실패 보상: 이번 finalize 때문에 '새로' 공유한 거라면 되돌려 비공개를 유지한다
            # (골드는 안 됐는데 공유만 새어 나가는 누수 방지). 원래 공유 상태였으면 건드리지 않음.
            if newly_published:
                try:
                    _proxy.proxy_json("POST", f"/api/generations/{server_id}/unpublish")
                except Exception:  # noqa: BLE001
                    pass
                if local_id:
                    repo.unpublish(local_id)
            raise
        if local_id:  # 내 로컬 카드에도 골드 미러(tab=my·히스토리 즉시 반영)
            repo.set_final(local_id, True, _finalizer_uid(request))
        return out
    # 비프록시(서버 본체/단독 모드): 로컬에서 직접 처리.
    if not gen:
        raise HTTPException(status_code=404, detail="generation 없음")
    if gen["status"] != "done":
        raise HTTPException(status_code=409, detail="완료된 생성만 최종 지정할 수 있음")
    if gen.get("project_id"):
        # 골드(최종) 결정권 = 그 프로젝트의 SUPERVISOR 만(PM 은 생성·멤버배치 역할이라 제외).
        # 전역 admin 은 최상위 관리자라 예외로 통과.
        if not rbac.has_any_global_role(account_global_roles(request), rbac.ADMIN):
            require_project_role(request, gen["project_id"], rbac.SUPERVISOR)
    else:
        # 프로젝트 미배정 → 검수자(Supervisor) 개념이 없다. 본인/admin 만(남의 비공개 강제 공유 차단).
        require_edit_generation(request, gen)
    if not gen.get("shared"):  # 최종 = 후보 확정 → 공유 동반(잠금은 unpublish 가드)
        repo.publish(gen_id, gen["worker_id"] or DEFAULT_WORKER_ID, "team")
    repo.set_final(gen_id, True, _finalizer_uid(request))
    return repo.get_generation(gen_id)


@router.post("/generations/{gen_id}/unfinalize", response_model=GenerationOut)
def unfinalize(gen_id: str, request: Request):
    """최종(골드) 해제 → 일반 공유 상태로 복귀(공유는 유지). Supervisor 만."""
    gen = repo.get_generation(gen_id)
    if _proxy.proxying():
        local_id, server_id = repo.finalize_id_map(gen_id)
        out = _proxy.proxy_json("POST", f"/api/generations/{server_id}/unfinalize")
        if local_id:
            repo.set_final(local_id, False)
        return out
    if not gen:
        raise HTTPException(status_code=404, detail="generation 없음")
    if gen.get("project_id"):
        # 골드(최종) 결정권 = 그 프로젝트의 SUPERVISOR 만(PM 은 생성·멤버배치 역할이라 제외).
        # 전역 admin 은 최상위 관리자라 예외로 통과.
        if not rbac.has_any_global_role(account_global_roles(request), rbac.ADMIN):
            require_project_role(request, gen["project_id"], rbac.SUPERVISOR)
    else:
        require_edit_generation(request, gen)  # 미배정 → 본인/admin 만
    repo.set_final(gen_id, False)
    return repo.get_generation(gen_id)


# ── 제공자 신원 ───────────────────────────────────────────────────────────
@router.get("/provider")
def get_provider() -> dict[str, Any]:
    """내 제공자 신원 {uid, name, email}. 작성자 표기의 기준."""
    return repo.get_provider()


@router.post("/generations/{gen_id}/import", response_model=GenerationOut, status_code=201)
def import_to_workspace(gen_id: str, body: ImportIn, request: Request):
    """공유 항목을 내 워크스페이스로 복제(프롬프트·레퍼런스 보존) + history."""
    src = repo.get_generation(gen_id)
    if not src and _proxy.proxying():
        # 팀 탭은 서버 id(job_id)로 표시 → 내 로컬 항목이면 job_id 로 재해석해 찾는다.
        # (남의 공유본은 로컬에 원본이 없어 여전히 404 — 그건 별개 사안.)
        local_id, _ = repo.finalize_id_map(gen_id)
        if local_id and local_id != gen_id:
            gen_id = local_id
            src = repo.get_generation(gen_id)
    if not src:
        raise HTTPException(status_code=404, detail="원본 generation 없음")
    if not src["shared"]:
        raise HTTPException(status_code=409, detail="공유되지 않은 항목은 가져올 수 없음")
    # 복제본은 가져온 계정 소유로 — house uid 로 떨어지면 내 작업에 안 잡힘(격리 일관성).
    acc = current_account(request)
    creator_uid = acc.get("creator_uid") if acc else None
    worker_id = body.worker_id or DEFAULT_WORKER_ID
    child_id = repo.import_generation(gen_id, worker_id, creator_uid=creator_uid)
    child = repo.get_generation(child_id)
    if not child:
        raise HTTPException(status_code=500, detail="복제 실패")
    return child

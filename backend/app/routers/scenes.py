"""캔버스 씬 DB 백업 라우터 — 브라우저 localStorage(원본)의 미러·복구.

프록시 모드에서도 로컬 처리(_proxy._LOCAL_PREFIXES '/api/scenes') — 개인 편집물은 로컬 DB 원칙.
owner 는 항상 서버가 actor_id 로 결정한다(클라는 owner 를 보내지 않음 — 계정 혼선 방지).
"""

from __future__ import annotations

from typing import Optional

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

from .. import repo
from ..deps import actor_id

router = APIRouter(prefix="/api/scenes", tags=["scenes"])


class SceneUpsertIn(BaseModel):
    id: str = Field(max_length=200)
    name: Optional[str] = None
    data: str  # 씬 JSON 원문(프론트 직렬화 그대로 보관)
    # 이 창이 마지막으로 서버와 맞춘 지문(""=모름). 없으면(옛 앱) 지금처럼 덮는다 — 판이 다르면 사본으로(Jay 결정 1A).
    base_hash: Optional[str] = None


class SceneSyncIn(BaseModel):
    project_id: str = ""  # 현재 씬은 전역('') — 미래 프로젝트별 분리용 자리
    upserts: list[SceneUpsertIn] = []
    deleted_ids: list[str] = []
    # 지울 씬의 판 — 행 지문이 다르면 남긴다(옛 창이 새 내용을 지우지 않게). 칸을 보냈는데 빠진 id 는 '모름'이라 남긴다. 없음(옛 앱) = 지금처럼 지운다.
    delete_bases: Optional[dict[str, str]] = None


class CardLinkIn(BaseModel):
    scene_id: str
    card_id: str
    generation_id: str


class CardLinkSyncIn(BaseModel):
    added: list[CardLinkIn] = []     # [구클라] 자동 백필 — backfill 로 해석(tombstone 해제 불가)
    backfill: list[CardLinkIn] = []  # 자동 스캔 — 새 행만, 제거 표시를 절대 해제하지 않음
    explicit: list[CardLinkIn] = []  # 사용자 의도(undo 부활 등) — 제거 표시 해제 허용
    removed: list[CardLinkIn] = []   # 카드에서 뺌(행 삭제가 아니라 표시 — repo 주석 참고)


@router.get("/backup")
def list_scene_backups(request: Request, project_id: str = "", include_data: bool = False):
    """내 백업 목록 — 기본 메타만(변경분 대조), include_data=1 은 복구용 전체."""
    return {
        "items": repo.list_scene_backups(actor_id(request), project_id, include_data)
    }


@router.put("/backup")
def sync_scene_backups(body: SceneSyncIn, request: Request):
    """변경 씬 upsert + 삭제 미러(한 트랜잭션). 로컬이 정답 — 클라 계산 diff 를 그대로 반영."""
    try:
        res = repo.sync_scene_backups(
            actor_id(request),
            body.project_id,
            [u.model_dump(exclude_unset=True) for u in body.upserts],  # base_hash 를 안 보낸 옛 앱은 칸 자체가 없다
            body.deleted_ids,
            body.delete_bases,
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    return {"ok": True, **res}


@router.get("/cards")
def list_scene_card_links(request: Request, scene_id: str = ""):
    """카드 소속 — scene_id 를 주면 그 씬만(씬 열 때), 없으면 전부(백필 대조용)."""
    return {"items": repo.list_scene_card_links(actor_id(request), scene_id or None)}


@router.put("/cards")
def sync_scene_card_links(body: CardLinkSyncIn, request: Request):
    """담김/뺌/부활 반영. 더하기 전용이라 이 요청이 남의 브라우저 기록을 지우는 일은 없다."""
    try:
        res = repo.sync_scene_card_links(
            actor_id(request),
            [a.model_dump() for a in [*body.added, *body.backfill]],
            [r.model_dump() for r in body.removed],
            explicit=[e.model_dump() for e in body.explicit],
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    return {"ok": True, **res}

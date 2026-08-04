"""캔버스 씬 DB 백업 라우터 — 브라우저 localStorage(원본)의 미러·복구.

프록시 모드에서도 로컬 처리(_proxy._LOCAL_PREFIXES '/api/scenes') — 개인 편집물은 로컬 DB 원칙.
owner 는 항상 서버가 actor_id 로 결정한다(클라는 owner 를 보내지 않음 — 계정 혼선 방지).
"""

from __future__ import annotations

from typing import Optional

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

from .. import repo
from ..deps import actor_id

router = APIRouter(prefix="/api/scenes", tags=["scenes"])


class SceneUpsertIn(BaseModel):
    id: str
    name: Optional[str] = None
    data: str  # 씬 JSON 원문(프론트 직렬화 그대로 보관)


class SceneSyncIn(BaseModel):
    project_id: str = ""  # 현재 씬은 전역('') — 미래 프로젝트별 분리용 자리
    upserts: list[SceneUpsertIn] = []
    deleted_ids: list[str] = []


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
            [u.model_dump() for u in body.upserts],
            body.deleted_ids,
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    return {"ok": True, **res}

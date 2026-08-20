"""알림 센터 API — 기존 생성본 코멘트 seen 모델의 조회 뷰."""

from __future__ import annotations

from fastapi import APIRouter, Query, Request

from .. import repo
from ..deps import actor_id

router = APIRouter(prefix="/api/notifications", tags=["notifications"])


@router.get("/comments")
def list_comment_notifications(
    request: Request,
    limit: int = Query(50, ge=1, le=100),
):
    return repo.list_comment_notifications(actor_id(request), limit)


@router.post("/comments/seen-all")
def seen_all_comment_notifications(request: Request):
    seen = repo.mark_all_comment_notifications_seen(actor_id(request))
    return {"ok": True, "seen": seen}

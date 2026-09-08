"""알림 센터 API — 기존 생성본 코멘트 seen 모델의 조회 뷰."""

from __future__ import annotations

from fastapi import APIRouter, Query, Request

from .. import deps, rbac, repo
from ..deps import account_global_roles, actor_id

router = APIRouter(prefix="/api/notifications", tags=["notifications"])


def _read_all(request: Request) -> bool:
    """단독 모드(AUTH off)·전역 read_all(admin/PM/PD) 이면 가시성 제한 없음 — projects.py 팀 집계와 같은 판정."""
    return (not deps.AUTH_ENABLED) or rbac.has_global_cap(account_global_roles(request), "read_all")


@router.get("/comments")
def list_comment_notifications(
    request: Request,
    limit: int = Query(50, ge=1, le=100),
):
    # 답글 알림은 그 생성물이 '지금도 내게 보이는' 것만 — 권한을 잃은 뒤 달린 답글의 본문·썸네일이
    # 알림으로 새는 것을 막는다(코덱스 레인C C2). 판정은 목록(team 탭)과 같은 경계.
    return repo.list_comment_notifications(actor_id(request), limit, read_all=_read_all(request))


@router.post("/comments/seen-all")
def seen_all_comment_notifications(request: Request):
    seen = repo.mark_all_comment_notifications_seen(actor_id(request), read_all=_read_all(request))
    return {"ok": True, "seen": seen}

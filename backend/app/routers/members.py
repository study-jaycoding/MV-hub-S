"""멤버·전역역할 라우터 (관리자 창) — 로드맵 PART 1 / §4-5.

멤버 = 생성자(creator). 전역 역할(복수 가능)을 부여·표시한다.
역할 부여는 grant_global 역량(admin)만 — AUTH_ENABLED 일 때 강제, off 면 통과.
"""

from __future__ import annotations

from fastapi import APIRouter, Request

from .. import repo
from ..deps import require_global_cap
from ..models import GlobalRolesIn, MemberOut

router = APIRouter(prefix="/api/members", tags=["members"])


@router.get("", response_model=list[MemberOut])
def list_members(request: Request):
    # 멤버 목록(이름·역할)은 모든 로그인 사용자가 조회 가능 — 프로젝트 팀원 검색·배정에 필요.
    # (민감정보 아님. 실제 역할 '부여'는 PATCH 쪽 권한 가드로 막는다.)
    return repo.list_members()


@router.patch("/{uid}/global-roles", response_model=list[MemberOut])
def set_member_global_roles(uid: str, body: GlobalRolesIn, request: Request):
    """v02 전역 역할(복수) 부여 — grant_global 역량(admin)만. 갱신된 멤버 목록 반환."""
    require_global_cap(request, "grant_global")
    repo.set_member_global_roles(uid, body.global_roles)
    return repo.list_members()

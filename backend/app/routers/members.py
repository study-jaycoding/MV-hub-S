"""멤버·전역역할 라우터 (관리자 창) — 로드맵 PART 1 / §4-5.

멤버 = 생성자(creator). 전역 역할(복수 가능)을 부여·표시한다.
역할 부여는 grant_global 역량(admin)만 — AUTH_ENABLED 일 때 강제, off 면 통과.
"""

from __future__ import annotations

from fastapi import APIRouter, Request

from .. import rbac, repo
from ..config import AUTH_ENABLED
from ..deps import account_global_roles, current_account, require_global_cap
from ..models import GlobalRolesIn, MemberOut

router = APIRouter(prefix="/api/members", tags=["members"])


def _viewer_uid(request: Request):
    """'나'(is_mine) 판정용 요청 계정 creator_uid — plain 신원(actor). 없으면 None(→provider 폴백).
    ★account_scope_uid(\\x00/acct: 스코프값)가 아니라 실제 계정 uid 를 써야 is_mine 이 요청자 기준."""
    acc = current_account(request)
    return acc.get("creator_uid") if acc else None


def _can_see_account_details(request: Request) -> bool:
    """계정 상세(email·status·전역역할)를 볼 자격 — 관리(grant_global=admin)·PM(grant_project_role).
    AUTH off(단독 모드)는 보안 경계가 없어 항상 True."""
    if not AUTH_ENABLED:
        return True
    roles = account_global_roles(request)
    return rbac.has_global_cap(roles, "grant_global") or rbac.has_global_cap(
        roles, "grant_project_role"
    )


@router.get("", response_model=list[MemberOut])
def list_members(request: Request):
    """멤버 목록. 이름·uid·생성물수는 모두에게(팀원 검색·배정용). 계정 상세(email·status·전역역할)는
    관리/PM 권한자에게만 — 일반 사용자에겐 마스킹(누가 admin/PM인지, 이메일·가입상태를 감춘다).
    프론트는 email 없으면 shortUid 폴백, 자기 권한은 /api/me 로 계산하므로 무변경."""
    members = repo.list_members(viewer_uid=_viewer_uid(request))
    if not _can_see_account_details(request):
        for m in members:
            m["email"] = None
            m["status"] = None
            m["global_roles"] = []
    return members


@router.patch("/{uid}/global-roles", response_model=list[MemberOut])
def set_member_global_roles(uid: str, body: GlobalRolesIn, request: Request):
    """v02 전역 역할(복수) 부여 — grant_global 역량(admin)만. 갱신된 멤버 목록 반환."""
    require_global_cap(request, "grant_global")
    repo.set_member_global_roles(uid, body.global_roles)
    return repo.list_members(viewer_uid=_viewer_uid(request))

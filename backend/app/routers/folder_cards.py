"""폴더 카드 — 공유 & 리뷰 탭에서 고른 폴더의 하위 폴더마다 카드 한 장(건수·표지) + 팀이 같이 보는 '대표' 지정.

팀 공유물 전용이라 로컬 허브는 두 경로 모두 공유 서버로 넘긴다(목록 `tab=team` 과 같다). 옛 공유 서버에는
이 경로가 없어 404 "Not Found" 가 그대로 돌아가고, 화면은 그것을 보고 묶음 보기를 끈다.

대표 지정(PUT)은 라이브러리 변경으로 통보된다(`mutation_notify`) — 다만 그 통보는 **바꾼 계정의 창**에만 간다.
다른 팀원의 화면은 팀 목록의 주기 조회(15초) 때 같이 바뀐다.
"""

from __future__ import annotations

from typing import Optional

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

from . import _proxy
from .. import active_account, rbac, repo
from ..config import AUTH_ENABLED
from ..deps import account_global_roles, account_scope_uid, actor_id
# 표지 행을 팀 목록 행과 같은 주소 규칙(원격 원본 우선)으로 내보내기 위해 목록 라우터의 것을 그대로 쓴다.
from .library import _prefer_remote_source_urls

router = APIRouter(prefix="/api/projects", tags=["projects"])


class FolderCoverIn(BaseModel):
    folder_path: str = Field(min_length=1, max_length=1000)
    generation_id: str = Field(min_length=1, max_length=200)


def _team_scope(request: Request) -> tuple[Optional[list[str]], Optional[str]]:
    """팀 목록과 같은 가시성 — (내 멤버 프로젝트 | None = 전체 공유물, 보는 계정 uid).

    전체를 볼 수 있어도(read_all) 보는 계정 uid 는 따로 돌려준다 — 남의 개인 메타를 가리는 기준이다.
    """
    viewer = account_scope_uid(request)
    read_all = (not AUTH_ENABLED) or rbac.has_global_cap(account_global_roles(request), "read_all")
    return (None if read_all else repo.my_member_projects(viewer or "\x00")), viewer


@router.get("/{pid}/folder-cards")
def project_folder_cards(
    pid: str, request: Request, parent: str = "", workspace_id: Optional[str] = None,
):
    """`parent` 바로 아래 폴더마다 {path, name, count, rep, cover} + parent 에 직접 든 수(own_count)."""
    # 접수한 계정의 토큰·DB 로 끝까지 간다 — 서버를 기다리는 사이 계정이 바뀌어도 섞이지 않게.
    with active_account.pinned_account_scope():
        if _proxy.proxying():
            return _proxy.proxy_get(f"/api/projects/{pid}/folder-cards", request)
        member_projects, viewer = _team_scope(request)
        data = repo.folder_cards(
            pid, parent, team_member_projects=member_projects, viewer_uid=viewer,
            workspace_id=(workspace_id or "").strip() or None,
        )
        _prefer_remote_source_urls([folder["cover"] for folder in data["folders"]])
        return data


@router.put("/{pid}/folder-cover")
def set_project_folder_cover(pid: str, body: FolderCoverIn, request: Request):
    """그 폴더의 대표를 정한다 — 팀 목록에서 볼 수 있고 그 폴더(하위 포함)에 든 공유물이면 누구나."""
    with active_account.pinned_account_scope():
        if _proxy.proxying():
            return _proxy.proxy_json(
                "PUT", f"/api/projects/{pid}/folder-cover", body=body.model_dump(),
            )
        member_projects, viewer = _team_scope(request)
        try:
            return repo.set_folder_cover(
                pid, body.folder_path, body.generation_id,
                team_member_projects=member_projects, viewer_uid=viewer, set_by=actor_id(request),
            )
        except LookupError:
            raise HTTPException(status_code=404, detail="이 폴더에서 볼 수 있는 공유물이 아닙니다") from None

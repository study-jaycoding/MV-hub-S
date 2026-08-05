"""Assets 라우터들이 공유하는 HTTP 접근 정책."""

from __future__ import annotations

from fastapi import HTTPException, Request

from .. import rbac, repo
from ..config import AUTH_ENABLED
from ..deps import require_project_role
from ..services.request_guards import require_loopback_request


def require_mount_manager(request: Request) -> None:
    """절대경로 마운트 등록·해제는 로그인한 로컬 사용자만 허용한다."""
    if AUTH_ENABLED:
        if getattr(request.state, "account", None) is None:
            raise HTTPException(status_code=401, detail="로그인이 필요합니다")
        require_loopback_request(request, "폴더 등록은 로컬 허브에서만 가능합니다")
        return
    require_loopback_request(request, "폴더 등록은 서버 로컬에서만 가능합니다")


def require_local_assets(request: Request) -> None:
    """공유 서버에서 파일 I/O가 원격 서버 디스크를 노출하지 않게 한다."""
    if AUTH_ENABLED:
        require_loopback_request(request, "Assets 파일 기능은 로컬 허브에서만 사용할 수 있습니다")


def require_asset_comment_access(
    project: str,
    request: Request,
    *,
    write: bool,
) -> None:
    """공유 Assets 코멘트의 프로젝트 멤버십 경계를 검사한다."""
    if not AUTH_ENABLED:
        return
    project_row = repo.get_project_by_name(project)
    if not project_row:
        raise HTTPException(
            status_code=403,
            detail="등록된 프로젝트의 Assets 코멘트만 사용할 수 있습니다",
        )
    require_project_role(
        request,
        project_row["id"],
        *rbac.PROJECT_ROLES,
        read_only=not write,
    )

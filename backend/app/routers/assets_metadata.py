"""Assets 개인 메타데이터와 팀 코멘트 HTTP API.

파일 탐색·업로드와 달리 메타데이터는 계정 DB, 코멘트는 공유 서버 DB가 정답이다.
이 라우터는 그 데이터 소유권 경계를 유지하고 디스크 파일 처리에는 관여하지 않는다.
"""

from __future__ import annotations

from typing import Any, Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel, Field

from . import _assets_access, _proxy
from .. import repo
from ..deps import actor_id
from ..services.asset_paths import (
    COMBINED_INTERNAL_PROJECT,
    INTERNAL_FOLDERS,
    real_meta_key,
)


router = APIRouter()


class AssetTagsIn(BaseModel):
    project: str
    path: str
    tags: list[str] = Field(default_factory=list)


class AssetCommentIn(BaseModel):
    project: str
    path: str
    comment: Optional[str] = None


class AssetColorIn(BaseModel):
    project: str
    path: str
    color: Optional[str] = None


@router.get("/meta")
def asset_meta(request: Request, project: str = Query(...)):
    """개인 메타에 공유 서버의 코멘트 개수·읽음 상태만 합성한다."""
    if _assets_access.AUTH_ENABLED:
        _assets_access.require_asset_comment_access(project, request, write=False)
    actor = actor_id(request)
    sources = (
        [(folder, folder + "/") for folder in INTERNAL_FOLDERS]
        if project == COMBINED_INTERNAL_PROJECT
        else [(project, "")]
    )
    local: dict[str, Any] = {}
    for real_project, prefix in sources:
        for path, meta in repo.get_asset_meta(real_project, actor).items():
            local[prefix + path] = meta
    if _proxy.proxying():
        for real_project, prefix in sources:
            try:
                remote = _proxy.proxy_json(
                    "GET",
                    "/api/assets/meta",
                    params={"project": real_project},
                    timeout=5,
                )
            except Exception:  # noqa: BLE001 - 코멘트 뱃지는 부가정보다.
                remote = None
            if not isinstance(remote, dict):
                continue
            for path, remote_meta in remote.items():
                if not isinstance(remote_meta, dict):
                    continue
                key = prefix + path
                slot = local.get(key)
                if slot is None:
                    slot = {
                        "is_source": False,
                        "source_name": None,
                        "tags": [],
                        "comment": None,
                        "color": None,
                        "comment_count": 0,
                        "has_unread": False,
                    }
                    local[key] = slot
                slot["comment_count"] = remote_meta.get("comment_count", 0)
                slot["has_unread"] = remote_meta.get("has_unread", False)
    return local


class CommentAddIn(BaseModel):
    project: str
    path: str
    text: str
    author: Optional[str] = None
    parent_id: Optional[str] = None
    muted: bool = False


class CommentEditIn(BaseModel):
    text: str
    worker_id: Optional[str] = None


class CommentReadIn(BaseModel):
    project: str
    path: str
    worker_id: Optional[str] = None


@router.get("/comments")
def list_comments(
    request: Request,
    project: str = Query(...),
    path: str = Query(...),
):
    project, path = real_meta_key(project, path)
    if _proxy.proxying():
        return _proxy.proxy_json(
            "GET",
            "/api/assets/comments",
            params={"project": project, "path": path},
        )
    _assets_access.require_asset_comment_access(project, request, write=False)
    return repo.list_asset_comments(project, path)


@router.post("/comments")
def add_comment(body: CommentAddIn, request: Request):
    project, path = real_meta_key(body.project, body.path)
    if _proxy.proxying():
        return _proxy.proxy_json(
            "POST",
            "/api/assets/comments",
            body={**body.model_dump(), "project": project, "path": path},
        )
    _assets_access.require_asset_comment_access(project, request, write=True)
    text = (body.text or "").strip()
    if not text:
        raise HTTPException(status_code=400, detail="빈 코멘트")
    comment_id = repo.add_asset_comment(
        project,
        path,
        actor_id(request),
        text,
        body.parent_id,
        body.muted,
    )
    return {"id": comment_id}


@router.put("/comments/{comment_id}")
def edit_comment(comment_id: str, body: CommentEditIn, request: Request):
    if _proxy.proxying():
        return _proxy.proxy_json(
            "PUT",
            f"/api/assets/comments/{comment_id}",
            body=body.model_dump(),
        )
    scope = repo.get_asset_comment_scope(comment_id)
    if not scope:
        raise HTTPException(status_code=404, detail="코멘트 없음")
    _assets_access.require_asset_comment_access(scope["project"], request, write=True)
    text = (body.text or "").strip()
    if not text:
        raise HTTPException(status_code=400, detail="빈 코멘트")
    try:
        repo.edit_asset_comment(comment_id, actor_id(request), text)
    except PermissionError as exc:
        raise HTTPException(status_code=403, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    return {"ok": True}


@router.delete("/comments/{comment_id}")
def delete_comment(comment_id: str, request: Request):
    if _proxy.proxying():
        return _proxy.proxy_json("DELETE", f"/api/assets/comments/{comment_id}")
    scope = repo.get_asset_comment_scope(comment_id)
    if not scope:
        raise HTTPException(status_code=404, detail="코멘트 없음")
    _assets_access.require_asset_comment_access(scope["project"], request, write=True)
    try:
        repo.delete_asset_comment(comment_id, actor_id(request))
    except PermissionError as exc:
        raise HTTPException(status_code=403, detail=str(exc)) from exc
    return {"ok": True}


@router.post("/comments/read")
def read_comments(body: CommentReadIn, request: Request):
    project, path = real_meta_key(body.project, body.path)
    if _proxy.proxying():
        return _proxy.proxy_json(
            "POST",
            "/api/assets/comments/read",
            body={**body.model_dump(), "project": project, "path": path},
        )
    _assets_access.require_asset_comment_access(project, request, write=False)
    repo.mark_asset_comments_read(actor_id(request), project, path)
    return {"ok": True}


@router.put(
    "/tags",
    dependencies=[Depends(_assets_access.require_local_assets)],
)
def asset_set_tags(body: AssetTagsIn, request: Request):
    project, path = real_meta_key(body.project, body.path)
    repo.set_asset_tags(project, path, body.tags, actor_id(request))
    return {"ok": True}


@router.put(
    "/comment",
    dependencies=[Depends(_assets_access.require_local_assets)],
)
def asset_set_comment(body: AssetCommentIn, request: Request):
    project, path = real_meta_key(body.project, body.path)
    repo.set_asset_comment(project, path, body.comment, actor_id(request))
    return {"ok": True}


@router.put(
    "/color",
    dependencies=[Depends(_assets_access.require_local_assets)],
)
def asset_set_color(body: AssetColorIn, request: Request):
    project, path = real_meta_key(body.project, body.path)
    repo.set_asset_color(project, path, body.color, actor_id(request))
    return {"ok": True}

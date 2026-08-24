"""공유 서버 릴리스 업데이트 공지 API."""

from __future__ import annotations

import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

from .. import repo
from ..deps import actor_id, require_admin
from ..services.event_journal import journal_audit_event

router = APIRouter(prefix="/api/update-notices", tags=["update-notices"])

_SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
_VERSION_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$")


class ReleaseNoticeIn(BaseModel):
    version: str
    file: str
    sha256: str
    size: int = 0
    created_at: str


class PinIn(BaseModel):
    pinned: bool


class SeenIn(BaseModel):
    revision: int


def _normalized_release(body: ReleaseNoticeIn) -> dict[str, Any]:
    version = body.version.strip()
    file_name = body.file.strip()
    digest = body.sha256.strip().lower()
    if not _VERSION_RE.fullmatch(version):
        raise HTTPException(status_code=400, detail="업데이트 버전 형식이 올바르지 않습니다")
    if (
        not file_name
        or len(file_name) > 180
        or Path(file_name).name != file_name
        or "/" in file_name
        or "\\" in file_name
    ):
        raise HTTPException(status_code=400, detail="업데이트 파일명이 안전하지 않습니다")
    if not _SHA256_RE.fullmatch(digest):
        raise HTTPException(status_code=400, detail="업데이트 SHA256 형식이 올바르지 않습니다")
    if body.size < 0 or body.size > 100 * 1024 * 1024 * 1024:
        raise HTTPException(status_code=400, detail="업데이트 파일 크기가 올바르지 않습니다")
    try:
        released = datetime.fromisoformat(body.created_at.strip().replace("Z", "+00:00"))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail="업데이트 생성 시간이 올바르지 않습니다") from exc
    if released.tzinfo is None:
        released = released.replace(tzinfo=timezone.utc)
    return {
        # 공지 ID도 전체 검증 해시를 써서 서로 다른 릴리스가 같은 앞부분을 가질 때의
        # 충돌을 없앤다. 같은 파일은 sha256 UNIQUE 제약으로 멱등 등록된다.
        "notice_id": f"release-{digest}",
        "version": version,
        "file_name": file_name,
        "sha256": digest,
        "size_bytes": int(body.size),
        "released_at": released.astimezone(timezone.utc).isoformat(timespec="seconds"),
    }


def _public_item(item: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": item["id"],
        "version": item["version"],
        "file": item["file_name"],
        "released_at": item["released_at"],
        "pinned": bool(item["pinned"]),
        "announcement_revision": int(item["announcement_revision"] or 0),
        "announced_at": item.get("announced_at"),
        "unread": bool(item.get("unread")),
    }


def _admin_item(item: dict[str, Any]) -> dict[str, Any]:
    return {
        **_public_item(item),
        "sha256": item["sha256"],
        "size": int(item["size_bytes"] or 0),
    }


@router.get("")
def list_update_notices(request: Request):
    return [_public_item(item) for item in repo.list_announced_release_updates(actor_id(request))]


@router.post("/{notice_id}/seen")
def seen_update_notice(notice_id: str, body: SeenIn, request: Request):
    if body.revision < 1:
        raise HTTPException(status_code=400, detail="공지 번호가 올바르지 않습니다")
    if not repo.mark_release_update_notice_seen(notice_id, body.revision, actor_id(request)):
        raise HTTPException(status_code=409, detail="업데이트 공지가 바뀌었습니다")
    return {"ok": True}


@router.post("/seen-all")
def seen_all_update_notices(request: Request):
    return {"ok": True, "seen": repo.mark_all_release_update_notices_seen(actor_id(request))}


@router.get("/admin/list")
def list_update_notices_admin(request: Request):
    require_admin(request)
    return [_admin_item(item) for item in repo.list_release_update_notices_admin()]


@router.post("/admin/register")
def register_update_notice(body: ReleaseNoticeIn, request: Request):
    require_admin(request)
    item, created = repo.upsert_release_update_notice(**_normalized_release(body))
    journal_audit_event(
        "release_notice_registered" if created else "release_notice_refreshed",
        actor_uid=actor_id(request),
        target_type="release_update_notice",
        target_id=item["id"],
        fields=["version", "file_name", "size_bytes", "released_at"],
        details={"version": item["version"], "created": created},
    )
    return {"ok": True, "created": created, "item": _admin_item(item)}


@router.put("/admin/{notice_id}/pin")
def pin_update_notice(notice_id: str, body: PinIn, request: Request):
    require_admin(request)
    try:
        item = repo.set_release_update_notice_pinned(notice_id, body.pinned)
    except repo.ReleaseNoticeNotFoundError as exc:
        raise HTTPException(status_code=404, detail="업데이트 항목이 없습니다") from exc
    except repo.ReleaseNoticePinnedLimitError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    journal_audit_event(
        "release_notice_pinned" if body.pinned else "release_notice_unpinned",
        actor_uid=actor_id(request),
        target_type="release_update_notice",
        target_id=notice_id,
        fields=["pinned"],
        details={"version": item["version"], "pinned": body.pinned},
    )
    return {"ok": True, "item": _admin_item(item)}


@router.post("/admin/{notice_id}/announce")
def announce_update_notice(notice_id: str, request: Request):
    require_admin(request)
    try:
        item = repo.announce_release_update_notice(notice_id, actor_id(request))
    except repo.ReleaseNoticeNotFoundError as exc:
        raise HTTPException(status_code=404, detail="업데이트 항목이 없습니다") from exc
    journal_audit_event(
        "release_notice_announced",
        actor_uid=actor_id(request),
        target_type="release_update_notice",
        target_id=notice_id,
        fields=["announcement_revision", "announced_at"],
        details={
            "version": item["version"],
            "revision": int(item["announcement_revision"]),
        },
    )
    return {"ok": True, "item": _admin_item(item)}

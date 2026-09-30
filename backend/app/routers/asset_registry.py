"""에셋 대장 API — 공유 서버가 권위. 설계: docs/ASSET_REGISTRY.md.

로컬 허브에서 이 경로는 _LOCAL_PREFIXES 에 없어 데이터 프록시가 공유 서버로 넘긴다. 로컬 허브의 파이썬 코드
(레퍼런스 찾기)는 lookup_for_request 로 부른다 — 위임 모드면 서버에, 아니면(서버 자신·격리 시험) 자기 DB 에 묻는다.
대장은 **후보**일 뿐이다: 부르는 쪽이 자기 마운트에서 파일을 열고 지문까지 확인한 뒤에만 잇는다(Codex P0).
"""

from __future__ import annotations

import logging
from typing import Annotated, Any, Optional

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

from .. import rbac, repo
from ..config import AUTH_ENABLED
from ..db import get_connection
from ..deps import account_global_roles, account_scope_uid, require_global_cap
from ..repo import asset_registry as registry
from ..services.asset_registry import controller
from ..services.operational_logging import log_event
from . import _proxy

router = APIRouter(prefix="/api/asset-registry", tags=["asset-registry"])
_log = logging.getLogger("mvhub.asset_registry")

_MAX_KEYS = 500


_Id = Annotated[str, Field(max_length=64)]  # 번호·프로젝트 id(uuid) 길이 상한 — 큰 본문을 먼저 다 읽지 않게(Codex P2)
_Tail = Annotated[str, Field(max_length=1024)]


class ScanIn(BaseModel):
    project_ids: list[_Id] = Field(default_factory=list, max_length=200)


class ShaKey(BaseModel):
    sha256: str = Field(min_length=64, max_length=64)
    bytes: int = Field(gt=0)


class LookupIn(BaseModel):
    ids: list[_Id] = Field(default_factory=list, max_length=_MAX_KEYS)
    shas: list[ShaKey] = Field(default_factory=list, max_length=_MAX_KEYS)
    tails: list[_Tail] = Field(default_factory=list, max_length=_MAX_KEYS)


def visible_project_ids(request: Optional[Request]) -> Optional[set[str]]:
    """None = 전부(인증 꺼짐·read_all). 아니면 그 계정이 멤버인 프로젝트만 — 프로젝트 목록과 같은 규칙."""
    if not AUTH_ENABLED or request is None:
        return None
    if rbac.has_global_cap(account_global_roles(request), "read_all"):
        return None
    uid = account_scope_uid(request) or "\x00"
    data = repo.list_projects(include_archived=True, member_uid=uid)
    return {str(p.get("id")) for p in data.get("projects") or [] if isinstance(p, dict)}


def lookup_local(body: LookupIn, visible: Optional[set[str]]) -> dict[str, Any]:
    with get_connection() as conn:
        ids = registry.lookup_ids(conn, body.ids, visible)
        shas = registry.lookup_shas(conn, [(k.sha256.lower(), k.bytes) for k in body.shas], visible)
        tails = registry.lookup_tails(conn, body.tails, visible)
        scans = {row["project_id"]: row for row in registry.scan_rows(conn)}
    used = {r["project_id"] for r in ids.values()}
    used |= {r["project_id"] for rows in list(shas.values()) + list(tails.values()) for r in rows}
    projects = {
        pid: {k: scans[pid].get(k) for k in ("state", "complete", "clean", "finished_at")} if pid in scans else None
        for pid in used
    }
    return {"ids": ids, "shas": shas, "tails": tails, "projects": projects}


def lookup_for_request(
    request: Optional[Request], ids: list[str], shas: list[tuple[str, int]], tails: list[str]
) -> Optional[dict[str, Any]]:
    """레퍼런스 찾기(assets.locate)가 대장 후보를 묻는다. 실패·옛 서버(404)·대장 없음이면 None — 부르는 쪽은
    지금의 직접 훑기로 넘어간다. 한 번에 _MAX_KEYS 개까지만 묻는다(넘치는 것은 직접 훑기가 맡는다)."""
    body = LookupIn(
        ids=list(dict.fromkeys(i for i in ids if i))[:_MAX_KEYS],
        shas=[ShaKey(sha256=s, bytes=b) for s, b in list(dict.fromkeys(shas))[:_MAX_KEYS]],
        tails=list(dict.fromkeys(tails))[:_MAX_KEYS],
    )
    if not (body.ids or body.shas or body.tails):
        return None
    try:
        if _proxy.proxying():
            return _proxy.proxy_json("POST", "/api/asset-registry/lookup", body=body.model_dump(), timeout=10)
        return lookup_local(body, visible_project_ids(request))
    except Exception:  # noqa: BLE001 — 대장은 가속·보조일 뿐, 없어도 찾기는 돈다
        log_event(_log, "asset_registry_lookup_failed", level=logging.INFO, exc_info=True)
        return None


@router.post("/lookup")
def lookup(body: LookupIn, request: Request) -> dict[str, Any]:
    return lookup_local(body, visible_project_ids(request))


@router.get("/usage/{registry_asset_id}")
def usage(registry_asset_id: str, request: Request) -> dict[str, Any]:
    """이 번호의 파일을 쓴 생성 기록. 판 확인(version_verified=1)과 가능 연결(0)을 나눠 준다."""
    visible = visible_project_ids(request)
    with get_connection() as conn:
        if not registry.lookup_ids(conn, [registry_asset_id], visible):
            raise HTTPException(status_code=404, detail="없는 번호입니다")
        rows = registry.reference_usage(conn, registry_asset_id)
    if visible is not None:
        rows = [r for r in rows if r.get("project_id") in visible]
    return {
        "verified": [r for r in rows if r.get("version_verified") == 1],
        "possible": [r for r in rows if r.get("version_verified") != 1],
    }


@router.post("/scan")
async def scan(body: ScanIn, request: Request) -> dict[str, Any]:
    """관리자 수동 훑기(첫 전체 훑기는 사람 적은 시간에). 이미 돌고 있으면 409."""
    require_global_cap(request, "system")
    if not controller.enabled:
        raise HTTPException(status_code=503, detail="에셋 대장이 꺼져 있습니다(CONTENT_HUB_ASSET_REGISTRY=1)")
    if not controller.request_scan(body.project_ids or None, mode="manual"):
        raise HTTPException(status_code=409, detail="이미 훑는 중입니다")
    return {"started": True}


@router.get("/status")
def status(request: Request) -> dict[str, Any]:
    require_global_cap(request, "system")
    return controller.status()

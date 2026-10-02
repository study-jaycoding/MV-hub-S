"""에셋 대장 API — 공유 서버가 권위. 설계: docs/ASSET_REGISTRY.md.

로컬 허브에서 이 경로는 _LOCAL_PREFIXES 에 없어 데이터 프록시가 공유 서버로 넘긴다. 로컬 허브의 파이썬 코드
(레퍼런스 찾기)는 lookup_for_request 로 부른다 — 위임 모드면 서버에, 아니면(서버 자신·격리 시험) 자기 DB 에 묻는다.
대장은 **후보**일 뿐이다: 부르는 쪽이 자기 마운트에서 파일을 열고 지문까지 확인한 뒤에만 잇는다(Codex P0).
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
from typing import Annotated, Any, Literal, Optional

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, ConfigDict, Field

from .. import rbac, repo
from ..config import AUTH_ENABLED
from ..db import get_connection
from ..deps import account_global_roles, account_scope_uid, require_global_cap
from ..repo import asset_registry as registry
from ..services.asset_registry import (
    LEASE_TTL_S,
    canonical_unc,
    consume_slot,
    controller,
    leases,
    pm_projects,
    registry_mode,
    save_schedule,
    schedule_status,
)
from ..services.asset_registry_scan import hidden_name
from ..services.media_types import AUDIO_EXTENSIONS, IMAGE_EXTENSIONS, VIDEO_EXTENSIONS
from ..services.operational_logging import log_event
from . import _proxy

_MEDIA = frozenset(IMAGE_EXTENSIONS + VIDEO_EXTENSIONS + AUDIO_EXTENSIONS)  # 훑기 자식과 같은 집합

router = APIRouter(prefix="/api/asset-registry", tags=["asset-registry"])
_log = logging.getLogger("mvhub.asset_registry")

_MAX_KEYS = 500


_Id = Annotated[str, Field(max_length=64)]  # 번호·프로젝트 id(uuid) 길이 상한 — 큰 본문을 먼저 다 읽지 않게(Codex P2)
_Tail = Annotated[str, Field(max_length=1024)]


class ScanIn(BaseModel):
    project_ids: list[_Id] = Field(default_factory=list, max_length=200)


class ModeIn(BaseModel):
    mode: Literal["server", "local"]


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
    try:
        # 입력 검사도 try 안 — 1024자 넘는 경로 꼬리 하나가 묶음 전체를 500 으로 만들지 않게(2026-10-03 점검 L1-4·CXB-2)
        body = LookupIn(
            ids=list(dict.fromkeys(i for i in ids if i))[:_MAX_KEYS],
            shas=[ShaKey(sha256=s, bytes=b) for s, b in list(dict.fromkeys(shas))[:_MAX_KEYS]],
            tails=list(dict.fromkeys(tails))[:_MAX_KEYS],
        )
        if not (body.ids or body.shas or body.tails):
            return None
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
    _require_on(request)
    if registry_mode() != "server":
        raise HTTPException(status_code=409, detail="훑는 곳이 '로컬 · 이 PC' 입니다 — 관리자 PC 에서 훑습니다")
    if not controller.request_scan(body.project_ids or None, mode="manual"):
        raise HTTPException(status_code=409, detail="이미 훑는 중입니다")
    return {"started": True}


@router.get("/status")
def status(request: Request) -> dict[str, Any]:
    require_global_cap(request, "system")
    return controller.status()


@router.post("/mode")
def set_mode(body: ModeIn, request: Request) -> dict[str, Any]:
    """훑는 곳(서버 / 로컬 · 이 PC) — 서버 DB 에 두어 관리자 모두 같게 본다(Jay 2026-09-30). 훑는 중에는 409."""
    _require_on(request)
    if not controller.set_mode(body.mode):
        raise HTTPException(status_code=409, detail="훑는 중이거나 DB 를 정리하는 중이라 지금은 바꿀 수 없습니다")
    log_event(_log, "asset_registry_mode", mode=body.mode, by=account_scope_uid(request) or "local")
    return {"mode": body.mode}


class ScheduleIn(BaseModel):
    kind: Literal["off", "month", "week", "day"]
    day: int = Field(1, ge=1, le=28)  # 매월 — 29~31일은 없는 달이 있어 받지 않는다
    weekday: int = Field(0, ge=0, le=6)  # 매주 — 월요일 0
    hour: int = Field(3, ge=0, le=23)


class ClaimIn(BaseModel):
    runner: str = Field("", max_length=64)


@router.post("/schedule")
def set_schedule(body: ScheduleIn, request: Request) -> dict[str, Any]:
    """자동 훑기 시간(끔·매월·매주·매일 + 시) — 서버 DB 에 두어 관리자 모두 같게(Jay 2026-10-02). 훑는 중에도 저장된다."""
    _require_on(request)
    schedule = save_schedule(body.kind, body.day, body.weekday, body.hour)
    log_event(_log, "asset_registry_schedule", kind=schedule["kind"], by=account_scope_uid(request) or "local")
    return schedule_status()


@router.post("/schedule/claim")
def claim_schedule(body: ClaimIn, request: Request) -> dict[str, Any]:
    """로컬 모드: 관리자 PC 가 60초마다 '이번 회차를 내가 맡나'를 묻는다. 서버 시계로 판정해 회차당 첫 PC 하나만 run.
    동기 라우트라 클라이언트가 끊어도 판정·기록은 끝까지 간다."""
    _require_on(request)
    runner = "".join(ch for ch in body.runner if ch.isprintable())[:40] or "PC"
    ok, _reason, slot, _mark_id = consume_slot(f"pc:{runner}", "local")
    if ok:
        log_event(_log, "asset_registry_scheduled", slot=slot, runner=f"pc:{runner}")
    return {"run": ok, "slot": slot}


def _require_on(request: Request) -> None:
    require_global_cap(request, "system")
    if not controller.enabled:
        raise HTTPException(status_code=503, detail="에셋 대장이 꺼져 있습니다(CONTENT_HUB_ASSET_REGISTRY=1)")


# ── 도우미 PC 훑기(서버가 NAS 를 못 읽을 때, 2026-09-30 Claude 설계·Codex 합의) ─────────────────────────────
# 관리자 PC 의 로컬 허브가 서버에서 자리(lease)를 받아 자기 PC 로 NAS 를 훑고 **완주 결과**를 올린다. 판정·번호 발급은
# 서버의 기존 _apply 그대로(서버만 번호를 만든다). 서버 자체 훑기 코드는 바꾸지 않는다 — 둘은 leases 로 서로 막는다.
HELPER_MAX_FILES = 100_000
_INT_MAX = (1 << 62)  # SQLite 정수(64비트) 안 — 큰 값으로 기록 단계가 500 이 되지 않게(Codex P2)


class HelperLeaseIn(BaseModel):
    project_id: _Id


class HelperLeaseRef(BaseModel):
    lease_id: _Id


class HelperFile(BaseModel):
    """자식 훑기가 내는 한 줄과 같은 모양 — 서버 훑기가 절대 만들지 않는 행이 들어오지 않게 엄격히 받는다(Codex P0)."""

    model_config = ConfigDict(strict=True, extra="forbid")
    p: str = Field(min_length=1, max_length=1024)
    b: int = Field(ge=0, le=1 << 44)
    m: int = Field(ge=0, le=_INT_MAX)
    s: Optional[str] = None
    st: Literal["ok", "undetermined", "pending"]


class HelperStats(BaseModel):
    model_config = ConfigDict(extra="ignore")
    hashed: int = Field(default=0, ge=0, le=_INT_MAX)
    hashed_bytes: int = Field(default=0, ge=0, le=_INT_MAX)
    elapsed_ms: int = Field(default=0, ge=0, le=_INT_MAX)


class HelperResultIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    lease_id: _Id
    seq: int = Field(ge=1, le=10_000)
    complete: bool
    files: list[HelperFile] = Field(default_factory=list, max_length=HELPER_MAX_FILES)
    stats: HelperStats = Field(default_factory=HelperStats)


def _helper_owner(request: Request, need_local: bool = False) -> str:
    """need_local — 새로 훑기를 시작하는 곳(프로젝트 목록·자리)은 훑는 곳이 '로컬'일 때만. 도우미는 503 을 전체 멈춤으로
    받는다(프로젝트 사이에 '서버'로 바뀌면 거기서 멈춘다, Codex). 자리가 살아 있는 동안은 훑는 곳을 못 바꾸므로
    연장·반납·결과는 보지 않는다."""
    _require_on(request)
    if need_local and registry_mode() != "local":
        raise HTTPException(status_code=503, detail="훑는 곳이 '서버' 입니다 — 관리자 창에서 '로컬 · 이 PC' 로 바꿉니다")
    return account_scope_uid(request) or "local"


def _bad_file(index: int, why: str) -> HTTPException:
    # 경로는 돌려주지 않는다(로그·응답에 경로 목록을 남기지 않는다) — 순번과 이유만
    return HTTPException(status_code=422, detail=f"{index}번째 파일을 받을 수 없습니다: {why}")


def _checked_files(files: list[HelperFile]) -> list[registry.RegistryFile]:
    """자식 훑기의 규칙과 같게 거른다: 상대 경로·숨김 조각 없음·render 폴더 밖·미디어 확장자, ok 면 64자 지문과 크기."""
    out: list[registry.RegistryFile] = []
    seen: set[str] = set()
    for i, f in enumerate(files):
        parts = f.p.split("/")
        if "\\" in f.p or ":" in f.p or any(part in ("", ".", "..") for part in parts):
            raise _bad_file(i, "상대 경로가 아닙니다")
        if any(hidden_name(part) for part in parts) or any(part.casefold() == "render" for part in parts[:-1]):
            raise _bad_file(i, "훑지 않는 자리입니다")
        if os.path.splitext(parts[-1])[1].lower() not in _MEDIA:
            raise _bad_file(i, "미디어 파일이 아닙니다")
        key = f.p.casefold()
        if key in seen:
            raise _bad_file(i, "같은 경로가 두 번 있습니다")
        seen.add(key)
        if f.st == "ok":
            if f.b <= 0 or not (f.s and len(f.s) == 64 and all(c in "0123456789abcdef" for c in f.s)):
                raise _bad_file(i, "지문이 올바르지 않습니다")
        elif f.s is not None:
            raise _bad_file(i, "미판정 파일에 지문이 있습니다")
        out.append(registry.RegistryFile(f.p, f.b, f.m, f.s, f.st))
    return out


@router.get("/helper/projects")
def helper_projects(request: Request) -> dict[str, Any]:
    """도우미가 훑을 PM 프로젝트 — unc 가 없으면(서버 DRIVES 대응표에 없음) 그 프로젝트는 도우미도 못 훑는다."""
    _helper_owner(request, need_local=True)
    return {"projects": [{"project_id": pid, "name": name, "root": root, "unc": canonical_unc(root)}
                         for pid, name, root in pm_projects()]}


@router.post("/helper/lease")
def helper_lease(body: HelperLeaseIn, request: Request) -> dict[str, Any]:
    owner = _helper_owner(request, need_local=True)
    found = {pid: (name, root) for pid, name, root in pm_projects()}.get(body.project_id)
    if found is None:
        raise HTTPException(status_code=404, detail="없는 프로젝트입니다")
    name, root = found
    unc = canonical_unc(root)
    if unc is None:
        raise HTTPException(status_code=422, detail="서버가 이 프로젝트 루트의 공유 주소를 모릅니다(CONTENT_HUB_ASSET_REGISTRY_DRIVES)")
    # 훑는 곳도 같은 잠금 안에서 다시 본다 — 위 확인과 자리 발급 사이에 '서버'로 바뀌는 경쟁(set_mode 와 같은 잠금)
    lease = leases.acquire(body.project_id, name, owner, unc, lambda: controller.busy() or registry_mode() != "local")
    if lease is None:
        raise HTTPException(status_code=409, detail="이미 다른 곳에서 훑는 중입니다")
    with get_connection() as conn:
        rows = registry.registry_rows(conn, body.project_id)
    known = [{"p": r["path"], "b": r["bytes"], "m": r["mtime_ns"] or 0, "s": r["sha256"]}
             for r in rows if r["state"] == "present"]
    log_event(_log, "asset_registry_helper_lease", project_id=body.project_id, known=len(known))
    return {"lease_id": lease["id"], "unc": unc, "ttl_s": LEASE_TTL_S, "known": known}


@router.post("/helper/renew")
def helper_renew(body: HelperLeaseRef, request: Request) -> dict[str, Any]:
    owner = _helper_owner(request)
    try:
        leases.renew(body.lease_id, owner)
    except LookupError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    return {"ttl_s": LEASE_TTL_S}


@router.post("/helper/release")
def helper_release(body: HelperLeaseRef, request: Request) -> dict[str, Any]:
    leases.release(body.lease_id, _helper_owner(request))
    return {"released": True}


@router.post("/helper/result")
def helper_result(body: HelperResultIn, request: Request) -> dict[str, Any]:
    """완주 결과만 반영한다. 미완주(도우미 쪽 NAS 끊김·시간 초과)는 대장도 마지막 훑기 기록도 바꾸지 않는다 —
    도우미 PC 사정일 수 있어 서버 훑기의 failed 기록과 다르게 둔다(Codex 합의)."""
    owner = _helper_owner(request)
    files = _checked_files(body.files)
    digest = hashlib.sha256(json.dumps(body.model_dump(), sort_keys=True, separators=(",", ":")).encode()).hexdigest()
    try:
        state, value = leases.begin_apply(body.lease_id, owner, body.seq, digest)
    except (LookupError, ValueError) as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    if state == "ack":
        return value
    lease = value
    ack: Optional[dict[str, Any]] = None
    try:
        kinds: dict[str, int] = {}
        clean = False
        if body.complete:
            scan = registry.RegistryScan(True, files)
            clean = scan.clean
            stats = {
                "root": lease["unc"], "state": "ok" if clean else "partial", "started_at": lease["started_at"],
                "finished_at": registry.utc_now(), "complete": True, "clean": clean, "files": len(files),
                "hashed": body.stats.hashed, "hashed_bytes": body.stats.hashed_bytes,
                "undetermined": sum(1 for f in files if f.status == "undetermined"),
                "pending": sum(1 for f in files if f.status == "pending"),
                "elapsed_ms": body.stats.elapsed_ms, "note": "도우미 PC",
            }
            kinds = controller._apply(lease["project_id"], lease["name"], scan, stats)
        ack = {"ok": True, "applied": body.complete, "clean": clean, "kinds": kinds}
    finally:
        leases.finish_apply(body.lease_id, body.seq, digest, ack)
    log_event(_log, "asset_registry_helper_result", project_id=lease["project_id"], complete=body.complete,
              clean=ack["clean"], files=len(files), **kinds)
    return ack

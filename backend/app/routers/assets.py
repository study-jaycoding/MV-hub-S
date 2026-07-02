"""Assets(구성) 라우터 — project-viewer 의 '구성 탭'(폴더 트리 브라우저) 포팅.

ASSETS_ROOT(= PV PROJECTS_DIR) 아래의 프로젝트 폴더를 트리로 보여주고 파일을 서빙한다.
프로젝트 = 루트 아래 한 폴더. 기본 테스트 폴더는 config.DEFAULT_PROJECT.

경로 보안: 모든 접근은 ASSETS_ROOT/<project> 안으로 제한(traversal 차단) — PV 의
safe_project_dir / safe_resolve 가드를 그대로 따른다.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import os
import subprocess
import sys
import tempfile
import uuid
import zipfile
from datetime import datetime
from pathlib import Path
from typing import Any, Optional

from fastapi import APIRouter, Depends, File, Form, HTTPException, Query, Request, UploadFile
from fastapi.responses import FileResponse
from pydantic import BaseModel
from starlette.background import BackgroundTask

from . import _proxy
from .. import rbac, repo
from ..config import (
    ASSETS_ROOT,
    AUTH_ENABLED,
    DATA_DIR,
    DEFAULT_PROJECT,
    DEFAULT_WORKER_ID,
    MANAGE_ENABLED,
)
from ..db import get_connection
from ..deps import account_global_roles, account_scope_uid, actor_id
from ..services.media_types import asset_media_type
from ..services.project_folders import hidden_folder
from ..services.request_guards import require_loopback_request
from ..services import media_cache, thumbs
from ..services.path_safety import safe_join


def _require_mount_manager(request: Request) -> None:
    """외부 폴더 등록/해제 권한. 폴더 등록은 **계정별 개인 목록**이라(각자 자기 것만 보고·지움)
    로그인한 사용자는 누구나 자기 폴더를 직접 관리한다.
      · AUTH 켜짐: 로그인한 계정이면 통과(자기 소유 마운트만 다룬다 — 남의 것엔 영향 없음).
      · AUTH 꺼짐(신원 없음): 서버 로컬(127.0.0.1/::1)에서만 — LAN의 임의 등록 차단.
    ⚠️ 임의 절대경로를 마운트로 받으므로, 그 계정은 자기 마운트 범위의 서버 파일만 열람 가능."""
    if AUTH_ENABLED:
        if getattr(request.state, "account", None) is None:
            raise HTTPException(status_code=401, detail="로그인이 필요합니다")
        # 공유 서버(AUTH on)에서도 폴더 등록은 로컬(loopback)만 — LAN 사용자가 서버 디스크를
        # 임의 경로로 mount 하는 것을 막는다(Assets 는 각 워커 로컬 허브 전용).
        require_loopback_request(request, "폴더 등록은 로컬 허브에서만 가능합니다")
        return
    require_loopback_request(request, "폴더 등록은 서버 로컬에서만 가능합니다")


def _require_local_assets(request: Request) -> None:
    """Assets 파일 I/O(트리·읽기·썸네일·업로드·zip·reveal·재매칭)는 로컬 허브(loopback) 전용.
    공유 서버(AUTH on)에서는 LAN 사용자가 서버 디스크를 열람·기록·탐색하지 못하게 막는다
    (설계상 Assets 는 각 워커의 로컬 허브에서만 동작한다). 로컬 허브는 AUTH off + 127.0.0.1
    바인드라 그대로 통과한다."""
    if AUTH_ENABLED:
        require_loopback_request(request, "Assets 파일 기능은 로컬 허브에서만 사용할 수 있습니다")



def _mounts_file() -> Path:
    """등록된 외부 폴더(마운트) 영속 파일 — **활성 계정 DB 폴더 안**(계정별 격리).
    ★DB·마이그레이션과 동일하게 계정 키=이메일(account_key)을 써야 같은 폴더를 가리킨다.
    (예전엔 uid 를 써서 DB 는 email 폴더, 마운트는 uid 폴더로 갈려 로그인 후 마운트가 사라졌다.)
    로그인하면 data/db/acct/<email-slug>/asset_mounts.json, 미로그인/단독이면 레거시 위치."""
    from ..active_account import account_dir, account_key

    key = account_key()
    return (account_dir(key) / "asset_mounts.json") if key else (DATA_DIR / "asset_mounts.json")

router = APIRouter(prefix="/api/assets", tags=["assets"])

_PROMPT_IMPORT_PROJECT = "imports"


def _media_type(name: str) -> Optional[str]:
    return asset_media_type(name, include_audio=True)


def _sha256_file(path: Path) -> Optional[str]:
    try:
        h = hashlib.sha256()
        with path.open("rb") as f:
            for chunk in iter(lambda: f.read(1024 * 1024), b""):
                h.update(chunk)
        return h.hexdigest()
    except OSError:
        return None


def _find_same_media(dest: Path, digest: str, media_type: str) -> Optional[Path]:
    try:
        entries = list(dest.iterdir())
    except OSError:
        return None
    for p in entries:
        if not p.is_file() or _media_type(p.name) != media_type:
            continue
        if _sha256_file(p) == digest:
            return p
    return None


# ── 업로드 스트리밍(청크) — 큰 파일을 통째로 메모리에 read 하지 않는다 ─────────────────
_UPLOAD_CHUNK_SIZE = media_cache._CHUNK_SIZE
_UPLOAD_MAX_BYTES = int(os.getenv("CONTENT_HUB_UPLOAD_MAX_BYTES", str(media_cache._MAX_BYTES)))


class _UploadTooLarge(Exception):
    """업로드가 크기 상한(_UPLOAD_MAX_BYTES)을 넘음."""


async def _stream_upload_tmp(up: UploadFile, dest_dir: Path) -> tuple[Path, int, str]:
    """업로드를 dest_dir 안 temp(.part)로 청크 스트리밍 — 전체를 메모리에 올리지 않는다.
    함께 sha256 을 계산해 (tmp, 바이트수, sha256hex) 반환. 상한 초과면 _UploadTooLarge.
    실패 시 temp 를 정리하고 예외를 다시 던진다."""
    tmp = dest_dir / f".upload-{uuid.uuid4().hex}.part"
    h = hashlib.sha256()
    written = 0
    try:
        with tmp.open("xb") as f:
            while True:
                chunk = await up.read(_UPLOAD_CHUNK_SIZE)
                if not chunk:
                    break
                written += len(chunk)
                if written > _UPLOAD_MAX_BYTES:
                    raise _UploadTooLarge()
                h.update(chunk)
                await asyncio.to_thread(f.write, chunk)
        return tmp, written, h.hexdigest()
    except Exception:
        tmp.unlink(missing_ok=True)
        raise


def _commit_unique_tmp(tmp: Path, dest_dir: Path, raw_name: str) -> Path:
    """temp 를 최종 파일명으로 원자적 확정(덮어쓰기 안 함). 이름 충돌은 _2, _3… 로 회피하되,
    os.link(하드링크)로 '없을 때만 생성'을 원자화해 동일 이름 동시 업로드 race 를 막는다.
    하드링크 불가 파일시스템은 O_EXCL 로 최종 이름을 선점한 뒤 replace 로 폴백."""
    stem, ext = Path(raw_name).stem, Path(raw_name).suffix
    i = 1
    while True:
        name = raw_name if i == 1 else f"{stem}_{i}{ext}"
        target = safe_join(dest_dir, name)
        if target is None:
            tmp.unlink(missing_ok=True)
            raise HTTPException(status_code=400, detail="안전하지 않은 파일명")
        try:
            os.link(tmp, target)
            tmp.unlink(missing_ok=True)
            return target
        except FileExistsError:
            i += 1
            continue
        except OSError:
            # 하드링크 미지원 파일시스템 → 최종 이름을 배타 생성으로 선점 후 replace
            try:
                fd = os.open(str(target), os.O_CREAT | os.O_EXCL | os.O_WRONLY)
                os.close(fd)
            except FileExistsError:
                i += 1
                continue
            try:
                os.replace(tmp, target)
            except Exception:
                # replace 실패 → 방금 선점한 0바이트 파일과 tmp 를 정리(잔재 방지)
                try:
                    os.unlink(target)
                except OSError:
                    pass
                tmp.unlink(missing_ok=True)
                raise
            return target


def _load_mounts() -> list[dict[str, str]]:
    """등록된 외부 폴더 [{name, path, owner}]. owner=등록한 계정(creator_uid) — 계정별 개인 목록.
    레거시(소유자 없는) 항목은 _owner_mounts(owner) 에서 현재 요청 계정 소유로 1회 이관한다."""
    try:
        data = json.loads(_mounts_file().read_text("utf-8"))
    except (FileNotFoundError, ValueError, OSError):
        return []
    out: list[dict[str, str]] = []
    for m in data.get("mounts", []) if isinstance(data, dict) else []:
        name = str(m.get("name", "")).strip()
        path = str(m.get("path", "")).strip()
        if not (name and path):
            continue
        owner = str(m.get("owner", "")).strip()
        out.append({"name": name, "path": path, "owner": owner})
    return out


def _save_mounts(mounts: list[dict[str, str]]) -> None:
    f = _mounts_file()
    f.parent.mkdir(parents=True, exist_ok=True)
    f.write_text(json.dumps({"mounts": mounts}, ensure_ascii=False, indent=2), "utf-8")


def _owner_mounts(owner: str) -> list[dict[str, str]]:
    """그 계정(owner)이 등록한 마운트만 — 각자 자기 것만 본다."""
    mounts = _load_mounts()
    migrated = False
    out: list[dict[str, str]] = []
    for m in mounts:
        m_owner = m.get("owner", "")
        if m_owner == owner:
            out.append(m)
        elif m_owner in ("", DEFAULT_WORKER_ID):
            m["owner"] = owner
            migrated = True
            out.append(m)
    if migrated:
        _save_mounts(mounts)
    return out


def _mount_dir(name: str, owner: str) -> Optional[Path]:
    """등록 이름 → 실제 폴더(그 계정 소유 안에서만 해석 — 남의 마운트엔 접근 못 함)."""
    for m in _owner_mounts(owner):
        if m["name"] == name:
            p = Path(m["path"]).resolve()
            return p if p.is_dir() else None
    return None


def _auto_project_mounts(request: Request) -> list[dict[str, str]]:
    """PM 프로젝트 설정의 root_path 를 Assets 자동 마운트로 노출한다.

    수동 asset_mounts.json 에 쓰지 않고 매번 읽어 합친다. 프로젝트 설정을 바꾸면
    에셋창도 다음 로드부터 그대로 따라가게 하기 위해서다.
    """
    if not MANAGE_ENABLED:
        return []
    try:
        with get_connection() as conn:
            rows = conn.execute(
                "SELECT project_id, root_path FROM project_folder_link"
            ).fetchall()
        links = {str(r["project_id"]): {"root_path": r["root_path"]} for r in rows}
    except Exception:  # noqa: BLE001 - PM 테이블이 아직 없으면 자동 마운트만 비활성
        return []
    if not links:
        return []

    read_all = (not AUTH_ENABLED) or rbac.has_global_cap(account_global_roles(request), "read_all")
    member_uid = None if read_all else (account_scope_uid(request) or "\x00")
    try:
        visible = repo.list_projects(include_archived=False, member_uid=member_uid).get("projects") or []
    except Exception:  # noqa: BLE001
        visible = []

    out: list[dict[str, str]] = []
    used: set[str] = set()
    for p in visible:
        if not isinstance(p, dict):
            continue
        pid = str(p.get("id") or "")
        name = str(p.get("name") or "").strip()
        link = links.get(pid) or {}
        root = str(link.get("root_path") or "").strip()
        if not (pid and name and root) or name in used:
            continue
        try:
            path = Path(root).expanduser().resolve()
        except OSError:
            path = Path(root).expanduser()
        used.add(name)
        out.append({"name": name, "path": str(path), "owner": "project"})
    return out


def _auto_mount_dir(name: str, request: Request) -> Optional[Path]:
    for m in _auto_project_mounts(request):
        if m["name"] == name:
            p = Path(m["path"]).resolve()
            return p if p.is_dir() else None
    return None


def _project_dir_info(project: str, request: Request) -> Optional[tuple[Path, bool]]:
    """프로젝트 이름 → 실제 폴더 + 자동 PM 경로 여부.

    두 번째 값이 True 면 PM 프로젝트 설정에서 온 경로다. 이 경우 Assets 트리에서
    Render 폴더는 숨기고, 나머지 제작 폴더만 보여준다.
    """
    owner = actor_id(request)
    # 내(owner)가 등록한 외부 폴더(마운트)가 있으면 그 경로 우선 — 임의 위치 허용.
    md = _mount_dir(project, owner)
    if md:
        return md, False
    auto = _auto_mount_dir(project, request)
    if auto:
        return auto, True
    cand = (ASSETS_ROOT / project).resolve()
    try:
        cand.relative_to(ASSETS_ROOT)
    except ValueError:
        return None
    return (cand, False) if cand.is_dir() else None


def _safe_project_dir(project: str, request: Request) -> Optional[Path]:
    info = _project_dir_info(project, request)
    return info[0] if info else None


def _safe_resolve(project_dir: Path, rel: str) -> Optional[Path]:
    return safe_join(project_dir, rel)  # 경로 이탈 차단은 공용 path_safety.safe_join 으로 단일화


def _index_by_sha(
    project_dir: Path, wanted: set[str], limit: int = 100000
) -> tuple[dict[str, str], bool]:
    """project_dir 안 미디어 파일을 훑어 wanted(내용 지문 sha256) 에 해당하는 sha→상대경로 인덱스.
    (index, scanned_all) 반환 — limit 초과로 중단되면 scanned_all=False(=끝까지 못 봐 불확실).
    폴더를 한 번만 스캔하고, 필요한 지문을 다 찾으면 조기 종료한다. 재매칭 버튼에서만 호출."""
    index: dict[str, str] = {}
    if not wanted:
        return index, True
    count = 0
    try:
        for p in project_dir.rglob("*"):
            if not p.is_file() or not _media_type(p.name):
                continue
            # symlink 등으로 폴더 밖을 가리키는 파일 차단(_safe_resolve 와 동일 보안 모델).
            try:
                rp = p.resolve()
                rel = rp.relative_to(project_dir)
            except (OSError, ValueError):
                continue
            # 숨김 파일/폴더(부모 포함)는 트리에서 안 보이므로 재매칭 대상에서도 제외.
            if any(_hidden(part) for part in rel.parts):
                continue
            count += 1
            if count > limit:
                return index, False
            digest = _sha256_file(rp)
            if digest and digest in wanted and digest not in index:
                index[digest] = rel.as_posix()
                if len(index) == len(wanted):
                    break  # 필요한 지문을 모두 찾음 → 조기 종료
    except OSError:
        return index, False
    return index, True


def _resolve_broken_sources(request: Request, prune: bool) -> tuple[int, list[str]]:
    """원경로에서 사라진 내 소스를 내용 지문으로 재매칭해 다시 잇는다(자가 치유).
    prune=True 면, 재매칭도 실패하고 '폴더를 끝까지 훑어 확실히 없는' 소스만 소스 지정을 해제한다
    (스캔이 limit 로 잘려 불확실하면 보류 — 있는 파일을 실수로 해제하지 않기 위함).
    프로젝트(마운트)별로 폴더를 한 번만 스캔한다."""
    owner = actor_id(request)
    by_project: dict[str, list[tuple[str, Optional[str]]]] = {}
    for project, path, sha in repo.list_source_metas(owner):
        by_project.setdefault(project, []).append((path, sha))

    relinked = 0
    pruned: list[str] = []
    for project, items in by_project.items():
        proj_dir = _safe_project_dir(project, request)
        if not proj_dir:
            continue
        broken: list[tuple[str, Optional[str]]] = []
        for path, sha in items:
            cur = _safe_resolve(proj_dir, path)
            if cur and cur.is_file():
                continue  # 원경로에서 이미 열림 → 손댈 필요 없음
            broken.append((path, sha))
        if not broken:
            continue
        wanted = {sha for _, sha in broken if sha}
        index, scanned_all = _index_by_sha(proj_dir, wanted)
        for path, sha in broken:
            new_rel = index.get(sha) if sha else None
            if new_rel and new_rel != path:
                repo.relink_asset_path(project, path, new_rel, owner)
                relinked += 1
            elif prune and scanned_all:
                # 지문이 없거나(옛 소스) 폴더를 끝까지 훑어도 못 찾음 → 원본이 정말 없음 → 해제.
                repo.set_asset_source(project, path, None, False, owner)
                pruned.append(f"{project}/{path}")
    return relinked, pruned


def _hidden(name: str) -> bool:
    # 시스템/ledger 파일·placeholder 숨김 (PV 와 동일한 취지)
    return hidden_folder(name) or name.lower() == "readme.md"


def _build_tree(
    directory: Path,
    rel_prefix: str,
    *,
    hidden_names: Optional[set[str]] = None,
) -> list[dict[str, Any]]:
    """디렉터리를 재귀 순회 — 폴더 우선, 미디어 파일만 포함."""
    try:
        entries = sorted(
            directory.iterdir(), key=lambda p: (not p.is_dir(), p.name.lower())
        )
    except (PermissionError, OSError):
        return []

    out: list[dict[str, Any]] = []
    for entry in entries:
        if _hidden(entry.name):
            continue
        if hidden_names and entry.name.lower() in hidden_names:
            continue
        rel = f"{rel_prefix}{entry.name}"
        if entry.is_dir():
            out.append(
                {
                    "name": entry.name,
                    "type": "dir",
                    "path": rel,
                    "children": _build_tree(entry, rel + "/", hidden_names=hidden_names),
                }
            )
        else:
            mt = _media_type(entry.name)
            if mt:
                try:
                    mtime = entry.stat().st_mtime  # 파일 날짜(에셋 날짜별 구분용)
                except OSError:
                    mtime = None
                out.append({"name": entry.name, "type": mt, "path": rel, "mtime": mtime})
    return out


class ProjectsOut(BaseModel):
    projects: list[str]
    default: str
    root: str


@router.get("/projects", response_model=ProjectsOut)
def list_projects(request: Request):
    """등록된 외부 폴더(마운트)만 프로젝트로 노출 — **내가 등록한 것만**(계정별 개인 목록).
    디스크 폴더 자동 인식은 하지 않는다 — 사용자가 '폴더 등록'에서 직접 등록한 것만 보인다."""
    projects = [m["name"] for m in _owner_mounts(actor_id(request))]
    for m in _auto_project_mounts(request):
        if m["name"] not in projects:
            projects.append(m["name"])
    # 내장 폴더는 파일이 있으면 프로젝트로 노출 → Assets 에서 탐색·태그·소스지정(@이름) 가능.
    for built_in in ("captures", _PROMPT_IMPORT_PROJECT):
        p = ASSETS_ROOT / built_in
        if p.is_dir() and built_in not in projects and any(p.iterdir()):
            projects.append(built_in)
    # 기본 프로젝트가 목록에 있으면 그것, 아니면 첫 항목
    default = DEFAULT_PROJECT if DEFAULT_PROJECT in projects else (projects[0] if projects else "")
    return ProjectsOut(projects=projects, default=default, root=str(ASSETS_ROOT))


# ── 외부 폴더 등록(마운트) 관리 ──────────────────────────────────────────────
class MountIn(BaseModel):
    name: str
    path: str


def _mounts_payload(request: Request) -> dict:
    """마운트 목록 응답(수동 + 프로젝트 자동, 이름 중복 제거) — GET/POST/DELETE 공통.
    셋이 같은 스키마를 돌려줘야 등록/삭제 직후와 새로고침 목록이 어긋나지 않는다
    (auto 폴더가 사라졌다 되살아나 보이는 현상 방지)."""
    manual = [
        {"name": m["name"], "path": m["path"], "exists": Path(m["path"]).is_dir()}
        for m in _owner_mounts(actor_id(request))
    ]
    names = {m["name"] for m in manual}
    auto = [
        {"name": m["name"], "path": m["path"], "exists": Path(m["path"]).is_dir(), "auto": True}
        for m in _auto_project_mounts(request)
        if m["name"] not in names
    ]
    return {"mounts": manual + auto}


@router.get("/mounts")
def list_mounts(request: Request):
    """**내가 등록한** 외부 폴더 목록(+실제 존재 여부) — 계정별 개인 목록."""
    return _mounts_payload(request)


@router.post("/mounts", dependencies=[Depends(_require_mount_manager)])
def add_mount(body: MountIn, request: Request):
    """외부 폴더 등록 — **내(actor_id) 개인 목록**에 추가. 같은 이름이 내 목록에 있으면 경로 갱신.
    다른 계정이 같은 이름을 써도 충돌하지 않는다(계정별 네임스페이스). 원격의 임의 등록은
    _require_mount_manager(로그인 필요)로 막는다 — 자기 마운트 범위만 열람 가능."""
    owner = actor_id(request)
    name = body.name.strip()
    # 사용자가 경로를 따옴표째 붙여넣어도 처리
    path = body.path.strip().strip('"').strip("'")
    if not name:
        raise HTTPException(status_code=400, detail="이름을 입력하세요")
    if not path:
        raise HTTPException(status_code=400, detail="폴더 경로를 입력하세요")
    p = Path(path).resolve()
    if not p.is_dir():
        raise HTTPException(status_code=400, detail=f"폴더가 존재하지 않습니다: {path}")
    # 내 항목 중 같은 이름만 교체(남의 마운트는 그대로 보존).
    mounts = [m for m in _load_mounts() if not (m["name"] == name and m.get("owner", "") == owner)]
    mounts.append({"name": name, "path": str(p), "owner": owner})
    _save_mounts(mounts)
    return _mounts_payload(request)


@router.delete("/mounts/{name}", dependencies=[Depends(_require_mount_manager)])
def del_mount(name: str, request: Request):
    """등록된 외부 폴더 해제 — **내 것만** 지운다(남의 등록엔 영향 없음). 원본 폴더는 안 건드림."""
    owner = actor_id(request)
    mounts = [m for m in _load_mounts() if not (m["name"] == name and m.get("owner", "") == owner)]
    _save_mounts(mounts)
    return _mounts_payload(request)


@router.get("/tree", dependencies=[Depends(_require_local_assets)])
def project_tree(request: Request, project: str = Query(...)):
    """프로젝트 폴더 트리(폴더 + 미디어 파일) — 내가 등록한 마운트 안에서만 해석."""
    info = _project_dir_info(project, request)
    if not info:
        raise HTTPException(status_code=404, detail=f"프로젝트 없음: {project}")
    proj_dir, auto_project = info
    return {
        "project": project,
        "name": proj_dir.name,
        "children": _build_tree(
            proj_dir,
            "",
            hidden_names={"render"} if auto_project else None,
        ),
    }


# ── 파일별 메타데이터(소스/태그/코멘트/컬러) ─────────────────────────────
class AssetSourceIn(BaseModel):
    project: str
    path: str
    name: Optional[str] = None
    is_source: bool = True


class AssetTagsIn(BaseModel):
    project: str
    path: str
    tags: list[str] = []


class AssetCommentIn(BaseModel):
    project: str
    path: str
    comment: Optional[str] = None


class AssetColorIn(BaseModel):
    project: str
    path: str
    color: Optional[str] = None


def _require_project(project: str, request: Request) -> None:
    if not _safe_project_dir(project, request):
        raise HTTPException(status_code=404, detail=f"프로젝트 없음: {project}")


@router.get("/meta")
def asset_meta(request: Request, project: str = Query(...)):
    """파일별 메타(+ comment_count·has_unread). 미확인은 코멘트별 muted 플래그를 따른다.
    읽음 기준 신원은 로그인 계정(actor_id) — 작성·읽음추적이 같은 신원이라 일관.

    ★개인 메타(소스/태그/컬러/노트)는 **로컬 계정 DB** 가 정답이다 — 생성탭 @/# 피커
    (/api/sources)도 같은 로컬 asset_meta 를 읽으므로, 여기서 통째로 서버에 위임하면 둘이 다른
    DB 를 봐서 '에셋에서 정한 소스/태그가 생성탭에 안 뜨는' 단절이 생긴다(실측 버그). 코멘트
    스레드만 공유(서버)라, 프록시 중이면 서버에서 코멘트 뱃지(comment_count·has_unread)만 가져와
    로컬 개인 메타에 머지한다."""
    local = repo.get_asset_meta(project, actor_id(request))
    if _proxy.proxying():
        try:
            remote = _proxy.proxy_json(
                "GET", "/api/assets/meta", params={"project": project},
                timeout=5,  # 비핵심 보강(코멘트 뱃지만) — 서버 지연/다운에 메타 응답을 60초씩 막지 않게
            )
        except Exception:  # noqa: BLE001 — 코멘트 뱃지는 부가정보, 실패해도 개인 메타는 보여준다
            remote = None
        if isinstance(remote, dict):
            for path, rm in remote.items():
                if not isinstance(rm, dict):
                    continue
                slot = local.get(path)
                if slot is None:  # 개인 메타는 없지만 공유 코멘트가 달린 파일 → 뱃지만 채운다
                    slot = {
                        "is_source": False, "source_name": None, "tags": [],
                        "comment": None, "color": None,
                        "comment_count": 0, "has_unread": False,
                    }
                    local[path] = slot
                slot["comment_count"] = rm.get("comment_count", 0)
                slot["has_unread"] = rm.get("has_unread", False)
    return local


class CommentAddIn(BaseModel):
    project: str
    path: str
    text: str
    author: Optional[str] = None
    parent_id: Optional[str] = None
    muted: bool = False  # 작성 시점 '내 알림 끄기' 상태(코멘트별 캡처)


class CommentEditIn(BaseModel):
    text: str
    worker_id: Optional[str] = None


class CommentReadIn(BaseModel):
    project: str
    path: str
    worker_id: Optional[str] = None


@router.get("/comments")
def list_comments(request: Request, project: str = Query(...), path: str = Query(...)):
    """파일 코멘트 스레드(작성자·시각 포함, 오래된→최신). 스레드 자체는 팀 공유."""
    if _proxy.proxying():
        return _proxy.proxy_json(
            "GET", "/api/assets/comments", params={"project": project, "path": path}
        )
    return repo.list_asset_comments(project, path)


@router.post("/comments")
def add_comment(body: CommentAddIn, request: Request):
    if _proxy.proxying():
        return _proxy.proxy_json("POST", "/api/assets/comments", body=body.model_dump())
    text = (body.text or "").strip()
    if not text:
        raise HTTPException(status_code=400, detail="빈 코멘트")
    # 작성자는 로그인 신원(creator_uid) — body.author 무시(멀티계정에서 'me' 로 뭉치지 않게).
    cid = repo.add_asset_comment(
        body.project, body.path, actor_id(request), text, body.parent_id, body.muted
    )
    return {"id": cid}


@router.put("/comments/{comment_id}")
def edit_comment(comment_id: str, body: CommentEditIn, request: Request):
    if _proxy.proxying():
        return _proxy.proxy_json(
            "PUT", f"/api/assets/comments/{comment_id}", body=body.model_dump()
        )
    text = (body.text or "").strip()
    if not text:
        raise HTTPException(status_code=400, detail="빈 코멘트")
    try:
        repo.edit_asset_comment(comment_id, actor_id(request), text)
    except PermissionError as e:
        raise HTTPException(status_code=403, detail=str(e))
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))
    return {"ok": True}


@router.delete("/comments/{comment_id}")
def delete_comment(comment_id: str, request: Request):
    if _proxy.proxying():
        return _proxy.proxy_json("DELETE", f"/api/assets/comments/{comment_id}")
    try:
        repo.delete_asset_comment(comment_id, actor_id(request))
    except PermissionError as e:
        raise HTTPException(status_code=403, detail=str(e))
    return {"ok": True}


@router.post("/comments/read")
def read_comments(body: CommentReadIn, request: Request):
    if _proxy.proxying():
        return _proxy.proxy_json("POST", "/api/assets/comments/read", body=body.model_dump())
    repo.mark_asset_comments_read(actor_id(request), body.project, body.path)
    return {"ok": True}


# 메타 쓰기(소스/태그/컬러/개인 노트) — 계정별 개인화라 **로컬 계정 DB** 에 저장한다(서버로
# 위임하지 않는다). 생성탭 @/# 피커(/api/sources)가 같은 로컬 asset_meta 를 읽으므로 여기서
# 서버로 새면 '에셋에서 정한 소스/태그가 생성탭에 안 뜨는' 단절이 생긴다(실측 버그). 디스크
# 검증(_require_project) 없음: 메타는 (project,path,owner) 키로만 식별.
@router.put("/source", dependencies=[Depends(_require_local_assets)])
def asset_set_source(body: AssetSourceIn, request: Request):
    # 에셋 메타는 계정별 개인화 — 내(actor_id) 설정만 만들고 바꾼다(남의 것과 안 섞임).
    # 소스로 켤 때 파일 내용 지문(sha256)을 함께 기록해, 이후 폴더가 바뀌어도 재매칭되게 한다.
    content_sha: Optional[str] = None
    if body.is_source:
        proj_dir = _safe_project_dir(body.project, request)
        target = _safe_resolve(proj_dir, body.path) if proj_dir else None
        if target and target.is_file():
            content_sha = _sha256_file(target)
    repo.set_asset_source(
        body.project, body.path, body.name, body.is_source, actor_id(request), content_sha
    )
    return {"ok": True}


@router.post("/sources/relink", dependencies=[Depends(_require_local_assets)])
def relink_broken_sources(request: Request):
    """원경로에서 사라진 내 Assets 소스를, 저장해둔 내용 지문(sha256)으로 같은 폴더를 뒤져 찾아
    경로를 다시 잇는다(자가 치유). 필요할 때만 도는 일괄 작업 — 평소 파일 조회엔 스캔이 없다."""
    relinked, _ = _resolve_broken_sources(request, prune=False)
    return {"relinked": relinked}


@router.post("/sources/prune", dependencies=[Depends(_require_local_assets)])
def prune_broken_sources(request: Request):
    """원본 파일을 확실히 찾을 수 없는 내 Assets 소스의 소스 지정을 해제한다(is_source=0).
    먼저 지문으로 재매칭을 시도해 찾을 수 있으면 다시 잇고, 폴더를 끝까지 훑어도 못 찾은 것만
    해제한다(스캔이 잘려 불확실하면 보류). 파일이 있는 소스와 태그·컬러 등 메타는 보존한다."""
    relinked, pruned = _resolve_broken_sources(request, prune=True)
    return {"pruned": len(pruned), "relinked": relinked, "items": pruned}


@router.put("/tags")
def asset_set_tags(body: AssetTagsIn, request: Request):
    repo.set_asset_tags(body.project, body.path, body.tags, actor_id(request))
    return {"ok": True}


@router.put("/comment")
def asset_set_comment(body: AssetCommentIn, request: Request):
    repo.set_asset_comment(body.project, body.path, body.comment, actor_id(request))
    return {"ok": True}


@router.put("/color")
def asset_set_color(body: AssetColorIn, request: Request):
    repo.set_asset_color(body.project, body.path, body.color, actor_id(request))
    return {"ok": True}


@router.get("/file", dependencies=[Depends(_require_local_assets)])
def get_file(request: Request, project: str = Query(...), path: str = Query(...)):
    """프로젝트 내 파일 서빙(경로 보안) — 내가 등록한 마운트 안에서만(img 요청은 쿠키로 인증)."""
    proj_dir = _safe_project_dir(project, request)
    if not proj_dir:
        raise HTTPException(status_code=404, detail=f"프로젝트 없음: {project}")
    target = _safe_resolve(proj_dir, path)
    if not target or not target.is_file():
        raise HTTPException(status_code=404, detail="파일 없음")
    return FileResponse(target)


@router.get("/thumb", dependencies=[Depends(_require_local_assets)])
def get_thumb(
    request: Request,
    project: str = Query(...),
    path: str = Query(...),
    w: int = Query(512, ge=64, le=1024),
):
    """이미지 썸네일(리사이즈+디스크 캐시) — 그리드/리스트 스크롤 성능용.
    원본 풀해상도(수 MP) 대신 작은 이미지를 디코딩하게 해 렉을 없앤다."""
    proj_dir = _safe_project_dir(project, request)
    if not proj_dir:
        raise HTTPException(status_code=404, detail=f"프로젝트 없음: {project}")
    target = _safe_resolve(proj_dir, path)
    if not target or not target.is_file():
        raise HTTPException(status_code=404, detail="파일 없음")
    if _media_type(target.name) != "image":
        raise HTTPException(status_code=415, detail="썸네일은 이미지만 지원")
    # 썸네일 생성·캐시키는 thumbs 서비스로 단일화 — 엔드포인트와 pre-warm 이 같은 키를 써야
    # 미리 구운 캐시를 엔드포인트가 읽는다(예전엔 여기서 별도 재구현해 계약이 갈릴 위험이 있었다).
    cache = thumbs.ensure_thumb(target, w)
    if not cache:
        raise HTTPException(status_code=500, detail="썸네일 생성 실패")
    return FileResponse(cache, media_type="image/jpeg")


@router.post("/upload", dependencies=[Depends(_require_local_assets)])
async def upload_assets(
    request: Request,
    project: str = Form(...),
    dir: str = Form(""),
    files: list[UploadFile] = File(...),
):
    """외부 파일을 현재 폴더(dir, 비면 프로젝트 루트)로 가져오기(드롭 업로드).
    파일명은 basename 만 사용(경로 traversal 차단), 미디어가 아닌 파일은 제외,
    이름 충돌은 _2, _3… 으로 회피(덮어쓰기 안 함)."""
    proj_dir = _safe_project_dir(project, request)
    if not proj_dir:
        raise HTTPException(status_code=404, detail=f"프로젝트 없음: {project}")
    dest = _safe_resolve(proj_dir, dir) if dir else proj_dir
    if not dest or not dest.is_dir():
        raise HTTPException(status_code=400, detail="대상 폴더 없음")

    saved: list[str] = []
    skipped: list[str] = []
    for up in files:
        raw = os.path.basename((up.filename or "").replace("\\", "/"))
        if not raw:
            continue
        if _media_type(raw) is None:  # 미디어(이미지/영상/오디오)만 — 그 외는 제외
            skipped.append(raw)
            continue
        try:
            tmp, size, _ = await _stream_upload_tmp(up, dest)  # 청크 스트리밍 + 크기 상한
        except _UploadTooLarge:
            skipped.append(raw)  # 상한 초과 파일은 건너뛰고 나머지는 저장
            continue
        except Exception as e:  # noqa: BLE001
            raise HTTPException(status_code=500, detail=f"저장 실패({raw}): {e}")
        if size == 0:
            tmp.unlink(missing_ok=True)
            skipped.append(raw)
            continue
        target = _commit_unique_tmp(tmp, dest, raw)  # 원자적 확정(덮어쓰기·race 방지)
        saved.append(target.relative_to(proj_dir).as_posix())

    return {"saved": saved, "skipped": skipped}


@router.post("/capture", dependencies=[Depends(_require_local_assets)])
async def upload_capture(request: Request, file: UploadFile = File(...)):
    """클립보드 캡쳐(이미지)를 내장 'captures' 폴더에 저장 + asset 토큰용 정보 반환.
    저장 즉시 레퍼런스(asset:captures|name)로 쓸 수 있고, Assets 에서도 탐색·태그·소스지정 가능.
    captures 는 내장 ASSETS_ROOT/captures 폴더(마운트 아님)라 owner 무관하게 thumb/file 서빙됨."""
    cap_dir = (ASSETS_ROOT / "captures").resolve()
    cap_dir.mkdir(parents=True, exist_ok=True)
    try:
        tmp, size, _ = await _stream_upload_tmp(file, cap_dir)
    except _UploadTooLarge:
        raise HTTPException(status_code=413, detail="캡쳐가 너무 큽니다")
    if size == 0:
        tmp.unlink(missing_ok=True)
        raise HTTPException(status_code=400, detail="빈 캡쳐")
    name = f"capture-{datetime.now().strftime('%Y%m%d-%H%M%S')}.png"  # 충돌은 _commit 이 _2 로 회피
    target = _commit_unique_tmp(tmp, cap_dir, name)
    return {"project": "captures", "path": target.name, "name": target.name, "type": "image"}


@router.post("/reference-import", dependencies=[Depends(_require_local_assets)])
async def upload_reference_import(
    request: Request,
    project: str = Form(""),
    dir: str = Form(""),
    files: list[UploadFile] = File(...),
):
    """프롬프트/레퍼런스 트레이에 외부 파일을 직접 드롭할 때 쓰는 내장 가져오기.
    선택된 에셋 폴더가 있으면 그 안의 import/에 저장하고, 같은 파일은 해시로 재사용한다."""
    project = (project or "").strip()
    dir = (dir or "").strip().strip("/")

    out_project = _PROMPT_IMPORT_PROJECT
    project_dir: Optional[Path] = None
    if project and project not in ("captures", _PROMPT_IMPORT_PROJECT):
        project_dir = _safe_project_dir(project, request)
        if project_dir:
            import_rel = f"{dir}/import" if dir else "import"
            dest = _safe_resolve(project_dir, import_rel)
            if dest:
                out_project = project
            else:
                project_dir = None
    if not project_dir:
        dest = (ASSETS_ROOT / _PROMPT_IMPORT_PROJECT).resolve()
        try:
            dest.relative_to(ASSETS_ROOT)
        except ValueError:
            raise HTTPException(status_code=500, detail="imports 경로 오류")
    dest.mkdir(parents=True, exist_ok=True)

    saved: list[dict[str, Any]] = []
    skipped: list[str] = []
    for up in files:
        raw = os.path.basename((up.filename or "").replace("\\", "/"))
        if not raw:
            continue
        mt = _media_type(raw)
        if mt not in ("image", "video"):
            skipped.append(raw)
            continue
        try:
            tmp, size, digest = await _stream_upload_tmp(up, dest)  # 스트리밍 + sha 동시 계산
        except _UploadTooLarge:
            skipped.append(raw)
            continue
        except Exception as e:  # noqa: BLE001
            raise HTTPException(status_code=500, detail=f"저장 실패({raw}): {e}")
        if size == 0:
            tmp.unlink(missing_ok=True)
            skipped.append(raw)
            continue
        existing = _find_same_media(dest, digest, mt)  # 같은 내용 이미 있으면 재사용(중복 저장 안 함)
        if existing:
            tmp.unlink(missing_ok=True)
            rel = (
                existing.relative_to(project_dir).as_posix()
                if project_dir
                else existing.name
            )
            saved.append({
                "project": out_project,
                "path": rel,
                "name": existing.name,
                "type": mt,
                "reused": True,
            })
            continue
        target = _commit_unique_tmp(tmp, dest, raw)
        rel = (
            target.relative_to(project_dir).as_posix()
            if project_dir
            else target.name
        )
        saved.append({
            "project": out_project,
            "path": rel,
            "name": target.name,
            "type": mt,
        })

    return {"saved": saved, "skipped": skipped}


@router.get("/zip", dependencies=[Depends(_require_local_assets)])
def export_zip(
    request: Request, project: str = Query(...), paths: list[str] = Query(default=[])
):
    """선택한 여러 파일을 zip 으로 묶어 스트리밍(OS 드래그 다중 내보내기용).
    네이티브 DownloadURL 드래그는 1건만 지원하므로, 다중선택은 이 zip 한 건으로 내보낸다.
    zip 내부는 파일명만으로 평탄화하고 동일 이름은 _2, _3… 으로 회피한다."""
    proj_dir = _safe_project_dir(project, request)
    if not proj_dir:
        raise HTTPException(status_code=404, detail=f"프로젝트 없음: {project}")
    if not paths:
        raise HTTPException(status_code=400, detail="내보낼 파일이 없음")

    tmp = tempfile.NamedTemporaryFile(prefix="ch-export-", suffix=".zip", delete=False)
    tmp_path = tmp.name
    tmp.close()
    used: set[str] = set()
    try:
        with zipfile.ZipFile(tmp_path, "w", zipfile.ZIP_DEFLATED) as zf:
            for rel in paths:
                target = _safe_resolve(proj_dir, rel)
                if not target or not target.is_file():
                    continue
                arc = target.name  # 폴더 구조 평탄화 — 파일명만
                if arc in used:  # 이름 충돌 회피
                    stem, dot, ext = arc.rpartition(".")
                    i = 2
                    while True:
                        cand = f"{stem}_{i}.{ext}" if dot else f"{arc}_{i}"
                        if cand not in used:
                            arc = cand
                            break
                        i += 1
                used.add(arc)
                zf.write(target, arcname=arc)
    except Exception as e:  # noqa: BLE001
        os.unlink(tmp_path)
        raise HTTPException(status_code=500, detail=f"zip 생성 실패: {e}")

    if not used:
        os.unlink(tmp_path)
        raise HTTPException(status_code=404, detail="유효한 파일이 없음")

    return FileResponse(
        tmp_path,
        media_type="application/zip",
        filename=f"assets-{len(used)}.zip",
        background=BackgroundTask(os.unlink, tmp_path),  # 전송 후 임시 zip 삭제
    )


class RevealIn(BaseModel):
    project: str
    path: str


@router.post("/reveal", dependencies=[Depends(_require_local_assets)])
def reveal_file(body: RevealIn, request: Request):
    """OS 파일 탐색기에서 원본 위치를 열고 해당 파일을 선택(로컬 전용)."""
    proj_dir = _safe_project_dir(body.project, request)
    if not proj_dir:
        raise HTTPException(status_code=404, detail=f"프로젝트 없음: {body.project}")
    target = _safe_resolve(proj_dir, body.path)
    if not target or not target.exists():
        raise HTTPException(status_code=404, detail="파일 없음")
    try:
        if sys.platform == "win32":
            # explorer 는 성공해도 종료코드 1 을 반환하므로 검사하지 않음
            subprocess.Popen(["explorer", f"/select,{target}"])
        elif sys.platform == "darwin":
            subprocess.Popen(["open", "-R", str(target)])
        else:
            subprocess.Popen(["xdg-open", str(target.parent)])
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=f"탐색기 열기 실패: {e}")
    return {"ok": True}

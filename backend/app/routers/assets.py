"""Assets(구성) 라우터 — project-viewer 의 '구성 탭'(폴더 트리 브라우저) 포팅.

ASSETS_ROOT(= PV PROJECTS_DIR) 아래의 프로젝트 폴더를 트리로 보여주고 파일을 서빙한다.
프로젝트 = 루트 아래 한 폴더. 기본 테스트 폴더는 config.DEFAULT_PROJECT.

경로 보안: 모든 접근은 ASSETS_ROOT/<project> 안으로 제한(traversal 차단) — PV 의
safe_project_dir / safe_resolve 가드를 그대로 따른다.
"""

from __future__ import annotations

import asyncio
import os
import subprocess
import sys
import tempfile
import zipfile
from datetime import datetime
from pathlib import Path
from typing import Any, Optional

from fastapi import APIRouter, BackgroundTasks, Depends, File, Form, HTTPException, Query, Request, UploadFile
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field
from starlette.background import BackgroundTask

from . import _assets_access, assets_metadata
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
from ..deps import (
    account_global_roles,
    account_scope_uid,
    actor_id,
)
from ..services.media_types import VIDEO_EXTENSIONS, AUDIO_EXTENSIONS
from ..services.request_guards import require_loopback_request
from ..services import asset_io, asset_mounts, asset_paths, asset_tree, thumbs
from ..services.path_safety import safe_join


_require_mount_manager = _assets_access.require_mount_manager
_require_local_assets = _assets_access.require_local_assets



def _mounts_file() -> Path:
    """등록된 외부 폴더(마운트) 영속 파일 — **활성 계정 DB 폴더 안**(계정별 격리).
    ★DB·마이그레이션과 동일하게 계정 키=이메일(account_key)을 써야 같은 폴더를 가리킨다.
    (예전엔 uid 를 써서 DB 는 email 폴더, 마운트는 uid 폴더로 갈려 로그인 후 마운트가 사라졌다.)
    로그인하면 data/db/acct/<email-slug>/asset_mounts.json, 미로그인/단독이면 레거시 위치."""
    from ..active_account import account_dir, account_key

    key = account_key()
    return (account_dir(key) / "asset_mounts.json") if key else (DATA_DIR / "asset_mounts.json")

router = APIRouter(prefix="/api/assets", tags=["assets"])
router.include_router(assets_metadata.router)

_PROMPT_IMPORT_PROJECT = asset_paths.PROMPT_IMPORT_PROJECT
# 내장 스크래치 폴더(캡쳐·임포트)를 하나로 보여주는 합본 프로젝트 — 사이드바엔 두 폴더로 표시.
_COMBINED_INTERNAL = asset_paths.COMBINED_INTERNAL_PROJECT
_INTERNAL_FOLDERS = asset_paths.INTERNAL_FOLDERS
_PROJECT_HIDDEN_FOLDERS: dict[str, set[str]] = {
    "뻘뻘뻘": {"mosaic"},
}


def _tree_hidden_names(project: str, *, auto_project: bool) -> Optional[set[str]]:
    """프로젝트별 표시 제외 폴더를 반환한다. 실제 폴더나 파일은 변경하지 않는다."""
    hidden = set(_PROJECT_HIDDEN_FOLDERS.get(project, set()))
    if auto_project:
        hidden.add("render")
    return hidden or None


def _media_type(name: str) -> Optional[str]:
    return asset_io.media_type(name)


def _sha256_file(path: Path) -> Optional[str]:
    return asset_io.sha256_file(path)


def _find_same_media(
    dest: Path, digest: str, media_type: str, size: Optional[int] = None
) -> Optional[Path]:
    return asset_io.find_same_media(dest, digest, media_type, size)


# ── 업로드 스트리밍(청크) — 큰 파일을 통째로 메모리에 read 하지 않는다 ─────────────────
_UPLOAD_MAX_FILES = asset_io.UPLOAD_MAX_FILES
_ZIP_MAX_FILES = asset_io.ZIP_MAX_FILES
_UploadTooLarge = asset_io.UploadTooLarge


async def _stream_upload_tmp(up: UploadFile, dest_dir: Path) -> tuple[Path, int, str]:
    return await asset_io.stream_upload_tmp(up, dest_dir)


def _commit_unique_tmp(tmp: Path, dest_dir: Path, raw_name: str) -> Path:
    """temp 를 최종 파일명으로 원자적 확정(덮어쓰기 안 함). 이름 충돌은 _2, _3… 로 회피하되,
    os.link(하드링크)로 '없을 때만 생성'을 원자화해 동일 이름 동시 업로드 race 를 막는다.
    하드링크 불가 파일시스템은 O_EXCL 로 최종 이름을 선점한 뒤 replace 로 폴백."""
    try:
        return asset_io.commit_unique_tmp(tmp, dest_dir, raw_name)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


def _owner_mounts(owner: str) -> list[dict[str, str]]:
    """그 계정(owner)이 등록한 마운트만 — 각자 자기 것만 본다."""
    return asset_mounts.owner_mounts(_mounts_file(), owner, DEFAULT_WORKER_ID)


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
        links = {}
    # 로컬 링크가 비어도 진행한다 — 팀 공유 렌더 루트(p.render_root_path)만 있는 PC 에서도
    # 프로젝트가 Assets 자동 마운트로 잡히게 한다(아래 루프에서 render_root_path 우선).

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
        # 팀 공유 렌더경로(project.render_root_path) 우선, 없으면 레거시 로컬 링크.
        root = str(p.get("render_root_path") or link.get("root_path") or "").strip()
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
    # 합본(imp/cap)은 ASSETS_ROOT 기준 — 파일/썸네일 경로가 captures/xxx, imports/xxx 로 해석된다.
    if project == _COMBINED_INTERNAL:
        return ASSETS_ROOT, False
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


class ProjectsOut(BaseModel):
    projects: list[str]
    default: str
    root: str


@router.get(
    "/projects",
    response_model=ProjectsOut,
    dependencies=[Depends(_require_local_assets)],
)
def list_projects(request: Request, background: BackgroundTasks):
    """등록된 외부 폴더(마운트)만 프로젝트로 노출 — **내가 등록한 것만**(계정별 개인 목록).
    디스크 폴더 자동 인식은 하지 않는다 — 사용자가 '폴더 등록'에서 직접 등록한 것만 보인다."""
    projects = [m["name"] for m in _owner_mounts(actor_id(request))]
    for m in _auto_project_mounts(request):
        if m["name"] not in projects:
            projects.append(m["name"])
    # 내장 스크래치 폴더(captures/imports)는 하나로 합쳐 'imp/cap' 한 항목으로 노출(둘 중 하나라도 파일 있으면).
    #  → 사이드바에서 두 폴더로 갈라 보여준다(asset_tree.read_combined_tree).
    if _COMBINED_INTERNAL not in projects:
        for folder in _INTERNAL_FOLDERS:
            p = ASSETS_ROOT / folder
            if p.is_dir() and any(p.iterdir()):
                projects.append(_COMBINED_INTERNAL)
                break
    # 목록 조회는 디스크 재귀 순회를 유발하지 않는다. 썸네일 준비는 실제로 /tree 를 연
    # 현재 프로젝트에서만 수행한다(등록된 모든 네트워크 폴더를 미리 훑던 지연 제거).
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


@router.get("/mounts", dependencies=[Depends(_require_local_assets)])
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
    asset_mounts.upsert(_mounts_file(), name=name, location=str(p), owner=owner)
    return _mounts_payload(request)


@router.delete("/mounts/{name}", dependencies=[Depends(_require_mount_manager)])
def del_mount(name: str, request: Request):
    """등록된 외부 폴더 해제 — **내 것만** 지운다(남의 등록엔 영향 없음). 원본 폴더는 안 건드림."""
    owner = actor_id(request)
    asset_mounts.remove(_mounts_file(), name=name, owner=owner)
    return _mounts_payload(request)


@router.get("/tree", dependencies=[Depends(_require_local_assets)])
def project_tree(
    request: Request,
    background: BackgroundTasks,
    project: str = Query(...),
    fresh: bool = Query(False),
):
    """프로젝트 폴더 트리(폴더 + 미디어 파일) — 내가 등록한 마운트 안에서만 해석.
    fresh=1 이면 캐시를 먼저 무효화한다. 같은 프로젝트 동시 요청은 한 번의 순회로 합친다."""
    if project == _COMBINED_INTERNAL:  # 합본 — captures/imports 를 두 폴더로 묶어 반환
        # 합본도 실제 하위 폴더를 감시해야 외부 편집기의 같은 이름 덮어쓰기를 즉시 감지한다.
        try:
            from ..services import asset_watcher

            asset_watcher.watch_combined(
                ASSETS_ROOT,
                project,
                tuple(_INTERNAL_FOLDERS),
            )
        except Exception:  # noqa: BLE001 — 감시 등록 실패가 트리 조회를 막지 않게
            pass
        return {
            "project": project,
            "name": project,
            "children": asset_tree.read_combined_tree(
                ASSETS_ROOT,
                _INTERNAL_FOLDERS,
                fresh=fresh,
            ),
        }
    info = _project_dir_info(project, request)
    if not info:
        raise HTTPException(status_code=404, detail=f"프로젝트 없음: {project}")
    proj_dir, auto_project = info
    # 지금 보고 있는 이 프로젝트 폴더를 실시간 감시 등록(이미 감시 중이면 무시).
    # 파일이 바뀌면 watchdog 가 WS 로 알려 프론트가 새로고침 없이 갱신한다(Phase 2). 감시 불가 환경은 무해.
    try:
        from ..services import asset_watcher

        asset_watcher.watch(proj_dir, project, hide_render=auto_project)
    except Exception:  # noqa: BLE001 — 감시 등록 실패가 트리 조회를 막지 않게
        pass
    tree_read = asset_tree.read_project_tree(
        proj_dir,
        fresh=fresh,
        hidden_names=_tree_hidden_names(project, auto_project=auto_project),
    )
    children = tree_read.children
    # 폴더의 이미지·영상 썸네일/포스터를 백그라운드로 미리 구워 첫 스크롤 딜레이 제거(생성 라이브러리와 동일).
    # 캐시 미스(새로 훑은 경우)에만 + 최근 5분 내 같은 폴더 프리워밍이 있었으면 스킵(포커스 fresh 재조회가
    # 올 때마다 전체 재프리워밍이 재큐잉되던 것 방지). 비디오 ffmpeg 는 세마포어로 폭주 방지.
    if tree_read.scanned:
        media = asset_tree.collect_media(children, proj_dir)
        if media and not thumbs.prewarm_recently(str(proj_dir)):
            background.add_task(thumbs.prewarm_asset_thumbs, media)  # 두 버킷(256/512) 파일 단위 워밍
    return {"project": project, "name": proj_dir.name, "children": children}


# ── 파일별 메타데이터(소스/태그/코멘트/컬러) ─────────────────────────────
class AssetSourceIn(BaseModel):
    project: str
    path: str
    name: Optional[str] = None
    is_source: bool = True


class AssetSourceBatchItem(BaseModel):
    path: str
    name: Optional[str] = None


class AssetSourcesBatchIn(BaseModel):
    project: str
    items: list[AssetSourceBatchItem] = Field(default_factory=list)


_real_meta_key = asset_paths.real_meta_key


# 메타 쓰기(소스/태그/컬러/개인 노트) — 계정별 개인화라 **로컬 계정 DB** 에 저장한다(서버로
# 위임하지 않는다). 생성탭 @/# 피커(/api/sources)가 같은 로컬 asset_meta 를 읽으므로 여기서
# 서버로 새면 '에셋에서 정한 소스/태그가 생성탭에 안 뜨는' 단절이 생긴다(실측 버그). 디스크
# 파일이 있으면 재연결용 지문만 계산하고, 없어도 메타 자체는 (project,path,owner) 키로 저장한다.
@router.put("/source", dependencies=[Depends(_require_local_assets)])
def asset_set_source(body: AssetSourceIn, request: Request):
    # 에셋 메타는 계정별 개인화 — 내(actor_id) 설정만 만들고 바꾼다(남의 것과 안 섞임).
    # 소스로 켤 때 파일 내용 지문(sha256)을 함께 기록해, 이후 폴더가 바뀌어도 재매칭되게 한다.
    real_project, real_path = _real_meta_key(body.project, body.path)  # 합본이면 실제 폴더 기준으로
    content_sha: Optional[str] = None
    if body.is_source:
        proj_dir = _safe_project_dir(real_project, request)
        target = _safe_resolve(proj_dir, real_path) if proj_dir else None
        if target and target.is_file():
            content_sha = _sha256_file(target)
    repo.set_asset_source(
        real_project, real_path, body.name, body.is_source, actor_id(request), content_sha
    )
    return {"ok": True}


@router.put("/sources/batch", dependencies=[Depends(_require_local_assets)])
def asset_set_sources_batch(body: AssetSourcesBatchIn, request: Request):
    if len(body.items) > 500:
        raise HTTPException(status_code=400, detail="한 번에 최대 500개 파일까지 변경할 수 있습니다")
    prepared: list[tuple[str, str, Optional[str], bool, Optional[str]]] = []
    for item in body.items:
        real_project, real_path = _real_meta_key(body.project, item.path)
        content_sha: Optional[str] = None
        proj_dir = _safe_project_dir(real_project, request)
        target = _safe_resolve(proj_dir, real_path) if proj_dir else None
        if target and target.is_file():
            content_sha = _sha256_file(target)
        prepared.append((real_project, real_path, item.name, True, content_sha))
    count = repo.set_asset_sources_batch(prepared, actor_id(request))
    return {"ok": True, "count": count}


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
    v: Optional[str] = Query(None),
):
    """이미지 썸네일(리사이즈+디스크 캐시) — 그리드/리스트 스크롤 성능용.
    원본 풀해상도(수 MP) 대신 작은 이미지를 디코딩하게 해 렉을 없앤다.
    v(파일 버전)는 캐시 정책 분기용 — 붙어 있으면 그 URL 은 특정 내용에 1:1 대응이라 영구 캐시한다."""
    proj_dir = _safe_project_dir(project, request)
    if not proj_dir:
        raise HTTPException(status_code=404, detail=f"프로젝트 없음: {project}")
    target = _safe_resolve(proj_dir, path)
    if not target or not target.is_file():
        raise HTTPException(status_code=404, detail="파일 없음")
    # 썸네일 생성·캐시키는 thumbs 서비스로 단일화 — 엔드포인트와 pre-warm 이 같은 키를 써야
    # 미리 구운 캐시를 엔드포인트가 읽는다(예전엔 여기서 별도 재구현해 계약이 갈릴 위험이 있었다).
    # 이미지=리사이즈, 비디오=ffmpeg 첫 프레임 포스터(내 작업 라이브러리처럼 poster 로 씀).
    mt = _media_type(target.name)
    if mt == "image":
        cache = thumbs.ensure_thumb(target, w)
    elif mt == "video":
        cache = thumbs.ensure_video_poster(target, w)
    else:
        raise HTTPException(status_code=415, detail="썸네일은 이미지·영상만 지원")
    if not cache:
        # 비디오 포스터 실패(ffmpeg 없음·손상 파일 등)는 404. 그 타일은 포스터 없이 재생버튼만 뜬다
        # (preload=none 이라 첫 프레임은 안 뜸 — 드문 경우). 이미지 실패는 500.
        raise HTTPException(status_code=404 if mt == "video" else 500, detail="썸네일 생성 실패")
    thumbs.mark_thumb_used(cache)  # 실서빙 히트만 LRU 갱신(프리워밍 스윕은 제외)
    # v(파일 버전)가 붙은 URL 은 그 내용에 1:1 대응 → 영구·immutable 캐시로 다음부턴 요청 없이 즉시 표시.
    # v 가 없으면(옛 저장 URL·직접 호출) 매번 재검증(no-cache)해, 원본을 같은 이름으로 덮어써도
    # 브라우저가 옛 썸네일로 굳지 않게 한다. (버전 캐시버스터가 붙은 새 경로가 정상 경로다.)
    cache_control = "public, max-age=31536000, immutable" if v else "no-cache"
    return FileResponse(
        cache,
        media_type="image/jpeg",
        headers={"Cache-Control": cache_control},
    )


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
    # 합본(imp/cap)은 물리 폴더가 아니라 ASSETS_ROOT 뷰다. 루트(빈 dir)로 드롭하면 파일이 ASSETS_ROOT
    #  최상위에 저장돼 합본 트리에 안 보이고 루트를 오염시킨다 → imports 폴더로 보낸다(외부 파일 버킷).
    if project == _COMBINED_INTERNAL and not dir:
        dir = _PROMPT_IMPORT_PROJECT
    dest = _safe_resolve(proj_dir, dir) if dir else proj_dir
    if not dest or not dest.is_dir():
        raise HTTPException(status_code=400, detail="대상 폴더 없음")
    if len(files) > _UPLOAD_MAX_FILES:
        raise HTTPException(status_code=400, detail=f"한 번에 최대 {_UPLOAD_MAX_FILES}개까지 올릴 수 있습니다")

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

    if saved:
        asset_tree.invalidate_project_tree(proj_dir)  # 새 파일 반영 — 다음 트리 요청은 다시 훑는다
    return {"saved": saved, "skipped": skipped}


@router.post("/capture", dependencies=[Depends(_require_local_assets)])
async def upload_capture(request: Request, file: UploadFile = File(...)):
    """클립보드 캡쳐(이미지)를 내장 'captures' 폴더에 저장 + asset 토큰용 정보 반환.
    저장 즉시 레퍼런스(asset:captures|name)로 쓸 수 있고, Assets 에서도 탐색·태그·소스지정 가능.
    captures 는 내장 ASSETS_ROOT/captures 폴더(마운트 아님)라 owner 무관하게 thumb/file 서빙됨."""
    cap_dir = (ASSETS_ROOT / "captures").resolve()
    cap_dir.mkdir(parents=True, exist_ok=True)
    try:
        tmp, size, digest = await _stream_upload_tmp(file, cap_dir)
    except _UploadTooLarge:
        raise HTTPException(status_code=413, detail="캡쳐가 너무 큽니다")
    if size == 0:
        tmp.unlink(missing_ok=True)
        raise HTTPException(status_code=400, detail="빈 캡쳐")
    # 임포트와 동일 — 같은 내용(sha256)이 이미 captures 에 있으면 재사용(중복 방지). 크기 우선 비교로 가속.
    try:
        existing = await asyncio.to_thread(_find_same_media, cap_dir, digest, "image", size)
        if existing:
            tmp.unlink(missing_ok=True)
            return {"project": "captures", "path": existing.name, "name": existing.name, "type": "image", "reused": True}
        name = f"capture-{datetime.now().strftime('%Y%m%d-%H%M%S')}.png"  # 충돌은 _commit 이 _2 로 회피
        target = _commit_unique_tmp(tmp, cap_dir, name)
    except BaseException:
        # 스트리밍이 끝난 뒤 중복 검사·최종 확정에서 실패해도 .part 파일을 남기지 않는다.
        tmp.unlink(missing_ok=True)
        raise
    asset_tree.invalidate_project_tree(cap_dir)  # 새 캡쳐 즉시 반영 — 다음 트리 요청은 다시 훑는다
    asset_tree.invalidate_combined_tree(ASSETS_ROOT, _INTERNAL_FOLDERS)
    return {"project": "captures", "path": target.name, "name": target.name, "type": "image"}


@router.post("/reference-import", dependencies=[Depends(_require_local_assets)])
async def upload_reference_import(
    request: Request,
    project: str = Form(""),
    dir: str = Form(""),
    files: list[UploadFile] = File(...),
):
    """프롬프트/레퍼런스 트레이에 외부 파일을 직접 드롭할 때 쓰는 내장 가져오기.
    captures 처럼 **항상 전용 imports 폴더 하나**로 모은다(같은 파일은 해시로 재사용).
    project/dir 폼 인자는 하위호환으로 받되 무시 — 예전엔 '선택된 폴더 안 {dir}/import'로 저장해
    실제 프로젝트 폴더를 오염시켰다(CH/import, CH/import/import ...). 이제 흩뿌리지 않는다."""
    out_project = _PROMPT_IMPORT_PROJECT
    project_dir: Optional[Path] = None  # 항상 None → 저장 경로가 flat(파일명만, captures 와 동일)
    dest = (ASSETS_ROOT / _PROMPT_IMPORT_PROJECT).resolve()
    try:
        dest.relative_to(ASSETS_ROOT)
    except ValueError:
        raise HTTPException(status_code=500, detail="imports 경로 오류")
    dest.mkdir(parents=True, exist_ok=True)
    if len(files) > _UPLOAD_MAX_FILES:
        raise HTTPException(status_code=400, detail=f"한 번에 최대 {_UPLOAD_MAX_FILES}개까지 올릴 수 있습니다")

    saved: list[dict[str, Any]] = []
    skipped: list[str] = []
    committed_new = False  # 새 파일을 하나라도 확정했으면 트리 캐시 무효화 대상
    for up in files:
        raw = os.path.basename((up.filename or "").replace("\\", "/"))
        if not raw:
            continue
        mt = _media_type(raw)
        if mt not in ("image", "video", "audio"):
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
        # 폴더 내 기존 파일 비교 — 크기 우선(다르면 해시 스킵) 후 sha256. 동기 IO 라 스레드로 오프로딩.
        try:
            existing = await asyncio.to_thread(_find_same_media, dest, digest, mt, size)
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
        except BaseException:
            # 스트리밍 이후 예외도 정리해 실패한 드롭이 숨은 디스크 찌꺼기를 만들지 않게 한다.
            tmp.unlink(missing_ok=True)
            raise
        committed_new = True
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

    if committed_new:
        asset_tree.invalidate_project_tree(dest)  # 새 임포트 즉시 반영 — 다음 트리 요청은 다시 훑는다
        asset_tree.invalidate_combined_tree(ASSETS_ROOT, _INTERNAL_FOLDERS)
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
    if len(paths) > _ZIP_MAX_FILES:
        raise HTTPException(status_code=400, detail=f"한 번에 최대 {_ZIP_MAX_FILES}개까지 내보낼 수 있습니다")

    tmp = tempfile.NamedTemporaryFile(prefix="ch-export-", suffix=".zip", delete=False)
    tmp_path = tmp.name
    tmp.close()
    used: set[str] = set()
    seen_targets: set[str] = set()  # 같은 파일 반복 요청을 _2,_3… 으로 부풀리지 않게 dedup
    try:
        with zipfile.ZipFile(tmp_path, "w", zipfile.ZIP_DEFLATED) as zf:
            for rel in paths:
                target = _safe_resolve(proj_dir, rel)
                if not target or not target.is_file():
                    continue
                key = str(target).lower()
                if key in seen_targets:
                    continue  # 동일 실경로 중복 — 한 번만 담는다
                seen_targets.add(key)
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
            # ★인자 '리스트'로 넘기면 subprocess 가 경로에 공백이 있을 때 "/select,<경로>" 전체를
            #  통째로 따옴표로 감싸버린다(explorer "/select,C:\My Docs\a.png"). 이 형태는 explorer 가
            #  파싱 못 해 파일 선택 대신 기본 폴더(문서 등)가 열린다 → "원본을 못 찾는" 증상.
            #  명령 '문자열'로 넘겨 경로만 따옴표로 감싼(/select,"<경로>") 올바른 형태가 explorer 에
            #  그대로 전달되게 한다. shell=False 라 파일명 속 &, ^ 등 셸 메타문자도 그대로 리터럴(주입 없음).
            #  explorer 는 성공해도 종료코드 1 을 반환하므로 검사하지 않음.
            subprocess.Popen(f'explorer /select,"{target}"')
        elif sys.platform == "darwin":
            subprocess.Popen(["open", "-R", str(target)])
        else:
            subprocess.Popen(["xdg-open", str(target.parent)])
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=f"탐색기 열기 실패: {e}")
    return {"ok": True}


class ClipboardCopyIn(BaseModel):
    project: str
    paths: list[str]


# 이미지는 Claude 지원 세트(JPEG/PNG/GIF/WebP)만(BMP 제외). 여기에 모든 영상·오디오를 더한다.
# OS 클립보드는 파일 종류를 안 가리므로 미디어 파일이면 올린다 — 붙여넣는 대상(claude.ai 등)이 그 종류를
# 받는지는 대상 앱에 달림(이미지는 확실, 영상·오디오는 대상에 따라 다름).
_CLIPBOARD_IMAGE_EXT = (".png", ".jpg", ".jpeg", ".gif", ".webp")
_CLIPBOARD_MEDIA_EXT = _CLIPBOARD_IMAGE_EXT + VIDEO_EXTENSIONS + AUDIO_EXTENSIONS
_CLIPBOARD_MAX = 20  # 한 번에 올릴 최대 개수(과다 복사 방지)


@router.post("/clipboard-copy", dependencies=[Depends(_require_local_assets)])
def clipboard_copy_files(body: ClipboardCopyIn, request: Request):
    """선택한 어셋 원본 미디어(이미지·영상·오디오) 파일들을 OS 클립보드에 '파일 목록'(CF_HDROP)으로
    올린다(Windows·로컬 전용). 사용자가 외부 대화창(claude.ai)에서 Ctrl+V 하면 여러 파일이 한 번에
    첨부된다(탐색기 파일복사와 동일 원리). 브라우저 클립보드는 이미지 1장만 담기는 한계가 있어(영상·오디오
    불가), 로컬 백엔드가 대신 OS 클립보드를 채운다. (대상 앱이 그 종류를 받는지는 대상에 달림.)"""
    # 클립보드 덮어쓰기는 단순 조회보다 부작용이 크다 → AUTH 여부와 무관하게 loopback 을 직접 강제.
    require_loopback_request(request, "클립보드 복사는 로컬 허브에서만 가능합니다")
    if sys.platform != "win32":
        raise HTTPException(status_code=400, detail="이 기능은 Windows에서만 지원됩니다")
    proj_dir = _safe_project_dir(body.project, request)
    if not proj_dir:
        raise HTTPException(status_code=404, detail=f"프로젝트 없음: {body.project}")

    abs_paths: list[str] = []
    seen: set[str] = set()
    skipped = 0
    for rel in body.paths:
        target = _safe_resolve(proj_dir, rel)  # 경로 이탈 차단(safe_join)
        # is_file() 로 폴더 배제 + 허용 미디어(이미지·영상·오디오) 확장자만.
        if not target or not target.is_file() or target.suffix.lower() not in _CLIPBOARD_MEDIA_EXT:
            skipped += 1
            continue
        key = str(target)
        if key in seen:  # 중복 제거(순서 보존)
            continue
        seen.add(key)
        abs_paths.append(key)
        if len(abs_paths) >= _CLIPBOARD_MAX:
            break

    if not abs_paths:
        raise HTTPException(status_code=404, detail="복사할 미디어 파일이 없습니다")

    # 경로들을 임시 파일에 한 줄씩(UTF-8 BOM) 기록 → PowerShell 이 그 파일에서 읽어 클립보드에 올린다.
    #  ★경로를 명령 문자열에 직접 넣지 않는다(파일명 속 따옴표·$·백틱 인젝션 원천 차단). tmp 경로조차
    #   명령에 안 넣고 환경변수(MVHUB_CLIP_LIST)로 넘긴다. Windows 파일명에 개행 불가라 줄 구분이 안전.
    #  -Sta: 클립보드 API 는 STA 스레드 필요. Set-Clipboard 는 실제 데이터를 복사하므로 프로세스 종료 후 유지.
    fd, list_path = tempfile.mkstemp(suffix=".txt", prefix="mvhub_clip_")
    try:
        with os.fdopen(fd, "w", encoding="utf-8-sig", newline="\n") as f:
            f.write("\n".join(abs_paths))
        ps_cmd = (
            "Set-Clipboard -LiteralPath "
            "(Get-Content -LiteralPath $env:MVHUB_CLIP_LIST -Encoding UTF8 | Where-Object { $_ })"
        )
        try:
            proc = subprocess.run(
                ["powershell.exe", "-NoProfile", "-NonInteractive", "-Sta", "-Command", ps_cmd],
                env={**os.environ, "MVHUB_CLIP_LIST": list_path},
                capture_output=True,
                text=True,
                timeout=15,
            )
        except subprocess.TimeoutExpired:
            raise HTTPException(status_code=500, detail="클립보드 복사 시간 초과")
        if proc.returncode != 0:
            detail = (proc.stderr or "").strip() or "PowerShell 오류"
            raise HTTPException(status_code=500, detail=f"클립보드 복사 실패: {detail}")
    finally:
        try:
            os.unlink(list_path)
        except OSError:
            pass

    return {"ok": True, "count": len(abs_paths), "skipped": skipped}

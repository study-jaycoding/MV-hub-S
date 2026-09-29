"""Assets(구성) 라우터 — project-viewer 의 '구성 탭'(폴더 트리 브라우저) 포팅.

ASSETS_ROOT(= PV PROJECTS_DIR) 아래의 프로젝트 폴더를 트리로 보여주고 파일을 서빙한다.
프로젝트 = 루트 아래 한 폴더. 기본 테스트 폴더는 config.DEFAULT_PROJECT.

경로 보안: 모든 접근은 ASSETS_ROOT/<project> 안으로 제한(traversal 차단) — PV 의
safe_project_dir / safe_resolve 가드를 그대로 따른다.
"""

from __future__ import annotations

import asyncio
import logging
import os
import secrets
import subprocess
import sys
import tempfile
import threading
import time
import zipfile
from collections import OrderedDict
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
from ..services.media_types import (
    AUDIO_EXTENSIONS,
    IMAGE_EXTENSIONS,
    VIDEO_EXTENSIONS,
    asset_content_type,
)
from ..services.async_tools import to_thread_non_abandon
from ..services.request_guards import (
    require_local_machine_request,
    require_loopback_browser_request,
    require_loopback_request,
)
from ..services import (
    asset_io,
    asset_mounts,
    asset_paths,
    asset_tree,
    asset_watcher,
    resolve_library_dialog,
    resolve_project_library,
    resolve_selection_monitor,
    resolve_status_runner,
    thumbs,
    upload_limits,
)
from ..services.operational_logging import log_event
from ..services.path_safety import path_comparison_key, safe_join, unc_for_drive


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
    "뻘뻘뻘": {"mosaic", "reference"},
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


# ── 업로드 스트리밍(청크) — 큰 파일을 통째로 메모리에 read 하지 않는다 ─────────────────
_UPLOAD_MAX_FILES = asset_io.UPLOAD_MAX_FILES
_UPLOAD_TOTAL_MAX_BYTES = upload_limits.ASSET_UPLOAD_TOTAL_MAX_BYTES
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


def _validate_upload_batch(files: list[UploadFile]) -> None:
    """Starlette가 실제로 받은 파일 바이트 합계를 저장 시작 전에 검사한다."""
    try:
        upload_limits.validate_upload_batch(
            files,
            max_files=_UPLOAD_MAX_FILES,
            max_file_bytes=asset_io.UPLOAD_MAX_BYTES,
            max_total_bytes=_UPLOAD_TOTAL_MAX_BYTES,
        )
    except upload_limits.UploadLimitExceeded as exc:
        if exc.kind == "file_count":
            raise HTTPException(
                status_code=400,
                detail=f"한 번에 최대 {_UPLOAD_MAX_FILES}개까지 올릴 수 있습니다",
            ) from exc
        if exc.kind == "file_size":
            raise HTTPException(
                status_code=413,
                detail=(
                    f"{(exc.index or 0) + 1}번째 파일이 너무 큽니다"
                    f"(최대 {upload_limits.format_byte_limit(asset_io.UPLOAD_MAX_BYTES)})"
                ),
                headers=upload_limits.limit_headers(asset_io.UPLOAD_MAX_BYTES),
            ) from exc
        raise HTTPException(
            status_code=413,
            detail=(
                "한 번에 올릴 수 있는 파일 합계가 너무 큽니다"
                f"(최대 {upload_limits.format_byte_limit(_UPLOAD_TOTAL_MAX_BYTES)})"
            ),
            headers=upload_limits.limit_headers(_UPLOAD_TOTAL_MAX_BYTES),
        ) from exc


def _owner_mounts(owner: str) -> list[dict[str, str]]:
    """그 계정(owner)이 등록한 마운트만 — 각자 자기 것만 본다."""
    return asset_mounts.owner_mounts(_mounts_file(), owner, DEFAULT_WORKER_ID)


# 마운트 경로 해석 TTL 캐시 — 응답 없는 SMB 공유의 resolve()/is_dir() 는 요청마다 수 초~
# 수십 초 블로킹해(그리드 200장 = /thumb 200회) 스레드풀을 통째로 잠식했다.
# ★코덱스 리뷰 반영 2가지: ①TTL 은 I/O 가 '끝난 시점'부터 센다 — 시작 시점 기준이면
#   resolve 가 30초 걸리는 죽은 공유에서 실패 캐시가 저장 즉시 만료돼 무의미했다.
#   ②같은 경로의 동시 캐시 미스는 한 스레드만 실제 I/O 를 하고 나머지는 그 결과를
#   기다린다(in-flight 단일화) — 안 하면 첫 미스 폭주는 그대로였다.
_MOUNT_PATH_CACHE: dict[str, tuple[float, Optional[Path]]] = {}
_MOUNT_PATH_PENDING: dict[str, threading.Event] = {}
_MOUNT_PATH_LOCK = threading.Lock()
_MOUNT_PATH_TTL_OK = 5.0
_MOUNT_PATH_TTL_DEAD = 30.0


def _resolve_mount_path(raw: str) -> Optional[Path]:
    """경로 문자열 → 실재하는 폴더 Path(없으면 None). TTL 캐시 + 동시 미스 단일화."""
    while True:
        with _MOUNT_PATH_LOCK:
            hit = _MOUNT_PATH_CACHE.get(raw)
            if hit and hit[0] > time.monotonic():
                return hit[1]
            pending = _MOUNT_PATH_PENDING.get(raw)
            if pending is None:
                pending = threading.Event()
                _MOUNT_PATH_PENDING[raw] = pending
                break  # 이 스레드가 해석 담당
        # 다른 스레드가 해석 중 — 끝나면 캐시를 다시 읽는다(해석이 아주 오래 걸리면 재대기).
        pending.wait(timeout=35.0)
    try:
        try:
            p = Path(raw).resolve()
            result = p if p.is_dir() else None
        except OSError:
            result = None
        ttl = _MOUNT_PATH_TTL_OK if result is not None else _MOUNT_PATH_TTL_DEAD
        with _MOUNT_PATH_LOCK:
            _MOUNT_PATH_CACHE[raw] = (time.monotonic() + ttl, result)
        return result
    finally:
        with _MOUNT_PATH_LOCK:
            _MOUNT_PATH_PENDING.pop(raw, None)
        pending.set()


def _mount_dir(name: str, owner: str) -> Optional[Path]:
    """등록 이름 → 실제 폴더(그 계정 소유 안에서만 해석 — 남의 마운트엔 접근 못 함)."""
    for m in _owner_mounts(owner):
        if m["name"] == name:
            return _resolve_mount_path(m["path"])
    return None


def _auto_project_mounts(
    request: Request, workspace_id: Optional[str] = None
) -> list[dict[str, str]]:
    """PM 프로젝트 설정의 root_path 를 Assets 자동 마운트로 노출한다.

    수동 asset_mounts.json 에 쓰지 않고 매번 읽어 합친다. 프로젝트 설정을 바꾸면
    에셋창도 다음 로드부터 그대로 따라가게 하기 위해서다.

    workspace_id 가 오면 그 팀 워크스페이스의 프로젝트만 남긴다(생성 탭과 같은 규칙:
    팀 선택 시만 좁히고 개인·미선택은 전체). 수동 마운트는 이 경로를 타지 않으므로
    워크스페이스와 무관하게 항상 보인다 — 내가 직접 추가한 폴더는 팀 소속이 아니다.
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
        visible = repo.list_projects(
            include_archived=False, member_uid=member_uid, workspace_id=workspace_id
        ).get("projects") or []
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
        # ★여기서 resolve() 하지 않는다(디스크 I/O 없음) — 죽은 NAS 루트가 섞여 있으면
        #  /mounts·/projects 요청마다 블로킹됐다. 실제 해석은 사용 시점에 TTL 캐시
        #  (_resolve_mount_path)가 담당하고, 여기선 문자열 정규화만 한다.
        path = os.path.normpath(str(Path(root).expanduser()))
        used.add(name)
        out.append({"name": name, "path": path, "owner": "project", "project_id": pid})
    return out


def _auto_mount_dir(name: str, request: Request) -> Optional[tuple[Path, str]]:
    for m in _auto_project_mounts(request):
        if m["name"] == name:
            directory = _resolve_mount_path(m["path"])
            if directory is not None:
                return directory, m["project_id"]
    return None


def _project_dir_info(project: str, request: Request) -> Optional[tuple[Path, bool, str]]:
    """프로젝트 이름 → 실제 폴더 + 자동 PM 경로 여부 + watcher 등록 ID.

    두 번째 값이 True 면 PM 프로젝트 설정에서 온 경로다. 이 경우 Assets 트리에서
    Render 폴더는 숨기고, 나머지 제작 폴더만 보여준다.
    """
    # 합본(imp/cap)은 ASSETS_ROOT 기준 — 파일/썸네일 경로가 captures/xxx, imports/xxx 로 해석된다.
    if project == _COMBINED_INTERNAL:
        return ASSETS_ROOT, False, f"combined-root:{project}"
    owner = actor_id(request)
    # 내장 폴더(imports·captures)는 등록 폴더보다 먼저 이 PC 설치 폴더로 푼다 — 같은 이름의 등록
    # 폴더가 있어도 NAS 로 새지 않게(Jay 2026-09-29 옛 방식 복귀, Codex).
    if project in _INTERNAL_FOLDERS:
        cand = (ASSETS_ROOT / project).resolve()
        return (cand, False, asset_watcher.manual_registration_id(owner, project)) if cand.is_dir() else None
    # 내(owner)가 등록한 외부 폴더(마운트)가 있으면 그 경로 우선 — 임의 위치 허용.
    md = _mount_dir(project, owner)
    if md:
        return md, False, asset_watcher.manual_registration_id(owner, project)
    auto = _auto_mount_dir(project, request)
    if auto:
        directory, project_id = auto
        return directory, True, asset_watcher.auto_registration_id(project_id)
    cand = (ASSETS_ROOT / project).resolve()
    try:
        cand.relative_to(ASSETS_ROOT)
    except ValueError:
        return None
    if not cand.is_dir():
        return None
    return cand, False, asset_watcher.manual_registration_id(owner, project)


def _safe_project_dir(project: str, request: Request) -> Optional[Path]:
    info = _project_dir_info(project, request)
    return info[0] if info else None


def _safe_resolve(project_dir: Path, rel: str) -> Optional[Path]:
    return safe_join(project_dir, rel)  # 경로 이탈 차단은 공용 path_safety.safe_join 으로 단일화


def _safe_project_resolve(project: str, project_dir: Path, rel: str) -> Optional[Path]:
    """합본 뷰는 ASSETS_ROOT 전체가 아니라 captures/imports 아래만 파일 경계로 쓴다."""
    target = _safe_resolve(project_dir, rel)
    if target is None or project != _COMBINED_INTERNAL:
        return target
    for folder in _INTERNAL_FOLDERS:
        try:
            target.relative_to((project_dir / folder).resolve())
            return target
        except ValueError:
            continue
    return None


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
            if any(asset_tree.is_hidden_name(part) for part in rel.parts):
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


# ── 이 PC 사본을 가리키는 참조의 '서버 원본' 찾기(자동 복구 /locate) ──────────────────
# 끌어다 놓은 파일은 브라우저가 **내용만** 준다(원래 경로는 주지 않는다). 그래서 이 PC 사본을 가리키는
# 참조는 자동 복구가 프로젝트 폴더에서 **같은 내용**(사본이 없으면 경로·이름)을 찾아 원본으로 잇는다.
#
# 비용: 파일 내용을 다 읽으면 NAS 에서 너무 느리다 → **크기(stat)로 후보를 좁히고 그 후보만**
# 지문을 계산한다. 폴더 목록은 자동 복구 한 번(scan_id) 동안만 같이 쓴다(아래 스냅샷).
_LOCATE_LIMIT = 60000  # 이 개수를 넘기면 색인을 끊는다(끊기면 '없다'고 단정하지 않는다)


def _walk_media(proj_dir: Path, limit: int = _LOCATE_LIMIT) -> tuple[list[tuple[str, str, int]], bool]:
    """프로젝트 폴더의 미디어 파일 (상대경로, 이름, 크기) 목록과 완주 여부.

    ★os.scandir 로 한 번에 훑는다 — 목록 조회가 항목의 종류·크기를 함께 주므로 파일마다 NAS 에
    다시 묻지 않는다. 예전 `rglob` → 파일마다 `is_file`·`resolve`·`stat` 은 NAS 왕복이 여러 번이라
    뻘뻘뻘(항목 3만) 한 곳에 13.3초가 걸렸다(2026-09-28 실측, scandir 로 2.4초).

    예전과 같게 지키는 것:
      · 숨김 이름은 후보가 아니다 — 숨김 폴더는 **아예 내려가지 않는다**. 그래서 숨김 폴더 안의
        읽기 오류로 '완주 못 함'이 되지 않는다(그 안은 어차피 후보가 아니므로 이쪽이 더 맞다).
      · 링크·정션 폴더는 따라가지 않는다 — 루트 밖으로 샐 수 있다.
      · 파일 링크는 **실제 대상이 루트 안일 때만** 받고, 상대경로도 예전처럼 **대상 자리**로 둔다
        (옛 씬 토큰이 대상 경로를 담고 있을 수 있다 — 바꾸면 경로 뒷부분 일치가 사라진다, Codex).
      · 미디어 수가 limit 를 넘으면 거기서 멈추고 완주가 아니라고 알린다(넘친 항목은 넣지 않는다).
      · 못 읽은 폴더·파일이 있으면 완주가 아니다 — '없다'고 단정하지 않게.
    """
    found: list[tuple[str, str, int]] = []
    scanned_all = True
    stack: list[tuple[str, str]] = [("", str(proj_dir))]
    while stack:
        rel_dir, abs_dir = stack.pop()
        try:
            entries = os.scandir(abs_dir)
        except OSError:
            scanned_all = False
            continue
        with entries:
            for entry in entries:
                name = entry.name
                if asset_tree.is_hidden_name(name):
                    continue
                rel = f"{rel_dir}/{name}" if rel_dir else name
                try:
                    linked = entry.is_symlink() or entry.is_junction()
                    if entry.is_dir(follow_symlinks=False):
                        if not linked:
                            stack.append((rel, entry.path))
                        continue
                    if not _media_type(name):
                        continue
                    if linked:
                        target = Path(entry.path).resolve()
                        rel = target.relative_to(proj_dir).as_posix()  # 루트 밖이면 ValueError
                        name = target.name
                        if not target.is_file():
                            continue
                        size = target.stat().st_size
                    else:
                        if not entry.is_file(follow_symlinks=False):
                            continue
                        size = entry.stat(follow_symlinks=False).st_size
                except ValueError:
                    continue
                except OSError:
                    scanned_all = False
                    continue
                if len(found) >= limit:
                    return found, False
                found.append((rel, name, size))
    return found, scanned_all


def _build_index(proj_dir: Path) -> tuple[dict[int, list[str]], dict[str, list[str]], bool]:
    """한 번 훑어 두 색인을 만든다 — (크기 → 상대경로들), (파일이름 → 상대경로들). 캐시 없음."""
    entries, scanned_all = _walk_media(proj_dir)
    index: dict[int, list[str]] = {}
    names: dict[str, list[str]] = {}
    for rel, name, size in entries:
        index.setdefault(size, []).append(rel)
        names.setdefault(name.casefold(), []).append(rel)
    return index, names, scanned_all


# ── 자동 복구 스냅샷 ─────────────────────────────────────────────────────────────
# F5 한 번의 자동 복구가 참조를 200개씩 여러 번 묻는다. 요청마다 NAS 를 처음부터 다시 훑으면
# 같은 폴더를 여러 번 훑는다(실측: 요청 3번 × 16초). 그래서 **같은 복구 작업(scan_id)** 의 요청들은
# 첫 스캔을 같이 쓴다. 새 F5 는 새 scan_id 라 다시 훑으므로 '다른 PC 가 방금 넣은 동명 파일'을
# 놓쳐 '유일하다'고 오판하지 않는다(Codex 2026-09-28).
_SCAN_TTL = 300.0
_SCAN_MAX = 16  # 동시에 들고 있는 (계정·작업·폴더) 스냅샷 수 상한 — 넘치면 오래된 것부터 버린다
_SCAN_WAIT = 60.0  # 같은 폴더를 먼저 훑는 요청을 기다리는 최대 시간
_SCAN_SESSIONS: "OrderedDict[tuple[str, str, str], tuple[float, tuple[dict[int, list[str]], dict[str, list[str]], bool]]]" = OrderedDict()
# 지금 훑는 중인 폴더 — **작업 id 와 무관하게 폴더 기준**. NAS 가 멈춘 채 F5 를 되풀이하면 새 작업 id 마다
# 새 스캔이 같은 죽은 폴더에 붙잡혀 스레드가 쌓인다(Codex 2026-09-28). 폴더당 한 스캔만 돌게 한다.
_SCAN_INFLIGHT: dict[tuple[str, str], threading.Event] = {}
_SCAN_GUARD = threading.Lock()


def _locate_snapshot(
    owner: str, scan_id: str, proj_dir: Path
) -> tuple[dict[int, list[str]], dict[str, list[str]], bool]:
    """같은 복구 작업 안에서는 첫 스캔을 같이 쓴다. scan_id 가 없으면 매번 새로 훑는다.

    키 = 계정 + 작업 + 폴더 — 다른 계정·다른 작업이 섞이지 않게. 같은 키로 동시에 오면 **하나만**
    훑고 나머지는 그 결과를 기다린다(같은 폴더를 동시에 두 번 훑지 않게, Codex).
    """
    if not scan_id:
        return _build_index(proj_dir)
    folder = os.path.normcase(str(proj_dir))
    key = (owner, scan_id, folder)
    flight = (owner, folder)  # 같은 폴더는 작업 id 가 달라도 동시에 한 번만 훑는다
    while True:
        with _SCAN_GUARD:
            now = time.monotonic()
            for stale in [k for k, (t, _s) in _SCAN_SESSIONS.items() if now - t > _SCAN_TTL]:
                _SCAN_SESSIONS.pop(stale, None)
            hit = _SCAN_SESSIONS.get(key)
            if hit:
                _SCAN_SESSIONS.move_to_end(key)
                return hit[1]
            waiting = _SCAN_INFLIGHT.get(flight)
            mine = waiting is None
            if mine:
                waiting = threading.Event()
                _SCAN_INFLIGHT[flight] = waiting
        if not mine:
            if waiting.wait(timeout=_SCAN_WAIT):  # type: ignore[union-attr]
                continue  # 끝났으면 캐시에 있다. 실패했으면 내가 다시 훑는다.
            # 먼저 훑는 쪽이 NAS 에 멈춰 있다 — 영원히 기다리지 않고 이번엔 '완주 못 함'으로 돌린다.
            # 그러면 이 폴더로는 아무것도 바꾸지 않고, 다음 복구에서 다시 시도한다(Codex 2026-09-28).
            return {}, {}, False
        try:
            snap = _build_index(proj_dir)
            with _SCAN_GUARD:
                _SCAN_SESSIONS[key] = (time.monotonic(), snap)
                _SCAN_SESSIONS.move_to_end(key)
                while len(_SCAN_SESSIONS) > _SCAN_MAX:
                    _SCAN_SESSIONS.popitem(last=False)
            return snap
        finally:
            with _SCAN_GUARD:
                _SCAN_INFLIGHT.pop(flight, None)
            waiting.set()  # type: ignore[union-attr]


def _locate_by_content(
    proj_dir: Path,
    size: int,
    digest: str,
    name: str,
    snapshot: Optional[tuple[dict[int, list[str]], dict[str, list[str]], bool]] = None,
) -> tuple[Optional[str], bool]:
    """(내용이 같은 파일의 상대경로, 폴더를 끝까지 훑었는가). 못 찾으면 (None, 완주여부).
    후보 순서: 파일명이 같은 것 먼저 → 경로가 짧은 것 → 사전순(같은 입력이면 늘 같은 답).
    ★완주 여부를 함께 돌려주는 이유: 훑다 끊긴 결과를 '없다'로 단정하면 옛 씬을 엉뚱한
    프로젝트로 이어 버린다(Codex 2026-09-28)."""
    if size <= 0 or not digest:
        return None, True
    index, _names, scanned_all = snapshot or _build_index(proj_dir)
    same_size = index.get(size) or []
    if not same_size:
        return None, scanned_all
    ordered = sorted(same_size, key=lambda rel: (rel.rsplit("/", 1)[-1] != name, len(rel), rel))
    for rel in ordered:
        target = _safe_resolve(proj_dir, rel)
        if target and target.is_file() and _sha256_file(target) == digest:
            return rel, scanned_all
    return None, scanned_all


# 확장자만 바뀐 파일을 같은 그림으로 볼 수 있는 묶음 — 이미지는 이미지끼리, 영상은 영상끼리.
_EXT_FAMILIES = (IMAGE_EXTENSIONS, VIDEO_EXTENSIONS, AUDIO_EXTENSIONS)


def _locate_by_path(
    proj_dir: Path,
    rel: str,
    snapshot: Optional[tuple[dict[int, list[str]], dict[str, list[str]], bool]] = None,
) -> tuple[list[str], list[str], list[str], bool]:
    """상대경로로 같은 파일을 찾는다 — 사본이 없어 지문을 낼 수 없을 때의 길.

    (경로 뒷부분까지 맞는 것, 파일 이름만 맞는 것, 확장자만 다른 것, 완주 여부).
      · 같은 그림이라도 프로젝트를 어느 깊이로 등록했느냐에 따라 `CH/바바라/x.png` 도 되고
        `assets/CH/바바라/x.png` 도 된다 — 그래서 뒷부분 일치를 따로 모은다.
      · 확장자만 다른 것: 누가 `x.png` 를 `x.jpeg` 로 바꿔 저장해 두면 씬은 옛 `.png` 를 가리킨다
        (Jay 2026-09-28 실측: 매튜_바바라받으려는동작(e025)). **같은 종류끼리**(이미지↔이미지)이고
        **폴더 경로까지 같을 때만** 모은다 — 근거가 가장 약하므로 부르는 쪽이 맨 마지막에 쓴다.
    고르는 책임은 부르는 쪽에 둔다(여러 곳이면 바꾸지 않는다).
    """
    _index, names, scanned_all = snapshot or _build_index(proj_dir)
    name = rel.rsplit("/", 1)[-1]
    same_name = names.get(name.casefold()) or []
    tail = "/" + rel.casefold().lstrip("/")
    exact = [r for r in same_name if ("/" + r.casefold()).endswith(tail)]
    named = [r for r in same_name if r not in exact]

    other_ext: list[str] = []
    stem, dot, ext = name.rpartition(".")
    if dot and stem:
        mine = "." + ext.lower()
        family = next((f for f in _EXT_FAMILIES if mine in f), ())
        tail_stem = tail[: -len(mine)]  # 확장자를 뺀 경로 뒷부분
        for other in family:
            if other == mine:
                continue
            for cand in names.get((stem + other).casefold(), []):
                if ("/" + cand.casefold()).rsplit(".", 1)[0].endswith(tail_stem):
                    other_ext.append(cand)
    return exact, named, other_ext, scanned_all


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
    linked: list[str] = []  # PM 프로젝트에 연결된(자동 마운트) 이름 — 드롭다운 색 구분용


@router.get(
    "/projects",
    response_model=ProjectsOut,
    dependencies=[Depends(_require_local_assets)],
)
def list_projects(
    request: Request, background: BackgroundTasks, workspace_id: Optional[str] = None
):
    """등록된 외부 폴더(마운트)만 프로젝트로 노출 — **내가 등록한 것만**(계정별 개인 목록).
    디스크 폴더 자동 인식은 하지 않는다 — 사용자가 '폴더 등록'에서 직접 등록한 것만 보인다.
    workspace_id 가 오면 프로젝트 유래 폴더만 그 팀으로 좁힌다(수동 등록은 항상 노출)."""
    projects = [m["name"] for m in _owner_mounts(actor_id(request))]
    auto_names = [m["name"] for m in _auto_project_mounts(request, workspace_id)]
    for name in auto_names:
        if name not in projects:
            projects.append(name)
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
    linked_set = set(auto_names)
    return ProjectsOut(
        projects=projects,
        default=default,
        root=str(ASSETS_ROOT),
        linked=[p for p in projects if p in linked_set],
    )


# ── 외부 폴더 등록(마운트) 관리 ──────────────────────────────────────────────
class MountIn(BaseModel):
    name: str
    path: str


def _mounts_payload(request: Request, workspace_id: Optional[str] = None) -> dict:
    """마운트 목록 응답(수동 + 프로젝트 자동, 이름 중복 제거) — GET/POST/DELETE 공통.
    셋이 같은 스키마를 돌려줘야 등록/삭제 직후와 새로고침 목록이 어긋나지 않는다
    (auto 폴더가 사라졌다 되살아나 보이는 현상 방지)."""
    manual = [
        {"name": m["name"], "path": m["path"], "exists": _resolve_mount_path(m["path"]) is not None}
        for m in _owner_mounts(actor_id(request))
    ]
    names = {m["name"] for m in manual}
    auto = [
        {"name": m["name"], "path": m["path"], "exists": _resolve_mount_path(m["path"]) is not None, "auto": True}
        for m in _auto_project_mounts(request, workspace_id)
        if m["name"] not in names
    ]
    return {"mounts": manual + auto}


@router.get("/mounts", dependencies=[Depends(_require_local_assets)])
def list_mounts(request: Request, workspace_id: Optional[str] = None):
    """**내가 등록한** 외부 폴더 목록(+실제 존재 여부) — 계정별 개인 목록.
    workspace_id 가 오면 프로젝트 유래(auto) 항목만 그 팀으로 좁힌다."""
    return _mounts_payload(request, workspace_id)


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
    previous = next((m for m in _owner_mounts(owner) if m["name"] == name), None)
    asset_mounts.upsert(_mounts_file(), name=name, location=str(p), owner=owner)
    if previous and os.path.normcase(
        os.path.normpath(previous["path"])
    ) != os.path.normcase(str(p)):
        asset_watcher.unwatch(asset_watcher.manual_registration_id(owner, name))
    with _MOUNT_PATH_LOCK:  # 방금 검증한 경로가 실패로 캐시돼 있으면(복구 직후 재등록) 즉시 무효화
        _MOUNT_PATH_CACHE.clear()
    return _mounts_payload(request)


@router.delete("/mounts/{name}", dependencies=[Depends(_require_mount_manager)])
def del_mount(name: str, request: Request):
    """등록된 외부 폴더 해제 — **내 것만** 지운다(남의 등록엔 영향 없음). 원본 폴더는 안 건드림."""
    owner = actor_id(request)
    asset_mounts.remove(_mounts_file(), name=name, owner=owner)
    asset_watcher.unwatch(asset_watcher.manual_registration_id(owner, name))
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
    proj_dir, auto_project, registration_id = info
    # 지금 보고 있는 이 프로젝트 폴더를 실시간 감시 등록(이미 감시 중이면 무시).
    # 파일이 바뀌면 watchdog 가 WS 로 알려 프론트가 새로고침 없이 갱신한다(Phase 2). 감시 불가 환경은 무해.
    try:
        asset_watcher.watch(
            proj_dir,
            project,
            hide_render=auto_project,
            registration_id=registration_id,
        )
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
    target = _safe_project_resolve(project, proj_dir, path)
    if not target or not target.is_file():
        raise HTTPException(status_code=404, detail="파일 없음")
    content_type = asset_content_type(target.name)
    if content_type is None:
        # 마운트 폴더에는 미디어 외 파일도 있을 수 있다. 트리에서 숨기는 것만으로는 직접 URL을
        # 막지 못하므로 HTTP 경계에서도 차단한다. 특히 HTML/SVG/스크립트를 같은 오리진으로
        # 실행하지 않는 것이 핵심이다.
        raise HTTPException(status_code=415, detail="지원하지 않는 Assets 파일 형식입니다")
    return FileResponse(
        target,
        media_type=content_type,
        filename=target.name,
        content_disposition_type="inline",
        headers={
            "X-Content-Type-Options": "nosniff",
            "Content-Security-Policy": "default-src 'none'; sandbox",
            "Cross-Origin-Resource-Policy": "same-origin",
            # 원본은 같은 경로에서 외부 편집기로 교체될 수 있으므로 매번 유효성을 확인한다.
            "Cache-Control": "no-cache",
        },
    )


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
    target = _safe_project_resolve(project, proj_dir, path)
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
        # 손상 파일·미지원 서브포맷·잠금 등 '그 파일의 문제'다 — 서버 오류(500)로 내면 손상 파일
        # 하나가 그리드 스크롤마다 에러 로그 폭탄을 만든다. 이미지·비디오 모두 404 로 통일
        # (그 타일만 조용히 비고, 배포·서버 상태 경보를 오염시키지 않는다).
        raise HTTPException(status_code=404, detail="썸네일 생성 실패(손상되었거나 열 수 없는 파일)")
    thumbs.mark_thumb_used(cache)  # 실서빙 히트만 LRU 갱신(프리워밍 스윕은 제외)
    # v(파일 버전)가 붙은 URL 은 그 내용에 1:1 대응 → 영구·immutable 캐시로 다음부턴 요청 없이 즉시 표시.
    # v 가 없으면(옛 저장 URL·직접 호출) 매번 재검증(no-cache)해, 원본을 같은 이름으로 덮어써도
    # 브라우저가 옛 썸네일로 굳지 않게 한다. (버전 캐시버스터가 붙은 새 경로가 정상 경로다.)
    cache_control = "public, max-age=31536000, immutable" if v else "no-cache"
    return FileResponse(
        cache,
        media_type="image/jpeg",
        headers={
            "Cache-Control": cache_control,
            "X-Content-Type-Options": "nosniff",
            "Content-Security-Policy": "default-src 'none'; sandbox",
            "Cross-Origin-Resource-Policy": "same-origin",
        },
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
    # SMB 경로 해석(_safe_project_dir — 죽은 NAS 는 최대 수십 초)·목적지 검사·배치 검증을
    # 스레드로(R7 2-G') — async 라우트 위 동기 파일시스템 대기가 전체 요청을 세웠다.
    def _resolve_destination() -> tuple[Path, Path]:
        proj_dir_local = _safe_project_dir(project, request)
        if not proj_dir_local:
            raise HTTPException(status_code=404, detail=f"프로젝트 없음: {project}")
        # 합본(imp/cap)은 물리 폴더가 아니라 ASSETS_ROOT 뷰다. 루트(빈 dir)로 드롭하면 파일이
        # ASSETS_ROOT 최상위에 저장돼 합본 트리에 안 보이고 루트를 오염시킨다 → imports 폴더로.
        nonlocal dir
        if project == _COMBINED_INTERNAL and not dir:
            dir = _PROMPT_IMPORT_PROJECT
        dest_local = (
            _safe_project_resolve(project, proj_dir_local, dir) if dir else proj_dir_local
        )
        if not dest_local or not dest_local.is_dir():
            raise HTTPException(status_code=400, detail="대상 폴더 없음")
        _validate_upload_batch(files)
        return proj_dir_local, dest_local

    proj_dir, dest = await asyncio.to_thread(_resolve_destination)

    saved: list[str] = []
    skipped: list[str] = []
    commit_attempted = [False]
    try:
        await _upload_files_loop(files, dest, proj_dir, saved, skipped, commit_attempted)
    finally:
        # 취소로 루프가 중단돼도 이미 커밋된 파일이 트리에 반영되게(코덱스 P1) —
        # ★saved 가 아니라 '커밋 시도' 기준(재확인 P1): 커밋 스레드는 완주해 파일을
        # 확정하지만 취소 전파로 saved.append 는 안 돌 수 있다. 무효화는 멱등·저렴.
        if saved or commit_attempted[0]:
            asset_tree.invalidate_project_tree(proj_dir)
    return {"saved": saved, "skipped": skipped}


async def _upload_files_loop(
    files: list[UploadFile],
    dest: Path,
    proj_dir: Path,
    saved: list[str],
    skipped: list[str],
    commit_attempted: list[bool],
) -> None:
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
        # 원자적 확정(hardlink/O_EXCL — 덮어쓰기·race 방지)도 스레드로(R7 2-G') —
        # non-abandon(코덱스 P1): 취소돼도 커밋 스레드 완료까지 대기.
        commit_attempted[0] = True  # 취소돼도 finally 의 트리 무효화가 돌게 먼저 표시
        target = await to_thread_non_abandon(_commit_unique_tmp, tmp, dest, raw)
        saved.append(target.relative_to(proj_dir).as_posix())


@router.post("/capture", dependencies=[Depends(_require_local_assets)])
async def upload_capture(request: Request, project: str = Form(""), file: UploadFile = File(...)):
    """붙여넣은 그림·부분수정 결과를 **이 PC 설치 폴더의 captures** 에 저장 + asset 토큰용 정보 반환.

    ★2026-09-29 Jay "옛 방식으로 해야한다": 09-28 에 프로젝트 폴더(NAS)로 옮겼던 것을 되돌렸다.
    그 PC 에만 있으므로 캔버스가 빨간 테두리·오른쪽 위 마크로 알린다. project 폼 값은 하위호환으로
    받되 쓰지 않는다."""
    _validate_upload_batch([file])
    project = "captures"  # 응답 토큰도 asset:captures|… 로 고정(같은 이름의 등록 폴더로 새지 않게)
    proj_dir = cap_dir = (ASSETS_ROOT / project).resolve()
    cap_dir.mkdir(parents=True, exist_ok=True)
    try:
        tmp, size, digest = await _stream_upload_tmp(file, cap_dir)
    except _UploadTooLarge:
        raise HTTPException(
            status_code=413,
            detail=(
                "캡쳐가 너무 큽니다"
                f"(최대 {upload_limits.format_byte_limit(asset_io.UPLOAD_MAX_BYTES)})"
            ),
            headers=upload_limits.limit_headers(asset_io.UPLOAD_MAX_BYTES),
        )
    if size == 0:
        tmp.unlink(missing_ok=True)
        raise HTTPException(status_code=400, detail="빈 캡쳐")
    # 임포트와 동일 — 같은 내용(sha256)이 이미 captures 에 있으면 재사용(중복 방지). 크기 우선 비교로 가속.
    commit_attempted = False
    try:
        name = f"capture-{datetime.now().strftime('%Y%m%d-%H%M%S')}.png"  # 충돌은 _commit 이 _2 로 회피
        commit_attempted = True  # 취소 재전파 전 실제 파일 확정 가능 — finally 무효화 기준
        target, reused, discard_token = await to_thread_non_abandon(
            _commit_capture_with_discard_token,
            tmp,
            cap_dir,
            name,
            digest,
            size,
            project,
            proj_dir,
        )
    except BaseException:
        # 스트리밍이 끝난 뒤 중복 검사·최종 확정에서 실패해도 .part 파일을 남기지 않는다.
        tmp.unlink(missing_ok=True)
        raise
    finally:
        if commit_attempted:
            asset_tree.invalidate_project_tree(proj_dir)
            asset_tree.invalidate_combined_tree(ASSETS_ROOT, _INTERNAL_FOLDERS)  # Assets 의 imp/cap 합본
    rel = target.relative_to(proj_dir).as_posix()
    if reused:
        return {
            "project": project, "path": rel, "name": target.name, "type": "image",
            "reused": True, "sha256": digest, "bytes": size,
        }
    return {
        "project": project,
        "path": rel,
        "name": target.name,
        "type": "image",
        "sha256": digest,  # 나중에 원본이 옮겨져도 내용으로 다시 찾기 위한 표식
        "bytes": size,
        # 신규 파일에만 1회용 정리 토큰 — 생성 요청이 확정 거절(4xx)로 끝난 고아만
        # 프론트가 이 토큰으로 지울 수 있다(아래 /capture-discard).
        "discard_token": discard_token,
    }


# ── 캡처 고아 정리 — 부분 수정이 올린 캡처가 생성 요청 확정 실패로 잡과 연결되지 못한
# 경우의 1회용 삭제. 임의 경로 삭제를 막기 위해 서버가 신규 업로드에만 발급한 토큰으로만
# 동작하고, reference 가 참조 중이면 지우지 않는다(코덱스 합의). 단일 프로세스 전제의
# 인메모리 토큰(TTL 15분) — 앱 재시작이면 토큰 소멸 = 정리 포기(비파괴 방향).
_CAPTURE_DISCARD_TTL = 15 * 60.0
# token -> (프로젝트, 상대경로, 확정 당시 물리경로 비교키, 내용 지문, 만료 monotonic)
#  ★2026-09-28: 캡처가 프로젝트 폴더로 옮겨가면서 파일명 하나로는 대상을 특정할 수 없다.
#  지우기 직전에 **그때 그 파일이 맞는지**(절대경로·지문)까지 확인한다 — 15분 사이 프로젝트
#  폴더 설정이 바뀌면 같은 상대경로가 다른 파일을 가리킬 수 있다(Codex 지적).
_capture_discard_tokens: dict[str, tuple[str, str, str, str, float]] = {}
# RLock: reuse 확정(_finalize_reused_capture)과 삭제(discard)가 같은 락 경계를 공유해야
# 'B 가 reused 로 고른 파일을 A 의 discard 가 그 사이 지우는' 경합이 닫힌다(코덱스 BLOCK).
_capture_discard_lock = threading.RLock()


def _capture_path_key(target: Path) -> str:
    """같은 물리 파일의 드라이브 대소문자·extended path·알려진 UNC 별칭을 한 키로 맞춘다."""
    resolved = path_comparison_key(target.resolve())
    mapped = unc_for_drive(str(resolved))
    comparable = path_comparison_key(Path(mapped or str(resolved)))
    return os.path.normcase(str(comparable))


def _commit_capture_with_discard_token(
    tmp: Path, cap_dir: Path, name: str, digest: str, size: int, project: str, proj_dir: Path
) -> tuple[Path, bool, Optional[str]]:
    """워커 스레드에서 실행 — 커밋/재사용 판정과 토큰 발급·무효화를 discard 와 같은 락
    안에서 원자로 처리한다(코덱스 BLOCK 2차: 신규 커밋과 토큰 발급 사이에 reuse 가
    끼어들면, reuse 확정 이후 발급된 토큰으로 참조 중인 파일이 삭제될 수 있었다).

    · 신규 커밋 → 같은 락 안에서 토큰 발급 = 이후의 reuse 확정이 반드시 그 토큰을 본다.
    · reuse → 옛 토큰 무효화 + 파일 실존 검증(discard 가 pop→검사→unlink 를 같은 락
      안에서 다 하므로, 여기서 보인 파일은 이후 옛 토큰으로 절대 지워지지 않는다).
      이미 지워졌으면 사라진 경로 응답 대신 409 로 재시도를 유도한다."""
    with _capture_discard_lock:
        target, reused = asset_io.find_or_commit_media(tmp, cap_dir, name, digest, "image", size)
        rel = target.relative_to(proj_dir).as_posix()
        if reused:
            # project 이름이 달라도 같은 물리 폴더를 가리킬 수 있다. 논리 토큰이 아니라 파일 키로
            # 옛 정리 권한을 없애야 다른 별칭에서 재사용한 파일을 먼저 올린 쪽이 지우지 못한다.
            _invalidate_capture_discard_tokens(target)
            if not target.exists():
                raise HTTPException(status_code=409, detail="캡처가 방금 정리되었습니다 — 다시 시도하세요")
            return target, True, None
        return target, False, _issue_capture_discard_token(project, rel, target, digest)


def _issue_capture_discard_token(project: str, rel: str, target: Path, digest: str) -> str:
    now = time.monotonic()
    target_key = _capture_path_key(target)
    with _capture_discard_lock:
        # 만료 청소 + 같은 파일을 가리키는 옛 토큰 제거(새 업로드가 상태의 기준)
        for t, (_p, _r, key, _sha, exp) in list(_capture_discard_tokens.items()):
            if exp < now or key == target_key:
                _capture_discard_tokens.pop(t, None)
        token = secrets.token_urlsafe(16)
        _capture_discard_tokens[token] = (
            project, rel, target_key, digest, now + _CAPTURE_DISCARD_TTL,
        )
    return token


def _invalidate_capture_discard_tokens(target: Path) -> None:
    target_key = _capture_path_key(target)
    with _capture_discard_lock:
        for t, (_p, _r, key, _sha, _exp) in list(_capture_discard_tokens.items()):
            if key == target_key:
                _capture_discard_tokens.pop(t, None)


class CaptureDiscardIn(BaseModel):
    token: str


@router.post("/capture-discard", dependencies=[Depends(_require_local_assets)])
def discard_capture(body: CaptureDiscardIn, request: Request):
    """캡처 고아 정리 — 신규 업로드에 발급된 1회용 토큰으로만. 프론트는 생성 요청이
    서버에 커밋되지 않았음이 확실한 실패(400/422)일 때만 부른다 — 네트워크 오류·5xx·
    타임아웃은 커밋됐을 수 있어 부르지 않는다(그 잔존은 문서화된 수용 사항)."""
    require_local_machine_request(
        request, "캡처 정리는 해당 작업자 PC에서만 실행할 수 있습니다"
    )
    now = time.monotonic()
    # pop→참조검사→unlink 전체를 한 락 안에서 — reuse 확정(_finalize_reused_capture)과
    # 원자화해 'reused 로 고른 직후 파일이 사라지는' 경합을 닫는다(코덱스 BLOCK).
    # 락 안의 sqlite 1건 조회는 짧고(로컬 파일 DB) capture 업로드는 드물어 병목 아님.
    with _capture_discard_lock:
        entry = _capture_discard_tokens.pop(body.token, None)
        if entry is None or entry[4] < now:
            raise HTTPException(status_code=404, detail="정리 토큰이 없거나 만료되었습니다")
        project, rel, committed_key, committed_sha = entry[0], entry[1], entry[2], entry[3]
        with get_connection() as conn:
            row = conn.execute(
                "SELECT 1 FROM reference WHERE file_path = ? LIMIT 1",
                (f"asset:{project}|{rel}",),
            ).fetchone()
        if row:
            raise HTTPException(status_code=409, detail="생성물이 참조하는 파일이라 지우지 않습니다")
        proj_dir = _safe_project_dir(project, request)
        target = _safe_resolve(proj_dir, rel) if proj_dir else None
        if not proj_dir or target is None:  # 토큰은 서버 발급이라 정상경로지만 이중 방어
            raise HTTPException(status_code=400, detail="잘못된 경로")
        # ★올릴 때의 그 파일이 맞을 때만 지운다 — 그 사이 프로젝트 폴더 설정이 바뀌었거나
        #  같은 자리를 다른 파일이 차지했으면 지우지 않고 보류한다(Codex 2026-09-28).
        if _capture_path_key(target) != committed_key:
            raise HTTPException(status_code=409, detail="그때 올린 파일이 아니라 지우지 않습니다")
        # 이미 없으면 정리 목적은 달성됐다. 파일이 있을 때만 지문을 확인해 같은 자리에 생긴
        # 다른 파일을 지우지 않는다. 토큰은 위에서 pop 했으므로 이 성공도 1회용이다.
        if target.exists():
            if _sha256_file(target) != committed_sha:
                raise HTTPException(status_code=409, detail="그때 올린 파일이 아니라 지우지 않습니다")
            try:
                target.unlink(missing_ok=True)
            except OSError:
                raise HTTPException(status_code=409, detail="파일을 지우지 못했습니다")
        # 한계: 업로드 재사용 없이 다른 project 별칭으로 직접 참조한 경우 exact logical 조회는
        # 그 별칭을 못 본다. 완전 차단은 reference 에 물리경로 색인을 추가하는 별도 DB 작업이다.
    asset_tree.invalidate_project_tree(proj_dir)
    asset_tree.invalidate_combined_tree(ASSETS_ROOT, _INTERNAL_FOLDERS)
    return {"ok": True}


class LocateIn(BaseModel):
    tokens: list[str] = Field(default_factory=list)
    # 이 캔버스 탭에 지정된 팀 워크스페이스(씬 파일에 함께 온다). 있으면 **그 공간에 등록된
    # 프로젝트 폴더부터** 찾고, 거기서 찾히면 다른 곳은 보지 않는다 — 같은 이름이 여러 곳에
    # 있어도 헷갈리지 않는다(Jay 2026-09-28).
    workspace_id: str = ""
    # 자동 복구 한 번(F5 한 번)을 가리키는 id. 같은 id 의 요청들은 첫 스캔을 같이 쓴다 —
    # 참조를 200개씩 여러 번 묻는 동안 같은 NAS 폴더를 매번 다시 훑지 않게. 없으면 매번 새로 훑는다.
    scan_id: str = Field(default="", max_length=64)


_LOCATE_MAX_TOKENS = 200
_log = logging.getLogger("mvhub.assets")


@router.post("/locate", dependencies=[Depends(_require_local_assets)])
def locate_legacy_assets(body: LocateIn, request: Request):
    """지금 이 PC 에서 **열리지 않는** 씬 참조를, 보이는 프로젝트 폴더의 같은 파일로 이어 준다.

    ★Jay 2026-09-28: "어느 방식으로 가져와도 서버에 그 파일이 있다면 모두에게 똑같이 보이게".
    그래서 두 가지를 모두 본다.
      · `imports`·`captures` 사본 참조 — 예전에 설치 폴더 안으로 복사된 것
      · 프로젝트 이름은 붙었지만 **이 PC 가 그 프로젝트를 못 보는** 참조 — 같은 폴더를 사람마다
        다른 이름·다른 깊이로 등록해 생긴다(`뻘뻘뻘`=…/10_ai, `뻘뻘뻘_RnD`=…/10_ai/assets).

    찾는 순서는 근거가 센 것부터다. ① 이 PC 에 사본이 있으면 **내용 지문** ② 없으면 **경로 뒷부분**
    ③ 그것도 없으면 **파일 이름**. 어느 단계든 **정확히 한 곳에서만** 찾혔을 때만 바꾼다 — 여러 곳에
    있으면 어느 것인지 단정할 수 없어 그대로 둔다.

    못 고친 참조 중 둘은 따로 알려 준다(Jay 2026-09-29 — 캔버스가 빨간 테두리로 그린다).
      · `missing` — 이 PC 에서도 안 열리고, 등록한 폴더를 **전부 끝까지** 훑어도 후보가 하나도 없다
      · `local` — 설치 폴더 안 옛 사본(imports·captures)에만 있다. 같은 내용이 서버에 한 곳도 없다
    NAS 가 끊겨 폴더를 못 읽으면 어느 쪽도 말하지 않는다 — '없는 것'과 '못 읽는 것'을 섞지 않는다."""
    started = time.perf_counter()
    fixed: list[dict[str, Any]] = []
    unresolved: list[str] = []
    missing: list[str] = []
    local_only: list[str] = []
    status_of: dict[str, list[str]] = {}  # 토큰 → 실린 목록(missing/local) — 중복 토큰에 같은 답을 싣는다
    owner = actor_id(request)
    # 내가 등록한 폴더도 PM 프로젝트도 **모두** 뒤진다 — 둘 다 같은 서버(NAS)를 가리키므로
    # 어느 쪽에서 찾든 같은 파일이다(Jay 2026-09-28). 이름이 겹쳐도 빼지 않는다. 대신 아래에서
    # 후보를 **물리 경로로 묶어** 같은 파일이 두 번 세어지지 않게 한다 — 같은 폴더를 두 이름·두
    # 깊이로 등록하면(`뻘뻘뻘`=…/10_ai, `뻘뻘뻘_RnD`=…/10_ai/assets) 한 그림이 두 곳에서
    # 찾히는데, 그걸 '여럿'으로 세면 도리어 아무것도 못 고친다.
    mounts = [
        m
        for m in [*_owner_mounts(owner), *_auto_project_mounts(request)]
        if m["name"] not in _INTERNAL_FOLDERS and m["name"] != _COMBINED_INTERNAL
    ]
    names = {m["name"] for m in mounts}
    project_dirs: list[tuple[str, Path]] = []
    for name in sorted(names):
        proj_dir = _safe_project_dir(name, request)
        if proj_dir:
            project_dirs.append((name, proj_dir))
    # '서버에 없다'는 등록한 폴더를 **모두 훑었을 때만** 말한다(Codex 2026-09-29). 이름 해석
    # (_safe_project_dir)은 ① 죽은 등록 대신 설치 폴더의 같은 이름 폴더로 넘어가고 ② 같은 이름을 개인
    # 등록과 PM 이 다른 폴더로 가리키면 개인 쪽만 준다 — 그래서 등록한 **원래 경로**가 살아 있고,
    # 그 이름으로 실제로 훑는 폴더와 같은 곳인지 하나씩 본다. 방금 해석한 경로라 대부분 TTL 캐시를 친다.
    # ponytail: 고장 난 옛 등록이 하나라도 있으면 그 PC 는 빨강을 못 낸다(안전한 쪽). 필요해지면
    #   그 경로의 공유 뿌리가 닿는지로 '옛 등록'과 'NAS 끊김'을 가른다.
    searched = dict(project_dirs)

    def searched_as_registered(m: dict[str, str]) -> bool:
        real = _resolve_mount_path(m["path"]) if m.get("path") else None
        here = searched.get(m["name"])
        return real is not None and here is not None and _capture_path_key(real) == _capture_path_key(here)

    can_judge = bool(project_dirs) and all(searched_as_registered(m) for m in mounts)

    # 폴더는 **미리 다 훑지 않는다** — 필요할 때 그 폴더만 훑는다. 공간(1바퀴)에서 다 찾히면 나머지
    # 프로젝트는 아예 안 훑는다. 예전에는 공간으로 좁히기 전에 전부 훑어 좁히기가 속도에 아무
    # 효과가 없었다(Codex 2026-09-28).
    # 한 요청 안에서는 같은 폴더를 한 번만 훑고, 같은 복구 작업(scan_id)의 다음 요청도 그 스냅샷을
    # 이어 쓴다. 새 복구 작업은 새로 훑는다 — 방금 추가된 동명 파일을 놓치지 않게.
    scan_id = (body.scan_id or "").strip()
    snapshots: dict[str, tuple[dict[int, list[str]], dict[str, list[str]], bool]] = {}

    def snapshot_of(proj_dir: Path) -> tuple[dict[int, list[str]], dict[str, list[str]], bool]:
        key = str(proj_dir)
        if key not in snapshots:
            snapshots[key] = _locate_snapshot(owner, scan_id, proj_dir)
        return snapshots[key]

    dirs_by_name = dict(project_dirs)
    # 캔버스 탭에 워크스페이스가 지정돼 있으면 **그 공간의 프로젝트만** 먼저 본다(1바퀴).
    # 거기서 못 찾았을 때만 전체를 본다(2바퀴).
    workspace_id = (body.workspace_id or "").strip()
    rounds: list[list[tuple[str, Path]]] = []
    if workspace_id:
        try:
            scoped_mounts = _auto_project_mounts(request, workspace_id)
        except Exception:  # noqa: BLE001 — 그 공간을 못 읽으면 전체로 넘어간다
            scoped_mounts = []
        scoped: list[tuple[str, Path]] = []
        for mount in scoped_mounts:
            # 이름이 아니라 **공간에 등록된 실제 폴더**를 훑는다. 이 PC 는 같은 이름의 개인 등록을
            # 먼저 보므로, 이름으로 좁히면 공간 밖 폴더를 훑게 된다(Codex 2026-09-28).
            space_dir = _resolve_mount_path(mount["path"])
            if space_dir is None:
                continue
            # 이 PC 에서 그 이름이 **다른 폴더**로 풀리면 쓰지 않는다 — 고친 참조가 이 PC 에서는
            # 엉뚱한 폴더를 가리키게 된다.
            here = dirs_by_name.get(mount["name"])
            if here is not None and _capture_path_key(here) != _capture_path_key(space_dir):
                continue
            scoped.append((mount["name"], space_dir))
        if scoped:
            rounds.append(scoped)
    rounds.append(project_dirs)

    def dedupe(cands: list[tuple[str, str]]) -> list[tuple[str, str]]:
        """같은 물리 파일을 가리키는 후보는 하나로 본다 — 한 폴더를 두 이름으로 등록했을 때
        같은 그림이 두 번 세어져 '여럿이라 못 고른다'가 되는 것을 막는다."""
        out: list[tuple[str, str]] = []
        seen_files: set[str] = set()
        for name, rel in cands:
            base = dirs_by_name.get(name)
            target = _safe_resolve(base, rel) if base else None
            key = _capture_path_key(target) if target else f"{name}|{rel}"
            if key in seen_files:
                continue
            seen_files.add(key)
            out.append((name, rel))
        return out

    def pick(cands: list[tuple[str, str]], complete: bool) -> Optional[dict[str, Any]]:
        """후보가 (같은 파일끼리 묶고 나서) 정확히 하나이고, 폴더를 끝까지 훑었을 때만 고른다."""
        if not complete:
            return None
        merged = dedupe(cands)
        if len(merged) != 1:
            return None
        return {"project": merged[0][0], "path": merged[0][1]}

    # 한 씬의 참조 수백 개가 같은 프로젝트를 가리킨다 — 폴더 해석은 이름마다 한 번만 한다
    # (수동 마운트 조회 + PM DB 조회가 들어 있다, Codex 2026-09-28).
    dir_cache: dict[str, Optional[Path]] = {}

    def project_dir_of(name: str) -> Optional[Path]:
        if name not in dir_cache:
            dir_cache[name] = _safe_project_dir(name, request)
        return dir_cache[name]

    seen: dict[str, Optional[dict[str, Any]]] = {}  # 같은 토큰이 여러 카드에 있어도 한 번만 계산
    for token in body.tokens[:_LOCATE_MAX_TOKENS]:
        if token in seen:
            if seen[token]:
                fixed.append({**seen[token], "token": token})  # type: ignore[dict-item]
            else:
                unresolved.append(token)
                if token in status_of:
                    status_of[token].append(token)
            continue
        seen[token] = None
        head, sep, rest = token.partition("|")
        old_project = head[len("asset:"):] if head.startswith("asset:") else ""
        if not sep or not old_project or not rest:
            unresolved.append(token)
            continue
        old_project, rest = asset_paths.real_meta_key(old_project, rest)
        internal = old_project in _INTERNAL_FOLDERS

        # 이미 이 PC 에서 열리는 참조는 손대지 않는다 — 멀쩡한 것을 옮기면 더 나빠진다.
        if not internal:
            current = project_dir_of(old_project)
            here = _safe_resolve(current, rest) if current else None
            if here and here.is_file():
                unresolved.append(token)
                continue

        # ① 내용 지문 — 이 PC 에 사본이 있을 때만 가능(가장 확실한 근거).
        digest = ""
        size = 0
        if internal:
            local = _safe_resolve((ASSETS_ROOT / old_project).resolve(), rest)
            if local and local.is_file():
                try:
                    size = local.stat().st_size
                except OSError:
                    size = 0
                if size > 0:
                    digest = _sha256_file(local)

        entry: Optional[dict[str, Any]] = None
        complete = True
        content_absent = False  # 전체 바퀴를 끝까지 훑었는데 같은 내용이 한 곳에도 없다
        nothing_found = False  # 전체 바퀴를 끝까지 훑었는데 경로·이름·확장자 후보가 하나도 없다
        if digest and size > 0:
            for i, scope in enumerate(rounds):
                hits: list[tuple[str, str]] = []
                complete = True
                for name, proj_dir in scope:
                    found, scanned_all = _locate_by_content(
                        proj_dir, size, digest, rest.rsplit("/", 1)[-1], snapshot=snapshot_of(proj_dir)
                    )
                    if not scanned_all:
                        complete = False
                    if found:
                        hits.append((name, found))
                    # 여기서 일찍 끊지 않는다 — 같은 파일을 두 이름으로 등록했을 수도 있어,
                    # 묶어 보기 전에는 '여럿'인지 알 수 없다.
                entry = pick(hits, complete)
                if entry:
                    break
                if i == len(rounds) - 1:  # 마지막 바퀴 = 등록 폴더 전체
                    content_absent = complete and not hits
            if entry is None:
                # 지문을 낼 수 있었는데 같은 내용이 없다(또는 여러 곳에 있다). 그런데도 이름만 같은
                # 파일로 이으면 **다른 그림**이 붙는다 — 근거가 약한 단계로 내려가지 않는다
                # (Codex 2026-09-28).
                unresolved.append(token)
                # 서버 어디에도 같은 내용이 없다 = 이 PC 안 사본에만 있다(여럿이면 서버에 있는 것이다)
                if can_judge and content_absent:
                    local_only.append(token)
                    status_of[token] = local_only
                continue
            entry |= {"sha256": digest, "bytes": size}

        # ② 경로 뒷부분 → ③ 파일 이름. 사본이 없는 참조(남이 준 씬)는 여기서만 살아난다.
        if entry is None:
            for i, scope in enumerate(rounds):
                by_path: list[tuple[str, str]] = []
                by_name: list[tuple[str, str]] = []
                by_ext: list[tuple[str, str]] = []
                complete = True
                for name, proj_dir in scope:
                    exact, named, other_ext, scanned_all = _locate_by_path(
                        proj_dir, rest, snapshot=snapshot_of(proj_dir)
                    )
                    if not scanned_all:
                        complete = False
                    by_path += [(name, r) for r in exact]
                    by_name += [(name, r) for r in named]
                    by_ext += [(name, r) for r in other_ext]
                    # 위와 같은 이유로 일찍 끊지 않는다.
                # 근거가 센 것부터 — 앞 단계에 후보가 하나라도 있으면 뒤 단계로 내려가지 않는다.
                # ④ 확장자만 다른 것(.png → .jpeg)은 가장 약하므로 맨 마지막이다.
                if by_path:
                    entry = pick(by_path, complete)
                elif by_name:
                    entry = pick(by_name, complete)
                else:
                    entry = pick(by_ext, complete)
                if entry:
                    break
                if i == len(rounds) - 1:  # 마지막 바퀴 = 등록 폴더 전체
                    nothing_found = complete and not (by_path or by_name or by_ext)

        if entry is None:
            unresolved.append(token)
            if can_judge and nothing_found:
                missing.append(token)
                status_of[token] = missing
            continue
        seen[token] = entry
        fixed.append({**entry, "token": token})
    log_event(
        _log,
        "assets_locate",
        tokens=len(body.tokens),
        fixed=len(fixed),
        workspace=bool(workspace_id),
        scan=scan_id[:8],
        projects=len(project_dirs),
        scanned_folders=len(snapshots),
        missing=len(missing),
        local=len(local_only),
        judge=can_judge,
        elapsed_ms=round((time.perf_counter() - started) * 1000, 1),
    )
    return {"fixed": fixed, "unresolved": unresolved, "missing": missing, "local": local_only}


@router.post("/reference-import", dependencies=[Depends(_require_local_assets)])
async def upload_reference_import(
    request: Request,
    project: str = Form(""),
    dir: str = Form(""),
    files: list[UploadFile] = File(...),
):
    """프롬프트/캔버스/트레이에 외부 파일을 직접 드롭할 때 쓰는 가져오기 — **이 PC 설치 폴더의
    imports** 한 곳에 모은다(같은 내용은 지문으로 재사용).

    ★2026-09-29 Jay "옛 방식으로 해야한다": 09-28 에 프로젝트 폴더(NAS)로 올리던 것을 되돌렸다.
    로컬 파일은 그 PC 에만 두고, 캔버스가 빨간 테두리·오른쪽 위 마크로 서버에 없음을 알린다.
    같은 내용이 서버에 있으면 자동 복구(/locate)가 원본으로 이어 준다 — 그래서 여기서는 NAS 를
    훑지 않는다(끌어다 놓을 때마다 NAS 전체를 훑던 2초대 지연도 함께 사라진다).
    project/dir 폼 값은 하위호환으로 받되 쓰지 않는다 — 목적지가 그때그때 달라지면 옛
    CH/import/import 오염이 재발한다."""
    out_project = _PROMPT_IMPORT_PROJECT  # 응답 토큰도 asset:imports|… 로 고정
    _validate_upload_batch(files)
    dest = (ASSETS_ROOT / out_project).resolve()
    dest.mkdir(parents=True, exist_ok=True)

    saved: list[dict[str, Any]] = []
    skipped: list[str] = []
    committed_new = False  # 새 파일을 하나라도 확정했으면 트리 캐시 무효화 대상
    commit_attempted = False
    try:
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
            # 중복 재검색부터 최종 확정까지 같은 동기 임계구역에서 수행하고, 취소돼도 스레드를 버리지 않는다.
            try:
                commit_attempted = True  # 취소 재전파 전 실제 파일 확정 가능 — finally 무효화 기준
                target, reused = await to_thread_non_abandon(
                    asset_io.find_or_commit_media,
                    tmp,
                    dest,
                    raw,
                    digest,
                    mt,
                    size,
                )
                if reused:
                    saved.append({
                        "project": out_project,
                        "path": target.name,
                        "name": target.name,
                        "type": mt,
                        "reused": True,
                        "sha256": digest,
                        "bytes": size,
                    })
                    continue
            except BaseException:
                # 스트리밍 이후 예외도 정리해 실패한 드롭이 숨은 디스크 찌꺼기를 만들지 않게 한다.
                tmp.unlink(missing_ok=True)
                raise
            committed_new = True
            saved.append({
                "project": out_project,
                "path": target.name,
                "name": target.name,
                "type": mt,
                "sha256": digest,
                "bytes": size,
            })
    finally:
        if committed_new or commit_attempted:
            asset_tree.invalidate_project_tree(dest)
            asset_tree.invalidate_combined_tree(ASSETS_ROOT, _INTERNAL_FOLDERS)  # Assets 의 imp/cap 합본
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
                target = _safe_project_resolve(project, proj_dir, rel)
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
        headers={"X-Content-Type-Options": "nosniff"},
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
    target = _safe_project_resolve(body.project, proj_dir, body.path)
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


class ResolveLibraryDialogIn(BaseModel):
    project: str = Field(min_length=1, max_length=200)
    dir: str = Field(min_length=1, max_length=1000)


class ResolveProjectOpenIn(ResolveLibraryDialogIn):
    name: str = Field(min_length=1, max_length=500)
    folder_path: str = Field(default="", max_length=1000)
    # 이 열기가 부른 켜기의 번호(/resolve-library/launch 응답) — 켜는 동안엔 이것이 맞는 열기만 Resolve 에 닿는다.
    launch_id: str = Field(default="", max_length=64)


# 열기가 이 이유로 실패하면 'Resolve 가 아직 준비되지 않음'이다 — 화면이 Resolve 를 켜고 다시 시도한다(503).
# resolve_busy(다른 가져오기·연결이 Resolve 를 쓰는 중)·launching(다른 화면이 켠 Resolve 가 켜지는 중)도
# 기다리면 풀린다(Codex P1).
_RESOLVE_NOT_READY_CODES = frozenset(
    {"not_running", "api_unavailable", "manager_unavailable", "resolve_busy", "launching"}
)


def _resolve_davinci_root(project: str, directory: str, request: Request) -> Path:
    normalized_dir = directory.replace("\\", "/").strip("/")
    if normalized_dir.casefold() != "@davinci":
        raise HTTPException(status_code=400, detail="프로젝트 루트의 @davinci 폴더만 사용할 수 있습니다")
    project_dir = _safe_project_dir(project, request)
    if not project_dir:
        raise HTTPException(status_code=404, detail=f"프로젝트 없음: {project}")
    target = _safe_project_resolve(project, project_dir, normalized_dir)
    if not target:
        raise HTTPException(status_code=400, detail="잘못된 @davinci 경로입니다")
    return target


@router.get("/resolve-library/projects", dependencies=[Depends(_require_local_assets)])
def list_resolve_library_projects(
    request: Request,
    project: str = Query(..., min_length=1, max_length=200),
    dir: str = Query("@davinci", min_length=1, max_length=1000),
):
    target = _resolve_davinci_root(project, dir, request)
    try:
        projects = resolve_project_library.list_disk_projects(target)
    except resolve_project_library.ResolveProjectLibraryError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {
        # Resolve 에 실제로 등록된 이름(해시 전 옛 이름일 수 있다) — 화면이 상태의 database_name 과 비교한다.
        "library_name": resolve_library_dialog.registered_library_name(target)
        or resolve_library_dialog.library_name_for_project(project, target),
        "library_path": str(target),
        "projects": projects,
    }


@router.get("/resolve-library/thumbnails", dependencies=[Depends(_require_local_assets)])
async def list_resolve_library_thumbnails(
    request: Request,
    project: str = Query(..., min_length=1, max_length=200),
    dir: str = Query("@davinci", min_length=1, max_length=1000),
):
    """프로젝트마다 Resolve 가 저장해 둔 대표 그림(JPEG base64)과 카드 정보(타임라인 수·해상도·fps).

    표시 전용 — 못 읽은 것은 빠진다. {"thumbnails": {...}, "details": {...}}(details 는 2026-09-22 추가).
    """
    target = _resolve_davinci_root(project, dir, request)
    try:
        return await asyncio.to_thread(resolve_project_library.project_cards, target)
    except resolve_project_library.ResolveProjectLibraryError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.post("/resolve-library/launch", dependencies=[Depends(_require_local_assets)])
async def launch_resolve_for_library(request: Request):
    """Resolve 가 꺼져 있으면 켜고 바로 돌아온다({status: running|starting, launch_id}). 준비는 화면이 launch-state 로 본다.

    선택 감시를 멈춘 채 켠다 — Resolve 가 막 꺼졌을 때 아직 살아 있던 감시 자식을 먼저 거둔다(Codex P1).
    켜기 창이 열린 뒤엔 감시의 _held() 가 재시작을 막는다.
    """
    require_loopback_browser_request(request, "Resolve 켜기는 로컬 MV Hub에서만 사용할 수 있습니다")
    try:
        async with resolve_selection_monitor.selection_monitor.suspended():
            return await asyncio.to_thread(resolve_project_library.launch_resolve)
    except resolve_project_library.ResolveProjectLibraryError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.get("/resolve-library/launch-state", dependencies=[Depends(_require_local_assets)])
async def resolve_launch_state():
    """Resolve 가 떴는지·창이 생겼는지(작업 목록만 본다 — Resolve API 는 부르지 않는다)."""
    title = await asyncio.to_thread(resolve_project_library.resolve_window_title)
    return {"running": title is not None, "window": bool(title)}


@router.post("/resolve-library/connect-dialog", dependencies=[Depends(_require_local_assets)])
async def open_resolve_library_connect_dialog(body: ResolveLibraryDialogIn, request: Request):
    """Assets의 루트 @davinci 폴더를 Resolve 프로젝트 라이브러리로 연결한다(Connect 까지).

    OS 프로그램을 앞으로 가져오는 부수효과가 있으므로 loopback 브라우저 문맥까지 확인한다.
    이미 등록된 폴더면 창을 열지 않는다(resolve_library_dialog.open_library_connect_dialog).
    """
    require_loopback_browser_request(
        request, "Resolve 라이브러리 연결은 로컬 MV Hub에서만 사용할 수 있습니다"
    )
    target = _resolve_davinci_root(body.project, body.dir, request)
    try:
        async with resolve_selection_monitor.selection_monitor.suspended():
            return await to_thread_non_abandon(
                resolve_library_dialog.open_library_connect_dialog,
                target,
                body.project,
            )
    except resolve_library_dialog.ResolveLibraryDialogError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.post("/resolve-library/open", dependencies=[Depends(_require_local_assets)])
async def open_resolve_library_project(body: ResolveProjectOpenIn, request: Request):
    require_loopback_browser_request(
        request, "Resolve 프로젝트 열기는 로컬 MV Hub에서만 사용할 수 있습니다"
    )
    target = _resolve_davinci_root(body.project, body.dir, request)
    try:
        async with resolve_selection_monitor.selection_monitor.suspended():
            result = await to_thread_non_abandon(
                resolve_project_library.open_disk_project,
                target,
                body.project,
                body.name,
                body.folder_path.replace("\\", "/").strip("/"),
                body.launch_id.strip(),
            )
    except resolve_project_library.ResolveProjectLibraryError as exc:
        not_ready = exc.code in _RESOLVE_NOT_READY_CODES
        # 코드가 있는 실패 = Resolve 쪽 작업이 답했다 → 켜기는 끝났다. 코드가 빈 실패는 디스크 쪽(목록·폴더)이라
        # Resolve 준비와 무관하다 — 창은 그대로 두고 만료나 다음 성공에 맡긴다.
        if exc.code and not not_ready:
            resolve_status_runner.end_launch_window()
        raise HTTPException(status_code=503 if not_ready else 400, detail=str(exc)) from exc
    # 열렸다(complete) = Resolve API 가 준비됐다 → 켜기 창을 닫는다.
    resolve_status_runner.end_launch_window()
    return result


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
        target = _safe_project_resolve(body.project, proj_dir, rel)
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

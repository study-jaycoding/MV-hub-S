"""Assets(구성) 라우터 — project-viewer 의 '구성 탭'(폴더 트리 브라우저) 포팅.

ASSETS_ROOT(= PV PROJECTS_DIR) 아래의 프로젝트 폴더를 트리로 보여주고 파일을 서빙한다.
프로젝트 = 루트 아래 한 폴더. 기본 테스트 폴더는 config.DEFAULT_PROJECT.

경로 보안: 모든 접근은 ASSETS_ROOT/<project> 안으로 제한(traversal 차단) — PV 의
safe_project_dir / safe_resolve 가드를 그대로 따른다.
"""

from __future__ import annotations

import hashlib
import json
import os
import subprocess
import sys
import tempfile
import zipfile
from pathlib import Path
from typing import Any, Optional

from fastapi import APIRouter, Depends, File, Form, HTTPException, Query, Request, UploadFile
from fastapi.responses import FileResponse
from PIL import Image
from pydantic import BaseModel
from starlette.background import BackgroundTask

from . import _proxy
from .. import repo
from ..config import (
    ASSETS_ROOT,
    AUTH_ENABLED,
    DATA_DIR,
    DEFAULT_PROJECT,
    MEDIA_DIR,
)
from ..deps import actor_id


def _proxying() -> bool:
    """이 프로세스가 '로컬 허브'(데이터를 공유 서버에 위임)인가?

    서버 직결 하이브리드(plan): 파일 I/O·CLI 는 로컬에서, 순수 데이터(메타/코멘트)는 서버로 위임.
    공유 서버 토큰이 있으면(=로그인한 로컬 허브) 위임 모드. 서버 본체(AUTH on)는 토큰이 없으니
    자기 repo 로 처리한다. 같은 코드가 양쪽에서 돌아도 모드로 갈린다."""
    return not AUTH_ENABLED and bool(_proxy.token())


def _require_mount_manager(request: Request) -> None:
    """외부 폴더 등록/해제 권한. 폴더 등록은 **계정별 개인 목록**이라(각자 자기 것만 보고·지움)
    로그인한 사용자는 누구나 자기 폴더를 직접 관리한다.
      · AUTH 켜짐: 로그인한 계정이면 통과(자기 소유 마운트만 다룬다 — 남의 것엔 영향 없음).
      · AUTH 꺼짐(신원 없음): 서버 로컬(127.0.0.1/::1)에서만 — LAN의 임의 등록 차단.
    ⚠️ 임의 절대경로를 마운트로 받으므로, 그 계정은 자기 마운트 범위의 서버 파일만 열람 가능."""
    if AUTH_ENABLED:
        if getattr(request.state, "account", None) is None:
            raise HTTPException(status_code=401, detail="로그인이 필요합니다")
        return
    host = request.client.host if request.client else ""
    if host not in ("127.0.0.1", "::1"):
        raise HTTPException(status_code=403, detail="폴더 등록은 서버 로컬에서만 가능합니다")

_THUMB_DIR = MEDIA_DIR / ".thumbs"  # 썸네일 디스크 캐시


def _mounts_file() -> Path:
    """등록된 외부 폴더(마운트) 영속 파일 — **활성 계정 DB 폴더 안**(계정별 격리).
    로그인하면 data/db/acct/<uid>/asset_mounts.json, 미로그인/단독이면 레거시 위치
    data/asset_mounts.json(기존 그대로). 계정마다 자기 폴더 목록만 갖게 한다."""
    from ..active_account import account_dir, active_uid

    uid = active_uid()
    return (account_dir(uid) / "asset_mounts.json") if uid else (DATA_DIR / "asset_mounts.json")

router = APIRouter(prefix="/api/assets", tags=["assets"])

_IMAGE_EXT = (".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp")
_VIDEO_EXT = (".mp4", ".mov", ".webm", ".mkv", ".avi")
_AUDIO_EXT = (".mp3", ".wav", ".ogg", ".flac", ".m4a", ".aac")


def _media_type(name: str) -> Optional[str]:
    low = name.lower()
    if low.endswith(_IMAGE_EXT):
        return "image"
    if low.endswith(_VIDEO_EXT):
        return "video"
    if low.endswith(_AUDIO_EXT):
        return "audio"
    return None


def _load_mounts() -> list[dict[str, str]]:
    """등록된 외부 폴더 [{name, path, owner}]. owner=등록한 계정(creator_uid) — 계정별 개인 목록.
    레거시(소유자 없는) 항목은 첫 로드 때 제공자(get_my_uid) 소유로 이관·재저장(멱등)."""
    try:
        data = json.loads(_mounts_file().read_text("utf-8"))
    except (FileNotFoundError, ValueError, OSError):
        return []
    out: list[dict[str, str]] = []
    migrated = False
    prov: Optional[str] = None
    for m in data.get("mounts", []) if isinstance(data, dict) else []:
        name = str(m.get("name", "")).strip()
        path = str(m.get("path", "")).strip()
        if not (name and path):
            continue
        owner = str(m.get("owner", "")).strip()
        if not owner:
            if prov is None:
                prov = repo.get_my_uid() or ""
            owner = prov
            migrated = True
        out.append({"name": name, "path": path, "owner": owner})
    if migrated:
        _save_mounts(out)  # 레거시 → 제공자 소유로 1회 이관
    return out


def _save_mounts(mounts: list[dict[str, str]]) -> None:
    f = _mounts_file()
    f.parent.mkdir(parents=True, exist_ok=True)
    f.write_text(json.dumps({"mounts": mounts}, ensure_ascii=False, indent=2), "utf-8")


def _owner_mounts(owner: str) -> list[dict[str, str]]:
    """그 계정(owner)이 등록한 마운트만 — 각자 자기 것만 본다."""
    return [m for m in _load_mounts() if m.get("owner", "") == owner]


def _mount_dir(name: str, owner: str) -> Optional[Path]:
    """등록 이름 → 실제 폴더(그 계정 소유 안에서만 해석 — 남의 마운트엔 접근 못 함)."""
    for m in _owner_mounts(owner):
        if m["name"] == name:
            p = Path(m["path"]).resolve()
            return p if p.is_dir() else None
    return None


def _safe_project_dir(project: str, owner: str) -> Optional[Path]:
    # 내(owner)가 등록한 외부 폴더(마운트)가 있으면 그 경로 우선 — 임의 위치 허용.
    md = _mount_dir(project, owner)
    if md:
        return md
    cand = (ASSETS_ROOT / project).resolve()
    try:
        cand.relative_to(ASSETS_ROOT)
    except ValueError:
        return None
    return cand if cand.is_dir() else None


def _safe_resolve(project_dir: Path, rel: str) -> Optional[Path]:
    cand = (project_dir / rel).resolve()
    try:
        cand.relative_to(project_dir)
    except ValueError:
        return None
    return cand


def _hidden(name: str) -> bool:
    # 시스템/ledger 파일·placeholder 숨김 (PV 와 동일한 취지)
    return name.startswith((".", "_")) or name.lower() == "readme.md"


def _build_tree(directory: Path, rel_prefix: str) -> list[dict[str, Any]]:
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
        rel = f"{rel_prefix}{entry.name}"
        if entry.is_dir():
            out.append(
                {
                    "name": entry.name,
                    "type": "dir",
                    "path": rel,
                    "children": _build_tree(entry, rel + "/"),
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
    # 기본 프로젝트가 목록에 있으면 그것, 아니면 첫 항목
    default = DEFAULT_PROJECT if DEFAULT_PROJECT in projects else (projects[0] if projects else "")
    return ProjectsOut(projects=projects, default=default, root=str(ASSETS_ROOT))


# ── 외부 폴더 등록(마운트) 관리 ──────────────────────────────────────────────
class MountIn(BaseModel):
    name: str
    path: str


@router.get("/mounts")
def list_mounts(request: Request):
    """**내가 등록한** 외부 폴더 목록(+실제 존재 여부) — 계정별 개인 목록."""
    return {
        "mounts": [
            {"name": m["name"], "path": m["path"], "exists": Path(m["path"]).is_dir()}
            for m in _owner_mounts(actor_id(request))
        ]
    }


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
    return {
        "mounts": [
            {"name": m["name"], "path": m["path"], "exists": Path(m["path"]).is_dir()}
            for m in mounts
            if m.get("owner", "") == owner
        ]
    }


@router.delete("/mounts/{name}", dependencies=[Depends(_require_mount_manager)])
def del_mount(name: str, request: Request):
    """등록된 외부 폴더 해제 — **내 것만** 지운다(남의 등록엔 영향 없음). 원본 폴더는 안 건드림."""
    owner = actor_id(request)
    mounts = [m for m in _load_mounts() if not (m["name"] == name and m.get("owner", "") == owner)]
    _save_mounts(mounts)
    return {
        "mounts": [
            {"name": m["name"], "path": m["path"], "exists": Path(m["path"]).is_dir()}
            for m in mounts
            if m.get("owner", "") == owner
        ]
    }


@router.get("/tree")
def project_tree(request: Request, project: str = Query(...)):
    """프로젝트 폴더 트리(폴더 + 미디어 파일) — 내가 등록한 마운트 안에서만 해석."""
    proj_dir = _safe_project_dir(project, actor_id(request))
    if not proj_dir:
        raise HTTPException(status_code=404, detail=f"프로젝트 없음: {project}")
    return {
        "project": project,
        "name": proj_dir.name,
        "children": _build_tree(proj_dir, ""),
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


def _require_project(project: str, owner: str) -> None:
    if not _safe_project_dir(project, owner):
        raise HTTPException(status_code=404, detail=f"프로젝트 없음: {project}")


@router.get("/meta")
def asset_meta(request: Request, project: str = Query(...)):
    """파일별 메타(+ comment_count·has_unread). 미확인은 코멘트별 muted 플래그를 따른다.
    읽음 기준 신원은 로그인 계정(actor_id) — 작성·읽음추적이 같은 신원이라 일관.

    서버 직결: 메타는 순수 데이터라 서버 DB 가 단일 정답 → 위임. (디스크 검증 없음 — 서버엔
    이 마운트가 없고, 메타는 (project,path) 키로만 식별)."""
    if _proxying():
        return _proxy.proxy_json("GET", "/api/assets/meta", params={"project": project})
    return repo.get_asset_meta(project, actor_id(request))


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
    if _proxying():
        return _proxy.proxy_json(
            "GET", "/api/assets/comments", params={"project": project, "path": path}
        )
    return repo.list_asset_comments(project, path)


@router.post("/comments")
def add_comment(body: CommentAddIn, request: Request):
    if _proxying():
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
    if _proxying():
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
    if _proxying():
        return _proxy.proxy_json("DELETE", f"/api/assets/comments/{comment_id}")
    try:
        repo.delete_asset_comment(comment_id, actor_id(request))
    except PermissionError as e:
        raise HTTPException(status_code=403, detail=str(e))
    return {"ok": True}


@router.post("/comments/read")
def read_comments(body: CommentReadIn, request: Request):
    if _proxying():
        return _proxy.proxy_json("POST", "/api/assets/comments/read", body=body.model_dump())
    repo.mark_asset_comments_read(actor_id(request), body.project, body.path)
    return {"ok": True}


# 메타 쓰기(소스/태그/코멘트/컬러) — 모두 순수 데이터라 서버 DB 가 단일 정답 → 위임.
# 디스크 검증(_require_project) 없음: 서버엔 워커의 마운트가 없고, 메타는 (project,path,owner) 키로만 식별.
@router.put("/source")
def asset_set_source(body: AssetSourceIn, request: Request):
    if _proxying():
        return _proxy.proxy_json("PUT", "/api/assets/source", body=body.model_dump())
    # 에셋 메타는 계정별 개인화 — 내(actor_id) 설정만 만들고 바꾼다(남의 것과 안 섞임).
    repo.set_asset_source(body.project, body.path, body.name, body.is_source, actor_id(request))
    return {"ok": True}


@router.put("/tags")
def asset_set_tags(body: AssetTagsIn, request: Request):
    if _proxying():
        return _proxy.proxy_json("PUT", "/api/assets/tags", body=body.model_dump())
    repo.set_asset_tags(body.project, body.path, body.tags, actor_id(request))
    return {"ok": True}


@router.put("/comment")
def asset_set_comment(body: AssetCommentIn, request: Request):
    if _proxying():
        return _proxy.proxy_json("PUT", "/api/assets/comment", body=body.model_dump())
    repo.set_asset_comment(body.project, body.path, body.comment, actor_id(request))
    return {"ok": True}


@router.put("/color")
def asset_set_color(body: AssetColorIn, request: Request):
    if _proxying():
        return _proxy.proxy_json("PUT", "/api/assets/color", body=body.model_dump())
    repo.set_asset_color(body.project, body.path, body.color, actor_id(request))
    return {"ok": True}


@router.get("/file")
def get_file(request: Request, project: str = Query(...), path: str = Query(...)):
    """프로젝트 내 파일 서빙(경로 보안) — 내가 등록한 마운트 안에서만(img 요청은 쿠키로 인증)."""
    proj_dir = _safe_project_dir(project, actor_id(request))
    if not proj_dir:
        raise HTTPException(status_code=404, detail=f"프로젝트 없음: {project}")
    target = _safe_resolve(proj_dir, path)
    if not target or not target.is_file():
        raise HTTPException(status_code=404, detail="파일 없음")
    return FileResponse(target)


@router.get("/thumb")
def get_thumb(
    request: Request,
    project: str = Query(...),
    path: str = Query(...),
    w: int = Query(512, ge=64, le=1024),
):
    """이미지 썸네일(리사이즈+디스크 캐시) — 그리드/리스트 스크롤 성능용.
    원본 풀해상도(수 MP) 대신 작은 이미지를 디코딩하게 해 렉을 없앤다."""
    proj_dir = _safe_project_dir(project, actor_id(request))
    if not proj_dir:
        raise HTTPException(status_code=404, detail=f"프로젝트 없음: {project}")
    target = _safe_resolve(proj_dir, path)
    if not target or not target.is_file():
        raise HTTPException(status_code=404, detail="파일 없음")
    if _media_type(target.name) != "image":
        raise HTTPException(status_code=415, detail="썸네일은 이미지만 지원")

    mtime = int(target.stat().st_mtime)
    key = hashlib.sha1(f"{target}|{mtime}|{w}".encode("utf-8")).hexdigest()
    _THUMB_DIR.mkdir(parents=True, exist_ok=True)
    cache = _THUMB_DIR / f"{key}.jpg"
    if not cache.exists():
        try:
            with Image.open(target) as im:
                im = im.convert("RGB")  # JPEG: 알파 제거(어두운 카드 배경이라 무방)
                im.thumbnail((w, w), Image.LANCZOS)
                im.save(cache, "JPEG", quality=82)
        except Exception as e:  # noqa: BLE001
            raise HTTPException(status_code=500, detail=f"썸네일 생성 실패: {e}")
    return FileResponse(cache, media_type="image/jpeg")


@router.post("/upload")
async def upload_assets(
    request: Request,
    project: str = Form(...),
    dir: str = Form(""),
    files: list[UploadFile] = File(...),
):
    """외부 파일을 현재 폴더(dir, 비면 프로젝트 루트)로 가져오기(드롭 업로드).
    파일명은 basename 만 사용(경로 traversal 차단), 미디어가 아닌 파일은 제외,
    이름 충돌은 _2, _3… 으로 회피(덮어쓰기 안 함)."""
    proj_dir = _safe_project_dir(project, actor_id(request))
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
        target = _safe_resolve(dest, raw)
        if not target:
            skipped.append(raw)
            continue
        if target.exists():  # 덮어쓰기 방지
            stem, ext, i = target.stem, target.suffix, 2
            while True:
                cand = dest / f"{stem}_{i}{ext}"
                if not cand.exists():
                    target = cand
                    break
                i += 1
        try:
            target.write_bytes(await up.read())
        except Exception as e:  # noqa: BLE001
            raise HTTPException(status_code=500, detail=f"저장 실패({raw}): {e}")
        saved.append(target.relative_to(proj_dir).as_posix())

    return {"saved": saved, "skipped": skipped}


@router.get("/zip")
def export_zip(
    request: Request, project: str = Query(...), paths: list[str] = Query(default=[])
):
    """선택한 여러 파일을 zip 으로 묶어 스트리밍(OS 드래그 다중 내보내기용).
    네이티브 DownloadURL 드래그는 1건만 지원하므로, 다중선택은 이 zip 한 건으로 내보낸다.
    zip 내부는 파일명만으로 평탄화하고 동일 이름은 _2, _3… 으로 회피한다."""
    proj_dir = _safe_project_dir(project, actor_id(request))
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


@router.post("/reveal")
def reveal_file(body: RevealIn, request: Request):
    """OS 파일 탐색기에서 원본 위치를 열고 해당 파일을 선택(로컬 전용)."""
    proj_dir = _safe_project_dir(body.project, actor_id(request))
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

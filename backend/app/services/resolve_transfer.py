"""DaVinci Resolve 편집 원본 전송 기반.

선택한 생성물 원본을 프로젝트의 ``ResolveSource/<folder_path>`` 아래에 안전하게
모으고, Resolve 연결 계층이 읽을 수 있는 manifest JSON을 남긴다.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import os
import re
import shutil
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from ..config import MEDIA_DIR
from . import media_cache, project_folders
from .atomic_io import atomic_write_text
from .path_safety import safe_join


MANIFEST_FORMAT = "mvhub.resolve-transfer"
MANIFEST_VERSION = 1
SOURCE_DIR_NAME = "ResolveSource"
_MIN_FREE_BYTES = max(
    0, int(os.environ.get("CONTENT_HUB_RESOLVE_MIN_FREE_BYTES", str(256 * 1024 * 1024)))
)
_TRANSFER_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,80}$")


class ResolveTransferError(RuntimeError):
    """전송 전체를 시작할 수 없는 설정/경로 오류."""


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _new_transfer_id() -> str:
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    return f"{stamp}-{uuid.uuid4().hex[:8]}"


def resolve_source_root(project_id: str) -> Path:
    """프로젝트 Render 폴더의 형제 ``ResolveSource``를 반환한다.

    기존 Render 완료본과 편집 원본이 섞이지 않게 물리 루트를 분리한다. 이미
    존재하는 ResolveSource가 심링크/정션으로 프로젝트 밖을 가리키면 safe_join이
    거부한다.
    """
    state = project_folders.render_root_state(project_id)
    if state.get("error"):
        raise ResolveTransferError(str(state["error"]))
    render_raw = (state.get("render_path") or "").strip()
    if not render_raw:
        raise ResolveTransferError("렌더 폴더가 연결되지 않았습니다")

    render = Path(render_raw).resolve()
    project_root = render.parent
    source_root = safe_join(project_root, SOURCE_DIR_NAME)
    if source_root is None:
        raise ResolveTransferError("ResolveSource 경로가 프로젝트 밖을 가리킵니다")
    if source_root.exists() and not source_root.is_dir():
        raise ResolveTransferError(f"ResolveSource 위치가 폴더가 아닙니다: {source_root}")
    try:
        source_root.mkdir(parents=True, exist_ok=True)
    except OSError as exc:
        raise ResolveTransferError(f"ResolveSource 폴더를 만들 수 없습니다: {exc}") from exc

    # mkdir 직후 다시 해석해 생성 중 경로가 바뀌었거나 정션인 경우도 차단한다.
    checked = safe_join(project_root, SOURCE_DIR_NAME)
    if checked is None or checked != source_root:
        raise ResolveTransferError("ResolveSource 경로 안전성을 확인할 수 없습니다")
    return source_root


def _manifest_path(source_root: Path, transfer_id: str) -> Path:
    if not _TRANSFER_ID_RE.fullmatch(transfer_id):
        raise ResolveTransferError("전송 ID 형식이 안전하지 않습니다")
    path = safe_join(source_root, Path(".mvhub") / "transfers" / f"{transfer_id}.json")
    if path is None:
        raise ResolveTransferError("전송 목록 저장 경로가 안전하지 않습니다")
    return path


def _write_manifest(path: Path, manifest: dict[str, Any]) -> None:
    atomic_write_text(
        path,
        json.dumps(manifest, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
    )


async def save_manifest(manifest: dict[str, Any]) -> None:
    """후속 Resolve 가져오기 결과까지 같은 manifest에 원자적으로 저장한다."""
    path = Path(str(manifest.get("manifest_path") or ""))
    source_root = Path(str(manifest.get("source_root") or ""))
    try:
        relative = path.relative_to(source_root)
    except ValueError as exc:
        raise ResolveTransferError("전송 목록 저장 경로가 안전하지 않습니다") from exc
    if not path.name or safe_join(source_root, relative) != path:
        raise ResolveTransferError("전송 목록 저장 경로가 안전하지 않습니다")
    await asyncio.to_thread(_write_manifest, path, manifest)


def _transfer_filename(
    folder_path: str, gen_id: str, source_hint: str, media_type: str
) -> str:
    """전체 generation ID의 해시를 써 공통 접두사 ID끼리도 파일명이 충돌하지 않게 한다."""
    conventional = project_folders.export_filename(
        folder_path, gen_id, source_hint, media_type
    )
    suffix = Path(conventional).suffix
    seq = conventional[: -len(suffix)] if suffix else conventional
    # 기존 <시퀀스>_<gen 앞12자> 형식에서 시퀀스 표시는 유지하되, 식별 부분은
    # 전체 ID 기반으로 만든다. gen ID가 같은 항목만 같은 목적지를 갖는다.
    seq = seq.rsplit("_", 1)[0]
    digest = hashlib.sha256(gen_id.encode("utf-8")).hexdigest()[:12]
    return f"{seq}_{digest}{suffix}"


def _refresh_summary(manifest: dict[str, Any], *, finished: bool = False) -> None:
    items = manifest["items"]
    manifest["downloaded"] = sum(item["status"] == "downloaded" for item in items)
    manifest["skipped"] = sum(item["status"] == "skipped" for item in items)
    manifest["error_count"] = sum(item["status"] == "error" for item in items)
    if not finished:
        manifest["status"] = "pending"
        return
    ok_count = manifest["downloaded"] + manifest["skipped"]
    if manifest["error_count"] == 0:
        manifest["status"] = "complete"
    elif ok_count:
        manifest["status"] = "partial"
    else:
        manifest["status"] = "failed"
    manifest["completed_at"] = _utc_now()


async def _cached_source(asset: dict[str, Any]) -> Path:
    """asset의 로컬 캐시를 확보한다. 임의 절대경로는 허용하지 않는다."""
    file_path = str(asset.get("file_path") or "")
    source_url = str(asset.get("source_url") or "")

    if file_path.startswith("/media/"):
        local = safe_join(MEDIA_DIR, file_path.removeprefix("/media/"))
        if local is not None and local.is_file() and local.stat().st_size > 0:
            return local

    # 로컬 /media가 유실됐으면 보존해 둔 원격 source_url로 자기치유한다.
    candidates = [file_path, source_url]
    seen: set[str] = set()
    for candidate in candidates:
        if candidate in seen or not candidate.startswith(("http://", "https://")):
            continue
        seen.add(candidate)
        rel = await media_cache.cache_url(candidate)
        if not rel or not rel.startswith("/media/"):
            continue
        local = safe_join(MEDIA_DIR, rel.removeprefix("/media/"))
        if local is not None and local.is_file() and local.stat().st_size > 0:
            return local
    raise ResolveTransferError("원본을 내려받을 수 없습니다")


def _copy_atomic(source: Path, dest: Path) -> str:
    """원본을 덮어쓰지 않고 원자적으로 복사한다. 반환값은 downloaded/skipped."""
    source_size = source.stat().st_size
    if source_size <= 0:
        raise ResolveTransferError("원본 파일이 비어 있습니다")
    if dest.exists():
        if dest.is_file() and _same_file_content(source, dest):
            return "skipped"
        raise ResolveTransferError("같은 이름의 다른 파일이 이미 있습니다")

    dest.parent.mkdir(parents=True, exist_ok=True)
    try:
        free = shutil.disk_usage(dest.parent).free
        if free < source_size + _MIN_FREE_BYTES:
            raise ResolveTransferError("대상 디스크 공간이 부족합니다")
    except OSError:
        # 일부 UNC는 여유 공간 조회를 지원하지 않는다. 실제 쓰기 오류로 최종 판정한다.
        pass

    tmp = dest.with_name(dest.name + f".{uuid.uuid4().hex}.part")
    try:
        shutil.copy2(source, tmp)
        if tmp.stat().st_size != source_size:
            raise ResolveTransferError("원본 복사가 불완전합니다(크기 불일치)")
        os.replace(tmp, dest)
    finally:
        try:
            tmp.unlink(missing_ok=True)
        except OSError:
            pass
    return "downloaded"


def _same_file_content(left: Path, right: Path) -> bool:
    """크기만 같은 다른 영상을 멱등 재실행으로 오인하지 않게 바이트를 대조한다."""
    try:
        if left.stat().st_size != right.stat().st_size:
            return False
        with left.open("rb") as left_file, right.open("rb") as right_file:
            while True:
                left_chunk = left_file.read(1024 * 1024)
                right_chunk = right_file.read(1024 * 1024)
                if left_chunk != right_chunk:
                    return False
                if not left_chunk:
                    return True
    except OSError:
        return False


async def transfer_generations(
    project_id: str,
    generations: list[dict[str, Any]],
    *,
    transfer_id: str | None = None,
) -> dict[str, Any]:
    """생성물 원본을 폴더 구조대로 복사하고 Resolve용 manifest를 반환한다.

    항목은 순차 처리한다. 대용량 원본 여러 개가 동시에 네트워크와 NAS를 점유하지
    않게 하고, 한 항목의 실패가 나머지를 막지 않게 오류를 항목별로 격리한다.
    """
    if not project_id:
        raise ResolveTransferError("프로젝트가 지정되지 않았습니다")
    if not generations:
        raise ResolveTransferError("전송할 생성물이 없습니다")
    if any((gen.get("project_id") or "") != project_id for gen in generations):
        raise ResolveTransferError("한 번에 하나의 프로젝트만 전송할 수 있습니다")

    source_root = await asyncio.to_thread(resolve_source_root, project_id)
    transfer_id = transfer_id or _new_transfer_id()
    manifest_path = _manifest_path(source_root, transfer_id)
    manifest: dict[str, Any] = {
        "format": MANIFEST_FORMAT,
        "version": MANIFEST_VERSION,
        "transfer_id": transfer_id,
        "project_id": project_id,
        "project_name": generations[0].get("project_name") or "",
        "source_root": str(source_root),
        "manifest_path": str(manifest_path),
        "created_at": _utc_now(),
        "completed_at": None,
        "status": "pending",
        "total": len(generations),
        "downloaded": 0,
        "skipped": 0,
        "error_count": 0,
        "items": [],
    }

    work: list[tuple[dict[str, Any], dict[str, Any], Path]] = []
    for gen in generations:
        gen_id = str(gen.get("id") or "")
        folder_path = str(gen.get("folder_path") or "")
        assets = gen.get("assets") or []
        asset = assets[0] if assets and isinstance(assets[0], dict) else None
        media_type = str((asset or {}).get("type") or "")
        source_hint = str((asset or {}).get("source_url") or (asset or {}).get("file_path") or "")
        filename = (
            _transfer_filename(folder_path, gen_id, source_hint, media_type)
            if gen_id and folder_path and asset
            else ""
        )
        item: dict[str, Any] = {
            "generation_id": gen_id,
            "folder_path": folder_path,
            "filename": filename,
            "media_type": media_type,
            "local_path": "",
            "status": "pending",
            "error": None,
        }
        manifest["items"].append(item)

        reason = None
        if gen.get("status") != "done":
            reason = "완료된 생성물만 전송할 수 있습니다"
        elif not gen_id:
            reason = "생성물 ID가 없습니다"
        elif not folder_path:
            reason = "폴더 경로가 없습니다"
        elif asset is None:
            reason = "원본 파일이 없습니다"
        elif media_type not in {"video", "audio", "image"}:
            reason = f"Resolve 전송을 지원하지 않는 형식입니다: {media_type or 'unknown'}"
        else:
            dest = project_folders.safe_dest(source_root, folder_path, filename)
            if dest is None:
                reason = "경로 안전성 위반"
            else:
                item["local_path"] = str(dest)
                work.append((item, asset, dest))
        if reason:
            item["status"] = "error"
            item["error"] = reason

    _refresh_summary(manifest)
    await asyncio.to_thread(_write_manifest, manifest_path, manifest)

    for item, asset, dest in work:
        try:
            source = await _cached_source(asset)
            # 다운로드 사이에 정션/경로가 바뀌지 않았는지 복사 직전 재검증한다.
            checked = project_folders.safe_dest(
                source_root, item["folder_path"], item["filename"]
            )
            if checked is None or checked != dest:
                raise ResolveTransferError("복사 직전 경로 안전성 확인에 실패했습니다")
            item["status"] = await asyncio.to_thread(_copy_atomic, source, dest)
        except Exception as exc:  # noqa: BLE001 - 파일 1건 실패를 격리해 나머지는 계속 처리
            item["status"] = "error"
            item["error"] = str(exc)
        _refresh_summary(manifest)
        await asyncio.to_thread(_write_manifest, manifest_path, manifest)

    _refresh_summary(manifest, finished=True)
    await asyncio.to_thread(_write_manifest, manifest_path, manifest)
    return manifest

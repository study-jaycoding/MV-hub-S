"""DaVinci Resolve Media Pool 연결 계층.

파일 준비(`resolve_transfer`)와 Resolve 프로그램 조작을 분리한다. 이 모듈은
전송 manifest에 기록된 로컬 파일만 현재 열린 Resolve 프로젝트로 가져온다.
"""

from __future__ import annotations

import importlib
import os
import re
import sys
import threading
from pathlib import Path
from typing import Any


MEDIA_POOL_ROOT = "MV Hub"
_DEFAULT_SCRIPT_MODULES = Path(
    os.environ.get(
        "CONTENT_HUB_RESOLVE_SCRIPT_API",
        r"C:\ProgramData\Blackmagic Design\DaVinci Resolve\Support\Developer\Scripting\Modules",
    )
)
_IMPORT_LOCK = threading.Lock()
_UNSAFE_FOLDER_CHARS = re.compile(r"[\\/\x00-\x1f]")


class ResolveBridgeError(RuntimeError):
    """Resolve 연결이나 Media Pool 조작을 완료할 수 없는 오류."""


def _connect_resolve() -> Any:
    """설치된 공식 Resolve 스크립팅 모듈로 실행 중인 앱에 연결한다."""
    module_path = str(_DEFAULT_SCRIPT_MODULES)
    if module_path not in sys.path:
        sys.path.insert(0, module_path)
    try:
        module = importlib.import_module("DaVinciResolveScript")
    except (ImportError, OSError) as exc:
        raise ResolveBridgeError(
            "DaVinci Resolve 스크립팅 모듈을 불러올 수 없습니다"
        ) from exc
    try:
        resolve = module.scriptapp("Resolve")
    except Exception as exc:  # noqa: BLE001 - 외부 프로그램 연결 오류를 사용자 메시지로 변환한다.
        raise ResolveBridgeError("DaVinci Resolve에 연결할 수 없습니다") from exc
    if not resolve:
        raise ResolveBridgeError("DaVinci Resolve가 실행 중이지 않습니다")
    return resolve


def _folder_name(value: str, fallback: str) -> str:
    cleaned = _UNSAFE_FOLDER_CHARS.sub("_", value.strip()).strip(" .")
    return cleaned or fallback


def _subfolder(parent: Any, name: str, media_pool: Any) -> Any:
    for folder in parent.GetSubFolderList() or []:
        if folder.GetName() == name:
            return folder
    created = media_pool.AddSubFolder(parent, name)
    if not created:
        raise ResolveBridgeError(f"Resolve Media Pool 폴더를 만들 수 없습니다: {name}")
    return created


def _destination_folder(media_pool: Any, root: Any, parts: list[str]) -> Any:
    folder = root
    for raw_part in parts:
        part = _folder_name(raw_part, "미분류")
        folder = _subfolder(folder, part, media_pool)
    return folder


def _normal_path(value: str) -> str:
    if not value:
        return ""
    try:
        return os.path.normcase(os.path.normpath(str(Path(value).resolve(strict=False))))
    except OSError:
        return os.path.normcase(os.path.normpath(value))


def _clip_file_path(clip: Any) -> str:
    try:
        props = clip.GetClipProperty()
    except TypeError:
        props = None
    if isinstance(props, dict):
        return str(props.get("File Path") or "")
    try:
        return str(clip.GetClipProperty("File Path") or "")
    except (AttributeError, TypeError):
        return ""


def _existing_paths(folder: Any) -> set[str]:
    return {
        normalized
        for clip in (folder.GetClipList() or [])
        if (normalized := _normal_path(_clip_file_path(clip)))
    }


def _import_manifest_locked(manifest: dict[str, Any], resolve: Any) -> dict[str, Any]:
    project_manager = resolve.GetProjectManager()
    project = project_manager.GetCurrentProject() if project_manager else None
    if not project:
        raise ResolveBridgeError("현재 열려 있는 Resolve 프로젝트가 없습니다")
    media_pool = project.GetMediaPool()
    root = media_pool.GetRootFolder() if media_pool else None
    if not media_pool or not root:
        raise ResolveBridgeError("현재 Resolve 프로젝트의 Media Pool을 열 수 없습니다")

    previous_folder = media_pool.GetCurrentFolder()
    project_label = _folder_name(
        str(manifest.get("project_name") or ""),
        str(manifest.get("project_id") or "프로젝트"),
    )
    result: dict[str, Any] = {
        "status": "pending",
        "project_name": str(project.GetName() or ""),
        "target_root": f"{MEDIA_POOL_ROOT}/{project_label}",
        "total": 0,
        "imported": 0,
        "skipped": 0,
        "error_count": 0,
        "error": None,
        "items": [],
    }

    try:
        managed_root = _destination_folder(media_pool, root, [MEDIA_POOL_ROOT, project_label])
        for source_item in manifest.get("items") or []:
            if source_item.get("status") not in {"downloaded", "skipped"}:
                continue
            item = {
                "generation_id": str(source_item.get("generation_id") or ""),
                "local_path": str(source_item.get("local_path") or ""),
                "media_pool_path": "",
                "status": "pending",
                "error": None,
            }
            result["items"].append(item)
            result["total"] += 1
            try:
                source = Path(item["local_path"])
                if not source.is_file() or source.stat().st_size <= 0:
                    raise ResolveBridgeError("Resolve로 가져올 원본 파일이 없습니다")
                parts = [
                    part
                    for part in str(source_item.get("folder_path") or "")
                    .replace("\\", "/")
                    .split("/")
                    if part and part not in {".", ".."}
                ]
                target = _destination_folder(media_pool, managed_root, parts)
                item["media_pool_path"] = "/".join(
                    [MEDIA_POOL_ROOT, project_label, *parts]
                )
                normalized = _normal_path(str(source))
                if normalized in _existing_paths(target):
                    item["status"] = "skipped"
                    result["skipped"] += 1
                    continue
                if not media_pool.SetCurrentFolder(target):
                    raise ResolveBridgeError("Resolve Media Pool 대상 폴더를 선택할 수 없습니다")
                imported = media_pool.ImportMedia([str(source)])
                if not imported:
                    raise ResolveBridgeError("Resolve가 원본 파일을 가져오지 못했습니다")
                item["status"] = "imported"
                result["imported"] += 1
            except Exception as exc:  # noqa: BLE001 - 항목별 실패를 격리한다.
                item["status"] = "error"
                item["error"] = str(exc)
                result["error_count"] += 1

        success_count = result["imported"] + result["skipped"]
        if not result["total"]:
            result["status"] = "failed"
            result["error"] = "Resolve로 가져올 준비가 끝난 원본이 없습니다"
        elif not result["error_count"]:
            result["status"] = "complete"
        elif success_count:
            result["status"] = "partial"
        else:
            result["status"] = "failed"

        if result["imported"] and not project_manager.SaveProject():
            result["status"] = "partial" if success_count else "failed"
            result["error"] = "Resolve 프로젝트 저장을 확인하지 못했습니다"
    finally:
        if previous_folder:
            try:
                media_pool.SetCurrentFolder(previous_folder)
            except Exception:  # noqa: BLE001 - 복원 실패가 원래 결과를 덮지 않게 한다.
                pass
    return result


def import_manifest_to_current_project(
    manifest: dict[str, Any], *, resolve: Any | None = None
) -> dict[str, Any]:
    """manifest 원본을 현재 Resolve 프로젝트에 폴더 구조대로 가져온다."""
    try:
        with _IMPORT_LOCK:
            return _import_manifest_locked(manifest, resolve or _connect_resolve())
    except Exception as exc:  # noqa: BLE001 - Resolve 외부 API 오류가 HTTP 500으로 번지지 않게 한다.
        return {
            "status": "unavailable",
            "project_name": "",
            "target_root": "",
            "total": 0,
            "imported": 0,
            "skipped": 0,
            "error_count": 0,
            "error": str(exc),
            "items": [],
        }

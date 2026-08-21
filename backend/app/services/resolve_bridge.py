"""DaVinci Resolve Media Pool 연결 계층.

파일 준비(`resolve_transfer`)와 Resolve 프로그램 조작을 분리한다. 이 모듈은
전송 manifest에 기록된 로컬 파일만 현재 열린 Resolve 프로젝트로 가져온다.
"""

from __future__ import annotations

import importlib
import os
import re
import subprocess
import sys
import threading
import time
import unicodedata
import uuid
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


MEDIA_POOL_ROOT = "MV Hub"
_SCRIPTING_RELATIVE_DIR = Path(
    "Blackmagic Design",
    "DaVinci Resolve",
    "Support",
    "Developer",
    "Scripting",
)
_IMPORT_LOCK = threading.Lock()
_CONNECT_ATTEMPTS = max(
    1, int(os.environ.get("CONTENT_HUB_RESOLVE_CONNECT_ATTEMPTS", "3"))
)
_CONNECT_RETRY_DELAY_SECONDS = max(
    0.0, float(os.environ.get("CONTENT_HUB_RESOLVE_CONNECT_RETRY_DELAY_SECONDS", "0.4"))
)
_MEDIA_IMPORT_ATTEMPTS = max(
    1, int(os.environ.get("CONTENT_HUB_RESOLVE_IMPORT_ATTEMPTS", "2"))
)
_MEDIA_IMPORT_BATCH_SIZE = max(
    1, int(os.environ.get("CONTENT_HUB_RESOLVE_IMPORT_BATCH_SIZE", "50"))
)
_MEDIA_IMPORT_RETRY_DELAY_SECONDS = max(
    0.0, float(os.environ.get("CONTENT_HUB_RESOLVE_IMPORT_RETRY_DELAY_SECONDS", "0.35"))
)
_UNSAFE_FOLDER_CHARS = re.compile(r"[\\/\x00-\x1f]")
_NATURAL_NAME_CHUNKS = re.compile(r"(\d+)")


class ResolveBridgeError(RuntimeError):
    """Resolve 연결이나 Media Pool 조작을 완료할 수 없는 오류."""

    def __init__(self, message: str, *, code: str = "resolve_error"):
        super().__init__(message)
        self.code = code


def _unique_paths(paths: list[Path]) -> list[Path]:
    result: list[Path] = []
    seen: set[str] = set()
    for path in paths:
        key = os.path.normcase(os.path.normpath(str(path)))
        if key in seen:
            continue
        seen.add(key)
        result.append(path)
    return result


def _script_module_candidates() -> list[Path]:
    """Resolve 버전·설치 방식별 공식 Python 모듈 후보 경로."""
    candidates: list[Path] = []
    for variable in ("CONTENT_HUB_RESOLVE_SCRIPT_API", "RESOLVE_SCRIPT_API"):
        raw = os.environ.get(variable, "").strip()
        if not raw:
            continue
        configured = Path(raw).expanduser()
        candidates.append(
            configured if configured.name.casefold() == "modules" else configured / "Modules"
        )
    programdata = os.environ.get("PROGRAMDATA", r"C:\ProgramData")
    candidates.append(Path(programdata) / _SCRIPTING_RELATIVE_DIR / "Modules")
    return _unique_paths(candidates)


def _script_library_candidates() -> list[Path]:
    """기본 C: 드라이브가 아닌 설치까지 포함한 fusionscript 후보."""
    candidates: list[Path] = []
    for variable in ("CONTENT_HUB_RESOLVE_SCRIPT_LIB", "RESOLVE_SCRIPT_LIB"):
        raw = os.environ.get(variable, "").strip()
        if raw:
            candidates.append(Path(raw).expanduser())
    install_dir = os.environ.get("CONTENT_HUB_RESOLVE_INSTALL_DIR", "").strip()
    if install_dir:
        candidates.append(Path(install_dir).expanduser() / "fusionscript.dll")
    for variable in ("ProgramW6432", "PROGRAMFILES", "PROGRAMFILES(X86)"):
        root = os.environ.get(variable, "").strip()
        if root:
            candidates.append(
                Path(root) / "Blackmagic Design" / "DaVinci Resolve" / "fusionscript.dll"
            )
    candidates.append(
        Path(r"C:\Program Files\Blackmagic Design\DaVinci Resolve\fusionscript.dll")
    )
    return _unique_paths(candidates)


def _prepare_resolve_api() -> tuple[list[Path], Path | None]:
    """찾아낸 API를 현재 프로세스에 연결하고 진단 정보를 반환한다."""
    module_dirs = _script_module_candidates()
    existing_module_dirs = [
        path for path in module_dirs if (path / "DaVinciResolveScript.py").is_file()
    ]
    for path in reversed(existing_module_dirs):
        value = str(path)
        if value not in sys.path:
            sys.path.insert(0, value)

    library = next((path for path in _script_library_candidates() if path.is_file()), None)
    if library is not None:
        # 공식 래퍼가 비표준 설치 드라이브에서도 DLL을 찾게 한다.
        configured = os.environ.get("RESOLVE_SCRIPT_LIB", "").strip()
        if not configured or not Path(configured).is_file():
            os.environ["RESOLVE_SCRIPT_LIB"] = str(library)
    return existing_module_dirs, library


def resolve_api_environment() -> dict[str, Any]:
    """공식 Resolve API 후보와 실제 발견 경로를 연결 시도 없이 반환한다."""
    module_candidates = _script_module_candidates()
    library_candidates = _script_library_candidates()
    existing_modules = [
        path / "DaVinciResolveScript.py"
        for path in module_candidates
        if (path / "DaVinciResolveScript.py").is_file()
    ]
    library = next((path for path in library_candidates if path.is_file()), None)
    return {
        "module_candidates": [str(path) for path in module_candidates],
        "existing_module_paths": [str(path) for path in existing_modules],
        "library_candidates": [str(path) for path in library_candidates],
        "library_path": str(library) if library else "",
    }


def _resolve_process_running() -> bool | None:
    """Windows에서 Resolve.exe 실행 여부를 짧게 확인한다.

    ``None``은 운영체제나 프로세스 조회 자체가 확인을 지원하지 않는 경우다. 이때
    실행 중이 아니라고 단정하지 않아 잘못된 안내를 피한다.
    """
    if os.name != "nt":
        return None
    creation_flags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
    try:
        completed = subprocess.run(
            ["tasklist", "/FI", "IMAGENAME eq Resolve.exe", "/FO", "CSV", "/NH"],
            check=False,
            capture_output=True,
            text=True,
            timeout=2,
            creationflags=creation_flags,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    return '"resolve.exe"' in completed.stdout.casefold()


def resolve_process_running() -> bool | None:
    """다른 진단 계층이 Resolve 실행 여부를 안전하게 재사용하도록 공개한다."""
    return _resolve_process_running()


def _python_incompatible_error(exc: Exception) -> ResolveBridgeError:
    """fusionscript(C 확장)가 현재 인터프리터와 비호환일 때의 사용자 안내."""
    py_version = f"{sys.version_info.major}.{sys.version_info.minor}.{sys.version_info.micro}"
    bits = 64 if sys.maxsize > 2**32 else 32
    return ResolveBridgeError(
        "DaVinci Resolve 연결 부품(fusionscript)을 현재 파이썬에서 불러오지 못했습니다. "
        f"현재 실행 파이썬은 {py_version} ({bits}비트)입니다. Resolve 버전에 따라 호환되는 "
        "Python이 다르며, MV Hub는 PC에 설치된 다른 64비트 Python으로 자동 재시도합니다. "
        "공식 최소조건은 Resolve의 Developer\\Scripting\\README.txt에서 확인할 수 있습니다. "
        f"(원인: {exc})",
        code="python_incompatible",
    )


def _connect_resolve() -> Any:
    """설치된 공식 Resolve 스크립팅 모듈로 실행 중인 앱에 연결한다."""
    module_dirs, library = _prepare_resolve_api()
    try:
        module = importlib.import_module("DaVinciResolveScript")
    except (ImportError, OSError) as exc:
        # 모듈 파일 부재(복구 설치 대상)와 fusionscript DLL 로드 실패(파이썬 버전
        # 비호환, "DLL load failed while importing fusionscript")를 구분한다.
        if isinstance(exc, ImportError) and (
            getattr(exc, "name", "") == "fusionscript" or "fusionscript" in str(exc)
        ):
            raise _python_incompatible_error(exc) from exc
        searched = ", ".join(str(path) for path in _script_module_candidates())
        raise ResolveBridgeError(
            "DaVinci Resolve 스크립팅 API를 찾을 수 없습니다. "
            "Resolve 설치 프로그램에서 복구 설치를 실행하세요. "
            f"확인한 위치: {searched}",
            code="module_unavailable",
        ) from exc
    except SystemError as exc:
        # fusionscript.dll(C 확장) 초기화 실패 — CPython 은 이 경우 SystemError
        # ("initialization of fusionscript failed without raising an exception")를 낸다.
        # 좁게 SystemError만 잡아 실제 코드 버그를 오진하지 않게 한다.
        raise _python_incompatible_error(exc) from exc
    last_error: Exception | None = None
    for attempt in range(_CONNECT_ATTEMPTS):
        try:
            resolve = module.scriptapp("Resolve")
        except Exception as exc:  # noqa: BLE001 - 일시적 외부 API 오류는 짧게 재시도한다.
            last_error = exc
            resolve = None
        if resolve:
            return resolve
        if attempt + 1 < _CONNECT_ATTEMPTS and _CONNECT_RETRY_DELAY_SECONDS:
            time.sleep(_CONNECT_RETRY_DELAY_SECONDS)

    if last_error is not None:
        raise ResolveBridgeError(
            "DaVinci Resolve에 연결할 수 없습니다", code="api_unavailable"
        ) from last_error
    process_running = _resolve_process_running()
    if process_running:
        detail = ""
        if module_dirs:
            detail = f" (API: {module_dirs[0]}"
            if library:
                detail += f", DLL: {library}"
            detail += ")"
        raise ResolveBridgeError(
            "DaVinci Resolve는 실행 중이지만 외부 연결이 허용되지 않았습니다. "
            "Resolve 환경설정 → 시스템 → 일반 → External scripting using을 "
            "Local로 저장한 뒤 Resolve를 완전히 종료하고 다시 실행하세요"
            + detail,
            code="api_unavailable",
        )
    if process_running is False:
        raise ResolveBridgeError(
            "DaVinci Resolve가 실행 중이지 않습니다", code="not_running"
        )
    raise ResolveBridgeError(
        "DaVinci Resolve 실행 여부를 확인할 수 없고 연결에도 실패했습니다",
        code="api_unavailable",
    )


def _project_identity(project: Any) -> tuple[str, str]:
    """Resolve 프로젝트의 안정적인 ID와 표시 이름을 반환한다."""
    name = str(project.GetName() or "")
    get_unique_id = getattr(project, "GetUniqueId", None)
    if not callable(get_unique_id):
        return "", name
    try:
        return str(get_unique_id() or ""), name
    except Exception:  # noqa: BLE001 - Resolve 버전별 미지원은 이름 확인으로 폴백한다.
        return "", name


def resolve_connection_status() -> dict[str, Any]:
    """현재 Resolve 연결과 열린 프로젝트 상태를 사용자 안내용 구조로 반환한다."""
    try:
        # Resolve 스크립팅 API는 동시 호출 안정성을 보장하지 않으므로 가져오기와 같은 잠금을 쓴다.
        with _IMPORT_LOCK:
            resolve = _connect_resolve()
            project_manager = resolve.GetProjectManager()
            project = project_manager.GetCurrentProject() if project_manager else None
            project_identity = _project_identity(project) if project else None
            get_version = getattr(resolve, "GetVersionString", None)
            resolve_version = str(get_version() or "") if callable(get_version) else ""
            get_product = getattr(resolve, "GetProductName", None)
            resolve_product = str(get_product() or "") if callable(get_product) else ""
        if not project:
            return {
                "status": "no_project",
                "connected": True,
                "process_running": True,
                "project_open": False,
                "project_id": "",
                "project_name": "",
                "resolve_version": resolve_version,
                "resolve_product": resolve_product,
                "message": "DaVinci Resolve는 연결됐지만 열려 있는 프로젝트가 없습니다",
            }
        project_id, project_name = project_identity or ("", "")
        return {
            "status": "ready",
            "connected": True,
            "process_running": True,
            "project_open": True,
            "project_id": project_id,
            "project_name": project_name,
            "resolve_version": resolve_version,
            "resolve_product": resolve_product,
            "message": f"DaVinci Resolve 연결됨 · {project_name}",
        }
    except ResolveBridgeError as exc:
        process_running = exc.code != "not_running"
        return {
            "status": exc.code,
            "connected": False,
            "process_running": process_running,
            "project_open": False,
            "project_id": "",
            "project_name": "",
            "resolve_version": "",
            "resolve_product": "",
            "message": str(exc),
        }
    except Exception as exc:  # noqa: BLE001 - 외부 API 상태 확인 실패도 HTTP 500으로 만들지 않는다.
        return {
            "status": "api_unavailable",
            "connected": False,
            "process_running": True,
            "project_open": False,
            "project_id": "",
            "project_name": "",
            "resolve_version": "",
            "resolve_product": "",
            "message": f"DaVinci Resolve 연결 상태를 확인할 수 없습니다: {exc}",
        }


def _assert_expected_project(manifest: dict[str, Any], project: Any) -> None:
    """보내기를 누를 때 고정한 프로젝트와 현재 프로젝트가 같은지 확인한다."""
    target = manifest.get("resolve_target") or {}
    expected_id = str(target.get("project_id") or "")
    expected_name = str(target.get("project_name") or "")
    if not expected_id and not expected_name:
        return

    current_id, current_name = _project_identity(project)
    id_mismatch = bool(expected_id and current_id and expected_id != current_id)
    name_fallback_mismatch = bool(
        expected_name and (not expected_id or not current_id) and expected_name != current_name
    )
    if id_mismatch or name_fallback_mismatch:
        expected_label = expected_name or expected_id
        current_label = current_name or current_id or "확인 불가"
        raise ResolveBridgeError(
            "Resolve 프로젝트가 전송 시작 때와 달라졌습니다 "
            f"(예정: {expected_label}, 현재: {current_label}). "
            "예정된 프로젝트를 다시 연 뒤 준비된 원본 다시 가져오기를 실행하세요",
            code="project_changed",
        )


def _folder_name(value: str, fallback: str) -> str:
    cleaned = _UNSAFE_FOLDER_CHARS.sub("_", value.strip()).strip(" .")
    return cleaned or fallback


def _folder_parts(value: str) -> list[str]:
    return [
        part
        for part in value.replace("\\", "/").split("/")
        if part and part not in {".", ".."}
    ]


def _natural_name_key(value: str) -> tuple[Any, ...]:
    """숫자 덩어리를 실제 숫자로 비교해 c2가 c10보다 먼저 오게 한다."""
    chunks = tuple(
        (1, int(chunk)) if chunk.isdigit() else (0, chunk.casefold())
        for chunk in _NATURAL_NAME_CHUNKS.split(value)
        if chunk
    )
    return chunks, value.casefold(), value


def _folder_path_sort_key(parts: tuple[str, ...]) -> tuple[Any, ...]:
    return tuple(
        _natural_name_key(_folder_name(part, "미분류")) for part in parts
    )


def _refresh_folders(media_pool: Any) -> None:
    refresh = getattr(media_pool, "RefreshFolders", None)
    if callable(refresh):
        refresh()


def _folder_identity(value: str) -> str:
    """Resolve/Windows 사이 한글 정규화 차이도 같은 Bin 이름으로 본다."""
    return unicodedata.normalize("NFC", value).casefold()


def _find_subfolder(parent: Any, name: str) -> Any | None:
    wanted = _folder_identity(name)
    for folder in parent.GetSubFolderList() or []:
        if _folder_identity(str(folder.GetName() or "")) == wanted:
            return folder
    return None


def _folder_path_from_root(root: Any, target: Any) -> tuple[str, ...] | None:
    """재생성 뒤에도 같은 위치를 다시 선택할 수 있게 현재 Bin 경로를 기록한다."""
    try:
        target_id = str(target.GetUniqueId() or "")
    except (AttributeError, TypeError):
        target_id = ""

    def visit(folder: Any, path: tuple[str, ...]) -> tuple[str, ...] | None:
        try:
            folder_id = str(folder.GetUniqueId() or "")
        except (AttributeError, TypeError):
            folder_id = ""
        if folder is target or (target_id and folder_id == target_id):
            return path
        for child in folder.GetSubFolderList() or []:
            found = visit(child, (*path, str(child.GetName() or "")))
            if found is not None:
                return found
        return None

    return visit(root, ())


def _folder_at_path(root: Any, parts: tuple[str, ...]) -> Any | None:
    folder = root
    for name in parts:
        folder = _find_subfolder(folder, name)
        if folder is None:
            return None
    return folder


def _subfolder(parent: Any, name: str, media_pool: Any) -> Any:
    existing = _find_subfolder(parent, name)
    if existing is not None:
        return existing
    created = media_pool.AddSubFolder(parent, name)
    if not created:
        raise ResolveBridgeError(f"Resolve Media Pool 폴더를 만들 수 없습니다: {name}")
    if _folder_identity(str(created.GetName() or "")) != _folder_identity(name):
        # 스캔 직후 다른 요청이 같은 Bin을 만든 경합이면 Resolve가 `name copy`를
        # 반환할 수 있다. 방금 만든 빈 복제본만 치우고 먼저 생긴 정상 Bin을 쓴다.
        winner = _find_subfolder(parent, name)
        is_empty = not (created.GetSubFolderList() or []) and not (
            created.GetClipList() or []
        )
        delete_folders = getattr(media_pool, "DeleteFolders", None)
        if (
            winner is not None
            and is_empty
            and callable(delete_folders)
            and delete_folders([created])
        ):
            return winner
        raise ResolveBridgeError(
            f"Resolve가 중복 폴더를 만들었습니다: {created.GetName()}"
        )
    return created


def _destination_folder(media_pool: Any, root: Any, parts: list[str]) -> Any:
    folder = root
    for raw_part in parts:
        part = _folder_name(raw_part, "미분류")
        folder = _subfolder(folder, part, media_pool)
    return folder


# 매핑 드라이브 문자("z:") → UNC 루트("\\nas\share") 캐시. 조회 실패(로컬 디스크 등)는
# None 으로 캐시해 드라이브당 1회만 시스템 호출한다.
_DRIVE_UNC_CACHE: dict[str, "str | None"] = {}


def _drive_unc(drive: str) -> "str | None":
    """네트워크 매핑 드라이브면 UNC 루트를 반환, 아니면 None (Windows 전용)."""
    if os.name != "nt" or len(drive) != 2 or drive[1] != ":":
        return None
    key = drive.lower()
    if key in _DRIVE_UNC_CACHE:
        return _DRIVE_UNC_CACHE[key]
    unc: "str | None" = None
    try:
        import ctypes

        buf = ctypes.create_unicode_buffer(1024)
        length = ctypes.c_ulong(len(buf))
        if ctypes.windll.mpr.WNetGetConnectionW(drive, buf, ctypes.byref(length)) == 0:
            unc = buf.value or None
    except Exception:  # noqa: BLE001 — 조회 실패는 '매핑 아님'과 동일 취급
        unc = None
    _DRIVE_UNC_CACHE[key] = unc
    return unc


def _normal_path(value: str) -> str:
    """경로를 비교 가능한 정규형으로.

    ★Z:↔UNC 통일: Resolve 의 GetClipProperty('File Path')는 클립이 등록된 표기를 그대로
    돌려준다. 우리는 Z:\\... 로 ImportMedia 했는데 Resolve 가 \\\\NAS\\... 로 기록하면(또는
    반대) dedupe 매칭이 전부 빗나가 ①같은 파일을 한 번 더 import(Media Pool 중복)
    ②성공한 가져오기를 전 항목 실패로 보고했다. 매핑 드라이브는 UNC 루트로 치환해
    양쪽 표기가 같은 정규형이 되게 한다."""
    if not value:
        return ""
    try:
        normalized = os.path.normcase(os.path.normpath(str(Path(value).resolve(strict=False))))
    except OSError:
        normalized = os.path.normcase(os.path.normpath(value))
    drive, rest = os.path.splitdrive(normalized)
    if drive and not drive.startswith("\\\\"):
        unc = _drive_unc(drive)
        if unc:
            normalized = os.path.normcase(os.path.normpath(unc + rest))
    return normalized


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


def _import_media_batch(
    media_pool: Any,
    target: Any,
    entries: list[tuple[dict[str, Any], Path, str]],
    result: dict[str, Any],
) -> None:
    """한 Bin의 원본을 묶어 가져오고, 빠진 항목만 한 번 더 시도한다."""
    remaining = list(entries)
    last_error = ""
    for attempt in range(_MEDIA_IMPORT_ATTEMPTS):
        if not remaining:
            break
        returned_paths: set[str] = set()
        returned_all = False
        try:
            if not media_pool.SetCurrentFolder(target):
                raise ResolveBridgeError("Resolve Media Pool 대상 폴더를 선택할 수 없습니다")
            imported = media_pool.ImportMedia([str(source) for _item, source, _path in remaining])
            if not imported:
                last_error = "Resolve가 원본 파일을 가져오지 못했습니다"
            elif isinstance(imported, (list, tuple)):
                returned_paths = {
                    normalized
                    for clip in imported
                    if (normalized := _normal_path(_clip_file_path(clip)))
                }
                # 일부 Resolve 버전/파일 형식은 반환 객체의 File Path 속성이 즉시 비어
                # 있어도 요청 수와 같은 객체를 돌려준다. 이 경우 기존 API 성공 계약을 믿는다.
                returned_all = len(imported) == len(remaining) and not returned_paths
        except Exception as exc:  # noqa: BLE001 - 부분 성공 여부를 실제 Bin 경로로 다시 확인한다.
            last_error = str(exc)

        try:
            _refresh_folders(media_pool)
            current_paths = _existing_paths(target) | returned_paths
        except Exception as exc:  # noqa: BLE001 - 확인 불가 항목은 재시도 후 개별 실패로 남긴다.
            current_paths = set()
            last_error = str(exc)

        next_remaining: list[tuple[dict[str, Any], Path, str]] = []
        for item, source, normalized in remaining:
            if returned_all or normalized in current_paths:
                item["status"] = "imported"
                result["imported"] += 1
            else:
                next_remaining.append((item, source, normalized))
        remaining = next_remaining
        if (
            remaining
            and attempt + 1 < _MEDIA_IMPORT_ATTEMPTS
            and _MEDIA_IMPORT_RETRY_DELAY_SECONDS
        ):
            time.sleep(_MEDIA_IMPORT_RETRY_DELAY_SECONDS)

    for item, _source, _normalized in remaining:
        item["status"] = "error"
        item["error"] = last_error or "Resolve가 원본 파일을 가져오지 못했습니다"
        result["error_count"] += 1


def _path_identity(parts: tuple[str, ...]) -> tuple[str, ...]:
    return tuple(_folder_identity(part) for part in parts)


def _desired_tree(
    folder_paths: set[tuple[str, ...]],
) -> tuple[
    dict[tuple[str, ...], tuple[str, ...]],
    dict[tuple[str, ...], list[tuple[str, str]]],
]:
    """카탈로그 경로를 정규 경로와 부모별 자연 정렬 목록으로 바꾼다."""
    nodes: dict[tuple[str, ...], tuple[str, ...]] = {(): ()}
    children: dict[tuple[str, ...], dict[str, str]] = {}
    for raw_parts in folder_paths:
        clean = tuple(_folder_name(part, "미분류") for part in raw_parts if part)
        for depth, name in enumerate(clean):
            parent = clean[:depth]
            path = clean[: depth + 1]
            parent_id = _path_identity(parent)
            path_id = _path_identity(path)
            nodes[path_id] = path
            children.setdefault(parent_id, {})[_folder_identity(name)] = name
    ordered_children = {
        parent_id: sorted(
            values.items(), key=lambda item: _natural_name_key(item[1])
        )
        for parent_id, values in children.items()
    }
    return nodes, ordered_children


def _scan_actual_tree(
    folder: Any,
    *,
    path: tuple[str, ...] = (),
    nodes: dict[tuple[str, ...], tuple[tuple[str, ...], Any]] | None = None,
    children: dict[tuple[str, ...], list[tuple[str, str]]] | None = None,
) -> tuple[
    dict[tuple[str, ...], tuple[tuple[str, ...], Any]],
    dict[tuple[str, ...], list[tuple[str, str]]],
]:
    nodes = nodes if nodes is not None else {(): ((), folder)}
    children = children if children is not None else {}
    parent_id = _path_identity(path)
    seen: set[str] = set()
    child_rows: list[tuple[str, str]] = []
    for child in folder.GetSubFolderList() or []:
        name = str(child.GetName() or "")
        identity = _folder_identity(name)
        if identity in seen:
            raise ResolveBridgeError(f"Resolve에 같은 이름의 Bin이 중복되어 있습니다: {name}")
        seen.add(identity)
        child_rows.append((identity, name))
        child_path = (*path, name)
        child_id = _path_identity(child_path)
        nodes[child_id] = (child_path, child)
        _scan_actual_tree(child, path=child_path, nodes=nodes, children=children)
    children[parent_id] = child_rows
    return nodes, children


def _clip_identity(clip: Any) -> str:
    normalized = _normal_path(_clip_file_path(clip))
    if normalized:
        return f"path:{normalized}"
    try:
        media_id = str(clip.GetMediaId() or "")
    except (AttributeError, TypeError):
        media_id = ""
    return f"id:{media_id}" if media_id else f"object:{id(clip)}"


def _create_tree(
    media_pool: Any, root: Any, paths: set[tuple[str, ...]]
) -> dict[tuple[str, ...], Any]:
    nodes: dict[tuple[str, ...], Any] = {(): root}
    all_nodes = {
        parts[:depth]
        for parts in paths
        for depth in range(1, len(parts) + 1)
    }
    for parts in sorted(
        all_nodes, key=lambda value: (len(value), _folder_path_sort_key(value))
    ):
        parent = nodes[parts[:-1]]
        nodes[parts] = _subfolder(parent, _folder_name(parts[-1], "미분류"), media_pool)
    return nodes


def _delete_empty_children(media_pool: Any, parent: Any) -> None:
    delete_folders = getattr(media_pool, "DeleteFolders", None)
    if not callable(delete_folders):
        raise ResolveBridgeError("현재 Resolve가 빈 Bin 삭제를 지원하지 않습니다")
    for child in list(parent.GetSubFolderList() or []):
        _delete_empty_children(media_pool, child)
        if (child.GetClipList() or []) or (child.GetSubFolderList() or []):
            raise ResolveBridgeError(f"비어 있지 않은 Bin은 정리하지 않습니다: {child.GetName()}")
        if not delete_folders([child]):
            raise ResolveBridgeError(f"빈 Bin을 정리하지 못했습니다: {child.GetName()}")
        _refresh_folders(media_pool)


def _export_rebuild_backup(
    manifest: dict[str, Any], project_manager: Any, project: Any
) -> str:
    manifest_root_raw = str(manifest.get("manifest_root") or "").strip()
    if not manifest_root_raw:
        raise ResolveBridgeError("Resolve 구조 변경 전 백업 경로가 없습니다")
    manifest_root = Path(manifest_root_raw).resolve()
    backup_dir = (manifest_root / ".mvhub" / "resolve-backups").resolve()
    try:
        backup_dir.relative_to(manifest_root)
    except ValueError as exc:
        raise ResolveBridgeError("Resolve 백업 경로가 프로젝트 밖을 가리킵니다") from exc
    backup_dir.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    project_name = str(project.GetName() or "Resolve")
    backup_path = backup_dir / f"resolve-{stamp}-{uuid.uuid4().hex[:8]}.drp"
    if not project_manager.SaveProject():
        raise ResolveBridgeError("Resolve 구조 변경 전 프로젝트를 저장하지 못했습니다")
    export_project = getattr(project_manager, "ExportProject", None)
    if not callable(export_project) or not export_project(
        project_name, str(backup_path), False
    ):
        raise ResolveBridgeError("Resolve 구조 변경 전 프로젝트 백업을 만들지 못했습니다")
    return str(backup_path)


def _reconcile_folder_tree_visible(
    manifest: dict[str, Any],
    project_manager: Any,
    project: Any,
    media_pool: Any,
    root: Any,
    managed_root: Any,
    desired_paths: set[tuple[str, ...]],
) -> tuple[bool, str]:
    """MoveFolders 없이 클립을 보존하며 MV Hub Bin을 카탈로그 순서로 맞춘다."""
    actual_nodes, actual_children = _scan_actual_tree(managed_root)
    # 과거 목록 파일은 읽지 않는다. Resolve에 이미 있는 Bin은 보존하고,
    # 이번에 선택한 경로만 더해 자연 정렬 대상을 만든다.
    desired_paths = set(desired_paths)
    desired_paths.update(
        path for identity, (path, _folder) in actual_nodes.items() if identity
    )
    desired_nodes, desired_children = _desired_tree(desired_paths)

    rebuild_needed = False
    for parent_id, desired_rows in desired_children.items():
        actual_ids = [identity for identity, _name in actual_children.get(parent_id, [])]
        desired_ids = [identity for identity, _name in desired_rows]
        if actual_ids != desired_ids[: len(actual_ids)]:
            rebuild_needed = True
            break

    if not rebuild_needed:
        before_count = len(actual_nodes)
        _create_tree(media_pool, managed_root, desired_paths)
        return len(desired_nodes) > before_count, ""

    move_clips = getattr(media_pool, "MoveClips", None)
    if not callable(move_clips):
        raise ResolveBridgeError("현재 Resolve가 클립을 보존한 Bin 재정렬을 지원하지 않습니다")
    backup_path = _export_rebuild_backup(manifest, project_manager, project)
    snapshots: dict[tuple[str, ...], tuple[list[Any], Counter[str]]] = {}
    for identity, desired_path in desired_nodes.items():
        if not identity or identity not in actual_nodes:
            continue
        clips = list(actual_nodes[identity][1].GetClipList() or [])
        if clips:
            snapshots[desired_path] = (clips, Counter(map(_clip_identity, clips)))

    staging_name = f"__MVHUB_REBUILD_{uuid.uuid4().hex}__"
    staging = media_pool.AddSubFolder(root, staging_name)
    if not staging or _folder_identity(str(staging.GetName() or "")) != _folder_identity(
        staging_name
    ):
        raise ResolveBridgeError(
            f"Resolve 정렬용 임시 Bin을 만들지 못했습니다. 백업: {backup_path}"
        )
    staged_nodes: dict[tuple[str, ...], Any] = {(): staging}
    try:
        staged_nodes = _create_tree(media_pool, staging, set(snapshots))
        for path, (clips, _identities) in snapshots.items():
            if clips and not move_clips(clips, staged_nodes[path]):
                raise ResolveBridgeError(f"클립을 정렬용 공간으로 옮기지 못했습니다: {'/'.join(path)}")
        for identity, (_path, folder) in actual_nodes.items():
            if identity and (folder.GetClipList() or []):
                raise ResolveBridgeError(f"기존 Bin에 클립이 남아 있습니다: {folder.GetName()}")

        _delete_empty_children(media_pool, managed_root)
        final_nodes = _create_tree(media_pool, managed_root, desired_paths)
        for path, (_clips, expected) in snapshots.items():
            staged_clips = list(staged_nodes[path].GetClipList() or [])
            if staged_clips and not move_clips(staged_clips, final_nodes[path]):
                raise ResolveBridgeError(f"클립을 정렬된 Bin으로 되돌리지 못했습니다: {'/'.join(path)}")
            actual = Counter(map(_clip_identity, final_nodes[path].GetClipList() or []))
            if actual != expected:
                raise ResolveBridgeError(f"정렬 후 클립 검증이 일치하지 않습니다: {'/'.join(path)}")

        _delete_empty_children(media_pool, staging)
        if not media_pool.DeleteFolders([staging]):
            raise ResolveBridgeError("Resolve 정렬용 임시 Bin을 정리하지 못했습니다")
        _refresh_folders(media_pool)

        _actual_nodes, final_children = _scan_actual_tree(managed_root)
        for parent_id, desired_rows in desired_children.items():
            if [row[0] for row in final_children.get(parent_id, [])] != [
                row[0] for row in desired_rows
            ]:
                raise ResolveBridgeError("Resolve 화면의 최종 Bin 순서가 일치하지 않습니다")
        return True, backup_path
    except Exception as exc:
        recovery_errors: list[str] = []
        try:
            remaining: dict[tuple[str, ...], list[Any]] = {}
            if staging:
                staged_actual, _children = _scan_actual_tree(staging)
                for _identity, (path, folder) in staged_actual.items():
                    if path and (clips := list(folder.GetClipList() or [])):
                        remaining[path] = clips
            if remaining:
                recovery_nodes = _create_tree(media_pool, managed_root, set(remaining))
                for path, clips in remaining.items():
                    if clips and not move_clips(clips, recovery_nodes[path]):
                        recovery_errors.append(f"클립 복구 실패: {'/'.join(path)}")
            if staging and not recovery_errors:
                _delete_empty_children(media_pool, staging)
                if not media_pool.DeleteFolders([staging]):
                    recovery_errors.append("임시 Bin 정리 실패")
            project_manager.SaveProject()
        except Exception as recovery_exc:  # noqa: BLE001 - 복구 결과를 원인과 함께 보고한다.
            recovery_errors.append(str(recovery_exc))
        suffix = f" 백업: {backup_path}"
        if recovery_errors:
            suffix += "; 자동 복구 확인 필요: " + ", ".join(recovery_errors)
        raise ResolveBridgeError(f"{exc}.{suffix}") from exc


def _reconcile_folder_tree(
    manifest: dict[str, Any],
    project_manager: Any,
    project: Any,
    media_pool: Any,
    root: Any,
    managed_root: Any,
    desired_paths: set[tuple[str, ...]],
) -> tuple[bool, str]:
    """카탈로그 구조를 현재 Resolve Media Pool에 적용한다."""
    return _reconcile_folder_tree_visible(
        manifest,
        project_manager,
        project,
        media_pool,
        root,
        managed_root,
        desired_paths,
    )


def _import_manifest_locked(manifest: dict[str, Any], resolve: Any) -> dict[str, Any]:
    project_manager = resolve.GetProjectManager()
    project = project_manager.GetCurrentProject() if project_manager else None
    if not project:
        raise ResolveBridgeError("현재 열려 있는 Resolve 프로젝트가 없습니다")
    _assert_expected_project(manifest, project)
    media_pool = project.GetMediaPool()
    root = media_pool.GetRootFolder() if media_pool else None
    if not media_pool or not root:
        raise ResolveBridgeError("현재 Resolve 프로젝트의 Media Pool을 열 수 없습니다")

    previous_folder = media_pool.GetCurrentFolder()
    previous_folder_path = (
        _folder_path_from_root(root, previous_folder) if previous_folder else None
    )
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
        "folder_order_backup": "",
        "items": [],
    }

    try:
        managed_root = _destination_folder(media_pool, root, [MEDIA_POOL_ROOT, project_label])
        source_items = [
            source_item
            for source_item in manifest.get("items") or []
            if source_item.get("status") in {"downloaded", "skipped"}
        ]

        # Resolve에는 정렬 API가 없다. 현재 Resolve 구조와 이번 선택 경로만 합쳐,
        # 삽입 순서가 깨질 때만 백업 후 클립 보존 재생성으로 화면 순서까지 맞춘다.
        folder_paths: set[tuple[str, ...]] = set()
        for source_item in source_items:
            source = Path(str(source_item.get("local_path") or ""))
            try:
                if not source.is_file() or source.stat().st_size <= 0:
                    continue
            except OSError:
                continue
            folder_paths.add(
                tuple(_folder_parts(str(source_item.get("folder_path") or "")))
            )

        ordering_errors: list[str] = []
        reordered = False
        try:
            reordered, backup_path = _reconcile_folder_tree(
                manifest,
                project_manager,
                project,
                media_pool,
                root,
                managed_root,
                folder_paths,
            )
            result["folder_order_backup"] = backup_path
        except Exception as exc:  # noqa: BLE001 - 가져오기는 유지하고 정렬 실패를 보고한다.
            ordering_errors.append(str(exc))

        prepared_targets = {(): managed_root}
        folder_errors: dict[tuple[str, ...], str] = {}
        for parts_key in sorted(folder_paths, key=_folder_path_sort_key):
            try:
                prepared_targets[parts_key] = _destination_folder(
                    media_pool, managed_root, list(parts_key)
                )
            except Exception as exc:  # noqa: BLE001 - 해당 경로 항목만 실패 처리한다.
                folder_errors[parts_key] = str(exc)

        import_batches: dict[
            tuple[str, ...], list[tuple[dict[str, Any], Path, str]]
        ] = {}
        existing_paths_by_folder: dict[tuple[str, ...], set[str]] = {}
        queued_paths_by_folder: dict[tuple[str, ...], set[str]] = {}
        for source_item in source_items:
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
                parts = _folder_parts(str(source_item.get("folder_path") or ""))
                parts_key = tuple(parts)
                if parts_key in folder_errors:
                    raise ResolveBridgeError(folder_errors[parts_key])
                if parts_key not in prepared_targets:
                    # 준비 검사와 실제 가져오기 사이에 파일 상태가 바뀐 경우에도
                    # 이전 동작처럼 해당 항목을 가져올 수 있게 한다.
                    prepared_targets[parts_key] = _destination_folder(
                        media_pool, managed_root, parts
                    )
                target = prepared_targets[parts_key]
                item["media_pool_path"] = "/".join(
                    [MEDIA_POOL_ROOT, project_label, *parts]
                )
                normalized = _normal_path(str(source))
                if parts_key not in existing_paths_by_folder:
                    existing_paths_by_folder[parts_key] = _existing_paths(target)
                if normalized in existing_paths_by_folder[parts_key]:
                    item["status"] = "skipped"
                    result["skipped"] += 1
                    continue
                queued = queued_paths_by_folder.setdefault(parts_key, set())
                if normalized in queued:
                    item["status"] = "skipped"
                    result["skipped"] += 1
                    continue
                queued.add(normalized)
                import_batches.setdefault(parts_key, []).append((item, source, normalized))
            except Exception as exc:  # noqa: BLE001 - 항목별 실패를 격리한다.
                item["status"] = "error"
                item["error"] = str(exc)
                result["error_count"] += 1

        for parts_key in sorted(import_batches, key=_folder_path_sort_key):
            entries = import_batches[parts_key]
            for start in range(0, len(entries), _MEDIA_IMPORT_BATCH_SIZE):
                _import_media_batch(
                    media_pool,
                    prepared_targets[parts_key],
                    entries[start : start + _MEDIA_IMPORT_BATCH_SIZE],
                    result,
                )

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

        if ordering_errors:
            result["status"] = "partial" if success_count else "failed"
            result["error"] = "Resolve 폴더 카탈로그 적용 실패: " + "; ".join(
                ordering_errors
            )

        if (result["imported"] or reordered) and not project_manager.SaveProject():
            result["status"] = "partial" if success_count else "failed"
            save_error = "Resolve 프로젝트 저장을 확인하지 못했습니다"
            result["error"] = (
                f"{result['error']}; {save_error}" if result["error"] else save_error
            )
    finally:
        if previous_folder:
            try:
                _refresh_folders(media_pool)
                restored = (
                    _folder_at_path(root, previous_folder_path)
                    if previous_folder_path is not None
                    else None
                )
                media_pool.SetCurrentFolder(restored or previous_folder)
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

"""DaVinci Resolve Media Pool 연결 계층.

파일 준비(`resolve_transfer`)와 Resolve 프로그램 조작을 분리한다. 이 모듈은
전송 manifest에 기록된 로컬 파일만 현재 열린 Resolve 프로젝트로 가져온다.
"""

from __future__ import annotations

import hashlib
import importlib
import json
import os
import re
import stat as stat_module
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
MVHUB_METADATA_KEY = "MV Hub"
MVHUB_METADATA_VERSION = 1
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

# ── attempt journal 훅 (명세 §부속 A) ─────────────────────────────────────────
# 이 모듈은 부모(허브)와 자식(resolve_import_worker) 양쪽에서 로드된다. 부모는 자식의
# stdout JSON 만 기다리므로 중간 단계를 볼 수 없다 — 그래서 자식이 여기서 직접 phase 를
# journal 에 원자 기록한다. 훅이 없으면(부모·in-process 실행) 아무 일도 하지 않는다.
_journal_hook: Any = None


def set_journal_hook(hook: Any) -> None:
    global _journal_hook
    _journal_hook = hook


def _journal(phase: str, **fields: Any) -> None:
    hook = _journal_hook
    if hook is None:
        return
    try:
        hook(phase, **fields)
    except Exception:  # noqa: BLE001 - 기록 실패가 가져오기 자체를 깨지 않는다.
        pass


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
            # 지금 보고 있는 프로젝트 라이브러리 — 같은 이름 프로젝트가 다른 라이브러리에도 있을 수 있어
            # 화면이 '열려 있음'을 판정할 때 함께 본다. 라이브러리를 바꾸지 않는 읽기다.
            try:
                current_database = dict(project_manager.GetCurrentDatabase() or {}) if project_manager else {}
            except Exception:  # noqa: BLE001 - 없으면 화면이 '확인 불가'로 다룬다.
                current_database = {}
            database_name = str(current_database.get("DbName") or "")
        if not project:
            return {
                "status": "no_project",
                "connected": True,
                "process_running": True,
                "project_open": False,
                "project_id": "",
                "project_name": "",
                "database_name": database_name,
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
            "database_name": database_name,
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


class _ProjectChanged(ResolveBridgeError):
    """가져오는 도중 Resolve 에서 다른 프로젝트가 열렸다(code = project_changed).

    fact = 무슨 일이 있었나, hint = 무엇을 하면 되나 — 글은 둘을 이은 것이다. 따로 두는 까닭: Bin 순서를 다시 짓다 멈춘 때는
    '다시 가져오기'가 아니라 **복구가 먼저**라, 같은 사실에 다른 안내를 붙인다(leftover = 그때 남은 임시 Bin·백업)."""

    def __init__(self, fact: str, hint: str, leftover: dict[str, str] | None = None):
        super().__init__(f"{fact} — {hint}", code="project_changed")
        self.fact = fact
        self.leftover = leftover or {}


def _assert_still_current(project_manager: Any, started: tuple[str, str]) -> None:
    """Resolve 에 **쓰는 호출 바로 앞마다** — 지금 열린 프로젝트가 이 가져오기를 시작한 그 프로젝트인가.

    쓰는 호출 = Bin 만들기·클립 옮기기·Bin 지우기 하나하나, 가져오기 묶음, 저장(정렬 백업·복구의 저장 포함).
    **ProjectManager 에서 다시 물어** 본다(resolve_timeline 의 guard 와 같은 확인): 처음 받은 project 객체만 보면 그사이 다른
    프로젝트를 연 것을 놓치고, SaveProject 는 **그때 열려 있는** 프로젝트를 저장한다(Codex 배포 전 검토 2026-10-13).
    started = 시작할 때의 (ID, 이름) — ID 를 못 읽는 Resolve 는 이름으로 견준다. 사람의 조작과 API 호출 사이의 틈까지
    막지는 못한다(호출 하나 — 가져오기 묶음이면 그 묶음 — 가 도는 도중에 바꾸면 그 호출은 끝난다. 그 뒤로 멈추고 저장하지 않는다)."""
    current = project_manager.GetCurrentProject()
    current_id, current_name = _project_identity(current) if current else ("", "")
    started_id, started_name = started
    same = bool(current) and (
        current_id == started_id if started_id and current_id else current_name == started_name
    )
    if not same:
        raise _ProjectChanged(
            "가져오는 도중 Resolve 프로젝트가 바뀌어 멈췄습니다 "
            f"(시작: {started_name or started_id}, 현재: {current_name or current_id or '없음'}). "
            "지금 열린 프로젝트는 저장하지 않았습니다",
            "시작한 프로젝트를 다시 연 뒤 준비된 원본 다시 가져오기를 실행하세요",
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


def _clips_by_path(folder: Any) -> dict[str, Any]:
    """Bin 클립을 정규 원본 경로로 찾는다. 같은 원본의 중복 클립은 첫 항목을 쓴다."""
    result: dict[str, Any] = {}
    for clip in folder.GetClipList() or []:
        normalized = _normal_path(_clip_file_path(clip))
        if not normalized:
            continue
        result.setdefault(normalized, clip)
    return result


def _existing_paths(folder: Any) -> set[str]:
    return set(_clips_by_path(folder))


def mvhub_clip_metadata(generation_id: str, project_id: str) -> str:
    """Resolve의 숨은 third-party metadata에 넣는 작은 MV Hub 식별자."""
    return json.dumps(
        {
            "version": MVHUB_METADATA_VERSION,
            "generation_id": generation_id,
            "project_id": project_id,
        },
        ensure_ascii=True,
        separators=(",", ":"),
    )


def parse_mvhub_clip_metadata(value: Any) -> dict[str, str] | None:
    """버전 1 메타데이터만 엄격히 읽는다. 손상·타 앱 값은 선택 연결에 쓰지 않는다."""
    if not isinstance(value, str) or not value:
        return None
    try:
        payload = json.loads(value)
    except json.JSONDecodeError:
        return None
    if not isinstance(payload, dict) or payload.get("version") != MVHUB_METADATA_VERSION:
        return None
    generation_id = str(payload.get("generation_id") or "").strip()
    project_id = str(payload.get("project_id") or "").strip()
    if not generation_id or not project_id:
        return None
    return {"generation_id": generation_id, "project_id": project_id}


def _stamp_mvhub_metadata(clip: Any, generation_id: str, project_id: str) -> bool:
    """가져오기 성공과 독립된 best-effort 메타데이터 기록."""
    setter = getattr(clip, "SetThirdPartyMetadata", None)
    if not callable(setter) or not generation_id or not project_id:
        return False
    value = mvhub_clip_metadata(generation_id, project_id)
    getter = getattr(clip, "GetThirdPartyMetadata", None)
    try:
        if callable(getter) and getter(MVHUB_METADATA_KEY) == value:
            return False
        return bool(setter(MVHUB_METADATA_KEY, value))
    except Exception:  # noqa: BLE001 - 메타데이터 미지원이 원본 가져오기를 실패시키면 안 된다.
        return False


# Resolve 가 이미지 시퀀스로 묶을 수 있는 스틸 확장자. 판정은 manifest 필드가 아니라
# 확장자로 한다 — 반입 계층까지 내려오는 항목에는 media_type 이 없다.
_STILL_IMAGE_SUFFIXES = {
    ".png", ".jpg", ".jpeg", ".tif", ".tiff", ".exr", ".dpx", ".tga", ".bmp", ".webp",
}


def _is_still_image(path: str) -> bool:
    return Path(path).suffix.lower() in _STILL_IMAGE_SUFFIXES


def _import_groups(sources: list[str]) -> list[list[str]]:
    """스틸은 한 건씩, 잇달아 있는 영상·오디오는 한 묶음으로 나눈다(원래 순서 유지).

    스틸을 한 호출에 같이 넣으면 Resolve 가 번호만 다른 이미지를 이미지 시퀀스로 합쳐
    클립 하나(``[00-01]``)로 만든다. 영상·오디오는 그럴 일이 없어 묶어 넣는다(대량 전송 성능).
    """
    groups: list[list[str]] = []
    for path in sources:
        if not _is_still_image(path) and groups and not _is_still_image(groups[-1][0]):
            groups[-1].append(path)
        else:
            groups.append([path])
    return groups


def _import_media_items(media_pool: Any, sources: list[str]) -> list[Any]:
    """원본을 Media Pool 로 가져온다. 한 묶음이 실패해도 나머지는 계속 넣는다.

    한 건의 예외로 루프를 끊으면 뒤 항목이 호출조차 안 된 채 전부 실패로 집계된다
    (코덱스 리뷰). 전부 실패했을 때만 마지막 예외를 그대로 올려 원인을 남긴다.

    ``ImportMedia([{"FilePath": …}])`` 는 문서상 항목당 클립 하나를 만들지만 실기에서는
    아무것도 가져오지 못했다(2026-09-02 실측, `media_import_failed`). 그래서 경로 목록만 쓴다.
    """
    imported: list[Any] = []
    last_error: BaseException | None = None
    for group in _import_groups(sources):
        try:
            clips = media_pool.ImportMedia(list(group))
        except Exception as exc:  # noqa: BLE001 - 묶음별 실패를 격리한다
            last_error = exc
            continue
        if clips:
            imported.extend(clips)
    if not imported and last_error is not None:
        raise last_error
    return imported


def _import_media_batch(
    media_pool: Any,
    target: Any,
    entries: list[tuple[dict[str, Any], Path, str]],
    result: dict[str, Any],
    project_id: str = "",
) -> bool:
    """한 Bin의 원본을 묶어 가져오고, 빠진 항목만 한 번 더 시도한다."""
    remaining = list(entries)
    last_error = ""
    metadata_changed = False
    for attempt in range(_MEDIA_IMPORT_ATTEMPTS):
        if not remaining:
            break
        returned_paths: set[str] = set()
        returned_by_path: dict[str, Any] = {}
        returned_all = False
        try:
            if not media_pool.SetCurrentFolder(target):
                raise ResolveBridgeError("Resolve Media Pool 대상 폴더를 선택할 수 없습니다")
            imported = _import_media_items(
                media_pool, [str(source) for _item, source, _path in remaining]
            )
            if not imported:
                last_error = "Resolve가 원본 파일을 가져오지 못했습니다"
            elif isinstance(imported, (list, tuple)):
                returned_paths = {
                    normalized
                    for clip in imported
                    if (normalized := _normal_path(_clip_file_path(clip)))
                }
                returned_by_path = {
                    normalized: clip
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
            if returned_all:
                # 전량 반환 성공 계약을 믿는 경우 Bin 전체 재스캔 결과는 판정에 안 쓰인다
                # (R5 bridge-1) — 기존 클립 C개의 GetClipProperty 왕복을 생략한다.
                # RefreshFolders(화면 갱신)는 유지. 부분·불명확 반환은 종전대로 재스캔.
                current_by_path = returned_by_path
                current_paths = returned_paths
            else:
                current_by_path = _clips_by_path(target)
                current_by_path.update(returned_by_path)
                current_paths = set(current_by_path)
        except Exception as exc:  # noqa: BLE001 - 확인 불가 항목은 재시도 후 개별 실패로 남긴다.
            current_by_path = {}
            current_paths = set()
            last_error = str(exc)

        next_remaining: list[tuple[dict[str, Any], Path, str]] = []
        for item, source, normalized in remaining:
            if returned_all or normalized in current_paths:
                item["status"] = "imported"
                result["imported"] += 1
                clip = current_by_path.get(normalized)
                if clip is not None:
                    metadata_changed = _stamp_mvhub_metadata(
                        clip,
                        str(item.get("generation_id") or ""),
                        project_id,
                    ) or metadata_changed
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
        # ★코드 없이 문구만 남기면 상위가 오류 문자열을 파싱해 상태를 판단하게 된다
        # (§C 금지). 재시도까지 하고도 Bin 에 나타나지 않은 항목은 이 코드로 확정한다.
        item["error_code"] = "media_import_failed"
        result["error_count"] += 1
    return metadata_changed


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
    media_pool: Any, root: Any, paths: set[tuple[str, ...]], guard: Any
) -> dict[tuple[str, ...], Any]:
    """paths 의 Bin 을 (없으면) 만든다. guard() 는 Bin 하나마다 — 긴 조회 뒤의 첫 쓰기 앞과 만드는 사이사이에서 프로젝트를 다시 본다."""
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
        guard()
        nodes[parts] = _subfolder(parent, _folder_name(parts[-1], "미분류"), media_pool)
    return nodes


def _delete_empty_children(media_pool: Any, parent: Any, guard: Any) -> None:
    delete_folders = getattr(media_pool, "DeleteFolders", None)
    if not callable(delete_folders):
        raise ResolveBridgeError("현재 Resolve가 빈 Bin 삭제를 지원하지 않습니다")
    for child in list(parent.GetSubFolderList() or []):
        _delete_empty_children(media_pool, child, guard)
        if (child.GetClipList() or []) or (child.GetSubFolderList() or []):
            raise ResolveBridgeError(f"비어 있지 않은 Bin은 정리하지 않습니다: {child.GetName()}")
        guard()  # 지우기 하나마다 — 바뀐 프로젝트에서 이어 지우지 않는다
        if not delete_folders([child]):
            raise ResolveBridgeError(f"빈 Bin을 정리하지 못했습니다: {child.GetName()}")
        _refresh_folders(media_pool)


def _export_rebuild_backup(
    manifest: dict[str, Any], project_manager: Any, project: Any, guard: Any
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
    guard()  # 다른 프로젝트가 열려 있으면 그것을 저장하지 않는다
    if not project_manager.SaveProject():
        raise ResolveBridgeError("Resolve 구조 변경 전 프로젝트를 저장하지 못했습니다")
    export_project = getattr(project_manager, "ExportProject", None)
    if not callable(export_project) or not export_project(
        project_name, str(backup_path), False
    ):
        raise ResolveBridgeError("Resolve 구조 변경 전 프로젝트 백업을 만들지 못했습니다")
    return str(backup_path)


# ── 빠른 Bin 정렬(MoveFolders) — 2026-10-16 Codex 설계 승인(v3) ─────────────────────────────────────────────
# 순서가 깨진 부모마다 '꼬리'(실제 자식 순서가 바라는 순서와 처음 어긋나는 자리부터 끝까지)만 임시 Bin 으로 빼고, 새 Bin 을 그 안에
#  만든 뒤, 바라는 순서로 한 번에 다시 넣는다. 아래 '클립을 옮겨 MV Hub 전체를 다시 짓기'는 형제 300 앞 삽입에 97~101초였다(실제
#  Resolve 21.1.1 시험 프로젝트). MoveFolders 두 번은 같은 시험에서 60개에 0.2·0.3초였다.
# 과거(08-12) MoveFolders 정렬이 '이동 결과 불일치'로 실패한 기록이 있다(원인·판 모름). 그래서 셋을 지킨다:
#  · 시험 프로젝트에서 실기기 시험을 통과한 판(GetVersion 전체 값)만 쓴다. 비어 있으면 꺼져 있다 — 시험 전에는 켜지 않는다.
#  · 이동 전 상태를 고유 ID 로 적어 둔다. 첫 쓰기보다 먼저 파일(복구 기록)로 남기고, 쓰기마다 새로 조회해 검증한다.
#  · 실패하면 되돌린다. 처음 상태로 돌아간 것이 확인될 때만 기존 다시 짓기로 넘어가고, 확인이 안 되면 그 자리에서 멈춘다
#    (가져오기·타임라인·저장을 더 하지 않는다 — _RebuildRecoveryNeeded).
# 21.1.1.10 — 2026-10-16 시험 프로젝트 실기기 시험 통과: 형제 302 앞 삽입 8.4초(지금 길 97~101초)·중간 삽입 8.9초, 손자 Bin·한글
#  이름·같은 파일의 다른 클립 둘·타임라인 둘(항목 12의 자리·길이·고유 ID)이 그대로, 저장 → 다시 열기 뒤에도 같음, 빈 Bin 은 [] 를 준다,
#  두 번째 이동을 거꾸로 넣는 강제 실패 → 처음 상태 확인 → 기존 다시 짓기 완료(클립·타임라인 그대로, 순서 맞음).
_MOVE_FOLDERS_TESTED: frozenset[tuple[str, ...]] = frozenset({("21", "1", "1", "10", "")})
_RECOVERY_SCHEMA = 1


class _RebuildRecoveryNeeded(ResolveBridgeError):
    """빠른 Bin 정렬이 처음 상태로 돌아갔다는 것을 확인하지 못했다 — 사람이 보고 복구해야 한다.

    code = rebuild_recovery_needed(이번 보내기에서 멈춤) · rebuild_recovery_pending(앞서 멈춘 기록이 이번 보내기를 막음).
    leftover = 결과에 싣는 임시 Bin·백업·기록 자리(_ProjectChanged 와 같은 방식)."""

    def __init__(self, message: str, *, code: str, leftover: dict[str, str]):
        super().__init__(message, code=code)
        self.leftover = leftover


class _Unknown(Exception):
    """Resolve 조회가 실패했거나 고유 ID 를 못 읽었다 — 빈 목록·없는 것으로 치지 않는다."""


class _MoveFailed(Exception):
    """빠른 정렬의 한 단계가 실패했거나 결과가 맞지 않았다 — 되돌리기로 간다."""


def _resolve_version_key(resolve: Any) -> tuple[str, ...] | None:
    get_version = getattr(resolve, "GetVersion", None)
    if not callable(get_version):
        return None
    try:
        value = get_version()
    except Exception:  # noqa: BLE001 - 판을 못 읽으면 빠른 길을 쓰지 않는다.
        return None
    if not isinstance(value, (list, tuple)) or len(value) < 4:
        return None
    return tuple(str(part) for part in value)


def _uid(item: Any) -> str:
    try:
        value = str(item.GetUniqueId() or "")
    except Exception as exc:  # noqa: BLE001
        raise _Unknown("Resolve 고유 ID 를 읽지 못했습니다") from exc
    if not value:
        raise _Unknown("Resolve 고유 ID 가 비어 있습니다")
    return value


def _strict_list(read: Any) -> list[Any]:
    # shortcut: 빈 Bin 에서 Resolve 가 [] 가 아니라 None 을 주면 빠른 길은 늘 자격 없음이 된다 — 실기기 시험 항목
    try:
        value = read()
    except Exception as exc:  # noqa: BLE001
        raise _Unknown("Resolve 조회가 실패했습니다") from exc
    if value is None:
        raise _Unknown("Resolve 조회가 빈 응답을 돌려줬습니다")
    return list(value)


def _name(item: Any) -> str:
    # 이름 읽기의 예외도 '모름'이다 — 일반 예외로 빠져나가면 부르는 쪽이 정렬 오류로 삼키고 가져오기를 이어 간다(Codex 재확인 P1)
    try:
        return str(item.GetName() or "")
    except Exception as exc:  # noqa: BLE001
        raise _Unknown("Resolve Bin 이름을 읽지 못했습니다") from exc


def _children_of(folder: Any) -> list[tuple[str, str, Any]]:
    """자식 Bin (고유 ID, 이름 identity, 객체) — 늘 새로 조회한다."""
    return [
        (_uid(child), _folder_identity(_name(child)), child)
        for child in _strict_list(folder.GetSubFolderList)
    ]


def _clip_counter(folder: Any) -> dict[str, int]:
    return dict(Counter(_uid(clip) for clip in _strict_list(folder.GetClipList)))


def _subtree(folder: Any) -> dict[str, Any]:
    """folder 와 그 아래 전체 — {"folders": {uid: [부모 uid, 이름]}, "clips": {uid: {클립 uid: 개수}}}. 맨 위의 부모는 ""
    라 어느 부모 아래에 있든 같은 값이다(옮기기 전·후 비교)."""
    folders: dict[str, list[str]] = {}
    clips: dict[str, dict[str, int]] = {}

    def visit(node: Any, parent_uid: str) -> None:
        uid = _uid(node)
        if uid in folders:
            raise _Unknown(f"같은 고유 ID 가 두 번 나왔습니다: {uid}")
        folders[uid] = [parent_uid, _name(node)]
        clips[uid] = _clip_counter(node)
        for child in _strict_list(node.GetSubFolderList):
            visit(child, uid)

    visit(folder, "")
    return {"folders": folders, "clips": clips}


def _restored(parent: Any, record: dict[str, Any]) -> bool:
    """처음 상태 — 부모·앞부분 자식 순서·직속 클립·꼬리 하위 트리가 옮기기 전과 같다. 순서 예외는 되돌린 꼬리끼리만."""
    prefix, tails = record["prefix"], record["tails"]
    if _uid(parent) != record["parent_uid"] or _clip_counter(parent) != record["parent_clips"]:
        return False
    children = _children_of(parent)
    uids = [uid for uid, _identity, _folder in children]
    if uids[: len(prefix)] != prefix or sorted(uids[len(prefix):]) != sorted(record["tail_order"]):
        return False
    return all(_subtree(folder) == tails[uid] for uid, _identity, folder in children[len(prefix):])


def _finished(parent: Any, record: dict[str, Any]) -> bool:
    """끝난 상태 — 자식 이름 순서가 바라는 순서이고, 앞부분·직속 클립·꼬리 하위 트리는 그대로, 새 Bin 은 비어 있다."""
    prefix, tails = record["prefix"], record["tails"]
    if _uid(parent) != record["parent_uid"] or _clip_counter(parent) != record["parent_clips"]:
        return False
    children = _children_of(parent)
    if [identity for _uid_, identity, _folder in children] != record["desired"]:
        return False
    if [uid for uid, _identity, _folder in children[: len(prefix)]] != prefix:
        return False
    seen = set()
    created = set(record.get("created") or [])
    for uid, _identity, folder in children[len(prefix):]:
        if uid in tails:
            if _subtree(folder) != tails[uid]:
                return False
            seen.add(uid)
        elif uid not in created or _strict_list(folder.GetSubFolderList) or _strict_list(folder.GetClipList):
            return False  # 이번에 만든(기록한) 빈 Bin 만 허용한다 — 사람이 넣은 Bin 이면 끝난 상태가 아니다
    return seen == set(tails)


def _root_as_before(root: Any, record: dict[str, Any]) -> bool:
    """루트 직속이 시작 때와 같다 — 임시 Bin(이름이 바뀐 사본 포함)이 남지 않았다."""
    return [uid for uid, _identity, _folder in _children_of(root)] == record["root_children"]


def _recovery_folder(manifest: dict[str, Any]) -> Path | None:
    raw = str(manifest.get("manifest_root") or "").strip()
    if not raw:
        return None
    manifest_root = Path(raw).resolve()
    folder = (manifest_root / ".mvhub" / "resolve-recovery").resolve()
    try:
        folder.relative_to(manifest_root)
    except ValueError as exc:
        raise ResolveBridgeError("Resolve 정렬 복구 기록 자리가 프로젝트 밖을 가리킵니다") from exc
    return folder


def _recovery_record_path(folder: Path, project_id: str, managed_identity: tuple[str, ...]) -> Path:
    # 원본 프로젝트 ID 와 관리 루트 identity(NFC·casefold — _folder_identity)의 해시. 본문에서도 둘을 대조한다.
    key = hashlib.sha256(f"{project_id}\0{'/'.join(managed_identity)}".encode("utf-8")).hexdigest()
    return folder / f"{key}.json"


def _write_recovery_record(path: Path, record: dict[str, Any]) -> None:
    """필수 기록 — _journal 과 달리 실패를 삼키지 않는다(임시 파일 → fsync → 바꿔 넣기)."""
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f"{path.name}.{uuid.uuid4().hex}.tmp")
    try:
        with open(temporary, "wb") as handle:
            handle.write(json.dumps(record, ensure_ascii=False, sort_keys=True).encode("utf-8"))
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    finally:
        if temporary.exists():
            try:
                temporary.unlink()
            except OSError:
                pass


def _check_recovery_record(record: Any, project_id: str, managed_identity: tuple[str, ...]) -> dict[str, Any]:
    if not isinstance(record, dict) or record.get("schema") != _RECOVERY_SCHEMA:
        raise ValueError("복구 기록 형식이 다릅니다")
    if record.get("project_id") != project_id or record.get("managed_identity") != list(managed_identity):
        raise ValueError("복구 기록의 프로젝트가 다릅니다")
    for key, kind in (
        ("parent_uid", str), ("staging", str), ("backup", str), ("prefix", list), ("tail_order", list),
        ("desired", list), ("parent_clips", dict), ("tails", dict), ("root_children", list),
    ):
        if not isinstance(record.get(key), kind):
            raise ValueError(f"복구 기록에 {key} 가 없습니다")
    return record


def _find_by_uid(folder: Any, uid: str) -> Any | None:
    if _uid(folder) == uid:
        return folder
    for child in _strict_list(folder.GetSubFolderList):
        found = _find_by_uid(child, uid)
        if found is not None:
            return found
    return None


def _settle_recovery_record(
    manifest: dict[str, Any], root: Any, project_id: str, managed_identity: tuple[str, ...]
) -> None:
    """앞서 빠른 Bin 정렬이 멈추며 남긴 기록 — **모든 보내기가 첫 Bin 을 만들기 전에** 본다. 지금 상태가 처음 상태(가) 또는
    끝난 상태(나)와 정확히 같으면 기록을 지우고 이어 간다. 그 밖에는(읽기·조회 실패, 주인 확인 불가 포함) 멈춘다."""
    raw = str(manifest.get("manifest_root") or "").strip()
    if not raw:
        return
    # 쓰는 쪽(_recovery_folder)과 같은 자리를 풀지 않은 경로로 본다 — 보통은 폴더가 없어 조회 한 번으로 끝난다. 그 자리가 프로젝트
    #  밖을 가리켜도(junction 등) 거기에 기록이 있으면 확인한다(Codex 구현 리뷰 P2).
    folder = Path(raw) / ".mvhub" / "resolve-recovery"
    try:
        names = {entry.name for entry in os.scandir(folder) if entry.name.endswith(".json")}
    except FileNotFoundError:
        return
    except OSError as exc:
        raise _RebuildRecoveryNeeded(
            f"Resolve Bin 정렬 복구 기록을 읽지 못했습니다: {exc}",
            code="rebuild_recovery_pending", leftover={"rebuild_recovery_record": str(folder)},
        ) from exc
    if not names:
        return
    if not project_id:
        raise _RebuildRecoveryNeeded(
            "Resolve 프로젝트 ID 를 읽지 못해 남은 Bin 정렬 복구 기록의 주인을 확인할 수 없습니다 — 기록을 확인하세요",
            code="rebuild_recovery_pending", leftover={"rebuild_recovery_record": str(folder)},
        )
    path = _recovery_record_path(folder, project_id, managed_identity)
    if path.name not in names:
        return
    leftover = {"rebuild_recovery_record": str(path)}
    try:
        record = _check_recovery_record(
            json.loads(path.read_text(encoding="utf-8")), project_id, managed_identity
        )
        leftover.update(folder_order_backup=record["backup"], rebuild_staging_bin=record["staging"])
        settled = False
        managed_root = root
        for name in managed_identity:
            managed_root = next(
                (child for _uid_, identity, child in _children_of(managed_root) if identity == name), None
            )
            if managed_root is None:
                break
        if managed_root is not None and _root_as_before(root, record):  # 바로 되돌릴 때와 같은 해제 조건(Codex 구현 리뷰 P1)
            parent = _find_by_uid(managed_root, record["parent_uid"])
            settled = parent is not None and (_restored(parent, record) or _finished(parent, record))
    except (OSError, ValueError, KeyError, TypeError, _Unknown) as exc:
        raise _RebuildRecoveryNeeded(
            f"Resolve Bin 정렬이 앞서 멈춘 기록을 확인하지 못했습니다: {exc}. 임시 Bin '{leftover.get('rebuild_staging_bin', '')}'"
            f" 과 백업({leftover.get('folder_order_backup', '')})을 보고 복구한 뒤 다시 보내세요",
            code="rebuild_recovery_pending", leftover=leftover,
        ) from exc
    if not settled:
        raise _RebuildRecoveryNeeded(
            f"Resolve Bin 정렬이 앞서 멈춘 채 남아 있습니다 — 임시 Bin '{record['staging']}' 의 Bin 을 원래 자리로 옮기거나"
            f" 백업({record['backup']})을 불러온 뒤 다시 보내세요(임시 Bin 이 비어 있으면 지우면 됩니다)",
            code="rebuild_recovery_pending", leftover=leftover,
        )
    try:
        path.unlink()
    except OSError as exc:
        raise _RebuildRecoveryNeeded(
            f"Resolve Bin 정렬 복구 기록을 지우지 못했습니다: {exc}", code="rebuild_recovery_pending", leftover=leftover
        ) from exc


def _restore_after_failed_move(
    media_pool: Any, root: Any, parent: Any, record: dict[str, Any], guard: Any
) -> None:
    """임시 Bin 안의 꼬리를 부모로 되돌리고, 이번에 만든(기록한) 빈 Bin 과 임시 Bin 을 지운 뒤 처음 상태인지 새로 조회해 확인한다.
    확인되지 않으면 _MoveFailed. 프로젝트가 바뀌면 _ProjectChanged 를 그대로 올린다(되돌리기를 이어 가지 않는다).
    지우는 것은 기록한 고유 ID 의 빈 Bin 뿐이다 — 사람이 넣은 Bin 은 비어 있어도 지우지 않고 멈춘다(Codex 구현 리뷰 P1)."""
    tails = record["tails"]
    created = set(record.get("created") or [])
    found = [child for uid, _identity, child in _children_of(root) if uid == record["staging_uid"]]
    if found:
        staging = found[0]
        back = [child for uid, _identity, child in _children_of(staging) if uid in tails]
        if back:
            guard()
            if not media_pool.MoveFolders(back, parent):
                raise _MoveFailed("Bin 을 원래 자리로 되돌리지 못했습니다")
        for uid, _identity, child in _children_of(staging):
            if uid not in created or _strict_list(child.GetSubFolderList) or _strict_list(child.GetClipList):
                raise _MoveFailed("정렬용 임시 Bin 에 이번에 만들지 않았거나 비어 있지 않은 Bin 이 남았습니다")
            guard()
            if not media_pool.DeleteFolders([child]):
                raise _MoveFailed("새로 만든 빈 Bin 을 지우지 못했습니다")
        if _strict_list(staging.GetClipList):
            raise _MoveFailed("정렬용 임시 Bin 에 클립이 있습니다")
        guard()
        if not media_pool.DeleteFolders([staging]):
            raise _MoveFailed("정렬용 임시 Bin 을 지우지 못했습니다")
        _refresh_folders(media_pool)
    # 두 번째 이동이 일부만 됐으면 이번에 만든 새 Bin 이 부모에 들어와 있다 — 그것만, 비어 있을 때만 지운다.
    keep = set(record["prefix"]) | set(tails)
    for uid, _identity, child in _children_of(parent):
        if uid in keep:
            continue
        if uid not in created or _strict_list(child.GetSubFolderList) or _strict_list(child.GetClipList):
            raise _MoveFailed("부모에 이번에 만들지 않았거나 비어 있지 않은 Bin 이 있습니다")
        guard()
        if not media_pool.DeleteFolders([child]):
            raise _MoveFailed("새로 만든 빈 Bin 을 지우지 못했습니다")
    _refresh_folders(media_pool)
    if not _root_as_before(root, record) or not _restored(parent, record):
        raise _MoveFailed("되돌린 결과가 처음 상태와 같지 않습니다")


def _sort_by_moving_bins(
    media_pool: Any,
    root: Any,
    managed_root: Any,
    parent_identity: tuple[str, ...],
    desired_rows: list[tuple[str, str]],
    record_path: Path,
    record_base: dict[str, Any],
    guard: Any,
) -> bool:
    """한 부모의 꼬리를 MoveFolders 로 다시 넣는다.
    True = 정렬·검증을 끝내고 기록을 지웠다. False = 고유 ID 를 못 읽어 이동 전에 손을 뗐거나, 실패했지만 처음 상태로 돌아간 것을
    확인하고 기록을 지웠다 — 부르는 쪽이 기존 다시 짓기로 간다. 그 밖에는 _RebuildRecoveryNeeded·_ProjectChanged(기록은 남는다)."""
    nodes, _children = _scan_actual_tree(managed_root)  # 앞 부모를 옮긴 뒤일 수 있다 — 새로 읽는다
    parent = nodes[parent_identity][1]
    desired_ids = [identity for identity, _name in desired_rows]
    try:
        parent_uid = _uid(parent)
        children = _children_of(parent)
        keep = 0
        while keep < len(children) and keep < len(desired_ids) and children[keep][1] == desired_ids[keep]:
            keep += 1
        tail = children[keep:]
        tails = {uid: _subtree(folder) for uid, _identity, folder in tail}
        every = [uid for tree in tails.values() for uid in tree["folders"]]
        clip_uses = Counter(_clip_counter(parent))
        for tree in tails.values():
            for counter in tree["clips"].values():
                clip_uses.update(counter)
        if (
            not tail or len(set(every)) != len(every) or parent_uid in every
            or any(count > 1 for count in clip_uses.values())  # 클립 고유 ID 가 겹치면 검증을 믿을 수 없다(Codex 구현 리뷰 P2)
        ):
            return False
        record = {
            **record_base,
            "parent_uid": parent_uid,
            "prefix": [uid for uid, _identity, _folder in children[:keep]],
            "tail_order": [uid for uid, _identity, _folder in tail],
            "tails": tails,
            "parent_clips": _clip_counter(parent),
            "desired": desired_ids,
            "root_children": [uid for uid, _identity, _folder in _children_of(root)],
            "staging": f"__MVHUB_SORT_{uuid.uuid4().hex}__",
            "staging_uid": "",
            "created": [],
            "stage": "planned",
        }
    except _Unknown:
        return False
    actual_ids = {identity for _uid_, identity, _folder in children}
    new_names = [name for identity, name in desired_rows if identity not in actual_ids]
    leftover = {
        "folder_order_backup": record["backup"],
        "rebuild_staging_bin": record["staging"],
        "rebuild_recovery_record": str(record_path),
    }

    def stage(name: str) -> None:
        # 필수 기록 — 갱신하지 못하면 되돌리지도, 기존 다시 짓기로 가지도 않고 멈춘다(설계 D)
        record["stage"] = name
        try:
            _write_recovery_record(record_path, record)
        except OSError as exc:
            raise _RebuildRecoveryNeeded(
                f"Resolve Bin 정렬 복구 기록을 남기지 못해 멈췄습니다({name}): {exc}. 임시 Bin '{record['staging']}'"
                f" · 백업: {record['backup']}",
                code="rebuild_recovery_needed", leftover=leftover,
            ) from exc

    def stop(message: str) -> _RebuildRecoveryNeeded:
        return _RebuildRecoveryNeeded(
            f"{message} — 가져오기를 멈췄습니다. 임시 Bin '{record['staging']}' · 백업: {record['backup']}",
            code="rebuild_recovery_needed", leftover=leftover,
        )

    stage("planned")  # 첫 쓰기(임시 Bin)보다 먼저
    # 1) 임시 Bin — 호출이 실패·예외·다른 이름이면 새로 조회해 부수효과를 본다. 아무것도 안 생겼으면 기록을 지우고 기존 다시 짓기로,
    #    무엇이든 생겼으면 멈춘다(설계 D — 생긴 것을 추측으로 지우지 않는다). 첫 guard 에서 멈추면 기록은 처음 상태라 다음 보내기가 푼다.
    guard()
    staging_identity = _folder_identity(record["staging"])
    try:
        made = media_pool.AddSubFolder(root, record["staging"])
        call_ok = bool(made) and _folder_identity(str(made.GetName() or "")) == staging_identity
    except Exception:  # noqa: BLE001 - 결과는 아래 새 조회로 판정한다.
        call_ok = False
    try:
        added = [row for row in _children_of(root) if row[0] not in record["root_children"]]
    except _Unknown as exc:
        raise stop(f"정렬용 임시 Bin 을 만든 뒤 Resolve 를 다시 읽지 못했습니다({exc})") from exc
    if not added and not call_ok:
        try:
            record_path.unlink()
        except OSError as exc:
            raise stop(f"복구 기록을 지우지 못했습니다({exc})") from exc
        return False
    if not call_ok or len(added) != 1 or added[0][1] != staging_identity:
        raise stop("정렬용 임시 Bin 을 만든 결과가 맞지 않습니다(루트의 새 Bin 을 확인하세요)")
    record["staging_uid"], _staging_identity, staging = added[0]
    stage("staging_created")
    try:
        guard()
        moved = media_pool.MoveFolders([folder for _uid_, _identity, folder in tail], staging)
        inside = [uid for uid, _identity, _folder in _children_of(staging)]
        left = [uid for uid, _identity, _folder in _children_of(parent)]
        if not moved or left != record["prefix"] or sorted(inside) != sorted(record["tail_order"]):
            raise _MoveFailed("Bin 을 정렬용 공간으로 옮긴 결과가 맞지 않습니다")
        stage("moved_out")

        for name in new_names:
            guard()
            created = media_pool.AddSubFolder(staging, name)
            if not created:
                raise _MoveFailed(f"새 Bin 을 만들지 못했습니다: {name}")
            record["created"].append(_uid(created))
            stage("moved_out")  # 만든 Bin 은 바로 적는다 — 되돌릴 때 이것만 지운다
            if _folder_identity(str(created.GetName() or "")) != _folder_identity(name):
                raise _MoveFailed(f"새 Bin 이 다른 이름으로 만들어졌습니다: {created.GetName()}")
        by_identity = {identity: folder for _uid_, identity, folder in _children_of(staging)}
        if set(by_identity) != set(desired_ids[keep:]):
            raise _MoveFailed("정렬용 공간의 Bin 이 바라는 목록과 다릅니다")

        guard()
        moved = media_pool.MoveFolders([by_identity[identity] for identity in desired_ids[keep:]], parent)
        if not moved or not _finished(parent, record) or _children_of(staging) or _strict_list(staging.GetClipList):
            raise _MoveFailed("Bin 을 바라는 순서로 다시 넣은 결과가 맞지 않습니다")
        stage("moved_back")

        guard()
        if not media_pool.DeleteFolders([staging]):
            raise _MoveFailed("Resolve 정렬용 임시 Bin 을 정리하지 못했습니다")
        _refresh_folders(media_pool)
        if not _root_as_before(root, record):
            raise _MoveFailed("Resolve 정렬용 임시 Bin 이 남았습니다")
    except _RebuildRecoveryNeeded:
        raise  # 기록 갱신 실패 — 되돌리지 않고 멈춘다
    except _ProjectChanged as changed:
        raise _ProjectChanged(
            changed.fact,
            f"Bin 순서를 맞추던 중이었습니다 — 시작한 프로젝트를 다시 열고, 다시 보내기 **전에** 임시 Bin '{record['staging']}' 의"
            f" Bin 을 원래 자리로 옮기거나 백업을 불러오세요. 백업: {record['backup']}",
            leftover,
        ) from changed
    except Exception as failure:  # noqa: BLE001 - 어느 단계의 실패든 되돌리기와 그 확인으로 간다.
        try:
            _restore_after_failed_move(media_pool, root, parent, record, guard)
            record_path.unlink()
        except _ProjectChanged as changed:
            raise _ProjectChanged(
                changed.fact,
                f"Bin 순서를 맞추다 되돌리던 중이었습니다 — 시작한 프로젝트를 다시 열고, 다시 보내기 **전에** 임시 Bin"
                f" '{record['staging']}' 의 Bin 을 원래 자리로 옮기거나 백업을 불러오세요. 백업: {record['backup']}",
                leftover,
            ) from failure
        except Exception as recovery:  # noqa: BLE001 - 원래 실패와 되돌리기 실패를 함께 보고한다.
            raise _RebuildRecoveryNeeded(
                f"Resolve Bin 정렬이 실패했고({failure}) 처음 상태로 되돌린 것을 확인하지 못했습니다({recovery}). 가져오기를"
                f" 멈췄습니다 — 임시 Bin '{record['staging']}' 의 Bin 을 원래 자리로 옮기거나 백업({record['backup']})을 불러오세요",
                code="rebuild_recovery_needed", leftover=leftover,
            ) from failure
        return False
    try:
        record_path.unlink()
    except OSError as exc:
        raise _RebuildRecoveryNeeded(
            f"Resolve Bin 정렬은 끝났지만 복구 기록을 지우지 못했습니다: {exc}",
            code="rebuild_recovery_needed", leftover=leftover,
        ) from exc
    return True


def _reconcile_folder_tree_visible(
    manifest: dict[str, Any],
    project_manager: Any,
    project: Any,
    media_pool: Any,
    root: Any,
    managed_root: Any,
    desired_paths: set[tuple[str, ...]],
    guard: Any,
    *,
    resolve: Any = None,
    project_label: str = "",
) -> tuple[bool, str]:
    """클립을 보존하며 MV Hub Bin을 카탈로그 순서로 맞춘다 — 시험을 통과한 판이면 먼저 빠른 길(위 MoveFolders), 아니면 아래 다시 짓기.
    guard() = 지금 열린 프로젝트가 시작한 그 프로젝트가 아니면 예외(_assert_still_current) — 저장 직전과, Bin 만들기·클립
    옮기기·Bin 지우기 **하나마다** 부른다(Codex 재검토 2026-10-13: 묶음 경계만 보면 그 사이의 여러 쓰기가 바뀐 프로젝트로 간다).
    다시 짓는 도중에 바뀌면 되돌리지도 저장하지도 않고, 남은 임시 Bin·백업을 담은 _ProjectChanged 로 끝낸다."""
    actual_nodes, actual_children = _scan_actual_tree(managed_root)
    requested_paths = set(desired_paths)
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
        # 없는 경로만 만든다 — 있는 Bin 까지 모두 다시 찾으면(형제마다 이름 비교 + 프로젝트 확인) 형제 수의 제곱으로 늘어
        # 형제 300 이면 클립 1개 보내기가 9.5초였다(실제 Resolve 21.1.1 시험 프로젝트, 그중 이 단계 8.8~9.0초).
        # 요청 경로만 본다 — 실제 Bin 이름은 생성 이름 정리를 거치지 않았을 수 있어 정리하면 다른 키가 된다(Codex 설계 검토).
        missing = {
            path for path in requested_paths
            if _path_identity(tuple(_folder_name(part, "미분류") for part in path if part)) not in actual_nodes
        }
        if missing:
            _create_tree(media_pool, managed_root, missing, guard)
        return len(desired_nodes) > before_count, ""

    move_clips = getattr(media_pool, "MoveClips", None)
    if not callable(move_clips):
        raise ResolveBridgeError("현재 Resolve가 클립을 보존한 Bin 재정렬을 지원하지 않습니다")
    project_id = _project_identity(project)[0]
    fast = (
        bool(project_id and project_label)
        and callable(getattr(media_pool, "MoveFolders", None))
        and _resolve_version_key(resolve) in _MOVE_FOLDERS_TESTED
    )
    _journal("rebuild_backup_started", side_effects_started=True)
    backup_path = _export_rebuild_backup(manifest, project_manager, project, guard)
    _journal("rebuild_backup_complete", drp_path=backup_path)
    guard()  # 백업을 내보내는 동안(프로젝트가 크면 길다) 바뀌었으면 옮기기를 시작하지 않는다
    if fast:
        managed_identity = _path_identity((MEDIA_POOL_ROOT, project_label))
        recovery_folder = _recovery_folder(manifest)
        if recovery_folder is None:  # 백업이 manifest_root 를 요구하므로 여기 오지 않는다
            raise ResolveBridgeError("Resolve 정렬 복구 기록 자리가 없습니다")
        record_path = _recovery_record_path(recovery_folder, project_id, managed_identity)
        record_base = {
            "schema": _RECOVERY_SCHEMA,
            "project_id": project_id,
            "managed_identity": list(managed_identity),
            "backup": backup_path,
            "created": datetime.now(timezone.utc).isoformat(),
        }
        broken = sorted(
            (
                parent_id
                for parent_id, desired_rows in desired_children.items()
                if (actual_rows := actual_children.get(parent_id))
                and [row[0] for row in actual_rows] != [row[0] for row in desired_rows][: len(actual_rows)]
            ),
            # 얕은 층부터(깊은 부모는 이름이 그대로라 다시 읽으면 찾는다), 같은 층은 이름순 — 실행마다 같은 순서(집합 순서는 해시 무작위)
            key=lambda parent_id: (len(parent_id), _folder_path_sort_key(parent_id)),
        )
        if all(
            _sort_by_moving_bins(
                media_pool, root, managed_root, parent_id, desired_children[parent_id],
                record_path, record_base, guard,
            )
            for parent_id in broken
        ):
            nodes, _children = _scan_actual_tree(managed_root)
            missing = {
                path for path in desired_paths
                if _path_identity(tuple(_folder_name(part, "미분류") for part in path if part)) not in nodes
            }
            if missing:  # 더 깊은 층의 없는 경로 — 새 Bin 아래라 끝에 붙어 순서가 맞다
                _create_tree(media_pool, managed_root, missing, guard)
            _nodes, final_children = _scan_actual_tree(managed_root)
            for parent_id, desired_rows in desired_children.items():
                if [row[0] for row in final_children.get(parent_id, [])] != [row[0] for row in desired_rows]:
                    raise ResolveBridgeError("Resolve 화면의 최종 Bin 순서가 일치하지 않습니다")
            return True, backup_path
        # 처음 상태로 되돌린 것을 확인했다 — 옛 객체 지도는 버리고 다시 읽어 아래 다시 짓기로 간다(백업은 이미 있다).
        actual_nodes, actual_children = _scan_actual_tree(managed_root)
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
    # ★staging Bin 이름을 '만든 직후·클립을 옮기기 전에' 기록한다. 여기서 죽으면 고아 Bin 이
    # 남는데, 이름이 journal 에 없으면 복구기가 무엇을 격리해야 할지 알 수 없다(§3.1).
    _journal("rebuild_staging_created", staging_bin=staging_name, side_effects_started=True)
    staged_nodes: dict[tuple[str, ...], Any] = {(): staging}
    try:
        _journal("rebuild_to_staging", staging_bin=staging_name)
        staged_nodes = _create_tree(media_pool, staging, set(snapshots), guard)
        for path, (clips, _identities) in snapshots.items():
            if clips:
                guard()
            if clips and not move_clips(clips, staged_nodes[path]):
                raise ResolveBridgeError(f"클립을 정렬용 공간으로 옮기지 못했습니다: {'/'.join(path)}")
        for identity, (_path, folder) in actual_nodes.items():
            if identity and (folder.GetClipList() or []):
                raise ResolveBridgeError(f"기존 Bin에 클립이 남아 있습니다: {folder.GetName()}")

        _journal("rebuild_to_final", staging_bin=staging_name)
        _delete_empty_children(media_pool, managed_root, guard)
        final_nodes = _create_tree(media_pool, managed_root, desired_paths, guard)
        for path, (_clips, expected) in snapshots.items():
            staged_clips = list(staged_nodes[path].GetClipList() or [])
            if staged_clips:
                guard()
            if staged_clips and not move_clips(staged_clips, final_nodes[path]):
                raise ResolveBridgeError(f"클립을 정렬된 Bin으로 되돌리지 못했습니다: {'/'.join(path)}")
            actual = Counter(map(_clip_identity, final_nodes[path].GetClipList() or []))
            if actual != expected:
                raise ResolveBridgeError(f"정렬 후 클립 검증이 일치하지 않습니다: {'/'.join(path)}")

        _journal("rebuild_verified", staging_bin=staging_name)
        _delete_empty_children(media_pool, staging, guard)
        guard()
        if not media_pool.DeleteFolders([staging]):
            raise ResolveBridgeError("Resolve 정렬용 임시 Bin을 정리하지 못했습니다")
        _refresh_folders(media_pool)
        # 임시 Bin 이 사라졌으므로 고아 Bin 격리 대상이 아니다 — 이름을 지운다.
        _journal("rebuild_staging_deleted", staging_bin="")

        _actual_nodes, final_children = _scan_actual_tree(managed_root)
        for parent_id, desired_rows in desired_children.items():
            if [row[0] for row in final_children.get(parent_id, [])] != [
                row[0] for row in desired_rows
            ]:
                raise ResolveBridgeError("Resolve 화면의 최종 Bin 순서가 일치하지 않습니다")
        return True, backup_path
    except Exception as exc:
        recovery_errors: list[str] = []
        changed = exc if isinstance(exc, _ProjectChanged) else None
        try:
            # 되돌리기의 쓰기(Bin 만들기·클립 옮기기·지우기·저장)도 하나마다 프로젝트를 본다 — 바뀌었으면 첫 쓰기 앞에서 손을 뗀다
            #  (지금 열린 것은 다른 프로젝트다).
            remaining: dict[tuple[str, ...], list[Any]] = {}
            if staging:
                staged_actual, _children = _scan_actual_tree(staging)
                for _identity, (path, folder) in staged_actual.items():
                    if path and (clips := list(folder.GetClipList() or [])):
                        remaining[path] = clips
            if remaining:
                recovery_nodes = _create_tree(media_pool, managed_root, set(remaining), guard)
                for path, clips in remaining.items():
                    guard()
                    if clips and not move_clips(clips, recovery_nodes[path]):
                        recovery_errors.append(f"클립 복구 실패: {'/'.join(path)}")
            if staging and not recovery_errors:
                _delete_empty_children(media_pool, staging, guard)
                guard()
                if not media_pool.DeleteFolders([staging]):
                    recovery_errors.append("임시 Bin 정리 실패")
                else:
                    # 자동 복구가 임시 Bin 을 치웠다 — 고아 Bin 격리 대상에서 뺀다.
                    _journal("rebuild_staging_deleted", staging_bin="")
            guard()
            project_manager.SaveProject()
        except _ProjectChanged as gone:  # 되돌리기 전이나 되돌리는 사이에 바뀌었다 — 여기서 손을 뗀다
            changed = gone
        except Exception as recovery_exc:  # noqa: BLE001 - 복구 결과를 원인과 함께 보고한다.
            recovery_errors.append(str(recovery_exc))
        if changed is not None:
            # 다시 짓다 멈췄다 — 시작한 프로젝트에 임시 Bin 이 남았을 수 있다. 이 사실과 백업 자리를 버리지 않는다: 부르는 쪽이
            #  정렬 실패로 삼켜 '다시 가져오기'만 안내하면, 다시 가져오기는 MV Hub Bin 만 보므로 임시 Bin 의 클립을 못 되살린다
            #  (Codex 재검토 2026-10-13 P1).
            first = "" if exc is changed else f" 처음 실패: {exc}."
            raise _ProjectChanged(
                changed.fact,
                f"Bin 순서를 다시 짓던 중이었습니다.{first} 시작한 프로젝트에는 기존 클립 일부가 임시 Bin '{staging_name}' 에 "
                "남아 있을 수 있습니다 — 다시 가져오기 **전에** 그 프로젝트를 열어 그 클립을 원래 Bin 으로 옮기거나 "
                f"백업을 불러오세요. 백업: {backup_path}",
                {"folder_order_backup": backup_path, "rebuild_staging_bin": staging_name},
            ) from exc
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
    guard: Any,
    *,
    resolve: Any = None,
    project_label: str = "",
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
        guard,
        resolve=resolve,
        project_label=project_label,
    )


def _import_manifest_locked(manifest: dict[str, Any], resolve: Any) -> dict[str, Any]:
    project_manager = resolve.GetProjectManager()
    project = project_manager.GetCurrentProject() if project_manager else None
    if not project:
        raise ResolveBridgeError(
            "현재 열려 있는 Resolve 프로젝트가 없습니다", code="no_project"
        )
    _assert_expected_project(manifest, project)
    _current_id, _current_name = _project_identity(project)

    def guard() -> None:
        _assert_still_current(project_manager, (_current_id, _current_name))

    _journal(
        "project_verified",
        resolve_project={
            "expected_id": str((manifest.get("resolve_target") or {}).get("project_id") or ""),
            "current_id": _current_id,
            "current_name": _current_name,
        },
    )
    media_pool = project.GetMediaPool()
    root = media_pool.GetRootFolder() if media_pool else None
    if not media_pool or not root:
        raise ResolveBridgeError(
            "현재 Resolve 프로젝트의 Media Pool을 열 수 없습니다", code="api_unavailable"
        )

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
        # 상태 판단은 문자열 메시지가 아니라 이 코드로만 한다(명세 §C).
        "error_code": None,
        "ordering_error_codes": [],
        "folder_order_backup": "",
        "items": [],
    }

    try:
        # 앞서 빠른 Bin 정렬이 멈추며 남긴 기록 — 첫 Bin 을 만들기 전에, 정렬이 필요 없는 보내기도 본다(남았으면 여기서 멈춘다).
        _settle_recovery_record(manifest, root, _current_id, _path_identity((MEDIA_POOL_ROOT, project_label)))
        # 첫 AddSubFolder 보다 먼저 기록한다(§부속 A) — 여기서부터 Resolve 에 부수효과가
        # 생길 수 있으므로, 이후 사망분은 자동 재실행이 아니라 복구 절차 대상이다.
        _journal("mutation_started", side_effects_started=True)
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
                # stat 1회로 파일 여부·크기를 함께 판정(R5 bridge-2). is_file 과 같은
                # symlink 추종 의미(Path.stat 기본), OSError 는 종전처럼 건너뜀.
                stat_result = source.stat()
                if not stat_module.S_ISREG(stat_result.st_mode) or stat_result.st_size <= 0:
                    continue
            except OSError:
                continue
            folder_paths.add(
                tuple(_folder_parts(str(source_item.get("folder_path") or "")))
            )

        ordering_errors: list[str] = []
        ordering_error_codes: list[str] = []
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
                guard,
                resolve=resolve,
                project_label=project_label,
            )
            result["folder_order_backup"] = backup_path
        except (_ProjectChanged, _RebuildRecoveryNeeded):
            # 정렬 실패로 삼키지 않는다 — 통째로 멈춘다(import_manifest_to_current_project 가 code 와 남은 것을 돌려준다).
            #  다시 짓다 멈춘 것이면 남은 임시 Bin·백업이 그 글에 있다: 삼키고 뒤의 확인이 새 글을 내면 그것이 사라진다.
            raise
        except Exception as exc:  # noqa: BLE001 - 가져오기는 유지하고 정렬 실패를 보고한다.
            ordering_errors.append(str(exc))
            ordering_error_codes.append(getattr(exc, "code", None) or "unexpected_error")

        prepared_targets = {(): managed_root}
        folder_errors: dict[tuple[str, ...], str] = {}
        for parts_key in sorted(folder_paths, key=_folder_path_sort_key):
            guard()  # 아래 try 는 그 경로의 항목만 실패시키고 이어 간다 — 프로젝트 확인은 그 밖에서(Bin 을 만드는 일이다)
            try:
                prepared_targets[parts_key] = _destination_folder(
                    media_pool, managed_root, list(parts_key)
                )
            except Exception as exc:  # noqa: BLE001 - 해당 경로 항목만 실패 처리한다.
                folder_errors[parts_key] = str(exc)

        metadata_changed = False
        import_batches: dict[
            tuple[str, ...], list[tuple[dict[str, Any], Path, str]]
        ] = {}
        existing_clips_by_folder: dict[tuple[str, ...], dict[str, Any]] = {}
        queued_paths_by_folder: dict[tuple[str, ...], set[str]] = {}
        for source_item in source_items:
            item = {
                "generation_id": str(source_item.get("generation_id") or ""),
                "local_path": str(source_item.get("local_path") or ""),
                "media_pool_path": "",
                "status": "pending",
                "error": None,
                "error_code": None,
            }
            result["items"].append(item)
            result["total"] += 1
            try:
                source = Path(item["local_path"])
                try:
                    stat_result = source.stat()  # stat 1회(R5 bridge-2) — 2단계 재검증 자체는 유지
                except OSError:
                    stat_result = None
                if (
                    stat_result is None
                    or not stat_module.S_ISREG(stat_result.st_mode)
                    or stat_result.st_size <= 0
                ):
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
                if parts_key not in existing_clips_by_folder:
                    existing_clips_by_folder[parts_key] = _clips_by_path(target)
                existing_clip = existing_clips_by_folder[parts_key].get(normalized)
                if existing_clip is not None:
                    item["status"] = "skipped"
                    result["skipped"] += 1
                    metadata_changed = _stamp_mvhub_metadata(
                        existing_clip,
                        item["generation_id"],
                        str(manifest.get("project_id") or ""),
                    ) or metadata_changed
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
                item["error_code"] = getattr(exc, "code", None) or "unexpected_error"
                result["error_count"] += 1

        batch_index = 0
        for parts_key in sorted(import_batches, key=_folder_path_sort_key):
            entries = import_batches[parts_key]
            for start in range(0, len(entries), _MEDIA_IMPORT_BATCH_SIZE):
                batch = entries[start : start + _MEDIA_IMPORT_BATCH_SIZE]
                batch_index += 1
                guard()  # 묶음마다 — 바뀐 프로젝트에 이어서 가져오지 않는다
                # 호출 직전 calling, 경로 검증 뒤 verified (§부속 A batch 규칙).
                batch_journal = {
                    "index": batch_index,
                    "folder_path": "/".join(parts_key),
                    "item_ids": [str(item.get("generation_id") or "") for item, _s, _n in batch],
                    "state": "calling",
                }
                _journal(
                    "import_batch_calling",
                    last_batch=batch_journal,
                    side_effects_started=True,
                )
                metadata_changed = _import_media_batch(
                    media_pool,
                    prepared_targets[parts_key],
                    batch,
                    result,
                    str(manifest.get("project_id") or ""),
                ) or metadata_changed
                _journal(
                    "import_batch_verified",
                    last_batch={**batch_journal, "state": "verified"},
                )

        success_count = result["imported"] + result["skipped"]
        if not result["total"]:
            result["status"] = "failed"
            result["error"] = "Resolve로 가져올 준비가 끝난 원본이 없습니다"
            result["error_code"] = "source_missing"
        elif not result["error_count"]:
            result["status"] = "complete"
        elif success_count:
            result["status"] = "partial"
        else:
            result["status"] = "failed"
        if result["error_count"] and not result["error_code"]:
            result["error_code"] = next(
                (
                    str(item["error_code"])
                    for item in result["items"]
                    if item.get("error_code")
                ),
                "unexpected_error",
            )

        if ordering_errors:
            result["status"] = "partial" if success_count else "failed"
            result["error"] = "Resolve 폴더 카탈로그 적용 실패: " + "; ".join(
                ordering_errors
            )
            result["ordering_error_codes"] = ordering_error_codes
            result["error_code"] = result["error_code"] or (
                ordering_error_codes[0] if ordering_error_codes else "unexpected_error"
            )

        actual_project_change = bool(result["imported"] or reordered)
        if actual_project_change or metadata_changed:
            guard()  # SaveProject 는 지금 열린 프로젝트를 저장한다 — 시작한 그 프로젝트일 때만
            _journal("saving_project")
        if actual_project_change or metadata_changed:
            save_ok = project_manager.SaveProject()
            if not save_ok and actual_project_change:
                result["status"] = "partial" if success_count else "failed"
                save_error = "Resolve 프로젝트 저장을 확인하지 못했습니다"
                result["error"] = (
                    f"{result['error']}; {save_error}" if result["error"] else save_error
                )
                result["error_code"] = result["error_code"] or "api_unavailable"
            elif not save_ok:
                # 과거 클립의 보조 ID 백필 실패가 원본 반입 성공을 실패로 바꾸면 안 된다.
                result.setdefault("warnings", []).append(
                    "Resolve 프로젝트 저장 확인 실패(선택 연결 메타데이터)"
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


def _unavailable_import(message: str, code: str) -> dict[str, Any]:
    return {
        "status": "unavailable",
        "error_code": code,
        "project_name": "",
        "target_root": "",
        "total": 0,
        "imported": 0,
        "skipped": 0,
        "error_count": 0,
        "error": message,
        "items": [],
    }


def import_manifest_to_current_project(
    manifest: dict[str, Any], *, resolve: Any | None = None
) -> dict[str, Any]:
    """manifest 원본을 현재 Resolve 프로젝트에 폴더 구조대로 가져온다."""
    try:
        with _IMPORT_LOCK:
            _journal("connecting")
            return _import_manifest_locked(manifest, resolve or _connect_resolve())
    except ResolveBridgeError as exc:
        # ★ 먼저 잡아 code 를 보존한다(명세 §C). 종전엔 아래 일반 catch 가 삼켜
        # project_changed 같은 판정 근거가 API 까지 전달되지 않았다.
        # Bin 순서를 다시 짓다 멈춘 것이면 남은 임시 Bin·백업 자리도 결과에 싣는다(글에도 있다 — 복구가 먼저인 상태).
        return {**_unavailable_import(str(exc), exc.code), **getattr(exc, "leftover", {})}
    except Exception as exc:  # noqa: BLE001 - Resolve 외부 API 오류가 HTTP 500으로 번지지 않게 한다.
        return _unavailable_import(str(exc), "unexpected_error")

"""DaVinci Resolve Scripts 메뉴에 MV Hub Clip Exporter를 설치한다.

Resolve 버전과 실행 계정 차이를 피하려고 Windows 공식 스크립트 검색 경로인
모든 사용자 공용 경로를 우선 사용하고, 쓰기 권한이 없을 때만 현재 사용자
경로로 폴백한다.
"""

from __future__ import annotations

import os
import re
import uuid
from pathlib import Path
from typing import Any


SCRIPT_FILE_NAME = "MVHub Clip Exporter.py"
IMPORTER_FILE_NAME = "MVHub Importer.py"
USER_SCRIPT_RELATIVE_DIR = Path(
    "Blackmagic Design",
    "DaVinci Resolve",
    "Support",
    "Fusion",
    "Scripts",
    "Utility",
    "MV Hub",
)
ALL_USERS_SCRIPT_RELATIVE_DIR = Path(
    "Blackmagic Design",
    "DaVinci Resolve",
    "Fusion",
    "Scripts",
    "Utility",
    "MV Hub",
)
_VERSION_PATTERN = re.compile(
    r'^PLUGIN_VERSION\s*=\s*["\']([^"\']+)["\']', re.MULTILINE
)
_MANAGED_MARKERS = {
    SCRIPT_FILE_NAME: b"com.millionvolt.mvhub.clip-exporter",
    IMPORTER_FILE_NAME: b"com.millionvolt.mvhub.importer-result",
}


class ResolveScriptInstallError(RuntimeError):
    """사용자에게 표시할 수 있는 Resolve 스크립트 설치 오류."""


def bundled_script_path() -> Path:
    return Path(__file__).resolve().parents[1] / "resources" / "resolve" / "MVHub_Clip_Exporter.py"


def bundled_importer_script_path() -> Path:
    return Path(__file__).resolve().parents[1] / "resources" / "resolve" / "MVHub_Importer.py"


def _appdata_root(appdata: str | Path | None = None) -> Path:
    raw = str(appdata or os.environ.get("APPDATA") or "").strip()
    if not raw and os.name == "nt":
        raw = str(Path.home() / "AppData" / "Roaming")
    if not raw:
        raise ResolveScriptInstallError("Windows 사용자 AppData 폴더를 찾을 수 없습니다")
    return Path(raw).expanduser().resolve()


def _programdata_root(programdata: str | Path | None = None) -> Path:
    raw = str(programdata or os.environ.get("PROGRAMDATA") or "").strip()
    if not raw and os.name == "nt":
        raw = r"C:\ProgramData"
    if not raw:
        raise ResolveScriptInstallError("Windows 공용 ProgramData 폴더를 찾을 수 없습니다")
    return Path(raw).expanduser().resolve()


def resolve_script_target(appdata: str | Path | None = None) -> Path:
    """현재 사용자 전용 공식 설치 경로(기존 호출 호환)."""
    return _appdata_root(appdata) / USER_SCRIPT_RELATIVE_DIR / SCRIPT_FILE_NAME


def resolve_all_users_script_target(programdata: str | Path | None = None) -> Path:
    """Resolve 버전·Windows 계정에 관계없이 검색되는 공용 공식 경로."""
    return _programdata_root(programdata) / ALL_USERS_SCRIPT_RELATIVE_DIR / SCRIPT_FILE_NAME


def resolve_importer_target(exporter_target: Path) -> Path:
    return exporter_target.with_name(IMPORTER_FILE_NAME)


def resolve_script_targets(
    *,
    appdata: str | Path | None = None,
    programdata: str | Path | None = None,
) -> list[tuple[str, Path]]:
    """설치 후보를 반환한다.

    테스트나 기존 코드가 ``appdata``만 넘기면 예전처럼 사용자 경로 하나만
    다룬다. 실제 앱 호출은 공용 경로와 사용자 경로를 모두 검사한다.
    """
    user = ("current_user", resolve_script_target(appdata))
    if appdata is not None and programdata is None:
        return [user]
    return [
        ("all_users", resolve_all_users_script_target(programdata)),
        user,
    ]


def _read_script(path: Path, label: str) -> bytes:
    try:
        content = path.read_bytes()
    except OSError as exc:
        raise ResolveScriptInstallError(f"{label}을 읽을 수 없습니다: {path}") from exc
    if not content:
        raise ResolveScriptInstallError(f"{label}이 비어 있습니다: {path}")
    return content


def _script_version(content: bytes | None) -> str | None:
    if not content:
        return None
    try:
        text = content.decode("utf-8-sig")
    except UnicodeDecodeError:
        return None
    match = _VERSION_PATTERN.search(text)
    return match.group(1).strip() if match else None


def _target_state(
    scope: str,
    path: Path,
    source_content: bytes,
    importer_content: bytes,
) -> dict[str, Any]:
    try:
        content = _read_script(path, "설치된 Resolve 스크립트") if path.is_file() else None
        importer_path = resolve_importer_target(path)
        installed_importer = (
            _read_script(importer_path, "설치된 Resolve Importer")
            if importer_path.is_file()
            else None
        )
        error = None
    except ResolveScriptInstallError as exc:
        content = None
        installed_importer = None
        error = str(exc)
    return {
        "scope": scope,
        "path": str(path),
        "importer_path": str(resolve_importer_target(path)),
        "installed": content is not None or installed_importer is not None,
        "up_to_date": content == source_content and installed_importer == importer_content,
        "installed_version": _script_version(content),
        "importer_installed": installed_importer is not None,
        "importer_version": _script_version(installed_importer),
        "error": error,
    }


def _status_result(
    source_content: bytes,
    importer_content: bytes,
    targets: list[tuple[str, Path]],
) -> dict[str, Any]:
    states = [
        _target_state(scope, path, source_content, importer_content)
        for scope, path in targets
    ]
    installed = [state for state in states if state["installed"]]
    current = [state for state in installed if state["up_to_date"]]
    primary = current[0] if current else (installed[0] if installed else states[0])
    return {
        "installed": bool(installed),
        "up_to_date": bool(current),
        "bundled_version": _script_version(source_content),
        "importer_bundled_version": _script_version(importer_content),
        "installed_version": primary["installed_version"],
        # 구버전 프론트도 실제 사용 중인 경로를 표시하도록 path를 유지한다.
        "path": primary["path"],
        "paths": [state["path"] for state in states],
        "installed_paths": [state["path"] for state in installed],
        "all_users_installed": any(
            state["scope"] == "all_users" and state["up_to_date"] for state in states
        ),
        "warnings": [state["error"] for state in states if state["error"]],
        "installations": states,
    }


def resolve_script_status(
    *,
    appdata: str | Path | None = None,
    programdata: str | Path | None = None,
    source_path: str | Path | None = None,
) -> dict[str, Any]:
    source = Path(source_path) if source_path is not None else bundled_script_path()
    source_content = _read_script(source, "내장 Resolve 스크립트")
    importer_content = _read_script(
        bundled_importer_script_path(), "내장 Resolve Importer"
    )
    targets = resolve_script_targets(appdata=appdata, programdata=programdata)
    return _status_result(source_content, importer_content, targets)


def _atomic_install(
    target: Path,
    source_content: bytes,
    importer_content: bytes,
) -> tuple[bool, str | None]:
    current = _read_script(target, "설치된 Resolve 스크립트") if target.is_file() else None
    importer_target = resolve_importer_target(target)
    current_importer = (
        _read_script(importer_target, "설치된 Resolve Importer")
        if importer_target.is_file()
        else None
    )
    if current == source_content and current_importer == importer_content:
        return False, _script_version(current)
    previous_version = _script_version(current)
    payloads = [(target, source_content), (importer_target, importer_content)]
    originals = {
        destination: destination.read_bytes() if destination.is_file() else None
        for destination, _content in payloads
    }
    temporaries: list[tuple[Path, Path]] = []
    replaced: list[Path] = []
    try:
        target.parent.mkdir(parents=True, exist_ok=True)
        for destination, content in payloads:
            temporary = destination.with_name(
                f".{destination.name}.{uuid.uuid4().hex}.tmp"
            )
            temporary.write_bytes(content)
            temporaries.append((temporary, destination))
        for temporary, destination in temporaries:
            os.replace(temporary, destination)
            replaced.append(destination)
    except OSError as exc:
        rollback_errors: list[str] = []
        for destination in reversed(replaced):
            original = originals[destination]
            try:
                if original is None:
                    destination.unlink(missing_ok=True)
                    continue
                restore = destination.with_name(
                    f".{destination.name}.{uuid.uuid4().hex}.restore.tmp"
                )
                try:
                    restore.write_bytes(original)
                    os.replace(restore, destination)
                finally:
                    restore.unlink(missing_ok=True)
            except OSError as rollback_exc:
                rollback_errors.append(str(rollback_exc))
        detail = (
            f" (되돌리기 실패: {'; '.join(rollback_errors)})"
            if rollback_errors
            else ""
        )
        raise ResolveScriptInstallError(
            f"Resolve 도구 두 파일을 함께 설치하지 못했습니다: {target}{detail}"
        ) from exc
    finally:
        for temporary, _destination in temporaries:
            try:
                temporary.unlink(missing_ok=True)
            except OSError:
                pass
    return True, previous_version


def _backup_managed_user_copies(
    user_target: Path,
) -> tuple[list[str], list[str], list[str]]:
    """공용 설치 후 사용자 경로의 관리 스크립트 두 개를 안전 백업한다."""
    migrated: list[str] = []
    backups: list[str] = []
    warnings: list[str] = []
    backup_dir = user_target.parent / ".mvhub-legacy-backup"
    for path in (user_target, resolve_importer_target(user_target)):
        if not path.is_file():
            continue
        content = _read_script(path, "기존 사용자 Resolve 스크립트")
        marker = _MANAGED_MARKERS.get(path.name)
        version = _script_version(content)
        if not marker or marker not in content or not version:
            warnings.append(f"사용자 수정 가능성이 있어 기존 파일을 보존했습니다: {path}")
            continue
        backup_dir.mkdir(parents=True, exist_ok=True)
        backup = backup_dir / f"{path.name}.{version}.{uuid.uuid4().hex[:8]}.bak"
        os.replace(path, backup)
        migrated.append(str(path))
        backups.append(str(backup))
    return migrated, backups, warnings


def install_resolve_script(
    *,
    appdata: str | Path | None = None,
    programdata: str | Path | None = None,
    source_path: str | Path | None = None,
) -> dict[str, Any]:
    source = Path(source_path) if source_path is not None else bundled_script_path()
    source_content = _read_script(source, "내장 Resolve 스크립트")
    importer_content = _read_script(
        bundled_importer_script_path(), "내장 Resolve Importer"
    )
    targets = resolve_script_targets(appdata=appdata, programdata=programdata)
    errors: list[str] = []
    changed = False
    previous_version: str | None = None
    installed_scope = ""

    for scope, target in targets:  # 실제 앱은 공용 → 사용자 순서
        try:
            changed, previous_version = _atomic_install(
                target, source_content, importer_content
            )
            installed_scope = scope
            break
        except ResolveScriptInstallError as exc:
            label = "모든 사용자 공용" if scope == "all_users" else "현재 사용자"
            errors.append(f"{label} 경로 설치 실패: {exc}")
    if not installed_scope:
        raise ResolveScriptInstallError("; ".join(errors))

    migrated_paths: list[str] = []
    backup_paths: list[str] = []
    if installed_scope == "all_users":
        user_target = dict(targets).get("current_user")
        if user_target and user_target != dict(targets)["all_users"]:
            try:
                migrated_paths, backup_paths, migration_warnings = (
                    _backup_managed_user_copies(user_target)
                )
                errors.extend(migration_warnings)
                changed = changed or bool(migrated_paths)
            except (OSError, ResolveScriptInstallError) as exc:
                errors.append(f"기존 사용자 스크립트 백업 실패: {exc}")

    result = _status_result(source_content, importer_content, targets)
    result.update(
        {
            "changed": changed,
            "previous_version": previous_version,
            "installed_scope": installed_scope,
            "migrated_paths": migrated_paths,
            "backup_paths": backup_paths,
            "warnings": list(dict.fromkeys([*result["warnings"], *errors])),
        }
    )
    return result

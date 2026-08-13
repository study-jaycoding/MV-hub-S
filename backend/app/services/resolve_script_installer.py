"""DaVinci Resolve 사용자 Scripts 메뉴에 MV Hub Clip Exporter를 설치한다."""

from __future__ import annotations

import os
import re
import uuid
from pathlib import Path
from typing import Any


SCRIPT_FILE_NAME = "MVHub Clip Exporter.py"
SCRIPT_RELATIVE_DIR = Path(
    "Blackmagic Design",
    "DaVinci Resolve",
    "Support",
    "Fusion",
    "Scripts",
    "Utility",
    "MV Hub",
)
_VERSION_PATTERN = re.compile(
    r'^PLUGIN_VERSION\s*=\s*["\']([^"\']+)["\']', re.MULTILINE
)


class ResolveScriptInstallError(RuntimeError):
    """사용자에게 표시할 수 있는 Resolve 스크립트 설치 오류."""


def bundled_script_path() -> Path:
    return Path(__file__).resolve().parents[1] / "resources" / "resolve" / "MVHub_Clip_Exporter.py"


def _appdata_root(appdata: str | Path | None = None) -> Path:
    raw = str(appdata or os.environ.get("APPDATA") or "").strip()
    if not raw and os.name == "nt":
        raw = str(Path.home() / "AppData" / "Roaming")
    if not raw:
        raise ResolveScriptInstallError("Windows 사용자 AppData 폴더를 찾을 수 없습니다")
    return Path(raw).expanduser().resolve()


def resolve_script_target(appdata: str | Path | None = None) -> Path:
    return _appdata_root(appdata) / SCRIPT_RELATIVE_DIR / SCRIPT_FILE_NAME


def _read_script(path: Path, label: str) -> bytes:
    try:
        content = path.read_bytes()
    except OSError as exc:
        raise ResolveScriptInstallError(f"{label}을 읽을 수 없습니다: {path}") from exc
    if not content:
        raise ResolveScriptInstallError(f"{label}이 비어 있습니다: {path}")
    return content


def _script_version(content: bytes) -> str | None:
    try:
        text = content.decode("utf-8-sig")
    except UnicodeDecodeError:
        return None
    match = _VERSION_PATTERN.search(text)
    return match.group(1).strip() if match else None


def resolve_script_status(
    *,
    appdata: str | Path | None = None,
    source_path: str | Path | None = None,
) -> dict[str, Any]:
    source = Path(source_path) if source_path is not None else bundled_script_path()
    target = resolve_script_target(appdata)
    source_content = _read_script(source, "내장 Resolve 스크립트")
    target_content = _read_script(target, "설치된 Resolve 스크립트") if target.is_file() else None
    return {
        "installed": target_content is not None,
        "up_to_date": target_content == source_content,
        "bundled_version": _script_version(source_content),
        "installed_version": _script_version(target_content) if target_content else None,
        "path": str(target),
    }


def install_resolve_script(
    *,
    appdata: str | Path | None = None,
    source_path: str | Path | None = None,
) -> dict[str, Any]:
    source = Path(source_path) if source_path is not None else bundled_script_path()
    target = resolve_script_target(appdata)
    source_content = _read_script(source, "내장 Resolve 스크립트")
    current_content = _read_script(target, "설치된 Resolve 스크립트") if target.is_file() else None
    previous_version = _script_version(current_content) if current_content else None
    changed = current_content != source_content

    if changed:
        try:
            target.parent.mkdir(parents=True, exist_ok=True)
            temporary = target.with_name(f".{target.name}.{uuid.uuid4().hex}.tmp")
            try:
                temporary.write_bytes(source_content)
                os.replace(temporary, target)
            finally:
                try:
                    temporary.unlink(missing_ok=True)
                except OSError:
                    pass
        except OSError as exc:
            raise ResolveScriptInstallError(
                "Resolve 스크립트 폴더에 파일을 설치하지 못했습니다"
            ) from exc

    result = resolve_script_status(appdata=appdata, source_path=source)
    result.update({"changed": changed, "previous_version": previous_version})
    return result

"""DaVinci Resolve 로컬 환경을 읽기 전용으로 진단한다.

스크립트 파일 복사 성공과 Resolve에서의 실제 사용 가능 여부는 서로 다르다.
이 모듈은 설치·Python·공식 API·실제 연결을 분리해서 사용자가 다음 조치를
알 수 있는 구조로 반환한다. 진단 중에는 파일이나 Windows 설정을 변경하지 않는다.
"""

from __future__ import annotations

import getpass
import os
import re
import struct
import sys
from pathlib import Path
from typing import Any

from .resolve_bridge import resolve_api_environment
from .resolve_script_installer import resolve_script_status
from .resolve_status_runner import resolve_connection_status_bounded


_VERSION_PARTS = re.compile(r"^(\d+)\.(\d+)")


def _python_bits(executable: Path) -> int | None:
    """실행하지 않고 Windows PE 헤더에서 Python 실행 파일 비트 수를 읽는다."""
    try:
        with executable.open("rb") as stream:
            if stream.read(2) != b"MZ":
                return None
            stream.seek(0x3C)
            pe_offset = struct.unpack("<I", stream.read(4))[0]
            stream.seek(pe_offset)
            if stream.read(4) != b"PE\0\0":
                return None
            machine = struct.unpack("<H", stream.read(2))[0]
    except (OSError, struct.error):
        return None
    if machine == 0x014C:
        return 32
    if machine in {0x8664, 0xAA64}:
        return 64
    return None


def _version_supported(version: str, bits: int | None) -> bool:
    match = _VERSION_PARTS.match(version.strip())
    if not match:
        return False
    return (int(match.group(1)), int(match.group(2))) >= (3, 6) and bits == 64


def _registry_python_installations() -> list[dict[str, Any]]:
    """Windows에 등록된 Python을 사용자 범위와 함께 반환한다."""
    if os.name != "nt":
        return []
    try:
        import winreg
    except ImportError:
        return []

    found: list[dict[str, Any]] = []
    views = [0]
    for flag_name in ("KEY_WOW64_64KEY", "KEY_WOW64_32KEY"):
        flag = getattr(winreg, flag_name, 0)
        if flag and flag not in views:
            views.append(flag)
    for scope, root in (("all_users", winreg.HKEY_LOCAL_MACHINE), ("current_user", winreg.HKEY_CURRENT_USER)):
        for view in views:
            try:
                core = winreg.OpenKey(
                    root,
                    r"SOFTWARE\Python\PythonCore",
                    0,
                    winreg.KEY_READ | view,
                )
            except OSError:
                continue
            with core:
                index = 0
                while True:
                    try:
                        version = winreg.EnumKey(core, index)
                    except OSError:
                        break
                    index += 1
                    try:
                        install_key = winreg.OpenKey(core, version + r"\InstallPath")
                        with install_key:
                            try:
                                executable_raw = winreg.QueryValueEx(install_key, "ExecutablePath")[0]
                            except OSError:
                                install_root = winreg.QueryValue(install_key, None)
                                executable_raw = str(Path(install_root) / "python.exe")
                    except OSError:
                        continue
                    executable = Path(str(executable_raw)).expanduser()
                    if not executable.is_file():
                        continue
                    bits = _python_bits(executable)
                    found.append(
                        {
                            "scope": scope,
                            "version": version,
                            "bits": bits,
                            "path": str(executable),
                            "resolve_menu_compatible": _version_supported(version, bits),
                        }
                    )

    unique: dict[str, dict[str, Any]] = {}
    for item in found:
        key = os.path.normcase(os.path.normpath(item["path"]))
        current = unique.get(key)
        if current is None or item["scope"] == "all_users":
            unique[key] = item
    return sorted(
        unique.values(),
        key=lambda item: (item["scope"] != "all_users", item["version"], item["path"]),
    )


def _registry_resolve_installations() -> list[dict[str, str]]:
    """기본 경로와 제거 프로그램 정보에서 Resolve 설치를 찾는다."""
    candidates: list[dict[str, str]] = []
    configured = os.environ.get("CONTENT_HUB_RESOLVE_INSTALL_DIR", "").strip()
    if configured:
        candidates.append({"path": configured, "version": "", "name": "DaVinci Resolve"})

    if os.name == "nt":
        try:
            import winreg
        except ImportError:
            winreg = None  # type: ignore[assignment]
        if winreg is not None:
            views = [0]
            for flag_name in ("KEY_WOW64_64KEY", "KEY_WOW64_32KEY"):
                flag = getattr(winreg, flag_name, 0)
                if flag and flag not in views:
                    views.append(flag)
            uninstall_key = r"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall"
            for root in (winreg.HKEY_LOCAL_MACHINE, winreg.HKEY_CURRENT_USER):
                for view in views:
                    try:
                        parent = winreg.OpenKey(
                            root, uninstall_key, 0, winreg.KEY_READ | view
                        )
                    except OSError:
                        continue
                    with parent:
                        index = 0
                        while True:
                            try:
                                child_name = winreg.EnumKey(parent, index)
                            except OSError:
                                break
                            index += 1
                            try:
                                child = winreg.OpenKey(parent, child_name)
                                with child:
                                    name = str(winreg.QueryValueEx(child, "DisplayName")[0])
                                    if "davinci resolve" not in name.casefold():
                                        continue
                                    if "control panel" in name.casefold():
                                        continue
                                    try:
                                        location = str(winreg.QueryValueEx(child, "InstallLocation")[0]).strip()
                                    except OSError:
                                        location = ""
                                    try:
                                        version = str(winreg.QueryValueEx(child, "DisplayVersion")[0]).strip()
                                    except OSError:
                                        version = ""
                            except OSError:
                                continue
                            candidates.append(
                                {
                                    "path": location
                                    or r"C:\Program Files\Blackmagic Design\DaVinci Resolve",
                                    "version": version,
                                    "name": name,
                                }
                            )

    for root_variable in ("ProgramW6432", "PROGRAMFILES", "PROGRAMFILES(X86)"):
        root = os.environ.get(root_variable, "").strip()
        if root:
            candidates.append(
                {
                    "path": str(Path(root) / "Blackmagic Design" / "DaVinci Resolve"),
                    "version": "",
                    "name": "DaVinci Resolve",
                }
            )
    candidates.append(
        {
            "path": r"C:\Program Files\Blackmagic Design\DaVinci Resolve",
            "version": "",
            "name": "DaVinci Resolve",
        }
    )

    unique: dict[str, dict[str, str]] = {}
    for item in candidates:
        install_dir = Path(item["path"]).expanduser()
        executable = install_dir / "Resolve.exe"
        if not executable.is_file():
            continue
        key = os.path.normcase(os.path.normpath(str(install_dir)))
        previous = unique.get(key)
        if previous is None or (item["version"] and not previous["version"]):
            unique[key] = {**item, "path": str(install_dir), "executable": str(executable)}
    return list(unique.values())


def resolve_environment_snapshot() -> dict[str, Any]:
    """연결을 시도하지 않고 현재 PC의 Resolve 관련 파일과 런타임을 조사한다."""
    api = resolve_api_environment()
    return {
        "windows_user": getpass.getuser(),
        "mvhub_python": {
            "version": f"{sys.version_info.major}.{sys.version_info.minor}.{sys.version_info.micro}",
            "bits": 64 if sys.maxsize > 2**32 else 32,
            "path": sys.executable,
        },
        "system_pythons": _registry_python_installations(),
        "resolve_installations": _registry_resolve_installations(),
        "api": api,
    }


def _check(key: str, label: str, state: str, message: str, detail: str = "") -> dict[str, str]:
    return {
        "key": key,
        "label": label,
        "state": state,
        "message": message,
        "detail": detail,
    }


def build_resolve_diagnostics(
    script: dict[str, Any],
    connection: dict[str, Any],
    environment: dict[str, Any],
) -> dict[str, Any]:
    """수집 결과를 사용자에게 설명할 수 있는 상태로 분류한다."""
    checks: list[dict[str, str]] = []
    recommendations: list[str] = []
    installations = environment.get("resolve_installations") or []
    if installations:
        first = installations[0]
        version = f" {first['version']}" if first.get("version") else ""
        checks.append(
            _check("resolve_install", "Resolve 설치", "ok", f"DaVinci Resolve{version} 발견", first["path"])
        )
    else:
        checks.append(
            _check(
                "resolve_install",
                "Resolve 설치",
                "warning",
                "등록된 Resolve 설치 경로를 찾지 못했습니다",
                "사용자 지정 경로라면 연결 설정에서 설치 경로를 지정해야 합니다.",
            )
        )
        recommendations.append("Resolve 설치 경로를 확인하거나 복구 설치하세요.")

    if script.get("up_to_date"):
        scope = "모든 사용자" if script.get("all_users_installed") else "현재 사용자"
        checks.append(
            _check("scripts", "메뉴 스크립트", "ok", f"최신 도구 2개 설치됨 · {scope}", script.get("path", ""))
        )
    elif script.get("installed"):
        checks.append(_check("scripts", "메뉴 스크립트", "warning", "설치됐지만 업데이트가 필요합니다", script.get("path", "")))
        recommendations.append("Resolve 스크립트 설치 버튼으로 최신 파일을 적용하세요.")
    else:
        checks.append(_check("scripts", "메뉴 스크립트", "error", "가져오기·내보내기 도구가 설치되지 않았습니다", script.get("path", "")))
        recommendations.append("Resolve 스크립트를 설치하세요.")

    compatible_pythons = [
        item
        for item in environment.get("system_pythons") or []
        if item.get("resolve_menu_compatible")
    ]
    if compatible_pythons:
        python = compatible_pythons[0]
        all_users = python.get("scope") == "all_users"
        checks.append(
            _check(
                "menu_python",
                "Resolve용 Python",
                "ok" if all_users else "warning",
                f"Python {python['version']} {python['bits']}비트 · "
                + ("모든 사용자" if all_users else "현재 사용자만"),
                python["path"],
            )
        )
        if not all_users:
            recommendations.append(
                "다른 Windows 계정에서도 사용하려면 64비트 Python을 모든 사용자용으로 설치하세요."
            )
    else:
        checks.append(
            _check(
                "menu_python",
                "Resolve용 Python",
                "warning",
                "모든 사용자용 64비트 Python 3.6 이상을 찾지 못했습니다",
                "Resolve 내부 Python 메뉴 스크립트가 표시되지 않거나 실행되지 않을 수 있습니다.",
            )
        )
        recommendations.append("Resolve 메뉴 사용을 위해 64비트 Python을 모든 사용자용으로 설치하세요.")

    api = environment.get("api") or {}
    module = next(iter(api.get("existing_module_paths") or []), "")
    library = str(api.get("library_path") or "")
    checks.append(
        _check(
            "api_module",
            "Resolve API 모듈",
            "ok" if module else "error",
            "DaVinciResolveScript.py 발견" if module else "DaVinciResolveScript.py를 찾지 못했습니다",
            module or "Resolve 복구 설치가 필요할 수 있습니다.",
        )
    )
    checks.append(
        _check(
            "api_library",
            "Resolve 연결 DLL",
            "ok" if library else "error",
            "fusionscript.dll 발견" if library else "fusionscript.dll을 찾지 못했습니다",
            library or "사용자 지정 설치 경로라면 자동 탐색되지 않았을 수 있습니다.",
        )
    )
    if not module or not library:
        recommendations.append("Resolve API 파일이 없으면 Resolve를 복구 설치하세요.")

    connected = bool(connection.get("connected"))
    connection_state = str(connection.get("status") or "api_unavailable")
    if connected:
        checks.append(_check("connection", "실제 연결", "ok", connection.get("message", "Resolve 연결됨")))
    elif connection_state == "not_running":
        checks.append(_check("connection", "실제 연결", "info", connection.get("message", "Resolve가 실행 중이지 않습니다")))
    else:
        checks.append(_check("connection", "실제 연결", "warning", connection.get("message", "Resolve에 연결하지 못했습니다")))
        if connection_state == "python_incompatible":
            recommendations.append("Resolve 버전과 연결용 Python의 호환성을 확인하세요.")
        elif connection_state == "api_unavailable":
            recommendations.append("Studio에서는 External scripting using을 Local로 저장하고 Resolve를 재시작하세요.")

    menu_ready = bool(script.get("up_to_date") and compatible_pythons)
    if connected:
        status = "ready"
        summary = "Resolve 자동 연결을 사용할 수 있습니다."
    elif menu_ready:
        status = "menu_ready"
        summary = (
            "Resolve 메뉴 스크립트 사용 조건이 준비되어 있습니다. "
            "Resolve 재시작 후 메뉴에서 확인하세요."
        )
    else:
        status = "action_required"
        summary = "Resolve 연동을 사용하려면 표시된 항목을 먼저 조치해야 합니다."
    return {
        "status": status,
        "summary": summary,
        "checks": checks,
        "recommendations": list(dict.fromkeys(recommendations)),
        "script": script,
        "connection": connection,
        "environment": environment,
    }


def resolve_environment_diagnostics() -> dict[str, Any]:
    """현재 PC의 전체 Resolve 진단 결과를 반환한다."""
    return build_resolve_diagnostics(
        resolve_script_status(),
        resolve_connection_status_bounded(),
        resolve_environment_snapshot(),
    )

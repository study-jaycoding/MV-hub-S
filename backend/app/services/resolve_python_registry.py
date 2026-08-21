"""Windows에 설치된 Python을 레지스트리에서 읽기 전용으로 조사한다.

Resolve 진단(메뉴 스크립트용 Python 표시)과 연결 러너(fusionscript 호환
인터프리터 자동 폴백)가 같은 목록을 쓰도록 분리한 leaf 모듈이다.
"""

from __future__ import annotations

import os
import re
import struct
from pathlib import Path
from typing import Any


_VERSION_PARTS = re.compile(r"^(\d+)\.(\d+)")


def parse_python_version(version: str) -> tuple[int, int] | None:
    """레지스트리 버전 문자열("3.11")을 비교 가능한 숫자 쌍으로 바꾼다."""
    match = _VERSION_PARTS.match(version.strip())
    if not match:
        return None
    return int(match.group(1)), int(match.group(2))


def python_bits(executable: Path) -> int | None:
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


def menu_version_supported(version: str, bits: int | None) -> bool:
    """Resolve 메뉴 스크립트가 요구하는 공식 최소 조건(3.6 이상 64비트)."""
    parsed = parse_python_version(version)
    return parsed is not None and parsed >= (3, 6) and bits == 64


def registry_python_installations() -> list[dict[str, Any]]:
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
                    bits = python_bits(executable)
                    found.append(
                        {
                            "scope": scope,
                            "version": version,
                            "bits": bits,
                            "path": str(executable),
                            "resolve_menu_compatible": menu_version_supported(version, bits),
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

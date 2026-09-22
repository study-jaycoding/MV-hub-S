"""경로 안전 결합 공용 — base 아래로만 해석되게 join(traversal·symlink 이탈 차단).

라우터·서비스 여러 곳에서 `(base / rel).resolve()` 후 `relative_to(base)` 로 이탈을 막던 동일 패턴을
한 곳에 모은다. 보안 로직이므로 동작을 그대로 보존한다:
  · `resolve()` 로 symlink 까지 실제 해석해 base 밖을 가리키면 차단(문자열 prefix 검사보다 강함).
  · 절대경로 rel 이라도 최종 위치가 base 안이면 허용(기존 `(base / rel).resolve()` 동작 유지).
  · 해석 실패(ValueError/OSError)는 안전측(None)으로 — 못 여는 경로는 접근 거부.
"""

from __future__ import annotations

import ctypes
import os
from pathlib import Path, PurePath, PureWindowsPath
from typing import Optional, Union


def unc_for_drive(path: str) -> Optional[str]:
    """연결된 네트워크 드라이브(Z: 등)로 시작하면 그 공유의 UNC 로 바꾼다. 드라이브 글자가 없거나 로컬 드라이브면 그대로.
    드라이브 글자인데 어디에 걸렸는지 이 PC 에서 알 수 없으면 None(모름) — 같은 폴더인지 판정하는 쪽이 안전측을 고른다.

    같은 NAS 를 `Z:` 와 UNC 로 달리 적으면 경로 대조가 빗나간다(Codex P1 — Resolve 라이브러리·완료 탭 미러).
    Windows 가 기억하는 드라이브 → 공유 대응표(WNetGetConnectionW)와 드라이브 종류(GetDriveTypeW)만 묻고 네트워크는
    건드리지 않는다. ★연결 안 된 빈 글자도 로컬 드라이브와 같은 2250(ERROR_NOT_CONNECTED)을 돌려준다(2026-09-22 이 PC
    실측 — C:·D: 와 Q:·Y:) → 드라이브 종류로 '있는 로컬 드라이브'일 때만 그대로 둔다.
    """
    drive, rest = os.path.splitdrive(path)
    if os.name != "nt" or len(drive) != 2 or drive[1] != ":":
        return path
    buffer = ctypes.create_unicode_buffer(1024)
    size = ctypes.c_ulong(len(buffer))
    try:
        code = ctypes.windll.mpr.WNetGetConnectionW(drive, buffer, ctypes.byref(size))
        # 0 = 연결됨, 1201 = 지금은 끊겼지만 기억된 연결 — 둘 다 대응표로는 유효하다.
        if code in (0, 1201) and buffer.value:
            return buffer.value + rest
        kind = ctypes.windll.kernel32.GetDriveTypeW(drive + "\\")
    except (AttributeError, OSError):
        return None
    # 2 이동식 · 3 고정 · 5 CD · 6 RAM 디스크 = 로컬. 0 모름 · 1 없는 글자 · 4 네트워크인데 대응표를 못 읽음 = 모름.
    return path if kind in (2, 3, 5, 6) else None


def path_comparison_key(path: PurePath) -> PurePath:
    """해석된 경로의 비교용 키. IO 경로를 바꾸거나 다시 resolve하지 않는다.

    Windows resolve가 파일 교체 중 extended 접두사를 남기는 경우도 같은 경로로
    비교한다. 일반 드라이브·UNC의 알려진 표기만 통일하며 device namespace는 보존한다.
    PureWindowsPath의 컴포넌트·대소문자 비교 규칙을 그대로 사용한다.
    """
    if not isinstance(path, PureWindowsPath):
        return path
    drive = path.drive
    if (
        path.root
        and len(drive) == 6
        and drive[:4] == "\\\\?\\"
        and drive[4] in "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"
        and drive[5] == ":"
    ):
        return PureWindowsPath(str(path)[4:])
    if path.root and drive[:8].upper() == "\\\\?\\UNC\\":
        server_share = drive[8:].split("\\")
        if len(server_share) == 2 and all(
            part not in {"", ".", "..", "?"} for part in server_share
        ):
            return PureWindowsPath("\\\\" + str(path)[8:])
    return path


def safe_join(base: Path, rel: Union[str, Path]) -> Optional[Path]:
    """base 아래로 안전하게 결합한 절대경로. 최종 해석 경로가 base 밖이면 None."""
    try:
        base = base.resolve()
        cand = (base / rel).resolve()
        base_key = path_comparison_key(base)
        cand_key = path_comparison_key(cand)
        # resolve가 완전히 해석하지 못한 상위 이동은 비교로 추측하지 않는다.
        if ".." in base_key.parts or ".." in cand_key.parts:
            return None
        cand_key.relative_to(base_key)
    except (ValueError, OSError):
        return None
    return cand

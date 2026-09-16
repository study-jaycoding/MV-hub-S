"""Windows 릴리스 업데이트와 직접 전송의 프로세스 간 상호 배제.

부모와 호환 Python 자식이 각각 공유 핸들을 소유한다. 업데이터는 같은 파일을
FileShare.None으로 열므로 어느 쪽이 먼저 시작해도 전송 도중 교체할 수 없다.
파일의 존재/내용/나이는 상태가 아니다. 열린 핸들만 잠금이며 종료 시 OS가 회수한다.
호환 Python(3.9+)에서도 쓸 수 있도록 표준 라이브러리만 사용한다.
"""

from __future__ import annotations

import ctypes
import os
from contextlib import contextmanager
from pathlib import Path
from typing import Iterator

APP_ROOT = Path(__file__).resolve().parents[3]
LOCK_NAME = ".resolve-transfer.lock"


class ResolveTransferGateError(RuntimeError):
    """전송 보호를 확보하지 못했으므로 작업을 시작하지 않는다."""


class ResolveTransferGateBusy(ResolveTransferGateError):
    """업데이터가 설치 폴더를 교체 중이다."""


@contextmanager
def transfer_lease(root: Path | None = None) -> Iterator[None]:
    """릴리스만 공유 잠금. 핸들은 비상속이며 대기/유효기간/파일 삭제를 하지 않는다."""
    root = APP_ROOT if root is None else root
    # 업데이트 중 실행기가 잠시 교체되는 때도 이미 만든 보호 파일은 남아 있다.
    # 무거운 앱 설정/DB를 자식에 import하지 않으며, 표식 없는 개발 폴더에는 파일을 만들지 않는다.
    lock_path = root / LOCK_NAME
    release_install = lock_path.exists() or all(
        (root / name).is_file() for name in ("INSTALL_SOURCE.txt", "update_release.bat")
    )
    if os.name != "nt" or not release_install:
        yield
        return

    from ctypes import wintypes

    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    create_file = kernel32.CreateFileW
    create_file.argtypes = (
        wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD, ctypes.c_void_p,
        wintypes.DWORD, wintypes.DWORD, wintypes.HANDLE,
    )
    create_file.restype = wintypes.HANDLE
    close_handle = kernel32.CloseHandle
    close_handle.argtypes = (wintypes.HANDLE,)
    close_handle.restype = wintypes.BOOL
    handle = create_file(
        str(lock_path),
        0x80000000 | 0x40000000,  # GENERIC_READ | GENERIC_WRITE
        0x1 | 0x2,  # FILE_SHARE_READ | FILE_SHARE_WRITE: 동시 전송 허용
        None,  # NULL SECURITY_ATTRIBUTES: 자식 프로세스에 상속하지 않는다
        4,  # OPEN_ALWAYS: 기존 파일 내용을 바꾸지 않는다
        0x80,  # FILE_ATTRIBUTE_NORMAL
        None,
    )
    if handle == ctypes.c_void_p(-1).value:
        error = ctypes.get_last_error()
        if error in (32, 33):  # ERROR_SHARING_VIOLATION / ERROR_LOCK_VIOLATION
            raise ResolveTransferGateBusy(
                "프로그램 업데이트가 진행 중이라 Resolve 전송을 시작할 수 없습니다. 완료 후 다시 시도하세요"
            )
        raise ResolveTransferGateError(
            f"Resolve 전송 보호 파일을 열 수 없습니다. 설치 폴더 접근 권한을 확인하세요 (Windows 오류 {error})"
        ) from ctypes.WinError(error)
    try:
        yield
    finally:
        close_handle(handle)

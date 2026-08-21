"""호환 Python이 없는 PC를 위한 반자동 Python 설치 도우미.

fusionscript 폴백(resolve_status_runner)이 쓸 64비트 Python이 PC에 하나도
없을 때, 공식 python.org 설치 파일을 내려받아(고정 SHA256 검증) 반자동
모드로 실행한다. 반자동 = 사용자는 관리자 권한(UAC) 승인만 하면 되고,
설치는 질문 없이 진행 표시만 보여주며 끝난다. 설치가 끝나면 다음 진단부터
레지스트리 조사(resolve_python_registry)가 자동으로 인식한다.
"""

from __future__ import annotations

import hashlib
import os
import tempfile
from pathlib import Path
from typing import Any
from urllib.request import urlopen


# Resolve 21 실측(CF-PC01)에 맞춘 폴백 권장 버전. 3.11 계열의 마지막 설치판이다.
PYTHON_INSTALLER_VERSION = "3.11.9"
_INSTALLER_URL = (
    "https://www.python.org/ftp/python/"
    f"{PYTHON_INSTALLER_VERSION}/python-{PYTHON_INSTALLER_VERSION}-amd64.exe"
)
# 2026-08-21 python.org 원본에서 직접 내려받아 고정한 값. 이후 다운로드 변조를 막는다.
_INSTALLER_SHA256 = "5ee42c4eee1e6b4464bb23722f90b45303f79442df63083f05322f1785f5fdde"
# /passive: 질문 없이 진행 표시만. InstallAllUsers=1: 다른 Windows 계정에서도 인식.
_INSTALLER_ARGUMENTS = "/passive InstallAllUsers=1 PrependPath=0 Include_test=0"
_DOWNLOAD_TIMEOUT_SECONDS = 60.0
# 정상 파일은 약 25MB. 비정상 응답이 디스크를 채우지 않게 상한을 둔다.
_DOWNLOAD_MAX_BYTES = 100 * 1024 * 1024


class ResolvePythonInstallError(RuntimeError):
    """사용자에게 표시할 수 있는 설치 도우미 오류."""


def _installer_cache_path() -> Path:
    return (
        Path(tempfile.gettempdir())
        / "mvhub"
        / f"python-{PYTHON_INSTALLER_VERSION}-amd64.exe"
    )


def _sha256_of(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _download_installer(target: Path) -> None:
    target.parent.mkdir(parents=True, exist_ok=True)
    partial = target.with_name(target.name + ".part")
    try:
        with urlopen(_INSTALLER_URL, timeout=_DOWNLOAD_TIMEOUT_SECONDS) as response:
            with partial.open("wb") as stream:
                received = 0
                while True:
                    chunk = response.read(1024 * 256)
                    if not chunk:
                        break
                    received += len(chunk)
                    if received > _DOWNLOAD_MAX_BYTES:
                        raise ResolvePythonInstallError(
                            "Python 설치 파일 다운로드가 예상 크기를 초과했습니다"
                        )
                    stream.write(chunk)
    except ResolvePythonInstallError:
        partial.unlink(missing_ok=True)
        raise
    except OSError as exc:
        partial.unlink(missing_ok=True)
        raise ResolvePythonInstallError(
            f"Python 설치 파일을 내려받지 못했습니다. 인터넷 연결을 확인하세요 ({exc})"
        ) from exc
    if _sha256_of(partial) != _INSTALLER_SHA256:
        partial.unlink(missing_ok=True)
        raise ResolvePythonInstallError(
            "내려받은 Python 설치 파일이 공식 원본과 일치하지 않습니다. 잠시 후 다시 시도하세요"
        )
    os.replace(partial, target)


def _launch_installer(target: Path) -> None:
    # 설치 파일이 스스로 관리자 권한(UAC)을 요청할 수 있게 ShellExecute 경유로 연다.
    # subprocess.CreateProcess 는 승격 필요 exe 에서 ERROR_ELEVATION_REQUIRED 로 실패한다.
    os.startfile(str(target), arguments=_INSTALLER_ARGUMENTS)  # noqa: S606


def start_python_installer() -> dict[str, Any]:
    """설치 파일을 준비(캐시·검증)하고 반자동 설치를 시작한다."""
    if os.name != "nt":
        raise ResolvePythonInstallError("Python 자동 설치는 Windows에서만 사용할 수 있습니다")
    target = _installer_cache_path()
    if not target.is_file() or _sha256_of(target) != _INSTALLER_SHA256:
        _download_installer(target)
    try:
        _launch_installer(target)
    except OSError as exc:
        raise ResolvePythonInstallError(
            f"Python 설치 파일을 실행하지 못했습니다: {exc}"
        ) from exc
    return {
        "ok": True,
        "version": PYTHON_INSTALLER_VERSION,
        "installer_path": str(target),
        "message": (
            f"Python {PYTHON_INSTALLER_VERSION} 설치가 시작됐습니다. "
            "관리자 권한 요청(UAC) 창이 뜨면 승인하세요. 설치는 자동으로 진행되며, "
            "완료 후 'Resolve 진단'을 다시 누르면 연결에 자동으로 사용됩니다."
        ),
    }

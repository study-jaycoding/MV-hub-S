"""Resolve 가져오기 큐의 프로세스 간 배타 락 (manifest v3 명세 §2.1~2.2).

manifest 파일 자체는 잠그지 않는다. 갱신이 ``os.replace``라서 교체 순간 파일 객체가
바뀌어 잠금이 따라가지 않기 때문이다. 대신 절대 삭제·교체하지 않는 별도 ``.lock``
파일의 첫 1바이트를 Windows ``LockFileEx``(즉시 실패)로 잠근다. push 워커와 Resolve
메뉴 Importer 가 같은 전송을 동시에 드레인하는 이중 실행을 막는 유일한 방어선이다.

best-effort 폴백은 두지 않는다. 잠금을 신뢰할 수 없는 저장소(byte-range lock 미지원
SMB 등)에서는 ``ResolveLockUnsupported``(``locking_unsupported``)를 올려 워커를 끈다.
"""

from __future__ import annotations

import errno
import os
import threading
import uuid
from contextlib import contextmanager
from pathlib import Path
from typing import IO, Iterator, Sequence

from ..config import DATA_DIR
from .atomic_io import atomic_write_text
from .path_safety import safe_join


LOCKING_UNSUPPORTED = "locking_unsupported"


class ResolveLockUnsupported(RuntimeError):
    """저장소가 byte-range 잠금을 제공하지 않는다. 자동 워커를 비활성화해야 한다."""

    code = LOCKING_UNSUPPORTED


class ResolveLockBusy(RuntimeError):
    """다른 소유자가 이미 보유 중 — 정상 경쟁이므로 다음 후보로 넘어간다."""


if os.name == "nt":  # pragma: no cover - 플랫폼 분기(운영 경로는 Windows)
    import ctypes
    import msvcrt
    from ctypes import wintypes

    _LOCKFILE_FAIL_IMMEDIATELY = 0x00000001
    _LOCKFILE_EXCLUSIVE_LOCK = 0x00000002
    _ERROR_LOCK_VIOLATION = 33
    _ERROR_IO_PENDING = 997

    class _Overlapped(ctypes.Structure):
        _fields_ = [
            ("Internal", ctypes.c_void_p),
            ("InternalHigh", ctypes.c_void_p),
            ("Offset", wintypes.DWORD),
            ("OffsetHigh", wintypes.DWORD),
            ("hEvent", wintypes.HANDLE),
        ]

    _kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    _kernel32.LockFileEx.argtypes = (
        wintypes.HANDLE,
        wintypes.DWORD,
        wintypes.DWORD,
        wintypes.DWORD,
        wintypes.DWORD,
        ctypes.POINTER(_Overlapped),
    )
    _kernel32.LockFileEx.restype = wintypes.BOOL
    _kernel32.UnlockFileEx.argtypes = (
        wintypes.HANDLE,
        wintypes.DWORD,
        wintypes.DWORD,
        wintypes.DWORD,
        ctypes.POINTER(_Overlapped),
    )
    _kernel32.UnlockFileEx.restype = wintypes.BOOL
    # 64비트에서 HANDLE 을 int 로 잘라 쓰면 잘못된 핸들이 되므로 반드시 선언한다.
    _kernel32.OpenProcess.argtypes = (wintypes.DWORD, wintypes.BOOL, wintypes.DWORD)
    _kernel32.OpenProcess.restype = wintypes.HANDLE
    _kernel32.GetProcessTimes.argtypes = (
        wintypes.HANDLE,
        ctypes.POINTER(wintypes.FILETIME),
        ctypes.POINTER(wintypes.FILETIME),
        ctypes.POINTER(wintypes.FILETIME),
        ctypes.POINTER(wintypes.FILETIME),
    )
    _kernel32.GetProcessTimes.restype = wintypes.BOOL
    _kernel32.CloseHandle.argtypes = (wintypes.HANDLE,)
    _kernel32.CloseHandle.restype = wintypes.BOOL
    _kernel32.TerminateProcess.argtypes = (wintypes.HANDLE, wintypes.UINT)
    _kernel32.TerminateProcess.restype = wintypes.BOOL

    def _lock_first_byte(handle: IO[bytes]) -> None:
        overlapped = _Overlapped()
        ok = _kernel32.LockFileEx(
            msvcrt.get_osfhandle(handle.fileno()),
            _LOCKFILE_EXCLUSIVE_LOCK | _LOCKFILE_FAIL_IMMEDIATELY,
            0,
            1,
            0,
            ctypes.byref(overlapped),
        )
        if ok:
            return
        code = ctypes.get_last_error()
        if code in (_ERROR_LOCK_VIOLATION, _ERROR_IO_PENDING):
            raise ResolveLockBusy(f"다른 작업자가 사용 중입니다 (WinError {code})")
        raise ResolveLockUnsupported(
            f"이 저장소는 파일 범위 잠금을 지원하지 않습니다 (WinError {code})"
        )

    def _unlock_first_byte(handle: IO[bytes]) -> None:
        overlapped = _Overlapped()
        _kernel32.UnlockFileEx(
            msvcrt.get_osfhandle(handle.fileno()), 0, 1, 0, ctypes.byref(overlapped)
        )

    def process_liveness(pid: int, started_at_filetime: str) -> str:
        """``alive`` | ``dead`` | ``unknown`` (명세 §2.7 — PID 재사용 방지).

        PID 존재만으로 생존을 판정하지 않는다. 생성 시각(FILETIME)까지 같아야 원
        소유자이며, 다르면 PID 재사용이므로 원 소유자는 사망으로 본다.
        """
        if pid <= 0:
            return "unknown"
        PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
        ERROR_INVALID_PARAMETER = 87
        handle = _kernel32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, pid)
        if not handle:
            code = ctypes.get_last_error()
            return "dead" if code == ERROR_INVALID_PARAMETER else "unknown"
        try:
            creation = wintypes.FILETIME()
            exit_time = wintypes.FILETIME()
            kernel_time = wintypes.FILETIME()
            user_time = wintypes.FILETIME()
            ok = _kernel32.GetProcessTimes(
                handle,
                ctypes.byref(creation),
                ctypes.byref(exit_time),
                ctypes.byref(kernel_time),
                ctypes.byref(user_time),
            )
            if not ok:
                return "unknown"
            current = (creation.dwHighDateTime << 32) | creation.dwLowDateTime
        finally:
            _kernel32.CloseHandle(handle)
        recorded = str(started_at_filetime or "").strip()
        if not recorded.isdigit():
            return "unknown"
        return "alive" if int(recorded) == current else "dead"

    def terminate_process(pid: int, started_at_filetime: str) -> bool:
        """사용자의 '강제 중단' 확인이 있을 때만 부르는 프로세스 종료.

        ★생성 시각까지 일치할 때만 끊는다. PID 만 보고 끊으면 재사용된 PID의 무고한
        프로세스(다른 앱, Resolve 자신)를 죽일 수 있다. 자동 경로에서는 절대 부르지
        않는다 — 명세 §D 의 ``TerminateProcess`` 금지는 자동 취소에 대한 규칙이다.
        """
        if pid <= 0 or pid == os.getpid():
            return False
        if process_liveness(pid, started_at_filetime) != "alive":
            return False
        PROCESS_TERMINATE = 0x0001
        handle = _kernel32.OpenProcess(PROCESS_TERMINATE, False, pid)
        if not handle:
            return False
        try:
            return bool(_kernel32.TerminateProcess(handle, 1))
        finally:
            _kernel32.CloseHandle(handle)

    def process_started_at_filetime(pid: int | None = None) -> str:
        """현재(또는 지정) 프로세스의 생성 시각 FILETIME 문자열."""
        target = os.getpid() if pid is None else pid
        PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
        handle = _kernel32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, target)
        if not handle:
            return ""
        try:
            creation = wintypes.FILETIME()
            exit_time = wintypes.FILETIME()
            kernel_time = wintypes.FILETIME()
            user_time = wintypes.FILETIME()
            if not _kernel32.GetProcessTimes(
                handle,
                ctypes.byref(creation),
                ctypes.byref(exit_time),
                ctypes.byref(kernel_time),
                ctypes.byref(user_time),
            ):
                return ""
            return str((creation.dwHighDateTime << 32) | creation.dwLowDateTime)
        finally:
            _kernel32.CloseHandle(handle)

else:  # pragma: no cover - 개발용 POSIX 분기(운영 워커는 Windows 전용)
    import fcntl

    def _lock_first_byte(handle: IO[bytes]) -> None:
        try:
            fcntl.lockf(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB, 1, 0, os.SEEK_SET)
        except OSError as exc:
            if exc.errno in (errno.EACCES, errno.EAGAIN):
                raise ResolveLockBusy("다른 작업자가 사용 중입니다") from exc
            raise ResolveLockUnsupported(
                f"이 저장소는 파일 범위 잠금을 지원하지 않습니다 ({exc})"
            ) from exc

    def _unlock_first_byte(handle: IO[bytes]) -> None:
        try:
            fcntl.lockf(handle.fileno(), fcntl.LOCK_UN, 1, 0, os.SEEK_SET)
        except OSError:
            pass

    def process_liveness(pid: int, started_at_filetime: str) -> str:
        if pid <= 0:
            return "unknown"
        try:
            os.kill(pid, 0)
        except ProcessLookupError:
            return "dead"
        except OSError:
            return "unknown"
        # POSIX 에는 값싼 생성시각 조회가 없어 PID 재사용을 구분할 수 없다.
        return "unknown"

    def terminate_process(pid: int, started_at_filetime: str) -> bool:
        """POSIX 개발 분기 — 생성 시각을 확인할 수 없어 이미 죽은 PID 만 걸러 낸다."""
        import signal

        if pid <= 0 or pid == os.getpid():
            return False
        if process_liveness(pid, started_at_filetime) == "dead":
            return False
        try:
            os.kill(pid, signal.SIGTERM)
        except OSError:
            return False
        return True

    def process_started_at_filetime(pid: int | None = None) -> str:
        return ""


class FileLock:
    """안정된 lock 파일 1바이트에 대한 배타 잠금. 파일은 만들기만 하고 지우지 않는다."""

    def __init__(self, path: Path | str):
        self.path = Path(path)
        self._handle: IO[bytes] | None = None

    @property
    def held(self) -> bool:
        return self._handle is not None

    def acquire(self) -> None:
        if self._handle is not None:
            raise RuntimeError("이미 보유한 락입니다")
        self.path.parent.mkdir(parents=True, exist_ok=True)
        # "a+b" 는 없으면 만들고 있으면 그대로 연다 — 절대 truncate 하지 않는다.
        handle = open(self.path, "a+b")
        try:
            _lock_first_byte(handle)
        except BaseException:
            handle.close()
            raise
        self._handle = handle

    def try_acquire(self) -> bool:
        """경쟁이면 False. 저장소가 잠금을 지원하지 않으면 예외를 그대로 올린다."""
        try:
            self.acquire()
        except ResolveLockBusy:
            return False
        return True

    def release(self) -> None:
        handle, self._handle = self._handle, None
        if handle is None:
            return
        try:
            _unlock_first_byte(handle)
        finally:
            handle.close()

    def __enter__(self) -> "FileLock":
        self.acquire()
        return self

    def __exit__(self, *_exc: object) -> None:
        self.release()


@contextmanager
def acquire_chain(paths: Sequence[Path]) -> Iterator[list[FileLock]]:
    """machine → project → transfer 순으로 잡고 역순으로 푼다(명세 §2.1)."""
    locks: list[FileLock] = []
    try:
        for path in paths:
            lock = FileLock(path)
            lock.acquire()
            locks.append(lock)
        yield locks
    finally:
        for lock in reversed(locks):
            lock.release()


def _resolve_root() -> Path:
    return DATA_DIR / "resolve"


def machine_lock_path() -> Path:
    return _resolve_root() / "locks" / "machine-import.lock"


def project_lock_path(manifest_root: Path) -> Path:
    path = safe_join(Path(manifest_root), Path(".mvhub") / "locks" / "project-import.lock")
    if path is None:
        raise ResolveLockUnsupported("프로젝트 락 경로가 안전하지 않습니다")
    return path


def locks_dir(manifest_root: Path) -> Path:
    """manifest 루트 아래의 락 디렉터리(프로젝트 락·전송 락이 함께 있는 곳)."""
    return project_lock_path(manifest_root).parent


def transfer_lock_path(manifest_root: Path, transfer_id: str) -> Path:
    path = safe_join(
        Path(manifest_root),
        Path(".mvhub") / "locks" / "transfers" / f"{transfer_id}.lock",
    )
    if path is None:
        raise ResolveLockUnsupported("전송 락 경로가 안전하지 않습니다")
    return path


_host_id_cache: dict[str, str] = {}


def host_id() -> str:
    """PC 식별자. 다른 PC 소유 claim 을 훔치지 않기 위한 판단 근거(명세 §2.7).

    프로세스 수명 동안 바뀌지 않으므로 한 번만 읽는다(claim 마다 파일 I/O 하지 않는다).
    """
    path = _resolve_root() / "host-id"
    cached = _host_id_cache.get(str(path))
    if cached:
        return cached
    try:
        current = path.read_text(encoding="utf-8").strip()
    except OSError:
        current = ""
    if not current:
        current = uuid.uuid4().hex
        try:
            atomic_write_text(path, current + "\n")
            current = path.read_text(encoding="utf-8").strip() or current
        except OSError:
            return current
    _host_id_cache[str(path)] = current
    return current


def self_test(directory: Path | None = None) -> tuple[bool, str]:
    """'첫 락 성공, 둘째 락 실패'를 두 핸들로 확인한다(명세 §2.2).

    Windows 의 ``LockFileEx``는 핸들 단위라 같은 프로세스의 두 번째 핸들도 거절되므로
    이 검사가 다른 프로세스와 동일한 의미를 갖는다. POSIX 의 ``fcntl`` 잠금은 프로세스
    단위여서 이 검사가 실패하고, 그 결과 v3 워커가 켜지지 않는다(운영은 Windows 전용).
    """
    target = Path(directory) if directory is not None else machine_lock_path().parent
    path = target / "locking-self-test.lock"
    first = FileLock(path)
    try:
        first.acquire()
    except ResolveLockUnsupported as exc:
        return False, str(exc)
    except OSError as exc:
        return False, f"락 파일을 열 수 없습니다: {exc}"
    try:
        second = FileLock(path)
        try:
            second.acquire()
        except ResolveLockBusy:
            return True, ""
        except (ResolveLockUnsupported, OSError) as exc:
            return False, str(exc)
        second.release()
        return False, "같은 파일을 두 번 잠글 수 있습니다(byte-range 잠금 미지원)"
    finally:
        first.release()


# manifest 루트(대개 NAS/SMB)별 self-test 결과. 로컬 CONTENT_HUB_DATA 가 잠금을 지원해도
# 실제 manifest 가 놓이는 공유 폴더는 지원하지 않을 수 있어, 그 루트에서 직접 검사한다.
_ROOT_SELF_TEST: dict[str, tuple[bool, str]] = {}
_ROOT_SELF_TEST_GUARD = threading.Lock()
_ROOT_SELF_TEST_MAX = 256


def root_self_test(manifest_root: Path) -> tuple[bool, str]:
    """실제 manifest 루트에서 byte-range 잠금이 동작하는지 루트당 1회 검사한다(§2.2).

    실패한 루트는 v3 접수·드레인을 거부해야 한다. best-effort 폴백은 두지 않는다 —
    잠금이 없는 저장소에서 큐를 돌리면 이중 드레인을 막을 수단이 사라진다.
    """
    try:
        target = locks_dir(Path(manifest_root))
    except ResolveLockUnsupported as exc:
        return False, str(exc)
    key = os.path.normcase(os.path.abspath(str(target)))
    with _ROOT_SELF_TEST_GUARD:
        cached = _ROOT_SELF_TEST.get(key)
    if cached is not None:
        return cached
    result = self_test(target)
    with _ROOT_SELF_TEST_GUARD:
        if len(_ROOT_SELF_TEST) >= _ROOT_SELF_TEST_MAX:
            _ROOT_SELF_TEST.clear()
        _ROOT_SELF_TEST[key] = result
    return result


def reset_root_self_test() -> None:
    """검사 결과 기억을 비운다(저장소 교체·테스트용)."""
    with _ROOT_SELF_TEST_GUARD:
        _ROOT_SELF_TEST.clear()

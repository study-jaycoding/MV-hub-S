"""Windows Job Object 하나 — 자식 프로세스와 그 후손을 통째로 소유한다.

Resolve 선택 작업자 회수(resolve_selection_monitor)가 쓴다. 직접 자식은 venv 실행기일 수 있고(실행기 → 진짜 파이썬),
작업자가 불러온 확장이 후손을 만들 수도 있어, 직접 자식의 종료나 stdout 파이프만으로는 '다 끝났다'를 확정하지 못한다.
Job 은 (1) 한 번에 트리 전체를 끝내고 (2) 남은 프로세스 수를 OS 에 물어 종료를 확인하고 (3) 이 핸들이 닫히면(허브가
어떻게 죽든) 남은 것을 OS 가 끝낸다(KILL_ON_JOB_CLOSE).

자식은 **멈춘 채로 만들어**(CREATE_SUSPENDED) Job 에 넣은 뒤 풀어야 한다 — 먼저 돌게 두면 Job 에 넣기 전에 만든 후손이 밖에 남는다.
"""

from __future__ import annotations

import ctypes
import errno
import os
import subprocess
import threading
import time
from ctypes import wintypes

CREATE_SUSPENDED = 0x00000004

_JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000
_JobObjectBasicAccountingInformation = 1
_JobObjectExtendedLimitInformation = 9
_PROCESS_TERMINATE = 0x0001
_PROCESS_SET_QUOTA = 0x0100
_PROCESS_SUSPEND_RESUME = 0x0800


class _BasicLimit(ctypes.Structure):
    _fields_ = [
        ("PerProcessUserTimeLimit", ctypes.c_int64),
        ("PerJobUserTimeLimit", ctypes.c_int64),
        ("LimitFlags", wintypes.DWORD),
        ("MinimumWorkingSetSize", ctypes.c_size_t),
        ("MaximumWorkingSetSize", ctypes.c_size_t),
        ("ActiveProcessLimit", wintypes.DWORD),
        ("Affinity", ctypes.c_size_t),
        ("PriorityClass", wintypes.DWORD),
        ("SchedulingClass", wintypes.DWORD),
    ]


class _IoCounters(ctypes.Structure):
    _fields_ = [(name, ctypes.c_uint64) for name in (
        "ReadOperationCount", "WriteOperationCount", "OtherOperationCount",
        "ReadTransferCount", "WriteTransferCount", "OtherTransferCount",
    )]


class _ExtendedLimit(ctypes.Structure):
    _fields_ = [
        ("BasicLimitInformation", _BasicLimit),
        ("IoInfo", _IoCounters),
        ("ProcessMemoryLimit", ctypes.c_size_t),
        ("JobMemoryLimit", ctypes.c_size_t),
        ("PeakProcessMemoryUsed", ctypes.c_size_t),
        ("PeakJobMemoryUsed", ctypes.c_size_t),
    ]


class _BasicAccounting(ctypes.Structure):
    _fields_ = [
        ("TotalUserTime", ctypes.c_int64),
        ("TotalKernelTime", ctypes.c_int64),
        ("ThisPeriodTotalUserTime", ctypes.c_int64),
        ("ThisPeriodTotalKernelTime", ctypes.c_int64),
        ("TotalPageFaultCount", wintypes.DWORD),
        ("TotalProcesses", wintypes.DWORD),
        ("ActiveProcesses", wintypes.DWORD),
        ("TotalTerminatedProcesses", wintypes.DWORD),
    ]


def _api():
    """핸들을 64비트로 주고받게 형을 박아 둔 kernel32·ntdll(형을 안 박으면 핸들이 32비트로 잘린다)."""
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    ntdll = ctypes.WinDLL("ntdll")
    kernel32.CreateJobObjectW.argtypes = [ctypes.c_void_p, wintypes.LPCWSTR]
    kernel32.CreateJobObjectW.restype = wintypes.HANDLE
    kernel32.SetInformationJobObject.argtypes = [wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD]
    kernel32.SetInformationJobObject.restype = wintypes.BOOL
    kernel32.QueryInformationJobObject.argtypes = [wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD, ctypes.c_void_p]
    kernel32.QueryInformationJobObject.restype = wintypes.BOOL
    kernel32.AssignProcessToJobObject.argtypes = [wintypes.HANDLE, wintypes.HANDLE]
    kernel32.AssignProcessToJobObject.restype = wintypes.BOOL
    kernel32.TerminateJobObject.argtypes = [wintypes.HANDLE, wintypes.UINT]
    kernel32.TerminateJobObject.restype = wintypes.BOOL
    kernel32.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    kernel32.OpenProcess.restype = wintypes.HANDLE
    kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
    kernel32.CloseHandle.restype = wintypes.BOOL
    ntdll.NtResumeProcess.argtypes = [wintypes.HANDLE]
    ntdll.NtResumeProcess.restype = ctypes.c_long
    return kernel32, ntdll


class ProcessJob:
    """프로세스 트리를 소유하는 Job 하나. 만들지 못하면 OSError.

    kill_on_close=True(기본): 핸들이 닫히면(이 프로세스가 어떻게 죽든) 남은 프로세스를 OS 가 끝낸다.
    False: 닫혀도 끝내지 않는다 — 도중에 끊으면 안 되는 트리를 '필요할 때만 통째로 끝내고 확인'하려고 쓴다.
    """

    def __init__(self, *, kill_on_close: bool = True) -> None:
        if os.name != "nt":
            raise OSError("Job Object 는 Windows 전용입니다")
        self._kernel32, self._ntdll = _api()
        self._handle = self._kernel32.CreateJobObjectW(None, None)
        if not self._handle:
            raise ctypes.WinError(ctypes.get_last_error())
        if not kill_on_close:
            return
        limits = _ExtendedLimit()
        limits.BasicLimitInformation.LimitFlags = _JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
        if not self._kernel32.SetInformationJobObject(
            self._handle, _JobObjectExtendedLimitInformation, ctypes.byref(limits), ctypes.sizeof(limits)
        ):
            error = ctypes.get_last_error()
            self.close()
            raise ctypes.WinError(error)

    def adopt_suspended(self, pid: int) -> None:
        """멈춘 채 만든(CREATE_SUSPENDED) 프로세스를 이 Job 에 넣고 푼다. 실패하면 OSError — 호출자가 그 프로세스를 끝낸다."""
        handle = self._kernel32.OpenProcess(_PROCESS_SET_QUOTA | _PROCESS_TERMINATE | _PROCESS_SUSPEND_RESUME, False, pid)
        if not handle:
            raise ctypes.WinError(ctypes.get_last_error())
        try:
            if not self._kernel32.AssignProcessToJobObject(self._handle, handle):
                raise ctypes.WinError(ctypes.get_last_error())
            status = self._ntdll.NtResumeProcess(handle)
            if status != 0:
                raise OSError(f"NtResumeProcess 실패(NTSTATUS {status & 0xFFFFFFFF:#x})")
        finally:
            self._kernel32.CloseHandle(handle)

    def active(self) -> int:
        """이 Job 에 살아 있는 프로세스 수. 물어볼 수 없으면 OSError(= 종료를 확인할 수 없다)."""
        if not self._handle:
            raise OSError("닫힌 Job 입니다")
        info = _BasicAccounting()
        if not self._kernel32.QueryInformationJobObject(
            self._handle, _JobObjectBasicAccountingInformation, ctypes.byref(info), ctypes.sizeof(info), None
        ):
            raise ctypes.WinError(ctypes.get_last_error())
        return int(info.ActiveProcesses)

    def terminate(self) -> None:
        """Job 안의 모든 프로세스를 끝낸다(요청만 — 끝났는지는 active() 로 확인)."""
        if self._handle and not self._kernel32.TerminateJobObject(self._handle, 1):
            raise ctypes.WinError(ctypes.get_last_error())

    def close(self) -> None:
        """핸들을 닫는다 — 남은 프로세스가 있으면 OS 가 끝낸다."""
        handle, self._handle = self._handle, None
        if handle:
            self._kernel32.CloseHandle(handle)

    def __del__(self) -> None:  # 참조를 잃어도 핸들이 새지 않게
        try:
            self.close()
        except Exception:  # noqa: BLE001
            pass


# ── 호출 하나의 자식 트리 — 끝나는 도우미 자식(Resolve 조회·변경)을 호출마다의 Job 이 소유한다 ─────────────────────────
_TREE_REAP_SECONDS = 5.0  # 제한 시간 뒤 트리 종료를 확인하는 기한
_TREE_TIDY_SECONDS = 2.0  # 그 뒤 직접 자식·파이프를 거두는 기한(종료 근거는 Job 이지 이 단계가 아니다)


def run_in_job(
    args: list[str], *, input_text: str | None = None, timeout: float | None = None, kill_on_close: bool = True, **popen: object
):
    """subprocess.run(capture_output=True) 과 같은 결과를 내되, 자식을 멈춘 채 만들어 이 호출만의 Job 에 넣은 뒤 푼다.

    · 제한 시간을 넘기면 **트리째** 끝내고(직접 자식이 venv 실행기여도 진짜 파이썬·후손까지) 남은 수 0 을 기한 안에 확인한 뒤
      TimeoutExpired 를 올린다. 정리에는 기한이 있다 — 후손이 출력 파이프를 쥐고 있어도 여기서 멈추지 않는다.
    · kill_on_close=True(조회): 이 프로세스(허브)가 어떻게 죽든 트리를 OS 가 끝낸다(Job 에 넣은 뒤부터). False(Resolve 를 바꾸는 자식):
      허브가 죽어도 끝까지 돈다(도중에 끊으면 프로젝트가 반쯤 바뀐 채 남는다) — **제한 시간 때만** 끝낸다.
    · 실행 전 실패(Job 을 만들거나 넣지 못함·입출력 스레드를 못 띄움)는 OSError — 그 자식은 한 줄도 돌지 않은 채 끝낸다. Job 없이 조용히 돌리지 않는다.
    · 실행 뒤 통신 오류는 ChildOutcomeUnknown(SubprocessError) — 자식이 이미 무언가 했을 수 있다. 조회 자식은 끝내고 변경 자식은 끊지 않는다.
      입출력은 communicate 가 아니라 이 모듈의 스레드(_Pump)가 맡는다 — 부른 쪽이 떠나도 입력을 끝까지 쓰고 닫으며 출력을 끝까지 받는다.
    · 끝내라고 한 트리가 끝난 것을 기한 안에 확인하지 못하면 그 자식·Job 을 붙들어 두고(_strays), 다음 호출이 다시 확인한다 —
      아직 살아 있으면 새 자식을 띄우지 않고 OSError.
    · Windows 가 아니면 subprocess.run 그대로(개발·시험용).
    """
    if os.name != "nt":
        return subprocess.run(args, check=False, capture_output=True, input=input_text, timeout=timeout, **popen)  # type: ignore[call-overload]
    _clear_strays()  # 앞선 호출이 종료를 확인하지 못한 트리가 아직 살아 있으면 여기서 OSError — 새 자식을 띄우지 않는다
    job = ProcessJob(kill_on_close=kill_on_close)
    try:
        flags = int(popen.pop("creationflags", 0)) | CREATE_SUSPENDED  # type: ignore[call-overload]
        process = subprocess.Popen(
            args, stdin=subprocess.PIPE if input_text is not None else None, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            creationflags=flags, **popen,  # type: ignore[arg-type]
        )
    except BaseException:
        job.close()  # 자식을 못 만들었다 — 빈 Job 핸들을 남기지 않는다
        raise
    # 입출력을 맡을 스레드는 자식을 **풀기 전에** 띄운다 — 못 띄우면 자식은 한 줄도 돌지 않은 채 끝낸다(실행 전 실패).
    # 자식이 돈 뒤에 입출력 주인을 새로 구하는 일이 없다: 부른 쪽이 어떻게 떠나든 이 스레드들이 입력을 끝까지 쓰고 닫으며 출력을 끝까지 받는다.
    try:
        pump = _Pump(process, input_text)
    except BaseException as error:
        job.close()
        _discard(None, process)
        if isinstance(error, RuntimeError):  # 스레드를 띄울 수 없음 — 호출자들이 아는 '실행할 수 없음'으로
            raise OSError(f"자식의 입출력 스레드를 띄우지 못했습니다: {error}") from error
        raise
    adopt_error, interrupt = _adopt(job, process.pid)
    if adopt_error is not None:
        # 넣기·풀기를 시작도 못 했거나(자식은 Job 밖), 넣기(Job 밖) 또는 풀기(Job 안)가 실패했다 — 어느 쪽이든 멈춘 채라 한 줄도 돌지 않았다.
        # 끝내고 끝난 것을 확인한다.
        try:
            in_job = not isinstance(adopt_error, _NeverAdopted) and job.active() > 0  # 시작도 못 했으면 Job 에 물을 것이 없다
        except OSError:
            in_job = False
        if not in_job:
            job.close()
        _discard(job if in_job else None, process)
        raise interrupt or adopt_error
    if interrupt is not None:
        # 자식은 풀렸고(돌기 시작했다) 부른 쪽은 그사이 중단됐다 — 기다리다 떠나는 것과 같은 규칙: 조회 자식은 끝내고 변경 자식은 끊지 않는다.
        if kill_on_close:
            _discard(job, process)
        else:
            job.close()
        raise interrupt
    try:
        pump.wait(args, timeout)
    except subprocess.TimeoutExpired:
        _discard(job, process)  # 제한 시간 — 조회든 변경이든 트리째 끝낸다
        raise
    except BaseException as error:
        # 부른 쪽이 기다리다 떠난다(중단 등) — 자식은 이미 돌았다(= 실행 전 실패가 아니다). 조회 자식은 끝내고, Resolve 를 바꾸는 자식은
        # 끊지 않는다: 스스로 끝나며 그동안 변경 문을 쥐고 있고, 입출력은 스레드들이 계속 맡는다(여기서 파이프를 건드리지 않는다).
        if kill_on_close:
            _discard(job, process)
        else:
            job.close()  # 끝내지 않는 Job — 닫아도 자식은 계속 돈다
        if isinstance(error, Exception):
            raise ChildOutcomeUnknown(f"자식과의 통신이 끊겨 결과를 알 수 없습니다: {error}") from error
        raise
    job.close()  # 조회 자식이 남긴 후손이 있으면 여기서 끝난다
    if pump.errors:  # 자식은 끝났지만 입력을 다 못 줬거나 출력을 다 못 받았다 — 결과를 믿을 수 없다
        raise ChildOutcomeUnknown(f"자식과의 통신이 끊겨 결과를 알 수 없습니다: {pump.errors[0]}") from pump.errors[0]
    return subprocess.CompletedProcess(args, process.returncode, pump.out[0], pump.err[0])


def _adopt(job: ProcessJob, pid: int) -> tuple[BaseException | None, BaseException | None]:
    """넣기·풀기를 별도 스레드에서 끝까지 한다. 돌려주는 것 = (넣기·풀기의 오류 또는 None, 기다리던 부른 쪽이 받은 중단 또는 None).

    부른 스레드의 중단(KeyboardInterrupt — 주 스레드에만 온다)이 '풀기 직전·직후' 사이에 끼면 자식이 풀렸는지 알 수 없게 된다:
    풀린 변경 자식을 끝내도, 안 풀린 자식을 주인 없이 두어도 틀리다. 그래서 넣기·풀기(짧은 시스템 호출 셋)는 중단이 닿지 않는 스레드가
    마치고, 부른 쪽은 중단되더라도 그 결과를 본 뒤에 판단한다 — 오류가 없으면 자식은 풀렸고, 있으면 멈춘 채다.
    스레드를 띄우는 단계도 같다: 못 띄웠거나, 띄우는 도중 중단됐는데 작업자가 뜨지 않았으면 _NeverAdopted(멈춘 채), 떴으면 끝까지 기다린다.
    (기한보다 늦게 뜬 작업자는 '취소됨'을 보고 아무것도 하지 않는다 — 부른 쪽이 끝내는 자식을 뒤늦게 풀지 않는다.)
    """
    outcome: list[BaseException] = []
    started, done = threading.Event(), threading.Event()  # 스레드의 상태(join·is_alive)에 기대지 않고 작업자가 직접 알린다

    lock = threading.Lock()
    cancelled: list[bool] = []  # 부른 쪽이 '뜨지 않았다'로 판정했다 — 뒤늦게 뜬 작업자는 아무것도 하지 않고 물러난다

    def work() -> None:
        with lock:
            if cancelled:
                return
            started.set()
        try:
            job.adopt_suspended(pid)
        except BaseException as error:  # noqa: BLE001
            outcome.append(error)
        finally:
            done.set()

    interrupt: BaseException | None = None
    try:
        threading.Thread(target=work, name="resolve-child-adopt", daemon=True).start()
    except RuntimeError as error:  # 스레드를 띄울 수 없다 — 작업자는 돌지 않았다
        return _NeverAdopted(f"자식을 Job 에 넣을 스레드를 띄우지 못했습니다: {error}"), None
    except BaseException as error:  # noqa: BLE001 - 시작하는 도중의 중단: 작업자가 떴는지 모른다 → 잠깐 기다려 본다
        interrupt = error
        try:
            _wait(started, _ADOPT_START_SECONDS)
        except BaseException:  # noqa: BLE001 - 또 중단됐다 — 지금 떴는지만 본다
            pass
        with lock:  # 판정과 작업자의 시작이 엇갈리지 않게
            if not started.is_set():
                cancelled.append(True)
                return _NeverAdopted("자식을 Job 에 넣기 전에 중단됐습니다"), interrupt  # 뜨지 않았다 — 자식은 멈춘 채다
    while not done.is_set():
        try:
            _wait(done, None)
        except BaseException as error:  # noqa: BLE001 - 넣기·풀기가 끝난 것을 본 뒤에 올린다(부른 쪽에서)
            interrupt = interrupt or error
    return (outcome[0] if outcome else None), interrupt


_ADOPT_START_SECONDS = 1.0  # 시작 도중 중단됐을 때 작업자가 떴는지 기다려 보는 시간(떴다면 수 ms 안에 알린다)


class _NeverAdopted(OSError):
    """넣기·풀기를 시작하지도 못했다 — 자식은 Job 밖에서 멈춘 채다(한 줄도 돌지 않았다)."""


def _wait(event: threading.Event, seconds: float | None) -> bool:
    return event.wait(seconds)


class _Pump:
    """자식 하나의 입출력 주인 — 입력을 쓰고 닫는 스레드 하나, stdout·stderr 를 끝(EOF)까지 받는 스레드 둘(모두 데몬).

    스레드를 하나라도 못 띄우면 RuntimeError(부른 쪽이 아직 멈춰 있는 자식을 끝낸다 — 이미 뜬 스레드는 파이프가 닫히며 끝난다).
    입력 스레드는 실패해도 stdin 을 닫는다(입력 끝을 기다리는 자식이 변경 문을 쥔 채 남지 않게). 출력 스레드는 읽다 실패해도
    남은 것을 받아 버린 뒤에야 닫는다(자식이 꽉 찬 파이프에 막히지 않게). 실패는 errors 에 남긴다.
    """

    def __init__(self, process, input_text) -> None:
        self.process = process
        self.out: list = []
        self.err: list = []
        self.errors: list[BaseException] = []
        self.threads = [
            threading.Thread(target=self._read, args=(process.stdout, self.out), name="resolve-child-stdout", daemon=True),
            threading.Thread(target=self._read, args=(process.stderr, self.err), name="resolve-child-stderr", daemon=True),
        ]
        if process.stdin is not None and input_text is not None:
            self.threads.append(threading.Thread(target=self._write, args=(process.stdin, input_text), name="resolve-child-stdin", daemon=True))
        for thread in self.threads:
            thread.start()

    def _write(self, stream, text) -> None:
        # 쓰기와 닫기(남은 버퍼를 내보낸다) 둘 다 입력 전달이다 — 같은 기준으로 가린다. 쓰기가 실패해도 닫기는 한다.
        for step in (lambda: stream.write(text), stream.close):
            try:
                step()
            except BrokenPipeError:
                pass  # 자식이 입력을 다 읽지 않고 끝났다 — subprocess 와 같게 오류로 치지 않는다
            except OSError as error:
                # Windows 는 같은 경우에 EINVAL 을 주기도 한다(bpo-19612) — 문지기가 입력을 읽지 않고 75 로 끝난 것을 '결과 미확인'으로 만들지 않는다
                if error.errno != errno.EINVAL:
                    self.errors.append(error)
            except Exception as error:  # noqa: BLE001
                self.errors.append(error)

    def _read(self, stream, sink: list) -> None:
        try:
            sink.append(stream.read())
        except Exception as error:  # noqa: BLE001
            self.errors.append(error)
            sink.append(None)
            try:
                raw = getattr(stream, "buffer", stream)
                while raw.read(65536):
                    pass
            except Exception:  # noqa: BLE001
                pass
        finally:
            try:
                stream.close()
            except OSError:
                pass

    def wait(self, args, timeout: float | None) -> None:
        """입출력이 끝나고(= 파이프를 쥔 프로세스가 모두 끝남) 직접 자식이 끝날 때까지 기다린다. 기한을 넘기면 TimeoutExpired."""
        deadline = None if timeout is None else time.monotonic() + timeout
        for thread in self.threads:
            thread.join(None if deadline is None else max(0.0, deadline - time.monotonic()))
            if thread.is_alive():
                raise subprocess.TimeoutExpired(args, timeout)
        self.process.wait(None if deadline is None else max(0.0, deadline - time.monotonic()))


class ChildOutcomeUnknown(subprocess.SubprocessError):
    """자식이 시작된 뒤 통신 오류로 결과를 받지 못했다 — '실행하지 못함'이 아니다(이미 무언가 했을 수 있다)."""


class PreviousChildUnconfirmed(OSError):
    """앞선 자식 트리가 끝났는지 아직 확인하지 못해 새 자식을 띄우지 않았다 — 인터프리터·실행 파일 문제가 아니다."""


# 끝내라고 했는데 끝난 것을 확인하지 못한 트리 — (Job 또는 None, 직접 자식). 잊지 않고 다음 호출 때 다시 확인한다.
_strays: list[tuple[ProcessJob | None, object]] = []
_strays_lock = threading.Lock()


def _alive(job: ProcessJob | None, process) -> bool:
    """트리가 아직 살아 있나 — Job 이 소유하면 Job 에 묻고(물을 수 없으면 살아 있다고 본다), 아니면 직접 자식만 본다."""
    if job is not None:
        try:
            return job.active() > 0
        except OSError:
            return True
    return process.poll() is None


def _end(job: ProcessJob | None, process) -> None:
    """끝내라고 요청만 한다(끝났는지는 _alive 로 확인)."""
    try:
        if job is not None:
            job.terminate()
        else:
            process.kill()
    except OSError:
        pass


def _discard(job: ProcessJob | None, process) -> bool:
    """트리를 끝내고 끝난 것을 기한(_TREE_REAP_SECONDS) 안에 확인한다. 확인하면 직접 자식·파이프·Job 을 거두고 True.

    확인하지 못하면 False — 자식과 Job 을 놓지 않고 _strays 에 붙들어 둔다(Job 은 닫지 않는다: 닫으면 다시 물을 수 없다).
    기한 없는 대기는 없다.
    """
    _end(job, process)
    deadline = time.monotonic() + _TREE_REAP_SECONDS
    while _alive(job, process):
        if time.monotonic() >= deadline:
            with _strays_lock:
                _strays.append((job, process))
            return False
        time.sleep(0.02)
    _reclaim(job, process)
    return True


def _reclaim(job: ProcessJob | None, process) -> None:
    """끝난 것이 확인된 트리의 직접 자식을 거두고 파이프·Job 을 닫는다."""
    try:
        process.wait(timeout=_TREE_TIDY_SECONDS)
    except (subprocess.TimeoutExpired, OSError):
        pass
    for stream in (process.stdin, process.stdout, process.stderr):
        if stream is not None:
            try:
                stream.close()
            except OSError:
                pass
    if job is not None:
        job.close()


def _clear_strays() -> None:
    """붙들어 둔 트리를 다시 확인한다 — 끝났으면 거두고, 아직 살아 있으면 다시 끝내라고 한 뒤 OSError.

    미확인 트리를 **확인한 뒤의** 새 실행을 막는다 — 실패가 되풀이돼도 호출마다 하나씩 쌓이지 않는다. 이미 함께 돌던 호출들이
    저마다 미확인으로 끝나면 그 트리들은 모두 붙든다(동시에 도는 정상 호출을 한 줄로 세우지 않는다).
    """
    with _strays_lock:
        for entry in list(_strays):
            job, process = entry
            if _alive(job, process):
                _end(job, process)
                continue
            _strays.remove(entry)
            _reclaim(job, process)
        if _strays:
            raise PreviousChildUnconfirmed("앞선 Resolve 자식의 종료를 아직 확인하지 못했습니다")


# ── 이름 붙은 뮤텍스 — '쥐고 있는가'(소유)로 배제한다 ──────────────────────────────────────────────────────────
# 핸들이 열려 있는지(존재)가 아니라 소유를 본다 — 잠깐 열어 보는 쪽 때문에 '바쁨'으로 잘못 답하지 않는다.
# 쥔 프로세스가 죽으면 OS 가 풀어 준다(다음에 쥐는 쪽이 WAIT_ABANDONED 로 넘겨받는다).
RESOLVE_MUTATION_MUTEX = "Local\\MVHub_Resolve_Mutation"
_WAIT_OBJECT_0 = 0x0
_WAIT_ABANDONED = 0x80
_WAIT_TIMEOUT = 0x102


class NamedMutex:
    """이름 붙은 뮤텍스 하나. acquire/release 는 **같은 스레드**에서 부른다(Windows 뮤텍스의 소유는 스레드 단위). Windows 가 아니면 배제 없음."""

    def __init__(self, name: str) -> None:
        self._handle = None
        self._closed = False
        if os.name != "nt":
            return
        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel32.CreateMutexW.argtypes = [ctypes.c_void_p, wintypes.BOOL, wintypes.LPCWSTR]
        kernel32.CreateMutexW.restype = wintypes.HANDLE
        kernel32.WaitForSingleObject.argtypes = [wintypes.HANDLE, wintypes.DWORD]
        kernel32.WaitForSingleObject.restype = wintypes.DWORD
        kernel32.ReleaseMutex.argtypes = [wintypes.HANDLE]
        kernel32.ReleaseMutex.restype = wintypes.BOOL
        kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
        kernel32.CloseHandle.restype = wintypes.BOOL
        self._kernel32 = kernel32
        self._handle = kernel32.CreateMutexW(None, False, name)
        if not self._handle:
            raise ctypes.WinError(ctypes.get_last_error())

    def acquire(self, wait_seconds: float = 0.0) -> bool:
        """쥔다. 다른 스레드·프로세스가 쥐고 있어 wait_seconds 안에 못 쥐면 False. 판정할 수 없으면 OSError."""
        if self._closed:
            raise OSError("닫힌 뮤텍스는 쥘 수 없습니다")
        if self._handle is None:
            return True
        result = self._kernel32.WaitForSingleObject(self._handle, max(0, int(wait_seconds * 1000)))
        if result in (_WAIT_OBJECT_0, _WAIT_ABANDONED):
            return True
        if result == _WAIT_TIMEOUT:
            return False
        raise ctypes.WinError(ctypes.get_last_error())

    def release(self) -> None:
        """소유를 푼다(핸들은 그대로 — 다시 쥘 수 있다). 이 스레드가 쥐고 있지 않으면 OSError."""
        if self._closed:
            raise OSError("닫힌 뮤텍스는 풀 수 없습니다")
        if self._handle is not None and not self._kernel32.ReleaseMutex(self._handle):
            raise ctypes.WinError(ctypes.get_last_error())

    def close(self) -> None:
        """핸들만 닫는다 — **소유는 풀지 않는다**(다른 핸들이 열려 있으면 쥔 스레드가 끝날 때까지 쥔 채다). 풀려면 쥔 스레드에서
        먼저 release 한다. 닫은 뒤의 acquire/release 는 OSError. 소멸자도 핸들만 닫는다(쥔 스레드에서 돈다는 보장이 없다)."""
        self._closed = True
        handle, self._handle = self._handle, None
        if handle:
            self._kernel32.CloseHandle(handle)

    def __del__(self) -> None:  # 참조를 잃어도 핸들이 새지 않게
        try:
            self.close()
        except Exception:  # noqa: BLE001
            pass


def resolve_mutation_gate() -> NamedMutex:
    """Resolve 를 바꾸는 작업과 선택 읽기가 프로세스 사이에서 겹치지 않게 쥐는 문. 이름은 부를 때의 RESOLVE_MUTATION_MUTEX(시험은 바꿔 쓴다)."""
    return NamedMutex(RESOLVE_MUTATION_MUTEX)


def new_process_job() -> ProcessJob | None:
    """Job 을 만든다. Windows 가 아니면 None(호출자는 Job 없는 길로 — 앱의 지원 대상은 Windows 라 그 길은 개발·시험용이다).

    Windows 에서 만들기·설정이 실패하면 OSError 를 그대로 올린다 — Job 없는 길로 조용히 내려가면 기한 없는 회수로 되돌아간다.
    호출자(선택 감시)는 그 실패를 자식 생성 실패로 다뤄 백오프 뒤 다시 시도한다.
    """
    if os.name != "nt":
        return None
    return ProcessJob()

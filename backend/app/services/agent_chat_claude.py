"""MV Agent 칸 — 이 PC 의 Claude 상태 판정·로그인 창·PC 전체 뮤텍스(설계 docs/status/AskAgent_첫연결_설계_2026-11-09.md 3·5·6절).

- 상태는 `claude --setting-sources local auth status` 하나로 본다. 로그아웃이면 종료 코드 1 이어도 JSON 이 오니 종료 코드로 버리지 않는다.
- 로그인은 사람이 보는 새 콘솔 창(`CREATE_NEW_CONSOLE | CREATE_BREAKAWAY_FROM_JOB`)이다 — 허브는 그 창을 Job 에 넣지도 끄지도 않는다
  (브라우저 자동 열기를 끄는 방법이 공식 문서에 없어서, 숨긴 프로세스로 띄우면 사용자 브라우저를 끌 수 있다). 스위치 기본 꺼짐.
- 같은 Claude 자격을 쓰는 허브들(dev·배포판, 기록 폴더를 따로 준 허브까지)은 이름 있는 뮤텍스 하나로 '차례'와 '로그인 창 만들기'를
  줄 세운다 — 이름·기록 위치는 자격 폴더(CLAUDE_CONFIG_DIR 또는 ~/.claude)로 정한다. 뮤텍스는 스레드 소유라 잡은 스레드가 놓는다.
  주인 기록(running|clean)은 정상·버려진 획득 모두에서 먼저 본다 — 살아 있는 허브의 정리 안 된 일이면 계속 막는다.
- 기록은 필수 필드·상태까지 검사한다. 깨졌거나 프로세스가 살았는지 확인 못 하면(열기 거절 포함) 막는 쪽이 기본이고, 확인된 근거가 있을 때만
  이어 간다 — 창 기록: 잠금 안에서 허브가 띄운 로그인 창(claude.exe … auth login)이 하나도 없음 · 주인 기록: 회수 안 된 차례 표식
  (이름 있는 이벤트 — 차례 잠금을 쥔 허브가 회수 확인 뒤 놓을 때까지 열어 둠, 허브가 죽으면 커널이 닫음)이 없음.
- 상태·기록·응답에 이메일·조직 id·경로를 싣지 않는다.
"""
from __future__ import annotations

import contextlib
import ctypes
import hashlib
import json
import os
import subprocess
import time
from ctypes import wintypes
from pathlib import Path
from typing import Callable

from .. import config
from . import agent_chat_process as process

MIN_VERSION = (2, 1, 268)  # auth status JSON 필드(configDirectory 등)가 문서와 맞는 판
PAID = frozenset({"pro", "max", "ultra", "team", "enterprise"})
FREE = frozenset({"free"})
CHAT_OK = frozenset({"ready", "subscription_unknown"})  # 허브(차례)·화면(입력칸) 공통 대화 허용 조건
LOGIN_OK = frozenset({"not_logged_in", "not_subscription", "no_plan"})  # [Claude 연결]을 보일 상태
FAST_MODELS = frozenset({"opus"})  # 빠른 모드 = Opus 5.5 만(문서)
STATUS_TIMEOUT = 30.0
MESSAGES = {
    "not_installed": "이 PC 에 Claude Code 가 없어요",
    "outdated": "Claude Code 를 업데이트해야 해요",
    "unknown": "Claude 상태를 확인하지 못했어요",
    "not_logged_in": "Claude 에 로그인되어 있지 않아요",
    "not_subscription": "구독 로그인이 아니에요(API 키 방식은 쓰지 않아요)",
    "no_plan": "이 계정엔 Claude Code 를 쓸 수 있는 구독이 없어요",
    "login_window": "Claude 로그인 창이 열려 있어요",
    "window_record": "로그인 창 상태를 확인하지 못했어요 — 열린 Claude 로그인 창을 닫고 [다시 확인]을 눌러 주세요",
}
LOGIN_MARK = " auth login"  # 허브가 띄운 로그인 창의 명령줄 표식(login_command)
CREATE_NEW_CONSOLE, CREATE_BREAKAWAY_FROM_JOB = 0x00000010, 0x01000000
_WAIT_OBJECT_0, _WAIT_ABANDONED, _WAIT_TIMEOUT = 0x0, 0x80, 0x102
_PROCESS_QUERY_LIMITED, _STILL_ACTIVE, _SYNCHRONIZE = 0x1000, 259, 0x00100000
_ERROR_FILE_NOT_FOUND, _ERROR_INVALID_PARAMETER = 2, 87
_held_windows: list[subprocess.Popen] = []  # 띄운 창의 Popen 을 쥐어 둔다(정리 경고만 막음 — 창을 끄지 않는다)


class Busy(Exception):
    """지금은 할 수 없다 — 사람 말 문구를 담는다."""

    def __init__(self, message: str, code: str = "busy"):
        super().__init__(message)
        self.code = code


class LoginDisabled(Exception):
    pass


class BreakawayDenied(Exception):
    """허브가 탈출을 허용하지 않는 Job 아래라 로그인 창을 Job 밖으로 띄울 수 없다 — 터미널 안내로 간다."""


class RecordUnreadable(Exception):
    pass


# ── 상태 판정 ──
def _auth_status(prefix: list[str]) -> dict | None:
    """JSON 상태(종료 코드와 상관없이) — 실행 실패·시간 초과·JSON 아님이면 None."""
    try:
        done = subprocess.run([*prefix, "--setting-sources", "local", "auth", "status"], capture_output=True,
                              stdin=subprocess.DEVNULL, text=True, encoding="utf-8", errors="replace", timeout=STATUS_TIMEOUT,
                              env=process.child_env(), cwd=str(_work_dir()),
                              creationflags=process.CREATE_NO_WINDOW if os.name == "nt" else 0)
    except (OSError, subprocess.TimeoutExpired):
        return None
    try:
        data = json.loads(done.stdout or "")
    except ValueError:
        return None
    return data if isinstance(data, dict) else None


def claude_state(prefix: list[str] | None) -> dict:
    """{state, version, subscription} — subscription 은 알려진 유료 종류의 표시 이름만(그 밖은 None)."""
    if not prefix:
        return {"state": "not_installed", "version": None, "subscription": None}
    version = process.cli_version(prefix)
    if not version:
        return {"state": "unknown", "version": None, "subscription": None}
    if process.version_tuple(version) < MIN_VERSION:
        return {"state": "outdated", "version": version, "subscription": None}
    data = _auth_status(prefix)
    if data is None:
        return {"state": "unknown", "version": version, "subscription": None}
    plan = str(data.get("subscriptionType") or "").strip().lower()
    if not data.get("loggedIn"):
        state = "not_logged_in"
    elif data.get("authMethod") != "claude.ai" or data.get("apiProvider") != "firstParty":
        state = "not_subscription"
    elif plan in PAID:
        state = "ready"
    elif plan in FREE:
        state = "no_plan"
    else:
        state = "subscription_unknown"  # 누락·모르는 값 — 막는 판정은 확인된 사실만
    try:
        if window_alive():  # 연결된 뒤에도 창이 닫힐 때까지는 창 상태 — 차례 잠금(창이 살아 있으면 거절)과 같은 판정
            state = "login_window"
    except RecordUnreadable:
        state = "window_record"
    return {"state": state, "version": version, "subscription": plan.capitalize() if state == "ready" else None}


def claude_problem(prefix: list[str] | None) -> str | None:
    """차례 허용 판정(engine_problem 의 Claude 쪽) — 화면의 입력칸 잠금과 같은 조건."""
    state = claude_state(prefix)["state"]
    return None if state in CHAT_OK else MESSAGES.get(state, MESSAGES["unknown"])


# ── 기록 파일(원자적 쓰기) ──
def _work_dir() -> Path:
    work = config.AGENT_CHAT_DIR / "work"
    work.mkdir(parents=True, exist_ok=True)
    return work


def _credential_dir() -> str:
    """Claude 자격이 사는 폴더(자식 환경 기준 — 차례·로그인·상태 확인이 보는 곳)."""
    env = process.child_env()
    raw = env.get("CLAUDE_CONFIG_DIR") or str(Path(env.get("USERPROFILE") or Path.home()) / ".claude")
    return os.path.normcase(os.path.abspath(os.path.expanduser(raw)))


def _scope() -> str:
    """잠금 이름·기록 이름의 열쇠 = 기록 위치 + 자격 폴더. 기록 위치는 사용자마다 하나라 같은 자격의 허브들이 같은 열쇠,
    시험은 임시 위치라 실제 허브와 겹치지 않는다."""
    key = f"{config.AGENT_CHAT_CLAUDE_DIR}\n{_credential_dir()}".casefold()
    return hashlib.sha256(key.encode("utf-8")).hexdigest()[:12]


def _owner_file() -> Path:
    return config.AGENT_CHAT_CLAUDE_DIR / f"{_scope()}-owner.json"


def _window_file() -> Path:
    return config.AGENT_CHAT_CLAUDE_DIR / f"{_scope()}-login.json"


def _id(value) -> bool:
    return type(value) is int and value > 0  # bool 은 int 의 하위형이라 type 으로 가른다


def _valid_window(data: dict) -> bool:
    status = data.get("status")
    if status == "open":
        return _id(data.get("pid")) and _id(data.get("start"))
    if status == "launching":
        return _id(data.get("hub_pid")) and _id(data.get("hub_start"))
    return status == "none"


def _valid_owner(data: dict) -> bool:
    return (data.get("status") in ("running", "clean") and data.get("kind") in ("turn", "login")
            and _id(data.get("pid")) and _id(data.get("start")))


def _read(path: Path, valid: Callable[[dict], bool]) -> dict | None:
    """없으면 None. 못 읽음·JSON 아님·필수 필드·상태가 어긋나면 RecordUnreadable — 모양만 맞는 기록이 막는 판정을 비켜 가지 않게."""
    try:
        raw = path.read_text(encoding="utf-8")
    except FileNotFoundError:
        return None
    except OSError as exc:
        raise RecordUnreadable(str(path.name)) from exc
    try:
        data = json.loads(raw)
    except ValueError as exc:
        raise RecordUnreadable(str(path.name)) from exc
    if not isinstance(data, dict) or not valid(data):
        raise RecordUnreadable(str(path.name))
    return data


def _write(path: Path, data: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_name(f"{path.name}.{os.getpid()}.tmp")
    temp.write_text(json.dumps(data), encoding="utf-8")
    os.replace(temp, path)


# ── 프로세스 생존(pid + 시작 시각 — 번호 재사용 구분) ──
def _k32():
    k32 = ctypes.WinDLL("kernel32", use_last_error=True)
    k32.OpenProcess.restype = wintypes.HANDLE
    k32.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    k32.GetProcessTimes.argtypes = [wintypes.HANDLE] + [ctypes.POINTER(wintypes.FILETIME)] * 4
    k32.GetExitCodeProcess.argtypes = [wintypes.HANDLE, ctypes.POINTER(wintypes.DWORD)]
    k32.CloseHandle.argtypes = [wintypes.HANDLE]
    k32.CreateMutexW.restype = wintypes.HANDLE
    k32.CreateMutexW.argtypes = [ctypes.c_void_p, wintypes.BOOL, wintypes.LPCWSTR]
    k32.WaitForSingleObject.argtypes = [wintypes.HANDLE, wintypes.DWORD]
    k32.WaitForSingleObject.restype = wintypes.DWORD
    k32.ReleaseMutex.argtypes = [wintypes.HANDLE]
    k32.CreateEventW.restype = wintypes.HANDLE
    k32.CreateEventW.argtypes = [ctypes.c_void_p, wintypes.BOOL, wintypes.BOOL, wintypes.LPCWSTR]
    k32.OpenEventW.restype = wintypes.HANDLE
    k32.OpenEventW.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.LPCWSTR]
    return k32


def _handle_start(k32, handle) -> int | None:
    created, exited, kernel, user = (wintypes.FILETIME() for _ in range(4))
    if not k32.GetProcessTimes(handle, ctypes.byref(created), ctypes.byref(exited), ctypes.byref(kernel), ctypes.byref(user)):
        return None
    return (created.dwHighDateTime << 32) | created.dwLowDateTime


def process_start(pid: int) -> int | None:
    """살아 있으면 생성 시각(FILETIME 정수), 끝났으면 None — 살았는지 확인하지 못하면(열기 거절 포함) RecordUnreadable(막는 쪽).
    '끝남'은 그런 번호가 없음(87)·종료 코드가 있음만. 시작 시각이 다르면 부른 쪽이 다른 프로세스로 본다."""
    k32 = _k32()
    handle = k32.OpenProcess(_PROCESS_QUERY_LIMITED, False, int(pid))
    if not handle:
        if ctypes.get_last_error() == _ERROR_INVALID_PARAMETER:  # 그런 번호 없음
            return None
        raise RecordUnreadable("process")
    try:
        code = wintypes.DWORD()
        if not k32.GetExitCodeProcess(handle, ctypes.byref(code)):
            raise RecordUnreadable("process")
        if code.value != _STILL_ACTIVE:
            return None
        start = _handle_start(k32, handle)
        if start is None:
            raise RecordUnreadable("process")
        return start
    finally:
        k32.CloseHandle(handle)


def _alive(pid: int, start: int) -> bool:
    return process_start(pid) == start  # 기록 모양(_valid_*)이 pid·start 를 양의 정수로 보장


def _me() -> dict:
    return {"pid": os.getpid(), "start": process_start(os.getpid())}


def _claude_command_lines() -> list[str] | None:
    """이 PC 에 떠 있는 claude.exe 들의 명령줄 — 조회 실패·못 읽는 줄이 하나라도 있으면 None(없다고 단정하지 않는다).
    run_agent_session._powershell_rows 와 같은 규칙: 출력 UTF-8 고정·0개는 '[]'·cmdlet 오류는 Stop."""
    script = ("$ErrorActionPreference='Stop'; [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); "
              "$rows = @(Get-CimInstance Win32_Process -Filter \"Name='claude.exe'\" | Select-Object ProcessId,CommandLine); "
              "if ($rows.Count) { $rows | ConvertTo-Json -Compress } else { '[]' }")
    powershell = Path(os.environ.get("SystemRoot") or r"C:\Windows") / "System32" / "WindowsPowerShell" / "v1.0" / "powershell.exe"
    try:
        done = subprocess.run([str(powershell), "-NoProfile", "-NonInteractive", "-Command", script], capture_output=True,
                              stdin=subprocess.DEVNULL, timeout=STATUS_TIMEOUT, creationflags=process.CREATE_NO_WINDOW)
        rows = json.loads(done.stdout.decode("utf-8")) if done.returncode == 0 else None
    except (OSError, subprocess.SubprocessError, ValueError):
        return None
    if rows is None:
        return None
    lines = [row.get("CommandLine") if isinstance(row, dict) else None for row in (rows if isinstance(rows, list) else [rows])]
    return None if any(not isinstance(line, str) or not line for line in lines) else lines


@contextlib.contextmanager
def _scope_lock():
    """같은 자격의 잠금을 기다리지 않고 잡아 본다(이미 잡은 스레드면 다시 잡힌다) — 못 잡으면 False."""
    k32 = _k32()
    handle = k32.CreateMutexW(None, False, mutex_name())
    if not handle:
        yield False
        return
    try:
        held = k32.WaitForSingleObject(handle, 0) in (_WAIT_OBJECT_0, _WAIT_ABANDONED)
        try:
            yield held
        finally:
            if held:
                k32.ReleaseMutex(handle)
    finally:
        k32.CloseHandle(handle)


def _window_alive_once() -> bool:
    record = _read(_window_file(), _valid_window)
    if not record or record["status"] == "none":
        return False
    if record["status"] == "open":
        return _alive(record["pid"], record["start"])
    return _alive(record["hub_pid"], record["hub_start"])  # launching — 만드는 허브가 살아 있나


def window_alive() -> bool:
    """이 PC 에 칸이 연 로그인 창이 살아 있나 — open = 창 프로세스, launching = 만드는 허브가 살아 있나.
    기록이 깨졌거나 살았는지 확인하지 못하면: 잠금 안에서 다시 보고(그새 다른 허브가 고쳐 썼을 수 있다), 그래도 모르면
    허브가 띄운 로그인 창(claude.exe … auth login)이 하나도 없음을 확인했을 때만 기록을 치운다. 그것도 못 하면 RecordUnreadable(막음)."""
    try:
        return _window_alive_once()
    except RecordUnreadable:
        pass
    with _scope_lock() as held:
        if held:
            try:
                return _window_alive_once()
            except RecordUnreadable:
                lines = _claude_command_lines()
                if lines is not None and not any(LOGIN_MARK in line for line in lines):
                    path = _window_file()
                    with contextlib.suppress(OSError):
                        os.replace(path, path.with_name(f"{path.name}.bad"))
                    return False
    raise RecordUnreadable("window")


def _marker_name() -> str:
    return f"Local\\MVHub.ClaudeTurn.{_scope()}"


def turn_work_alive() -> bool | None:
    """회수를 확인하지 못한 Claude 차례가 이 PC 의 어느 허브에 남아 있나(확인 못 하면 None). 차례 잠금을 쥔 허브는 회수를 확인하고
    놓을 때까지 이름 있는 이벤트를 열어 둔다 — 스레드가 놓지 못하고 죽으면 열린 채 남고, 허브가 죽으면 커널이 그 Job 과 함께 닫는다."""
    k32 = _k32()
    handle = k32.OpenEventW(_SYNCHRONIZE, False, _marker_name())
    if handle:
        k32.CloseHandle(handle)
        return True
    return False if ctypes.get_last_error() == _ERROR_FILE_NOT_FOUND else None


# ── PC 전체 뮤텍스 ──
def mutex_name() -> str:
    """같은 Claude 자격을 쓰는 허브들이 같은 이름(_scope)."""
    return f"Local\\MVHub.Claude.{_scope()}"


class ClaudeLock:
    """잡은 스레드가 놓는다. 차례는 띄울 때~회수 확인까지, 로그인은 창을 만들 때만."""

    def __init__(self, kind: str):
        self.kind = kind
        self._handle = None
        self._marker = None  # 차례만 — 회수 확인 뒤 놓을 때까지 열어 두는 표식(turn_work_alive)

    def acquire(self) -> None:
        k32 = _k32()
        handle = k32.CreateMutexW(None, False, mutex_name())
        if not handle:
            raise Busy("Claude 작업 잠금을 만들지 못했어요")
        result = k32.WaitForSingleObject(handle, 0)
        if result == _WAIT_TIMEOUT:
            k32.CloseHandle(handle)
            raise Busy("다른 MV Hub 에서 Claude 가 일하는 중이에요", "claude_busy")
        if result not in (_WAIT_OBJECT_0, _WAIT_ABANDONED):
            k32.CloseHandle(handle)
            raise Busy("Claude 작업 잠금을 확인하지 못했어요")
        try:
            # 정상·버려진 획득 모두 먼저 기록을 본다 — 살아 있는 허브의 정리 안 된 일이면 계속 막는다(죽은 허브면 커널이 그 Job 을 껐다)
            try:
                owner = _read(_owner_file(), _valid_owner)
                running = bool(owner) and owner["status"] == "running" and _alive(owner["pid"], owner["start"])
            except RecordUnreadable:
                # 기록이 깨졌거나 주인이 살았는지 모름 — 회수 안 된 차례가 어느 허브에도 없다는 표식 확인이 있을 때만 이어 간다(기록은 아래에서 새로 씀)
                if turn_work_alive() is not False:
                    raise Busy("이전 Claude 작업 기록을 확인하지 못했어요 — MV Hub 를 모두 다시 켜 주세요") from None
                running = False
            if running:
                raise Busy("이전 Claude 작업 정리를 확인하지 못했어요 — 그 MV Hub 를 다시 켜 주세요", "unclean")
            if self.kind == "turn":
                try:
                    if window_alive():
                        raise Busy("Claude 로그인 창이 열려 있어요 — 마치거나 닫은 뒤 보내 주세요", "login_window_open")
                except RecordUnreadable:
                    raise Busy(MESSAGES["window_record"]) from None
                self._marker = k32.CreateEventW(None, True, False, _marker_name())
                if not self._marker:
                    raise Busy("Claude 작업 표식을 만들지 못했어요")
            _write(_owner_file(), {**_me(), "kind": self.kind, "status": "running"})
        except BaseException:
            if self._marker:
                k32.CloseHandle(self._marker)
                self._marker = None
            k32.ReleaseMutex(handle)
            k32.CloseHandle(handle)
            raise
        self._handle = handle

    def release(self) -> None:
        """자기 일의 회수(Job 0개)를 확인한 뒤에만 부른다 — clean 을 쓰고 표식을 닫고 놓는다."""
        if not self._handle:
            return
        k32 = _k32()
        try:
            _write(_owner_file(), {**_me(), "kind": self.kind, "status": "clean"})
        finally:
            if self._marker:
                k32.CloseHandle(self._marker)
                self._marker = None
            k32.ReleaseMutex(self._handle)
            k32.CloseHandle(self._handle)
            self._handle = None


def would_block() -> str | None:
    """차례를 받기 전 빠른 확인(다른 허브 대화 중·로그인 창) — 실제 잡기는 차례 스레드가 한다(뮤텍스는 스레드 소유)."""
    try:
        if window_alive():
            return "Claude 로그인 창이 열려 있어요 — 마치거나 닫은 뒤 보내 주세요"
    except RecordUnreadable:
        return MESSAGES["window_record"]
    k32 = _k32()
    handle = k32.CreateMutexW(None, False, mutex_name())
    if not handle:
        return None
    try:
        result = k32.WaitForSingleObject(handle, 0)
        if result in (_WAIT_OBJECT_0, _WAIT_ABANDONED):
            k32.ReleaseMutex(handle)
            return None
        return "다른 MV Hub 에서 Claude 가 일하는 중이에요"
    finally:
        k32.CloseHandle(handle)


# ── 로그인 창 ──
def login_command(prefix: list[str]) -> list[str]:
    return [*prefix, "--setting-sources", "local", "auth", "login", "--claudeai"]  # --setting-sources 는 auth 앞(뒤면 모르는 옵션)


def _spawn_window(command: list[str]) -> subprocess.Popen:
    """새 콘솔·Job 밖·멈춘 채. 입출력은 넘기지 않는다(새 콘솔의 핸들 — 허브 로그로 주소·코드·이메일이 가지 않게)."""
    return subprocess.Popen(command, cwd=str(_work_dir()), env=process.child_env(), close_fds=True,
                            creationflags=CREATE_NEW_CONSOLE | CREATE_BREAKAWAY_FROM_JOB | process.CREATE_SUSPENDED)


def _resume(proc: subprocess.Popen) -> None:
    ntdll = ctypes.WinDLL("ntdll")
    ntdll.NtResumeProcess.argtypes = [wintypes.HANDLE]
    ntdll.NtResumeProcess.restype = ctypes.c_long
    if ntdll.NtResumeProcess(int(proc._handle)) != 0:
        raise OSError("로그인 창을 시작하지 못했어요")


def open_login_window(still_current: Callable[[], None]) -> None:
    """[Claude 연결] — 스위치가 켜졌고 연결이 필요한 상태일 때만. 순서: 잠금 → 상태·창 기록 판정(잠금 안에서 — 그새 다른 허브가
    연결했거나 창을 열었으면 안 연다) → 신원 재대조 → launching 기록 → 멈춘 채 생성 → open 기록(생성 핸들의 시작 시각) → 재개 → 놓기.
    open 기록·재개가 안 되면 멈춘 창을 끈다 — 추적 안 된 로그인은 실행되지 않는다."""
    if not config.AGENT_CHAT_LOGIN_WINDOW:
        raise LoginDisabled()
    prefix = process.engine_prefix("claude")  # 차례·엔진 목록과 같은 찾기
    lock = ClaudeLock("login")
    lock.acquire()
    try:
        state = claude_state(prefix)["state"]
        if state == "login_window":
            raise Busy("열린 로그인 창에서 마쳐 주세요", "login_window_open")
        if state == "window_record":
            raise Busy(MESSAGES["window_record"])
        if state not in LOGIN_OK:
            raise Busy(MESSAGES.get(state, MESSAGES["unknown"]), "not_needed")
        still_current()
        me = _me()
        _write(_window_file(), {"status": "launching", "hub_pid": me["pid"], "hub_start": me["start"], "at": time.time()})
        try:
            proc = _spawn_window(login_command(prefix))
        except OSError as exc:
            _write(_window_file(), {"status": "none", "at": time.time()})
            if getattr(exc, "winerror", None) == 5:  # 탈출을 허용하지 않는 Job 아래
                raise BreakawayDenied() from exc
            raise
        try:
            start = _handle_start(_k32(), int(proc._handle))  # 번호로 다시 열지 않는다 — 생성 핸들이 그 프로세스 자체
            if start is None:
                raise OSError("로그인 창 시작 시각을 읽지 못했어요")
            _write(_window_file(), {"status": "open", "pid": proc.pid, "start": start, "at": time.time()})
            _resume(proc)
        except BaseException:
            with contextlib.suppress(OSError):
                proc.kill()  # 멈춘 채 끈다 — 사람에게 보인 적 없는 창
            with contextlib.suppress(OSError):
                _write(_window_file(), {"status": "none", "at": time.time()})
            raise
        _held_windows.append(proc)
    finally:
        lock.release()

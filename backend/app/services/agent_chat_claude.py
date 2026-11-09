"""MV Agent 칸 — 이 PC 의 Claude 상태 판정·로그인 창·PC 전체 뮤텍스(설계 docs/status/AskAgent_첫연결_설계_2026-11-09.md 3·5·6절).

- 상태는 `claude --setting-sources local auth status` 하나로 본다. 로그아웃이면 종료 코드 1 이어도 JSON 이 오니 종료 코드로 버리지 않는다.
- 로그인은 사람이 보는 새 콘솔 창(`CREATE_NEW_CONSOLE | CREATE_BREAKAWAY_FROM_JOB`)이다 — 허브는 그 창을 Job 에 넣지도 끄지도 않는다
  (브라우저 자동 열기를 끄는 방법이 공식 문서에 없어서, 숨긴 프로세스로 띄우면 사용자 브라우저를 끌 수 있다). 스위치 기본 꺼짐.
- 같은 Claude 자격을 쓰는 허브들(dev·배포판)은 이름 있는 뮤텍스 하나로 '차례'와 '로그인 창 만들기'를 줄 세운다. 뮤텍스는 스레드 소유라
  잡은 스레드가 놓는다. 주인 기록(running|clean)은 정상·버려진 획득 모두에서 먼저 본다 — 살아 있는 허브의 정리 안 된 일이면 계속 막는다.
- 상태·기록·응답에 이메일·조직 id·경로를 싣지 않는다.
"""
from __future__ import annotations

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
    "window_record": "로그인 창 기록을 확인하지 못했어요 — 열린 Claude 로그인 창을 닫고 MV Hub 를 다시 켜 주세요",
}
CREATE_NEW_CONSOLE, CREATE_BREAKAWAY_FROM_JOB = 0x00000010, 0x01000000
_WAIT_OBJECT_0, _WAIT_ABANDONED, _WAIT_TIMEOUT = 0x0, 0x80, 0x102
_PROCESS_QUERY_LIMITED, _STILL_ACTIVE = 0x1000, 259
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
def version_tuple(value: str) -> tuple[int, ...]:
    parts = []
    for piece in (value or "").split("."):
        digits = "".join(ch for ch in piece if ch.isdigit())
        if not digits:
            break
        parts.append(int(digits))
    return tuple(parts)


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
    if version_tuple(version) < MIN_VERSION:
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
    if state in LOGIN_OK:
        try:
            if window_alive():
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


def _owner_file() -> Path:
    return config.AGENT_CHAT_DIR / "claude-owner.json"


def _window_file() -> Path:
    return config.AGENT_CHAT_DIR / "claude-login.json"


def _read(path: Path) -> dict | None:
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
    if not isinstance(data, dict):
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
    return k32


def process_start(pid: int) -> int | None:
    """살아 있으면 생성 시각(FILETIME 정수), 끝났거나 열 수 없으면 None."""
    k32 = _k32()
    handle = k32.OpenProcess(_PROCESS_QUERY_LIMITED, False, int(pid))
    if not handle:
        return None
    try:
        code = wintypes.DWORD()
        if not k32.GetExitCodeProcess(handle, ctypes.byref(code)) or code.value != _STILL_ACTIVE:
            return None
        created, exited, kernel, user = (wintypes.FILETIME() for _ in range(4))
        if not k32.GetProcessTimes(handle, ctypes.byref(created), ctypes.byref(exited), ctypes.byref(kernel), ctypes.byref(user)):
            return None
        return (created.dwHighDateTime << 32) | created.dwLowDateTime
    finally:
        k32.CloseHandle(handle)


def _alive(pid, start) -> bool:
    return isinstance(pid, int) and start is not None and process_start(pid) == start


def _me() -> dict:
    return {"pid": os.getpid(), "start": process_start(os.getpid())}


def window_alive() -> bool:
    """이 PC 에 칸이 연 로그인 창이 살아 있나 — open = 창 프로세스, launching = 만드는 허브가 살아 있나. 기록이 깨지면 RecordUnreadable."""
    record = _read(_window_file())
    if not record:
        return False
    if record.get("status") == "open":
        return _alive(record.get("pid"), record.get("start"))
    if record.get("status") == "launching":
        return _alive(record.get("hub_pid"), record.get("hub_start"))
    return False


# ── PC 전체 뮤텍스 ──
def mutex_name() -> str:
    """같은 기록 폴더를 쓰는 허브들(기본 = 이 사용자의 dev·배포판)이 같은 이름 — 시험은 임시 폴더라 겹치지 않는다."""
    digest = hashlib.sha256(str(config.AGENT_CHAT_DIR).casefold().encode("utf-8")).hexdigest()[:12]
    return f"Local\\MVHub.Claude.{digest}"


class ClaudeLock:
    """잡은 스레드가 놓는다. 차례는 띄울 때~회수 확인까지, 로그인은 창을 만들 때만."""

    def __init__(self, kind: str):
        self.kind = kind
        self._handle = None

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
                owner = _read(_owner_file())
            except RecordUnreadable:
                raise Busy("이전 Claude 작업 기록을 확인하지 못했어요 — MV Hub 를 다시 켜 주세요") from None
            if owner and owner.get("status") == "running" and _alive(owner.get("pid"), owner.get("start")):
                raise Busy("이전 Claude 작업 정리를 확인하지 못했어요 — 그 MV Hub 를 다시 켜 주세요", "unclean")
            if self.kind == "turn":
                try:
                    if window_alive():
                        raise Busy("Claude 로그인 창이 열려 있어요 — 마치거나 닫은 뒤 보내 주세요", "login_window_open")
                except RecordUnreadable:
                    raise Busy(MESSAGES["window_record"]) from None
            _write(_owner_file(), {**_me(), "kind": self.kind, "status": "running"})
        except BaseException:
            k32.ReleaseMutex(handle)
            k32.CloseHandle(handle)
            raise
        self._handle = handle

    def release(self) -> None:
        """자기 일의 회수(Job 0개)를 확인한 뒤에만 부른다 — clean 을 쓰고 놓는다."""
        if not self._handle:
            return
        k32 = _k32()
        try:
            _write(_owner_file(), {**_me(), "kind": self.kind, "status": "clean"})
        finally:
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
    """[Claude 연결] — 스위치가 켜졌고 연결이 필요한 상태일 때만. 순서: 잠금 → 창 기록 확인 → 신원 재대조 → launching 기록 →
    멈춘 채 생성 → open 기록 → 재개 → 놓기(추적 안 된 로그인은 실행되지 않는다)."""
    if not config.AGENT_CHAT_LOGIN_WINDOW:
        raise LoginDisabled()
    prefix = process.engine_prefix("claude")  # 차례·엔진 목록과 같은 찾기
    state = claude_state(prefix)["state"]
    if state == "login_window":
        raise Busy("열린 로그인 창에서 마쳐 주세요", "login_window_open")
    if state not in LOGIN_OK:
        raise Busy(MESSAGES.get(state, MESSAGES["unknown"]), "not_needed")
    lock = ClaudeLock("login")
    lock.acquire()
    try:
        try:
            if window_alive():
                raise Busy("열린 로그인 창에서 마쳐 주세요", "login_window_open")
        except RecordUnreadable:
            raise Busy(MESSAGES["window_record"]) from None
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
        _write(_window_file(), {"status": "open", "pid": proc.pid, "start": process_start(proc.pid), "at": time.time()})
        _held_windows.append(proc)
        _resume(proc)  # 실패하면 창은 멈춘 채 open 으로 남아 사람이 닫을 때까지 막는다
    finally:
        lock.release()

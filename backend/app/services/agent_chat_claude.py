"""MV Agent 칸 — 이 PC 의 Claude 상태 판정·로그인 창·PC 전체 뮤텍스(설계 docs/status/AskAgent_첫연결_설계_2026-11-09.md 3·5·6절).

- 상태는 `claude --setting-sources local auth status` 하나로 본다. 로그아웃이면 종료 코드 1 이어도 JSON 이 오니 종료 코드로 버리지 않는다.
- 로그인은 사람이 보는 새 콘솔 창(`CREATE_NEW_CONSOLE | CREATE_BREAKAWAY_FROM_JOB`)이다 — Job 에 남았으면 재개하지 않고 끈다
  (브라우저 자동 열기를 끄는 방법이 공식 문서에 없어서, 숨긴 프로세스로 띄우면 사용자 브라우저를 끌 수 있다). 스위치 기본 켜짐.
- 같은 Claude 자격을 쓰는 허브들(dev·배포판, 기록 폴더를 따로 준 허브까지)은 이름 있는 뮤텍스 하나로 '차례'와 '로그인 창 만들기'를
  줄 세운다 — 이름·기록 위치는 자격 폴더(CLAUDE_CONFIG_DIR 또는 ~/.claude)로 정한다. 뮤텍스는 스레드 소유라 잡은 스레드가 놓는다.
  주인 기록(running|clean)은 정상·버려진 획득 모두에서 먼저 본다 — 살아 있는 허브의 정리 안 된 일이면 계속 막는다.
- 기록은 필수 필드·상태까지 검사한다. 깨졌거나 프로세스가 살았는지 확인 못 하면(열기 거절 포함) 막는 쪽이 기본이고, 확인된 근거가 있을 때만
  이어 간다 — 창 기록: 잠금 안에서 허브가 띄운 로그인 창(claude.exe … auth login)이 하나도 없음 · 잠금을 얻을 때마다(주인 기록이
  있든 없든 깨졌든) 회수 안 된 차례 표식(이름 있는 이벤트 — 차례 잠금을 쥔 허브가 회수 확인 뒤 놓을 때까지 열어 둠, 허브가 죽으면
  커널이 닫음)이 없음을 먼저 확인한다.
- 상태·기록·응답에 이메일·조직 id·경로를 싣지 않는다.
"""
from __future__ import annotations

import contextlib
import ctypes
import hashlib
import json
import logging
import os
import platform
import re
import subprocess
import threading
import time
import urllib.request
from ctypes import wintypes
from pathlib import Path
from typing import Callable

from .. import config
from ..repo.agent_chat import app_custom_config_dir
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


class LoginUnsupported(Exception):
    def __init__(self, reason: str):
        self.reason = reason
        super().__init__(reason)


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
    shown = (_plan_display_name(data.get("email")) or plan.capitalize()) if state == "ready" else None
    return {"state": state, "version": version, "subscription": shown}


def _plan_display_name(email) -> str | None:
    """Claude 앱과 같은 요금제 이름(Ultra 등) — Claude Code 설정 `.claude.json` 의 oauthAccount.planDisplayName.
    `auth status` 의 subscriptionType 은 Ultra 를 'max' 로 답한다(2026-11-10 실측). 공식 문서에 없는 칸이라 없거나·글이 이상하거나·
    그 파일의 계정이 지금 로그인 계정(이메일)과 다르면 None(부르는 쪽이 옛 값으로). 이메일은 비교에만 쓰고 싣지 않는다."""
    if not isinstance(email, str) or not email.strip():
        return None
    env = process.child_env()
    folder = env.get("CLAUDE_CONFIG_DIR")
    path = Path(folder) / ".claude.json" if folder else Path(env.get("USERPROFILE") or Path.home()) / ".claude.json"
    try:
        account = json.loads(path.read_text(encoding="utf-8")).get("oauthAccount")
    except (OSError, ValueError, AttributeError):
        return None
    if not isinstance(account, dict) or str(account.get("emailAddress") or "").strip().casefold() != email.strip().casefold():
        return None
    name = account.get("planDisplayName")
    return name.strip() if isinstance(name, str) and re.fullmatch(r"[A-Za-z0-9 +._-]{1,24}", name.strip()) else None


# ── 최신 판(보여 주기만 — npm 레지스트리 공개 주소) ──
LATEST_URL = "https://registry.npmjs.org/@anthropic-ai/claude-code/latest"
_LATEST_OK, _LATEST_FAIL = 6 * 3600.0, 600.0
_latest_lock = threading.Lock()
_latest_cache: tuple[float, str | None] | None = None  # (다시 물을 때, 판 또는 실패 None)


def latest_version() -> str | None:
    """npm 의 latest 판 번호(숫자.숫자.숫자만) — 실패면 None. 성공은 6시간·실패는 10분 기억한다(서랍을 열 때마다 묻지 않게)."""
    global _latest_cache
    with _latest_lock:
        now = time.monotonic()
        if _latest_cache and now < _latest_cache[0]:
            return _latest_cache[1]
        found = None
        try:
            request = urllib.request.Request(LATEST_URL, headers={"User-Agent": "mvhub-agent-panel", "Accept": "application/json"})
            with urllib.request.urlopen(request, timeout=5) as response:
                value = json.loads(response.read(65536).decode("utf-8")).get("version")
            if isinstance(value, str) and re.fullmatch(r"\d{1,4}\.\d{1,4}\.\d{1,6}", value):
                found = value
        except (OSError, ValueError, AttributeError):
            found = None
        _latest_cache = (now + (_LATEST_OK if found else _LATEST_FAIL), found)
        return found


def claude_problem(prefix: list[str] | None) -> str | None:
    """차례 허용 판정(engine_problem 의 Claude 쪽) — 화면의 입력칸 잠금과 같은 조건."""
    state = claude_state(prefix)["state"]
    return None if state in CHAT_OK else MESSAGES.get(state, MESSAGES["unknown"])


# ── 기록 파일(원자적 쓰기) ──
def _work_dir() -> Path:
    work = config.AGENT_CHAT_DIR / "work"
    work.mkdir(parents=True, exist_ok=True)
    return work


# ── 대화 삭제 때 그 세션 파일만(설계 docs/status/MVAgent_서랍메뉴_2026-11-12.md 2-5) ──
_UUID = re.compile(r"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}")
_SESSION_PEEK_LINES = 50
_SESSION_PEEK_BYTES = 4 * 1024 * 1024


def _norm(value: str) -> str:
    return os.path.normcase(os.path.normpath(value))


def claude_home(env: dict, cwd: Path) -> str:
    """차례를 띄우는 바로 그 환경·작업 폴더의 Claude 자격 폴더 — CLAUDE_CONFIG_DIR 이 상대 경로면 자식 작업 폴더 기준
    (허브 위치 기준인 _credential_dir 와 다르다)."""
    raw = env.get("CLAUDE_CONFIG_DIR")
    base = Path(os.path.expanduser(raw)) if raw else Path(env.get("USERPROFILE") or Path.home()) / ".claude"
    if not base.is_absolute():
        base = Path(cwd) / base
    return os.path.normpath(str(base))


def _belongs(path: Path, session_id: str, cwd: str) -> bool:
    """세션 파일 앞 50줄 안에 sessionId 와 작업 폴더(cwd)가 이 칸의 그 세션으로 적힌 줄이 있나."""
    want = _norm(cwd)
    read = 0
    with path.open("r", encoding="utf-8", errors="replace") as handle:
        for _ in range(_SESSION_PEEK_LINES):
            line = handle.readline(_SESSION_PEEK_BYTES)
            if not line:
                return False
            read += len(line)
            if read > _SESSION_PEEK_BYTES:
                return False
            try:
                row = json.loads(line)
            except ValueError:
                continue
            if (isinstance(row, dict) and row.get("sessionId") == session_id and isinstance(row.get("cwd"), str)
                    and row["cwd"] and _norm(row["cwd"]) == want):
                return True
    return False


def delete_session_record(session_id: str | None, home: str | None, cwd: str | None) -> str:
    """deleted · not_found(근거 없음·이름 후보 0개/여럿·폴더 읽기 오류·내용 확인 실패 — 안 지움) · failed(지우다 실패).
    <home>/projects/*/<id>.jsonl 이름 후보가 정확히 하나이고, 보통 파일·실제 경로가 projects 안·내용 확인을 통과할 때만."""
    if not (session_id and _UUID.fullmatch(session_id) and home and cwd):
        return "not_found"
    projects = Path(home) / "projects"
    name = f"{session_id}.jsonl"
    found: list[Path] = []
    try:
        with os.scandir(projects) as entries:
            for entry in entries:
                if not entry.is_dir(follow_symlinks=False):
                    continue
                candidate = Path(entry.path) / name
                try:
                    os.lstat(candidate)
                except FileNotFoundError:
                    continue
                found.append(candidate)
    except OSError:  # 어느 폴더든 못 읽으면 '하나뿐'을 확정할 수 없다
        return "not_found"
    if len(found) != 1:
        return "not_found"
    target = found[0]
    try:
        if target.is_symlink() or not target.is_file():
            return "not_found"
        if Path(os.path.realpath(target)).parent.parent != Path(os.path.realpath(projects)):
            return "not_found"
        if not _belongs(target, session_id, cwd):
            return "not_found"
    except OSError:
        return "not_found"
    try:
        target.unlink()
    except OSError:
        return "failed"
    return "deleted"


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
    return (data.get("status") in ("running", "clean") and data.get("kind") in ("turn", "login", "desktop")
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
            # 정상·버려진 획득 모두 먼저 본다 — ① 회수 안 된 차례 표식(기록이 있든 없든 깨졌든): 있거나 모르면 막는다
            work = turn_work_alive()
            if work is None:
                raise Busy("이전 Claude 작업 표식을 확인하지 못했어요 — MV Hub 를 모두 다시 켜 주세요")
            if work:
                raise Busy("이전 Claude 작업 정리를 확인하지 못했어요 — MV Hub 를 모두 다시 켜 주세요", "unclean")
            # ② 주인 기록 — 살아 있는 허브의 정리 안 된 일이면 막는다(죽은 허브면 커널이 그 Job 을 껐다)
            try:
                owner = _read(_owner_file(), _valid_owner)
                running = bool(owner) and owner["status"] == "running" and _alive(owner["pid"], owner["start"])
            except RecordUnreadable:
                running = False  # 깨졌거나 주인이 살았는지 모름 — ①에서 회수 안 된 차례가 어느 허브에도 없음을 확인했다(기록은 아래에서 새로 씀)
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
def _login_token_problem() -> str | None:
    """현재 토큰과 그 Windows 세션의 로그인 사용자를 대조한다. 조회 실패는 허용하지 않는다."""
    if os.name != "nt":
        return "unknown"
    try:
        kernel = ctypes.WinDLL("kernel32", use_last_error=True)
        advapi = ctypes.WinDLL("advapi32", use_last_error=True)
        wts = ctypes.WinDLL("wtsapi32", use_last_error=True)
        kernel.GetCurrentProcess.restype = wintypes.HANDLE
        kernel.CloseHandle.argtypes = [wintypes.HANDLE]
        advapi.OpenProcessToken.argtypes = [wintypes.HANDLE, wintypes.DWORD, ctypes.POINTER(wintypes.HANDLE)]
        advapi.GetTokenInformation.argtypes = [wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD,
                                               ctypes.POINTER(wintypes.DWORD)]
        advapi.LookupAccountSidW.argtypes = [wintypes.LPCWSTR, ctypes.c_void_p, wintypes.LPWSTR,
                                           ctypes.POINTER(wintypes.DWORD), wintypes.LPWSTR,
                                           ctypes.POINTER(wintypes.DWORD), ctypes.POINTER(wintypes.DWORD)]
        wts.WTSQuerySessionInformationW.argtypes = [wintypes.HANDLE, wintypes.DWORD, ctypes.c_int,
                                                   ctypes.POINTER(ctypes.c_void_p), ctypes.POINTER(wintypes.DWORD)]
        wts.WTSFreeMemory.argtypes = [ctypes.c_void_p]
        wts.WTSFreeMemory.restype = None
        token = wintypes.HANDLE()
        if not advapi.OpenProcessToken(kernel.GetCurrentProcess(), 0x0008, ctypes.byref(token)):  # TOKEN_QUERY
            return "unknown"
        try:
            size, elevated, session = wintypes.DWORD(), wintypes.DWORD(), wintypes.DWORD()
            if not advapi.GetTokenInformation(token, 20, ctypes.byref(elevated), ctypes.sizeof(elevated), ctypes.byref(size)):
                return "unknown"
            if elevated.value:
                return "elevated"
            if not advapi.GetTokenInformation(token, 12, ctypes.byref(session), ctypes.sizeof(session), ctypes.byref(size)):
                return "unknown"
            if session.value == 0:
                return "service"
            advapi.GetTokenInformation(token, 1, None, 0, ctypes.byref(size))  # TokenUser 크기
            if not size.value:
                return "unknown"
            buffer = ctypes.create_string_buffer(size.value)
            if not advapi.GetTokenInformation(token, 1, buffer, size, ctypes.byref(size)):
                return "unknown"
            sid = ctypes.cast(buffer, ctypes.POINTER(ctypes.c_void_p))[0]
            name_size, domain_size, use = wintypes.DWORD(), wintypes.DWORD(), wintypes.DWORD()
            advapi.LookupAccountSidW(None, sid, None, ctypes.byref(name_size), None, ctypes.byref(domain_size), ctypes.byref(use))
            if not name_size.value or not domain_size.value:
                return "unknown"
            name = ctypes.create_unicode_buffer(name_size.value)
            domain = ctypes.create_unicode_buffer(domain_size.value)
            if not advapi.LookupAccountSidW(None, sid, name, ctypes.byref(name_size), domain,
                                           ctypes.byref(domain_size), ctypes.byref(use)):
                return "unknown"
            if not name.value or not domain.value or use.value != 1:  # SidTypeUser
                return "unknown"
            logged_in = []
            for info in (5, 7):  # WTSUserName · WTSDomainName(콘솔 대신 토큰 세션 — RDP 한 세션도 지원)
                memory, length = ctypes.c_void_p(), wintypes.DWORD()
                try:
                    if not wts.WTSQuerySessionInformationW(None, session, info, ctypes.byref(memory), ctypes.byref(length)):
                        return "unknown"
                    if not memory.value or length.value < ctypes.sizeof(ctypes.c_wchar):
                        return "unknown"
                    value = ctypes.wstring_at(memory, length.value // ctypes.sizeof(ctypes.c_wchar)).rstrip("\0")
                    if not value:
                        return "unknown"
                    logged_in.append(value.casefold())
                finally:
                    if memory.value:
                        wts.WTSFreeMemory(memory)
            return None if logged_in == [name.value.casefold(), domain.value.casefold()] else "other_user"
        finally:
            kernel.CloseHandle(token)
    except (OSError, AttributeError, ValueError, ctypes.ArgumentError):
        return "unknown"


def login_command(prefix: list[str]) -> list[str]:
    return [*prefix, "--setting-sources", "local", "auth", "login", "--claudeai"]  # --setting-sources 는 auth 앞(뒤면 모르는 옵션)


def _spawn_window(command: list[str]) -> subprocess.Popen:
    """새 콘솔·멈춘 채. Job 에 남았으면 재개하지 않고 끈다. 입출력은 넘기지 않는다(허브 로그로 주소·코드·이메일이 가지 않게)."""
    return subprocess.Popen(command, cwd=str(_work_dir()), env=process.child_env(), close_fds=True,
                            creationflags=CREATE_NEW_CONSOLE | CREATE_BREAKAWAY_FROM_JOB | process.CREATE_SUSPENDED)


def _in_any_job(handle) -> bool | None:
    try:
        kernel = _k32()
        kernel.IsProcessInJob.argtypes = [wintypes.HANDLE, wintypes.HANDLE, ctypes.POINTER(wintypes.BOOL)]
        kernel.IsProcessInJob.restype = wintypes.BOOL
        in_job = wintypes.BOOL()
        if kernel.IsProcessInJob(handle, None, ctypes.byref(in_job)):
            return bool(in_job.value)
    except (OSError, AttributeError, ctypes.ArgumentError):
        pass
    return None


def _window_trapped(proc) -> bool:
    return _in_any_job(int(proc._handle)) is not False


def _resume(proc: subprocess.Popen) -> None:
    ntdll = ctypes.WinDLL("ntdll")
    ntdll.NtResumeProcess.argtypes = [wintypes.HANDLE]
    ntdll.NtResumeProcess.restype = ctypes.c_long
    if ntdll.NtResumeProcess(int(proc._handle)) != 0:
        raise OSError("로그인 창을 시작하지 못했어요")


def desktop_installation() -> str:
    """현재 사용자의 MSIX 등록과 실제 Claude.exe를 함께 확인한다. 잔여 CLI 폴더는 설치 증거가 아니다."""
    if os.name != "nt":
        return "unknown"
    script = r"""$ErrorActionPreference = 'Stop'
try {
  $packages = @(Get-AppxPackage -Name '*Claude*')
  $found = $false
  foreach ($package in $packages) {
    $manifest = Get-AppxPackageManifest -Package $package.PackageFullName
    foreach ($application in $manifest.Package.Applications.Application) {
      $exe = [string]$application.Executable
      if ($exe -and [IO.Path]::GetFileName($exe) -ieq 'Claude.exe' -and
          (Test-Path -LiteralPath (Join-Path $package.InstallLocation $exe) -PathType Leaf)) { $found = $true }
    }
  }
  if ($found) { 'available' }
  elseif ($packages.Count -gt 0) { 'unknown' }
  elseif ((Test-Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\App Paths\Claude.exe') -or
          (Test-Path 'HKLM:\Software\Microsoft\Windows\CurrentVersion\App Paths\Claude.exe') -or
          (Test-Path -LiteralPath (Join-Path $env:LOCALAPPDATA 'AnthropicClaude\claude.exe'))) { 'unknown' }
  else { 'missing' }
} catch { 'unknown' }
"""
    try:
        done = subprocess.run(["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", script],
                              stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=10,
                              creationflags=process.CREATE_NO_WINDOW, env=process.child_env())
        value = done.stdout.strip()
        return value if done.returncode == 0 and value in ("available", "missing", "unknown") else "unknown"
    except (OSError, subprocess.TimeoutExpired):
        return "unknown"


def desktop_precheck(prefix, home, cwd, env) -> None:
    if app_custom_config_dir(home, env):
        raise Busy("기본 설정 폴더의 Claude 세션만 앱에서 열 수 있어요", "custom_config_dir")
    if os.name != "nt" or platform.machine().lower() not in ("amd64", "x86_64"):
        raise Busy("이 환경에서는 Claude 앱 열기를 지원하지 않아요", "unsupported")
    if _login_token_problem():
        raise Busy("Windows 실행 사용자를 확인하지 못했어요", "unsupported")
    if not prefix:
        raise Busy("Claude Code를 찾지 못했어요", "not_installed")
    state = claude_state(prefix)
    if not state.get("version") or process.version_tuple(state["version"]) < (2, 1, 285):
        raise Busy("Claude Code를 업데이트해 주세요", "outdated")
    if state["state"] not in CHAT_OK:
        raise Busy(MESSAGES.get(state["state"], MESSAGES["unknown"]), "not_subscription")
    if not home or not cwd or not Path(cwd).is_absolute() or not Path(cwd).is_dir() or not Path(home).is_dir():
        raise Busy("원래 세션 환경을 확인하지 못했어요", "environment_changed")
    if _norm(os.path.realpath(home)) != _norm(os.path.realpath(claude_home(env, Path(cwd)))):
        raise Busy("원래 세션 환경을 확인하지 못했어요", "environment_changed")
    installation = desktop_installation()
    if installation != "available":
        raise Busy("Claude 데스크톱 앱이 없어요" if installation == "missing" else "Claude 데스크톱 설치를 확인하지 못했어요",
                   "desktop_missing" if installation == "missing" else "desktop_unknown")


def _stop_desktop_launcher(proc) -> bool:
    try:
        if proc.poll() is None:
            proc.kill()
        proc.wait(timeout=5)
        return True
    except (OSError, subprocess.TimeoutExpired):
        return False


def open_desktop(prefix, session_id, cwd, env, still_current, before_resume) -> dict:
    """로그인 창과 별개 계약: 숨긴 새 콘솔, 표준 핸들 무지정. 재개 뒤 실패는 잠금 유지."""
    proc, resumed = None, False
    started, code, classification = time.monotonic(), None, "launch"
    try:
        still_current()
        startup = subprocess.STARTUPINFO()
        startup.dwFlags = subprocess.STARTF_USESHOWWINDOW
        startup.wShowWindow = subprocess.SW_HIDE
        proc = subprocess.Popen([*prefix, "--desktop", "--resume", session_id], cwd=cwd, env=env, shell=False,
                                close_fds=True, stdin=None, stdout=None, stderr=None, startupinfo=startup,
                                creationflags=CREATE_NEW_CONSOLE | process.CREATE_SUSPENDED | CREATE_BREAKAWAY_FROM_JOB)
        classification = "job"
        if _in_any_job(int(proc._handle)) is not False:
            raise BreakawayDenied()
        classification = "identify"
        start = _handle_start(_k32(), int(proc._handle))
        if start is None:
            raise OSError("launcher_identity_unknown")
        still_current()
        before_resume(proc.pid, start)
        # 호출 결과가 유실돼도 재개됐을 수 있으므로 호출 전부터 불확실한 상태다.
        resumed = True
        classification = "uncertain"
        _resume(proc)
        code = proc.wait(timeout=30)
        classification = "handed" if code == 0 else "uncertain"
        return {"phase": "handed" if code == 0 else "uncertain", "code": code}
    except BaseException as exc:
        stopped = proc is None or _stop_desktop_launcher(proc)
        if not isinstance(exc, (OSError, subprocess.TimeoutExpired, BreakawayDenied)):
            raise  # 신원·DB 오류는 호출자가 보존된 opening으로 회수한다.
        result = {"phase": "idle" if not resumed and stopped else "uncertain", "code": None}
        if not resumed:
            result["open_failed"] = classification
        return result
    finally:
        logging.getLogger(__name__).info("Claude desktop exit_code=%s classification=%s seconds=%.3f",
                                        code, classification, time.monotonic() - started)


def reap_desktop_launcher(launcher: dict) -> bool:
    """재시작 후 자동 재개 금지. 같은 PID·생성 시각의 실행기만 핸들로 정리한다."""
    if not isinstance(launcher, dict) or type(launcher.get("pid")) is not int or type(launcher.get("start")) is not int:
        return False
    try:
        kernel = _k32()
        handle = kernel.OpenProcess(_PROCESS_QUERY_LIMITED | _SYNCHRONIZE | 0x0001, False, launcher["pid"])
        if not handle:
            return ctypes.get_last_error() == _ERROR_INVALID_PARAMETER
        try:
            actual = _handle_start(kernel, handle)
            if actual != launcher["start"]:
                return actual is not None  # 번호가 재사용됐으면 원래 실행기는 끝났다. 새 프로세스는 건드리지 않는다.
            kernel.TerminateProcess.argtypes = [wintypes.HANDLE, wintypes.UINT]
            kernel.TerminateProcess.restype = wintypes.BOOL
            if kernel.WaitForSingleObject(handle, 0) == _WAIT_OBJECT_0:
                return True
            return bool(kernel.TerminateProcess(handle, 1)) and kernel.WaitForSingleObject(handle, 5000) == _WAIT_OBJECT_0
        finally:
            kernel.CloseHandle(handle)
    except (OSError, AttributeError, ctypes.ArgumentError):
        return False


def open_login_window(still_current: Callable[[], None]) -> None:
    """[Claude 연결] — 스위치가 켜졌고 연결이 필요한 상태일 때만. 순서: 잠금 → 상태·창 기록 판정(잠금 안에서 — 그새 다른 허브가
    연결했거나 창을 열었으면 안 연다) → 신원 재대조 → launching 기록 → 멈춘 채 생성 → Job 판정 → open 기록(생성 핸들의 시작 시각) → 재개 → 놓기.
    open 기록·재개가 안 되면 멈춘 창을 끈다 — 추적 안 된 로그인은 실행되지 않는다."""
    if not config.AGENT_CHAT_LOGIN_WINDOW:
        raise LoginDisabled()
    problem = _login_token_problem()
    if problem:
        raise LoginUnsupported(problem)
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
            if _window_trapped(proc):
                raise BreakawayDenied()
            start = _handle_start(_k32(), int(proc._handle))  # 번호로 다시 열지 않는다 — 생성 핸들이 그 프로세스 자체
            if start is None:
                raise OSError("로그인 창 시작 시각을 읽지 못했어요")
            _write(_window_file(), {"status": "open", "pid": proc.pid, "start": start, "at": time.time()})
            _resume(proc)
        except BaseException:
            try:
                proc.kill()
                proc.wait(timeout=5)
            except (OSError, subprocess.TimeoutExpired):
                pass  # 끝났음을 확인하지 못하면 launching 또는 open 기록을 그대로 둔다
            else:
                with contextlib.suppress(OSError):
                    _write(_window_file(), {"status": "none", "at": time.time()})
            raise
        _held_windows.append(proc)
    finally:
        lock.release()

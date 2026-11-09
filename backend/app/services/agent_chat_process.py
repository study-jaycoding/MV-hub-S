"""Ask Agent 칸 — CLI 찾기·명령·자식 환경·Windows Job(멈춘 채 생성 → 배정 → 재개) 실행기.

루트 런처(`run_agent_session.py`)는 import 하지 않는다 — 허브는 staged 판으로 돌고 런처는 루트에 남는 갱신 경계(CODE_MAP §5).
옵션 값은 0단계 실측(설계 문서 6-1)으로 고정한 것이다. 바꾸면 그 실측을 다시 돌린다.
"""
from __future__ import annotations

import ctypes
import json
import os
import shutil
import subprocess
import threading
import time
from ctypes import wintypes
from pathlib import Path

from .agent_chat_parse import CLAUDE_ALLOWED, MAX_LINE, PANEL_SERVER, PANEL_TOOLS

CREATE_SUSPENDED, CREATE_NO_WINDOW = 0x00000004, 0x08000000
_KILL_ON_JOB_CLOSE, _EXT_INFO, _PID_LIST = 0x00002000, 9, 3
# 자식이 구독 로그인이 아닌 요금 경로로 새지 않게 — API 키·제공자 전환·중첩 실행 표식을 뺀다(0단계 6-1 '인증').
_STRIP = {"ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL", "OPENAI_API_KEY", "OPENAI_BASE_URL",
          "CODEX_API_KEY", "ELECTRON_RUN_AS_NODE", "CLAUDECODE"}
_STRIP_PREFIX = ("CLAUDE_CODE_",)
# 0단계를 통과한 Codex 판 — 새 판은 기본으로 켜지는 기능(연결 앱 등)이 늘 수 있어 다시 점검하기 전엔 잠근다.
CODEX_VERIFIED = frozenset({"0.162.0-alpha.17.2"})
# Jay 11-09 "Claude 먼저": 0단계에 남은 Codex 격리 확인(훅 대조 시험·허용 밖 도구 3개)을 마칠 때까지 Codex 를 잠근다.
# 확인을 마치고 합의하면 None 으로 바꾼다(설계 문서 6-1·8절 6번).
CODEX_LOCK: str | None = "점검 필요 — 격리 확인(훅 대조·남은 도구)이 끝나지 않았습니다"
CODEX_FEATURES_OFF = ("apps", "multi_agent", "image_generation", "unified_exec", "shell_tool", "plugins", "remote_plugin",
                      "goals", "sleep_tool", "tool_suggest", "browser_use", "computer_use", "hooks",
                      "skill_mcp_dependency_install", "skill_search", "view_image")
MAX_STDERR = 64 * 1024
MAX_TOTAL = 32 * 1024 * 1024  # 한 차례 stdout 전체 상한 — 넘으면 끈다


class OutputLimit(Exception):
    """한 차례 출력이 상한을 넘었다."""


def child_env(base: dict | None = None) -> dict:
    env = dict(os.environ if base is None else base)
    for key in list(env):
        if key.upper() in _STRIP or key.upper().startswith(_STRIP_PREFIX):
            env.pop(key)
    return env


def find_claude() -> list[str] | None:
    found = shutil.which("claude")
    if not found:
        return None
    path = Path(found)
    if path.suffix.lower() == ".exe":
        return [str(path)]
    # npm 셰임(.cmd/.ps1)은 빈 인자(`--tools ""`)를 망가뜨린다 — 옆 패키지의 실제 실행 파일을 직접 부른다.
    native = path.parent / "node_modules" / "@anthropic-ai" / "claude-code" / "bin" / "claude.exe"
    return [str(native)] if native.is_file() else None


def find_codex() -> list[str] | None:
    node, shim = shutil.which("node"), shutil.which("codex")
    if not node or not shim:
        return None
    script = Path(shim).parent / "node_modules" / "@openai" / "codex" / "bin" / "codex.js"
    return [node, str(script)] if script.is_file() else None


def engine_prefix(engine: str) -> list[str] | None:
    return find_claude() if engine == "claude" else find_codex()


def cli_version(prefix: list[str]) -> str:
    try:
        done = subprocess.run([*prefix, "--version"], capture_output=True, stdin=subprocess.DEVNULL, text=True,
                              encoding="utf-8", errors="replace", timeout=20, env=child_env(),
                              creationflags=CREATE_NO_WINDOW if os.name == "nt" else 0)
    except (OSError, subprocess.TimeoutExpired):
        return ""
    words = (done.stdout or "").split()
    if not words:
        return ""
    # "2.1.296 (Claude Code)" / "codex-cli 0.162.0-alpha.17.2"
    return words[0] if words[0][:1].isdigit() else words[-1]


def _status_output(prefix: list[str], args: list[str]) -> str:
    try:
        done = subprocess.run([*prefix, *args], capture_output=True, stdin=subprocess.DEVNULL, text=True,
                              encoding="utf-8", errors="replace", timeout=30, env=child_env(),
                              creationflags=CREATE_NO_WINDOW if os.name == "nt" else 0)
    except (OSError, subprocess.TimeoutExpired):
        return ""
    return done.stdout or "" if done.returncode == 0 else ""


def auth_problem(engine: str, prefix: list[str]) -> str | None:
    """구독 로그인인지 — 비밀값을 내지 않는 상태 확인으로만 본다(설계 3-4). 출력(이메일 등)은 판정에만 쓰고 남기지 않는다."""
    if engine == "claude":
        try:
            data = json.loads(_status_output(prefix, ["auth", "status"]))
        except ValueError:
            return "로그인 상태를 확인하지 못했습니다"
        if not data.get("loggedIn"):
            return "로그인되어 있지 않습니다"
        if data.get("authMethod") != "claude.ai" or data.get("apiProvider") != "firstParty":
            return "구독 로그인이 아닙니다(API 키 방식은 쓰지 않습니다)"
        return None
    text = _status_output(prefix, ["login", "status"])
    if "Logged in using ChatGPT" in text:
        return None
    return "구독 로그인이 아닙니다(API 키 방식은 쓰지 않습니다)" if "Logged in" in text else "로그인되어 있지 않습니다"


def engine_problem(engine: str, prefix: list[str] | None) -> str | None:
    """지금 설치된 실행 파일로 이 엔진을 써도 되나 — 차례마다 실행 직전에 다시 본다(이어 가기 포함). None 이면 된다."""
    if not prefix:
        return "이 PC 에 설치되어 있지 않습니다"
    if engine == "codex" and CODEX_LOCK:
        return CODEX_LOCK
    version = cli_version(prefix)
    if not version:
        return "판을 확인하지 못했습니다"
    if engine == "codex" and version not in CODEX_VERIFIED:
        return f"점검 필요 — 확인하지 않은 판입니다({version})"
    return auth_problem(engine, prefix)


def _toml_literal(value: str) -> str:
    if "'" in value or "\n" in value:
        raise ValueError("MCP 실행 경로에 쓸 수 없는 글자가 있습니다.")
    return "'" + value + "'"


def build_command(engine: str, prefix: list[str], *, model: str, effort: str, resume: str | None,
                  mcp_entry: dict, mcp_file: Path, work: Path) -> list[str]:
    if engine == "claude":
        mcp_file.parent.mkdir(parents=True, exist_ok=True)
        mcp_file.write_text(json.dumps({"mcpServers": {PANEL_SERVER: mcp_entry}}, ensure_ascii=False), encoding="utf-8")
        command = [*prefix, "-p", "--output-format", "stream-json", "--verbose", "--include-partial-messages",
                   "--model", model, "--effort", effort, "--tools", "", "--strict-mcp-config", "--mcp-config", str(mcp_file),
                   "--allowedTools", ",".join(sorted(CLAUDE_ALLOWED)), "--permission-mode", "dontAsk",
                   "--setting-sources", "local"]
        return command + (["--resume", resume] if resume else [])
    server = f"mcp_servers.{PANEL_SERVER}"
    options = ["--json", "--skip-git-repo-check", "--ignore-user-config", "--ignore-rules", "--sandbox", "read-only",
               "-m", model, "-c", f"model_reasoning_effort={effort}"]
    for feature in CODEX_FEATURES_OFF:
        options += ["--disable", feature]
    options += ["-c", 'web_search="disabled"', "-c", "agents.enabled=false", "-c", "apps._default.enabled=false",
                "-c", f"{server}.command={_toml_literal(mcp_entry['command'])}",
                "-c", f"{server}.args=[{','.join(_toml_literal(str(arg)) for arg in mcp_entry['args'])}]",
                "-c", f"{server}.enabled_tools={json.dumps(list(PANEL_TOOLS))}",
                "-c", f'{server}.default_tools_approval_mode="approve"', "-c", f"{server}.tool_timeout_sec=150"]
    if resume:
        return [*prefix, "exec", *options, "resume", resume, "-"]
    return [*prefix, "exec", *options, "-C", str(work), "-"]


class _Basic(ctypes.Structure):
    _fields_ = [("a", ctypes.c_longlong), ("b", ctypes.c_longlong), ("LimitFlags", wintypes.DWORD),
                ("c", ctypes.c_size_t), ("d", ctypes.c_size_t), ("e", wintypes.DWORD), ("f", ctypes.c_size_t),
                ("g", wintypes.DWORD), ("h", wintypes.DWORD)]


class _Extended(ctypes.Structure):
    _fields_ = [("Basic", _Basic), ("io", ctypes.c_ulonglong * 6), ("m1", ctypes.c_size_t), ("m2", ctypes.c_size_t),
                ("m3", ctypes.c_size_t), ("m4", ctypes.c_size_t)]


def _api():
    k32 = ctypes.WinDLL("kernel32", use_last_error=True)
    ntdll = ctypes.WinDLL("ntdll")
    k32.CreateJobObjectW.restype = wintypes.HANDLE
    k32.CreateJobObjectW.argtypes = [ctypes.c_void_p, wintypes.LPCWSTR]
    k32.SetInformationJobObject.argtypes = [wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD]
    k32.SetInformationJobObject.restype = wintypes.BOOL
    k32.AssignProcessToJobObject.argtypes = [wintypes.HANDLE, wintypes.HANDLE]
    k32.AssignProcessToJobObject.restype = wintypes.BOOL
    k32.TerminateJobObject.argtypes = [wintypes.HANDLE, wintypes.UINT]
    k32.TerminateJobObject.restype = wintypes.BOOL
    k32.QueryInformationJobObject.argtypes = [wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD, ctypes.c_void_p]
    k32.QueryInformationJobObject.restype = wintypes.BOOL
    k32.CloseHandle.argtypes = [wintypes.HANDLE]
    ntdll.NtResumeProcess.argtypes = [wintypes.HANDLE]
    ntdll.NtResumeProcess.restype = ctypes.c_long
    return k32, ntdll


class JobProcess:
    """CLI 한 번 = Job 하나. 닫으면 CLI 와 그 자식(MCP 어댑터 포함)이 함께 꺼진다(탈출 허용 없음)."""

    def __init__(self, command: list[str], cwd: Path, env: dict):
        if os.name != "nt":
            raise RuntimeError("Ask Agent 칸은 Windows 에서만 실행합니다.")
        self._k32, ntdll = _api()
        self._lock = threading.Lock()
        self._job = self._k32.CreateJobObjectW(None, None)
        info = _Extended()
        info.Basic.LimitFlags = _KILL_ON_JOB_CLOSE
        if not self._job or not self._k32.SetInformationJobObject(self._job, _EXT_INFO, ctypes.byref(info), ctypes.sizeof(info)):
            self._close_job()
            raise OSError("실행 묶음을 만들지 못했습니다.")
        try:
            self.proc = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                         cwd=str(cwd), env=env, creationflags=CREATE_SUSPENDED | CREATE_NO_WINDOW)
        except OSError:
            self._close_job()
            raise
        # 배정 전에는 재개하지 않는다 — 그 사이 생긴 자식을 놓치지 않게. 배정 실패면 실행 거부.
        if not self._k32.AssignProcessToJobObject(self._job, int(self.proc._handle)):
            self.proc.kill()
            self.proc.wait(10)
            self._close_job()
            raise OSError("실행 묶음에 넣지 못해 실행하지 않았습니다.")
        if ntdll.NtResumeProcess(int(self.proc._handle)) != 0:
            self.reap()
            raise OSError("실행을 시작하지 못했습니다.")
        self.stderr = bytearray()
        threading.Thread(target=self._drain_stderr, daemon=True).start()

    def feed(self, data: bytes) -> None:
        """stdin 쓰기는 따로 — 읽지 않는 CLI 때문에 막혀도 실행 스레드·시간 제한은 계속 돈다."""
        def write():
            try:
                self.proc.stdin.write(data)
                self.proc.stdin.close()
            except (OSError, ValueError):
                pass  # 이미 끝났거나 끈 프로세스 — 종료 코드·출력으로 판단한다
        threading.Thread(target=write, daemon=True).start()

    def _drain_stderr(self) -> None:
        for chunk in iter(lambda: self.proc.stderr.read(4096), b""):
            if len(self.stderr) < MAX_STDERR:
                self.stderr.extend(chunk[: MAX_STDERR - len(self.stderr)])

    def lines(self):
        """줄마다 — 읽는 단계에서 줄 크기를 끊고(넘는 줄은 버림) 차례 전체 출력이 상한을 넘으면 OutputLimit."""
        stream, total = self.proc.stdout, 0
        while True:
            raw = stream.readline(MAX_LINE + 1)
            if not raw:
                return
            total += len(raw)
            if total > MAX_TOTAL:
                raise OutputLimit()
            if len(raw) > MAX_LINE and not raw.endswith(b"\n"):
                while raw and not raw.endswith(b"\n"):
                    raw = stream.readline(MAX_LINE + 1)
                    total += len(raw)
                    if total > MAX_TOTAL:
                        raise OutputLimit()
                continue
            yield raw

    def exited(self) -> bool:
        return self.proc.poll() is not None

    def pids(self) -> list[int] | None:
        """Job 안 프로세스 id. 조회에 실패하면(260개 넘음 등) None — '0개'와 섞지 않는다."""
        with self._lock:
            if not self._job:
                return []
            buf = (ctypes.c_ulonglong * 260)()
            if not self._k32.QueryInformationJobObject(self._job, _PID_LIST, buf, ctypes.sizeof(buf), None):
                return None
            count = ctypes.cast(buf, ctypes.POINTER(wintypes.DWORD))[1]
            return [int(buf[1 + index]) for index in range(count)]  # DWORD 2개 = ulonglong 1칸 뒤부터 id

    @property
    def closed(self) -> bool:
        with self._lock:
            return self._job is None

    def terminate(self) -> None:
        with self._lock:
            if self._job:
                self._k32.TerminateJobObject(self._job, 1)

    def reap(self, timeout: float = 15.0) -> bool:
        """트리를 끄고 남은 프로세스가 0이 될 때까지 기다린다. 0을 확인했을 때만 핸들을 닫고 True —
        못 했으면 핸들을 쥔 채 False(부르는 쪽이 차례를 풀지 않고 다시 회수한다)."""
        self.terminate()
        deadline = time.monotonic() + timeout
        while self.pids() != [] and time.monotonic() < deadline:  # None(조회 실패)도 '남음'으로 본다
            time.sleep(0.1)
        if self.pids() != []:
            return False
        self._close_job()
        return True

    def _close_job(self) -> None:
        with self._lock:
            if self._job:
                self._k32.CloseHandle(self._job)
                self._job = None

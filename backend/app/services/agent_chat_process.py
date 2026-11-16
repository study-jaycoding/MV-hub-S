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
_STRIP = {"OPENAI_API_KEY", "OPENAI_BASE_URL", "CODEX_API_KEY", "ELECTRON_RUN_AS_NODE", "CLAUDECODE"}
_STRIP_PREFIX = ("CLAUDE_CODE_", "ANTHROPIC_")  # ANTHROPIC_* 는 전부 — 키·제공자 전환 변수가 늘어도 막히게(첫 연결 설계 4절)
# 0단계를 통과한 Codex 판 — 새 판은 기본으로 켜지는 기능(연결 앱 등)이 늘 수 있어 다시 점검하기 전엔 잠근다.
CODEX_VERIFIED = frozenset({"0.162.0-alpha.17.2"})
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


def official_claude() -> Path:
    """공식 설치(`irm https://claude.ai/install.ps1 | iex`)의 실행 파일 — 허브가 켜진 뒤 설치하면 허브의 PATH 엔 안 보여 직접 본다."""
    return Path(os.environ.get("USERPROFILE") or Path.home()) / ".local" / "bin" / "claude.exe"


# 실행기(run_agent_session.py)가 남기는 공식 설치 표식 — 허브는 읽기만 한다. 경로·상태 이름은 그쪽과 같게 둔다(시험이 맞춘다).
#  (docs/status/MVAgent_ClaudeCode업데이트_2026-11-10.md 2-v3-1b)
INSTALL_RUNNING_SECONDS = 20 * 60  # 실행기 설치 시한 15분 + 여유 — 실행기가 죽어 started 로 남아도 그 뒤엔 설치 중이 아니다
INSTALL_SKIP_REASONS = frozenset({"service_account", "not_interactive", "elevated", "token_unknown"})
INSTALL_FAIL_REASONS = frozenset({"exit", "timeout", "job", "start", "version_check"})


def install_marker() -> Path:
    base = Path(os.environ.get("LOCALAPPDATA") or (Path.home() / "AppData" / "Local"))
    return base / "MVHub" / "claude-install.json"


def read_install_marker() -> dict | None:
    """표식 원본(못 읽으면 None) — 엔진 캐시는 보이는 값이 아니라 이 원본이 바뀌었는지로도 버린다(성공 ok 도 바뀜이다)."""
    try:
        data = json.loads(install_marker().read_bytes().decode("utf-8"))
    except (OSError, ValueError):
        return None
    return data if isinstance(data, dict) else None


def claude_install(now: float | None = None, data: dict | None = None) -> dict | None:
    """{state: running|failed|skipped, at, reason} 또는 None. 건너뜀은 설치 상태 시각보다 새로울 때만(옛 건너뜀이 뒤 설치를 가리지 않게)."""
    data = read_install_marker() if data is None else data
    if not data:
        return None
    now = time.time() if now is None else now
    stamp = lambda value: value if isinstance(value, (int, float)) and not isinstance(value, bool) else None  # noqa: E731
    status, at = data.get("status"), stamp(data.get("at"))
    if status == "started" and at is not None and 0 <= now - at < INSTALL_RUNNING_SECONDS:
        return {"state": "running", "at": int(at), "reason": None}
    skip = data.get("last_skip") if isinstance(data.get("last_skip"), dict) else {}
    skipped_at = stamp(skip.get("at"))
    if skipped_at is not None and skip.get("reason") in INSTALL_SKIP_REASONS and (at is None or skipped_at > at):
        return {"state": "skipped", "at": int(skipped_at), "reason": skip["reason"]}
    if status == "failed" and at is not None:
        reason = data.get("reason")
        return {"state": "failed", "at": int(at), "reason": reason if reason in INSTALL_FAIL_REASONS else None}
    return None


def _same_file(a: str | Path, b: str | Path) -> bool:
    try:
        return Path(a).resolve() == Path(b).resolve()
    except OSError:
        return False


def install_method(prefix: list[str] | None) -> str:
    """허브가 고른 실행 파일의 설치 방식 — official·npm·other·none(판과 같은 파일로 센다)."""
    if not prefix:
        return "none"
    if _same_file(prefix[0], official_claude()):
        return "official"
    tail = [part.casefold() for part in Path(prefix[0]).parts[-5:]]
    return "npm" if tail == ["node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe"] else "other"


def _claude_candidates() -> list[list[str]]:
    found, out = shutil.which("claude"), []
    if found:
        path = Path(found)
        if path.suffix.lower() == ".exe":
            out.append([str(path)])
        else:
            # npm 셰임(.cmd/.ps1)은 빈 인자(`--tools ""`)를 망가뜨린다 — 옆 패키지의 실제 실행 파일을 직접 부른다.
            native = path.parent / "node_modules" / "@anthropic-ai" / "claude-code" / "bin" / "claude.exe"
            if native.is_file():
                out.append([str(native)])
    official = official_claude()
    if (claude_install() or {}).get("state") == "running":
        # 실행기가 공식 설치를 하는 중 — 공식 파일은 판 비교용 --version 까지 띄우지 않는다. PATH 로 찾은 것도 실제 경로로 비교해 뺀다.
        return [c for c in out if not _same_file(c[0], official)]
    if official.is_file() and all(not _same_file(c[0], official) for c in out):
        out.append([str(official)])
    return out


def find_claude() -> list[str] | None:
    """PATH → npm 옆 실제 실행 파일 → 공식 설치 위치. 둘 이상이면 판이 높은 쪽, 같으면 공식 위치."""
    candidates = _claude_candidates()
    if len(candidates) <= 1:
        return candidates[0] if candidates else None
    official = str(official_claude()).casefold()
    return max(candidates, key=lambda c: (version_tuple(cli_version(c)), c[0].casefold() == official))


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


def version_tuple(value: str) -> tuple[int, ...]:
    """"2.1.296" → (2, 1, 296) — 숫자 조각만(앞에서 끊김까지)."""
    parts = []
    for piece in (value or "").split("."):
        digits = "".join(ch for ch in piece if ch.isdigit())
        if not digits:
            break
        parts.append(int(digits))
    return tuple(parts)


def _status_output(prefix: list[str], args: list[str]) -> str:
    try:
        done = subprocess.run([*prefix, *args], capture_output=True, stdin=subprocess.DEVNULL, text=True,
                              encoding="utf-8", errors="replace", timeout=30, env=child_env(),
                              creationflags=CREATE_NO_WINDOW if os.name == "nt" else 0)
    except (OSError, subprocess.TimeoutExpired):
        return ""
    return "\n".join(part for part in (done.stdout, done.stderr) if part) if done.returncode == 0 else ""


def auth_problem(prefix: list[str]) -> str | None:
    """Codex 가 구독(ChatGPT) 로그인인지 — 비밀값을 내지 않는 상태 확인으로만 본다(설계 3-4)."""
    text = _status_output(prefix, ["login", "status"])
    if "Logged in using ChatGPT" in text:
        return None
    return "구독 로그인이 아닙니다(API 키 방식은 쓰지 않습니다)" if "Logged in" in text else "로그인되어 있지 않습니다"


def _toml_literal(value: str) -> str:
    if "'" in value or "\n" in value:
        raise ValueError("MCP 실행 경로에 쓸 수 없는 글자가 있습니다.")
    return "'" + value + "'"


def build_command(engine: str, prefix: list[str], *, model: str, effort: str, resume: str | None,
                  mcp_entry: dict, mcp_file: Path, work: Path, fast: bool = False, fork: bool = False,
                  images=()) -> list[str]:
    if engine == "claude":
        mcp_file.parent.mkdir(parents=True, exist_ok=True)
        mcp_file.write_text(json.dumps({"mcpServers": {PANEL_SERVER: mcp_entry}}, ensure_ascii=False), encoding="utf-8")
        command = [*prefix, "-p", "--output-format", "stream-json", "--verbose", "--include-partial-messages",
                   "--model", model, "--effort", effort, "--tools", "", "--strict-mcp-config", "--mcp-config", str(mcp_file),
                   "--allowedTools", ",".join(sorted(CLAUDE_ALLOWED)), "--permission-mode", "dontAsk",
                   "--setting-sources", "local",
                   # 빠른 모드는 매 차례 켬/끔을 적는다 — 사용자 설정·이어 가기가 켜 둔 값이 남지 않게(Claude 추가 사용 크레딧이 든다)
                   "--settings", json.dumps({"fastMode": bool(fast)})]
        # 포크의 첫 차례 — 원래 세션을 이어 읽되 새 세션 id 로 가른다(11-12 실측: 원래 파일 그대로·새 파일은 혼자 선다)
        return (command + (["--input-format", "stream-json"] if images else [])
                + (["--resume", resume] if resume else []) + (["--fork-session"] if resume and fork else []))
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
    image_args = [part for image in images for part in ("--image", str(image))]
    if resume:
        return [*prefix, "exec", *options, "resume", *image_args, *(["--"] if images else []), resume, "-"]
    return [*prefix, "exec", *options, *image_args, "-C", str(work), "-"]


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
    """CLI 한 번 = Job 하나. 닫으면 CLI 와 그 자식(MCP 어댑터 포함)이 함께 꺼진다(탈출 허용 없음).
    만들기(빈 Job)와 띄우기(start)를 나눈다 — 부르는 쪽이 띄우기 전에 Job 을 쥐어, 띄우다 실패해도 회수를 확인할 수 있게."""

    def __init__(self):
        if os.name != "nt":
            raise RuntimeError("MV Agent 칸은 Windows 에서만 실행합니다.")
        self._k32, self._ntdll = _api()
        self._lock = threading.Lock()
        self.proc: subprocess.Popen | None = None
        self._assigned = False
        self.stderr = bytearray()
        self._job = self._k32.CreateJobObjectW(None, None)
        info = _Extended()
        info.Basic.LimitFlags = _KILL_ON_JOB_CLOSE
        if not self._job or not self._k32.SetInformationJobObject(self._job, _EXT_INFO, ctypes.byref(info), ctypes.sizeof(info)):
            self._close_job()
            raise OSError("실행 묶음을 만들지 못했습니다.")

    def start(self, command: list[str], cwd: Path, env: dict) -> None:
        """멈춘 채 생성 → Job 배정 → 재개. 실패하면 예외 — Job 은 그대로 두므로 부르는 쪽이 reap 으로 0개를 확인한다."""
        self.proc = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                     cwd=str(cwd), env=env, creationflags=CREATE_SUSPENDED | CREATE_NO_WINDOW)
        # 배정 전에는 재개하지 않는다 — 그 사이 생긴 자식을 놓치지 않게. 배정 실패면 실행 거부(Job 밖이라 직접 끈다 —
        # 꺼졌는지는 reap 이 Job 과 함께 확인한다).
        if not self._k32.AssignProcessToJobObject(self._job, int(self.proc._handle)):
            self._kill_outside()
            raise OSError("실행 묶음에 넣지 못해 실행하지 않았습니다.")
        self._assigned = True
        threading.Thread(target=self._drain_stderr, daemon=True).start()  # 재개 전에 — 여기서 실패해도 멈춘 채로 Job 안
        if self._ntdll.NtResumeProcess(int(self.proc._handle)) != 0:
            self.terminate()
            raise OSError("실행을 시작하지 못했습니다.")

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
        return self.proc is not None and self.proc.poll() is not None

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

    def _outside_alive(self) -> bool:
        """Job 에 넣지 못한 채 살아 있는 CLI — Job 을 꺼도 안 꺼지니 따로 본다."""
        return self.proc is not None and not self._assigned and self.proc.poll() is None

    def _kill_outside(self) -> None:
        if self._outside_alive():
            try:
                self.proc.kill()
            except OSError:
                pass  # 못 껐으면 reap 이 '남음'으로 보고 다시 시도한다

    def terminate(self) -> None:
        with self._lock:
            if self._job:
                self._k32.TerminateJobObject(self._job, 1)
        self._kill_outside()

    def _left(self) -> bool:
        return self.pids() != [] or self._outside_alive()  # pids None(조회 실패)도 '남음'

    def reap(self, timeout: float = 15.0) -> bool:
        """트리를 끄고 남은 프로세스가 0이 될 때까지 기다린다(Job 밖에 남은 CLI 포함). 0을 확인했을 때만 핸들을 닫고 True —
        못 했으면 핸들을 쥔 채 False(부르는 쪽이 차례를 풀지 않고 다시 회수한다)."""
        self.terminate()
        deadline = time.monotonic() + timeout
        while self._left() and time.monotonic() < deadline:
            time.sleep(0.1)
            self._kill_outside()
        if self._left():
            return False
        self._close_job()
        return True

    def _close_job(self) -> None:
        with self._lock:
            if self._job:
                self._k32.CloseHandle(self._job)
                self._job = None

"""설치 요청/결과 파일 계약. 실행기도 이 파일을 읽으므로 최상위 import 는 표준 라이브러리만 쓴다."""
from __future__ import annotations

import ast
import contextlib
import ctypes
import json
import os
import re
import secrets
import time
from ctypes import wintypes
from pathlib import Path

ENGINES = ("claude", "codex")
FAIL_REASONS = {"download", "disk", "permission", "install_failed", "start", "marker_failed", "timeout",
                "job", "version_check", "release_unavailable", "interrupted"}
SKIP_REASONS = {"service_account", "not_interactive", "elevated", "token_unknown", "other_user",
                "shared_server", "release_only", "launcher_missing", "boot_pending"}


def local_dir() -> Path:
    return Path(os.environ.get("LOCALAPPDATA") or Path.home() / "AppData" / "Local") / "MVHub"


def directory() -> Path | None:
    install_id = os.environ.get("CONTENT_HUB_AGENT_INSTALL_ID", "")
    port = os.environ.get("CONTENT_HUB_AGENT_INSTALL_PORT", "")
    if not re.fullmatch(r"[a-f0-9]{10}", install_id) or not re.fullmatch(r"[0-9]{1,5}", port):
        return None
    return local_dir() / "agent-install" / install_id / port


def read(path: Path) -> dict:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


def write(path: Path, data: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_name(f".{path.name}.{secrets.token_hex(12)}.tmp")
    try:
        temp.write_text(json.dumps(data), encoding="utf-8")
        os.replace(temp, path)
    finally:
        temp.unlink(missing_ok=True)


@contextlib.contextmanager
def file_lock(path: Path):
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a+b") as stream:
        # 기존 Claude 자동 설치도 빈 파일의 첫 바이트를 잠근다. 잠금 전에 그 바이트를 쓰면 서로 충돌한다.
        stream.seek(0)
        if os.name == "nt":
            import msvcrt
            while True:
                try:
                    msvcrt.locking(stream.fileno(), msvcrt.LK_NBLCK, 1)
                    break
                except OSError as exc:
                    if exc.errno not in (13, 36):
                        raise
                    time.sleep(0.1)
        else:
            import fcntl
            fcntl.flock(stream.fileno(), fcntl.LOCK_EX)
        try:
            yield
        finally:
            stream.seek(0)
            if os.name == "nt":
                msvcrt.locking(stream.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                fcntl.flock(stream.fileno(), fcntl.LOCK_UN)


def process_start(pid: int) -> int | None:
    if os.name != "nt" or not isinstance(pid, int) or isinstance(pid, bool) or pid <= 0:
        return None
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel.OpenProcess.restype = wintypes.HANDLE
    kernel.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    kernel.GetProcessTimes.argtypes = [wintypes.HANDLE] + [ctypes.POINTER(wintypes.FILETIME)] * 4
    kernel.GetExitCodeProcess.argtypes = [wintypes.HANDLE, ctypes.POINTER(wintypes.DWORD)]
    kernel.CloseHandle.argtypes = [wintypes.HANDLE]
    handle = kernel.OpenProcess(0x1000, False, pid)
    if not handle:
        return None
    try:
        code = wintypes.DWORD()
        stamps = [wintypes.FILETIME() for _ in range(4)]
        if not kernel.GetExitCodeProcess(handle, ctypes.byref(code)) or code.value != 259:
            return None
        if kernel.GetProcessTimes(handle, *(ctypes.byref(stamp) for stamp in stamps)):
            return (stamps[0].dwHighDateTime << 32) | stamps[0].dwLowDateTime
        return None
    finally:
        kernel.CloseHandle(handle)


def launcher() -> dict:
    folder = directory()
    value = read(folder / "launcher.json") if folder else {}
    generation = os.environ.get("CONTENT_HUB_AGENT_INSTALL_GENERATION")
    if not generation or value.get("generation") != generation:
        return {}
    start = value.get("start")
    return value if isinstance(start, int) and start > 0 and process_start(value.get("pid")) == start else {}


def eligibility() -> str | None:
    from .. import config
    from . import agent_chat_claude as claude

    if config.AUTH_ENABLED:
        return "shared_server"
    live = launcher()
    if not live:
        return "launcher_missing"
    if not live.get("release"):
        return "release_only"
    if not live.get("ready"):
        return "boot_pending"
    problem = claude._login_token_problem()
    return {"service": "service_account", "unknown": "token_unknown"}.get(problem, problem)


def request(engine: str, still_current=lambda: None) -> dict:
    if engine not in ENGINES:
        raise ValueError("engine")
    reason = eligibility()
    if reason:
        return {"state": "skipped", "reason": reason, "at": int(time.time())}
    folder = directory()
    with file_lock(folder / f"{engine}.request.lock"):
        live = launcher()
        if not live or not live.get("ready"):
            return {"state": "skipped", "reason": "launcher_missing", "at": int(time.time())}
        old = read(folder / f"{engine}.json")
        if old.get("generation") == live["generation"] and old.get("state") == "running":
            return status(engine)
        still_current()
        value = {"id": secrets.token_hex(16), "engine": engine,
                 "install_id": os.environ["CONTENT_HUB_AGENT_INSTALL_ID"], "generation": live["generation"],
                 "at": int(time.time())}
        write(folder / f"{engine}.request.json", value)
        write(folder / f"{engine}.json", {**value, "state": "running", "reason": None})
        return {"id": value["id"], "state": "running", "reason": None, "at": value["at"]}


def status(engine: str) -> dict | None:
    folder = directory()
    if not folder:
        return None
    data = read(folder / f"{engine}.json")
    req = read(folder / f"{engine}.request.json")
    if not req or any(data.get(key) != req.get(key) for key in ("id", "engine", "install_id", "generation")):
        return None
    if not re.fullmatch(r"[a-f0-9]{32}", str(req.get("id", ""))) or req.get("engine") != engine:
        return None
    state, reason = data.get("state"), data.get("reason")
    if state not in {"running", "failed", "skipped", "ok"}:
        return None
    if state == "running" and (not launcher() or req["generation"] != os.environ.get("CONTENT_HUB_AGENT_INSTALL_GENERATION")):
        state, reason = "failed", "interrupted"
    if state == "failed" and reason not in FAIL_REASONS:
        reason = "install_failed"
    if state == "skipped" and reason not in SKIP_REASONS:
        reason = "token_unknown"
    return {"id": req["id"], "state": state, "reason": reason, "at": data.get("at", 0)}


def codex_release(source: Path | None = None) -> str:
    # 실행기는 staged 허브를 import 하지 않는다. 허용 판 상수만 원본 문법 트리에서 읽는다.
    tree = ast.parse((source or Path(__file__).with_name("agent_chat_process.py")).read_text(encoding="utf-8"))
    for node in tree.body:
        if isinstance(node, ast.Assign) and any(isinstance(t, ast.Name) and t.id == "CODEX_VERIFIED" for t in node.targets):
            versions = ast.literal_eval(node.value.args[0])
            if len(versions) == 1:
                return next(iter(versions))
    raise ValueError("Codex release is not singular")


def verified_status(engine: str) -> dict | None:
    from . import agent_chat_process as process

    result = status(engine)
    if result and result["state"] == "ok":
        exe = official_codex() if engine == "codex" else process.official_claude()
        version = process.cli_version([str(exe)]) if exe.is_file() else ""
        valid = version in process.CODEX_VERIFIED if engine == "codex" else bool(version)
        if engine == "codex" and (codex_home() / "packages" / "standalone" / "auto-update-version").exists():
            valid = False
        if not valid:
            return {**result, "state": "failed", "reason": "version_check"}
    return result


def installer_env(base: dict | None = None) -> dict:
    env = dict(os.environ if base is None else base)
    for key in list(env):
        if key.upper() in {"CODEX_INSTALL_DIR", "CODEX_RELEASE", "CODEX_NON_INTERACTIVE"}:
            env.pop(key)
    env.update(CODEX_RELEASE=codex_release(), CODEX_NON_INTERACTIVE="1")
    return env


def official_codex() -> Path:
    return local_dir().parent / "Programs" / "OpenAI" / "Codex" / "bin" / "codex.exe"


def codex_home() -> Path:
    return Path(os.environ.get("CODEX_HOME") or Path(os.environ.get("USERPROFILE") or Path.home()) / ".codex")

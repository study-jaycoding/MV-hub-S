"""일반 사용자에게 보이는 Codex 로그인 창. 출력은 읽지 않고 login status 로만 성공을 확인한다."""
from __future__ import annotations

import hashlib
import errno
import os
import secrets
import re
import socket
import subprocess
import time

from . import agent_chat_claude as claude
from . import agent_chat_codex as codex
from . import agent_chat_install as install
from . import agent_chat_process as process

_windows: list[subprocess.Popen] = []


def _folder():
    scope = hashlib.sha256(str(install.codex_home().resolve()).casefold().encode("utf-8")).hexdigest()[:24]
    return install.local_dir() / "codex-login" / scope


def _record():
    path = _folder() / "window.json"
    record = install.read(path)
    if path.exists() and not record:
        raise codex.CodexError("로그인 창 기록을 확인하지 못했어요")
    if record and not re.fullmatch(r"[a-f0-9]{32}", str(record.get("id", ""))):
        raise codex.CodexError("로그인 창 기록을 확인하지 못했어요")
    return record


def _alive(record):
    if not record:
        return False
    if record.get("state") == "none":
        return False
    if record.get("state") == "launching":
        pid, start = record.get("hub_pid"), record.get("hub_start")
        if not isinstance(pid, int) or not isinstance(start, int) or pid <= 0 or start <= 0:
            raise codex.CodexError("로그인 창 기록을 확인하지 못했어요")
        return claude.process_start(pid) == start
    if record.get("state") not in {"running", "failed", "ok"} or not isinstance(record.get("pid"), int) \
            or not isinstance(record.get("start"), int):
        raise codex.CodexError("로그인 창 기록을 확인하지 못했어요")
    return claude.process_start(record["pid"]) == record["start"]


def ports_busy() -> bool:
    for port in (1455, 1457):
        with socket.socket() as probe:
            if os.name == "nt":
                probe.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
            try:
                probe.bind(("127.0.0.1", port))
            except OSError as exc:
                if exc.errno != errno.EADDRINUSE and getattr(exc, "winerror", None) != 10048:
                    return False  # 권한/예약 등 다른 실패를 '다른 프로세스가 사용 중'이라고 말하지 않는다.
                continue
            return False
    return True


def _spawn(prefix):
    folder = _folder()
    folder.mkdir(parents=True, exist_ok=True)
    return subprocess.Popen([*prefix, "login"], cwd=str(folder), env=process.child_env(), close_fds=True,
        creationflags=claude.CREATE_NEW_CONSOLE | claude.CREATE_BREAKAWAY_FROM_JOB | process.CREATE_SUSPENDED)


def open_login_window(still_current=lambda: None, chain_id: str | None = None) -> dict:
    problem = claude._login_token_problem()
    if problem:
        raise codex.CodexError({"elevated": "관리자 권한으로 켜서 로그인 창을 열 수 없어요",
                               "other_user": "다른 Windows 사용자로 켜서 로그인 창을 열 수 없어요"}
                              .get(problem, "이 Windows 로그인에서는 로그인 창을 열 수 없어요"))
    with install.file_lock(_folder() / "window.lock"):
        old = _record()
        if _alive(old):
            return {"id": old["id"], "state": "running", "reason": None}
        prefix = process.engine_prefix("codex")
        if not prefix or process.cli_version(prefix) not in process.CODEX_VERIFIED:
            raise codex.CodexError("Codex 설치와 판을 먼저 확인해 주세요")
        authenticated = process.auth_problem(prefix) is None
        with codex._lock("codex_enabled.lock", wait=True):
            if chain_id is None:
                chain_id = secrets.token_hex(16)
                codex.start_chain(chain_id)
            codex.check_chain(chain_id)
            still_current()
            if authenticated:
                return {"id": chain_id, "state": "ok", "reason": None}
            proc = None
            me = claude.process_start(os.getpid())
            if me is None:
                raise codex.CodexError("로그인 창을 준비하지 못했어요")
            install.write(_folder() / "window.json", {"id": chain_id, "state": "launching",
                          "hub_pid": os.getpid(), "hub_start": me})
            try:
                proc = _spawn(prefix)
                if claude._window_trapped(proc):
                    raise claude.BreakawayDenied()
                start = claude._handle_start(claude._k32(), int(proc._handle))
                if start is None:
                    raise OSError("process start")
                install.write(_folder() / "window.json", {"id": chain_id, "state": "running", "pid": proc.pid,
                              "start": start, "target": process.codex_target(prefix), "at": int(time.time())})
                claude._resume(proc)
            except (OSError, claude.BreakawayDenied) as exc:
                if proc is not None:
                    try:
                        proc.kill()
                        proc.wait(timeout=5)
                    except (OSError, subprocess.TimeoutExpired):
                        pass  # 회수 확인 실패면 launching/open 표식으로 다음 창을 막는다.
                    else:
                        install.write(_folder() / "window.json", {"id": chain_id, "state": "none"})
                else:
                    install.write(_folder() / "window.json", {"id": chain_id, "state": "none"})
                return {"id": chain_id, "state": "failed", "reason": "job" if isinstance(exc, claude.BreakawayDenied) else "start"}
            _windows[:] = [window for window in _windows if window.poll() is None]
            _windows.append(proc)
            return {"id": chain_id, "state": "running", "reason": None}


def status(chain_id: str | None = None) -> dict:
    with install.file_lock(_folder() / "window.lock"):
        record = _record()
        if not record or (chain_id is not None and record.get("id") != chain_id):
            return {"id": chain_id, "state": "failed", "reason": "login_unfinished", "ports_busy": False}
        prefix = process.engine_prefix("codex")
        valid = prefix and process.codex_target(prefix) == record.get("target") \
            and process.cli_version(prefix) in process.CODEX_VERIFIED
        # 이미 종료 코드 0 으로 끝났어도 로그인 성공부터 다시 본다. 표식의 ok 는 성공 근거가 아니다.
        if valid and process.auth_problem(prefix) is None:
            return {"id": record["id"], "state": "ok", "reason": None}
        if _alive(record):
            return {"id": record["id"], "state": "running", "reason": None}
        return {"id": record["id"], "state": "failed", "reason": "login_unfinished", "ports_busy": ports_busy()}

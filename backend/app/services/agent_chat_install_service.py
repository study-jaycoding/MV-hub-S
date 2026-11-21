"""허브의 설치 요청·자격 판단·결과 검증. 실행기 파일 계약은 agent_chat_install에 둔다."""
from __future__ import annotations

import json
import os
import secrets
import threading
import time
from pathlib import Path

from .. import config
from . import agent_chat_claude as claude
from . import agent_chat_install as install
from . import agent_chat_process as process
from .agent_chat_install import RequestBusy

_verified: dict[str, tuple[tuple, bool]] = {}
_verify_lock = threading.Lock()


def eligibility() -> str | None:
    if config.AUTH_ENABLED:
        return "shared_server"
    live = install.launcher()
    if not live:
        return "launcher_missing"
    if not live.get("release"):
        return "release_only"
    if not live.get("ready"):
        return "boot_pending"
    problem = claude._login_token_problem()
    return {"service": "service_account", "unknown": "token_unknown"}.get(problem, problem)


def request(engine: str, still_current=lambda: None) -> dict:
    if engine not in install.ENGINES:
        raise ValueError("engine")
    reason = eligibility()
    if reason:
        return {"state": "skipped", "reason": reason, "at": int(time.time())}
    folder = install.directory()
    with install.file_lock(folder / f"{engine}.request.lock"):
        live = install.launcher()
        if not live or not live.get("ready"):
            return {"state": "skipped", "reason": "launcher_missing", "at": int(time.time())}
        old = install.read(folder / f"{engine}.json")
        if old.get("generation") == live["generation"] and old.get("state") == "running":
            pending = install.status(engine)
            if pending is None:
                raise RequestBusy("설치 요청 상태를 확인하지 못했어요. 잠시 뒤 다시 해 주세요")
            return pending
        still_current()
        value = {"id": secrets.token_hex(16), "engine": engine,
                 "install_id": os.environ["CONTENT_HUB_AGENT_INSTALL_ID"], "generation": live["generation"],
                 "at": int(time.time())}
        install.write(folder / f"{engine}.request.json", value)
        install.write(folder / f"{engine}.json", {**value, "state": "running", "reason": None})
        return {"id": value["id"], "state": "running", "reason": None, "at": value["at"]}


def _file_stamp(path: Path) -> tuple | None:
    try:
        stat = path.stat()
        return stat.st_size, stat.st_mtime_ns
    except OSError:
        return None


def verified_status(engine: str, *, probe: bool = True) -> dict | None:
    result = install.status(engine)
    if result and result["state"] == "ok":
        exe = install.official_codex() if engine == "codex" else process.official_claude()
        update = install.codex_home() / "packages" / "standalone" / "auto-update-version"
        fingerprint = (str(install.directory()), json.dumps(result, sort_keys=True), str(exe), _file_stamp(exe),
                       str(update), _file_stamp(update) if engine == "codex" else None)
        with _verify_lock:
            cached = _verified.get(engine)
            if cached and cached[0] == fingerprint:
                valid = cached[1]
            elif not probe:
                return None  # 꺼진 Codex 목록은 성공 표식을 검증하려고 CLI 를 띄우지 않는다.
            else:
                version = process.cli_version([str(exe)]) if exe.is_file() else ""
                valid = version in process.CODEX_VERIFIED if engine == "codex" else bool(version)
                if engine == "codex" and update.exists():
                    valid = False
                _verified[engine] = fingerprint, valid
        if not valid:
            return {**result, "state": "failed", "reason": "version_check"}
    return result

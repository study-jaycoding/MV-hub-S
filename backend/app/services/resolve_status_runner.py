"""Resolve 상태 검사를 제한 시간 안에 끝내는 부모 프로세스 계층."""

from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path
from typing import Any

from .resolve_probe import RESULT_PREFIX
from .resolve_bridge import resolve_process_running


_BACKEND_DIR = Path(__file__).resolve().parents[2]
_STATUS_TIMEOUT_SECONDS = max(
    1.0, float(os.environ.get("CONTENT_HUB_RESOLVE_STATUS_TIMEOUT_SECONDS", "8"))
)


def _unavailable(message: str, *, process_running: bool = True) -> dict[str, Any]:
    return {
        "status": "api_unavailable" if process_running else "not_running",
        "connected": False,
        "process_running": process_running,
        "project_open": False,
        "project_id": "",
        "project_name": "",
        "resolve_version": "",
        "resolve_product": "",
        "message": message,
    }


def resolve_connection_status_bounded() -> dict[str, Any]:
    """별도 검사 프로세스를 실행하고 제한 시간 초과 시 안전한 상태를 반환한다."""
    running = resolve_process_running()
    if running is False:
        return _unavailable(
            "DaVinci Resolve가 실행 중이지 않습니다", process_running=False
        )
    creation_flags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
    child_env = os.environ.copy()
    child_env["PYTHONIOENCODING"] = "utf-8"
    try:
        completed = subprocess.run(
            [sys.executable, "-m", "app.services.resolve_probe"],
            cwd=_BACKEND_DIR,
            check=False,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            env=child_env,
            timeout=_STATUS_TIMEOUT_SECONDS,
            creationflags=creation_flags,
        )
    except subprocess.TimeoutExpired:
        return _unavailable(
            f"DaVinci Resolve가 {_STATUS_TIMEOUT_SECONDS:g}초 안에 응답하지 않았습니다. "
            "작업을 저장하고 Resolve를 다시 실행하세요"
        )
    except (OSError, subprocess.SubprocessError) as exc:
        return _unavailable(f"DaVinci Resolve 연결 검사를 실행할 수 없습니다: {exc}")

    for line in reversed(completed.stdout.splitlines()):
        if not line.startswith(RESULT_PREFIX):
            continue
        try:
            result = json.loads(line.removeprefix(RESULT_PREFIX))
        except json.JSONDecodeError:
            break
        if isinstance(result, dict):
            return result
    detail = completed.stderr.strip() or f"검사 프로세스 종료 코드 {completed.returncode}"
    return _unavailable(f"DaVinci Resolve 연결 검사 결과를 읽을 수 없습니다: {detail}")

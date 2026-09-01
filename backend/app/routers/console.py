"""서버 콘솔 패널 API — cmd 창에 보이던 정보(버전·CLI·에이전트 로그)를 앱 안에서 보여준다.

로컬 요청 전용: 로그와 CLI 경로는 이 PC 의 정보라 공유 서버·다른 PC 로 내보내지 않는다.
"""

from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path
from typing import Any

from fastapi import APIRouter, HTTPException, Request

from ..config import BACKEND_DIR, PORT
from ..services import cli_bridge
from ..services.read_utf8_sig_first_line import read_first_line
from ..services.release_update import APP_ROOT, install_mode
from ..services.request_guards import require_local_machine_request

router = APIRouter(prefix="/api/console", tags=["console"])

_TAIL_MAX_BYTES = 64 * 1024  # 파일 끝 64KB 만 읽는다 — 큰 로그도 응답이 무겁지 않게


def _tail_lines(path: Path, limit: int) -> dict[str, Any]:
    """로그 파일 끝부분을 줄 단위로 — 없으면 exists=False (에러 아님)."""
    try:
        stat = path.stat()
    except OSError:
        return {"exists": False, "updated_at": None, "lines": []}
    try:
        with path.open("rb") as fh:
            if stat.st_size > _TAIL_MAX_BYTES:
                fh.seek(stat.st_size - _TAIL_MAX_BYTES)
            raw = fh.read()
    except OSError:
        return {"exists": False, "updated_at": None, "lines": []}
    text = raw.decode("utf-8", "replace")
    lines = [line for line in text.splitlines() if line.strip()]
    return {
        "exists": True,
        "updated_at": stat.st_mtime,  # epoch 초 — 프론트가 "n초 전"으로 표기
        "lines": lines[-limit:],
    }


@router.get("/summary")
def console_summary(request: Request, tail: int = 80):
    require_local_machine_request(
        request, "서버 콘솔 정보는 해당 작업자 PC에서만 볼 수 있습니다"
    )
    tail = max(10, min(int(tail), 300))
    try:
        version = read_first_line(APP_ROOT / "VERSION.txt")
    except OSError:
        version = ""
    try:
        cli_path = cli_bridge.cli_path()
    except cli_bridge.CLIError:
        cli_path = ""
    try:
        pinned = read_first_line(APP_ROOT / "hf_cli_version.txt")
    except OSError:
        pinned = ""
    return {
        "app_version": version,  # 릴리스 설치본만 존재 — 개발/서버 실행은 빈 값
        "install_mode": install_mode(APP_ROOT),  # release | server | development
        "port": PORT,
        "cli": {"available": bool(cli_path), "pinned": pinned, "path": cli_path},
        "agent_log": _tail_lines(BACKEND_DIR / "agent.log", tail),
        "hub_log": _tail_lines(BACKEND_DIR / "hub.log", tail),
    }


_CREATE_NO_WINDOW = 0x08000000


@router.post("/close-app")
def console_close_app(request: Request):
    """앱 내 '종료' 확인 후 호출 — MV Hub 앱 창에 OS 닫기(WM_CLOSE)를 보낸다.
    창이 닫히면 런처 감시자가 평소의 정상 종료 절차(허브·에이전트 정지)를 밟는다.
    확인은 프론트의 우리 디자인 확인창 한 번뿐 — 브라우저 측 확인창은 없다."""
    require_local_machine_request(
        request, "앱 종료는 해당 작업자 PC에서만 실행할 수 있습니다"
    )
    script = APP_ROOT / "run_agent_session.py"
    if not script.is_file():
        raise HTTPException(status_code=400, detail="run_agent_session.py 를 찾을 수 없습니다")
    subprocess.Popen(  # noqa: S603 — 설치 루트의 자체 스크립트 + 고정 인자
        [sys.executable, str(script), "--close-app-window"],
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        close_fds=True,
        creationflags=_CREATE_NO_WINDOW if os.name == "nt" else 0,
    )
    return {"ok": True}

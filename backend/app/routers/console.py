"""서버 콘솔 패널 API — cmd 창에 보이던 정보(버전·CLI·에이전트 로그)를 앱 안에서 보여준다.

로컬 요청 전용: 로그와 CLI 경로는 이 PC 의 정보라 공유 서버·다른 PC 로 내보내지 않는다.
"""

from __future__ import annotations

import os
import re
import subprocess
import sys
import threading
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

# 로그 꼬리를 화면으로 내보내기 전 비밀값 마스킹 — 과거에 기록된 로그(구버전 포맷 포함)도
# UI 노출은 막는다. Bearer 토큰과 서명 URL 쿼리 키(CloudFront Policy/Signature 등)가 대상.
_MASK_QUERY_KEYS = (
    "token|access_token|api_key|apikey|secret|password|signature|sig|sas"
    "|x-amz-signature|x-amz-security-token|x-goog-signature|key-pair-id|policy|expires"
)
_MASK_PATTERNS = [
    (re.compile(r"(?i)\b(bearer)\s+[A-Za-z0-9._~+/=-]+"), r"\1 ***"),
    # 줄 시작·공백 뒤의 bare `token=...` 형태도 잡는다(?& 만 요구하면 놓침)
    (re.compile(rf"(?i)((?:^|[?&\s])(?:{_MASK_QUERY_KEYS})=)[^&\s\"']+"), r"\1***"),
]


def _mask_secrets(line: str) -> str:
    for pattern, repl in _MASK_PATTERNS:
        line = pattern.sub(repl, line)
    return line


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
        "lines": [_mask_secrets(line) for line in lines[-limit:]],
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
# close-app single-flight — 종료 버튼 연타로 45초짜리 도우미 subprocess 가 동시에 여럿 돌지
# 않게 한다. sync 라우트는 threadpool 스레드에서 돌므로 스레드 락이 유효(단일 uvicorn 프로세스).
_close_app_lock = threading.Lock()


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
    if not _close_app_lock.acquire(blocking=False):
        raise HTTPException(status_code=409, detail="이미 종료가 진행 중입니다")
    try:
        return _run_close_app_helper(script)
    finally:
        _close_app_lock.release()


def _run_close_app_helper(script: Path):
    # 도우미 결과를 기다렸다가 실패면 에러로 — fire-and-forget 이면 창이 그대로인데
    # 프론트가 "종료 중…"에 영구 고정된다. sync 라우트라 threadpool 에서 돌아 이벤트
    # 루프는 막지 않고, 도우미는 Edge·Chrome 프로세스 조회에 각 최대 ~15초 걸릴 수 있다.
    try:
        result = subprocess.run(  # noqa: S603 — 설치 루트의 자체 스크립트 + 고정 인자
            [sys.executable, str(script), "--close-app-window"],
            stdin=subprocess.DEVNULL,
            capture_output=True,
            timeout=45,
            creationflags=_CREATE_NO_WINDOW if os.name == "nt" else 0,
        )
    except subprocess.TimeoutExpired:
        raise HTTPException(
            status_code=504, detail="앱 창 닫기가 응답하지 않습니다 — 창을 직접 닫아도 동일하게 정리됩니다"
        )
    if result.returncode != 0:
        raise HTTPException(
            status_code=409, detail="MV Hub 앱 창을 닫지 못했습니다 — 창을 직접 닫아도 동일하게 정리됩니다"
        )
    return {"ok": True}

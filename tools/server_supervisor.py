# -*- coding: utf-8 -*-
"""공유 서버 프로세스 감독기.

일반적인 1회 크래시는 자동 복구하되, 시작 직후 계속 죽는 설정/DB/포트 오류는
무한 재시작하지 않는다. 빠른 실패가 한도에 닿으면 ALERT를 남기고 비정상 종료해
작업 스케줄러가 5분 뒤 다시 시도하게 한다.
"""
from __future__ import annotations

import os
import subprocess
import sys
import time
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
BACKEND = ROOT / "backend"
SERVER_ENTRYPOINT = BACKEND / "serve.py"


def alert_path() -> Path:
    """운영 경고와 검증용 경고가 서로 덮어쓰지 않도록 경로를 분리한다."""
    configured = os.environ.get("CONTENT_HUB_SERVER_ALERT_PATH", "").strip()
    return Path(configured) if configured else ROOT / "logs" / "server_ALERT.txt"


def restart_delay(
    quick_exit_count: int,
    *,
    initial_seconds: float = 3.0,
    maximum_seconds: float = 60.0,
) -> float:
    """빠른 실패가 반복될수록 대기 시간을 늘려 CPU·로그 폭주를 막는다."""
    count = max(1, int(quick_exit_count))
    return min(maximum_seconds, initial_seconds * (2 ** (count - 1)))


def _write_alert(message: str) -> None:
    path = alert_path()
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(message + "\n", encoding="utf-8")
    except OSError:
        pass


def main() -> int:
    max_quick_exits = max(1, int(os.environ.get("CONTENT_HUB_RESTART_LIMIT", "5")))
    stable_seconds = max(10.0, float(os.environ.get("CONTENT_HUB_STABLE_SECONDS", "120")))
    quick_exits = 0

    while True:
        started = time.monotonic()
        try:
            # Use the absolute entrypoint in the child command line.  The
            # Windows restart helper can then prove that a listener belongs to
            # this exact MV Hub installation before it ever terminates it.
            process = subprocess.Popen([sys.executable, str(SERVER_ENTRYPOINT)], cwd=BACKEND)
            return_code = process.wait()
        except KeyboardInterrupt:
            if "process" in locals() and process.poll() is None:
                process.terminate()
                try:
                    process.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    process.kill()
            print("[supervisor] stop requested", flush=True)
            return 0
        except OSError as exc:
            return_code = -1
            print(f"[supervisor] launch failed: {type(exc).__name__}", flush=True)

        uptime = time.monotonic() - started
        if uptime >= stable_seconds:
            quick_exits = 0
        quick_exits += 1

        if quick_exits >= max_quick_exits:
            message = (
                f"[{datetime.now():%Y-%m-%d %H:%M:%S}] server restart storm blocked — "
                f"{quick_exits} quick exits, last_rc={return_code}. "
                "Check logs\\server_console.log and logs\\mvhub-runtime.jsonl."
            )
            print("[supervisor] ALERT: repeated startup failure; automatic restart paused", flush=True)
            _write_alert(message)
            return 1

        delay = restart_delay(quick_exits)
        print(
            f"[supervisor] server exited rc={return_code}; "
            f"restart {quick_exits}/{max_quick_exits} in {int(delay)}s",
            flush=True,
        )
        time.sleep(delay)


if __name__ == "__main__":
    raise SystemExit(main())

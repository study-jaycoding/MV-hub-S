# -*- coding: utf-8 -*-
"""MV Hub 구조화 운영 로그를 사람이 읽기 쉬운 한 줄로 보여준다."""
from __future__ import annotations

import argparse
import json
import os
import time
from collections import deque
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_LOG = Path(
    os.environ.get(
        "CONTENT_HUB_LOG_DIR", ROOT / "backend" / "data" / "logs"
    )
) / "mvhub-runtime.jsonl"
UPDATE_LOG = ROOT / "logs" / "update.log"

_LABELS = {
    "startup_begin": "서버 시작",
    "startup_ready": "서버 준비 완료",
    "startup_failed": "서버 시작 실패",
    "shutdown_complete": "서버 정상 종료",
    "shutdown_failed": "서버 종료 실패",
    "readiness_failed": "준비 상태 실패",
    "generation_requested": "생성 요청",
    "generation_claimed": "에이전트 실행 시작",
    "generation_job_anchored": "외부 작업 ID 확보",
    "generation_result_waiting": "결과 파일 대기",
    "generation_attention_required": "생성 확인 필요",
    "generation_job_conflict": "작업 ID 충돌 차단",
    "generation_finalized": "생성 최종 확정",
    "backup_completed": "백업 완료",
    "backup_failed": "백업 실패",
    "pm_metrics_failed": "관리 통계 기록 실패",
    "generation_queue_attention": "생성 큐 확인 필요",
    "telemetry_backlog": "관리 데이터 전송 지연",
    "worker_telemetry_received": "생성 정보",
    "browser_connected": "브라우저 연결",
    "browser_disconnected": "브라우저 연결 종료",
    "database_unready": "데이터베이스 준비 실패",
    "generation_journal_write_failed": "생성 이력 저장 실패",
    "audit_journal_write_failed": "감사 기록 저장 실패",
    "audit_change": "중요 설정 변경",
    "http_request": "HTTP 이상",
    "runtime_snapshot_failed": "상태 집계 실패",
}


def _short_time(value: object) -> str:
    text = str(value or "")
    return text[0:19].replace("T", " ") if text else "-"


def format_event(payload: dict[str, Any]) -> str | None:
    event = str(payload.get("event") or payload.get("message") or "")
    level = str(payload.get("level") or "INFO")
    stamp = _short_time(payload.get("ts"))
    if event == "runtime_snapshot":
        snapshot = payload.get("snapshot") or {}
        requests = snapshot.get("requests") or {}
        operations = snapshot.get("operations") or {}
        queue = operations.get("generation_queue") or {}
        agents = snapshot.get("agents") or {}
        websocket = snapshot.get("websocket") or {}
        backups = operations.get("backups") or {}
        telemetry = operations.get("telemetry") or {}
        databases = operations.get("databases") or {}
        status = requests.get("status") or {}
        connected_accounts = max(
            int(agents.get("connected_accounts") or 0),
            int(websocket.get("authenticated_accounts") or 0),
        )
        telemetry_text = (
            f" | 관리전송 대기 {telemetry.get('pending', 0)} (실패 {telemetry.get('failed', 0)})"
            if telemetry.get("applicable", True)
            else ""
        )
        queue_text = (
            f" | 활성 생성 {queue.get('active_total', 0)}"
            if queue.get("applicable", True)
            else ""
        )
        database_text = " | DB 정상" if databases.get("ready", True) else " | DB 오류"
        return (
            f"[{stamp}] 상태 | 요청 {requests.get('total', 0)} (5xx {status.get('5xx', 0)})"
            f"{queue_text}"
            f" | 접속 계정 {connected_accounts}"
            f"{telemetry_text}"
            f"{database_text}"
            f" | 백업 {backups.get('set_count', 0)}세트"
        )

    label = _LABELS.get(event)
    if label is None and level not in {"WARNING", "ERROR", "CRITICAL"}:
        return None
    label = label or event or "운영 이벤트"
    details = []
    for key, title in (
        ("generation_id", "생성"),
        ("worker_name", "작업자"),
        ("connections", "연결"),
        ("connected_accounts", "접속계정"),
        ("request_id", "요청"),
        ("job_id", "작업"),
        ("status", "상태"),
        ("provider_status", "외부상태"),
        ("reason", "사유"),
        ("elapsed_ms", "지연ms"),
        ("failed_checks", "실패검사"),
        ("pending", "전송대기"),
        ("failed", "전송실패"),
        ("received_items", "수신"),
        ("upserted_items", "반영"),
        ("skipped_items", "제외"),
        ("active_items", "진행중"),
        ("completed_items", "완료"),
        ("failed_items", "실패"),
        ("oldest_age_seconds", "최장대기초"),
        ("unanchored_over_10m", "작업ID없음"),
        ("audit_action", "변경"),
        ("target_type", "대상"),
        ("project_id", "프로젝트"),
        ("backup_set_files", "백업파일수"),
        ("backup_set_bytes", "백업크기byte"),
        ("operation", "작업"),
        ("error_type", "오류종류"),
    ):
        value = payload.get(key)
        if value not in (None, "", []):
            details.append(f"{title}={value}")
    suffix = " | " + " · ".join(details) if details else ""
    return f"[{stamp}] {level:<7} {label}{suffix}"


def _tail(path: Path, count: int) -> list[str]:
    with path.open("r", encoding="utf-8", errors="replace") as handle:
        return list(deque(handle, maxlen=max(1, count)))


def _file_identity(stat_result: os.stat_result) -> tuple[int, int, int]:
    # Windows의 st_ctime_ns는 내용 추가에도 바뀌므로 파일 교체 판별에 쓸 수 없다.
    # st_birthtime_ns는 생성 시각이라 안정적이고, 없는 플랫폼은 inode만으로 판별한다.
    birth_time = int(getattr(stat_result, "st_birthtime_ns", 0))
    return (stat_result.st_dev, stat_result.st_ino, birth_time)


def _tail_snapshot(path: Path, count: int) -> tuple[list[str], int, tuple[int, int, int]]:
    """최근 줄과 이어 읽을 위치를 같은 파일 핸들에서 얻는다."""
    with path.open("rb") as handle:
        lines = deque(handle, maxlen=max(1, count))
        position = handle.tell()
        identity = _file_identity(os.fstat(handle.fileno()))
    return [line.decode("utf-8", errors="replace") for line in lines], position, identity


class LogFollower:
    """Windows 로그 회전을 막지 않도록 새 내용이 있을 때만 파일을 짧게 연다."""

    def __init__(
        self,
        path: Path,
        position: int,
        identity: tuple[int, int, int],
    ) -> None:
        self.path = path
        self.position = position
        self.identity = identity
        self.pending = b""

    def poll(self) -> list[str]:
        try:
            current = self.path.stat()
        except OSError:
            return []

        current_identity = _file_identity(current)
        if current_identity != self.identity or current.st_size < self.position:
            self.position = 0
            self.identity = current_identity
            self.pending = b""
        if current.st_size <= self.position:
            return []

        try:
            with self.path.open("rb") as handle:
                opened_identity = _file_identity(os.fstat(handle.fileno()))
                if opened_identity != self.identity:
                    self.position = 0
                    self.identity = opened_identity
                    self.pending = b""
                handle.seek(self.position)
                chunk = handle.read()
                self.position = handle.tell()
        except OSError:
            return []

        self.pending += chunk
        parts = self.pending.split(b"\n")
        self.pending = parts.pop()
        return [part.decode("utf-8", errors="replace").rstrip("\r") for part in parts]


def recent_update_lines(path: Path = UPDATE_LOG, count: int = 5) -> list[str]:
    if not path.is_file():
        return []
    try:
        return [line.strip() for line in _tail(path, count) if line.strip()]
    except OSError:
        return []


def _show_line(raw: str) -> None:
    try:
        payload = json.loads(raw)
    except (TypeError, ValueError):
        return
    if not isinstance(payload, dict):
        return
    line = format_event(payload)
    if line:
        print(line, flush=True)


def main() -> int:
    parser = argparse.ArgumentParser(description="MV Hub 운영 로그 보기")
    parser.add_argument("--log", type=Path, default=DEFAULT_LOG)
    parser.add_argument("--tail", type=int, default=100)
    parser.add_argument("--once", action="store_true", help="최근 로그만 보고 종료")
    args = parser.parse_args()

    for alert_name in ("server_ALERT.txt", "watchdog_ALERT.txt"):
        alert = ROOT / "logs" / alert_name
        if alert.is_file():
            text = alert.read_text(encoding="utf-8", errors="replace").strip()
            if text:
                print(f"[ALERT] {text}")

    update_lines = recent_update_lines()
    if update_lines:
        print("최근 프로그램 업데이트:")
        for line in update_lines:
            print(f"  {line}")

    path = args.log.resolve()
    if not path.is_file():
        print(f"운영 로그가 아직 없습니다: {path}")
        print(f"초기 빌드/실행 오류는 {ROOT / 'logs' / 'server_console.log'} 에서 확인하세요.")
        return 1

    recent, position, identity = _tail_snapshot(path, args.tail)
    print(f"MV Hub 운영 로그: {path} (Ctrl+C 종료)")
    for raw in recent:
        _show_line(raw)
    if args.once:
        return 0

    try:
        follower = LogFollower(path, position, identity)
        while True:
            for raw in follower.poll():
                _show_line(raw)
            time.sleep(0.5)
    except KeyboardInterrupt:
        return 0


if __name__ == "__main__":
    raise SystemExit(main())

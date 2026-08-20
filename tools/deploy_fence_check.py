"""혼합 배포 직전 생성 파이프라인이 완전히 비었는지 읽기 전용으로 검사한다.

종료 코드:
  0: 생성 일시중지가 켜졌고 두 집계가 모두 0
  2: 일시중지가 꺼졌거나 진행 중 흔적이 남아 배포 차단
  3: DB 파일/스키마를 안전하게 읽을 수 없어 판정 실패
"""

from __future__ import annotations

import argparse
import os
import sqlite3
import sys
from collections.abc import Sequence
from contextlib import closing
from pathlib import Path
from typing import Any


EXIT_SAFE = 0
EXIT_BLOCKED = 2
EXIT_CHECK_ERROR = 3
PAUSE_SETTING_KEY = "generation_deployment_paused"
TERMINAL_REQUEST_STATUSES = ("done", "failed", "canceled")
ACTIVE_GENERATION_STATUSES = ("pending", "running")
TRUE_SETTING_VALUES = frozenset({"1", "true", "yes", "on"})
REPO_ROOT = Path(__file__).resolve().parent.parent


def default_db_path() -> Path:
    """서버와 같은 환경변수 우선순위로 기본 콘텐츠 DB 경로를 고른다."""
    configured = os.environ.get("CONTENT_HUB_DB", "").strip()
    if configured:
        return Path(configured).expanduser().resolve()
    data_root = Path(
        os.environ.get("CONTENT_HUB_DATA", str(REPO_ROOT / "backend" / "data"))
    ).expanduser()
    return (data_root / "db" / "content_hub.db").resolve()


def _readonly_connection(db_path: Path) -> sqlite3.Connection:
    resolved = db_path.expanduser().resolve()
    if not resolved.is_file():
        raise FileNotFoundError(f"DB 파일이 없습니다: {resolved}")
    connection = sqlite3.connect(f"{resolved.as_uri()}?mode=ro", uri=True, timeout=5)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA query_only=ON")
    connection.execute("PRAGMA busy_timeout=5000")
    return connection


def _grouped_counts(
    connection: sqlite3.Connection,
    table: str,
    where_sql: str,
    params: Sequence[object],
) -> dict[str, int]:
    rows = connection.execute(
        f"SELECT status, COUNT(*) AS count FROM {table} "
        f"WHERE {where_sql} GROUP BY status ORDER BY status",
        tuple(params),
    ).fetchall()
    return {str(row["status"]): int(row["count"]) for row in rows}


def inspect_fence(db_path: Path) -> dict[str, Any]:
    """DB를 수정하지 않고 pause·요청·generation 상태를 한 읽기 스냅샷에서 집계한다."""
    with closing(_readonly_connection(db_path)) as connection:
        connection.execute("BEGIN")
        pause_row = connection.execute(
            "SELECT value FROM app_setting WHERE key=?",
            (PAUSE_SETTING_KEY,),
        ).fetchone()
        paused = bool(
            pause_row
            and str(pause_row["value"] or "").strip().lower() in TRUE_SETTING_VALUES
        )

        request_marks = ",".join("?" for _ in TERMINAL_REQUEST_STATUSES)
        request_counts = _grouped_counts(
            connection,
            "gen_request",
            f"status NOT IN ({request_marks})",
            TERMINAL_REQUEST_STATUSES,
        )
        generation_marks = ",".join("?" for _ in ACTIVE_GENERATION_STATUSES)
        generation_counts = _grouped_counts(
            connection,
            "generation",
            f"status IN ({generation_marks})",
            ACTIVE_GENERATION_STATUSES,
        )
        connection.execute("ROLLBACK")

    request_total = sum(request_counts.values())
    generation_total = sum(generation_counts.values())
    return {
        "db_path": str(db_path.expanduser().resolve()),
        "paused": paused,
        "non_terminal_request_total": request_total,
        "non_terminal_request_counts": request_counts,
        "active_generation_total": generation_total,
        "active_generation_counts": generation_counts,
        "safe": paused and request_total == 0 and generation_total == 0,
    }


def _format_counts(counts: dict[str, int]) -> str:
    if not counts:
        return "없음"
    return ", ".join(f"{status}={count}" for status, count in counts.items())


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="배포 전 생성 일시중지와 진행 중 DB 흔적 0건을 읽기 전용으로 검사합니다."
    )
    parser.add_argument(
        "--db",
        type=Path,
        default=default_db_path(),
        help="콘텐츠 SQLite DB 경로(기본: CONTENT_HUB_DB/CONTENT_HUB_DATA 또는 backend\\data\\db)",
    )
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        result = inspect_fence(args.db)
    except (FileNotFoundError, sqlite3.Error, OSError) as exc:
        print("[판정 실패] 배포 fence DB를 읽을 수 없습니다.", file=sys.stderr)
        print(f"DB: {args.db.expanduser().resolve()}", file=sys.stderr)
        print(f"원인: {exc}", file=sys.stderr)
        return EXIT_CHECK_ERROR

    print(f"DB: {result['db_path']}")
    print(f"생성 접수 일시중지: {'ON' if result['paused'] else 'OFF'}")
    print(
        "미종결 gen_request: "
        f"{result['non_terminal_request_total']} "
        f"({_format_counts(result['non_terminal_request_counts'])})"
    )
    print(
        "진행 중 generation(status=pending/running): "
        f"{result['active_generation_total']} "
        f"({_format_counts(result['active_generation_counts'])})"
    )
    if result["safe"]:
        print("[통과] 배포 fence 조건이 모두 0입니다.")
        return EXIT_SAFE
    print("[차단] 일시중지 ON과 두 집계 0건을 모두 확인하기 전에는 배포하지 마세요.")
    return EXIT_BLOCKED


if __name__ == "__main__":
    raise SystemExit(main())

"""RL-02 작업 워크스페이스 이관을 운영 DB의 안전한 복사본에서 검증한다.

원본 DB는 읽기 전용 SQLite backup API로 스냅샷만 만들고, 스키마 이관·재실행·복원
검증은 임시 파일에서만 수행한다. 결과는 배포 판정용 JSON으로 남긴다.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import sqlite3
import sys
import tempfile
from contextlib import closing
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
BACKEND = ROOT / "backend"
if str(BACKEND) not in sys.path:
    sys.path.insert(0, str(BACKEND))


def _backup(source: Path, destination: Path) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    uri = source.resolve().as_uri() + "?mode=ro"
    with closing(sqlite3.connect(uri, uri=True)) as src:
        with closing(sqlite3.connect(destination)) as dst:
            src.backup(dst)


def _quick_check(path: Path) -> str:
    with closing(sqlite3.connect(path)) as conn:
        return str(conn.execute("PRAGMA quick_check").fetchone()[0])


def _counts(path: Path) -> dict[str, int]:
    wanted = ("generation", "project", "project_task", "task_generation", "task_assignment")
    with closing(sqlite3.connect(path)) as conn:
        tables = {
            row[0]
            for row in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")
        }
        return {
            table: int(conn.execute(f'SELECT COUNT(*) FROM "{table}"').fetchone()[0])
            for table in wanted
            if table in tables
        }


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest().upper()


def _validate_report_target(source: Path, report_path: Path) -> None:
    """보고서가 운영 DB나 SQLite 보조 파일을 덮어쓰지 못하게 한다."""
    source_path = source.resolve()
    report_target = report_path.resolve()
    protected = {
        source_path,
        Path(f"{source_path}-wal"),
        Path(f"{source_path}-shm"),
        Path(f"{source_path}-journal"),
    }
    if report_target in protected:
        raise ValueError(f"보고서 경로는 원본 DB 계열 파일과 달라야 합니다: {report_target}")


def _write_report_atomic(report_path: Path, result: dict[str, Any]) -> None:
    """중단 시 반쪽 JSON이 남지 않도록 같은 폴더에서 완성 뒤 교체한다."""
    report_path.parent.mkdir(parents=True, exist_ok=True)
    fd, temp_name = tempfile.mkstemp(
        prefix=f".{report_path.name}.", suffix=".tmp", dir=report_path.parent
    )
    os.close(fd)
    temp_path = Path(temp_name)
    try:
        temp_path.write_text(
            json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8"
        )
        os.replace(temp_path, report_path)
    finally:
        temp_path.unlink(missing_ok=True)


def run(source: Path, report_path: Path) -> dict[str, Any]:
    if not source.is_file():
        raise FileNotFoundError(f"DB 파일을 찾을 수 없습니다: {source}")
    _validate_report_target(source, report_path)

    with tempfile.TemporaryDirectory(prefix="mvhub-task-workspace-") as temp_dir:
        temp = Path(temp_dir)
        snapshot = temp / "source-snapshot.db"
        migrated = temp / "migration-copy.db"
        restored = temp / "rollback-copy.db"
        _backup(source, snapshot)
        _backup(snapshot, migrated)

        before_counts = _counts(snapshot)
        source_check = _quick_check(snapshot)
        if source_check != "ok":
            raise RuntimeError(f"원본 스냅샷 무결성 실패: {source_check}")

        old_db = os.environ.get("CONTENT_HUB_DB")
        os.environ["CONTENT_HUB_DB"] = str(migrated)
        db_module = None
        try:
            from app import db as db_module
            from app.repo import manage
            from app.repo.manage_schema import task_workspace_migration_preflight

            db_module.flush_pool()
            with db_module.get_connection() as conn:
                has_tasks = bool(
                    conn.execute(
                        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='project_task'"
                    ).fetchone()
                )
                preflight = (
                    task_workspace_migration_preflight(conn)
                    if has_tasks
                    else {
                        "multi_workspace_projects": 0,
                        "multi_workspace_folders": 0,
                        "multi_workspace_manual_tasks": 0,
                        "manual_tasks_without_generations": 0,
                    }
                )

            # 운영 원본이 아니라 ``migrated`` 복사본에서만 코어 스키마를 먼저 올린다.
            # 오래된 설치본은 generation.folder_path/workspace_*가 없을 수 있는데,
            # 관리 스키마 이관은 그 컬럼들을 근거로 사용한다. 앱의 정상 부팅도 init_db()
            # 뒤에 관리 스키마를 보장하므로 사전점검 도구도 같은 순서를 따라야 한다.
            db_module.flush_pool()
            db_module.init_db(migrated)
            db_module.flush_pool()
            with db_module.get_connection() as conn:
                manage._ensure_schema(conn)
            first_counts = _counts(migrated)

            # 새 프로세스에서도 완료 표식이 전체 생성물 재스캔/행 증가를 막는지 확인한다.
            db_module.flush_pool()
            with db_module.get_connection() as conn:
                manage._ensure_schema(conn)
                marker = conn.execute(
                    "SELECT value FROM manage_schema_state "
                    "WHERE key='task_workspace_snapshot_v1'"
                ).fetchone()
                foreign_key_errors = len(conn.execute("PRAGMA foreign_key_check").fetchall())
            second_counts = _counts(migrated)
        finally:
            try:
                if db_module is not None:
                    db_module.flush_pool()
            except Exception:
                pass
            if old_db is None:
                os.environ.pop("CONTENT_HUB_DB", None)
            else:
                os.environ["CONTENT_HUB_DB"] = old_db

        migrated_check = _quick_check(migrated)
        _backup(snapshot, restored)
        restored_check = _quick_check(restored)
        restored_counts = _counts(restored)
        result = {
            "generated_at": datetime.now(timezone.utc).isoformat(),
            "source": str(source.resolve()),
            "source_snapshot_sha256": _sha256(snapshot),
            "preflight": preflight,
            "before_counts": before_counts,
            "after_first_migration_counts": first_counts,
            "after_second_migration_counts": second_counts,
            "idempotent": first_counts == second_counts,
            "migration_marker": marker["value"] if marker else None,
            "integrity": {
                "source_snapshot": source_check,
                "migrated_copy": migrated_check,
                "rollback_copy": restored_check,
                "foreign_key_errors": foreign_key_errors,
            },
            "rollback_counts_match": before_counts == restored_counts,
            "passed": bool(
                source_check == migrated_check == restored_check == "ok"
                and foreign_key_errors == 0
                and first_counts == second_counts
                and marker
                and marker["value"] == "complete"
                and before_counts == restored_counts
            ),
        }

    _write_report_atomic(report_path, result)
    return result


def main() -> int:
    parser = argparse.ArgumentParser(description="MV Hub 작업 워크스페이스 DB 이관 사전 검증")
    parser.add_argument("--db", type=Path, help="검증할 content_hub.db (생략 시 현재 계정 DB)")
    parser.add_argument("--report", type=Path, help="JSON 보고서 경로")
    args = parser.parse_args()

    if args.db:
        source = args.db
    else:
        from app.db import get_db_path

        source = get_db_path()
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    report = args.report or ROOT / "predeploy-reports" / f"task-workspace-{stamp}.json"
    result = run(source, report)
    print(f"[task-workspace] {'PASS' if result['passed'] else 'FAIL'}")
    print(f"[task-workspace] report: {report.resolve()}")
    print(json.dumps(result["preflight"], ensure_ascii=False))
    return 0 if result["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())

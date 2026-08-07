"""브라우저 다중 사용자 실측용 팀 사용량 팩트.

운영 DB 오염을 막기 위해 이름이 data_test 또는 data_test_push 인 데이터 폴더만 허용한다.
고정 접두사로 넣은 행만 clean 할 수 있어 서버 스냅샷의 원래 데이터는 건드리지 않는다.

사용 예(PowerShell):
  python tools\\seed_manage_multi_user_test_data.py backend\\data_test apply
  python tools\\seed_manage_multi_user_test_data.py backend\\data_test clean
"""

from __future__ import annotations

import argparse
import sqlite3
from contextlib import closing
from datetime import datetime, timedelta, timezone
from pathlib import Path


ALLOWED_DATA_DIR_NAMES = {"data_test", "data_test_push"}
FIXTURE_ACCOUNT_PREFIX = "mvhub-browser-test+"
FIXTURE_LOCAL_PREFIX = "mvhub-browser-test-"


def resolve_manage_db(data_dir: Path) -> Path:
    resolved = data_dir.resolve()
    if resolved.name.lower() not in ALLOWED_DATA_DIR_NAMES:
        raise ValueError(
            "다중 사용자 검증 데이터는 data_test 또는 data_test_push 폴더에만 넣을 수 있습니다."
        )
    db_path = resolved / "db" / "manage_hub.db"
    if not db_path.is_file():
        raise FileNotFoundError(f"테스트 관리 DB가 없습니다: {db_path}")
    return db_path


def _table_columns(conn: sqlite3.Connection) -> set[str]:
    return {str(row[1]) for row in conn.execute("PRAGMA table_info(team_generation_fact)")}


def _check_schema(conn: sqlite3.Connection) -> None:
    required = {
        "id",
        "account_email",
        "creator_uid",
        "creator_name",
        "local_gen_id",
        "workspace_scope",
        "workspace_id",
        "workspace_name",
        "project_id",
        "project_name",
        "folder_path",
        "model",
        "output_type",
        "status",
        "real_credits",
        "elapsed_seconds",
        "created_at",
        "sort_ts",
        "is_final",
        "is_shared",
        "is_deleted",
        "last_seen_at",
        "updated_at",
    }
    missing = required - _table_columns(conn)
    if missing:
        raise RuntimeError(f"team_generation_fact 스키마가 오래되었습니다: {sorted(missing)}")


def _discover_scope(conn: sqlite3.Connection) -> tuple[str, str, str | None, str | None]:
    workspace = conn.execute(
        "SELECT workspace_id, MAX(workspace_name) AS workspace_name "
        "FROM team_generation_fact "
        "WHERE workspace_scope='team' AND workspace_id IS NOT NULL "
        "AND account_email NOT LIKE ? "
        "GROUP BY workspace_id "
        "ORDER BY COUNT(*) DESC, workspace_id LIMIT 1",
        (f"{FIXTURE_ACCOUNT_PREFIX}%",),
    ).fetchone()
    if workspace is None:
        raise RuntimeError("기준이 될 팀 워크스페이스 데이터가 없습니다. test_pull-db를 먼저 실행하세요.")
    workspace_id = str(workspace[0])
    project = conn.execute(
        "SELECT project_id, MAX(project_name) AS project_name "
        "FROM team_generation_fact "
        "WHERE workspace_scope='team' AND workspace_id=? AND project_id IS NOT NULL "
        "AND account_email NOT LIKE ? "
        "GROUP BY project_id ORDER BY COUNT(*) DESC, project_id LIMIT 1",
        (workspace_id, f"{FIXTURE_ACCOUNT_PREFIX}%"),
    ).fetchone()
    return (
        workspace_id,
        str(workspace[1] or workspace_id),
        project[0] if project else None,
        project[1] if project else None,
    )


def clean_fixture(conn: sqlite3.Connection) -> int:
    cursor = conn.execute(
        "DELETE FROM team_generation_fact "
        "WHERE account_email LIKE ? OR local_gen_id LIKE ?",
        (f"{FIXTURE_ACCOUNT_PREFIX}%", f"{FIXTURE_LOCAL_PREFIX}%"),
    )
    return max(int(cursor.rowcount or 0), 0)


def apply_fixture(conn: sqlite3.Connection) -> dict[str, object]:
    _check_schema(conn)
    workspace_id, workspace_name, project_id, project_name = _discover_scope(conn)
    clean_fixture(conn)

    now = datetime.now(timezone.utc).replace(microsecond=0)
    rows = [
        ("river", "리버", "river@example.invalid", "Seedance 2.0", "video", 12.0, 180, 0, "qa_multi/river_c0010", 7),
        ("river", "리버", "river@example.invalid", "Nano Banana 2", "image", 4.0, 45, 1, "qa_multi/river_c0010", 6),
        ("oji", "오지짱", "oji@example.invalid", "Nano Banana 2", "image", 5.0, 50, 0, "qa_multi/oji_c0020", 5),
        ("oji", "오지짱", "oji@example.invalid", "Cinematic Studio Video 3.5", "video", 3.0, 90, 0, "qa_multi/oji_c0020", 4),
    ]
    for index, (slug, name, email, model, output_type, credits, elapsed, is_final, folder, minutes) in enumerate(rows, 1):
        created = now - timedelta(minutes=minutes)
        account_email = f"{FIXTURE_ACCOUNT_PREFIX}{email}"
        local_id = f"{FIXTURE_LOCAL_PREFIX}{slug}-{index}"
        conn.execute(
            "INSERT INTO team_generation_fact("
            "id, account_email, creator_uid, creator_name, local_gen_id, "
            "workspace_scope, workspace_id, workspace_name, project_id, project_name, "
            "folder_path, model, output_type, status, real_credits, elapsed_seconds, "
            "created_at, sort_ts, is_final, is_shared, is_deleted, last_seen_at, updated_at"
            ") VALUES(?,?,?,?,?,'team',?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (
                f"{FIXTURE_LOCAL_PREFIX}fact-{index}",
                account_email,
                f"mvhub-test-{slug}",
                name,
                local_id,
                workspace_id,
                workspace_name,
                project_id,
                project_name,
                folder,
                model,
                output_type,
                "done",
                credits,
                elapsed,
                created.isoformat().replace("+00:00", "Z"),
                created.timestamp(),
                is_final,
                0,
                0,
                now.isoformat().replace("+00:00", "Z"),
                now.isoformat().replace("+00:00", "Z"),
            ),
        )
    return {
        "workspace_id": workspace_id,
        "workspace_name": workspace_name,
        "project_id": project_id,
        "project_name": project_name,
        "rows": len(rows),
        "credits": sum(float(row[5]) for row in rows),
        "members": ["리버", "오지짱"],
    }


def run(data_dir: Path, action: str) -> dict[str, object]:
    db_path = resolve_manage_db(data_dir)
    with closing(sqlite3.connect(db_path, timeout=15)) as conn:
        conn.execute("PRAGMA busy_timeout=15000")
        _check_schema(conn)
        if action == "apply":
            result = apply_fixture(conn)
        else:
            result = {"removed": clean_fixture(conn)}
        conn.commit()
    return {"db": str(db_path), **result}


def main() -> int:
    parser = argparse.ArgumentParser(description="테스트 DB에 다중 사용자 PM 데이터를 넣거나 제거합니다.")
    parser.add_argument("data_dir", type=Path)
    parser.add_argument("action", choices=("apply", "clean"))
    args = parser.parse_args()
    result = run(args.data_dir, args.action)
    print("[multi-user-test] " + " · ".join(f"{key}={value}" for key, value in result.items()))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

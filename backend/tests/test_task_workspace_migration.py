"""RL-02: 기존 project_task를 삭제 없이 워크스페이스 스냅샷으로 이관한다."""

from __future__ import annotations

import os
import sqlite3
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock


ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from app import db, repo
from app.repo import manage
from app.repo import manage_schema
from app.repo.manage_schema import task_workspace_migration_preflight
from tools.preflight_task_workspace import run as run_preflight


LEGACY_TASK_SCHEMA = """CREATE TABLE project_task (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    name TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'not_started',
    assignee_uid TEXT,
    start_date TEXT,
    due_date TEXT,
    sort_order INTEGER,
    note TEXT,
    sequence TEXT,
    description TEXT,
    folder_path TEXT,
    source_kind TEXT NOT NULL DEFAULT 'manual',
    source_last_seen_at TEXT,
    archived INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
)"""


class TaskWorkspaceMigrationTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory(ignore_cleanup_errors=True)
        self.old_db = os.environ.get("CONTENT_HUB_DB")
        os.environ["CONTENT_HUB_DB"] = os.path.join(self.tmp.name, "content_hub.db")
        db.flush_pool()
        db.init_db()
        repo.ensure_default_worker()
        with db.get_connection() as conn:
            conn.execute(LEGACY_TASK_SCHEMA)
            conn.execute(
                "CREATE TABLE task_generation(task_id TEXT NOT NULL, gen_id TEXT NOT NULL, "
                "PRIMARY KEY(task_id, gen_id))"
            )
            conn.execute(
                "CREATE TABLE task_assignment(task_id TEXT NOT NULL, assignee_uid TEXT NOT NULL, "
                "added_by TEXT, created_at TEXT DEFAULT (datetime('now')), "
                "PRIMARY KEY(task_id, assignee_uid))"
            )
            conn.execute(
                "INSERT INTO project(id,name,kind,workspace_scope,workspace_id,workspace_name) "
                "VALUES('p1','이동 프로젝트','team','team','ws-b','B')"
            )
            self._gen(conn, "ga", "ws-a", "A", "ep001/c0010")
            self._gen(conn, "gb", "ws-b", "B", "ep001/c0010")
            self._gen(conn, "ga2", "ws-a", "A", "ep002/c0020")
            self._gen(conn, "ga3", "ws-a", "A", "ep003/c0030")
            self._gen(conn, "gm-a", "ws-a", "A", None)
            self._gen(conn, "gm-b", "ws-b", "B", None)
            conn.execute(
                "INSERT INTO project_task(id,project_id,name,status,note,sequence,folder_path,source_kind) "
                "VALUES('multi-folder','p1','PM 이름','done','보존 메모','c0010',"
                "'ep001/c0010','generation')"
            )
            conn.execute(
                "INSERT INTO project_task(id,project_id,name,folder_path,source_kind) "
                "VALUES('single-folder','p1','ep002','ep002/c0020','generation')"
            )
            # 구버전에서 folder_path는 있으나 source_kind 기본값(manual)으로 남은 실제 이관 모양.
            conn.execute(
                "INSERT INTO project_task(id,project_id,name,folder_path) "
                "VALUES('legacy-default-folder','p1','ep003','ep003/c0030')"
            )
            conn.execute(
                "INSERT INTO project_task(id,project_id,name,source_kind) "
                "VALUES('manual-one','p1','수동 하나','manual')"
            )
            conn.execute(
                "INSERT INTO project_task(id,project_id,name,source_kind) "
                "VALUES('manual-multi','p1','수동 혼합','manual')"
            )
            conn.execute(
                "INSERT INTO project_task(id,project_id,name,source_kind) "
                "VALUES('manual-empty','p1','수동 빈 작업','manual')"
            )
            conn.execute(
                "INSERT INTO task_assignment(task_id,assignee_uid,added_by) "
                "VALUES('multi-folder','worker-a','pm')"
            )
            conn.execute("INSERT INTO task_generation VALUES('manual-one','gm-a')")
            conn.execute("INSERT INTO task_generation VALUES('manual-multi','gm-a')")
            conn.execute("INSERT INTO task_generation VALUES('manual-multi','gm-b')")

    @staticmethod
    def _gen(conn, gid: str, workspace_id: str, workspace_name: str, folder: str | None) -> None:
        conn.execute(
            "INSERT INTO generation(id,worker_id,prompt,status,project_id,folder_path,"
            "workspace_scope,workspace_id,workspace_name,created_at,sort_ts) "
            "VALUES(?, 'me', 'p', 'done', 'p1', ?, 'team', ?, ?, datetime('now'), "
            "strftime('%s','now'))",
            (gid, folder, workspace_id, workspace_name),
        )

    def tearDown(self) -> None:
        db.flush_pool()
        if self.old_db is None:
            os.environ.pop("CONTENT_HUB_DB", None)
        else:
            os.environ["CONTENT_HUB_DB"] = self.old_db
        db.flush_pool()
        self.tmp.cleanup()

    def test_preflight_is_read_only_and_reports_ambiguous_shapes(self) -> None:
        with db.get_connection() as conn:
            before = conn.total_changes
            report = task_workspace_migration_preflight(conn)
            self.assertEqual(conn.total_changes - before, 0)

        self.assertEqual(report["multi_workspace_projects"], 1)
        self.assertEqual(report["multi_workspace_folders"], 1)
        self.assertEqual(report["multi_workspace_manual_tasks"], 1)
        self.assertEqual(report["manual_tasks_without_generations"], 1)

    def test_preflight_reads_very_old_schema_without_writing_or_guessing(self) -> None:
        """스키마 이관 전 도구가 workspace/folder 컬럼 없는 DB에서도 먼저 실행돼야 한다."""
        conn = sqlite3.connect(":memory:")
        conn.row_factory = sqlite3.Row
        try:
            conn.execute("CREATE TABLE generation(id TEXT PRIMARY KEY, project_id TEXT)")
            conn.execute(
                "CREATE TABLE project_task(id TEXT PRIMARY KEY, project_id TEXT, name TEXT)"
            )
            conn.execute(
                "CREATE TABLE task_generation(task_id TEXT NOT NULL, gen_id TEXT NOT NULL)"
            )
            conn.execute("INSERT INTO generation VALUES('g-old','p-old')")
            conn.execute("INSERT INTO project_task VALUES('linked','p-old','연결 작업')")
            conn.execute("INSERT INTO project_task VALUES('empty','p-old','빈 작업')")
            conn.execute("INSERT INTO task_generation VALUES('linked','g-old')")
            before = conn.total_changes

            report = task_workspace_migration_preflight(conn)

            self.assertEqual(conn.total_changes, before)
            self.assertEqual(report["multi_workspace_projects"], 0)
            self.assertEqual(report["multi_workspace_folders"], 0)
            self.assertEqual(report["multi_workspace_manual_tasks"], 0)
            self.assertEqual(report["manual_tasks_without_generations"], 1)
        finally:
            conn.close()

    def test_preflight_accepts_database_before_manage_feature_existed(self) -> None:
        """project_task 자체가 없는 구 DB도 읽기 전용 사전점검을 통과한다."""
        conn = sqlite3.connect(":memory:")
        conn.row_factory = sqlite3.Row
        try:
            conn.execute("CREATE TABLE generation(id TEXT PRIMARY KEY, project_id TEXT)")
            conn.execute("INSERT INTO generation VALUES('g-old','p-old')")
            before = conn.total_changes

            report = task_workspace_migration_preflight(conn)

            self.assertEqual(conn.total_changes, before)
            self.assertEqual(report["multi_workspace_projects"], 0)
            self.assertEqual(report["multi_workspace_folders"], 0)
            self.assertEqual(report["multi_workspace_manual_tasks"], 0)
            self.assertEqual(report["manual_tasks_without_generations"], 0)
        finally:
            conn.close()

    def test_preflight_tool_migrates_realistic_old_copy_end_to_end(self) -> None:
        """구 generation 컬럼이 빠진 운영 DB도 복사본에서 코어→관리 순으로 이관한다."""
        source = Path(self.tmp.name) / "preflight-old.db"
        report_path = Path(self.tmp.name) / "preflight-report.json"
        conn = sqlite3.connect(source)
        try:
            conn.execute(LEGACY_TASK_SCHEMA)
            conn.executescript(
                """
                CREATE TABLE generation(
                    id TEXT PRIMARY KEY,
                    worker_id TEXT NOT NULL,
                    prompt TEXT NOT NULL,
                    model TEXT,
                    params TEXT,
                    color TEXT,
                    status TEXT NOT NULL DEFAULT 'pending',
                    created_at TEXT NOT NULL DEFAULT (datetime('now')),
                    project_id TEXT
                );
                CREATE TABLE task_generation(task_id TEXT NOT NULL, gen_id TEXT NOT NULL);
                INSERT INTO generation(id,worker_id,prompt,status,project_id)
                VALUES('g-old','me','old','done','p-old');
                INSERT INTO project_task(id,project_id,name)
                VALUES('t-old','p-old','옛 작업');
                INSERT INTO task_generation VALUES('t-old','g-old');
                """
            )
            conn.commit()
        finally:
            conn.close()

        result = run_preflight(source, report_path)

        self.assertTrue(result["passed"])
        self.assertTrue(result["idempotent"])
        self.assertEqual(result["migration_marker"], "complete")
        self.assertEqual(result["integrity"]["foreign_key_errors"], 0)
        self.assertTrue(result["rollback_counts_match"])
        self.assertTrue(report_path.is_file())
        self.assertEqual(
            list(report_path.parent.glob(f".{report_path.name}.*.tmp")),
            [],
            "원자 저장용 임시 보고서가 남으면 안 된다",
        )
        # 원본에는 사전점검이 새 컬럼을 쓰지 않는다.
        with sqlite3.connect(source) as original:
            columns = {row[1] for row in original.execute("PRAGMA table_info(generation)")}
        self.assertNotIn("folder_path", columns)
        self.assertNotIn("workspace_scope", columns)

    def test_preflight_report_cannot_overwrite_source_or_sqlite_sidecars(self) -> None:
        source = Path(os.environ["CONTENT_HUB_DB"])
        db.flush_pool()
        before = source.read_bytes()

        for suffix in ("", "-wal", "-shm", "-journal"):
            report_path = Path(f"{source}{suffix}")
            with self.subTest(report_path=report_path):
                with self.assertRaisesRegex(ValueError, "원본 DB 계열"):
                    run_preflight(source, report_path)

        self.assertEqual(source.read_bytes(), before)

    def test_migration_preserves_ambiguous_original_and_creates_clean_snapshots(self) -> None:
        with db.get_connection() as conn:
            manage._ensure_schema(conn)
            original = dict(
                conn.execute("SELECT * FROM project_task WHERE id='multi-folder'").fetchone()
            )
            derived = [
                dict(row)
                for row in conn.execute(
                    "SELECT * FROM project_task WHERE project_id='p1' "
                    "AND folder_path='ep001/c0010' AND id<>'multi-folder' ORDER BY workspace_id"
                )
            ]
            assignments = conn.execute(
                "SELECT task_id,assignee_uid FROM task_assignment ORDER BY task_id"
            ).fetchall()

        self.assertEqual(original["workspace_scope"], "unknown")
        self.assertEqual(original["workspace_origin"], "unknown")
        self.assertEqual(original["name"], "PM 이름")
        self.assertEqual(original["status"], "done")
        self.assertEqual(original["note"], "보존 메모")
        self.assertEqual([row["workspace_id"] for row in derived], ["ws-a", "ws-b"])
        self.assertTrue(all(row["workspace_origin"] == "generation" for row in derived))
        self.assertTrue(all(row["status"] == "not_started" for row in derived))
        self.assertTrue(all(row["note"] is None for row in derived))
        self.assertEqual([(row["task_id"], row["assignee_uid"]) for row in assignments], [
            ("multi-folder", "worker-a")
        ])

    def test_single_evidence_is_assigned_and_second_run_is_idempotent(self) -> None:
        with db.get_connection() as conn:
            manage._ensure_schema(conn)
            folder = dict(
                conn.execute("SELECT * FROM project_task WHERE id='single-folder'").fetchone()
            )
            manual = dict(
                conn.execute("SELECT * FROM project_task WHERE id='manual-one'").fetchone()
            )
            mixed = dict(
                conn.execute("SELECT * FROM project_task WHERE id='manual-multi'").fetchone()
            )
            legacy_folder = dict(
                conn.execute(
                    "SELECT * FROM project_task WHERE id='legacy-default-folder'"
                ).fetchone()
            )
            count_before = conn.execute("SELECT COUNT(*) AS c FROM project_task").fetchone()["c"]

        self.assertEqual((folder["workspace_scope"], folder["workspace_id"]), ("team", "ws-a"))
        self.assertEqual((manual["workspace_scope"], manual["workspace_id"]), ("team", "ws-a"))
        self.assertEqual(mixed["workspace_scope"], "unknown")
        self.assertEqual(legacy_folder["source_kind"], "generation")
        self.assertEqual(
            (legacy_folder["workspace_scope"], legacy_folder["workspace_id"]),
            ("team", "ws-a"),
        )

        # 풀 에폭을 바꿔 스키마 보장을 실제로 재실행한다.
        db.flush_pool()
        with db.get_connection() as conn:
            manage._ensure_schema(conn)
            count_after = conn.execute("SELECT COUNT(*) AS c FROM project_task").fetchone()["c"]
        self.assertEqual(count_after, count_before)

    def test_partial_indexes_reject_duplicates_per_scope_but_allow_other_workspace(self) -> None:
        with db.get_connection() as conn:
            manage._ensure_schema(conn)
            with self.assertRaises(sqlite3.IntegrityError):
                conn.execute(
                    "INSERT INTO project_task(id,project_id,name,folder_path,source_kind,"
                    "workspace_scope,workspace_id,workspace_origin) "
                    "VALUES('dup-a','p1','dup','ep002/c0020','generation','team','ws-a','snapshot')"
                )
            conn.execute(
                "INSERT INTO project_task(id,project_id,name,folder_path,source_kind,"
                "workspace_scope,workspace_id,workspace_origin) "
                "VALUES('other-team','p1','other','ep002/c0020','generation','team','ws-b','snapshot')"
            )

    def test_partial_rollout_with_workspace_columns_but_no_origin_is_recovered(self) -> None:
        with db.get_connection() as conn:
            conn.execute(
                "ALTER TABLE project_task ADD COLUMN workspace_scope TEXT NOT NULL DEFAULT 'unknown'"
            )
            conn.execute("ALTER TABLE project_task ADD COLUMN workspace_id TEXT")
            conn.execute("ALTER TABLE project_task ADD COLUMN workspace_name TEXT")
            # 실제 중간 배포에서 생길 수 있던 불완전한 값: team 표시는 있으나 UUID가 없다.
            # Python에서는 unknown으로 정규화됐지만 예전 SQL 이관 조건에서는 빠졌다.
            conn.execute(
                "UPDATE project_task SET workspace_scope='team', workspace_id=NULL "
                "WHERE id='single-folder'"
            )
            manage._ensure_schema(conn)
            row = conn.execute(
                "SELECT workspace_scope,workspace_id,workspace_origin FROM project_task "
                "WHERE id='single-folder'"
            ).fetchone()
        self.assertEqual(
            (row["workspace_scope"], row["workspace_id"], row["workspace_origin"]),
            ("team", "ws-a", "generation"),
        )

    def test_partial_rollout_with_all_columns_but_no_marker_is_recovered(self) -> None:
        """컬럼 추가 직후 중단돼 snapshot/unknown 기본값만 남은 DB도 다시 이관한다."""
        with db.get_connection() as conn:
            conn.execute(
                "ALTER TABLE project_task ADD COLUMN workspace_scope "
                "TEXT NOT NULL DEFAULT 'unknown'"
            )
            conn.execute("ALTER TABLE project_task ADD COLUMN workspace_id TEXT")
            conn.execute("ALTER TABLE project_task ADD COLUMN workspace_name TEXT")
            conn.execute(
                "ALTER TABLE project_task ADD COLUMN workspace_origin "
                "TEXT NOT NULL DEFAULT 'snapshot'"
            )
            manage._ensure_schema(conn)
            row = conn.execute(
                "SELECT workspace_scope,workspace_id,workspace_origin FROM project_task "
                "WHERE id='single-folder'"
            ).fetchone()
        self.assertEqual(
            (row["workspace_scope"], row["workspace_id"], row["workspace_origin"]),
            ("team", "ws-a", "generation"),
        )

    def test_workspace_schema_and_marker_roll_back_together_on_interruption(self) -> None:
        """DDL 뒤 이관 실패가 나도 다음 부팅에 보이는 반쪽 스키마를 남기지 않는다."""
        with mock.patch.object(
            manage_schema,
            "_migrate_task_workspace_snapshots",
            side_effect=RuntimeError("강제 중단"),
        ):
            with self.assertRaisesRegex(RuntimeError, "강제 중단"):
                with db.get_connection() as conn:
                    manage._ensure_schema(conn)

        db.flush_pool()
        with sqlite3.connect(os.environ["CONTENT_HUB_DB"]) as raw:
            columns = {row[1] for row in raw.execute("PRAGMA table_info(project_task)")}
            marker = raw.execute(
                "SELECT value FROM manage_schema_state WHERE key=?",
                (manage_schema._TASK_WORKSPACE_MIGRATION_KEY,),
            ).fetchone()
        self.assertNotIn("workspace_scope", columns)
        self.assertNotIn("workspace_origin", columns)
        self.assertIsNone(marker)

        # 강제 중단 원인이 사라진 다음 실행은 처음부터 다시 이관해 완료된다.
        with db.get_connection() as conn:
            manage._ensure_schema(conn)
            recovered = conn.execute(
                "SELECT workspace_scope,workspace_id FROM project_task "
                "WHERE id='single-folder'"
            ).fetchone()
        self.assertEqual((recovered["workspace_scope"], recovered["workspace_id"]), ("team", "ws-a"))

    def test_invalid_team_without_id_remains_visible_as_unresolved_after_marker(self) -> None:
        with db.get_connection() as conn:
            manage._ensure_schema(conn)
            conn.execute(
                "INSERT INTO project_task(id,project_id,name,source_kind,workspace_scope,"
                "workspace_id,workspace_origin) VALUES("
                "'late-invalid','p1','확인 필요','manual','team',NULL,'snapshot')"
            )

        tasks = manage.list_tasks("p1", include_archived=True, workspace_id="ws-b")
        task = next(item for item in tasks if item["id"] == "late-invalid")
        self.assertEqual((task["workspace_scope"], task["workspace_id"]), ("unknown", None))
        self.assertTrue(task["workspace_unresolved"])
        self.assertFalse(task["workspace_historical"])

    def test_completed_migration_does_not_rescan_generations_after_restart(self) -> None:
        with db.get_connection() as conn:
            manage._ensure_schema(conn)
            marker = conn.execute(
                "SELECT value FROM manage_schema_state WHERE key='task_workspace_snapshot_v1'"
            ).fetchone()
        self.assertEqual(marker["value"], "complete")

        db.flush_pool()  # 프로세스 재시작과 같은 새 스키마 보장 주기
        with mock.patch.object(
            manage_schema,
            "_migrate_task_workspace_snapshots",
            side_effect=AssertionError("완료된 이관을 다시 실행하면 안 됨"),
        ):
            with db.get_connection() as conn:
                manage._ensure_schema(conn)


if __name__ == "__main__":
    unittest.main()

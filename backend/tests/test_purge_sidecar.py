"""B4: 영구 purge 시 manage 사이드카(generation_metrics/task_generation/final_export) 고아 정리 검증.

- 휴지통 '이동'(delete_generation) 땐 사이드카를 보존한다(복원 가능해야 하므로).
- '영구 purge'(purge_trashed_item) 후에만 사이드카 고아를 제거한다.
- telemetry_outbox 삭제 tombstone 은 purge 후에도 보존한다(아직 서버에 push 안 됐을 수 있어
  드레이너가 소유 — purge 는 '삭제 통보'를 취소하는 게 아니다).
"""

import os
import tempfile
import unittest

from app import db, repo
from app.repo import manage as _m


class PurgeSidecarTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.old_db = os.environ.get("CONTENT_HUB_DB")
        os.environ["CONTENT_HUB_DB"] = os.path.join(self.tmp.name, "content_hub.db")
        db.flush_pool()
        db.init_db()
        repo.ensure_default_worker()
        with db.get_connection() as conn:
            conn.execute(
                "INSERT INTO worker(id, name, account_type) VALUES('u_me','Me','team') "
                "ON CONFLICT(id) DO NOTHING"
            )
            conn.execute("INSERT INTO project(id, name, kind, archived) VALUES('p1','P1','team',0)")
            conn.execute(
                "INSERT INTO generation(id, worker_id, prompt, status, created_at, sort_ts, "
                "creator_uid, project_id, job_id) "
                "VALUES('g1','me','p','done','2026-06-30',1,'u_me','p1','job-1')"
            )
            conn.execute(
                "INSERT INTO asset(id, generation_id, type, file_path) "
                "VALUES('a1','g1','image','/media/x.png')"
            )
            # 사이드카(manage) 행 — 스키마 보장 후 직접 심는다.
            _m._ensure_schema(conn)
            conn.execute(
                "INSERT INTO generation_metrics(gen_id, job_id, est_credits) VALUES('g1','job-1',10)"
            )
            conn.execute("INSERT INTO task_generation(task_id, gen_id) VALUES('tk1','g1')")
            conn.execute("INSERT INTO final_export(gen_id, dest_path) VALUES('g1','/out/g1.png')")

    def tearDown(self):
        db.flush_pool()
        if self.old_db is None:
            os.environ.pop("CONTENT_HUB_DB", None)
        else:
            os.environ["CONTENT_HUB_DB"] = self.old_db
        db.flush_pool()
        self.tmp.cleanup()

    def _count(self, table, col="gen_id"):
        with db.get_connection() as conn:
            return conn.execute(
                f"SELECT COUNT(*) FROM {table} WHERE {col}=?", ("g1",)
            ).fetchone()[0]

    def test_trash_keeps_sidecar_and_purge_removes_but_keeps_tombstone(self):
        # 1) 휴지통 이동 → 사이드카 보존(복원용), 삭제 tombstone 기록
        repo.delete_generation("g1")
        self.assertEqual(self._count("generation_metrics"), 1, "휴지통 이동 땐 metrics 보존")
        self.assertEqual(self._count("task_generation"), 1)
        self.assertEqual(self._count("final_export"), 1)
        self.assertEqual(
            self._count("telemetry_outbox", "local_gen_id"), 1, "삭제 tombstone 기록됨"
        )

        # 2) 영구 purge → 사이드카 고아 제거, tombstone 은 보존
        self.assertTrue(repo.purge_trashed_item("g1"))
        self.assertEqual(self._count("generation_metrics"), 0, "purge 후 metrics 고아 제거")
        self.assertEqual(self._count("task_generation"), 0, "purge 후 task_generation 제거")
        self.assertEqual(self._count("final_export"), 0, "purge 후 final_export 제거")
        self.assertEqual(
            self._count("telemetry_outbox", "local_gen_id"),
            1,
            "tombstone 은 purge 후에도 보존(미전송 삭제통보)",
        )


if __name__ == "__main__":
    unittest.main()

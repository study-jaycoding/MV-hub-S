"""로컬 sync 상태 관측성(⑤) — telemetry outbox pending/failed 노출. 조용히 묻히던 push 실패 가시화.

동작은 안 바꾸고 '기록만' 읽는 순수 additive. /api/sync-status 는 로컬 허브 자기 상태(프록시 금지).
"""

import os
import tempfile
import unittest


class SyncStatusTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(ignore_cleanup_errors=True)
        self.old_db = os.environ.get("CONTENT_HUB_DB")
        self.old_np = os.environ.get("CONTENT_HUB_NO_PROXY")
        os.environ["CONTENT_HUB_DB"] = os.path.join(self.tmp.name, "content_hub.db")
        os.environ["CONTENT_HUB_NO_PROXY"] = "1"
        from app import db, repo

        db.flush_pool()
        db.init_db()
        repo.ensure_default_worker()
        from fastapi.testclient import TestClient
        from app.main import app

        self.client = TestClient(app, client=("127.0.0.1", 50000))

    def tearDown(self):
        from app import db

        self.client.close()
        db.flush_pool()
        for k, v in (("CONTENT_HUB_DB", self.old_db), ("CONTENT_HUB_NO_PROXY", self.old_np)):
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v
        db.flush_pool()
        self.tmp.cleanup()

    def _seed_outbox(self):
        from app import db
        from app.repo import manage

        with db.get_connection() as conn:
            manage._ensure_schema(conn)  # 동적 telemetry_outbox 테이블
            # 대기(오류無) 1건 + 대기+실패 1건.
            conn.execute(
                "INSERT INTO telemetry_outbox(local_gen_id, dirty_at, pushed_at, last_error) "
                "VALUES('g1','2026-01-01', NULL, NULL)"
            )
            conn.execute(
                "INSERT INTO telemetry_outbox(local_gen_id, dirty_at, pushed_at, last_error) "
                "VALUES('g2','2026-01-02', NULL, 'boom')"
            )

    def test_status_empty(self):
        r = self.client.get("/api/sync-status")
        self.assertEqual(r.status_code, 200)
        d = r.json()
        self.assertEqual(d["pending"], 0)
        self.assertEqual(d["failed"], 0)
        self.assertIsNone(d["last_error"])

    def test_readonly_does_not_create_table(self):
        # ★관측 API 는 스키마 부작용이 없어야 — telemetry_outbox 없는 프레시 DB 에서 호출해도 테이블 안 생김.
        from app import db

        self.assertEqual(self.client.get("/api/sync-status").json()["pending"], 0)
        with db.get_connection() as conn:
            exists = conn.execute(
                "SELECT 1 FROM sqlite_master WHERE type='table' AND name='telemetry_outbox'"
            ).fetchone()
        self.assertIsNone(exists, "sync-status 가 telemetry_outbox 를 생성하면 안 됨(read-only)")

    def test_status_pending_and_failed(self):
        self._seed_outbox()
        d = self.client.get("/api/sync-status").json()
        self.assertEqual(d["pending"], 2)  # g1 + g2 (둘 다 pushed_at NULL)
        self.assertEqual(d["failed"], 1)  # g2 (last_error 있음)
        self.assertEqual(d["last_error"], "boom")
        self.assertEqual(d["oldest_dirty"], "2026-01-01")

    def test_pushed_row_not_pending(self):
        from app import db
        from app.repo import manage

        with db.get_connection() as conn:
            manage._ensure_schema(conn)
            conn.execute(
                "INSERT INTO telemetry_outbox(local_gen_id, dirty_at, pushed_at, last_error) "
                "VALUES('done1','2026-01-01','2026-01-01T00:00:01Z', NULL)"
            )
        d = self.client.get("/api/sync-status").json()
        self.assertEqual(d["pending"], 0)  # pushed_at 있으면 대기 아님


if __name__ == "__main__":
    unittest.main()

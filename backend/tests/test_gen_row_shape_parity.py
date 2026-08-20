"""목록/단건 생성물 행 모양 동등성 — GEN_BASE_JOINS 상수화의 안전망.

목록(list_generations)과 단건(get_generation)은 같은 조인·컬럼 계약을 공유해야 한다.
예전엔 FROM/JOIN 문자열이 두 파일에 복붙돼 있어 한쪽만 바꾸면 목록과 팝업의 필드가
조용히 어긋날 수 있었다. 필드 키 집합이 갈라지면 여기서 잡힌다.
"""

import os
import tempfile
import unittest

from app import db, repo


class GenRowShapeParityTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(ignore_cleanup_errors=True)
        self.old_db = os.environ.get("CONTENT_HUB_DB")
        os.environ["CONTENT_HUB_DB"] = os.path.join(self.tmp.name, "content_hub.db")
        db.flush_pool()
        db.init_db()
        repo.ensure_default_worker()
        with db.get_connection() as conn:
            conn.execute(
                "INSERT INTO generation(id, worker_id, prompt, status, created_at, sort_ts, "
                "creator_uid, job_id) VALUES('g1','me','p','done','2026-08-15',1,'u_me','job-1')"
            )
            conn.execute(
                "INSERT INTO asset(id, generation_id, type, file_path) "
                "VALUES('a1','g1','image','/media/a.png')"
            )

    def tearDown(self):
        db.flush_pool()
        if self.old_db is None:
            os.environ.pop("CONTENT_HUB_DB", None)
        else:
            os.environ["CONTENT_HUB_DB"] = self.old_db
        db.flush_pool()
        self.tmp.cleanup()

    def test_list_and_single_return_same_field_set(self):
        listed = repo.list_generations(limit=10)
        self.assertEqual(len(listed), 1)
        single = repo.get_generation("g1")
        self.assertIsNotNone(single)
        self.assertEqual(set(listed[0].keys()), set(single.keys()))
        # 조인 계약의 핵심 필드가 양쪽 모두에 있는지 명시 고정.
        for key in ("execution_phase", "provider_status", "local_only", "job_id", "worker_name"):
            self.assertIn(key, listed[0])
            self.assertIn(key, single)


if __name__ == "__main__":
    unittest.main()

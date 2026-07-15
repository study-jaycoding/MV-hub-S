"""generation row enrichment(_attach_children) 특성화 테스트 — 조회 응답 보강 필드를 고정.

generations.py → generation_rows.py 분리 전 안전망. list_generations 가 카드에 붙이는
assets/references/tags/auto_tags/shared/is_mine/params 등 핵심 필드가 안 바뀌게 잡는다.
"""

import os
import tempfile
import unittest

from app import db, repo


class GenerationRowsTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.old_db = os.environ.get("CONTENT_HUB_DB")
        os.environ["CONTENT_HUB_DB"] = os.path.join(self.tmp.name, "content_hub.db")
        db.flush_pool()
        db.init_db()
        repo.ensure_default_worker()
        self._seed()

    def tearDown(self):
        db.flush_pool()
        if self.old_db is None:
            os.environ.pop("CONTENT_HUB_DB", None)
        else:
            os.environ["CONTENT_HUB_DB"] = self.old_db
        db.flush_pool()
        self.tmp.cleanup()

    def _seed(self):
        with db.get_connection() as conn:
            conn.execute(
                "INSERT INTO worker(id, name, account_type) VALUES('u_me','Me','team') "
                "ON CONFLICT(id) DO NOTHING"
            )
            conn.execute("INSERT INTO project(id, name, kind, archived) VALUES('p1','P1','team',0)")
            conn.execute(
                "INSERT INTO project_member(project_id, creator_uid, project_role) VALUES('p1','u_me','creator')"
            )
            conn.execute(
                "INSERT INTO generation(id, worker_id, prompt, status, created_at, sort_ts, "
                "creator_uid, project_id, color, params) "
                "VALUES('g1','me','p','done','2026-06-30',1,'u_me','p1','#red','{\"a\": 1}')"
            )
            conn.execute(
                "INSERT INTO asset(id, generation_id, type, file_path) "
                "VALUES('a1','g1','image','/media/x.png')"
            )
            conn.execute(
                "INSERT INTO reference(id, type, file_path) VALUES('r1','image','/media/ref.png')"
            )
            conn.execute(
                "INSERT INTO gen_reference(generation_id, reference_id, role) VALUES('g1','r1','@Image1')"
            )
            conn.execute("INSERT INTO tag(id, name) VALUES('t1','cat')")
            conn.execute("INSERT INTO gen_tag(generation_id, tag_id) VALUES('g1','t1')")
            conn.execute("INSERT INTO auto_tag(id, name, owner_uid) VALUES('at1','mytag','u_me')")
            conn.execute("INSERT INTO gen_auto_tag(generation_id, auto_tag_id) VALUES('g1','at1')")
            conn.execute(
                "INSERT INTO share(id, generation_id, shared_by, visibility) VALUES('s1','g1','u_me','team')"
            )

    def test_row_enrichment_fields(self):
        rows = repo.list_generations(tab="my", account_uid="u_me", limit=50)
        by = {r["id"]: r for r in rows}
        self.assertIn("g1", by)
        g = by["g1"]
        # params JSON → dict
        self.assertEqual(g["params"], {"a": 1})
        # assets: /media/ 는 cached=True
        self.assertEqual(len(g["assets"]), 1)
        self.assertEqual(g["assets"][0]["type"], "image")
        self.assertTrue(g["assets"][0]["cached"])
        # references: 역할·cached
        self.assertEqual(len(g["references"]), 1)
        self.assertEqual(g["references"][0]["role"], "@Image1")
        self.assertTrue(g["references"][0]["cached"])
        # tags / auto_tags(별도 네임스페이스)
        self.assertEqual(g["tags"], ["cat"])
        self.assertEqual(g["auto_tags"], ["mytag"])
        # 공유·내 것
        self.assertTrue(g["shared"])
        self.assertTrue(g["is_mine"])
        # 기본 계보 요약(부모/자식/소스 없음)
        self.assertIsNone(g["parent_gen_id"])
        self.assertEqual(g["child_count"], 0)
        self.assertEqual(g["source_count"], 0)


if __name__ == "__main__":
    unittest.main()

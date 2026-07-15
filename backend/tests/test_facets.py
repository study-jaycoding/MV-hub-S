"""get_facets 특성화 테스트 — 필터 사이드바 facet(컬러/태그/자동태그/워커) 동작 고정.

generations.py → facets.py 분해 전 안전망.
"""

import os
import tempfile
import unittest

from app import db, repo


class GetFacetsTests(unittest.TestCase):
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
            for uid, name in (("u_me", "Me"), ("u_other", "Other")):
                conn.execute(
                    "INSERT INTO worker(id, name, account_type) VALUES(?,?,'team') "
                    "ON CONFLICT(id) DO NOTHING",
                    (uid, name),
                )

            def gen(gid, creator, color):
                conn.execute(
                    "INSERT INTO generation(id, worker_id, prompt, status, created_at, sort_ts, "
                    "creator_uid, color) VALUES(?, 'me', 'p', 'done', '2026-06-30', 1, ?, ?)",
                    (gid, creator, color),
                )

            gen("g_me", "u_me", "#red")
            gen("g_other", "u_other", "#blue")
            conn.execute("INSERT INTO tag(id, name) VALUES('t_cat','cat')")
            conn.execute("INSERT INTO tag(id, name) VALUES('t_dog','dog')")
            conn.execute("INSERT INTO gen_tag(generation_id, tag_id) VALUES('g_me','t_cat')")
            conn.execute("INSERT INTO gen_tag(generation_id, tag_id) VALUES('g_other','t_dog')")
            conn.execute("INSERT INTO auto_tag(id, name, owner_uid) VALUES('at_me','mytag','u_me')")
            conn.execute("INSERT INTO auto_tag(id, name, owner_uid) VALUES('at_other','othertag','u_other')")

    def test_colors_and_tags_scoped_to_my_generations(self):
        # account_uid 를 주면 '내가 만든 생성물에 쓰인' 컬러/태그만 — 남의 것이 사이드바로 새지 않는다.
        f = repo.get_facets("u_me")
        self.assertEqual(f["colors"], ["#red"])
        self.assertEqual(f["tags"], ["cat"])

    def test_auto_tags_are_owner_scoped_regardless_of_use(self):
        # 자동태그는 '사용 여부와 무관'하게 그 계정이 소유한 것 전부(방금 만든 것도 보이게). 남의 것은 제외.
        f = repo.get_facets("u_me")
        self.assertEqual(f["auto_tags"], ["mytag"])

    def test_workers_list_all(self):
        f = repo.get_facets("u_me")
        ids = {w["id"] for w in f["workers"]}
        self.assertIn("u_me", ids)
        self.assertIn("u_other", ids)


if __name__ == "__main__":
    unittest.main()

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
        # 공유·내 것 (+ shared_at — 팀 탭 '새로 들어옴' 판정 축, share.shared_at 기본값이 채워진다)
        self.assertTrue(g["shared"])
        self.assertTrue(bool(g["shared_at"]))
        self.assertTrue(g["is_mine"])
        # 기본 계보 요약(부모/자식/소스 없음)
        self.assertIsNone(g["parent_gen_id"])
        self.assertEqual(g["child_count"], 0)
        self.assertEqual(g["source_count"], 0)

    def test_generation_out_exposes_shared_at(self):
        # 응답 모델이 이 필드를 모르면 FastAPI 직렬화가 repo 가 붙인 값을 잘라내 글로우가 전부 꺼진다
        # (코덱스 P1 재발 방지 — repo dict 검사만으론 API 경계를 못 잡는다).
        from app.models import GenerationOut

        self.assertIn("shared_at", GenerationOut.model_fields)

    def test_team_fresh_items(self):
        # 기준선 이후 공유만 반환 + 미분류(project_id NULL)도 포함 — 사이드바 +N 배지의 원천.
        with db.get_connection() as conn:
            conn.execute("UPDATE generation SET folder_path='ep001/c0010' WHERE id='g1'")
            conn.execute(
                "INSERT INTO generation(id, worker_id, prompt, status, created_at, sort_ts, "
                "creator_uid, project_id, folder_path) "
                "VALUES('g2','me','p2','done','2026-07-01',2,'u_me','p1','ep001/c0015')"
            )
            conn.execute(
                "INSERT INTO generation(id, worker_id, prompt, status, created_at, sort_ts, "
                "creator_uid) VALUES('g3','me','p3','done','2026-07-02',3,'u_me')"  # 미분류
            )
            conn.execute(
                "UPDATE share SET shared_at='2026-08-01 00:00:00' WHERE generation_id='g1'"
            )
            conn.execute(
                "INSERT INTO share(id, generation_id, shared_by, visibility, shared_at) "
                "VALUES('s2','g2','u_me','team','2026-08-03 00:00:00')"
            )
            conn.execute(
                "INSERT INTO share(id, generation_id, shared_by, visibility, shared_at) "
                "VALUES('s3','g3','u_me','team','2026-08-03 12:00:00')"
            )
        items = repo.team_fresh_items("2026-08-02 00:00:00")
        by_id = {i["id"]: i for i in items}
        self.assertEqual(set(by_id), {"g2", "g3"})  # 기준선 이전(g1)은 제외
        self.assertEqual(by_id["g2"]["folder_path"], "ep001/c0015")
        self.assertIsNone(by_id["g3"]["project_id"])  # 미분류 포함
        self.assertEqual(repo.team_fresh_items("2026-08-04 00:00:00"), [])


if __name__ == "__main__":
    unittest.main()

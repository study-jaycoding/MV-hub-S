"""search_sources 특성화 테스트 — @/# 소스 피커의 가시성·검색·limit 동작을 고정한다.

generations.py 분해 시 이 응답 형태가 안 바뀌도록 하는 안전망이자,
'기본 limit 60→1000(피커 누락 방지)' 변경의 회귀 방지 테스트.
"""

import inspect
import os
import tempfile
import unittest

from app import db, repo


class SearchSourcesTests(unittest.TestCase):
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
            conn.execute("INSERT INTO project(id, name, kind, archived) VALUES('p_mem','Member','team',0)")
            conn.execute("INSERT INTO project(id, name, kind, archived) VALUES('p_non','NonMember','team',0)")
            conn.execute(
                "INSERT INTO project_member(project_id, creator_uid, project_role) VALUES('p_mem','u_me','creator')"
            )

            def src(gid, creator, project, sname, prompt="prompt"):
                conn.execute(
                    "INSERT INTO generation(id, worker_id, prompt, status, created_at, sort_ts, "
                    "creator_uid, project_id, is_source, source_name) "
                    "VALUES(?, 'me', ?, 'done', '2026-06-30', 1, ?, ?, 1, ?)",
                    (gid, prompt, creator, project, sname),
                )

            def share(gid, by):
                conn.execute(
                    "INSERT INTO share(id, generation_id, shared_by, visibility) VALUES(?,?,?,'team')",
                    ("s_" + gid, gid, by),
                )

            src("own", "u_me", None, "MyCat")  # 내 것
            src("mem", "u_other", "p_mem", "MemberCat")  # 내가 멤버인 프로젝트의 남 소스(공유)
            share("mem", "u_other")
            src("non", "u_other", "p_non", "NonMemberCat")  # 비멤버 프로젝트의 남 소스(공유) → 새면 안 됨
            share("non", "u_other")
            conn.execute("INSERT INTO tag(id, name) VALUES('t_red','red')")
            conn.execute("INSERT INTO gen_tag(generation_id, tag_id) VALUES('own','t_red')")

    @staticmethod
    def _ids(rows):
        return {r["id"] for r in rows}

    def test_visibility_excludes_nonmember_project_sources(self):
        # 내 것 + 내가 멤버인 프로젝트의 공유 소스만 — 비멤버 프로젝트 소스는 @ 피커로 새지 않아야 한다.
        rows = repo.search_sources(owner_uid="u_me", member_projects=["p_mem"])
        self.assertEqual(self._ids(rows), {"own", "mem"})

    def test_read_all_sees_all_sources(self):
        rows = repo.search_sources(owner_uid="u_me", read_all=True)
        self.assertEqual(self._ids(rows), {"own", "mem", "non"})

    def test_query_matches_source_name(self):
        # owner_uid 없음(AUTH off/단독) → 가시성 필터 없이 query 만. MemberCat/NonMemberCat 매칭.
        rows = repo.search_sources(query="Member")
        self.assertEqual(self._ids(rows), {"mem", "non"})

    def test_tag_filter(self):
        rows = repo.search_sources(tag="red")
        self.assertEqual(self._ids(rows), {"own"})

    def test_limit_caps_results(self):
        rows = repo.search_sources(limit=1)
        self.assertEqual(len(rows), 1)

    def test_default_limit_is_generous(self):
        # 피커 누락 회귀 방지 — 소스를 전량 로드하므로 기본 limit 이 넉넉해야 한다(과거 60 이었음).
        default = inspect.signature(repo.search_sources).parameters["limit"].default
        self.assertGreaterEqual(default, 1000)


if __name__ == "__main__":
    unittest.main()

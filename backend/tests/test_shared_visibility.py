import os
import tempfile
import unittest

from app import db, repo


class SharedVisibilityTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.old_db = os.environ.get("CONTENT_HUB_DB")
        os.environ["CONTENT_HUB_DB"] = os.path.join(self.tmp.name, "content_hub.db")
        db.flush_pool()
        db.init_db()
        repo.ensure_default_worker()
        self._seed_visibility_rows()

    def tearDown(self):
        db.flush_pool()
        if self.old_db is None:
            os.environ.pop("CONTENT_HUB_DB", None)
        else:
            os.environ["CONTENT_HUB_DB"] = self.old_db
        db.flush_pool()
        self.tmp.cleanup()

    def _seed_visibility_rows(self):
        with db.get_connection() as conn:
            for uid, name in (
                ("user_river", "River"),
                ("user_other", "Other"),
                ("acct:river@example.com", "River Legacy"),
            ):
                conn.execute(
                    "INSERT INTO worker(id, name, account_type) VALUES(?,?,?) "
                    "ON CONFLICT(id) DO NOTHING",
                    (uid, name, "team"),
                )
            conn.execute(
                "INSERT INTO project(id, name, kind, archived) VALUES('p_member','Member Project','team',0)"
            )
            conn.execute(
                "INSERT INTO project(id, name, kind, archived) VALUES('p_other','Other Project','team',0)"
            )
            conn.execute(
                "INSERT INTO project_member(project_id, creator_uid, project_role) VALUES(?,?,?)",
                ("p_member", "user_river", "creator"),
            )

            def gen(gen_id, creator_uid, project_id, sort_ts):
                conn.execute(
                    "INSERT INTO generation(id, worker_id, prompt, status, created_at, sort_ts, creator_uid, project_id) "
                    "VALUES(?, 'me', ?, 'done', '2026-06-30', ?, ?, ?)",
                    (gen_id, gen_id, sort_ts, creator_uid, project_id),
                )

            def share(gen_id, shared_by):
                conn.execute(
                    "INSERT INTO share(id, generation_id, shared_by, visibility) VALUES(?,?,?,'team')",
                    ("s_" + gen_id, gen_id, shared_by),
                )

            gen("own_unassigned", "user_river", None, 5)
            share("own_unassigned", "user_river")
            gen("own_nonmember_project", "user_river", "p_other", 4)
            share("own_nonmember_project", "user_river")
            gen("other_member_project", "user_other", "p_member", 3)
            share("other_member_project", "user_other")
            gen("other_unassigned", "user_other", None, 2)
            share("other_unassigned", "user_other")
            gen("other_nonmember_project", "user_other", "p_other", 1)
            share("other_nonmember_project", "user_other")

    def test_team_tab_includes_own_shared_items_outside_member_projects(self):
        rows = repo.list_generations(
            tab="team",
            team_member_projects=["p_member"],
            account_uid="user_river",
            limit=50,
        )
        ids = {r["id"] for r in rows}

        self.assertIn("own_unassigned", ids)
        self.assertIn("own_nonmember_project", ids)
        self.assertIn("other_member_project", ids)
        self.assertNotIn("other_unassigned", ids)
        self.assertNotIn("other_nonmember_project", ids)

    def test_share_dir_uses_account_creator_uid(self):
        mine = repo.list_generations(
            tab="team",
            team_member_projects=["p_member"],
            account_uid="user_river",
            share_dir="mine",
            limit=50,
        )
        received = repo.list_generations(
            tab="team",
            team_member_projects=["p_member"],
            account_uid="user_river",
            share_dir="received",
            limit=50,
        )

        self.assertEqual({r["id"] for r in mine}, {"own_unassigned", "own_nonmember_project"})
        self.assertEqual({r["id"] for r in received}, {"other_member_project"})

    def test_team_project_counts_match_visible_shared_items(self):
        data = repo.list_projects(
            member_uid="user_river",
            viewer_uid=None,
            shared_only=True,
            own_shared_uid="user_river",
        )
        counts = {p["id"]: p["count"] for p in data["projects"]}

        self.assertEqual(data["unassigned"], 1)
        self.assertEqual(counts["p_member"], 1)
        self.assertEqual(counts["p_other"], 1)

    def test_team_creator_counts_match_visible_shared_items(self):
        rows = repo.list_generations(
            tab="team",
            team_member_projects=["p_member"],
            account_uid="user_river",
            limit=50,
        )
        creators = repo.list_creators(
            account_uid="user_river",
            tab="team",
            team_member_projects=["p_member"],
        )
        counts = {c["uid"]: c["count"] for c in creators}

        expected: dict[str, int] = {}
        for row in rows:
            uid = row["creator_uid"]
            expected[uid] = expected.get(uid, 0) + 1

        self.assertEqual(counts, expected)
        self.assertEqual(counts["user_river"], 2)
        self.assertEqual(counts["user_other"], 1)

    def test_project_creator_counts_respect_visible_team_scope(self):
        creators = repo.list_creators(
            account_uid="user_river",
            tab="team",
            project_id="p_other",
            team_member_projects=["p_member"],
        )

        self.assertEqual({c["uid"]: c["count"] for c in creators}, {"user_river": 1})

    def test_legacy_acct_share_rows_link_account_to_real_creator_uid(self):
        with db.get_connection() as conn:
            conn.execute(
                "INSERT INTO account(email, name, password_hash, status, global_role, creator_uid) "
                "VALUES('river@example.com','River','x','approved','member','acct:river@example.com')"
            )
            conn.execute(
                "INSERT INTO generation(id, worker_id, prompt, status, created_at, sort_ts, creator_uid) "
                "VALUES('legacy_shared', 'me', 'legacy', 'done', '2026-06-30', 9, 'user_river')"
            )
            conn.execute(
                "INSERT INTO share(id, generation_id, shared_by, visibility) "
                "VALUES('s_legacy_shared', 'legacy_shared', 'acct:river@example.com', 'team')"
            )

        repo.link_accounts_to_creators()

        with db.get_connection() as conn:
            acc = conn.execute(
                "SELECT creator_uid FROM account WHERE email='river@example.com'"
            ).fetchone()
            worker = conn.execute("SELECT 1 FROM worker WHERE id='user_river'").fetchone()
            share = conn.execute(
                "SELECT shared_by FROM share WHERE generation_id='legacy_shared'"
            ).fetchone()

        self.assertEqual(acc["creator_uid"], "user_river")
        self.assertIsNotNone(worker)
        self.assertEqual(share["shared_by"], "user_river")


if __name__ == "__main__":
    unittest.main()

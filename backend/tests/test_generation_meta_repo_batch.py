"""생성물 개인 메타 저장소 배치의 ID 해석·마지막 값·원자성 계약."""

from __future__ import annotations

import os
import sqlite3
import tempfile
import unittest


class GenerationMetaRepoBatchTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory(ignore_cleanup_errors=True)
        self.old_db = os.environ.get("CONTENT_HUB_DB")
        os.environ["CONTENT_HUB_DB"] = os.path.join(self.tmp.name, "content_hub.db")

        from app import db, repo

        db.flush_pool()
        db.init_db()
        repo.ensure_default_worker()
        with db.get_connection() as conn:
            conn.executemany(
                "INSERT INTO generation(id, job_id, worker_id, creator_uid, prompt, model, status, "
                "created_at, sort_ts, origin) VALUES(?,?,'me',?,'p','m','done','2026-01-01',?,'local')",
                [
                    ("loc1", "job1", "me", 2),
                    ("loc2", "job2", "me", 1),
                ],
            )
        repo.set_tags("loc1", ["old"])
        repo.create_auto_tag("hero", "me")

    def tearDown(self) -> None:
        from app import db

        db.flush_pool()
        if self.old_db is None:
            os.environ.pop("CONTENT_HUB_DB", None)
        else:
            os.environ["CONTENT_HUB_DB"] = self.old_db
        db.flush_pool()
        self.tmp.cleanup()

    def test_batch_resolver_handles_local_job_and_500_input_limit(self) -> None:
        from app import repo

        requested = ["loc1", "job2", *[f"missing-{index}" for index in range(498)]]
        resolved = repo.resolve_generation_meta_batch(requested)

        self.assertEqual(resolved["loc1"]["id"], "loc1")
        self.assertEqual(resolved["job2"]["id"], "loc2")
        self.assertEqual(set(resolved), {"loc1", "job2"})

    def test_color_and_tag_batches_use_last_value_for_duplicate_id(self) -> None:
        from app import repo

        repo.set_generation_colors_batch(
            [("loc1", "red"), ("loc2", "green"), ("loc1", "blue")]
        )
        repo.set_generation_tags_batch(
            [("loc1", ["first"]), ("loc2", ["side"]), ("loc1", ["last", "last"])]
        )

        self.assertEqual(repo.get_generation("loc1")["color"], "blue")
        self.assertEqual(repo.get_generation("loc2")["color"], "green")
        self.assertEqual(repo.get_generation("loc1")["tags"], ["last"])
        self.assertEqual(repo.get_generation("loc2")["tags"], ["side"])

    def test_tags_come_back_in_name_order_not_storage_order(self) -> None:
        # 81회차 P2b 1-a — 태그는 집합으로 저장된다. 순서를 정하지 않으면 저장할 때마다 칩 순서가 바뀌었다.
        from app import db, repo

        # 태그 id·저장 순서를 이름순과 거꾸로 고정한다 — 정렬이 없으면 id 순이든 저장 순이든 거꾸로 나와 반드시 실패한다.
        backwards = [("a", "미드"), ("b", "검토"), ("c", "zeta"), ("d", "beta"), ("e", "alpha")]
        with db.get_connection() as conn:
            conn.execute("DELETE FROM gen_tag WHERE generation_id='loc1'")
            conn.executemany("INSERT INTO tag(id, name) VALUES(?,?)", backwards)
            conn.executemany("INSERT INTO gen_tag(generation_id, tag_id) VALUES('loc1', ?)", [(tid,) for tid, _ in backwards])

        self.assertEqual(repo.get_generation("loc1")["tags"], ["alpha", "beta", "zeta", "검토", "미드"])

    def test_auto_tag_batch_keeps_owner_namespace_and_ignores_unknown(self) -> None:
        from app import repo

        repo.create_auto_tag("other-only", "other")
        repo.set_generation_auto_tags_batch(
            [("loc1", ["hero", "other-only", "unknown"]), ("loc2", ["hero"])]
        )

        self.assertEqual(repo.get_generation("loc1")["auto_tags"], ["hero"])
        self.assertEqual(repo.get_generation("loc2")["auto_tags"], ["hero"])

    def test_tag_batch_rolls_back_all_rows_on_middle_failure(self) -> None:
        from app import repo

        with self.assertRaises(sqlite3.IntegrityError):
            repo.set_generation_tags_batch(
                [("loc1", ["changed"]), ("missing", ["changed"])]
            )

        self.assertEqual(repo.get_generation("loc1")["tags"], ["old"])

    def test_shadow_batches_keep_last_value_and_clear(self) -> None:
        from app import repo

        repo.set_color_overlays_batch(
            [("jobOther", "red"), ("jobOther", "blue"), ("jobClear", "green")]
        )
        repo.set_color_overlays_batch([("jobClear", None)])
        repo.set_tag_overlays_batch(
            [
                ("jobOther", ["first"]),
                ("jobOther", ["last", "last"]),
                ("jobClear", ["gone"]),
            ]
        )
        repo.set_tag_overlays_batch([("jobClear", [])])

        self.assertEqual(repo.color_overlay_by_anchors(["jobOther", "jobClear"]), {"jobOther": "blue"})
        self.assertEqual(repo.tags_overlay_by_anchors(["jobOther", "jobClear"]), {"jobOther": ["last"]})


if __name__ == "__main__":
    unittest.main()

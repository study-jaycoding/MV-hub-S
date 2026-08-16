"""B6: list_tasks 의 작업당 1쿼리(N+1)를 레인별 배치로 대체한 _batch_task_gen_rows 가
기존 _task_gen_rows 와 '작업별로 완전히 동일한' 결과(행·순서·필드)를 내는지 특성화 검증.

3레인(수동 링크 ∪ 폴더 ∪ 시퀀스) + 다중 작업 귀속 + linked 플래그 + 정렬(final/shared/sort_ts)을
모두 심어, 각 작업에 대해 배치 == 오라클(기존 함수) 이면 동작 보존이 증명된다.
"""

import os
import tempfile
import unittest
from unittest.mock import patch

from app import db, repo
from app.repo import manage as _m
from app.repo import manage_tasks as _mt


class TaskGenBatchParityTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.old_db = os.environ.get("CONTENT_HUB_DB")
        os.environ["CONTENT_HUB_DB"] = os.path.join(self.tmp.name, "content_hub.db")
        db.flush_pool()
        db.init_db()
        repo.ensure_default_worker()
        with db.get_connection() as conn:
            _m._ensure_schema(conn)
            conn.execute(
                "INSERT INTO worker(id, name, account_type) VALUES('u_me','Me','team') "
                "ON CONFLICT(id) DO NOTHING"
            )
            conn.execute("INSERT INTO project(id, name, kind, archived) VALUES('p1','P1','team',0)")
            # 이 파일은 레인 배치 동등성 테스트다. 수명주기 보관은 별도 테스트에서 검증하므로
            # 오래된 고정 fixture가 현재 날짜에 따라 숨지 않게 충분히 긴 기간을 둔다.
            conn.execute(
                "INSERT INTO project_planning(project_id, archive_after_days) VALUES('p1', 3650)"
            )

            def gen(gid, folder, sort_ts, is_final=0, status="done"):
                conn.execute(
                    "INSERT INTO generation(id, worker_id, prompt, status, created_at, sort_ts, "
                    "creator_uid, project_id, folder_path, is_final, job_id) "
                    "VALUES(?, 'me', 'p', ?, '2026-06-30T00:00:00Z', ?, 'u_me', 'p1', ?, ?, ?)",
                    (gid, status, sort_ts, folder, is_final, "job-" + gid),
                )
                conn.execute(
                    "INSERT INTO asset(id, generation_id, type, file_path) VALUES(?,?, 'image', ?)",
                    ("a_" + gid, gid, "/media/" + gid + ".png"),
                )

            # 폴더 레인(ep001/c0010): g1(일반), g2(최종), g5(다중귀속), g6(공유)
            gen("g1", "ep001/c0010", 100.0)
            gen("g2", "ep001/c0010", 200.0, is_final=1)
            gen("g5", "ep001/c0010", 130.0)
            gen("g6", "ep001/c0010", 110.0)
            # 시퀀스 레인(auto_tag 'c0020'): g3
            gen("g3", None, 150.0)
            # 수동 링크 대상: g4, g5(폴더와 중복 귀속)
            gen("g4", None, 120.0)
            # ★수동 링크됐지만 소프트 삭제된 컷 — 원본은 deleted_at 필터로 제외한다(회귀 방지 케이스).
            gen("g_del", None, 140.0)
            conn.execute("UPDATE generation SET deleted_at='2026-07-01T00:00:00Z' WHERE id='g_del'")

            # 공유(share) — g6 (folder 작업에서 shared DESC 정렬 검증)
            conn.execute(
                "INSERT INTO share(id, generation_id, shared_by, visibility) "
                "VALUES('s1','g6','u_me','team')"
            )
            # 시퀀스 태그 — g3 에 auto_tag 'c0020'
            conn.execute("INSERT INTO auto_tag(id, name, owner_uid) VALUES('at1','c0020','u_me')")
            conn.execute("INSERT INTO gen_auto_tag(generation_id, auto_tag_id) VALUES('g3','at1')")

            # 작업들
            conn.execute(
                "INSERT INTO project_task(id, project_id, name, status, sequence, folder_path) "
                "VALUES('t_folder','p1','ep001','not_started','c0010','ep001/c0010')"
            )
            conn.execute(
                "INSERT INTO project_task(id, project_id, name, status, sequence, folder_path) "
                "VALUES('t_seq','p1','manualseq','not_started','c0020', NULL)"
            )
            conn.execute(
                "INSERT INTO project_task(id, project_id, name, status, sequence, folder_path) "
                "VALUES('t_manual','p1','manual','not_started', NULL, NULL)"
            )
            # 수동 링크: g4→t_manual, g5→t_manual(폴더 레인과 중복), g1→t_folder(linked 플래그 검증)
            conn.execute("INSERT INTO task_generation(task_id, gen_id) VALUES('t_manual','g4')")
            conn.execute("INSERT INTO task_generation(task_id, gen_id) VALUES('t_manual','g5')")
            conn.execute("INSERT INTO task_generation(task_id, gen_id) VALUES('t_folder','g1')")
            # 삭제된 컷도 수동 링크 — 원본/배치 모두 제외되어야 한다.
            conn.execute("INSERT INTO task_generation(task_id, gen_id) VALUES('t_manual','g_del')")

    def tearDown(self):
        db.flush_pool()
        if self.old_db is None:
            os.environ.pop("CONTENT_HUB_DB", None)
        else:
            os.environ["CONTENT_HUB_DB"] = self.old_db
        db.flush_pool()
        self.tmp.cleanup()

    def test_batch_matches_per_task_oracle(self):
        with db.get_connection() as conn:
            rows = conn.execute(
                "SELECT * FROM project_task WHERE project_id='p1' "
                "ORDER BY COALESCE(sort_order, 1000000), created_at"
            ).fetchall()
            batch = _m._batch_task_gen_rows(conn, "p1", rows)
            for r in rows:
                oracle = [
                    dict(c)
                    for c in _m._task_gen_rows(
                        conn, r["id"], "p1", r["sequence"], r["folder_path"]
                    )
                ]
                self.assertEqual(
                    batch[r["id"]],
                    oracle,
                    f"task {r['name']} ({r['id']}): 배치 결과가 오라클과 다름",
                )

        # 스모크: 실제 lane 매칭이 비어있지 않은지(테스트가 무의미하지 않게)
        self.assertTrue(any(batch[r["id"]] for r in rows), "모든 작업이 비어 테스트 무의미")

    def test_folder_task_ordering_and_multi_membership(self):
        with db.get_connection() as conn:
            rows = conn.execute(
                "SELECT * FROM project_task WHERE project_id='p1'"
            ).fetchall()
            batch = _m._batch_task_gen_rows(conn, "p1", rows)
        by = {r["id"]: r for r in rows}
        self.assertIn("t_folder", by)
        # 폴더 작업: g1,g2,g5,g6 귀속. 정렬 = is_final DESC(g2), 그다음 shared DESC(g6), sort_ts DESC.
        folder_ids = [g["id"] for g in batch["t_folder"]]
        self.assertEqual(folder_ids[0], "g2", "최종(is_final)이 맨 앞")
        self.assertIn("g6", folder_ids)
        self.assertEqual(set(folder_ids), {"g1", "g2", "g5", "g6"})
        # g5 는 폴더 레인 + 수동 링크(t_manual) 둘 다 — 다중 귀속. g_del(삭제)은 링크돼도 제외.
        manual_ids = {g["id"] for g in batch["t_manual"]}
        self.assertEqual(manual_ids, {"g4", "g5"})
        self.assertNotIn("g_del", manual_ids, "소프트 삭제된 수동 링크 컷은 제외")
        # linked 플래그: t_folder 의 g1 은 수동 링크됨 → linked=1, 나머지 폴더컷은 0
        g1row = next(g for g in batch["t_folder"] if g["id"] == "g1")
        self.assertEqual(g1row["linked"], 1)
        g2row = next(g for g in batch["t_folder"] if g["id"] == "g2")
        self.assertEqual(g2row["linked"], 0)
        # 시퀀스 작업: g3 만
        self.assertEqual({g["id"] for g in batch["t_seq"]}, {"g3"})

    def test_multi_project_batch_keeps_folder_and_sequence_membership_scoped(self):
        """같은 폴더·시퀀스 이름을 쓰는 다른 프로젝트의 컷이 섞이면 안 된다."""
        with db.get_connection() as conn:
            conn.execute("INSERT INTO project(id, name, kind, archived) VALUES('p2','P2','team',0)")
            conn.execute(
                "INSERT INTO project_planning(project_id, archive_after_days) VALUES('p2', 3650)"
            )
            conn.execute(
                "INSERT INTO generation(id, worker_id, prompt, status, created_at, sort_ts, "
                "creator_uid, project_id, folder_path, is_final, job_id) "
                "VALUES('g_p2_folder', 'me', 'p', 'done', '2026-06-30T00:00:00Z', 300, "
                "'u_me', 'p2', 'ep001/c0010', 0, 'job-g_p2_folder')"
            )
            conn.execute(
                "INSERT INTO generation(id, worker_id, prompt, status, created_at, sort_ts, "
                "creator_uid, project_id, folder_path, is_final, job_id) "
                "VALUES('g_p2_seq', 'me', 'p', 'done', '2026-06-30T00:00:00Z', 310, "
                "'u_me', 'p2', NULL, 0, 'job-g_p2_seq')"
            )
            conn.execute(
                "INSERT INTO gen_auto_tag(generation_id, auto_tag_id) VALUES('g_p2_seq','at1')"
            )
            conn.execute(
                "INSERT INTO project_task(id, project_id, name, status, sequence, folder_path) "
                "VALUES('t2_folder','p2','ep001','not_started','c0010','ep001/c0010')"
            )
            conn.execute(
                "INSERT INTO project_task(id, project_id, name, status, sequence, folder_path) "
                "VALUES('t2_seq','p2','manualseq','not_started','c0020', NULL)"
            )

        with patch.object(_mt, "_batch_task_gen_rows", wraps=_mt._batch_task_gen_rows) as cut_batch:
            result = _m.list_tasks_batch(["p1", "p2"])
        cut_batch.assert_called_once()
        p1 = {task["id"]: task for task in result["p1"]}
        p2 = {task["id"]: task for task in result["p2"]}

        self.assertEqual({cut["id"] for cut in p2["t2_folder"]["cuts"]}, {"g_p2_folder"})
        self.assertEqual({cut["id"] for cut in p2["t2_seq"]["cuts"]}, {"g_p2_seq"})
        self.assertNotIn("g_p2_folder", {cut["id"] for cut in p1["t_folder"]["cuts"]})
        self.assertNotIn("g_p2_seq", {cut["id"] for cut in p1["t_seq"]["cuts"]})

    def test_list_tasks_exposes_per_cut_metrics_for_personal_work_totals(self):
        """개인 작업표가 본인 컷만 골라 크레딧·시간·댓글을 재집계할 수 있어야 한다."""
        with db.get_connection() as conn:
            conn.execute("UPDATE generation SET model='nano_banana_2' WHERE id='g1'")
            conn.execute(
                "INSERT INTO generation_metrics(gen_id, real_credits, elapsed_seconds) "
                "VALUES('g1', 7, 12.5)"
            )
            conn.execute(
                "INSERT INTO generation_comment(id, gen_id, author, text) "
                "VALUES('comment-g1', 'g1', 'u_me', '확인')"
            )

        folder = next(task for task in _m.list_tasks("p1") if task["id"] == "t_folder")
        cut = next(item for item in folder["cuts"] if item["id"] == "g1")

        self.assertEqual(cut["credits"], 7)
        self.assertEqual(cut["elapsed"], 12.5)
        self.assertEqual(cut["comment_count"], 1)
        self.assertEqual(cut["model"], "nano_banana_2")

    def test_multi_project_batch_chunks_paired_filters_below_sqlite_limit(self):
        """프로젝트와 폴더가 각각 400개를 넘어도 SQL 변수 상한 없이 전부 매칭한다."""
        count = 401
        with db.get_connection() as conn:
            conn.executemany(
                "INSERT INTO project(id, name, kind, archived) VALUES(?,?, 'team',0)",
                [(f"bulk_p{i}", f"Bulk {i}") for i in range(count)],
            )
            conn.executemany(
                "INSERT INTO generation(id, worker_id, prompt, status, created_at, sort_ts, "
                "creator_uid, project_id, folder_path, is_final, job_id) "
                "VALUES(?, 'me', 'p', 'done', '2026-06-30T00:00:00Z', ?, 'u_me', ?, ?, 0, ?)",
                [
                    (f"bulk_g{i}", float(i), f"bulk_p{i}", f"bulk/path/{i}", f"bulk_job{i}")
                    for i in range(count)
                ],
            )
            conn.executemany(
                "INSERT INTO project_task(id, project_id, name, status, sequence, folder_path) "
                "VALUES(?,?,?,'not_started',NULL,?)",
                [
                    (f"bulk_t{i}", f"bulk_p{i}", f"task{i}", f"bulk/path/{i}")
                    for i in range(count)
                ],
            )
            rows = conn.execute(
                "SELECT * FROM project_task WHERE id LIKE 'bulk_t%' ORDER BY id"
            ).fetchall()
            result = _mt._batch_task_gen_rows(conn, None, rows)

        self.assertEqual(len(result), count)
        for i in range(count):
            self.assertEqual([cut["id"] for cut in result[f"bulk_t{i}"]], [f"bulk_g{i}"])


if __name__ == "__main__":
    unittest.main()

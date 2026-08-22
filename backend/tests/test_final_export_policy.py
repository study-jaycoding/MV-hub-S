"""완료본 내보내기 정책 단일화(services.final_export) — 레거시 파생 오라클과 동등성 검증.

레거시 = 종전 finals_to_export 구현 그대로: list_tasks(include_archived=True)의 '파생'
status 가 done 인 작업의 final+done 컷. 신규 = raw 원자료 + is_exportable 순수 정책.
같은 fixture 에서 두 방식이 완전히 같은 집합을 내면 정책 유도가 증명된다.
"""

from __future__ import annotations

import os
import tempfile
import unittest
from unittest import mock

from app import db, repo
from app.repo import manage as repo_manage
from app.services import final_export


class FinalExportPolicyTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(ignore_cleanup_errors=True)
        self.old_db = os.environ.get("CONTENT_HUB_DB")
        os.environ["CONTENT_HUB_DB"] = os.path.join(self.tmp.name, "content_hub.db")
        db.flush_pool()
        db.init_db()
        repo.ensure_default_worker()
        with db.get_connection() as conn:
            repo_manage._ensure_schema(conn)
            conn.execute("INSERT INTO project(id, name, kind, archived) VALUES('p1','P1','team',0)")
            conn.execute("INSERT INTO project(id, name, kind, archived) VALUES('p2','P2','team',0)")
            conn.execute(
                "INSERT INTO project_planning(project_id, archive_after_days) VALUES('p1', 3650)"
            )

            def gen(gid, project, folder, *, is_final=0, status="done", deleted=False):
                conn.execute(
                    "INSERT INTO generation(id, worker_id, prompt, status, created_at, sort_ts, "
                    "creator_uid, project_id, folder_path, is_final, job_id, deleted_at) "
                    "VALUES(?, 'me', 'p', ?, '2026-06-30T00:00:00Z', 1.0, 'u_me', ?, ?, ?, ?, ?)",
                    (gid, status, project, folder, is_final, "job-" + gid,
                     "2026-07-01" if deleted else None),
                )
                conn.execute(
                    "INSERT INTO asset(id, generation_id, type, file_path) VALUES(?,?,'image',?)",
                    ("a_" + gid, gid, "/media/" + gid + ".png"),
                )

            # 폴더 레인(자동 작업은 sync 가 만든다)
            gen("fg1", "p1", "ep/c1", is_final=1)                 # 포함
            gen("fg2", "p1", "ep/c1")                              # 비최종 → 제외
            gen("dg1", "p1", "ep/c1", is_final=1, deleted=True)    # 삭제 → 제외
            gen("og1", "p1", "ep/c2", is_final=1)                  # 폴더 작업 omit → 제외
            gen("ag1", "p1", "ep/c3", is_final=1)                  # 보관(archived) 작업 → 포함
            # 수동/시퀀스 레인
            gen("mg1", "p1", None, is_final=1)                     # done 수동 작업 링크 → 포함
            gen("mg2", "p1", None, is_final=1, status="running")   # 생성 미완료 → 제외
            gen("xg1", "p1", None, is_final=1)                     # in_progress 수동 작업 → 제외
            gen("sg1", "p1", None, is_final=1)                     # done 시퀀스 작업 → 포함
            gen("pg1", "p2", None, is_final=1)                     # 타 프로젝트 링크 → 제외

            conn.execute(
                "INSERT INTO project_task(id, project_id, name, status) "
                "VALUES('tm','p1','수동완료','done')"
            )
            conn.execute(
                "INSERT INTO project_task(id, project_id, name, status) "
                "VALUES('tm2','p1','수동진행','in_progress')"
            )
            conn.execute(
                "INSERT INTO project_task(id, project_id, name, status, sequence) "
                "VALUES('ts','p1','시퀀스','done','seq1')"
            )
            for tid, gid in (("tm", "mg1"), ("tm", "mg2"), ("tm", "pg1"), ("tm2", "xg1")):
                conn.execute(
                    "INSERT INTO task_generation(task_id, gen_id) VALUES(?,?)", (tid, gid)
                )
            conn.execute("INSERT INTO auto_tag(id, name, owner_uid) VALUES('at1','seq1','u_me')")
            conn.execute(
                "INSERT INTO gen_auto_tag(generation_id, auto_tag_id) VALUES('sg1','at1')"
            )
        # 폴더 자동 작업을 물질화한 뒤(읽기 경로와 동일), 정책 케이스로 상태를 조정한다.
        repo_manage.list_tasks("p1", include_archived=True)
        with db.get_connection() as conn:
            conn.execute(
                "UPDATE project_task SET status='omit' WHERE project_id='p1' AND folder_path='ep/c2'"
            )
            conn.execute(
                "UPDATE project_task SET archived=1 WHERE project_id='p1' AND folder_path='ep/c3'"
            )

    def tearDown(self):
        db.flush_pool()
        if self.old_db is None:
            os.environ.pop("CONTENT_HUB_DB", None)
        else:
            os.environ["CONTENT_HUB_DB"] = self.old_db
        db.flush_pool()
        self.tmp.cleanup()

    @staticmethod
    def _legacy_finals(project_id: str) -> set[str]:
        """종전 finals_to_export 의 판정부 그대로(list_tasks 파생 상태 기반) — 오라클."""
        tasks = repo_manage.list_tasks(project_id, include_archived=True)
        return {
            c["id"]
            for t in tasks
            if t.get("status") == "done"
            for c in t.get("cuts", [])
            if c.get("is_final") and c.get("status") == "done"
        }

    def test_full_list_matches_legacy_derivation(self):
        legacy_selected = self._legacy_finals("p1")
        new_items = final_export.finals_to_export("p1")
        self.assertEqual({f["gen_id"] for f in new_items}, {"fg1", "mg1", "sg1", "ag1"})
        # 레거시 오라클은 타 프로젝트/삭제 재제한(sources) 이전 단계이므로 그 둘만 보정해 비교.
        legacy_after_sources = {
            s["gen_id"] for s in repo_manage.final_export_sources("p1", legacy_selected)
        }
        self.assertEqual({f["gen_id"] for f in new_items}, legacy_after_sources)

    def test_single_judgment_agrees_with_full_list_for_every_gen(self):
        full_ids = {f["gen_id"]: f for f in final_export.finals_to_export("p1")}
        all_gens = ["fg1", "fg2", "dg1", "og1", "ag1", "mg1", "mg2", "xg1", "sg1", "pg1", "none"]
        for gid in all_gens:
            single = final_export.final_to_export("p1", gid)
            if gid in full_ids:
                self.assertEqual(single, full_ids[gid], gid)
            else:
                self.assertIsNone(single, gid)

    def test_single_judgment_never_runs_project_wide_scan(self):
        with (
            mock.patch.object(
                repo_manage, "list_tasks", side_effect=AssertionError("전수 판정 금지")
            ),
            mock.patch.object(
                repo_manage, "list_tasks_batch", side_effect=AssertionError("전수 판정 금지")
            ),
        ):
            result = final_export.final_to_export("p1", "fg1")
        self.assertIsNotNone(result)

    def test_single_judgment_pushes_restriction_into_lane_sql(self):
        """단건 판정의 레인 조회가 SQL 수준에서 그 생성물로 제한되는지(전수 행 스캔 금지 — 코덱스 P2)."""
        statements: list[str] = []
        original_connect = db._connect

        def tracing_connect(path):
            conn = original_connect(path)
            conn.set_trace_callback(statements.append)
            return conn

        db.flush_pool()
        try:
            with mock.patch.object(db, "_connect", side_effect=tracing_connect):
                result = final_export.final_to_export("p1", "fg1")
        finally:
            db.flush_pool()
        self.assertIsNotNone(result)
        lane_sql = "\n".join(statements)
        self.assertIn("AND gen_id IN", lane_sql)  # 수동 링크 레인 제한
        # 폴더·시퀀스 레인 '각각'에 제한이 있어야 한다(코덱스 P2 — 전체 trace 검사는
        # 한 레인이 빠져도 통과할 수 있다). R6 2-C VALUES JOIN 문으로 특정해 단정.
        folder_lane = [s for s in statements if "wanted(pid, fpath)" in s]
        sequence_lane = [s for s in statements if "wanted(pid, seqname)" in s]
        self.assertTrue(folder_lane and all("AND g.id IN" in s for s in folder_lane))
        self.assertTrue(sequence_lane and all("AND g.id IN" in s for s in sequence_lane))
        # 전체 폴더 GROUP BY(프로젝트 전수)가 아니라 대상 폴더 제한 sync 만 돈다.
        group_by_stmts = [s for s in statements if "GROUP BY g.project_id, g.folder_path" in s]
        self.assertTrue(all("g.folder_path IN (" in s for s in group_by_stmts))

    def test_workspace_moved_project_excludes_old_workspace_finals(self):
        """코덱스 P1: 프로젝트가 ws 이동하면 과거 공간 작업의 완료본은 전체·단건 모두 제외."""
        with db.get_connection() as conn:
            conn.execute(
                "INSERT INTO project(id, name, kind, archived, workspace_scope, workspace_id, "
                "workspace_name) VALUES('p3','P3','team',0,'team','ws-a','A')"
            )
            conn.execute(
                "INSERT INTO project_planning(project_id, archive_after_days) VALUES('p3', 3650)"
            )
            conn.execute(
                "INSERT INTO generation(id, worker_id, prompt, status, created_at, sort_ts, "
                "creator_uid, project_id, folder_path, is_final, job_id, "
                "workspace_scope, workspace_id, workspace_name) "
                "VALUES('tg1','me','p','done','2026-06-30T00:00:00Z',1.0,'u_me','p3','tp/c1',1,"
                "'job-tg1','team','ws-a','A')"
            )
            conn.execute(
                "INSERT INTO asset(id, generation_id, type, file_path) "
                "VALUES('a_tg1','tg1','image','/media/tg1.png')"
            )
        # ws-a 스냅샷으로 작업 물질화 → 저장 대상 확인.
        self.assertEqual(
            {f["gen_id"] for f in final_export.finals_to_export("p3")}, {"tg1"}
        )
        # 프로젝트를 ws-b 로 이동 — 레거시(list_tasks 스냅샷 필터)와 동일하게 제외돼야 한다.
        with db.get_connection() as conn:
            conn.execute(
                "UPDATE project SET workspace_id='ws-b', workspace_name='B' WHERE id='p3'"
            )
        self.assertEqual(self._legacy_finals("p3"), set())
        self.assertEqual(final_export.finals_to_export("p3"), [])
        self.assertIsNone(final_export.final_to_export("p3", "tg1"))

    def test_blank_folder_path_task_matches_legacy_truthiness(self):
        """코덱스 P3: folder_path=' '(공백) 작업은 레거시처럼 폴더 작업으로 취급 — omit 아니면 포함."""
        with db.get_connection() as conn:
            conn.execute(
                "INSERT INTO project_task(id, project_id, name, status, folder_path) "
                "VALUES('tblank','p1','공백폴더','in_progress',' ')"
            )
            conn.execute(
                "INSERT INTO generation(id, worker_id, prompt, status, created_at, sort_ts, "
                "creator_uid, project_id, folder_path, is_final, job_id) "
                "VALUES('wg1','me','p','done','2026-06-30T00:00:00Z',1.0,'u_me','p1',NULL,1,'job-wg1')"
            )
            conn.execute(
                "INSERT INTO asset(id, generation_id, type, file_path) "
                "VALUES('a_wg1','wg1','image','/media/wg1.png')"
            )
            conn.execute("INSERT INTO task_generation(task_id, gen_id) VALUES('tblank','wg1')")
        self.assertIn("wg1", self._legacy_finals("p1"))  # 레거시: truthiness → 파생 done
        self.assertIn("wg1", {f["gen_id"] for f in final_export.finals_to_export("p1")})
        single = final_export.final_to_export("p1", "wg1")
        self.assertIsNotNone(single)


if __name__ == "__main__":
    unittest.main()

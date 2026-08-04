"""완료본 저장(save-finals) 위임 모드 수정 — 대장 project_id·targets 사실·content 규칙 고정.

설계(코덱스 합의): 서버=대상 판정 권위(targets/content API) / 로컬=NAS 저장 권위.
final_export.project_id 는 위임 모드에서 팀원 생성물(로컬 generation 없음) 이력을 보존하는 축.
"""

import os
import tempfile
import unittest

from app import db, repo
from app.repo import manage as _m


class SaveFinalsDelegationTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.old_db = os.environ.get("CONTENT_HUB_DB")
        os.environ["CONTENT_HUB_DB"] = os.path.join(self.tmp.name, "content_hub.db")
        db.flush_pool()
        db.init_db()
        repo.ensure_default_worker()
        with db.get_connection() as conn:
            conn.execute("INSERT INTO project(id, name, kind, archived) VALUES('p1','P1','team',0)")
            conn.execute(
                "INSERT INTO generation(id, worker_id, prompt, status, created_at, sort_ts, "
                "creator_uid, project_id, folder_path) "
                "VALUES('g1','me','p','done','2026-06-30',1,'u_me','p1','ep001/c0010')"
            )

    def tearDown(self):
        db.flush_pool()
        if self.old_db is None:
            os.environ.pop("CONTENT_HUB_DB", None)
        else:
            os.environ["CONTENT_HUB_DB"] = self.old_db
        db.flush_pool()
        self.tmp.cleanup()

    def test_record_export_project_id_and_legacy_fallback(self):
        # 신코드: project_id 저장 — 로컬 generation 이 없는(팀원 서버 UUID) 항목도 이력에 남는다.
        _m.record_export("srv-uuid-1", r"Z:\\R\\ep001\\c0010\\c0010_srv.png", "p1")
        # 레거시 행(project_id NULL) — generation 조인 폴백으로 계속 보인다.
        with db.get_connection() as conn:
            _m._ensure_schema(conn)
            conn.execute(
                "INSERT INTO final_export(gen_id, dest_path, exported_at) "
                "VALUES('g1','Z:/R/ep001/c0010/legacy.png','2026-01-01')"
            )
        got = {e["gen_id"] for e in _m.list_exports("p1")}
        self.assertEqual(got, {"srv-uuid-1", "g1"})
        # 다른 프로젝트로는 안 샌다.
        self.assertEqual(_m.list_exports("p2"), [])

    def test_record_export_upsert_keeps_project_id(self):
        _m.record_export("g1", "Z:/a.png", "p1")
        _m.record_export("g1", "Z:/b.png")  # project_id 없이 재기록(레거시 호출) — 기존 값 보존
        rows = _m.list_exports("p1")
        self.assertEqual(rows[0]["dest_path"], "Z:/b.png")
        self.assertEqual({e["gen_id"] for e in rows}, {"g1"})

    def test_targets_facts_shape(self):
        # 서버 targets 는 '사실'만 — 디스크 판정(saved/render_path)이 절대 섞이지 않는다.
        from app.routers.manage import _save_finals_targets_facts

        with db.get_connection() as conn:
            conn.execute(
                "INSERT INTO asset(id, generation_id, type, file_path) "
                "VALUES('a1','g1','image','https://cdn.example/x.png')"
            )
            _m._ensure_schema(conn)
            conn.execute(
                "INSERT INTO project_task(id, project_id, name, folder_path, status) "
                "VALUES('t1','p1','ep001','ep001/c0010', 'done')"
            )
            conn.execute("UPDATE generation SET is_final=1 WHERE id='g1'")
        facts = _save_finals_targets_facts("p1")
        by_id = {f["gen_id"]: f for f in facts}
        self.assertIn("g1", by_id)
        f = by_id["g1"]
        self.assertEqual(f["folder_path"], "ep001/c0010")
        self.assertTrue(f["filename"].startswith("c0010_"))
        self.assertIsNone(f["reason"])
        for banned in ("saved", "render_path", "file_path", "dest"):
            self.assertNotIn(banned, f)  # 디스크·경로 사실 미노출(설계 불변식)


if __name__ == "__main__":
    unittest.main()

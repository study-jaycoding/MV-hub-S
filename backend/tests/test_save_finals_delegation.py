"""완료본 저장(save-finals) 위임 모드 수정 — 대장 project_id·targets 사실·content 규칙 고정.

설계(코덱스 합의): 서버=대상 판정 권위(targets/content API) / 로컬=NAS 저장 권위.
final_export.project_id 는 위임 모드에서 팀원 생성물(로컬 generation 없음) 이력을 보존하는 축.
"""

import os
import tempfile
import unittest
from unittest import mock

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

    def test_facts_404_disambiguation(self):
        # 구서버(라우트 없음 "Not Found")만 server_outdated — 프로젝트 404 는 그대로 전달(코덱스 P2).
        from fastapi import HTTPException

        from app.routers import manage as mroute

        orig_proxying = mroute._proxy.proxying
        orig_pj = mroute._proxy.proxy_json

        def _raise(detail):
            def _f(*a, **k):
                raise HTTPException(status_code=404, detail=detail)

            return _f

        mroute._proxy.proxying = lambda: True
        try:
            mroute._proxy.proxy_json = _raise("Not Found")  # FastAPI 기본(라우트 자체 없음)
            facts, outdated = mroute._save_finals_facts("p1")
            self.assertEqual((facts, outdated), ([], True))
            mroute._proxy.proxy_json = _raise("없는 프로젝트")  # 신서버의 실제 404
            with self.assertRaises(HTTPException) as cm:
                mroute._save_finals_facts("p1")
            self.assertEqual(cm.exception.detail, "없는 프로젝트")
        finally:
            mroute._proxy.proxying = orig_proxying
            mroute._proxy.proxy_json = orig_pj

    def test_content_route_covered_by_stream_prefix(self):
        # content 는 대용량 바이트 — 일반 _forward(전체 read) 대신 스트리밍 중계 접두사에 걸려야
        # 한다(코덱스 P1). 라우트 개명 시 이 핀이 우회 회귀를 잡는다.
        from app.routers import _proxy as proxy_mod
        from app.routers.manage import router as manage_router

        content_paths = [
            r.path for r in manage_router.routes if "save-finals/content" in getattr(r, "path", "")
        ]
        self.assertTrue(content_paths)
        for p in content_paths:
            self.assertTrue(p.startswith(proxy_mod._STREAM_PREFIX))
        # 스트리밍 경로는 로컬 처리 대상이 아니어야(위임 시 서버로 감) — 분류 이중 확인.
        self.assertFalse(proxy_mod.is_local_path(proxy_mod._STREAM_PREFIX + "abc"))

    def test_content_rejects_private_remote_url_before_open(self):
        """발행 번들의 file_path 를 악용해 서버 내부망을 읽는 SSRF를 차단한다."""
        from fastapi import HTTPException

        from app.routers import manage as mroute

        with (
            mock.patch.object(mroute.repo, "get_generation", return_value={"project_id": "p1"}),
            mock.patch.object(mroute, "_require_project_manage"),
            mock.patch.object(
                mroute.repo_manage,
                "finals_to_export",
                return_value=[{"gen_id": "g1", "file_path": "http://127.0.0.1/private"}],
            ),
            mock.patch.object(mroute, "guarded_opener") as opener,
        ):
            with self.assertRaises(HTTPException) as cm:
                mroute.save_finals_content("g1", mock.Mock())
        self.assertEqual(cm.exception.status_code, 400)
        self.assertIn("허용되지 않는 원본 URL", str(cm.exception.detail))
        opener.assert_not_called()

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

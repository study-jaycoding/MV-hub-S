"""완료 탭 '공유 저장 · 최종 저장'(설계: docs/EXPORT_SYNC_DESIGN.md).

여기서 고정하는 규칙:
- 종류는 final(최종) · shared(공유 중이지만 최종은 아님 — 보류 포함). 두 집합은 겹치지 않는다.
- 공유본은 컷 폴더 안의 `shared/` 에 저장한다. 최종본의 경로는 종전 그대로다.
- '이미 저장'은 이름만으로 정하지 않는다: 대장이 그 경로를 기억하거나, 각인의 gen_id 가 다른 생성물이 아닐 때만.
  각인이 다른 생성물이면 conflict — 건너뛰지도 덮어쓰지도 않는다.
- 위임 모드에서 kind=shared 는 서버가 응답에 kind 를 되돌려 줄 때만 믿는다(구서버는 최종 목록을 준다).
"""
from __future__ import annotations

import asyncio
import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from fastapi import HTTPException

from app import db, repo
from app.repo import manage as repo_manage
from app.routers import manage as manage_router
from app.services import file_stamp, final_export, project_folders


class SaveFinalsKindTests(unittest.TestCase):
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

            def gen(gid, *, is_final=0, shared=False, held=0, status="done"):
                conn.execute(
                    "INSERT INTO generation(id, worker_id, prompt, status, created_at, sort_ts, creator_uid, project_id, "
                    "folder_path, is_final, is_held, job_id) VALUES(?, 'me', 'p', ?, '2026-06-30T00:00:00Z', 1.0, 'u_me', 'p1', 'ep/c1', ?, ?, ?)",
                    (gid, status, is_final, held, "job-" + gid),
                )
                conn.execute("INSERT INTO asset(id, generation_id, type, file_path) VALUES(?,?,'image',?)", ("a_" + gid, gid, "/media/" + gid + ".png"))
                if shared:
                    conn.execute("INSERT INTO share(id, generation_id, shared_by) VALUES(?,?,'me')", ("s_" + gid, gid))

            gen("final0000001", is_final=1, shared=True)   # 최종 — final 에만
            gen("shared000001", shared=True)               # 공유 — shared
            gen("held00000001", shared=True, held=1)       # 보류 — 공유의 하위 상태라 shared 에 포함
            gen("private00001")                            # 공유 안 함 — 어디에도 없음
            gen("running00001", shared=True, status="running")  # 생성 미완료 — 제외
        repo_manage.list_tasks("p1", include_archived=True)  # 폴더 자동 작업 물질화

    def tearDown(self):
        db.flush_pool()
        if self.old_db is None:
            os.environ.pop("CONTENT_HUB_DB", None)
        else:
            os.environ["CONTENT_HUB_DB"] = self.old_db
        db.flush_pool()
        self.tmp.cleanup()

    def test_kinds_are_disjoint_and_held_counts_as_shared(self):
        ids = lambda kind: {f["gen_id"] for f in final_export.finals_to_export("p1", kind)}  # noqa: E731
        self.assertEqual(ids("final"), {"final0000001"})
        self.assertEqual(ids("shared"), {"shared000001", "held00000001"})
        self.assertEqual(final_export.final_to_export("p1", "held00000001")["kind"], "shared")  # 바이트 중계는 종류를 안 가린다
        self.assertIsNone(final_export.final_to_export("p1", "held00000001", "final"))
        self.assertIsNone(final_export.final_to_export("p1", "private00001"))

    def test_shared_files_go_to_shared_subfolder_and_final_path_is_unchanged(self):
        self.assertEqual(project_folders.export_folder("ep/c1", "final"), "ep/c1")
        self.assertEqual(project_folders.export_folder("ep\\c1/", "shared"), "ep/c1/shared")
        self.assertEqual(project_folders.export_folder("", "shared"), "")  # 폴더 없는 것은 어차피 저장 불가
        facts = manage_router._save_finals_targets_facts("p1", "shared")
        self.assertEqual({t["kind"] for t in facts}, {"shared"})
        self.assertEqual({t["folder_path"] for t in facts}, {"ep/c1"})  # 폴더 좁히기(_only_in_folder)는 컷 폴더 기준 그대로

    def test_same_name_file_of_another_generation_is_a_conflict_not_saved(self):
        dest = Path(self.tmp.name) / "c1_final0000001.png"
        self.assertEqual(manage_router._dest_state(dest, "final0000001", {}), "missing")
        dest.write_bytes(b"x")
        with mock.patch.object(file_stamp, "read_stamp", return_value={file_stamp.KEY_GEN: "final0000001-other"}):
            self.assertEqual(manage_router._dest_state(dest, "final0000001", {}), "conflict")
            # 이 PC 가 그 경로에 저장했다고 대장이 기억하면 각인을 읽지 않는다(NAS 의 영상에 ffmpeg 를 돌리지 않는다)
            self.assertEqual(manage_router._dest_state(dest, "final0000001", {"final0000001": str(dest)}), "saved")
        with mock.patch.object(file_stamp, "read_stamp", return_value={file_stamp.KEY_GEN: "final0000001"}):
            self.assertEqual(manage_router._dest_state(dest, "final0000001", {}), "saved")
        with mock.patch.object(file_stamp, "read_stamp", return_value={}):  # 각인 이전 파일·다른 PC 의 각인 실패본
            self.assertEqual(manage_router._dest_state(dest, "final0000001", {}), "saved")

    def test_targets_route_echoes_kind_and_rejects_unknown(self):
        request = mock.Mock()
        with mock.patch.object(manage_router, "_require_project_read"):
            out = manage_router.save_finals_targets("p1", request, kind="shared")
            self.assertEqual((out["kind"], {t["gen_id"] for t in out["targets"]}), ("shared", {"shared000001", "held00000001"}))
            self.assertEqual(manage_router.save_finals_targets("p1", request)["kind"], "final")
            with self.assertRaises(HTTPException) as ctx:
                manage_router.save_finals_targets("p1", request, kind="everything")
            self.assertEqual(ctx.exception.status_code, 400)

    def test_old_server_ignoring_kind_never_feeds_finals_into_shared(self):
        old_server = {"targets": [{"gen_id": "final0000001", "folder_path": "ep/c1", "filename": "c1_final0000001.png", "reason": None}]}
        with mock.patch.object(manage_router._proxy, "proxying", return_value=True), \
                mock.patch.object(manage_router._proxy, "proxy_json", return_value=old_server):
            self.assertEqual(manage_router._save_finals_facts("p1", "shared"), ([], True))  # kind 를 안 되돌려 줌 = 구서버
            facts, outdated = manage_router._save_finals_facts("p1", "final")               # 최종 저장은 구서버에서도 그대로
            self.assertEqual(([t["kind"] for t in facts], outdated), (["final"], False))

    def test_final_request_never_relabels_a_shared_list(self):
        wrong = {"kind": "shared", "targets": []}
        with mock.patch.object(manage_router._proxy, "proxying", return_value=True), mock.patch.object(manage_router._proxy, "proxy_json", return_value=wrong):
            with self.assertRaises(HTTPException) as ctx:
                manage_router._save_finals_facts("p1", "final")
            self.assertEqual(ctx.exception.status_code, 502)

    def test_shared_lookup_failure_keeps_final_status_and_all_keeps_final_result(self):
        real = manage_router._save_finals_facts

        def flaky(project_id, kind="final"):
            if kind == "shared":
                raise HTTPException(status_code=503, detail="공유 서버 응답 없음")
            return real(project_id, kind)

        state = {"render_path": None, "error": None}
        with mock.patch.object(manage_router, "_save_finals_facts", side_effect=flaky), mock.patch.object(project_folders, "render_root_state", return_value=state), mock.patch.object(manage_router, "_require_project_read"):
            status = manage_router.save_finals_status("p1", mock.Mock())
        self.assertEqual((status["shared_supported"], status["shared_error"]), (False, "공유 서버 응답 없음"))
        self.assertEqual([t["gen_id"] for t in status["targets"]], ["final0000001"])  # 최종 목록은 그대로 뜬다

        async def locked(project_id, request, render, folder_path=None, kind="final"):
            if kind == "shared":
                raise HTTPException(status_code=400, detail="공유 서버 업데이트가 필요합니다")
            return {"saved": 1, "skipped": 0, "errors": []}

        ok_state = {"render_path": self.tmp.name, "error": None}
        with mock.patch.object(manage_router, "_save_finals_locked", side_effect=locked), mock.patch.object(project_folders, "render_root_state", return_value=ok_state), mock.patch.object(manage_router, "_require_project_manage"):
            out = asyncio.run(manage_router.save_finals("p1", mock.Mock(), kind="all"))
            with self.assertRaises(HTTPException):  # 한 종류만 고른 저장은 종전처럼 오류를 그대로 낸다
                asyncio.run(manage_router.save_finals("p1", mock.Mock(), kind="shared"))
        self.assertEqual((out["saved"], [e["gen_id"] for e in out["errors"]]), (1, ["(shared)"]))

    def test_compare_reads_only_and_splits_new_leftover_unknown(self):
        render = Path(self.tmp.name) / "Render"
        cut = render / "ep" / "c1"
        (cut / "shared").mkdir(parents=True)
        (cut / "c1_final0000001.png").write_bytes(b"saved")                 # 같음(각인 없음 = 종전처럼 저장된 것으로 본다)
        (cut / "c1_oldfinal0000.png").write_bytes(b"ours-but-not-wanted")   # 폴더에만 남은 우리 파일(최종 해제 등)
        (cut / "shared" / "c1_gone00000000.png").write_bytes(b"ours")       # 폴더에만 남은 우리 공유본
        (cut / "사람이넣은파일.png").write_bytes(b"human")                     # 모르는 파일 — 이름 규칙이 아니다
        (cut / "c1_fakeprefix00.png").write_bytes(b"no-stamp")              # 이름은 맞지만 각인이 없다 — 모르는 파일
        (cut / "c1_x.png.abcd.part").write_bytes(b"temp")                   # 저장 중 임시 파일은 세지 않는다
        stamps = {"c1_oldfinal0000.png": "oldfinal0000-full-id", "c1_gone00000000.png": "gone00000000-full-id"}
        before = sorted(str(f) for f in render.rglob("*"))
        state = {"render_path": str(render), "error": None}
        read = lambda path: {file_stamp.KEY_GEN: stamps[path.name]} if path.name in stamps else {}  # noqa: E731
        with mock.patch.object(project_folders, "render_root_state", return_value=state), \
                mock.patch.object(manage_router, "_require_project_manage"), \
                mock.patch.object(file_stamp, "read_stamp", side_effect=read):
            out = manage_router.save_finals_compare("p1", mock.Mock())
        self.assertEqual(sorted(str(f) for f in render.rglob("*")), before)  # 읽기만 한다
        self.assertEqual({(t["gen_id"], t["folder_path"]) for t in out["to_add"]}, {("shared000001", "ep/c1/shared"), ("held00000001", "ep/c1/shared")})
        self.assertEqual({(t["filename"], t["kind"], t["folder_path"]) for t in out["extra"]},
                         {("c1_oldfinal0000.png", "final", "ep/c1"), ("c1_gone00000000.png", "shared", "ep/c1/shared")})
        self.assertEqual((out["same"], out["unknown"], out["blocked"], out["shared_supported"]), (1, 2, [], True))

    def test_compare_is_local_only_but_targets_and_content_stay_delegated(self):
        from app.routers import _proxy

        self.assertTrue(_proxy.is_local_path("/api/manage/save-finals/compare"))
        self.assertTrue(_proxy.is_local_path("/api/manage/save-finals"))
        self.assertFalse(_proxy.is_local_path("/api/manage/save-finals/targets"))
        self.assertFalse(_proxy.is_local_path("/api/manage/save-finals/content/abc"))

    def test_save_writes_each_kind_to_its_folder_and_is_idempotent(self):
        render = Path(self.tmp.name) / "Render"
        media = Path(self.tmp.name) / "media"
        render.mkdir()
        media.mkdir()
        for gid in ("final0000001", "shared000001", "held00000001"):
            (media / f"{gid}.png").write_bytes(b"png-" + gid.encode())
        state = {"render_path": str(render), "error": None}
        with mock.patch.object(project_folders, "render_root_state", return_value=state), \
                mock.patch.object(manage_router, "MEDIA_DIR", media), \
                mock.patch.object(manage_router, "_require_project_manage"), \
                mock.patch.object(manage_router, "_require_project_read"), \
                mock.patch.object(file_stamp, "stamp_file", return_value=True):
            first = asyncio.run(manage_router.save_finals("p1", mock.Mock(), kind="all"))
            again = asyncio.run(manage_router.save_finals("p1", mock.Mock(), kind="all"))
            status = manage_router.save_finals_status("p1", mock.Mock())
        self.assertEqual((first["saved"], first["skipped"], first["errors"]), (3, 0, []))
        self.assertEqual((again["saved"], again["skipped"]), (0, 3))
        self.assertTrue((render / "ep" / "c1" / "c1_final0000001.png").is_file())
        self.assertTrue((render / "ep" / "c1" / "shared" / "c1_shared000001.png").is_file())
        self.assertFalse((render / "ep" / "c1" / "c1_shared000001.png").exists())
        self.assertTrue(status["shared_supported"])
        self.assertEqual({(t["kind"], t["saved"]) for t in status["targets"]}, {("final", True), ("shared", True)})


if __name__ == "__main__":
    unittest.main()

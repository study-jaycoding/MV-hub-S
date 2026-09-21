"""대량 저장의 진행률·취소 — 수백 건을 말없이 받던 것을 보이게 하고 멈출 수 있게 한다.

여기서 고정하는 규칙:
- 저장은 프로젝트당 한 번만 돈다(`_save_finals_lock`) → 작업 id 없이 프로젝트별 기록 하나.
- 기록은 **잠금을 잡은 뒤**에 만든다(기다리던 다음 요청이 앞 실행의 기록을 덮지 않게).
- `run` 은 실행 세대 — 끝난 저장에 늦게 도착한 취소가 **다음** 저장을 죽이지 않는다.
- 취소는 건 사이에만 본다(받던 파일 하나는 끝낸다). 이미 저장된 것은 되돌리지 않는다.
- 미러는 취소되면 **정리를 시작하지 않는다**(옮기기 시작하면 중간에 멈출 수 없다).
"""
from __future__ import annotations

import asyncio
import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from app import db, repo
from app.repo import manage as repo_manage
from app.routers import manage as manage_router
from app.services import file_stamp, project_folders


class SaveProgressTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(ignore_cleanup_errors=True)
        self.old_db = os.environ.get("CONTENT_HUB_DB")
        os.environ["CONTENT_HUB_DB"] = os.path.join(self.tmp.name, "content_hub.db")
        db.flush_pool()
        db.init_db()
        repo.ensure_default_worker()
        manage_router._SAVE_PROGRESS.clear()
        self.render = Path(self.tmp.name) / "Render"
        self.render.mkdir()
        self.media = Path(self.tmp.name) / "media"
        self.media.mkdir()
        with db.get_connection() as conn:
            conn.execute("INSERT INTO project(id, name, kind, archived) VALUES('p1','P1','team',0)")
            for i in range(6):
                gid = f"shared{i:06d}00"
                conn.execute(
                    "INSERT INTO generation(id, worker_id, prompt, status, created_at, sort_ts, creator_uid, project_id, "
                    "folder_path, is_final, is_held, job_id) VALUES(?, 'me', 'p', 'done', '2026-06-30T00:00:00Z', 1.0, 'u_me', 'p1', ?, 0, 0, ?)",
                    (gid, f"ep/c{i}", "job-" + gid),
                )
                conn.execute("INSERT INTO asset(id, generation_id, type, file_path) VALUES(?,?,'image',?)",
                             ("a_" + gid, gid, "/media/" + gid + ".png"))
                conn.execute("INSERT INTO share(id, generation_id, shared_by) VALUES(?,?,'me')", ("s_" + gid, gid))
                (self.media / f"{gid}.png").write_bytes(b"png-" + gid.encode())
        repo_manage.list_tasks("p1", include_archived=True)

    def tearDown(self):
        db.flush_pool()
        if self.old_db is None:
            os.environ.pop("CONTENT_HUB_DB", None)
        else:
            os.environ["CONTENT_HUB_DB"] = self.old_db
        db.flush_pool()
        self.tmp.cleanup()

    def _patches(self, on_item=None):
        state = {"render_path": str(self.render), "error": None}
        real = manage_router._dest_state

        def watched(dest, gen_id, ledger):
            if on_item:
                on_item(gen_id)
            return real(dest, gen_id, ledger)

        return [mock.patch.object(project_folders, "render_root_state", return_value=state),
                mock.patch.object(manage_router, "MEDIA_DIR", self.media),
                mock.patch.object(manage_router, "_require_project_manage"),
                mock.patch.object(manage_router, "_require_project_read"),
                mock.patch.object(file_stamp, "stamp_file", return_value=True),
                mock.patch.object(manage_router, "_dest_state", side_effect=watched)]

    def _run(self, on_item=None, kind="shared"):
        from contextlib import ExitStack
        with ExitStack() as stack:
            for item in self._patches(on_item):
                stack.enter_context(item)
            return asyncio.run(manage_router.save_finals("p1", mock.Mock(), kind=kind))

    def test_progress_counts_every_item_and_is_readable_while_saving(self):
        """저장 중에 조회하면 '몇 개 중 몇 개'가 보인다 — 종전엔 끝날 때까지 아무것도 안 보였다."""
        seen = []

        def peek(_gen_id):
            view = manage_router._progress_view("p1")
            seen.append((view["done"], view["total"], view["running"]))

        out = self._run(peek)
        self.assertEqual((out["saved"], out["cancelled"]), (6, False))
        self.assertEqual([d for d, _, _ in seen], [1, 2, 3, 4, 5, 6])  # 건마다 오른다
        self.assertTrue(all(total == 6 and running for _, total, running in seen))
        done = manage_router._progress_view("p1")
        self.assertEqual((done["done"], done["total"], done["running"], done["saved"]), (6, 6, False, 6))

    def test_cancel_stops_before_the_next_file_and_keeps_what_was_saved(self):
        """취소하면 받던 파일 하나는 끝내고 멈춘다. 이미 저장한 것은 그대로 두고, 다시 누르면 이어서 한다."""
        def cancel_after_two(_gen_id):
            view = manage_router._progress_view("p1")
            if view["done"] == 2:
                self.assertTrue(asyncio.run(manage_router.save_finals_cancel(
                    "p1", manage_router.SaveFinalsCancelIn(run=view["run"]), mock.Mock()))["ok"])

        out = self._run(cancel_after_two)
        self.assertTrue(out["cancelled"])
        self.assertEqual(out["saved"], 2)  # 취소를 본 건까지만
        self.assertEqual(len(list((self.render / "ep").rglob("*.png"))), 2)  # 남은 파일도 2개
        again = self._run()  # 다시 누르면 이어서 — 저장은 더하기만 한다(멱등)
        self.assertEqual((again["saved"], again["skipped"], again["cancelled"]), (4, 2, False))

    def test_a_late_cancel_does_not_kill_the_next_save(self):
        """끝난 저장의 취소가 늦게 도착해도 다음 저장을 죽이지 않는다 — 실행 세대(run)로 가린다."""
        first = manage_router._progress_view("p1")
        self.assertIsNone(first)
        self._run()
        stale = manage_router._progress_view("p1")["run"]
        answer = asyncio.run(manage_router.save_finals_cancel(
            "p1", manage_router.SaveFinalsCancelIn(run=stale), mock.Mock()))
        self.assertFalse(answer["ok"])  # 이미 끝났다
        out = self._run()  # 다음 저장은 멀쩡하다
        self.assertFalse(out["cancelled"])
        self.assertEqual(manage_router._progress_view("p1")["run"], stale + 1)

    def test_progress_is_created_after_the_lock_so_a_waiting_request_cannot_overwrite_it(self):
        """기록은 잠금을 잡은 뒤에 만든다 — 기다리던 요청이 먼저 만들면 앞 실행의 수와 취소가 섞인다."""
        source = __import__("inspect").getsource(manage_router.save_finals)
        lock_at = source.index("_save_finals_lock(project_id)")
        start_at = source.index("_progress_start(project_id")
        self.assertLess(lock_at, start_at)

    def test_a_finished_record_is_dropped_after_its_keep_time(self):
        """끝난 기록은 잠깐 남겨 '지난 저장'을 보여 주고, 오래되면 조회하는 김에 버린다(타이머 없이)."""
        self._run()
        view = manage_router._progress_view("p1")
        self.assertFalse(view["running"])
        manage_router._SAVE_PROGRESS["p1"]["ended_at"] -= manage_router._SAVE_PROGRESS_KEEP_SEC + 1
        self.assertIsNone(manage_router._progress_view("p1"))
        self.assertNotIn("p1", manage_router._SAVE_PROGRESS)

    def test_cancelling_a_mirror_saves_but_never_starts_the_cleanup(self):
        """미러가 취소되면 저장한 것은 두고 **정리는 시작하지 않는다** — 옮기기 시작하면 중간에 못 멈춘다."""
        moved = []

        def cancel_at_start(_gen_id):
            view = manage_router._progress_view("p1")
            # 미러는 저장 전에 폴더를 먼저 훑는다 — 그때는 아직 기록이 없다(잠금 뒤에 만들기 때문).
            if view and view["done"] == 1:
                asyncio.run(manage_router.save_finals_cancel(
                    "p1", manage_router.SaveFinalsCancelIn(run=view["run"]), mock.Mock()))

        from contextlib import ExitStack
        with ExitStack() as stack:
            for item in self._patches(cancel_at_start):
                stack.enter_context(item)
            stack.enter_context(mock.patch.object(manage_router, "_mirror_move",
                                                  side_effect=lambda *a, **k: moved.append(a) or {}))
            out = asyncio.run(manage_router.save_finals_mirror(
                "p1", manage_router.MirrorIn(confirm=[]), mock.Mock()))
        self.assertTrue(out["cancelled"])
        self.assertEqual(moved, [])  # 정리 단계에 들어가지 않았다
        self.assertEqual(out["moved"], [])
        self.assertGreaterEqual(out["saved"], 1)  # 저장한 것은 남는다


if __name__ == "__main__":
    unittest.main()

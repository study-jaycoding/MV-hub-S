"""카드 다운로드의 파일 이름 — `POST /api/download/names`(설계: docs/EXPORT_SYNC_DESIGN.md §7).

여기서 고정하는 규칙:
- 이름 = `<프로젝트>_<폴더 마디>_<work|share|fin>_<작업자>_<번호>`. 종류는 카드의 지금 상태(최종 → fin, 공유 → share, 그 밖 → work).
- 번호는 공유·최종 저장, 다빈치 보내기와 같은 장부의 같은 번호다 — 상태가 바뀌어도 번호는 그대로다.
- 생성물 id 만 받는다. 볼 수 없거나 없는 생성물은 응답에서 빠진다.
- 번호를 받을 수 없으면(렌더 폴더 미연결·폴더 없음) 같은 꼴의 임시 이름을 주고 장부에 아무것도 적지 않는다.
"""
from __future__ import annotations

import os
import re
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from fastapi.testclient import TestClient
from starlette.responses import StreamingResponse

from app import db, repo
from app.routers import _proxy, library
from app.services import export_names, project_folders

FOLDER = "e035/C0050"


class DownloadNameTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(ignore_cleanup_errors=True)
        self.old_db = os.environ.get("CONTENT_HUB_DB")
        os.environ["CONTENT_HUB_DB"] = os.path.join(self.tmp.name, "content_hub.db")
        db.flush_pool()
        db.init_db()
        repo.ensure_default_worker()
        self.render = Path(self.tmp.name) / "Render"
        (self.render / "e035" / "C0050").mkdir(parents=True)
        with db.get_connection() as conn:
            conn.execute("INSERT INTO project(id, name, kind, archived) VALUES('p1','뻘뻘뻘','team',0)")
            conn.execute("INSERT INTO project(id, name, kind, archived) VALUES('p2','렌더 없음','team',0)")
            conn.executemany("INSERT INTO creator(uid, name) VALUES(?,?)", [("u_me", "리버"), ("u_jay", "Jay Lee")])

            def gen(gid, *, uid="u_me", pid="p1", folder=FOLDER, is_final=0, shared=False, path="/media/a/x.mp4", kind="video"):
                conn.execute(
                    "INSERT INTO generation(id, worker_id, prompt, status, created_at, sort_ts, creator_uid, project_id, folder_path, "
                    "is_final, job_id) VALUES(?, 'me', 'p', 'done', '2026-06-30T00:00:00Z', 1.0, ?, ?, ?, ?, ?)",
                    (gid, uid, pid, folder, is_final, "job-" + gid),
                )
                conn.execute("INSERT INTO asset(id, generation_id, type, file_path) VALUES(?,?,?,?)", ("a_" + gid, gid, kind, path))
                if shared:
                    conn.execute("INSERT INTO share(id, generation_id, shared_by) VALUES(?,?,'me')", ("s_" + gid, gid))

            gen("work1")
            gen("share1", shared=True)
            gen("fin1", is_final=1, shared=True, path="/media/a/still.png", kind="image")
            gen("jay1", uid="u_jay")
            gen("nofolder", folder=None)
            gen("norender", pid="p2")
        self.client = TestClient(library_app(), client=("127.0.0.1", 50000))
        state = lambda pid: {"render_path": str(self.render) if pid == "p1" else "", "error": None}  # noqa: E731
        self.patch = mock.patch.object(project_folders, "render_root_state", side_effect=state)
        self.patch.start()

    def tearDown(self):
        self.patch.stop()
        self.client.close()
        db.flush_pool()
        if self.old_db is None:
            os.environ.pop("CONTENT_HUB_DB", None)
        else:
            os.environ["CONTENT_HUB_DB"] = self.old_db
        db.flush_pool()
        self.tmp.cleanup()

    def names(self, *ids: str) -> dict:
        response = self.client.post("/api/download/names", json={"gen_ids": list(ids)})
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()["names"]

    def test_the_name_follows_the_card_and_the_number_is_given_once(self):
        first = self.names("work1", "share1", "fin1", "jay1")
        self.assertEqual(first, {
            "work1": {"name": "뻘뻘뻘_e035_C0050_work_리버_001.mp4", "numbered": True},  # 공유 안 한 작업물
            "share1": {"name": "뻘뻘뻘_e035_C0050_share_리버_002.mp4", "numbered": True},  # 공유된 것
            "fin1": {"name": "뻘뻘뻘_e035_C0050_fin_리버_003.png", "numbered": True},  # 최종 — 확장자는 원본의 것
            "jay1": {"name": "뻘뻘뻘_e035_C0050_work_Jay_Lee_001.mp4", "numbered": True},  # 작업자마다 001 부터
        })
        self.assertEqual(self.names("jay1", "fin1", "share1", "work1", "work1"), first)  # 다시 받아도, 순서가 달라도 같은 이름

    def test_the_number_stays_when_the_card_becomes_shared_and_is_the_one_saving_uses(self):
        self.assertEqual(self.names("work1")["work1"]["name"], "뻘뻘뻘_e035_C0050_work_리버_001.mp4")
        with db.get_connection() as conn:
            conn.execute("INSERT INTO share(id, generation_id, shared_by) VALUES('s_work1','work1','me')")
        self.assertEqual(self.names("work1")["work1"]["name"], "뻘뻘뻘_e035_C0050_share_리버_001.mp4")  # 종류만 바뀐다
        # 공유 저장·다빈치가 보는 장부의 그 번호다(같은 열쇠 = job_id, 같은 프로젝트)
        ident = export_names.Ident("p1", "뻘뻘뻘", "job-work1", "id-on-another-pc", "리버")
        book = export_names.NameBook2(self.render, FOLDER)
        self.assertEqual(book.name_of(ident, "davinci"), "뻘뻘뻘_e035_C0050_davinci_리버_001.mp4")
        self.assertFalse(book.is_done(ident, "share"))  # 다운로드는 렌더 폴더에 파일을 놓지 않는다 — 확정 표식이 없다

    def test_without_a_place_for_the_ledger_the_download_gets_a_temporary_name(self):
        got = self.names("nofolder", "norender")
        for gen_id, shape in (("nofolder", r"뻘뻘뻘_work_리버_x[0-9a-f]{8}\.mp4"), ("norender", r"렌더_없음_e035_C0050_work_리버_x[0-9a-f]{8}\.mp4")):
            self.assertRegex(got[gen_id]["name"], "^" + shape + "$")
            self.assertFalse(got[gen_id]["numbered"])
        self.assertEqual(self.names("nofolder", "norender"), got)  # 임시 이름도 같은 생성물이면 같다
        self.assertFalse((self.render / "_mvhub_sync").exists())  # 장부에 아무것도 적지 않았다

    def test_an_unreadable_ledger_never_blocks_the_download(self):
        with mock.patch.object(export_names.NameBook2, "reload", side_effect=export_names.RegistryError("NAS")):
            got = self.names("work1")["work1"]
        self.assertEqual((bool(re.search(r"_work_리버_x[0-9a-f]{8}\.mp4$", got["name"])), got["numbered"]), (True, False))

    def test_a_card_with_nothing_to_download_yet_gets_no_name(self):
        """생성 중인 카드에 이름을 주면 확장자(`.bin`)가 번호와 함께 굳는다 — 결과물이 생긴 뒤의 저장·다빈치까지 그 확장자를 쓴다
        (Codex 코드 리뷰 P1). 받을 결과물이 없는 카드는 응답에서 빠지고 번호도 생기지 않는다."""
        with db.get_connection() as conn:
            conn.execute("INSERT INTO generation(id, worker_id, prompt, status, created_at, sort_ts, creator_uid, project_id, folder_path, job_id) "
                         "VALUES('running1', 'me', 'p', 'running', '2026-06-30T00:00:00Z', 1.0, 'u_me', 'p1', ?, 'job-running1')", (FOLDER,))
        self.assertEqual(self.names("running1"), {})
        self.assertFalse((self.render / "_mvhub_sync").exists())
        with db.get_connection() as conn:  # 생성이 끝났다
            conn.execute("UPDATE generation SET status='done' WHERE id='running1'")
            conn.execute("INSERT INTO asset(id, generation_id, type, file_path) VALUES('a_running1','running1','video','/media/a/r.mp4')")
        self.assertEqual(self.names("running1")["running1"], {"name": "뻘뻘뻘_e035_C0050_work_리버_001.mp4", "numbered": True})

    def test_a_busy_ledger_gives_a_temporary_name_instead_of_queueing(self):
        """다른 이름 요청이 번호를 받는 중(NAS 가 멎었을 수도 있다)이면 뒤의 요청은 잠깐만 기다리다 임시 이름을 받는다 —
        줄을 세우면 워커 스레드가 차서 허브의 다른 요청까지 선다(Codex 코드 리뷰 P1)."""
        self.assertTrue(library._DOWNLOAD_NAMES_LOCK.acquire(blocking=False))
        try:
            with mock.patch.object(library, "_DOWNLOAD_NAMES_WAIT", 0.05):
                got = self.names("work1")["work1"]
        finally:
            library._DOWNLOAD_NAMES_LOCK.release()
        self.assertEqual((bool(re.search(r"_work_리버_x[0-9a-f]{8}\.mp4$", got["name"])), got["numbered"]), (True, False))
        self.assertFalse((self.render / "_mvhub_sync").exists())
        self.assertEqual(self.names("work1")["work1"], {"name": "뻘뻘뻘_e035_C0050_work_리버_001.mp4", "numbered": True})  # 풀리면 번호를 받는다

    def test_only_ids_are_taken_and_unknown_ones_are_left_out(self):
        self.assertEqual(set(self.names("work1", "nope", "  ")), {"work1"})
        self.assertEqual(self.names(), {})
        too_many = [f"g{i}" for i in range(library.MAX_DOWNLOAD_NAMES + 1)]
        self.assertEqual(self.client.post("/api/download/names", json={"gen_ids": too_many}).status_code, 422)
        # 화면이 이름·종류를 같이 보내도 쓰지 않는다(모르는 필드는 버린다)
        sent = {"gen_ids": ["work1"], "names": {"work1": "남의_이름_fin_x_999.mp4"}, "kind": "fin"}
        self.assertEqual(self.client.post("/api/download/names", json=sent).json()["names"]["work1"]["name"], "뻘뻘뻘_e035_C0050_work_리버_001.mp4")

    def test_the_route_runs_on_this_pc_and_a_korean_name_survives_the_download_header(self):
        self.assertTrue(_proxy.is_local_path("/api/download/names"))  # 장부가 이 PC 가 보는 렌더 폴더에 있다
        self.assertEqual(library._attachment("plain_001.mp4"), 'attachment; filename="plain_001.mp4"')
        header = library._attachment("뻘뻘뻘_e035_C0050_work_리버_001.mp4")
        self.assertTrue(header.startswith("attachment; filename*=utf-8''%EB"))
        StreamingResponse(iter([b"x"]), headers={"Content-Disposition": header})  # 머리글에 그대로 실으면 여기서 UnicodeEncodeError


def library_app():
    from app.main import app

    return app


if __name__ == "__main__":
    unittest.main()

"""Comfy 출력 → '내 작업' 저장 검증 (Phase A).

 · create_comfy_generation 이 generation(generator='comfy', origin='local', job_id NULL, status='done')
   + asset 을 한 트랜잭션으로 물질화하는지
 · HF 삭제검증 대상(gens_with_job_id)에서 자동 제외(job_id 없음)
 · POST /api/comfy/save-to-library: 텍스트 출력 제외 + 재저장 멱등 + 응답 형태
"""

import os
import tempfile
import unittest


class ComfySaveRepoTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(ignore_cleanup_errors=True)
        self.old_db = os.environ.get("CONTENT_HUB_DB")
        os.environ["CONTENT_HUB_DB"] = os.path.join(self.tmp.name, "content_hub.db")
        from app import db, repo

        db.flush_pool()
        db.init_db()
        repo.ensure_default_worker()
        self.db = db
        self.repo = repo

    def tearDown(self):
        self.db.flush_pool()
        if self.old_db is None:
            os.environ.pop("CONTENT_HUB_DB", None)
        else:
            os.environ["CONTENT_HUB_DB"] = self.old_db
        self.db.flush_pool()
        self.tmp.cleanup()

    def test_materializes_generation_and_asset(self):
        gid, _existed = self.repo.create_comfy_generation(
            worker_id="me", creator_uid="me", prompt="얼음 새우", display_prompt=None,
            params={"workflow_name": "nano_image"}, kind="image",
            file_path="/media/comfy/abc123.png", thumbnail_path=None,
        )
        with self.db.get_connection() as c:
            g = c.execute("SELECT * FROM generation WHERE id=?", (gid,)).fetchone()
            a = c.execute("SELECT * FROM asset WHERE generation_id=?", (gid,)).fetchone()
        self.assertEqual(g["generator"], "comfy")
        self.assertEqual(g["origin"], "local")
        self.assertEqual(g["status"], "done")
        self.assertEqual(g["model"], "comfy")
        self.assertIsNone(g["job_id"])            # HF 삭제검증 대상 아님
        self.assertEqual(g["creator_uid"], "me")
        self.assertEqual(a["type"], "image")
        self.assertEqual(a["file_path"], "/media/comfy/abc123.png")
        self.assertEqual(a["thumbnail_path"], "/media/comfy/abc123.png")  # 없으면 file_path 폴백


    def test_dedup_by_asset_path_scoped_to_creator(self):
        """같은 file_path 는 같은 계정 안에서만 재사용(existed=True)되고 다른 계정은 별도 저장본이다."""
        path = "/media/comfy/dup.png"
        common = dict(worker_id="me", prompt="p", display_prompt=None, params={}, kind="image",
                      file_path=path, thumbnail_path=None)
        gid, existed = self.repo.create_comfy_generation(creator_uid="me", **common)
        self.assertFalse(existed)
        again, existed_again = self.repo.create_comfy_generation(creator_uid="me", **common)
        self.assertTrue(existed_again)
        self.assertEqual(again, gid)
        # 다른 계정 스코프에서는 안 잡힘(계정별 '내 작업' 분리)
        other, existed_other = self.repo.create_comfy_generation(creator_uid="someone_else", **common)
        self.assertFalse(existed_other)
        self.assertNotEqual(other, gid)

    def test_excluded_from_hf_deletion_candidates(self):
        self.repo.create_comfy_generation(
            worker_id="me", creator_uid="me", prompt="p", display_prompt=None,
            params={}, kind="video", file_path="/media/comfy/v.mp4", thumbnail_path=None,
        )
        # gens_with_job_id 는 job_id 있는 것만 → comfy(job_id NULL) 는 안 잡힘
        self.assertEqual(self.repo.gens_with_job_id(), [])

    def test_record_elapsed_seconds(self):
        # '실행 누른→결과' 소요시간을 generation_metrics 에 기록(측정값 직접).
        from app.repo import manage
        gid, _existed = self.repo.create_comfy_generation(
            worker_id="me", creator_uid="me", prompt="p", display_prompt=None,
            params={}, kind="image", file_path="/media/comfy/t.png", thumbnail_path=None,
        )
        manage.record_elapsed(gid, 12.5)
        m = self.repo.get_generation_metrics(gid)
        self.assertIsNotNone(m)
        self.assertAlmostEqual(m["elapsed_seconds"], 12.5, places=2)

    def test_records_lineage_from_source_gen(self):
        with self.db.get_connection() as c:
            c.execute(
                "INSERT INTO generation(id, worker_id, prompt, status, created_at, sort_ts) "
                "VALUES('src', 'me', 'p', 'done', '2026-01-01', 1)"
            )
        gid, _existed = self.repo.create_comfy_generation(
            worker_id="me", creator_uid="me", prompt="p", display_prompt=None,
            params={}, kind="image", file_path="/media/comfy/x.png", thumbnail_path=None,
            references=[{"file_path": "/media/ref.png", "type": "image", "source_gen_id": "src"}],
        )
        with self.db.get_connection() as c:
            edge = c.execute(
                "SELECT relation FROM history WHERE parent_gen_id='src' AND child_gen_id=?", (gid,)
            ).fetchone()
        self.assertEqual(edge["relation"], "reference")


class ComfySaveRouteTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(ignore_cleanup_errors=True)
        self.old_db = os.environ.get("CONTENT_HUB_DB")
        self.old_np = os.environ.get("CONTENT_HUB_NO_PROXY")
        os.environ["CONTENT_HUB_DB"] = os.path.join(self.tmp.name, "content_hub.db")
        os.environ["CONTENT_HUB_NO_PROXY"] = "1"
        from app import db, repo

        db.flush_pool()
        db.init_db()
        repo.ensure_default_worker()
        self.db = db
        from fastapi.testclient import TestClient
        from app.main import app

        self.client = TestClient(app, client=("127.0.0.1", 50000))

    def tearDown(self):
        self.client.close()
        self.db.flush_pool()
        for k, v in (("CONTENT_HUB_DB", self.old_db), ("CONTENT_HUB_NO_PROXY", self.old_np)):
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v
        self.db.flush_pool()
        self.tmp.cleanup()

    def test_save_excludes_text_and_is_idempotent(self):
        body = {
            "name": "nano_image",
            "prompt": "얼음 새우",
            "params": {"seed": 5},
            "outputs": [
                {"url": "/media/comfy/img1.png", "kind": "image"},
                {"url": "/media/comfy/vid1.mp4", "kind": "video"},
                {"url": "", "kind": "text"},  # 텍스트 → 저장 제외
            ],
        }
        r = self.client.post("/api/comfy/save-to-library", json=body)
        self.assertEqual(r.status_code, 200, r.text)
        saved = r.json()["saved"]
        self.assertEqual(len(saved), 2)  # 텍스트 제외, 이미지+영상만
        self.assertTrue(all(not s["existed"] for s in saved))
        # 재저장 → 중복 없이 기존 gen 재사용
        r2 = self.client.post("/api/comfy/save-to-library", json=body)
        saved2 = r2.json()["saved"]
        self.assertTrue(all(s["existed"] for s in saved2))
        self.assertEqual({s["generation_id"] for s in saved},
                         {s["generation_id"] for s in saved2})

    def test_rejects_non_media_url(self):
        # 외부/임의 URL 은 거부(HF 동기화 URL 과 겹쳐 job_id 붙는 불변식 붕괴 방지).
        body = {"outputs": [{"url": "https://evil.example/x.png", "kind": "image"}]}
        r = self.client.post("/api/comfy/save-to-library", json=body)
        self.assertEqual(r.status_code, 400, r.text)

    def test_saved_shows_in_my_library(self):
        body = {"prompt": "새우", "outputs": [{"url": "/media/comfy/lib.png", "kind": "image"}]}
        r = self.client.post("/api/comfy/save-to-library", json=body)
        self.assertEqual(r.status_code, 200, r.text)
        # '내 작업' 목록에 뜨는지(asset 포함)
        lib = self.client.get("/api/generations?tab=my").json()
        items = lib if isinstance(lib, list) else lib.get("items", [])
        hit = [g for g in items if g.get("model") == "comfy"]
        self.assertTrue(hit, "comfy 저장본이 내 작업 목록에 없음")
        self.assertTrue(hit[0]["assets"], "asset 이 비어 그리드에 안 뜸")


if __name__ == "__main__":
    unittest.main()

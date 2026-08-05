"""읽기 라우트 id 해석(ResolvedGen dependency) 특성화 — 로컬 id·서버 job_id 둘 다 같은 행으로 해석.

③ GenerationRef 정규화(routers/generation.py) 안전망: 히스토리/트리/메트릭 GET 이 gen_id 든 서버 job_id 든
같은 로컬 행을 찾고, 없는 id 는 (프록시 off 에서) 404 인지 고정. 팀 탭 카드(서버 job_id)로 열어도 빈 화면
안 나게 하는 resolve_and_get 계약을 라우트 레벨에서 검증.
"""

import os
import tempfile
import unittest


class GenerationReadRouteTests(unittest.TestCase):
    def setUp(self):
        # ignore_cleanup_errors: Windows 에서 DB 풀 커넥션이 tmp 파일을 잠깐 잡고 있어도 tearDown 이 안 깨지게.
        self.tmp = tempfile.TemporaryDirectory(ignore_cleanup_errors=True)
        self.old_db = os.environ.get("CONTENT_HUB_DB")
        self.old_np = os.environ.get("CONTENT_HUB_NO_PROXY")
        os.environ["CONTENT_HUB_DB"] = os.path.join(self.tmp.name, "content_hub.db")
        os.environ["CONTENT_HUB_NO_PROXY"] = "1"  # 격리 — 운영 공유서버에 안 닿게
        from app import db, repo

        db.flush_pool()
        db.init_db()
        repo.ensure_default_worker()
        # 팀 탭 카드처럼 id != job_id 인 동기화 생성물 시드(로컬 id=loc1, 서버 앵커=srv1).
        with db.get_connection() as conn:
            for gid, jid, ts in (("loc1", "srv1", 3), ("par1", "par1", 2), ("mat1", "mat1", 1)):
                conn.execute(
                    "INSERT INTO generation(id, job_id, worker_id, creator_uid, prompt, model, status, created_at, sort_ts) "
                    "VALUES(?,?,'me','me','p','m','done','2026-01-01', ?)",
                    (gid, jid, ts),
                )
            conn.execute(
                "INSERT INTO history(parent_gen_id, child_gen_id, relation) VALUES('mat1','loc1','reference')"
            )
        from fastapi.testclient import TestClient
        from app.main import app

        # AUTH off 모드는 main.py 미들웨어가 loopback(로컬) 요청만 허용 → TestClient client host 를 127.0.0.1 로.
        self.client = TestClient(app, client=("127.0.0.1", 50000))

    def tearDown(self):
        from app import db

        self.client.close()  # TestClient 의 app 커넥션 해제
        db.flush_pool()
        for k, v in (("CONTENT_HUB_DB", self.old_db), ("CONTENT_HUB_NO_PROXY", self.old_np)):
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v
        db.flush_pool()
        self.tmp.cleanup()

    def test_history_tree_by_local_id(self):
        r = self.client.get("/api/generations/loc1/history-tree")
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.json()["focus_id"], "loc1")

    def test_history_tree_by_server_job_id_resolves_same_row(self):
        # ★서버 job_id(srv1)로 열어도 로컬 행(loc1)으로 해석돼 같은 그래프(빈 화면 방지).
        r = self.client.get("/api/generations/srv1/history-tree")
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.json()["focus_id"], "loc1")

    def test_history_by_local_and_server_id_same(self):
        a = self.client.get("/api/generations/loc1/history")
        b = self.client.get("/api/generations/srv1/history")
        self.assertEqual(a.status_code, 200)
        self.assertEqual(b.status_code, 200)
        self.assertEqual(a.json()["target"]["id"], b.json()["target"]["id"])

    def test_metrics_by_local_id(self):
        r = self.client.get("/api/generations/loc1/metrics")
        self.assertEqual(r.status_code, 200)  # 메트릭 없으면 {} 라도 200

    def test_metrics_by_server_job_id_same(self):
        # ★metrics 도 server job_id(srv1)로 열면 local(loc1)과 같은 결과 — ref.local_id 사용 회귀 방지.
        a = self.client.get("/api/generations/loc1/metrics")
        b = self.client.get("/api/generations/srv1/metrics")
        self.assertEqual(b.status_code, 200)
        self.assertEqual(a.json(), b.json())

    def test_missing_id_404_when_not_proxying(self):
        # 프록시 off(NO_PROXY) + 로컬에 없음 → 404(기존 동작 고정).
        r = self.client.get("/api/generations/nope/history-tree")
        self.assertEqual(r.status_code, 404)

    def test_generation_batch_returns_items_materials_and_missing(self):
        r = self.client.post(
            "/api/generations/batch",
            json={"gen_ids": ["loc1", "mat1", "nope", "loc1"]},
        )
        self.assertEqual(r.status_code, 200)
        data = r.json()
        self.assertEqual(set(data["items"]), {"loc1", "mat1"})
        self.assertEqual(data["materials"]["loc1"], ["mat1"])
        self.assertEqual(data["materials"]["mat1"], [])
        self.assertEqual(data["missing"], ["nope"])

    def test_generation_batch_resolves_server_job_id_and_keeps_request_key(self):
        r = self.client.post("/api/generations/batch", json={"gen_ids": ["srv1"]})

        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.json()["items"]["srv1"]["id"], "loc1")
        self.assertEqual(r.json()["materials"]["srv1"], ["mat1"])

    def test_generation_batch_rejects_unbounded_request(self):
        r = self.client.post(
            "/api/generations/batch",
            json={"gen_ids": [f"g{i}" for i in range(501)]},
        )
        self.assertEqual(r.status_code, 413)

    def test_color_write_batch_resolves_ids_and_reports_missing(self):
        from app import repo

        r = self.client.put(
            "/api/generations/colors/batch",
            json={
                "items": [
                    {"id": "srv1", "color": "red"},
                    {"id": "par1", "color": "blue"},
                    {"id": "missing", "color": "green"},
                ]
            },
        )

        self.assertEqual(r.status_code, 200)
        self.assertEqual(
            r.json(),
            {"succeeded": ["srv1", "par1"], "failed": ["missing"]},
        )
        self.assertEqual(repo.get_generation("loc1")["color"], "red")
        self.assertEqual(repo.get_generation("par1")["color"], "blue")

    def test_tag_write_batch_commits_all_local_rows(self):
        from app import repo

        r = self.client.put(
            "/api/generations/tags/batch",
            json={
                "items": [
                    {"id": "srv1", "tags": ["hero"]},
                    {"id": "par1", "tags": ["parent"]},
                ],
                "auto": False,
            },
        )

        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.json()["failed"], [])
        self.assertEqual(repo.get_generation("loc1")["tags"], ["hero"])
        self.assertEqual(repo.get_generation("par1")["tags"], ["parent"])

    # ── write 라우트(add/remove/derive)도 서버 job_id → 로컬 행 해석(ref.local_id) ──
    def test_add_history_via_server_job_id_targets_local_row(self):
        r = self.client.post(
            "/api/generations/srv1/history", json={"parent_gen_id": "par1", "relation": "derived"}
        )
        self.assertEqual(r.status_code, 201)
        # 서버 job_id 로 연결했지만 엣지는 로컬 행(loc1)에 달려야 — loc1 조상에 par1.
        h = self.client.get("/api/generations/loc1/history")
        self.assertIn("par1", [a["id"] for a in h.json()["ancestors"]])

    def test_remove_history_via_server_job_id(self):
        self.client.post(
            "/api/generations/srv1/history", json={"parent_gen_id": "par1", "relation": "derived"}
        )
        r = self.client.delete("/api/generations/srv1/history/par1")
        self.assertEqual(r.status_code, 200)
        h = self.client.get("/api/generations/loc1/history")
        self.assertEqual([a["id"] for a in h.json()["ancestors"]], [])

    def test_derive_from_via_server_job_id(self):
        r = self.client.post("/api/generations/srv1/derive-from", json={"parent_ids": ["par1"]})
        self.assertEqual(r.status_code, 200)
        self.assertIn("par1", [a["id"] for a in r.json()["ancestors"]])


if __name__ == "__main__":
    unittest.main()

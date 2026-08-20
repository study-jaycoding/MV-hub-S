from __future__ import annotations

import os
import tempfile
from pathlib import Path

from fastapi.testclient import TestClient

from app import db, repo
from app.main import app


def test_important_admin_project_budget_and_final_changes_are_audited(monkeypatch):
    with tempfile.TemporaryDirectory() as tmp:
        old = os.environ.get("CONTENT_HUB_DB")
        os.environ["CONTENT_HUB_DB"] = str(Path(tmp) / "content_hub.db")
        db.flush_pool()
        try:
            monkeypatch.setattr(db, "_POOL_ENABLED", False)
            db.init_db()
            repo.ensure_default_worker()
            repo.ensure_admin_account("admin@example.com", "admin-password")
            client = TestClient(app, client=("127.0.0.1", 50000))
            login = client.post(
                "/api/auth/login",
                json={"email": "admin@example.com", "password": "admin-password"},
            )
            assert login.status_code == 200

            repo.register("member@example.com", "password-123", "member")
            response = client.patch(
                "/api/auth/accounts/member@example.com/status", json={"status": "approved"}
            )
            assert response.status_code == 200

            response = client.post("/api/projects", json={"name": "audit-project"})
            assert response.status_code == 200
            project_id = response.json()["id"]

            response = client.put(
                f"/api/manage/planning/{project_id}",
                json={
                    "status": "active",
                    "budget_credits": 5000,
                    "budget_period": "month",
                },
            )
            assert response.status_code == 200

            gen_id = repo.create_local_generation(
                {"model": "test-model", "prompt": "never audit this prompt"}, "me"
            )
            with db.get_connection() as conn:
                conn.execute(
                    "UPDATE generation SET status='done', project_id=? WHERE id=?",
                    (project_id, gen_id),
                )
            response = client.post(
                f"/api/generations/{gen_id}/publish", json={"visibility": "team"}
            )
            assert response.status_code == 200
            # 같은 상태를 다시 요청해도 실제 변경 감사 행을 중복 생성하지 않는다.
            assert client.post(
                f"/api/generations/{gen_id}/publish", json={"visibility": "team"}
            ).status_code == 200
            assert client.post(f"/api/generations/{gen_id}/unpublish").status_code == 200
            assert client.post(f"/api/generations/{gen_id}/unpublish").status_code == 200

            bundle = repo.export_bundle(gen_ids=[gen_id])
            response = client.post("/api/share/publish-bundle", json={"bundle": bundle})
            assert response.status_code == 200

            response = client.post(f"/api/generations/{gen_id}/finalize")
            assert response.status_code == 200

            response = client.get("/api/admin/audit-events", params={"limit": 50})
            assert response.status_code == 200
            rows = response.json()
            actions = {row["action"] for row in rows}
            assert {
                "account.status_changed",
                "project.created",
                "project.planning_changed",
                "generation.published",
                "generation.unpublished",
                "generation.publish_bundle_received",
                "generation.finalized",
            } <= actions
            assert sum(row["action"] == "generation.published" for row in rows) == 1
            assert sum(row["action"] == "generation.unpublished" for row in rows) == 1
            assert "member@example.com" not in response.text
            assert "never audit this prompt" not in response.text
        finally:
            db.flush_pool()
            if old is None:
                os.environ.pop("CONTENT_HUB_DB", None)
            else:
                os.environ["CONTENT_HUB_DB"] = old
            db.flush_pool()

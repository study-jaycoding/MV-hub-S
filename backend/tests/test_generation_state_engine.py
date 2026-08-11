"""유료 생성 요청의 제출·추적·검증·완료 상태 전이 회귀 테스트."""

from __future__ import annotations

import os
import tempfile
from pathlib import Path

from app import db, db_migrations, repo


class TestGenerationStateEngine:
    def setup_method(self):
        self.temp = tempfile.TemporaryDirectory(ignore_cleanup_errors=True)
        self.old_db = os.environ.get("CONTENT_HUB_DB")
        os.environ["CONTENT_HUB_DB"] = str(Path(self.temp.name) / "content_hub.db")
        db.flush_pool()
        db.init_db()
        repo.ensure_default_worker()

    def teardown_method(self):
        db.flush_pool()
        if self.old_db is None:
            os.environ.pop("CONTENT_HUB_DB", None)
        else:
            os.environ["CONTENT_HUB_DB"] = self.old_db
        db.flush_pool()
        self.temp.cleanup()

    def _request(self) -> tuple[str, str]:
        gen_id = repo.create_local_generation(
            {"prompt": "state test", "model": "model", "params": {}},
            "me",
            creator_uid="creator-1",
        )
        rid = repo.create_gen_request(
            "worker@example.com",
            "creator-1",
            gen_id,
            "create",
            {"model": "model", "prompt": "state test", "params": {}},
        )
        return rid, gen_id

    def test_anchor_is_tracking_not_done_and_terminal_requires_asset(self):
        rid, gen_id = self._request()
        claimed = repo.claim_pending_requests(
            "worker@example.com", limit=1, lease_owner="agent-1"
        )
        assert [item["id"] for item in claimed] == [rid]

        assert repo.apply_local_anchor(gen_id, rid, "job-1", verifying=False) is True
        with db.get_connection() as conn:
            request = conn.execute(
                "SELECT status,terminal_at FROM gen_request WHERE id=?", (rid,)
            ).fetchone()
            generation = conn.execute(
                "SELECT status,job_id FROM generation WHERE id=?", (gen_id,)
            ).fetchone()
        assert request["status"] == "tracking"
        assert request["terminal_at"] is None
        assert generation["status"] == "running"
        assert generation["job_id"] == "job-1"

        # 공급자 완료 신호만 있고 에셋이 없으면 완료 CAS가 거부된다.
        assert repo.apply_reconcile(
            gen_id,
            "job-1",
            asset_type="image",
            asset_path=None,
            asset_thumb=None,
            created_at=None,
            sort_ts=None,
            status="done",
            error=None,
            provider_status="completed",
        ) is False
        assert repo.get_gen_request(rid)["status"] == "tracking"

        assert repo.apply_reconcile(
            gen_id,
            "job-1",
            asset_type="image",
            asset_path="https://cdn.example/result.png",
            asset_thumb="https://cdn.example/thumb.jpg",
            created_at=None,
            sort_ts=None,
            status="done",
            error=None,
            provider_status="completed",
        ) is True
        final_request = repo.get_gen_request(rid)
        final_generation = repo.get_generation(gen_id)
        assert final_request["status"] == "done"
        assert final_request["terminal_at"] is not None
        assert final_generation["status"] == "done"
        assert final_generation["assets"][0]["file_path"] == "https://cdn.example/result.png"

    def test_migration_recovers_legacy_done_anchor_to_tracking(self):
        rid, gen_id = self._request()
        with db.get_connection() as conn:
            conn.execute(
                "UPDATE generation SET status='running',job_id='job-old' WHERE id=?", (gen_id,)
            )
            conn.execute("UPDATE gen_request SET status='done' WHERE id=?", (rid,))
            db_migrations._migrate(conn)
            request = conn.execute(
                "SELECT status,terminal_at FROM gen_request WHERE id=?", (rid,)
            ).fetchone()
        assert request["status"] == "tracking"
        assert request["terminal_at"] is None

    def test_tracking_request_is_never_reclaimed_or_timed_out_as_new_submission(self):
        rid, gen_id = self._request()
        assert repo.apply_local_anchor(gen_id, rid, "job-paid", verifying=True) is True
        with db.get_connection() as conn:
            conn.execute(
                "UPDATE gen_request SET updated_at=datetime('now','-2 hours') WHERE id=?", (rid,)
            )

        assert repo.claim_pending_requests("worker@example.com", limit=16) == []
        request = repo.get_gen_request(rid)
        generation = repo.get_generation(gen_id)
        assert request["status"] == "verifying"
        assert generation["status"] == "running"
        assert generation["job_id"] == "job-paid"

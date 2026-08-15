"""유료 생성 요청의 제출·추적·검증·완료 상태 전이 회귀 테스트."""

from __future__ import annotations

import os
import tempfile
from contextlib import contextmanager
from pathlib import Path
from unittest.mock import patch

from app import db, db_migrations, repo
from app.repo import gen_requests as gen_requests_repo


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

    def test_set_status_never_demotes_a_done_generation(self):
        # 주기 동기화가 done 으로 확정한 직후 늦은 reconcile 이 running 으로 되돌리면
        # 사용자가 재생성을 눌러 크레딧을 이중 지출한다 — done 은 절대 안 내려간다.
        _, gen_id = self._request()
        with db.get_connection() as conn:
            conn.execute("UPDATE generation SET status='done' WHERE id=?", (gen_id,))
        repo.set_status(gen_id, "running", "늦은 재조정")
        with db.get_connection() as conn:
            row = conn.execute(
                "SELECT status, error FROM generation WHERE id=?", (gen_id,)
            ).fetchone()
        assert row["status"] == "done"
        assert row["error"] is None

    def test_set_status_still_updates_non_terminal_generations(self):
        # done 보호가 정상 전이(pending→running, failed→running 복구)를 막으면 안 된다.
        _, gen_id = self._request()
        repo.set_status(gen_id, "running", None)
        with db.get_connection() as conn:
            assert (
                conn.execute(
                    "SELECT status FROM generation WHERE id=?", (gen_id,)
                ).fetchone()["status"]
                == "running"
            )
        with db.get_connection() as conn:
            conn.execute("UPDATE generation SET status='failed' WHERE id=?", (gen_id,))
        repo.set_status(gen_id, "running", None)
        with db.get_connection() as conn:
            assert (
                conn.execute(
                    "SELECT status FROM generation WHERE id=?", (gen_id,)
                ).fetchone()["status"]
                == "running"
            )

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

    def test_empty_claim_skips_immediate_write_transaction(self):
        """1초 폴링의 빈 경로는 BEGIN IMMEDIATE 쓰기락을 잡으면 안 된다."""
        statements: list[str] = []

        @contextmanager
        def traced_connection():
            with db.get_connection() as conn:
                conn.set_trace_callback(statements.append)
                try:
                    yield conn
                finally:
                    conn.set_trace_callback(None)

        with patch.object(gen_requests_repo, "get_connection", traced_connection):
            assert repo.claim_pending_requests("worker@example.com", limit=16) == []

        assert any("SELECT 1 FROM gen_request" in statement for statement in statements)
        assert not any("BEGIN IMMEDIATE" in statement for statement in statements)
        assert not any(statement.lstrip().upper().startswith("UPDATE") for statement in statements)

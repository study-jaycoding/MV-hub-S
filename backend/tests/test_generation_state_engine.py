"""유료 생성 요청의 제출·추적·검증·완료 상태 전이 회귀 테스트."""

from __future__ import annotations

import json
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

    def test_staged_claim_requires_same_live_owner_before_submission(self):
        rid, gen_id = self._request()
        claimed = repo.claim_pending_requests(
            "worker@example.com",
            limit=1,
            lease_owner="agent-1",
            submission_stage_capable=True,
        )
        assert claimed[0]["claim_phase"] == "claimed"
        assert repo.get_gen_request(rid)["status"] == "claimed"
        assert repo.get_generation(gen_id)["status"] == "pending"

        assert repo.begin_request_submission(rid, "worker@example.com", "agent-2") is None
        first = repo.begin_request_submission(rid, "worker@example.com", "agent-1")
        assert first == {"gen_id": gen_id, "transitioned": True}
        assert repo.get_gen_request(rid)["status"] == "submitting"
        assert repo.get_generation(gen_id)["status"] == "running"

        # ACK가 유실돼 같은 owner가 재호출해도 다시 시작된 것으로 집계하지 않는다.
        second = repo.begin_request_submission(rid, "worker@example.com", "agent-1")
        assert second == {"gen_id": gen_id, "transitioned": False}

    def test_missing_begin_ack_can_release_server_applied_transition_before_cli(self):
        rid, gen_id = self._request()
        repo.claim_pending_requests(
            "worker@example.com",
            limit=1,
            lease_owner="agent-1",
            submission_stage_capable=True,
        )
        # 서버에는 begin이 반영됐지만 응답을 에이전트가 받지 못한 상황을 재현한다.
        assert repo.begin_request_submission(
            rid, "worker@example.com", "agent-1"
        ) == {"gen_id": gen_id, "transitioned": True}

        assert (
            repo.release_claimed_request(rid, "worker@example.com", "agent-1")
            == gen_id
        )
        assert repo.get_gen_request(rid)["status"] == "pending"
        assert repo.get_generation(gen_id)["status"] == "pending"

        # job_id가 이미 생긴 제출은 같은 owner라도 반환할 수 없다.
        repo.claim_pending_requests(
            "worker@example.com",
            limit=1,
            lease_owner="agent-1",
            submission_stage_capable=True,
        )
        repo.begin_request_submission(rid, "worker@example.com", "agent-1")
        with db.get_connection() as conn:
            conn.execute("UPDATE generation SET job_id='job-paid' WHERE id=?", (gen_id,))
        assert repo.release_claimed_request(rid, "worker@example.com", "agent-1") is None
        assert repo.get_gen_request(rid)["status"] == "submitting"

    def test_expired_pre_submit_claim_is_safe_to_requeue_and_reclaim(self):
        rid, gen_id = self._request()
        repo.claim_pending_requests(
            "worker@example.com",
            limit=1,
            lease_owner="agent-old",
            submission_stage_capable=True,
        )
        with db.get_connection() as conn:
            conn.execute(
                "UPDATE gen_request SET lease_expires_at=datetime('now','-1 minute') "
                "WHERE id=?",
                (rid,),
            )

        transitions = repo.sweep_expired_generation_claims("worker@example.com")
        assert transitions == [
            {
                "id": rid,
                "gen_id": gen_id,
                "from_phase": "claimed",
                "to_phase": "pending",
                "action": "requeued",
            }
        ]
        assert repo.get_gen_request(rid)["status"] == "pending"
        assert repo.get_generation(gen_id)["status"] == "pending"

        reclaimed = repo.claim_pending_requests(
            "worker@example.com",
            limit=1,
            lease_owner="agent-new",
            submission_stage_capable=True,
        )
        assert [item["id"] for item in reclaimed] == [rid]

    def test_expired_post_submit_claim_is_quarantined_never_requeued(self):
        rid, gen_id = self._request()
        repo.claim_pending_requests(
            "worker@example.com",
            limit=1,
            lease_owner="agent-1",
            submission_stage_capable=True,
        )
        assert repo.begin_request_submission(
            rid, "worker@example.com", "agent-1"
        )
        with db.get_connection() as conn:
            conn.execute(
                "UPDATE gen_request SET lease_expires_at=datetime('now','-1 minute') "
                "WHERE id=?",
                (rid,),
            )

        transitions = repo.sweep_expired_generation_claims("worker@example.com")
        assert transitions[0]["to_phase"] == "recovery_required"
        request = repo.get_gen_request(rid)
        generation = repo.get_generation(gen_id)
        assert request["status"] == "recovery_required"
        assert request["terminal_at"] is None
        assert request["lease_owner"] is None
        assert generation["status"] == "running"
        assert "자동 재생성을 차단" in generation["error"]
        assert repo.claim_pending_requests("worker@example.com", limit=16) == []

    def test_unknown_cli_outcome_can_anchor_existing_job_or_explicitly_requeue(self):
        rid, gen_id = self._request()
        repo.claim_pending_requests(
            "worker@example.com",
            limit=1,
            lease_owner="agent-1",
            submission_stage_capable=True,
        )
        repo.begin_request_submission(rid, "worker@example.com", "agent-1")
        assert repo.mark_request_recovery_required(rid, "worker@example.com") == {
            "gen_id": gen_id,
            "transitioned": True,
        }
        # 보고 응답이 유실돼 에이전트가 다시 보내도 상태·이벤트 의미는 한 번만 전이한다.
        assert repo.mark_request_recovery_required(rid, "worker@example.com") == {
            "gen_id": gen_id,
            "transitioned": False,
        }
        assert repo.get_gen_request(rid)["status"] == "recovery_required"
        assert (
            repo.get_recovery_request_id_for_generation(gen_id, "worker@example.com")
            == rid
        )
        assert repo.get_recovery_request_id_for_generation(gen_id, "other@example.com") is None

        # 외부 이력에서 job을 찾은 경우 기존 anchor 경로로 새 생성 없이 추적을 복구한다.
        assert repo.apply_local_anchor(gen_id, rid, "job-found", verifying=True) is True
        assert repo.get_gen_request(rid)["status"] == "verifying"
        assert repo.get_generation(gen_id)["job_id"] == "job-found"

        rid2, gen_id2 = self._request()
        with db.get_connection() as conn:
            conn.execute(
                "UPDATE gen_request SET status='recovery_required' WHERE id=?", (rid2,)
            )
            conn.execute(
                "UPDATE generation SET status='running' WHERE id=?", (gen_id2,)
            )
        # 외부 작업이 없다는 명시 확인 경로만 pending 복귀를 허용한다.
        assert repo.requeue_recovery_request(rid2, "other@example.com") is None
        assert repo.requeue_recovery_request(rid2, "worker@example.com") == gen_id2
        assert repo.get_gen_request(rid2)["status"] == "pending"
        assert repo.get_generation(gen_id2)["status"] == "pending"

    def test_recovery_probe_ledger_holds_multiple_candidates_and_allows_fresh_no_match(self):
        rid, _ = self._request()
        repo.claim_pending_requests(
            "worker@example.com",
            limit=1,
            lease_owner="agent-1",
            submission_stage_capable=True,
        )
        fingerprint = {
            "version": 1,
            "model": "model",
            "prompt_sha256": "a" * 64,
            "params": {},
            "reference_roles": [],
        }
        repo.begin_request_submission(
            rid, "worker@example.com", "agent-1", fingerprint
        )
        repo.mark_request_recovery_required(rid, "worker@example.com")

        probes = repo.list_recovery_probe_requests("worker@example.com")
        assert len(probes) == 1
        assert probes[0]["id"] == rid
        assert probes[0]["fingerprint"] == fingerprint
        assert probes[0]["submission_started_at"]

        assert repo.record_recovery_probe_result(
            rid, "worker@example.com", "multiple", 2
        ) == {"outcome": "multiple", "candidate_count": 2, "job_id": None}
        blocked = repo.prepare_recovery_requeue(rid, "worker@example.com")
        assert blocked["status"] == "candidate_found"
        assert blocked["candidate_count"] == 2
        assert repo.get_gen_request(rid)["status"] == "recovery_required"

        # 뒤의 짧은 최신 목록이 비어도 이전 복수 후보 증거를 지우지 않는다.
        assert repo.record_recovery_probe_result(
            rid, "worker@example.com", "no_match", 0
        ) == {"outcome": "multiple", "candidate_count": 2, "job_id": None}
        assert repo.prepare_recovery_requeue(rid, "worker@example.com")["status"] == (
            "candidate_found"
        )

        # 처음부터 후보가 없다고 확인된 별도 요청만 명시 재큐를 허용한다.
        rid, gen_id = self._request()
        repo.claim_pending_requests(
            "worker@example.com",
            limit=1,
            lease_owner="agent-2",
            submission_stage_capable=True,
        )
        repo.begin_request_submission(
            rid, "worker@example.com", "agent-2", fingerprint
        )
        repo.mark_request_recovery_required(rid, "worker@example.com")
        assert repo.record_recovery_probe_result(
            rid, "worker@example.com", "no_match", 0
        ) == {"outcome": "no_match", "candidate_count": 0, "job_id": None}
        assert repo.prepare_recovery_requeue(rid, "worker@example.com") == {
            "status": "requeued",
            "gen_id": gen_id,
        }
        requeued = repo.get_gen_request(rid)
        assert requeued["status"] == "pending"
        assert requeued["submission_fingerprint"] is None
        assert requeued["submission_started_at"] is None

        # 새 제출의 복구 조사는 과거 시각/지문이 아니라 이번 시도를 기준으로 해야 한다.
        repo.claim_pending_requests(
            "worker@example.com",
            limit=1,
            lease_owner="agent-2",
            submission_stage_capable=True,
        )
        next_fingerprint = {**fingerprint, "prompt_sha256": "b" * 64}
        repo.begin_request_submission(
            rid, "worker@example.com", "agent-2", next_fingerprint
        )
        next_request = repo.get_gen_request(rid)
        assert json.loads(next_request["submission_fingerprint"]) == next_fingerprint
        assert next_request["submission_started_at"]

    def test_unique_probe_job_is_persisted_for_exact_anchor_retry(self):
        rid, gen_id = self._request()
        fingerprint = {
            "version": 1,
            "model": "model",
            "prompt_sha256": "c" * 64,
            "params": {},
            "reference_roles": [],
        }
        repo.claim_pending_requests(
            "worker@example.com",
            limit=1,
            lease_owner="agent-1",
            submission_stage_capable=True,
        )
        repo.begin_request_submission(
            rid, "worker@example.com", "agent-1", fingerprint
        )
        repo.mark_request_recovery_required(rid, "worker@example.com")

        expected = {
            "outcome": "unique",
            "candidate_count": 1,
            "job_id": "job-exact",
        }
        assert repo.record_recovery_probe_result(
            rid, "worker@example.com", "unique", 1, "job-exact"
        ) == expected
        # 뒤의 no_match가 유일 후보 증거와 정확한 job id를 지우지 못한다.
        assert repo.record_recovery_probe_result(
            rid, "worker@example.com", "no_match", 0
        ) == expected
        probes = repo.list_recovery_probe_requests("worker@example.com")
        assert probes[0]["recovery_probe_status"] == "unique"
        assert probes[0]["recovery_probe_job_id"] == "job-exact"
        assert repo.prepare_recovery_requeue(rid, "worker@example.com") == {
            "status": "candidate_found",
            "gen_id": gen_id,
            "candidate_count": 1,
        }

    def test_server_restart_preserves_persistent_queue_and_recovery_hold(self):
        pending_rid, pending_gen = self._request()
        recovery_rid, recovery_gen = self._request()
        with db.get_connection() as conn:
            conn.execute(
                "UPDATE gen_request SET status='recovery_required' WHERE id=?",
                (recovery_rid,),
            )
            conn.execute(
                "UPDATE generation SET status='running' WHERE id=?", (recovery_gen,)
            )
        orphan = repo.create_local_generation(
            {"prompt": "legacy orphan", "model": "model", "params": {}},
            "me",
            creator_uid="creator-1",
        )

        assert repo.fail_orphaned_jobs() == 1
        assert repo.get_generation(pending_gen)["status"] == "pending"
        assert repo.get_gen_request(pending_rid)["status"] == "pending"
        assert repo.get_generation(recovery_gen)["status"] == "running"
        assert repo.get_gen_request(recovery_rid)["status"] == "recovery_required"
        assert repo.get_generation(orphan)["status"] == "failed"

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

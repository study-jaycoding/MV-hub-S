"""혼합 배포에서 도장 능력 없는 에이전트에 유료 생성 claim을 주지 않는 계약."""

from __future__ import annotations

import asyncio
import os
import tempfile
from pathlib import Path
from unittest.mock import AsyncMock, patch

from app import db, repo
from app.models import CanvasManualClaimIn
from app.routers import gen_requests as gen_requests_router


class TestGenRequestCapabilityGate:
    def setup_method(self):
        self.temp = tempfile.TemporaryDirectory(ignore_cleanup_errors=True)
        self.old_db = os.environ.get("CONTENT_HUB_DB")
        os.environ["CONTENT_HUB_DB"] = str(Path(self.temp.name) / "content_hub.db")
        db.flush_pool()
        db.init_db()
        repo.ensure_default_worker()
        gen_requests_router._agent_update_notice_at.clear()
        self.account = {
            "email": "worker@example.com",
            "creator_uid": "creator-1",
        }

    def teardown_method(self):
        gen_requests_router._agent_update_notice_at.clear()
        db.flush_pool()
        if self.old_db is None:
            os.environ.pop("CONTENT_HUB_DB", None)
        else:
            os.environ["CONTENT_HUB_DB"] = self.old_db
        db.flush_pool()
        self.temp.cleanup()

    @staticmethod
    def _request(workspace: dict | None = None) -> tuple[str, str]:
        payload = {"model": "model", "prompt": "gate test", "params": {}}
        if workspace is not None:
            payload["workspace"] = workspace
        gen_id = repo.create_local_generation(
            payload,
            "me",
            creator_uid="creator-1",
            workspace=workspace,
        )
        rid = repo.create_gen_request(
            "worker@example.com",
            "creator-1",
            gen_id,
            "create",
            payload,
        )
        return rid, gen_id

    def test_legacy_agent_cannot_claim_and_request_stays_pending(self):
        rid, gen_id = self._request()
        with patch.object(
            gen_requests_router, "_require_account", return_value=self.account
        ), patch.object(
            gen_requests_router, "realtime_scope", return_value="acct:worker@example.com"
        ), patch.object(
            gen_requests_router.manager, "broadcast", new_callable=AsyncMock
        ) as broadcast, patch.object(
            gen_requests_router, "log_event"
        ) as log_event:
            claimed = asyncio.run(
                gen_requests_router.pending_gen_requests(
                    object(), capability="", agent_id=None
                )
            )

        assert claimed == []
        assert repo.get_gen_request(rid)["status"] == "pending"
        assert repo.get_generation(gen_id)["status"] == "pending"
        broadcast.assert_awaited_once_with(
            {
                "type": "flash",
                "message": gen_requests_router._AGENT_UPDATE_REQUIRED_MESSAGE,
            },
            account_uid="acct:worker@example.com",
        )
        log_event.assert_called_once()

    def test_submission_stage_agent_with_id_claims_normally(self):
        rid, gen_id = self._request()
        with patch.object(
            gen_requests_router, "_require_account", return_value=self.account
        ), patch.object(
            gen_requests_router, "realtime_scope", return_value="acct:worker@example.com"
        ), patch.object(
            gen_requests_router.manager, "broadcast", new_callable=AsyncMock
        ), patch.object(gen_requests_router, "schedule_telemetry_drain"):
            claimed = asyncio.run(
                gen_requests_router.pending_gen_requests(
                    object(),
                    capability="workspace,submission-stage",
                    agent_id="agent-1",
                )
            )

        assert [item["id"] for item in claimed] == [rid]
        assert claimed[0]["claim_phase"] == "claimed"
        request = repo.get_gen_request(rid)
        assert request["status"] == "claimed"
        assert request["lease_owner"] == "agent-1"
        # begin-submission 전에는 placeholder를 running으로 올리지 않는다.
        assert repo.get_generation(gen_id)["status"] == "pending"

    def test_submission_stage_without_agent_id_is_rejected(self):
        rid, _ = self._request()
        with patch.object(
            gen_requests_router, "_require_account", return_value=self.account
        ), patch.object(
            gen_requests_router, "realtime_scope", return_value="acct:worker@example.com"
        ), patch.object(
            gen_requests_router.manager, "broadcast", new_callable=AsyncMock
        ):
            claimed = asyncio.run(
                gen_requests_router.pending_gen_requests(
                    object(),
                    capability="workspace,submission-stage",
                    agent_id=None,
                )
            )

        assert claimed == []
        assert repo.get_gen_request(rid)["status"] == "pending"

    def test_submission_gate_does_not_bypass_existing_workspace_gate(self):
        rid, _ = self._request(
            {"scope": "team", "id": "workspace-1", "name": "Team"}
        )
        with patch.object(
            gen_requests_router, "_require_account", return_value=self.account
        ), patch.object(
            gen_requests_router, "realtime_scope", return_value="acct:worker@example.com"
        ), patch.object(
            gen_requests_router.manager, "broadcast", new_callable=AsyncMock
        ) as broadcast:
            claimed = asyncio.run(
                gen_requests_router.pending_gen_requests(
                    object(),
                    capability="submission-stage",
                    agent_id="agent-1",
                )
            )

        assert claimed == []
        assert repo.get_gen_request(rid)["status"] == "pending"
        broadcast.assert_not_awaited()

    def test_pending_exists_notifies_once_within_throttle_window(self):
        rid, _ = self._request()
        with patch.object(
            gen_requests_router, "_require_account", return_value=self.account
        ), patch.object(
            gen_requests_router, "realtime_scope", return_value="acct:worker@example.com"
        ), patch.object(
            gen_requests_router.manager, "broadcast", new_callable=AsyncMock
        ) as broadcast, patch.object(
            gen_requests_router, "log_event"
        ) as log_event:
            first = asyncio.run(
                gen_requests_router.pending_gen_requests_exist(
                    object(), capability="", agent_id=None
                )
            )
            second = asyncio.run(
                gen_requests_router.pending_gen_requests_exist(
                    object(), capability="", agent_id=None
                )
            )

        assert first == {"pending": False}
        assert second == {"pending": False}
        assert repo.get_gen_request(rid)["status"] == "pending"
        assert broadcast.await_count == 1
        log_event.assert_called_once()
        assert log_event.call_args.args[1] == "generation_claim_capability_blocked"
        fields = log_event.call_args.kwargs
        assert fields["route"] == "pending-exists"
        assert fields["submission_stage_declared"] is False
        assert fields["agent_id_present"] is False
        assert "email" not in fields

    def test_canvas_candidate_claim_only_links_existing_generation(self):
        body = CanvasManualClaimIn(
            generation_id="generation-1",
            scene_id="scene-1",
            card_id="card-1",
        )
        with patch.object(
            gen_requests_router, "AUTH_ENABLED", False
        ), patch.object(
            gen_requests_router, "_require_account", return_value=self.account
        ), patch.object(
            gen_requests_router, "actor_id", return_value="creator-1"
        ), patch.object(
            gen_requests_router.repo,
            "claim_canvas_generation_candidate",
            return_value=True,
        ) as link_existing, patch.object(
            gen_requests_router, "_paid_claim_blocked", new_callable=AsyncMock
        ) as paid_gate:
            result = gen_requests_router.claim_canvas_generation_candidate(body, object())

        assert result == {"ok": True}
        link_existing.assert_called_once_with(
            "worker@example.com",
            "generation-1",
            "scene-1",
            "card-1",
            owner_uid="creator-1",
            creator_uid="creator-1",
        )
        # 이 API는 완료된 생성물의 카드 소속만 기록하며 외부 생성 claim 경로가 아니다.
        paid_gate.assert_not_awaited()

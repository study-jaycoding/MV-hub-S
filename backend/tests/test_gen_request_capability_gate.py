"""혼합 배포에서 도장 능력 없는 에이전트에 유료 생성 claim을 주지 않는 계약."""

from __future__ import annotations

import asyncio
import json
import os
import tempfile
from pathlib import Path
from unittest.mock import AsyncMock, patch

import pytest
from fastapi import HTTPException

from app import db, repo
from app.models import CanvasManualClaimIn
from app.routers import gen_requests as gen_requests_router


_MISSING_REFERENCES = object()


class TestGenRequestCapabilityGate:
    @pytest.mark.parametrize("model", ["seed_audio", "elevenlabs_v4", "elevenlabs_v4_turbo", "qwen_audio_tts"])
    @pytest.mark.parametrize("marked", [False, True])
    def test_audio_models_gate_list_claim_and_begin(self, model, marked):
        payload = {"model": model, "prompt": "test", "params": {}}
        if marked:
            payload["media_protocol"] = "audio-models-v1"
        gen_id = repo.create_local_generation(payload, "me", creator_uid="creator-1")
        rid = repo.create_gen_request("worker@example.com", "creator-1", gen_id, "create", payload)
        old_caps = "workspace,submission-stage,asset-content,media-v2"
        with patch.object(gen_requests_router, "_require_account", return_value=self.account), patch.object(
            gen_requests_router, "realtime_scope", return_value="acct:worker@example.com"
        ), patch.object(gen_requests_router, "schedule_telemetry_drain"), patch.object(
            gen_requests_router.manager, "broadcast", new_callable=AsyncMock
        ):
            assert asyncio.run(gen_requests_router.pending_gen_requests_exist(object(), capability=old_caps, agent_id="old")) == {"pending": False}
            assert asyncio.run(gen_requests_router.pending_gen_requests(object(), capability=old_caps, agent_id="old")) == []
            with pytest.raises(HTTPException) as error:
                asyncio.run(gen_requests_router.begin_gen_request_submission(rid, object(), agent_id="old", capability=old_caps))
            assert error.value.status_code == 409
            assert repo.get_gen_request(rid)["status"] == "pending"
            new_caps = old_caps + ",audio-models-v1"
            assert asyncio.run(gen_requests_router.pending_gen_requests_exist(object(), capability=new_caps, agent_id="new")) == {"pending": True}
            claimed = asyncio.run(gen_requests_router.pending_gen_requests(object(), capability=new_caps, agent_id="new"))
            assert [item["id"] for item in claimed] == [rid]
            assert asyncio.run(gen_requests_router.begin_gen_request_submission(rid, object(), agent_id="new", capability=new_caps))["applied"] is True

    @pytest.mark.parametrize("model", ["voice_change", "dubbing"])
    @pytest.mark.parametrize("marked", [False, True])
    def test_video_voice_gate_list_claim_and_begin(self, model, marked):
        # 2-A 오디오 표시는 있어도 2-B 표시가 없는 에이전트는 못 받는다 — 기존 선언은 유지하고 새 표시를 더한다.
        payload = {"model": model, "prompt": "", "params": {}}
        if marked:
            payload["media_protocol"] = "video-voice-v1"
        gen_id = repo.create_local_generation(payload, "me", creator_uid="creator-1")
        rid = repo.create_gen_request("worker@example.com", "creator-1", gen_id, "create", payload)
        old_caps = "workspace,submission-stage,asset-content,media-v2,audio-models-v1"
        with patch.object(gen_requests_router, "_require_account", return_value=self.account), patch.object(
            gen_requests_router, "realtime_scope", return_value="acct:worker@example.com"
        ), patch.object(gen_requests_router, "schedule_telemetry_drain"), patch.object(
            gen_requests_router.manager, "broadcast", new_callable=AsyncMock
        ):
            assert asyncio.run(gen_requests_router.pending_gen_requests_exist(object(), capability=old_caps, agent_id="old")) == {"pending": False}
            assert asyncio.run(gen_requests_router.pending_gen_requests(object(), capability=old_caps, agent_id="old")) == []
            with pytest.raises(HTTPException) as error:
                asyncio.run(gen_requests_router.begin_gen_request_submission(rid, object(), agent_id="old", capability=old_caps))
            assert error.value.status_code == 409
            assert repo.get_gen_request(rid)["status"] == "pending"
            new_caps = old_caps + ",video-voice-v1"
            assert asyncio.run(gen_requests_router.pending_gen_requests_exist(object(), capability=new_caps, agent_id="new")) == {"pending": True}
            claimed = asyncio.run(gen_requests_router.pending_gen_requests(object(), capability=new_caps, agent_id="new"))
            assert [item["id"] for item in claimed] == [rid]
            assert asyncio.run(gen_requests_router.begin_gen_request_submission(rid, object(), agent_id="new", capability=new_caps))["applied"] is True

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
    def _request(workspace: dict | None = None, *, asset_content_protocol: int | None = None,
                 references=_MISSING_REFERENCES) -> tuple[str, str]:
        payload = {"model": "model", "prompt": "gate test", "params": {}}
        if references is not _MISSING_REFERENCES:
            payload["references"] = references
        if workspace is not None:
            payload["workspace"] = workspace
        if asset_content_protocol is not None:
            payload["asset_content_protocol"] = asset_content_protocol
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

    def test_old_asset_agent_sees_only_legacy_work_and_new_protocol_stays_pending(self):
        new_id, new_gen = self._request(asset_content_protocol=1, references=[{"file_path": "input.png", "type": "image", "role": "@Image1"}])
        with patch.object(gen_requests_router, "_require_account", return_value=self.account), patch.object(
            gen_requests_router, "realtime_scope", return_value="acct:worker@example.com"
        ), patch.object(gen_requests_router.manager, "broadcast", new_callable=AsyncMock) as broadcast, patch.object(
            gen_requests_router, "schedule_telemetry_drain"
        ):
            before = asyncio.run(gen_requests_router.pending_gen_requests_exist(
                object(), capability="workspace,submission-stage", agent_id="old-agent"))
            assert before == {"pending": False}
            assert asyncio.run(gen_requests_router.pending_gen_requests(
                object(), capability="workspace,submission-stage", agent_id="old-agent")) == []
            legacy_id, _ = self._request()
            assert asyncio.run(gen_requests_router.pending_gen_requests_exist(
                object(), capability="workspace,submission-stage", agent_id="old-agent")) == {"pending": True}
            claimed = asyncio.run(gen_requests_router.pending_gen_requests(
                object(), limit=1, capability="workspace,submission-stage", agent_id="old-agent"))
        assert [item["id"] for item in claimed] == [legacy_id]
        assert repo.get_gen_request(new_id)["status"] == "pending"
        assert repo.get_generation(new_gen)["status"] == "pending"
        # 선택적 새 프로토콜 필터는 기존 global paid-cap 안내 정책을 바꾸지 않는다.
        assert all(call.args[0]["type"] != "flash" for call in broadcast.await_args_list)

    def test_asset_content_agent_can_wake_and_claim_new_protocol(self):
        request_id, _ = self._request(asset_content_protocol=1)
        with patch.object(gen_requests_router, "_require_account", return_value=self.account), patch.object(
            gen_requests_router, "realtime_scope", return_value="acct:worker@example.com"
        ), patch.object(gen_requests_router.manager, "broadcast", new_callable=AsyncMock), patch.object(
            gen_requests_router, "schedule_telemetry_drain"
        ):
            assert asyncio.run(gen_requests_router.pending_gen_requests_exist(
                object(), capability="workspace,submission-stage,asset-content", agent_id="new-agent")) == {"pending": True}
            claimed = asyncio.run(gen_requests_router.pending_gen_requests(
                object(), capability="workspace,submission-stage,asset-content", agent_id="new-agent"))
        assert [item["id"] for item in claimed] == [request_id]
        assert claimed[0]["asset_content_protocol"] == 1
        assert repo.get_gen_request(request_id)["status"] == "claimed"

    def test_asset_content_sql_filter_does_not_starve_legacy_after_many_new_requests(self):
        new_ids = [self._request(asset_content_protocol=1, references=[{"file_path": "input.png", "type": "image", "role": "@Image1"}])[0] for _ in range(20)]
        legacy_id, _ = self._request()
        claimed = repo.claim_pending_requests(self.account["email"], limit=1, workspace_capable=True,
                                              asset_content_capable=False, lease_owner="old-agent", submission_stage_capable=True)
        assert [item["id"] for item in claimed] == [legacy_id]
        assert all(repo.get_gen_request(request_id)["status"] == "pending" for request_id in new_ids)
        # 직접 DB 호출은 현행 호환 기본값(True)을 유지한다. HTTP는 항상 별도 광고값을 넘긴다.
        assert len(repo.claim_pending_requests(self.account["email"], limit=1, workspace_capable=True)) == 1

    @pytest.mark.parametrize("references", [_MISSING_REFERENCES, []], ids=["missing", "empty-array"])
    def test_old_asset_agent_claims_stored_reference_free_protocol_without_rewriting_payload(self, references):
        rid, gen_id = self._request({"scope": "personal"}, asset_content_protocol=1, references=references)
        before = repo.get_gen_request(rid)["payload"]
        with patch.object(gen_requests_router, "_require_account", return_value=self.account), patch.object(
            gen_requests_router, "realtime_scope", return_value="acct:worker@example.com"
        ), patch.object(gen_requests_router.manager, "broadcast", new_callable=AsyncMock), patch.object(
            gen_requests_router, "schedule_telemetry_drain"
        ):
            assert asyncio.run(gen_requests_router.pending_gen_requests_exist(
                object(), capability="workspace,submission-stage", agent_id="old-agent")) == {"pending": True}
            claimed = asyncio.run(gen_requests_router.pending_gen_requests(
                object(), capability="workspace,submission-stage", agent_id="old-agent"))
        assert [item["id"] for item in claimed] == [rid]
        assert claimed[0]["references"] == [] and claimed[0]["asset_content_protocol"] == 1
        saved = repo.get_gen_request(rid)
        assert saved["status"] == "claimed" and saved["lease_owner"] == "old-agent"
        assert saved["payload"] == before
        assert repo.get_generation(gen_id)["status"] == "pending"

    @pytest.mark.parametrize("references", [None, {}, "[]", 0, False, [None], [{}], ["input.png"]])
    def test_old_asset_agent_does_not_claim_uncertain_reference_payload(self, references):
        # Corrupt only the stored queue payload, after creating a valid placeholder.
        rid, gen_id = self._request(asset_content_protocol=1)
        payload = json.loads(repo.get_gen_request(rid)["payload"])
        payload["references"] = references
        with db.get_connection() as conn:
            conn.execute("UPDATE gen_request SET payload=? WHERE id=?", (json.dumps(payload), rid))
        before = repo.get_gen_request(rid)
        with patch.object(gen_requests_router, "_require_account", return_value=self.account), patch.object(
            gen_requests_router, "realtime_scope", return_value="acct:worker@example.com"
        ), patch.object(gen_requests_router.manager, "broadcast", new_callable=AsyncMock):
            assert asyncio.run(gen_requests_router.pending_gen_requests_exist(
                object(), capability="workspace,submission-stage", agent_id="old-agent")) == {"pending": False}
            assert asyncio.run(gen_requests_router.pending_gen_requests(
                object(), capability="workspace,submission-stage", agent_id="old-agent")) == []
        assert repo.get_gen_request(rid) == before
        assert repo.get_generation(gen_id)["status"] == "pending"

    @pytest.mark.parametrize("references", [_MISSING_REFERENCES, []], ids=["missing", "empty-array"])
    def test_old_asset_agent_does_not_starve_reference_free_protocol_after_reference_queue(self, references):
        blocked = [self._request(asset_content_protocol=1, references=[{"file_path": "input.png"}])[0]
                   for _ in range(20)]
        rid, _ = self._request(asset_content_protocol=1, references=references)
        assert repo.has_pending_requests(self.account["email"], workspace_capable=True, asset_content_capable=False)
        claimed = repo.claim_pending_requests(self.account["email"], limit=1, workspace_capable=True,
            asset_content_capable=False, lease_owner="old-agent", submission_stage_capable=True)
        assert [item["id"] for item in claimed] == [rid]
        assert all(repo.get_gen_request(item)["status"] == "pending" for item in blocked)
        assert not repo.has_pending_requests(self.account["email"], workspace_capable=True, asset_content_capable=False)

    @pytest.mark.parametrize("creation", ["new", "orphan-repair"])
    def test_reference_free_new_and_repaired_requests_remain_protocol_and_old_agent_eligible(self, creation):
        from app.usecases.gen_requests import GenRequestCommand, repair_canvas_generation_links, submit_gen_request

        if creation == "new":
            command = GenRequestCommand(kind="create", email=self.account["email"], creator_uid="creator-1",
                worker_id="me", source_gen_id=None, workspace={"scope": "personal"},
                data={"model": "model", "prompt": "gate test", "references": []})
            with patch("app.usecases.gen_requests.MANAGE_ENABLED", False), patch(
                "app.usecases.gen_requests.journal_generation_event"
            ):
                generation = asyncio.run(submit_gen_request(command))
            gen_id = generation["id"]
        else:
            link = {"attempt_id": "attempt_empty_refs_1", "generation_id": "generation_empty_refs_1",
                    "scene_id": "scene-empty", "card_id": "card-empty"}
            gen_id = link["generation_id"]
            repo.create_local_generation({"model": "model", "prompt": "gate test"}, "me",
                creator_uid="creator-1", workspace={"scope": "personal"}, generation_id=gen_id)
            repair_canvas_generation_links(self.account["email"], "creator-1", [link])
        assert repo.has_pending_requests(self.account["email"], workspace_capable=True, asset_content_capable=False)
        claimed = repo.claim_pending_requests(self.account["email"], workspace_capable=True,
            asset_content_capable=False, lease_owner="old-agent", submission_stage_capable=True)
        assert len(claimed) == 1 and claimed[0]["gen_id"] == gen_id
        assert claimed[0]["references"] == [] and claimed[0]["asset_content_protocol"] == 1
        saved = repo.get_gen_request(claimed[0]["id"])
        assert json.loads(saved["payload"])["asset_content_protocol"] == 1
        assert saved["status"] == "claimed" and repo.get_generation(gen_id)["status"] == "pending"

    @pytest.mark.parametrize("model,protocol,capable", [
        ("dubbing", "video-voice-v1", "video_voice_v1_capable"),
        ("seed_audio", "audio-models-v1", "audio_models_v1_capable"),
        ("text2speech_v2", "media-v2", "media_v2_capable"),
    ])
    def test_orphan_repair_requeues_with_model_capability_marker(self, model, protocol, capable):
        # placeholder 저장 뒤 큐 활성화 전에 죽은 요청을 되살릴 때도 모델의 작업자 기능 표식을 싣는다 — 빠지면 그 기능을 가진
        #  최신 작업자가 가져가서도 '계약을 확인할 수 없습니다'로 실패시킨다(agent_push, Codex B-3). 옛 작업자는 종전대로 못 받는다.
        from app.usecases.gen_requests import repair_canvas_generation_links

        link = {"attempt_id": f"attempt_{model}", "generation_id": f"generation_{model}",
                "scene_id": "scene-protocol", "card_id": "card-protocol"}
        repo.create_local_generation({"model": model, "prompt": "gate test"}, "me",
            creator_uid="creator-1", workspace={"scope": "personal"}, generation_id=link["generation_id"])
        repair_canvas_generation_links(self.account["email"], "creator-1", [link])
        assert not repo.has_pending_requests(self.account["email"], workspace_capable=True)
        claimed = repo.claim_pending_requests(self.account["email"], workspace_capable=True, lease_owner="new-agent",
            submission_stage_capable=True, **{capable: True})
        assert len(claimed) == 1 and claimed[0]["gen_id"] == link["generation_id"]
        assert claimed[0]["media_protocol"] == protocol

    def test_asset_content_filter_preserves_previous_malformed_payload_behavior(self):
        request_id, _ = self._request()
        with db.get_connection() as conn:
            conn.execute("UPDATE gen_request SET payload='not-json' WHERE id=?", (request_id,))
        assert repo.has_pending_requests(self.account["email"], workspace_capable=True, asset_content_capable=False)
        claimed = repo.claim_pending_requests(self.account["email"], workspace_capable=True, asset_content_capable=False)
        assert [item["id"] for item in claimed] == [request_id]

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

    def test_update_checking_hides_pending_work_without_claiming_it(self):
        rid, _ = self._request()
        with patch.object(
            gen_requests_router, "_require_account", return_value=self.account
        ), patch.object(
            gen_requests_router, "update_in_progress", return_value=True
        ), patch.object(
            gen_requests_router, "_require_generation_deployment_open", new_callable=AsyncMock
        ) as deployment_gate:
            exists = asyncio.run(
                gen_requests_router.pending_gen_requests_exist(
                    object(), capability="workspace,submission-stage", agent_id="agent-1"
                )
            )
            claimed = asyncio.run(
                gen_requests_router.pending_gen_requests(
                    object(), capability="workspace,submission-stage", agent_id="agent-1"
                )
            )

        assert exists == {"pending": False}
        assert claimed == []
        assert repo.get_gen_request(rid)["status"] == "pending"
        deployment_gate.assert_not_awaited()

    def test_begin_submission_records_phase_before_update_gate_then_releases_claim(self):
        rid, gen_id = self._request()
        claimed = repo.claim_pending_requests(
            self.account["email"],
            workspace_capable=True,
            lease_owner="agent-1",
            submission_stage_capable=True,
        )
        assert [item["id"] for item in claimed] == [rid]

        def update_gate() -> bool:
            assert repo.get_gen_request(rid)["status"] == "submitting"
            assert repo.get_generation(gen_id)["status"] == "running"
            return True

        with patch.object(
            gen_requests_router, "_require_account", return_value=self.account
        ), patch.object(
            gen_requests_router, "realtime_scope", return_value="acct:worker@example.com"
        ), patch.object(
            gen_requests_router, "update_in_progress", side_effect=update_gate
        ), patch.object(
            gen_requests_router.manager, "broadcast", new_callable=AsyncMock
        ):
            with pytest.raises(HTTPException) as exc:
                asyncio.run(
                    gen_requests_router.begin_gen_request_submission(
                        rid, object(), agent_id="agent-1"
                    )
                )

        assert exc.value.status_code == 409
        assert "업데이트" in str(exc.value.detail)
        assert repo.get_gen_request(rid)["status"] == "pending"
        assert repo.get_generation(gen_id)["status"] == "pending"

    def test_orphan_pending_request_is_never_claimed(self):
        rid, gen_id = self._request()
        with db.get_connection() as conn:
            conn.execute("DELETE FROM generation WHERE id=?", (gen_id,))

        assert repo.has_pending_requests(self.account["email"], workspace_capable=True) is False
        assert repo.claim_pending_requests(
            self.account["email"],
            workspace_capable=True,
            lease_owner="agent-1",
            submission_stage_capable=True,
        ) == []
        assert repo.get_gen_request(rid)["status"] == "pending"

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


@pytest.mark.parametrize("raw_body, reason", [
    (b'', None), (b'null', None), (b'{}', None), (b'""', None),
    (b'{"reason": ""}', ""), (b'{"reason": null}', None),
    (b'{"reason":', None), (b'\xff', None), (b'[]', None),
    (b'{"reason": "Invalid media UUID"}', "Invalid media UUID"),
])
@pytest.mark.parametrize("applied", [True, False])
def test_recovery_route_optional_body_preserves_response_and_conflict(raw_body, reason, applied):
    from starlette.requests import Request

    async def receive():
        return {"type": "http.request", "body": raw_body, "more_body": False}

    request = Request({"type": "http", "method": "POST", "path": "/"}, receive)
    with patch.object(gen_requests_router, "_require_account", return_value={"email": "worker@example.com"}), patch.object(
        gen_requests_router, "realtime_scope", return_value="acct:worker@example.com"
    ), patch.object(gen_requests_router.agent_signals, "touch"), patch.object(
        gen_requests_router, "require_submission_recovery", new_callable=AsyncMock, return_value=applied
    ) as recover:
        if applied:
            assert asyncio.run(gen_requests_router.mark_gen_request_recovery_required("r1", request)) == {
                "ok": True, "applied": True,
            }
        else:
            with pytest.raises(HTTPException) as exc:
                asyncio.run(gen_requests_router.mark_gen_request_recovery_required("r1", request))
            assert exc.value.status_code == 409
            assert exc.value.detail == "복구 보류로 전환할 수 없는 요청 상태입니다"
    recover.assert_awaited_once_with("worker@example.com", "acct:worker@example.com", "r1", reason=reason)

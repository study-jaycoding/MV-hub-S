"""P6 usecase 추출 회귀 테스트 — create_gen_request 오케스트레이션(submit_gen_request)의
부수효과 순서·분기를 고정한다. 라우터에서 옮긴 흐름이 동작 그대로인지 지킨다."""

import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.models import RegenerateIn
from app.usecases import gen_requests as gen_request_usecases
from app.usecases.gen_requests import (
    GenRequestCommand,
    anchor_request,
    claim_gen_requests,
    fail_request,
    fulfill_request,
    reconcile_request,
    pm_best_effort,
    submit_gen_request,
)


@pytest.fixture(autouse=True)
def generation_journal(monkeypatch):
    """순수 오케스트레이션 단위 테스트가 실제 사용자 DB에 관측 기록을 쓰지 않게 격리한다."""
    mocked = MagicMock(return_value=True)
    monkeypatch.setattr(
        "app.usecases.gen_requests.journal_generation_event", mocked
    )
    return mocked


def _names(parent):
    """attach 된 자식 mock 들의 전역 호출 순서를 'repo.create_local_generation' 형태 이름 리스트로."""
    return [c[0] for c in parent.mock_calls if c[0]]


def test_create_path_calls_in_order_and_returns_gen(generation_journal):
    with patch("app.usecases.gen_requests.repo") as repo, patch(
        "app.usecases.gen_requests.agent_signals"
    ) as sig, patch("app.usecases.gen_requests.MANAGE_ENABLED", False):
        repo.create_local_generation.return_value = "gen1"
        repo.gen_recipe.return_value = {"model": "m", "params": {}, "prompt": "p"}
        repo.get_generation.return_value = {"id": "gen1"}
        parent = MagicMock()
        parent.attach_mock(repo, "repo")
        parent.attach_mock(sig, "sig")

        cmd = GenRequestCommand(
            kind="create", email="a@b.com", creator_uid="u", worker_id="w",
            source_gen_id=None, data={"x": 1},
        )
        out = asyncio.run(submit_gen_request(cmd))

        assert out == {"id": "gen1"}
        seq = [n for n in _names(parent) if n in (
            "repo.create_local_generation", "repo.gen_recipe",
            "repo.create_gen_request", "sig.signal", "repo.get_generation",
        )]
        assert seq == [
            "repo.create_local_generation", "repo.gen_recipe",
            "repo.create_gen_request", "sig.signal", "repo.get_generation",
        ]
        # create 분기에선 import/재생성 tweak 을 절대 부르지 않는다.
        repo.import_generation.assert_not_called()
        repo.set_color.assert_not_called()
        # payload 에 source_gen_id 를 주입해 create_gen_request 로 넘긴다.
        args = repo.create_gen_request.call_args.args
        assert args[0] == "a@b.com" and args[1] == "u" and args[2] == "gen1" and args[3] == "create"
        assert args[4]["source_gen_id"] is None
        generation_journal.assert_called_once_with(
            "generation_requested",
            "gen1",
            request_id=repo.create_gen_request.return_value,
            to_phase="pending",
            actor_uid="u",
        )


def test_regenerate_path_applies_tweaks_only_when_set():
    with patch("app.usecases.gen_requests.repo") as repo, patch(
        "app.usecases.gen_requests.agent_signals"
    ), patch("app.usecases.gen_requests.MANAGE_ENABLED", False):
        repo.import_generation.return_value = "gen2"
        repo.gen_recipe.return_value = {"model": "m", "params": {}, "prompt": "p"}
        repo.get_generation.return_value = {"id": "gen2"}

        cmd = GenRequestCommand(
            kind="regenerate", email="a@b.com", creator_uid="u", worker_id="w",
            source_gen_id="src", regenerate=RegenerateIn(color="#fff", prompt="pp"),
        )
        out = asyncio.run(submit_gen_request(cmd))

        assert out == {"id": "gen2"}
        repo.import_generation.assert_called_once_with("src", "w", creator_uid="u")
        repo.set_color.assert_called_once_with("gen2", "#fff")  # color 설정됨
        repo.override_prompt_model.assert_called_once()  # prompt 설정됨
        repo.add_auto_tags.assert_not_called()  # auto_tags 없음 → 미호출
        repo.create_local_generation.assert_not_called()


def test_pm_branch_records_pending_then_refreshes_estimate_when_manage_on():
    # MANAGE on + CLI 있음 → pending 즉시 기록 후 견적 결과로 한 번 갱신한다.
    with patch("app.usecases.gen_requests.repo") as repo, patch(
        "app.usecases.gen_requests.agent_signals"
    ), patch("app.usecases.gen_requests.cli_bridge") as cli, patch(
        "app.usecases.gen_requests.pm_best_effort"
    ) as pm, patch("app.usecases.gen_requests.MANAGE_ENABLED", True):
        repo.create_local_generation.return_value = "gen1"
        repo.gen_recipe.return_value = {"model": "m", "params": {}, "prompt": "p"}
        repo.get_generation.return_value = {"id": "gen1"}
        cli.cli_available.return_value = True
        cli.estimate_cost = AsyncMock(return_value={"credits": 5})

        cmd = GenRequestCommand(
            kind="create", email="a@b.com", creator_uid="u", worker_id="w",
            source_gen_id=None, data={},
        )

        async def submit_and_wait_for_estimate():
            before = set(gen_request_usecases._estimate_tasks)
            result = await submit_gen_request(cmd)
            scheduled = set(gen_request_usecases._estimate_tasks) - before
            if scheduled:
                await asyncio.gather(*scheduled)
            return result

        asyncio.run(submit_and_wait_for_estimate())

        cli.estimate_cost.assert_awaited_once()
        assert pm.call_count == 2
        assert [call.kwargs["operation"] for call in pm.call_args_list] == [
            "record_request",
            "record_request_estimate",
        ]
        assert all(call.kwargs["dirty_gen_id"] == "gen1" for call in pm.call_args_list)

    # MANAGE off → 견적·PM 완전 스킵.
    with patch("app.usecases.gen_requests.repo") as repo, patch(
        "app.usecases.gen_requests.agent_signals"
    ), patch("app.usecases.gen_requests.cli_bridge") as cli, patch(
        "app.usecases.gen_requests.pm_best_effort"
    ) as pm, patch("app.usecases.gen_requests.MANAGE_ENABLED", False):
        repo.create_local_generation.return_value = "gen1"
        repo.gen_recipe.return_value = {"model": "m", "params": {}, "prompt": "p"}
        repo.get_generation.return_value = {"id": "gen1"}
        cli.estimate_cost = AsyncMock(return_value={"credits": 5})

        cmd = GenRequestCommand(
            kind="create", email="a@b.com", creator_uid="u", worker_id="w",
            source_gen_id=None, data={},
        )
        asyncio.run(submit_gen_request(cmd))

        cli.estimate_cost.assert_not_awaited()
        pm.assert_not_called()


def test_pm_best_effort_marks_generation_dirty_only_after_metric_write():
    order = []
    with patch("app.usecases.gen_requests.MANAGE_ENABLED", True), patch(
        "app.repo.manage.mark_telemetry_dirty",
        side_effect=lambda ids: order.append(("dirty", ids)),
    ):
        pm_best_effort(
            lambda _manage: order.append(("metric", "g1")),
            operation="record_started",
            dirty_gen_id="g1",
        )

    assert order == [("metric", "g1"), ("dirty", ["g1"])]


def test_claim_requests_updates_each_placeholder_and_broadcasts_in_scope():
    claimed = [{"id": "r1", "gen_id": "g1"}, {"id": "r2", "gen_id": "g2"}]
    with patch("app.usecases.gen_requests.repo") as repo, patch(
        "app.usecases.gen_requests.agent_signals"
    ) as signals, patch("app.usecases.gen_requests.pm_best_effort") as pm, patch(
        "app.usecases.gen_requests.manager.broadcast", new_callable=AsyncMock
    ) as broadcast:
        repo.sweep_expired_generation_claims.return_value = []
        repo.claim_pending_requests.return_value = claimed

        out = asyncio.run(claim_gen_requests("A@B.COM", "acct:a", limit=99))

        assert out == claimed
        signals.touch.assert_called_once_with("A@B.COM")
        repo.claim_pending_requests.assert_called_once_with(
            "A@B.COM",
            limit=16,
            workspace_capable=False,
            lease_owner=None,
            submission_stage_capable=False,
            sweep_expired=False,
        )
        assert repo.set_status.call_args_list == [
            (("g1", "running", None),),
            (("g2", "running", None),),
        ]
        assert pm.call_count == 2
        assert [call.kwargs["account_uid"] for call in broadcast.await_args_list] == [
            "acct:a",
            "acct:a",
        ]
        assert [call.args[0]["generation_id"] for call in broadcast.await_args_list] == [
            "g1",
            "g2",
        ]


def test_staged_claim_waits_for_begin_before_marking_generation_started():
    claimed = [{"id": "r1", "gen_id": "g1", "claim_phase": "claimed"}]
    with patch("app.usecases.gen_requests.repo") as repo, patch(
        "app.usecases.gen_requests.agent_signals"
    ), patch("app.usecases.gen_requests.pm_best_effort") as pm, patch(
        "app.usecases.gen_requests.manager.broadcast", new_callable=AsyncMock
    ) as broadcast:
        repo.sweep_expired_generation_claims.return_value = []
        repo.claim_pending_requests.return_value = claimed

        out = asyncio.run(
            claim_gen_requests(
                "a@b.com",
                "acct:a",
                limit=1,
                lease_owner="agent-1",
                submission_stage_capable=True,
            )
        )

    assert out == claimed
    repo.set_status.assert_not_called()
    pm.assert_not_called()
    broadcast.assert_awaited_once_with({"type": "synced"}, account_uid="acct:a")


def test_begin_submission_records_started_only_on_first_transition():
    from app.usecases.gen_requests import begin_submission

    with patch("app.usecases.gen_requests.repo") as repo, patch(
        "app.usecases.gen_requests.pm_best_effort"
    ) as pm, patch(
        "app.usecases.gen_requests.journal_generation_event"
    ) as journal, patch(
        "app.usecases.gen_requests.manager.broadcast", new_callable=AsyncMock
    ) as broadcast:
        repo.begin_request_submission.side_effect = [
            {"gen_id": "g1", "transitioned": True},
            {"gen_id": "g1", "transitioned": False},
        ]

        assert asyncio.run(
            begin_submission("a@b.com", "acct:a", "r1", "agent-1")
        ) is True
        assert asyncio.run(
            begin_submission("a@b.com", "acct:a", "r1", "agent-1")
        ) is True

    assert pm.call_count == 1
    assert journal.call_count == 1
    assert broadcast.await_count == 1


def test_recovery_report_is_idempotent_and_generation_requeue_resolves_owned_request():
    from app.usecases.gen_requests import (
        confirm_generation_not_submitted_and_requeue,
        require_submission_recovery,
    )

    with patch("app.usecases.gen_requests.repo") as repo, patch(
        "app.usecases.gen_requests.journal_generation_event"
    ) as journal, patch(
        "app.usecases.gen_requests.manager.broadcast", new_callable=AsyncMock
    ) as broadcast, patch("app.usecases.gen_requests.agent_signals") as signals:
        repo.mark_request_recovery_required.side_effect = [
            {"gen_id": "g1", "transitioned": True},
            {"gen_id": "g1", "transitioned": False},
        ]
        assert asyncio.run(
            require_submission_recovery("a@b.com", "acct:a", "r1")
        ) is True
        assert asyncio.run(
            require_submission_recovery("a@b.com", "acct:a", "r1")
        ) is True

        assert journal.call_count == 1
        assert broadcast.await_count == 1

        repo.get_recovery_request_id_for_generation.return_value = "r1"
        repo.requeue_recovery_request.return_value = "g1"
        assert asyncio.run(
            confirm_generation_not_submitted_and_requeue(
                "a@b.com", "acct:a", "g1"
            )
        ) is True

    repo.get_recovery_request_id_for_generation.assert_called_once_with(
        "g1", "a@b.com"
    )
    repo.requeue_recovery_request.assert_called_once_with("r1", "a@b.com")
    signals.signal.assert_called_once_with("a@b.com", "gen-request")


def test_fulfill_request_applies_result_once_and_broadcasts():
    result = SimpleNamespace(
        asset_type="image",
        asset_path="C:/result.png",
        asset_thumb="C:/thumb.png",
        job_id="job1",
        created_at="2026-08-05T00:00:00Z",
        sort_ts=123.0,
        status="done",
        error=None,
    )
    with patch("app.usecases.gen_requests.repo") as repo, patch(
        "app.usecases.gen_requests.cli_bridge.parse_job", return_value={"parsed": True}
    ) as parse_job, patch(
        "app.usecases.gen_requests.normalize_job_result", return_value=result
    ) as normalize, patch("app.usecases.gen_requests.pm_best_effort") as pm, patch(
        "app.usecases.gen_requests.manager.broadcast", new_callable=AsyncMock
    ) as broadcast:
        repo.apply_local_fulfillment.return_value = True
        repo.get_generation.return_value = {"id": "g1", "status": "done"}

        out = asyncio.run(
            fulfill_request({"gen_id": "g1"}, "r1", {"raw": True}, "acct:a")
        )

        assert out == {"id": "g1", "status": "done"}
        parse_job.assert_called_once_with({"raw": True})
        normalize.assert_called_once_with({"parsed": True})
        repo.apply_local_fulfillment.assert_called_once_with(
            "g1",
            "r1",
            asset_type="image",
            asset_path="C:/result.png",
            asset_thumb="C:/thumb.png",
            job_id="job1",
            created_at="2026-08-05T00:00:00Z",
            sort_ts=123.0,
            status="done",
            error=None,
            request_status="done",
        )
        pm.assert_called_once()
        broadcast.assert_awaited_once_with(
            {
                "type": "progress",
                "generation_id": "g1",
                "status": "done",
                "result_url": "C:/result.png",
                "error": None,
            },
            account_uid="acct:a",
        )


def test_fulfill_request_cas_noop_does_not_repeat_side_effects():
    with patch("app.usecases.gen_requests.repo") as repo, patch(
        "app.usecases.gen_requests.cli_bridge.parse_job", return_value={}
    ), patch(
        "app.usecases.gen_requests.normalize_job_result", return_value=SimpleNamespace(
            asset_type=None,
            asset_path=None,
            asset_thumb=None,
            job_id="job1",
            created_at=None,
            sort_ts=None,
            status="failed",
            error="failed",
        ),
    ), patch("app.usecases.gen_requests.pm_best_effort") as pm, patch(
        "app.usecases.gen_requests.manager.broadcast", new_callable=AsyncMock
    ) as broadcast:
        repo.apply_local_fulfillment.return_value = False
        repo.get_generation.return_value = {"id": "g1", "status": "done"}

        out = asyncio.run(fulfill_request({"gen_id": "g1"}, "r1", {}, "acct:a"))

        assert out == {"id": "g1", "status": "done"}
        pm.assert_not_called()
        broadcast.assert_not_awaited()


def test_anchor_request_broadcasts_only_after_apply():
    with patch("app.usecases.gen_requests.repo") as repo, patch(
        "app.usecases.gen_requests.manager.broadcast", new_callable=AsyncMock
    ) as broadcast:
        repo.VERIFYING_NOTE = "확인중"
        repo.apply_local_anchor.return_value = True

        applied = asyncio.run(
            anchor_request({"gen_id": "g1"}, "r1", "job1", True, "acct:a")
        )

        assert applied is True
        repo.apply_local_anchor.assert_called_once_with("g1", "r1", "job1", verifying=True)
        broadcast.assert_awaited_once_with(
            {
                "type": "progress",
                "generation_id": "g1",
                "status": "running",
                "error": "확인중",
            },
            account_uid="acct:a",
        )


def test_reconcile_request_keeps_processing_in_tracking_without_terminal_write():
    pending = SimpleNamespace(status="pending")
    with patch("app.usecases.gen_requests.repo") as repo, patch(
        "app.usecases.gen_requests.cli_bridge.parse_job", return_value={"parsed": True}
    ), patch(
        "app.usecases.gen_requests.normalize_job_result", return_value=pending
    ), patch("app.usecases.gen_requests.pm_best_effort") as pm, patch(
        "app.usecases.gen_requests.manager.broadcast", new_callable=AsyncMock
    ) as broadcast:
        repo.get_generation.return_value = {"job_id": None, "assets": []}
        out = asyncio.run(
            reconcile_request({"id": "r1", "gen_id": "g1"}, {}, None, "acct:a")
        )

        assert out == {
            "ok": True,
            "applied": False,
            "outcome": "not_ready",
            "status": "running",
            "job_id": None,
            "asset_saved": False,
        }
        repo.record_request_check.assert_called_once()
        repo.set_status.assert_called_once_with("g1", "running", None)
        repo.apply_reconcile.assert_not_called()
        pm.assert_not_called()
        broadcast.assert_not_awaited()


def test_reconcile_request_applies_terminal_result_and_broadcasts():
    result = SimpleNamespace(
        asset_type="video",
        asset_path="C:/result.mp4",
        asset_thumb="C:/poster.jpg",
        job_id="job1",
        created_at="2026-08-05T00:00:00Z",
        sort_ts=123.0,
        status="done",
        error=None,
    )
    with patch("app.usecases.gen_requests.repo") as repo, patch(
        "app.usecases.gen_requests.cli_bridge.parse_job",
        return_value={"generation": {"id": "job1", "status": "done"}},
    ), patch(
        "app.usecases.gen_requests.normalize_job_result", return_value=result
    ), patch("app.usecases.gen_requests.pm_best_effort") as pm, patch(
        "app.usecases.gen_requests.manager.broadcast", new_callable=AsyncMock
    ) as broadcast:
        repo.apply_reconcile.return_value = True
        repo.get_generation.side_effect = [
            {"job_id": "job1", "assets": [], "status": "running"},
            {"job_id": "job1", "assets": [{"file_path": "C:/result.mp4"}], "status": "done"},
        ]

        out = asyncio.run(
            reconcile_request(
                {"id": "r1", "gen_id": "g1"}, {"status": "done"}, None, "acct:a"
            )
        )

        assert out == {
            "ok": True,
            "applied": True,
            "outcome": "applied",
            "status": "done",
            "job_id": "job1",
            "asset_saved": True,
        }
        repo.apply_reconcile.assert_called_once_with(
            "g1",
            "job1",
            asset_type="video",
            asset_path="C:/result.mp4",
            asset_thumb="C:/poster.jpg",
            created_at="2026-08-05T00:00:00Z",
            sort_ts=123.0,
            status="done",
            error=None,
            provider_status="done",
        )
        pm.assert_called_once()
        broadcast.assert_awaited_once_with(
            {
                "type": "progress",
                "generation_id": "g1",
                "status": "done",
                "result_url": "C:/result.mp4",
                "error": None,
            },
            account_uid="acct:a",
        )


def test_reconcile_unknown_provider_status_is_not_terminal():
    with patch("app.usecases.gen_requests.repo") as repo, patch(
        "app.usecases.gen_requests.cli_bridge.parse_job",
        return_value={"generation": {"id": "job1", "status": "future_state"}},
    ), patch(
        "app.usecases.gen_requests.manager.broadcast", new_callable=AsyncMock
    ):
        repo.get_generation.return_value = {
            "job_id": "job1",
            "assets": [],
            "status": "running",
        }
        out = asyncio.run(
            reconcile_request(
                {"id": "r1", "gen_id": "g1"},
                {"id": "job1", "status": "future_state"},
                None,
                "acct:a",
            )
        )

    assert out["outcome"] == "not_ready"
    assert out["status"] == "running"
    repo.record_request_check.assert_called_once()
    assert repo.record_request_check.call_args.kwargs["phase"] == "verifying"
    repo.apply_reconcile.assert_not_called()


def test_reconcile_completed_without_usable_asset_stays_verifying():
    result = SimpleNamespace(
        asset_type="image",
        asset_path="completed",
        asset_thumb=None,
        job_id="job1",
        created_at=None,
        sort_ts=None,
        status="done",
        error=None,
    )
    with patch("app.usecases.gen_requests.repo") as repo, patch(
        "app.usecases.gen_requests.cli_bridge.parse_job",
        return_value={"generation": {"id": "job1", "status": "done"}},
    ), patch(
        "app.usecases.gen_requests.normalize_job_result", return_value=result
    ), patch(
        "app.usecases.gen_requests.manager.broadcast", new_callable=AsyncMock
    ):
        repo.get_generation.return_value = {
            "job_id": "job1",
            "assets": [],
            "status": "running",
        }
        out = asyncio.run(
            reconcile_request(
                {"id": "r1", "gen_id": "g1"},
                {"id": "job1", "status": "done"},
                None,
                "acct:a",
            )
        )

    assert out["outcome"] == "not_ready"
    assert out["asset_saved"] is False
    repo.apply_reconcile.assert_not_called()
    assert repo.record_request_check.call_args.kwargs["phase"] == "verifying"


def test_fail_request_recovers_legacy_job_id_and_broadcasts():
    legacy_job_id = "123e4567-e89b-12d3-a456-426614174000"
    reason = f"job {legacy_job_id} ended with status 'nsfw'"
    with patch("app.usecases.gen_requests.repo") as repo, patch(
        "app.usecases.gen_requests.cli_bridge.normalize_status", return_value="nsfw"
    ), patch("app.usecases.gen_requests.pm_best_effort") as pm, patch(
        "app.usecases.gen_requests.manager.broadcast", new_callable=AsyncMock
    ) as broadcast:
        repo.apply_local_failure.return_value = True

        applied = asyncio.run(
            fail_request({"gen_id": "g1"}, "r1", reason, None, None, "acct:a")
        )

        assert applied is True
        repo.apply_local_failure.assert_called_once_with(
            "g1", "r1", reason, job_id=legacy_job_id, status="nsfw"
        )
        pm.assert_called_once()
        broadcast.assert_awaited_once_with(
            {
                "type": "progress",
                "generation_id": "g1",
                "status": "nsfw",
                "error": reason,
            },
            account_uid="acct:a",
        )


def test_legacy_ambiguous_submission_failure_is_quarantined_not_finalized():
    request = {
        "id": "r1",
        "gen_id": "g1",
        "account_email": "worker@example.com",
        "status": "submitting",
    }
    with patch("app.usecases.gen_requests.repo") as repo, patch(
        "app.usecases.gen_requests.require_submission_recovery",
        new_callable=AsyncMock,
        return_value=True,
    ) as recovery:
        applied = asyncio.run(
            fail_request(
                request,
                "r1",
                "제출 실패: CLI 응답에서 잡 id 없음",
                None,
                None,
                "acct:a",
            )
        )

    assert applied is True
    recovery.assert_awaited_once_with(
        "worker@example.com", "acct:a", "r1"
    )
    repo.apply_local_failure.assert_not_called()


def test_fail_request_cas_noop_does_not_repeat_side_effects():
    with patch("app.usecases.gen_requests.repo") as repo, patch(
        "app.usecases.gen_requests.pm_best_effort"
    ) as pm, patch(
        "app.usecases.gen_requests.manager.broadcast", new_callable=AsyncMock
    ) as broadcast:
        repo.apply_local_failure.return_value = False

        applied = asyncio.run(
            fail_request({"gen_id": "g1"}, "r1", "failed", None, None, "acct:a")
        )

        assert applied is False
        pm.assert_not_called()
        broadcast.assert_not_awaited()

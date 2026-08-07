"""P6 usecase 추출 회귀 테스트 — create_gen_request 오케스트레이션(submit_gen_request)의
부수효과 순서·분기를 고정한다. 라우터에서 옮긴 흐름이 동작 그대로인지 지킨다."""

import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

from app.models import RegenerateIn
from app.usecases.gen_requests import (
    GenRequestCommand,
    anchor_request,
    claim_gen_requests,
    fail_request,
    fulfill_request,
    reconcile_request,
    submit_gen_request,
)


def _names(parent):
    """attach 된 자식 mock 들의 전역 호출 순서를 'repo.create_local_generation' 형태 이름 리스트로."""
    return [c[0] for c in parent.mock_calls if c[0]]


def test_create_path_calls_in_order_and_returns_gen():
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


def test_pm_branch_estimates_only_when_manage_on_and_cli_available():
    # MANAGE on + CLI 있음 → 견적 await + pm_best_effort 1회.
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
        asyncio.run(submit_gen_request(cmd))

        cli.estimate_cost.assert_awaited_once()
        pm.assert_called_once()

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


def test_claim_requests_updates_each_placeholder_and_broadcasts_in_scope():
    claimed = [{"id": "r1", "gen_id": "g1"}, {"id": "r2", "gen_id": "g2"}]
    with patch("app.usecases.gen_requests.repo") as repo, patch(
        "app.usecases.gen_requests.agent_signals"
    ) as signals, patch("app.usecases.gen_requests.pm_best_effort") as pm, patch(
        "app.usecases.gen_requests.manager.broadcast", new_callable=AsyncMock
    ) as broadcast:
        repo.claim_pending_requests.return_value = claimed

        out = asyncio.run(claim_gen_requests("A@B.COM", "acct:a", limit=99))

        assert out == claimed
        signals.touch.assert_called_once_with("A@B.COM")
        repo.claim_pending_requests.assert_called_once_with(
            "A@B.COM", limit=16, workspace_capable=False
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


def test_reconcile_request_keeps_pending_without_writing():
    pending = SimpleNamespace(status="pending")
    with patch("app.usecases.gen_requests.repo") as repo, patch(
        "app.usecases.gen_requests.cli_bridge.parse_job", return_value={"parsed": True}
    ), patch(
        "app.usecases.gen_requests.normalize_job_result", return_value=pending
    ), patch("app.usecases.gen_requests.pm_best_effort") as pm, patch(
        "app.usecases.gen_requests.manager.broadcast", new_callable=AsyncMock
    ) as broadcast:
        out = asyncio.run(reconcile_request({"gen_id": "g1"}, {}, None, "acct:a"))

        assert out == {"ok": True, "applied": False, "status": "pending"}
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
        "app.usecases.gen_requests.cli_bridge.parse_job", return_value={}
    ), patch(
        "app.usecases.gen_requests.normalize_job_result", return_value=result
    ), patch("app.usecases.gen_requests.pm_best_effort") as pm, patch(
        "app.usecases.gen_requests.manager.broadcast", new_callable=AsyncMock
    ) as broadcast:
        repo.apply_reconcile.return_value = True

        out = asyncio.run(reconcile_request({"gen_id": "g1"}, {}, None, "acct:a"))

        assert out == {"ok": True, "applied": True, "status": "done"}
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

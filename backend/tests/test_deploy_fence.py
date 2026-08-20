"""혼합 배포 생성 일시중지와 읽기 전용 fence 계약."""

from __future__ import annotations

import asyncio
import importlib.util
import os
import tempfile
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import pytest
from fastapi import HTTPException

from app import db, deps, repo
from app.models import (
    GenerationCreate,
    GenerationDeploymentPauseIn,
    GenRequestIn,
    WorkspaceContext,
)
from app.routers import gen_requests as gen_requests_router


_TOOL_PATH = Path(__file__).resolve().parents[2] / "tools" / "deploy_fence_check.py"
_TOOL_SPEC = importlib.util.spec_from_file_location("deploy_fence_check", _TOOL_PATH)
assert _TOOL_SPEC and _TOOL_SPEC.loader
deploy_fence_check = importlib.util.module_from_spec(_TOOL_SPEC)
_TOOL_SPEC.loader.exec_module(deploy_fence_check)


@pytest.fixture
def fence_db():
    temporary = tempfile.TemporaryDirectory(ignore_cleanup_errors=True)
    path = Path(temporary.name) / "content_hub.db"
    old_db = os.environ.get("CONTENT_HUB_DB")
    os.environ["CONTENT_HUB_DB"] = str(path)
    db.flush_pool()
    db.init_db()
    repo.ensure_default_worker()
    try:
        yield path
    finally:
        db.flush_pool()
        if old_db is None:
            os.environ.pop("CONTENT_HUB_DB", None)
        else:
            os.environ["CONTENT_HUB_DB"] = old_db
        db.flush_pool()
        temporary.cleanup()


def _request_row() -> tuple[str, str]:
    payload = {"model": "model", "prompt": "fence test", "params": {}}
    gen_id = repo.create_local_generation(
        payload,
        "me",
        creator_uid="creator-1",
        workspace={"scope": "personal", "id": None, "name": None},
    )
    request_id = repo.create_gen_request(
        "worker@example.com",
        "creator-1",
        gen_id,
        "create",
        payload,
    )
    return request_id, gen_id


def _create_body() -> GenRequestIn:
    return GenRequestIn(
        kind="create",
        workspace=WorkspaceContext(scope="personal"),
        create=GenerationCreate(model="model", prompt="pause test"),
    )


def test_pause_on_rejects_intake_and_off_restores_success(fence_db):
    account = {"email": "worker@example.com", "creator_uid": "creator-1"}
    repo.set_setting(gen_requests_router._GENERATION_DEPLOYMENT_PAUSE_KEY, "1")

    with patch.object(
        gen_requests_router, "_require_account", return_value=account
    ), pytest.raises(HTTPException) as caught:
        asyncio.run(gen_requests_router.create_gen_request(_create_body(), object()))

    assert caught.value.status_code == 503
    assert caught.value.headers == {"Retry-After": "60"}
    with db.get_connection() as connection:
        assert connection.execute("SELECT COUNT(*) FROM gen_request").fetchone()[0] == 0
        assert connection.execute("SELECT COUNT(*) FROM generation").fetchone()[0] == 0

    repo.set_setting(gen_requests_router._GENERATION_DEPLOYMENT_PAUSE_KEY, "0")
    with patch.object(
        gen_requests_router, "_require_account", return_value=account
    ), patch.object(
        gen_requests_router, "AUTH_ENABLED", False
    ), patch(
        "app.usecases.gen_requests.MANAGE_ENABLED", False
    ), patch(
        "app.usecases.gen_requests.agent_signals.signal"
    ), patch(
        "app.usecases.gen_requests.journal_generation_event"
    ), patch.object(
        gen_requests_router, "schedule_telemetry_drain"
    ):
        generation = asyncio.run(
            gen_requests_router.create_gen_request(_create_body(), object())
        )

    assert generation["status"] == "pending"
    with db.get_connection() as connection:
        assert connection.execute("SELECT COUNT(*) FROM gen_request").fetchone()[0] == 1


def test_pause_on_rejects_claim_and_off_claims_normally(fence_db):
    request_id, generation_id = _request_row()
    account = {"email": "worker@example.com", "creator_uid": "creator-1"}
    repo.set_setting(gen_requests_router._GENERATION_DEPLOYMENT_PAUSE_KEY, "1")

    with patch.object(
        gen_requests_router, "_require_account", return_value=account
    ), pytest.raises(HTTPException) as caught:
        asyncio.run(
            gen_requests_router.pending_gen_requests(
                object(),
                capability="workspace,submission-stage",
                agent_id="agent-1",
            )
        )

    assert caught.value.status_code == 503
    assert repo.get_gen_request(request_id)["status"] == "pending"
    assert repo.get_generation(generation_id)["status"] == "pending"

    repo.set_setting(gen_requests_router._GENERATION_DEPLOYMENT_PAUSE_KEY, "0")
    with patch.object(
        gen_requests_router, "_require_account", return_value=account
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

    assert [item["id"] for item in claimed] == [request_id]
    assert repo.get_gen_request(request_id)["status"] == "claimed"


def test_pause_toggle_reuses_admin_gate(fence_db):
    body = GenerationDeploymentPauseIn(paused=True)
    member_request = SimpleNamespace(
        state=SimpleNamespace(account={"global_role": "member"})
    )
    with patch.object(deps, "AUTH_ENABLED", True), pytest.raises(HTTPException) as caught:
        gen_requests_router.set_generation_deployment_pause(body, member_request)

    assert caught.value.status_code == 403
    assert repo.get_setting(gen_requests_router._GENERATION_DEPLOYMENT_PAUSE_KEY) is None

    admin_request = SimpleNamespace(
        state=SimpleNamespace(account={"global_role": "admin"})
    )
    with patch.object(deps, "AUTH_ENABLED", True):
        response = gen_requests_router.set_generation_deployment_pause(
            body, admin_request
        )

    assert response["paused"] is True
    assert repo.get_setting(gen_requests_router._GENERATION_DEPLOYMENT_PAUSE_KEY) == "1"


def test_fence_exit_zero_only_when_paused_and_all_counts_are_zero(fence_db, capsys):
    repo.set_setting(deploy_fence_check.PAUSE_SETTING_KEY, "1")

    result = deploy_fence_check.inspect_fence(fence_db)
    assert result["safe"] is True
    assert result["non_terminal_request_total"] == 0
    assert result["active_generation_total"] == 0
    assert deploy_fence_check.main(["--db", str(fence_db)]) == deploy_fence_check.EXIT_SAFE
    assert "[통과]" in capsys.readouterr().out


def test_fence_blocks_every_non_terminal_request_and_active_generation(fence_db, capsys):
    repo.set_setting(deploy_fence_check.PAUSE_SETTING_KEY, "1")
    request_id, generation_id = _request_row()
    with db.get_connection() as connection:
        connection.execute(
            "UPDATE gen_request SET status='recovery_required' WHERE id=?",
            (request_id,),
        )
        # 요청 집계와 generation 흔적 집계가 독립임을 확인한다.
        connection.execute(
            "UPDATE generation SET status='done' WHERE id=?",
            (generation_id,),
        )
        provider_only_id = repo.create_local_generation(
            {"model": "model", "prompt": "provider only"}, "me"
        )
        connection.execute(
            "UPDATE generation SET status='running' WHERE id=?", (provider_only_id,)
        )

    result = deploy_fence_check.inspect_fence(fence_db)
    assert result["non_terminal_request_counts"] == {"recovery_required": 1}
    assert result["active_generation_counts"] == {"running": 1}
    assert result["safe"] is False
    assert deploy_fence_check.main(["--db", str(fence_db)]) == deploy_fence_check.EXIT_BLOCKED
    assert "[차단]" in capsys.readouterr().out


def test_fence_blocks_when_pause_is_off_even_if_counts_are_zero(fence_db):
    result = deploy_fence_check.inspect_fence(fence_db)
    assert result["paused"] is False
    assert result["non_terminal_request_total"] == 0
    assert result["active_generation_total"] == 0
    assert deploy_fence_check.main(["--db", str(fence_db)]) == deploy_fence_check.EXIT_BLOCKED

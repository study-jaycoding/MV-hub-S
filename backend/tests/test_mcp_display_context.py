"""No provider calls: exercise the authorized result boundary with fixed rows."""
import asyncio
from types import SimpleNamespace
from uuid import uuid4

import pytest
from fastapi import HTTPException
from app.routers import mcp_v2 as api


@pytest.fixture
def result(monkeypatch):
    workspace = {"scope": "team", "id": "test-team"}
    row = {"id": str(uuid4()), "job_id": str(uuid4()), "status": "done", "creator_uid": "owner",
           "workspace_scope": "team", "workspace_id": "test-team",
           "assets": [{"id": "asset-1", "type": "image", "source_url": "https://example.invalid/private.png"}]}
    monkeypatch.setattr(api.config, "AUTH_ENABLED", True)
    monkeypatch.setattr(api, "_generation_row", lambda *_: row)
    monkeypatch.setattr(api, "_request_workspace", lambda *_: workspace)
    monkeypatch.setattr(api, "_workspace", lambda *_: workspace)
    monkeypatch.setattr(api, "_internal", lambda *_: None)
    monkeypatch.setattr(api, "_still_current", lambda *_: None)
    monkeypatch.setattr(api, "account_actor_uid", lambda *_: "owner")
    ctx = SimpleNamespace(owner="owner", account={"creator_uid": "owner"})
    def run():
        args = api.GenerationIn(generation_id=row["id"], workspace_scope="team", workspace_id="test-team")
        return asyncio.run(api._result_once(ctx, args, preview=False))
    return row, run


def test_origin_id_scope_and_asset_identity_without_rendering(result):
    row, run = result
    value = run()
    display = value["display_context"]
    assert value["generation_id"] == row["id"] != display["origin_job_id"]
    assert display["arguments"] == {"id": row["job_id"]}
    assert display["workspace"] == {"scope": "team", "id": "test-team"}
    assert display["preview_key"] == f"higgsfield:{row['job_id']}:asset-1"
    assert run()["display_context"] == display
    assert not display["rendered"] and not display["automatic_display"] and value["media"] is None
    assert "folder_id" not in display and "source_url" not in str(display)
    assert display["status"] == "external_access_unverified"


@pytest.mark.parametrize("key,value", [("creator_uid", "other"), ("workspace_id", "other"), ("creator_uid", None)])
def test_unauthorized_result_rejected_before_origin_metadata(result, key, value):
    row, run = result
    row[key] = value
    with pytest.raises(HTTPException) as error:
        run()
    assert error.value.status_code == 404


@pytest.mark.parametrize("job_id", [None, "", "not-a-uuid", "../../secret"])
def test_missing_origin_never_substitutes_generation_id(result, job_id):
    row, run = result
    row["job_id"] = job_id
    display = run()["display_context"]
    assert display["origin_job_id"] is None and display["status"] == "origin_missing"
    assert "arguments" not in display


def test_pending_and_unverified_media_do_not_recommend_display(result):
    row, run = result
    row["status"] = "running"
    assert run()["display_context"]["status"] == "not_ready"
    assert run()["display_context"]["origin_job_id"] is None
    row["status"] = "done"
    row["assets"][0]["type"] = "video"
    assert run()["display_context"]["status"] == "media_not_verified"
    row["assets"] = []
    assert run()["display_context"]["status"] == "asset_missing"


def test_plan_wait_path_keeps_same_permission_boundary(result):
    row, _ = result
    ctx = SimpleNamespace(owner="owner", account={"creator_uid": "owner"})
    plan = {"id": str(uuid4()), "title": "test", "workspace": {"scope": "team", "id": "test-team"},
            "items": [{"generation_id": row["id"], "state": "submitted"}]}
    args = api.ResultIn(plan_id=plan["id"])
    value = asyncio.run(api._result_once(ctx, args, preview=False, plan=plan))
    assert value["display_context"]["origin_job_id"] == row["job_id"]
    row["creator_uid"] = "other"
    with pytest.raises(HTTPException):
        asyncio.run(api._result_once(ctx, args, preview=False, plan=plan))

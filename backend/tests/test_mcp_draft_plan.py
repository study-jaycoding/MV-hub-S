"""MCP plans describe the same fresh Draft request that submission will send."""
import asyncio

import pytest
from fastapi import HTTPException

from app.routers import mcp_v2 as api


@pytest.fixture
def validate(monkeypatch):
    async def models(*_args):
        return [{"job_set_type": "seedance_2_5"}]

    async def schema(_model):
        return {"params": [{"name": "resolution", "type": "string", "enum": ["480p", "1080p"]}]}

    monkeypatch.setattr(api, "_models", models)
    monkeypatch.setattr(api.generation, "model_params", schema)
    monkeypatch.setattr(api, "_workspace", lambda *_args: {"scope": "personal", "id": None})
    monkeypatch.setattr(api, "_references", lambda *_args: [])
    monkeypatch.setattr(api, "_still_current", lambda *_args: None)

    def run(params):
        item = {"model": "seedance_2_5", "params": params, "reference_ids": []}
        asyncio.run(api._validate_items(None, [item], {}))
        return item["params"]

    return run


def test_plan_marks_480p_as_draft_without_mutating_caller(validate):
    original = {"resolution": "480p"}
    assert validate(original) == {"resolution": "480p", "draft": True}
    assert original == {"resolution": "480p"}


def test_plan_does_not_turn_fresh_1080p_into_a_finish(validate):
    assert validate({"resolution": "1080p", "draft": True}) == {"resolution": "1080p"}


@pytest.mark.parametrize("extra", [{"draft_job_id": "remote-job"}, {"draft": "true"}, {"unknown": 1}])
def test_plan_rejects_raw_finish_id_or_invalid_options(validate, extra):
    with pytest.raises(HTTPException) as failure:
        validate({"resolution": "480p", **extra})
    assert failure.value.status_code == 422

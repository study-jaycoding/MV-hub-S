"""workflow 입력·비용·구버전 작업자 차단을 가짜 CLI와 임시 DB로 검증한다."""
import asyncio
import importlib.util
import json
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock

import pytest
from fastapi import HTTPException
from pydantic import ValidationError

from app import db, repo
from app.models import GenerationCreate
from app.routers import gen_requests as routes
from app.services import cli_bridge as cli
from app.usecases import gen_requests as usecases


def draw(**overrides):
    data = {"model": "draw_to_video", "prompt": "Move the marked object at 1.5 seconds",
            "params": {"duration": 5, "resolution": "720p"},
            "references": [{"file_path": "original.mp4", "type": "video", "role": "video"},
                           {"file_path": "sketch.png", "type": "image", "role": "image_references"}]}
    data.update(overrides)
    return data


@pytest.mark.parametrize("changes", [
    {"references": []}, {"references": draw()["references"][:1]},
    {"references": draw()["references"] * 2},
    {"references": [{**r, "role": "@Image1"} for r in draw()["references"]]},
    {"params": {"timestamp": 2}}, {"params": {"video": "other.mp4"}},
    {"params": {"duration": True}}, {"params": {"duration": float("inf")}},
    {"params": {"resolution": "4k"}}, {"params": {"enhancer": "false"}},
    {"params": {"resolution": []}}, {"params": {"resolution": {}}},
    {"params": {"aspect_ratio": []}}, {"params": {"aspect_ratio": {}}},
])
def test_draw_rejects_invalid_or_extra_inputs(changes):
    with pytest.raises(ValidationError):
        GenerationCreate(**draw(**changes))


def test_draw_schema_and_cost_use_official_workflow_command(monkeypatch):
    async def scenario():
        monkeypatch.setattr(cli, "_CALL_CACHE", {})
        monkeypatch.setattr(cli, "_PARAM_NAMES_CACHE", {})
        monkeypatch.setattr(cli, "_PARAM_NAMES_SAVED_AT", {})
        monkeypatch.setattr(cli, "_COST_CACHE", {})
        monkeypatch.setattr(cli, "_cost_loaded", True)
        monkeypatch.setattr(cli, "_ensure_cost_writer", lambda: None)
        run = AsyncMock(side_effect=[{"job_type": "draw_to_video", "type": "video", "params": [
            {"name": "duration"}, {"name": "resolution"}, {"name": "enhancer"}]}, {"credits": 26}])
        monkeypatch.setattr(cli, "_run_json", run)
        schema = await cli.get_model_params("draw_to_video")
        assert schema["type"] == "video"
        assert await cli.estimate_cost("draw_to_video", {**draw()["params"], "enhancer": True}, "edit") == {"credits": 26}
        assert run.call_args_list[0].args == ("workflow", "get", "draw_to_video")
        args = run.call_args_list[1].args
        assert args[:4] == ("generate", "cost", "workflow", "draw_to_video")
        assert args[args.index("--duration") + 1] == "5"
        assert "--enhancer" not in args
    asyncio.run(scenario())


@pytest.fixture
def media_db(monkeypatch, tmp_path):
    monkeypatch.setenv("CONTENT_HUB_DB", str(tmp_path / "content.db"))
    db.flush_pool()
    db.init_db()
    repo.ensure_default_worker()
    monkeypatch.setattr(usecases, "MANAGE_ENABLED", False)
    monkeypatch.setattr(usecases, "journal_generation_event", MagicMock())
    yield
    db.flush_pool()


def queue(data):
    gen_id = repo.create_local_generation(data, "me", creator_uid="u")
    rid = repo.create_gen_request("artist@example.com", "u", gen_id, "create", data)
    return rid, gen_id


def test_media_sql_gate_keeps_old_requests_claimable_without_starvation(media_db):
    media_id, _ = queue({**draw(), "media_protocol": "media-v2"})
    legacy_id, _ = queue({"model": "legacy", "prompt": "old", "params": {}})
    assert repo.has_pending_requests("artist@example.com")
    claimed = repo.claim_pending_requests("artist@example.com", limit=1)
    assert [row["id"] for row in claimed] == [legacy_id]
    assert repo.get_gen_request(media_id)["status"] == "pending"
    assert not repo.has_pending_requests("artist@example.com")
    assert repo.has_pending_requests("artist@example.com", media_v2_capable=True)
    new_claim = repo.claim_pending_requests("artist@example.com", media_v2_capable=True)
    assert new_claim[0]["media_protocol"] == "media-v2"


def test_new_model_is_blocked_even_if_marker_is_missing(media_db):
    rid, _ = queue(draw())
    assert not repo.has_pending_requests("artist@example.com")
    assert repo.claim_pending_requests("artist@example.com") == []
    assert repo.get_gen_request(rid)["status"] == "pending"


def test_old_agent_direct_begin_cannot_bypass_gate(media_db, monkeypatch):
    rid, _ = queue({**draw(), "media_protocol": "media-v2"})
    monkeypatch.setattr(routes, "_require_account", lambda _: {"email": "ARTIST@example.com"})
    begin = AsyncMock(return_value=True)
    monkeypatch.setattr(routes, "begin_submission", begin)
    with pytest.raises(HTTPException) as error:
        asyncio.run(routes.begin_gen_request_submission(rid, object(), "old-agent"))
    assert error.value.status_code == 409
    begin.assert_not_awaited()


def test_submit_marks_media_request_and_preserves_lineage(media_db):
    async def scenario():
        cmd = usecases.GenRequestCommand(kind="create", email="artist@example.com", creator_uid="u",
                                         worker_id="me", source_gen_id=None,
                                         workspace={"scope": "personal", "id": None, "name": None}, data=draw())
        gen = await usecases.submit_gen_request(cmd)
        with db.get_connection() as conn:
            row = conn.execute("SELECT payload FROM gen_request WHERE gen_id=?", (gen["id"],)).fetchone()
        payload = json.loads(row["payload"])
        assert payload["media_protocol"] == "media-v2"
        assert payload["workspace"]["scope"] == "personal"
        assert [ref["role"] for ref in payload["references"]] == ["video", "image_references"]
    asyncio.run(scenario())


def load_agent():
    path = Path(__file__).resolve().parents[2] / "agent_push.py"
    spec = importlib.util.spec_from_file_location("media_contract_agent", path)
    agent = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(agent)
    return agent


@pytest.mark.parametrize("model", ["draw_to_video", "text2speech_v2"])
def test_agent_submits_new_media_through_existing_workspace_and_anchor(model, monkeypatch, tmp_path):
    agent = load_agent()
    data = draw() if model == "draw_to_video" else {
        "model": model, "prompt": "line one\nline two", "references": [],
        "params": {"variant": "elevenlabs", "voice_type": "preset", "voice_id": "voice-1"}}
    request = {**data, "id": "request-1", "media_protocol": "media-v2", "claim_phase": "claimed",
               "workspace": {"scope": "personal", "id": None, "name": None}}
    cache = {}
    for ref in request["references"]:
        path = tmp_path / ref["file_path"]
        path.write_bytes(b"fake-input")
        cache[ref["file_path"]] = str(path)
    monkeypatch.setattr(agent, "_allowed_params", lambda *_: set(request["params"]))
    monkeypatch.setattr(agent, "_ensure_request_workspace", lambda *_: ("workspace-1", None))
    begin = MagicMock(return_value=True)
    monkeypatch.setattr(agent, "_begin_submission", begin)
    run = MagicMock(return_value=(["12345678-1234-1234-1234-123456789abc"], None))
    monkeypatch.setattr(agent, "_run_cli_json", run)
    monkeypatch.setattr(agent, "_anchor_tracked_safe", MagicMock())
    result = agent._submit_one("http://hub", "token", "fake-cli", "artist@example.com", request,
                               cache, {}, agent.Lock(), agent.Lock(), "agent-1")
    assert result["job_id"] == "12345678-1234-1234-1234-123456789abc"
    args = run.call_args.args
    assert args[1:4] == ("generate", "workflow" if model == "draw_to_video" else "create", model)
    assert run.call_args.kwargs["env"]["HIGGSFIELD_WORKSPACE_ID"] == "workspace-1"
    begin.assert_called_once()
    if model == "draw_to_video":
        assert args.count("--video") == 1 and args.count("--image-references") == 1
        assert result["expected_image_inputs"] == 0
        assert len(begin.call_args.args[4]["submitted_refs"]) == 2
        monkeypatch.setattr(agent, "_agent_state_path", lambda: str(tmp_path / "state.db"))
        agent._tracked_save("http://hub", "artist@example.com", result)
        assert agent._tracked_load("http://hub", "artist@example.com")[result["job_id"]]["expected_image_inputs"] == 0
    else:
        assert args[args.index("--prompt") + 1] == "line one\nline two"


def test_agent_missing_media_marker_never_invokes_paid_command(monkeypatch):
    agent = load_agent()
    monkeypatch.setattr(agent, "_allowed_params", lambda *_: {"duration"})
    monkeypatch.setattr(agent, "_fail", MagicMock())
    run = MagicMock()
    monkeypatch.setattr(agent, "_run_cli_json", run)
    assert agent._submit_one("hub", "token", "fake-cli", "artist@example.com",
                             {**draw(), "id": "r"}, {}, {}, agent.Lock(), agent.Lock(), "agent") is None
    run.assert_not_called()


def test_audio_fulfillment_keeps_type_and_repeated_result_is_idempotent(media_db, monkeypatch):
    monkeypatch.setattr(usecases.manager, "broadcast", AsyncMock())
    data = {"model": "text2speech_v2", "prompt": "hello", "params": {"voice_type": "preset", "voice_id": "voice-1", "variant": "elevenlabs"}}
    rid, gen_id = queue(data)
    row = repo.get_gen_request(rid)
    job = {"id": "job-audio", "status": "completed", "result_url": "https://cdn.test/result.mp3", "params": data["params"]}
    first = asyncio.run(usecases.fulfill_request(row, rid, job, "acct:artist"))
    second = asyncio.run(usecases.fulfill_request(row, rid, job, "acct:artist"))
    assert first["status"] == second["status"] == "done"
    with db.get_connection() as conn:
        assets = conn.execute("SELECT type,file_path FROM asset WHERE generation_id=?", (gen_id,)).fetchall()
    assert len(assets) == 1
    assert assets[0]["type"] == "audio"
    assert assets[0]["file_path"] == "https://cdn.test/result.mp3"
    usecases.manager.broadcast.assert_awaited_once()


def test_agent_accepts_output_array_without_promoting_reference_array(monkeypatch):
    agent = load_agent()
    report = MagicMock(return_value=(200, {"outcome": "applied", "asset_saved": True}))
    monkeypatch.setattr(agent, "_report_reconcile", report)
    tracked = {"rid": "r", "job_id": "j", "expected_image_inputs": 0}
    job = {"id": "j", "status": "completed", "outputs": [{"url": "https://cdn.test/audio.mp3", "type": "audio"}]}
    assert agent._finalize_tracked_job("hub", "token", "fake-cli", tracked, job, detailed=True)
    assert report.call_args.args[3] is job


@pytest.mark.parametrize("model_key", ["job_type", "job_set_type", "model"])
def test_draw_zero_observation_is_reported_without_forcing_failure(model_key, monkeypatch):
    agent = load_agent()
    report = MagicMock(return_value=(200, {"outcome": "applied", "asset_saved": True}))
    suppress = MagicMock()
    monkeypatch.setattr(agent, "_report_reconcile", report)
    monkeypatch.setattr(agent, "_suppress_job", suppress)
    monkeypatch.setattr(agent, "_job_image_input_count", lambda _: 0)
    tracked = {"rid": "r", "job_id": "j", "expected_image_inputs": 1}
    job = {"id": "j", "status": "completed", model_key: "draw_to_video", "result_url": "https://cdn.test/result.mp4"}
    assert agent._finalize_tracked_job("hub", "token", "fake-cli", tracked, job, detailed=True)
    suppress.assert_not_called()
    assert not report.call_args.kwargs


def test_media_smoke_only_queries_official_metadata_and_cost(monkeypatch):
    path = Path(__file__).resolve().parents[2] / "tools" / "hf_cli_contract_smoke.py"
    spec = importlib.util.spec_from_file_location("media_smoke", path)
    smoke = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(smoke)
    calls = []
    def query(cli_path, *args):
        calls.append((cli_path, args))
        if args[:2] == ("workflow", "get"):
            return {"type": "video", "params": [{"name": n} for n in ("video", "image_references", "prompt")],
                    "cost_params": [{"name": n} for n in ("duration", "resolution")]}, None
        if args[:2] == ("generate", "cost"):
            return {"credits_exact": 26.125}, None
        if args[:2] == ("model", "get"):
            return {"type": "audio", "params": [{"name": "prompt"}, {"name": "voice_id"},
                    {"name": "variant", "enum": ["elevenlabs"]}, {"name": "voice_type", "enum": ["preset"]}]}, None
        voice = {"id": "official-preset", "voice_type": "preset", "name": "Catalog voice"}
        if args[:2] == ("voices", "list"):
            return {"items": [voice]}, None
        if args[:2] == ("voices", "get"):
            return voice, None
        raise AssertionError("Unexpected paid command")
    monkeypatch.setattr(smoke, "run_json", query)
    smoke.check_media_contracts("explicit-candidate.exe")
    assert len(calls) == 5
    assert all(path == "explicit-candidate.exe" for path, _ in calls)
    assert all(status == smoke.PASS for status, _, _ in smoke.results)

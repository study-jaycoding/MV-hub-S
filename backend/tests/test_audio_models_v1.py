"""오디오 2-A: 유료 호출 없이 저장/전송/복구/입력 경계를 검사한다."""
import asyncio
import json
import subprocess
from pathlib import Path
from unittest.mock import AsyncMock, patch

import pytest

from app.models import (AUDIO_MODELS_V1, AUDIO_PARAMS, audio_cli_params,
                        audio_reference_error, audio_stored_params, validate_media_request)
from app.services import cli_bridge as cli
from test_agent_contracts import _load_agent


@pytest.fixture(autouse=True)
def isolated_audio_metadata(monkeypatch):
    for name in ("_CALL_CACHE", "_PARAM_NAMES_CACHE", "_PARAM_NAMES_SAVED_AT", "_PARAM_NAMES_RETRY_AT", "_COST_CACHE"):
        monkeypatch.setattr(cli, name, {})
    monkeypatch.setattr(cli, "_cost_loaded", True)
    monkeypatch.setattr(cli, "_ensure_cost_writer", lambda: None)


def voice():
    return {"voice_id": "voice-test", "voice_type": "preset"}


def test_definition_parity():
    agent = _load_agent()
    assert agent.AUDIO_PARAMS == AUDIO_PARAMS
    assert agent.AUDIO_MODELS_V1 == AUDIO_MODELS_V1
    source = (Path(__file__).parents[2] / "frontend/src/lib/spotlightPromptConfig.ts").read_text(encoding="utf-8")
    import re
    table = source.split("export const AUDIO_PARAMS:", 1)[1].split("};", 1)[0]
    for model, fields in AUDIO_PARAMS.items():
        line = re.search(rf"\b{model}: \[([^\]]+)\]", table)
        assert line and set(re.findall(r'"([a-z_]+)"', line[1])) == fields


@pytest.mark.parametrize("model", sorted(AUDIO_MODELS_V1 | {"text2speech_v2"}))
@pytest.mark.parametrize("path", ["object.pcm", "object.raw", "object.mp3"])
def test_audio_results_follow_model_whatever_the_extension(model, path):
    # format=pcm 결과처럼 모르는 확장자라도 명시 타입이 없으면 음성 모델의 결과는 오디오다(Codex A-2) — 이미지로 저장되지 않게.
    result = cli.parse_job({"id": "job", "job_type": model, "params": {}, "result_url": f"https://example.test/{path}",
                            "thumbnail_url": "https://example.test/poster.png"})
    assert result["asset"]["type"] == "audio"
    assert result["asset"]["thumbnail_url"] is None
    # 명시 타입은 그대로 우선한다
    explicit = cli.parse_job({"id": "job", "job_type": model, "params": {}, "result_url": f"https://example.test/{path}",
                              "result_media_type": "video"})
    assert explicit["asset"]["type"] == "video"


@pytest.mark.parametrize("model", sorted(AUDIO_MODELS_V1))
def test_audio_inputs_and_extensionless_results(model):
    validate_media_request(model, "대본\n원문", voice(), [])
    result = cli.parse_job({"id": "job", "job_type": model, "params": {}, "result_url": "https://example.test/object"})
    assert result["asset"]["type"] == "audio"
    with pytest.raises(ValueError):
        validate_media_request(model, "", voice(), [])
    with pytest.raises(ValueError):
        validate_media_request(model, "대본", {**voice(), "unknown": 1}, [])
    with pytest.raises(ValueError):
        validate_media_request(model, "대본", {"voice_id": "test", "voice_type": "element"}, [])


@pytest.mark.parametrize("key,value", [("stability", -0.1), ("similarity_boost", 1.1), ("stability", float("nan")), ("stability", True)])
def test_invalid_v4_numeric_options(key, value):
    with pytest.raises(ValueError):
        validate_media_request("elevenlabs_v4", "대본", {**voice(), key: value}, [])


@pytest.mark.parametrize("model", ["elevenlabs_v4", "elevenlabs_v4_turbo"])
def test_dialogue_round_trip_cost_and_recovery(model, monkeypatch):
    agent = _load_agent()
    script = '대본\n"인용" {원문}'
    params = {**voice(), "stability": 0.5}
    wire = audio_cli_params(model, script, params)
    assert audio_stored_params(model, wire) == {**params, "prompt": script}
    assert agent.audio_cli_params(model, script, params) == wire
    parsed = cli.parse_job({"id": "job", "job_type": model, "params": wire})
    assert parsed["generation"]["prompt"] == script
    assert parsed["generation"]["params"]["voice_id"] == "voice-test"
    assert parsed["generation"]["params"] == params
    fingerprint = agent._submission_fingerprint(model, script, params, set(params), [])
    request = {"fingerprint": fingerprint, "submission_started_at": 1000}
    job = {"id": "job", "job_type": model, "created_at": 1000, "params": wire}
    assert agent._matches_submission_fingerprint(request, job)
    job["params"] = {**wire, "dialogue": wire["dialogue"] * 2}
    assert not agent._matches_submission_fingerprint(request, job)
    assert "dialogue" in cli.parse_job(job)["generation"]["params"]
    assert cli.parse_job(job)["generation"]["prompt"] == "(제목 없음)"

    async def check_cost():
        monkeypatch.setattr(cli, "_COST_CACHE", {})
        monkeypatch.setattr(cli, "_cost_loaded", True)
        monkeypatch.setattr(cli, "_ensure_cost_writer", lambda: None)
        monkeypatch.setattr(cli, "_PARAM_NAMES_CACHE", {model: {"dialogue", "stability"}})
        monkeypatch.setattr(cli, "_run_json", AsyncMock(return_value={"credits": 0.23}))
        await cli.estimate_cost(model, params, script)
        await cli.estimate_cost(model, params, script + "다른 대본")
        assert cli._run_json.await_count == 2
        args = cli._run_json.call_args_list[0].args
        assert "--prompt" not in args
        assert json.loads(args[args.index("--dialogue") + 1]) == wire["dialogue"]
        assert all(script not in key for key in cli._COST_CACHE)
    asyncio.run(check_cost())


@pytest.mark.parametrize("refs,selected,valid", [
    (["audio"] * 3, False, True), (["audio"] * 3, True, False),
    (["audio"] * 2, True, True), (["image"], False, True),
    (["image"], True, False), (["image", "audio"], False, False),
    (["image"] * 2, False, False), (["video"], False, False),
])
def test_seed_audio_reference_parity(refs, selected, valid):
    agent = _load_agent()
    references = [{"type": kind, "file_path": "file", "role": kind + "_references"} for kind in refs]
    params = voice() if selected else {}
    error = audio_reference_error("seed_audio", params, references)
    assert agent.audio_reference_error("seed_audio", params, references) == error
    assert bool(error) is not valid
    if valid:
        validate_media_request("seed_audio", "대본", params, references)
        agent._validate_audio_request("seed_audio", "대본", params, references)
    else:
        with pytest.raises(ValueError, match="Seed Audio"):
            validate_media_request("seed_audio", "대본", params, references)


@pytest.mark.parametrize("failure", ["exit", "timeout", "parse"])
def test_dialogue_script_never_appears_in_error_or_log(failure, capsys):
    agent = _load_agent()
    script = "private-script-do-not-log"
    output = '{"dialogue":[{"text":"' + script
    args = ("generate", "create", "elevenlabs_v4", "--dialogue", json.dumps([{"text": script, **voice()}]))
    side_effect = subprocess.TimeoutExpired("cli", 1, output=output) if failure == "timeout" else None
    result = subprocess.CompletedProcess([], 1 if failure == "exit" else 0, output, "")
    with patch.object(agent.subprocess, "run", return_value=result, side_effect=side_effect):
        _, error = agent._run_cli_json("fake", *args)
    assert script not in error
    assert script not in capsys.readouterr().out
    assert script not in agent._args_for_log(args)


def test_dialogue_escaped_and_truncated_error_never_leaks_script():
    agent = _load_agent()
    script = "private-script-do-not-log"
    nested = json.dumps({"error": json.dumps({"dialogue": [{"text": script}]})})
    assert script not in agent._sanitize_diagnostic(nested)
    assert script not in agent._sanitize_diagnostic(nested[:-4])


@pytest.mark.parametrize("model", ["elevenlabs_v4", "elevenlabs_v4_turbo"])
def test_agent_submission_uses_dialogue_and_keeps_storage_fingerprint(model):
    agent = _load_agent()
    script = "첫 문장\n둘째 문장"
    request = {"id": "request", "model": model, "prompt": script, "params": voice(),
               "media_protocol": "audio-models-v1", "claim_phase": "claimed", "references": []}
    with patch.object(agent, "_allowed_params", return_value={"dialogue", "stability", "similarity_boost"}), \
         patch.object(agent, "_ensure_request_workspace", return_value=("workspace", None)), \
         patch.object(agent, "_begin_submission", return_value=True) as begin, \
         patch.object(agent, "_run_cli_json", return_value=(["12345678-1234-1234-1234-123456789abc"], None)) as run, \
         patch.object(agent, "_anchor_tracked_safe"):
        assert agent._submit_one("http://test", "token", "fake", "test@example.test", request,
                                 {}, {}, agent.Lock(), agent.Lock(), "agent")
    args = run.call_args.args
    assert "--prompt" not in args
    assert json.loads(args[args.index("--dialogue") + 1]) == [{"text": script, **voice()}]
    assert begin.call_args.args[-1]["params"] == voice()


def test_v4_schema_accepts_stored_voice_fields_for_frontend_and_mcp(monkeypatch):
    async def scenario():
        monkeypatch.setattr(cli, "_CALL_CACHE", {})
        monkeypatch.setattr(cli, "_run_json", AsyncMock(return_value={"params": [
            {"name": "dialogue", "type": "array", "required": True},
            {"name": "stability", "type": "number", "required": False}]}))
        schema = await cli.get_model_params("elevenlabs_v4")
        assert {"voice_id", "voice_type", "dialogue"} <= {p["name"] for p in schema["params"]}
        monkeypatch.setattr(cli, "get_voice", AsyncMock(return_value={"id": "voice-test", "voice_type": "preset"}))
        await cli.validate_media_submission("elevenlabs_v4", "대본", voice(), [])
        cli.get_voice.assert_awaited_once_with("voice-test")
    asyncio.run(scenario())

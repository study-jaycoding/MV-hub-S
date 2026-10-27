"""내레이션 입력·공식 목소리·결과 저장 계약. 실제 생성/외부 조회는 하지 않는다."""
import asyncio
import hashlib
from unittest.mock import AsyncMock

import pytest
from pydantic import ValidationError

from app.models import GenerationCreate, SPEECH_PROMPT_LIMITS
from app.services import cli_bridge as cli
from app.services.media_types import CACHE_MEDIA_EXTENSIONS, media_type_from_url
from app.services.mcp_ingest import mcp_item_to_cli


@pytest.fixture(autouse=True)
def isolated_metadata(monkeypatch, tmp_path):
    monkeypatch.setattr(cli, "_CALL_CACHE", {})
    monkeypatch.setattr(cli, "_PARAM_NAMES_CACHE", {})
    monkeypatch.setattr(cli, "_PARAM_NAMES_SAVED_AT", {})
    monkeypatch.setattr(cli, "_COST_CACHE", {})
    monkeypatch.setattr(cli, "_cost_loaded", True)
    monkeypatch.setattr(cli, "_ensure_cost_writer", lambda: None)


def speech(**overrides):
    data = dict(model="text2speech_v2", prompt="안녕하세요.\n다음 문장입니다.",
                params={"variant": "elevenlabs", "voice_id": "voice-1", "voice_type": "preset"})
    data.update(overrides)
    return data


@pytest.mark.parametrize("variant,limit", SPEECH_PROMPT_LIMITS.items())
def test_speech_limits_are_variant_specific(variant, limit):
    params = {**speech()["params"], "variant": variant}
    assert GenerationCreate(**speech(prompt="가" * limit, params=params)).prompt == "가" * limit
    with pytest.raises(ValidationError):
        GenerationCreate(**speech(prompt="가" * (limit + 1), params=params))


@pytest.mark.parametrize("override", [
    {"params": {"variant": "unknown", "voice_id": "v", "voice_type": "preset"}},
    {"params": {"variant": "elevenlabs", "voice_id": "v", "voice_type": "element"}},
    {"params": {"variant": "elevenlabs", "voice_id": "", "voice_type": "preset"}},
    {"references": [{"file_path": "a.wav", "type": "audio"}]},
    {"params": {**speech()["params"], "language": "fake"}},
])
def test_speech_rejects_unapproved_inputs(override):
    with pytest.raises(ValidationError):
        GenerationCreate(**speech(**override))


@pytest.mark.parametrize("variant", [{}, [], ["elevenlabs"]])
def test_malformed_variant_is_validation_error_not_type_error(variant):
    with pytest.raises(ValidationError):
        GenerationCreate(**speech(params={**speech()["params"], "variant": variant}))


@pytest.mark.parametrize("model_key", ["job_type", "job_set_type", "model"])
def test_extensionless_tts_result_uses_model_evidence(model_key):
    parsed = cli.parse_job({"id": "job", model_key: "text2speech_v2", "params": {},
                            "result_url": "https://cdn.test/audio-object?token=redacted"})
    assert parsed["asset"]["type"] == "audio"
    assert parsed["asset"]["min_result_url"] is None
    assert cli.parse_job({"id": "job", model_key: "other", "params": {},
                          "result_url": "https://cdn.test/object"})["asset"]["type"] == "image"


def test_voice_pages_and_get_validate_preset_and_do_not_invent_compatibility(monkeypatch):
    voice = {"id": "voice-1", "name": "Voice", "category": "voice", "voice_type": "preset"}
    async def scenario():
        run = AsyncMock(side_effect=[{"items": [voice, {"id": "cloned", "voice_type": "element"}], "cursor": "next"}, voice])
        monkeypatch.setattr(cli, "_run_json", run)
        page = await cli.list_voices()
        assert page == {"items": [voice], "cursor": "next"}
        assert await cli.get_voice("voice-1") == voice
        assert await cli.get_voice("voice-1") == voice
        assert run.await_count == 2
        assert run.call_args_list[0].args == ("voices", "list", "--size", "100")
        assert "variant" not in voice
    asyncio.run(scenario())


def test_failed_voice_lookup_is_not_cached_and_never_leaks_response(monkeypatch):
    async def scenario():
        monkeypatch.setattr(cli, "_run_json", AsyncMock(side_effect=cli.CLIError("HTTP 401 secret-token")))
        for _ in range(2):
            with pytest.raises(cli.CLIError, match="목소리를 확인") as error:
                await cli.get_voice("voice-1")
            assert "secret-token" not in str(error.value)
        assert cli._run_json.await_count == 2
    asyncio.run(scenario())


def test_speech_cost_key_contains_prompt_hash_and_cache_separates_text(monkeypatch):
    async def scenario():
        cli._PARAM_NAMES_CACHE["text2speech_v2"] = {"voice_type", "voice_id", "variant"}
        run = AsyncMock(side_effect=[{"credits": 1.2}, {"credits": 2.4}])
        monkeypatch.setattr(cli, "_run_json", run)
        params = speech()["params"]
        assert await cli.estimate_cost("text2speech_v2", params, "private first") == {"credits": 1.2}
        assert await cli.estimate_cost("text2speech_v2", params, "private second") == {"credits": 2.4}
        assert await cli.estimate_cost("text2speech_v2", params, "private first") == {"credits": 1.2}
        keys = list(cli._COST_CACHE)
        assert len(keys) == 2
        assert all("private" not in key for key in keys)
        assert any(hashlib.sha256(b"private first").hexdigest() in key for key in keys)
        assert run.await_count == 2
    asyncio.run(scenario())


@pytest.mark.parametrize("job", [
    {"result_url": "https://cdn.test/a.mp3?signature=x"},
    {"result_url": "https://cdn.test/no-extension", "type": "audio"},
    {"outputs": [{"url": "https://cdn.test/no-extension", "type": "audio"}]},
    {"results": [{"url": "https://cdn.test/a.wav"}]},
])
def test_audio_results_are_audio_assets(job):
    asset = cli.parse_job({"id": "job", "params": {}, **job})["asset"]
    assert asset["type"] == "audio"
    assert ".mp3" in CACHE_MEDIA_EXTENSIONS
    assert media_type_from_url("https://cdn.test/a.m4a?x=1#end") == "audio"


def test_reference_audio_is_never_used_as_generated_result():
    job = {"id": "j", "params": {"medias": [{"data": {"url": "https://cdn.test/input.mp3"}}]}}
    assert cli.parse_job(job)["asset"] is None
    converted = mcp_item_to_cli({"id": "j", "type": "audio", "results": {"minUrl": "https://cdn.test/input.png"}})
    assert converted["result_url"] is None


def test_server_checks_current_schema_and_voice_before_accepting(monkeypatch):
    async def scenario():
        monkeypatch.setattr(cli, "get_model_params", AsyncMock(return_value={"stale": False, "params": [
            {"name": "variant", "enum": ["elevenlabs"]}, {"name": "voice_type", "enum": ["preset", "element"]}, {"name": "voice_id"}]}))
        voice = AsyncMock(return_value={"id": "voice-1", "voice_type": "preset"})
        monkeypatch.setattr(cli, "get_voice", voice)
        await cli.validate_media_submission("text2speech_v2", "hello", speech()["params"], [])
        voice.assert_awaited_once_with("voice-1")
        cli.get_model_params.return_value["stale"] = True
        with pytest.raises(cli.CLIError):
            await cli.validate_media_submission("text2speech_v2", "hello", speech()["params"], [])
    asyncio.run(scenario())

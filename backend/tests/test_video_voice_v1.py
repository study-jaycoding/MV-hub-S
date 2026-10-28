"""오디오 2-B: 보이스 체인지·번역 워크플로 — 유료 호출 없이 저장/견적/제출/결과/게이트 경계를 검사한다."""
import asyncio
import json
import os
import re
import tempfile
from pathlib import Path
from unittest import mock
from unittest.mock import AsyncMock, patch

import pytest

from app import db, repo
from app.models import (DUBBING_LANGUAGES, VIDEO_VOICE_MODELS, VIDEO_VOICE_PARAMS, GenerationCreate,
                        validate_media_request)
from app.repo.gen_requests import _reference_delivery_check
from app.services import cli_bridge as cli
from test_agent_contracts import _load_agent

SHA = "sha256:" + "a" * 64


@pytest.fixture(autouse=True)
def isolated_metadata(monkeypatch):
    for name in ("_CALL_CACHE", "_PARAM_NAMES_CACHE", "_PARAM_NAMES_SAVED_AT", "_PARAM_NAMES_RETRY_AT", "_COST_CACHE"):
        monkeypatch.setattr(cli, name, {})
    monkeypatch.setattr(cli, "_cost_loaded", True)
    monkeypatch.setattr(cli, "_ensure_cost_writer", lambda: None)


def video(**extra):
    return [{"file_path": "C:/clips/source.mp4", "type": "video", "role": "input_video", **extra}]


def ctx(duration=8.4, fps=None, input_ref="C:/clips/source.mp4"):
    return {"duration": duration, **({"fps": fps} if fps is not None else {}), "input_ref": input_ref}


def params_for(model, **cost):
    base = {"voice_id": "voice-test", "voice_type": "preset"} if model == "voice_change" else {"target_language": "kor"}
    return {**base, "cost_context": ctx(**cost)}


def test_definition_parity_with_agent_and_frontend():
    agent = _load_agent()
    assert agent.VIDEO_VOICE_MODELS == VIDEO_VOICE_MODELS
    assert agent.VIDEO_VOICE_PARAMS == VIDEO_VOICE_PARAMS
    assert agent.DUBBING_LANGUAGES == DUBBING_LANGUAGES
    source = (Path(__file__).parents[2] / "frontend/src/lib/spotlightPromptConfig.ts").read_text(encoding="utf-8")
    table = source.split("export const DUBBING_LANGUAGES", 1)[1].split("];", 1)[0]
    assert set(re.findall(r'\["([a-z]{3})"', table)) == DUBBING_LANGUAGES


@pytest.mark.parametrize("model", sorted(VIDEO_VOICE_MODELS))
def test_valid_requests_and_agent_parity(model):
    agent = _load_agent()
    validate_media_request(model, "", params_for(model), video())
    agent._validate_video_voice_request(model, params_for(model), video())
    # 동기화 행의 '(제목 없음)' 프롬프트로 재생성해도 막지 않는다(CLI 로 보내지 않음).
    validate_media_request(model, "(제목 없음)", params_for(model), video())


@pytest.mark.parametrize("model", sorted(VIDEO_VOICE_MODELS))
@pytest.mark.parametrize("refs", [
    [], video() * 2, [{"file_path": "x.png", "type": "image", "role": "input_video"}],
    [{"file_path": "x.mp4", "type": "video", "role": "video"}], [{"file_path": "", "type": "video", "role": "input_video"}],
], ids=["none", "two", "image", "wrong-role", "no-file"])
def test_one_video_only_same_message_server_and_agent(model, refs):
    agent = _load_agent()
    with pytest.raises(ValueError, match="영상 1개를 넣으세요"):
        validate_media_request(model, "", params_for(model), refs)
    with pytest.raises(ValueError, match="영상 1개를 넣으세요"):
        agent._validate_video_voice_request(model, params_for(model), refs)
    assert agent._refs_for_cli(model, refs) == ([], "영상 1개를 넣으세요")


@pytest.mark.parametrize("model,params,message", [
    ("voice_change", {"voice_id": "v", "voice_type": "element", "cost_context": ctx()}, "프리셋"),
    ("voice_change", {"voice_type": "preset", "cost_context": ctx()}, "프리셋"),
    ("dubbing", {"target_language": "xx", "cost_context": ctx()}, "언어"),
    ("dubbing", {"target_language": "kor", "prompt_extra": 1, "cost_context": ctx()}, "옵션"),
    ("voice_change", {"voice_id": "v", "voice_type": "preset"}, "길이"),
    ("voice_change", {"voice_id": "v", "voice_type": "preset", "cost_context": ctx(duration=0)}, "길이"),
    ("voice_change", {"voice_id": "v", "voice_type": "preset", "cost_context": ctx(fps=25)}, "길이"),
    ("dubbing", {"target_language": "kor", "cost_context": ctx(fps=True)}, "길이"),
    ("dubbing", {"target_language": "kor", "cost_context": {"duration": 4}}, "길이"),
])
def test_invalid_options(model, params, message):
    with pytest.raises(ValueError, match=message):
        validate_media_request(model, "", params, video())


def test_create_allows_empty_prompt_only_for_workflows_and_checks_input_ref():
    GenerationCreate(prompt="", model="dubbing", params=params_for("dubbing"), references=video())
    GenerationCreate(prompt="", model="dubbing", params=params_for("dubbing", input_ref=SHA), references=video(asset_content_id=SHA))
    with pytest.raises(ValueError, match="프롬프트"):
        GenerationCreate(prompt="", model="nano_banana_2")
    with pytest.raises(ValueError, match="지금 넣은 영상과 다릅니다"):
        GenerationCreate(prompt="", model="dubbing", params=params_for("dubbing", input_ref="C:/clips/other.mp4"), references=video())


@pytest.mark.parametrize("model", sorted(VIDEO_VOICE_MODELS))
def test_mcp_plans_are_rejected_not_half_supported(model):
    """MCP 지원은 범위 밖(2-B 재합의 2차) — 빈 prompt 계획 항목은 받지 않고, 글을 넣어 와도 MCP 레퍼런스 역할(@Video1)·
    견적 문맥 없음으로 생성 요청이 되지 않는다(조용히 반쯤 실행되지 않는다)."""
    from pydantic import ValidationError
    from app.routers.mcp_v2 import PlanItem
    with pytest.raises(ValidationError):
        PlanItem(label="Cut", prompt="", model=model)
    PlanItem(label="Cut", prompt="x", model=model)  # 계획 항목 형식만으로는 통과하지만
    with pytest.raises(ValueError):  # 생성 요청 검증에서 막힌다
        GenerationCreate(prompt="x", model=model, params={k: v for k, v in params_for(model).items() if k != "cost_context"},
                         references=[{"file_path": "x.mp4", "type": "video", "role": "@Video1"}])


def test_estimate_uses_only_cost_params_without_prompt_or_files(monkeypatch):
    async def scenario():
        monkeypatch.setattr(cli, "_run_json", AsyncMock(side_effect=[{"credits": 1}, {"credits": 29}, {"credits": 3}]))
        assert (await cli.estimate_cost("voice_change", params_for("voice_change", duration=8)))["credits"] == 1
        assert (await cli.estimate_cost("dubbing", params_for("dubbing", duration=8.4, fps=30)))["credits"] == 29
        assert (await cli.estimate_cost("voice_change", params_for("voice_change", duration=30)))["credits"] == 3
        calls = [c.args for c in cli._run_json.call_args_list]
        assert calls[0] == ("generate", "cost", "workflow", "voice_change", "--duration", "8")
        assert calls[1] == ("generate", "cost", "workflow", "dubbing", "--duration", "8.4", "--fps", "30")
        # 같은 길이는 캐시, 다른 길이는 다른 값(이전 영상 가격을 쓰지 않음)
        assert (await cli.estimate_cost("voice_change", params_for("voice_change", duration=8)))["credits"] == 1
        assert cli._run_json.await_count == 3
        with pytest.raises(cli.CLIError, match="길이"):
            await cli.estimate_cost("dubbing", {"target_language": "kor"})
    asyncio.run(scenario())


def test_workflow_schema_and_submission_validation(monkeypatch):
    async def scenario():
        monkeypatch.setattr(cli, "_run_json", AsyncMock(return_value={"params": [
            {"name": "folder_id"}, {"name": "input_video"}, {"name": "voice_id"},
            {"name": "voice_type", "enum": ["preset", "element"]}], "cost_params": [{"name": "duration"}]}))
        monkeypatch.setattr(cli, "get_voice", AsyncMock(return_value={"id": "voice-test", "voice_type": "preset"}))
        await cli.validate_media_submission("voice_change", "", params_for("voice_change"), video())
        assert cli._run_json.call_args.args[:3] == ("workflow", "get", "voice_change")
        cli.get_voice.assert_awaited_once_with("voice-test")
    asyncio.run(scenario())


@pytest.mark.parametrize("model", sorted(VIDEO_VOICE_MODELS))
def test_extensionless_result_is_video_and_input_object_is_not_stored(model):
    job = {"id": "job", "job_type": model, "result_url": "https://cdn.example.test/object",
           "params": {"input_video": {"id": "u1", "url": "https://x/in.mp4"}, "folder_id": None,
                      **{k: v for k, v in params_for(model).items() if k != "cost_context"}}}
    parsed = cli.parse_job(job)
    assert parsed["asset"]["type"] == "video"
    assert set(parsed["generation"]["params"]) == VIDEO_VOICE_PARAMS[model] - {"cost_context"}


def test_reference_observation_keeps_input_video_role():
    result = _reference_delivery_check(
        [{"upload_id": "upload-1", "role": "input_video", "type": "video"}],
        {"params": {"input_video": {"id": "upload-1", "type": "video"}}},
    )
    assert result["observed_refs"] == [{"position": 0, "type": "video", "role": "input_video", "upload_id": "upload-1"}]


@pytest.mark.parametrize("model", sorted(VIDEO_VOICE_MODELS))
def test_agent_submits_workflow_with_input_video_and_no_prompt_or_cost_context(model, tmp_path):
    agent = _load_agent()
    clip = tmp_path / "source.mp4"
    clip.write_bytes(b"video-bytes")
    request = {"id": "request", "model": model, "prompt": "", "params": params_for(model),
               "media_protocol": "video-voice-v1", "claim_phase": "claimed", "references": video()}
    with patch.object(agent, "_allowed_params", return_value={"folder_id", "input_video", "voice_id", "voice_type", "target_language"}), \
         patch.object(agent, "_ensure_request_workspace", return_value=("workspace", None)), \
         patch.object(agent, "_begin_submission", return_value=True) as begin, \
         patch.object(agent, "_run_cli_json", return_value=(["12345678-1234-1234-1234-123456789abc"], None)) as run, \
         patch.object(agent, "_anchor_tracked_safe"):
        tracked = agent._submit_one("http://test", "token", "fake", "test@example.test", request,
                                    {"C:/clips/source.mp4": str(clip)}, {}, agent.Lock(), agent.Lock(), "agent")
    assert tracked["expected_image_inputs"] == 0
    args = run.call_args.args[1:]
    assert args[:3] == ("generate", "workflow", model)
    assert "--prompt" not in args and "--cost_context" not in args and "cost_context" not in " ".join(args)
    assert args[args.index("--input-video") + 1] == str(clip)
    fingerprint = begin.call_args.args[-1]
    assert "cost_context" not in fingerprint["params"]
    assert fingerprint["submitted_refs"][0]["role"] == "input_video"


@pytest.mark.parametrize("protocol", [None, "media-v2", "audio-models-v1"])
def test_agent_refuses_request_without_video_voice_protocol(protocol):
    agent = _load_agent()
    request = {"id": "request", "model": "dubbing", "prompt": "", "params": params_for("dubbing"),
               "media_protocol": protocol, "claim_phase": "claimed", "references": video()}
    with patch.object(agent, "_allowed_params", return_value={"input_video", "target_language"}), \
         patch.object(agent, "_fail") as fail, patch.object(agent, "_run_cli_json") as run:
        assert agent._submit_one("http://test", "token", "fake", "test@example.test", request,
                                 {}, {}, agent.Lock(), agent.Lock(), "agent") is None
    run.assert_not_called()
    assert "보이스 체인지·번역" in fail.call_args.args[-1]


class TestCreateUsecase:
    def setup_method(self):
        self.tmp = tempfile.TemporaryDirectory(ignore_cleanup_errors=True)
        self.old_db = os.environ.get("CONTENT_HUB_DB")
        os.environ["CONTENT_HUB_DB"] = str(Path(self.tmp.name) / "content_hub.db")
        db.flush_pool()
        db.init_db()
        repo.ensure_default_worker()

    def teardown_method(self):
        db.flush_pool()
        if self.old_db is None:
            os.environ.pop("CONTENT_HUB_DB", None)
        else:
            os.environ["CONTENT_HUB_DB"] = self.old_db
        db.flush_pool()
        self.tmp.cleanup()

    @pytest.mark.parametrize("model", sorted(VIDEO_VOICE_MODELS))
    def test_create_marks_protocol_keeps_cost_context_and_resend_is_idempotent(self, model):
        from app.usecases.gen_requests import GenRequestCommand, submit_gen_request
        data = GenerationCreate(prompt="", model=model, params=params_for(model), references=video()).model_dump()

        def submit():
            command = GenRequestCommand(kind="create", email="artist@example.com", creator_uid="artist", worker_id="me",
                                        source_gen_id=None, workspace={"scope": "personal", "id": None, "name": None},
                                        data=data, idempotency_key="33333333-3333-4333-8333-333333333333")
            with mock.patch("app.usecases.gen_requests.MANAGE_ENABLED", False), \
                 mock.patch("app.usecases.gen_requests.agent_signals.signal"), \
                 mock.patch("app.usecases.gen_requests.journal_generation_event"):
                return asyncio.run(submit_gen_request(command))

        first, second = submit(), submit()
        assert first == second
        with db.get_connection() as conn:
            rows = conn.execute("SELECT payload FROM gen_request WHERE account_email=?", ("artist@example.com",)).fetchall()
        assert len(rows) == 1
        payload = json.loads(rows[0]["payload"])
        assert payload["media_protocol"] == "video-voice-v1"
        assert payload["params"]["cost_context"] == ctx()
        assert [(r["type"], r["role"]) for r in payload["references"]] == [("video", "input_video")]

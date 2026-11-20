"""업스케일(크게 보기 [⤢ Upscale]) — 에이전트 제출 인자·견적 인자·서버 검사. CLI 는 가짜(유료 호출 없음).
설계: docs/status/업스케일_크게보기_2026-11-20.md (CLI 1.2.2 실측: 업스케일은 --prompt 거절, 원본은 *_references 하나)."""
import asyncio
import hashlib
import importlib.util
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest
from pydantic import ValidationError

from app.models import UPSCALE_MODELS, GenerationCreate
from app.services import cli_bridge as cli

JOB = "12345678-1234-1234-1234-123456789abc"
VIDEO_JOB = "9abf27e3-e932-4f39-87b0-3c278c6b21c8"


def load_agent():
    path = Path(__file__).resolve().parents[2] / "agent_push.py"
    spec = importlib.util.spec_from_file_location("upscale_agent", path)
    agent = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(agent)
    return agent


def test_agent_and_backend_list_the_same_upscale_models():
    assert load_agent().UPSCALE_MODELS == UPSCALE_MODELS


# ── 에이전트 제출(가짜 CLI) ──

@pytest.fixture
def harness(monkeypatch, tmp_path):
    agent = load_agent()
    files = {"src.mp4": tmp_path / "src.mp4", "src.png": tmp_path / "src.png"}
    for path in files.values():
        path.write_bytes(b"media")
    cache = {name: str(path) for name, path in files.items()}
    allowed = {"bytedance_video_upscale": {"fps", "model_version", "preset", "resolution", "video_references"},
               "topaz_image": {"output_width", "output_height", "variant", "face_enhancement", "image_references"},
               "nano_banana_flash": {"prompt", "resolution", "image_references"}}
    monkeypatch.setattr(agent, "_allowed_params", lambda _cli, model: allowed[model])
    monkeypatch.setattr(agent, "_ensure_request_workspace", lambda *_: ("workspace-1", None))
    begin = MagicMock(return_value=True)
    monkeypatch.setattr(agent, "_begin_submission", begin)
    run = MagicMock(return_value=([JOB], None))
    monkeypatch.setattr(agent, "_run_cli_json", run)
    monkeypatch.setattr(agent, "_anchor_tracked_safe", MagicMock())
    for name in ("_fail", "_release_claim", "_require_submission_recovery"):
        monkeypatch.setattr(agent, name, MagicMock())

    def submit(model, prompt, params, references):
        request = {"id": "r1", "model": model, "prompt": prompt, "params": params, "claim_phase": "claimed",
                   "workspace": {"scope": "personal", "id": None, "name": None}, "references": references}
        return agent._submit_one("http://hub", "token", "fake-cli", "artist@example.com", request,
                                 cache, {}, agent.Lock(), agent.Lock(), "agent-1")

    return SimpleNamespace(agent=agent, cache=cache, begin=begin, run=run, submit=submit)


def cli_args(run):
    return list(run.call_args.args)


@pytest.mark.parametrize("role", ["video_references", "@Video1", "video"])  # 화면 · MCP 계획 · 동기화본
def test_video_upscale_sends_the_source_as_video_references_without_prompt(harness, role):
    h = harness
    result = h.submit("bytedance_video_upscale", "(no text)",
                      {"resolution": "2k", "preset": "aigc", "fps": 24, "model_version": "standard"},
                      [{"file_path": "src.mp4", "type": "video", "role": role}])
    assert result["job_id"] == JOB
    args = cli_args(h.run)
    assert args[args.index("--video-references") + 1] == h.cache["src.mp4"]
    assert "--prompt" not in args and "--video" not in args and "--image" not in args
    assert args[args.index("--resolution") + 1] == "2k" and args[args.index("--preset") + 1] == "aigc"
    fingerprint = h.begin.call_args.args[4]
    assert fingerprint["prompt_sha256"] == hashlib.sha256(b"").hexdigest()
    assert [ref["role"] for ref in fingerprint["submitted_refs"]] == ["video"]  # 서버 전달 확인의 관측 표기와 같게
    assert fingerprint["reference_roles"] == ["video"]  # 복구 대조는 종류로
    h.agent._fail.assert_not_called()


@pytest.mark.parametrize("prompt", ["(no text)", "(제목 없음)", "make it sharp"])  # 자리표시 · 동기화본 · 재생성 덮어쓰기
def test_image_upscale_never_sends_a_prompt(harness, prompt):
    h = harness
    h.submit("topaz_image", prompt, {"output_width": 2560, "output_height": 1440, "variant": "Standard V2", "face_enhancement": False},
             [{"file_path": "src.png", "type": "image", "role": "@Image1"}])
    args = cli_args(h.run)
    assert "--prompt" not in args
    assert args[args.index("--image-references") + 1] == h.cache["src.png"]
    assert args[args.index("--output_width") + 1] == "2560" and args[args.index("--output_height") + 1] == "1440"
    h.agent._fail.assert_not_called()


@pytest.mark.parametrize("references", [
    [],
    [{"file_path": "src.png", "type": "image", "role": "image_references"}],  # 영상 모델에 이미지
    [{"file_path": "src.mp4", "type": "video", "role": "video_references"}] * 2,
])
def test_upscale_without_exactly_one_matching_source_fails_before_the_cli(harness, references):
    h = harness
    assert h.submit("bytedance_video_upscale", "(no text)", {"resolution": "2k"}, references) is None
    h.run.assert_not_called()
    h.agent._fail.assert_called_once()
    assert "원본 영상 1개" in h.agent._fail.call_args.args[3]


def test_other_models_keep_their_prompt_and_flags(harness):
    h = harness
    h.submit("nano_banana_flash", "a cat", {"resolution": "2k"}, [{"file_path": "src.png", "type": "image", "role": "@Image1"}])
    args = cli_args(h.run)
    assert args[args.index("--prompt") + 1] == "a cat"
    assert args[args.index("--image") + 1] == h.cache["src.png"] and "--image-references" not in args


@pytest.mark.parametrize("medias", [None, [{"role": "video"}], [{"role": "video_references"}], [{"data": {"type": "video"}}]])
def test_recovery_matches_an_upscale_job_whose_listing_has_no_prompt(medias):
    agent = load_agent()
    refs = [{"type": "video", "role": "video_references"}]
    fingerprint = agent._submission_fingerprint("topaz_video", "", {"resolution": "2160p"}, {"resolution"}, refs)
    request = {"fingerprint": fingerprint, "submission_started_at": 1_000.0}
    params = {"resolution": "2160p", **({"medias": medias} if medias is not None else {})}
    job = {"id": JOB, "job_set_type": "topaz_video", "params": params, "created_at": 1_001.0}
    assert agent._matches_submission_fingerprint(request, job)
    # 원본이 이미지로 적힌 응답은 같은 작업이 아니다
    assert not agent._matches_submission_fingerprint(request, {**job, "params": {"resolution": "2160p", "medias": [{"role": "image"}]}})
    # 다른 모델은 그대로 — 응답에 prompt 가 없으면 대조하지 않고, 역할도 원래 표기로 비교한다
    other = agent._submission_fingerprint("kling4_0", "", {"resolution": "720p"}, {"resolution"}, refs)
    assert other["reference_roles"] == ["videoreferences"]
    assert not agent._matches_submission_fingerprint({**request, "fingerprint": other},
                                                     {**job, "job_set_type": "kling4_0", "params": {"resolution": "720p"}})


# ── 견적 인자 ──

def _fresh_caches(monkeypatch):
    monkeypatch.setattr(cli, "_CALL_CACHE", {})
    monkeypatch.setattr(cli, "_PARAM_NAMES_CACHE", {})
    monkeypatch.setattr(cli, "_PARAM_NAMES_SAVED_AT", {})
    monkeypatch.setattr(cli, "_COST_CACHE", {})
    monkeypatch.setattr(cli, "_cost_loaded", True)
    monkeypatch.setattr(cli, "_ensure_cost_writer", lambda: None)


def _schema(job_type, *names):
    return {"job_type": job_type, "type": "image", "params": [{"name": n} for n in names]}


def test_image_upscale_cost_has_no_prompt_and_a_placeholder_source(monkeypatch):
    async def scenario():
        _fresh_caches(monkeypatch)
        run = AsyncMock(side_effect=[_schema("bytedance_image_upscale", "image_references", "remove_bg", "resolution"), {"credits": 2}])
        monkeypatch.setattr(cli, "_run_json", run)
        await cli.get_model_params("bytedance_image_upscale")
        assert await cli.estimate_cost("bytedance_image_upscale", {"resolution": "4k", "remove_bg": False}, "(no text)") == {"credits": 2}
        args = run.call_args_list[-1].args
        assert args[:3] == ("generate", "cost", "bytedance_image_upscale") and "--prompt" not in args
        assert args[args.index("--image-references") + 1] == cli._COST_DUMMY_REF
    asyncio.run(scenario())


def test_video_upscale_cost_uses_the_real_video_and_refuses_without_it(monkeypatch):
    async def scenario():
        _fresh_caches(monkeypatch)
        run = AsyncMock(side_effect=[_schema("bytedance_video_upscale", "resolution", "fps", "video_references"), {"credits": 4}])
        monkeypatch.setattr(cli, "_run_json", run)
        await cli.get_model_params("bytedance_video_upscale")
        assert await cli.estimate_cost("bytedance_video_upscale", {"resolution": "4k"}, video_ref=VIDEO_JOB) == {"credits": 4}
        args = run.call_args_list[-1].args
        assert args[args.index("--video-references") + 1] == VIDEO_JOB and "--prompt" not in args
        calls = run.call_count
        with pytest.raises(cli.CLIError):  # MCP·요청 장부처럼 원본 id 가 없으면 가짜 원본으로 틀린 값을 내지 않는다
            await cli.estimate_cost("topaz_hyperion_2_5", {"output_format": "h265"})
        assert run.call_count == calls
    asyncio.run(scenario())


@pytest.mark.parametrize("model", ["topaz_image", "topaz_image_generative", "topaz_video"])
def test_topaz_cost_is_unavailable_without_calling_the_cli(monkeypatch, model):
    async def scenario():
        _fresh_caches(monkeypatch)
        run = AsyncMock()
        monkeypatch.setattr(cli, "_run_json", run)
        with pytest.raises(cli.CLIError):
            await cli.estimate_cost(model, {"output_width": 2048, "output_height": 2048}, video_ref=VIDEO_JOB)
        run.assert_not_called()
    asyncio.run(scenario())


# ── 서버 검사(생성 요청) ──

def _create(model, references, prompt="(no text)"):
    return GenerationCreate(prompt=prompt, model=model, params={}, references=references)


@pytest.mark.parametrize("role", ["image_references", "@Image1"])  # 화면 · MCP 계획 — 역할은 보지 않는다
def test_upscale_request_accepts_one_source_of_the_right_kind(role):
    assert _create("topaz_image", [{"file_path": "C:/a.png", "type": "image", "role": role}]).model == "topaz_image"


@pytest.mark.parametrize("model,references", [
    ("topaz_image", []),
    ("topaz_image", [{"file_path": "C:/a.mp4", "type": "video", "role": "video_references"}]),
    ("bytedance_video_upscale", [{"file_path": "C:/a.mp4", "type": "video", "role": "video"}] * 2),
])
def test_upscale_request_rejects_a_wrong_source(model, references):
    with pytest.raises(ValidationError, match="업스케일에는 원본"):
        _create(model, references)

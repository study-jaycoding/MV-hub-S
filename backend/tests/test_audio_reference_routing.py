"""오디오 레퍼런스가 에이전트에서 CLI 의 --audio-references 로 나가는지(가짜 CLI — 과금 없음).

프런트가 만든 본문의 오디오(type audio · @AudioN, Seed Audio 는 audio_references)를 그대로 받는다
(frontend/tests/audioReferenceRouting.test.ts). 기록: docs/status/오디오_레퍼런스_검수_2026-10-28.md
"""
import asyncio
import importlib.util
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from fastapi import HTTPException
from pydantic import ValidationError

from app.models import GenRequestIn, RegenerateIn, validate_media_request
from app.routers import gen_requests as routes
from app.routers import mcp_v2

AUDIO_ONLY = "오디오 레퍼런스는 이미지나 영상 레퍼런스와 함께 넣어야 합니다 — Seedance 2.0·Mini 는 오디오만으로 만들 수 없습니다."


def refs(*kinds):
    return [{"file_path": f"ref{i}.{ {'image': 'png', 'video': 'mp4', 'audio': 'mp3'}[kind] }", "type": kind,
             "role": f"@{kind.capitalize()}{i + 1}"} for i, kind in enumerate(kinds)]


def load_agent():
    path = Path(__file__).resolve().parents[2] / "agent_push.py"
    spec = importlib.util.spec_from_file_location("audio_reference_agent", path)
    agent = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(agent)
    return agent


@pytest.mark.parametrize("model,refs,expected", [
    ("seedance_2_5", [("still.png", "image", "@Image1"), ("line.mp3", "audio", "@Audio1")],
     ["--image-references", "up-1", "--audio-references", "up-2"]),
    ("seedance_2_0", [("still.png", "image", "@Image1"), ("line.mp3", "audio", "@Audio1")],
     ["--image-references", "up-1", "--audio-references", "up-2"]),
    ("seedance_2_0_mini", [("clip.mp4", "video", "@Video1"), ("line.mp3", "audio", "@Audio1")],
     ["--video-references", "up-1", "--audio-references", "up-2"]),
    ("seed_audio", [("line.mp3", "audio", "audio_references")], ["--audio-references", "LOCAL:line.mp3"]),
])
def test_audio_reference_reaches_cli_as_audio(model, refs, expected, monkeypatch, tmp_path):
    agent = load_agent()
    cache = {}
    for name, _, _ in refs:
        (tmp_path / name).write_bytes(b"fake-" + name.encode())
        cache[name] = str(tmp_path / name)
    uploads = iter(["up-1", "up-2", "up-3"])
    monkeypatch.setattr(agent, "_upload_for_media", lambda *_: ({"id": next(uploads), "type": "media_input"}, False))
    monkeypatch.setattr(agent, "_allowed_params", lambda *_: {"duration", "mode", "format"})
    monkeypatch.setattr(agent, "_ensure_request_workspace", lambda *_: ("workspace-1", None))
    monkeypatch.setattr(agent, "_begin_submission", MagicMock(return_value=True))
    monkeypatch.setattr(agent, "_anchor_tracked_safe", MagicMock())
    monkeypatch.setattr(agent, "_fail", MagicMock())
    run = MagicMock(return_value=(["12345678-1234-1234-1234-123456789abc"], None))
    monkeypatch.setattr(agent, "_run_cli_json", run)
    request = {"id": "request-1", "model": model, "prompt": "말한다 <<<audio1>>>", "params": {"duration": 4},
               "references": [{"file_path": name, "type": kind, "role": role} for name, kind, role in refs],
               "workspace": {"scope": "personal", "id": None, "name": None}, "claim_phase": "claimed"}
    if model == "seed_audio":
        request.update(params={}, media_protocol="audio-models-v1")
    result = agent._submit_one("http://hub", "token", "fake-cli", "artist@example.com", request,
                               cache, {}, agent.Lock(), agent.Lock(), "agent-1")
    agent._fail.assert_not_called()
    assert result and result["job_id"] == "12345678-1234-1234-1234-123456789abc"
    args = list(run.call_args.args)
    pairs = [x for i, a in enumerate(args) if a.startswith("--") and a.endswith("-references") for x in (a, args[i + 1])]
    expected = [cache[e[6:]] if e.startswith("LOCAL:") else e for e in expected]
    assert pairs == expected
    # 오디오는 이미지 입력 수(사후 부착 검증)에 들어가지 않는다
    assert result["expected_image_inputs"] == sum(kind == "image" for _, kind, _ in refs)


# ── 서버도 막는다(Codex 점검 G): 재생성·MCP 는 프런트 검사를 거치지 않는다. CLI 가 작업 id 없이 거부하면
#    에이전트는 카드를 '제출 확인 필요'로 격리하므로(agent_push.py) 서버가 제출 전에 막아야 한다.
@pytest.mark.parametrize("model,kinds,error", [
    ("seedance_2_0", ["audio"], AUDIO_ONLY),
    ("seedance_2_0_mini", ["audio", "audio"], AUDIO_ONLY),
    ("seedance_2_0_mini", ["image", "audio", "audio", "audio", "audio"], "오디오 레퍼런스는 3개까지 넣을 수 있습니다 — 지금 4개입니다."),
    ("seedance_2_0", ["image", "audio", "audio", "audio"], None),
    ("seedance_2_0_mini", ["video", "audio"], None),
    ("seedance_2_5", ["audio"], None),
])
def test_shared_validation_has_seedance_audio_rules(model, kinds, error):
    if error:
        with pytest.raises(ValueError, match=error):
            validate_media_request(model, "p", {}, refs(*kinds))
    else:
        validate_media_request(model, "p", {}, refs(*kinds))


def test_create_body_rejects_audio_only_seedance_mini():
    with pytest.raises(ValidationError, match="오디오만으로"):
        GenRequestIn(kind="create", workspace={"scope": "personal"},
                     create={"prompt": "p", "model": "seedance_2_0_mini", "references": refs("audio")})


@pytest.mark.parametrize("kinds,rejected", [(["audio"], True), (["image", "audio"], False)])
def test_regenerate_route_rejects_before_creating_anything(kinds, rejected):
    body = GenRequestIn(kind="regenerate", source_gen_id="local-123", regenerate=RegenerateIn(), workspace={"scope": "personal"})
    submit = AsyncMock(side_effect=RuntimeError("reached submit"))
    recipe = {"model": "seedance_2_0_mini", "prompt": "p", "params": {}, "references": refs(*kinds)}
    with patch.object(routes, "update_in_progress", return_value=False), \
         patch.object(routes, "_require_account", return_value={"email": "artist@example.invalid", "creator_uid": "artist"}), \
         patch.object(routes, "expected_account_differs", return_value=False), \
         patch.object(routes, "AUTH_ENABLED", False), \
         patch.object(routes, "_require_generation_deployment_open", AsyncMock()), \
         patch.object(routes, "require_view_generation"), \
         patch.object(routes.repo, "get_generation", return_value={"id": "local-123", "model": "seedance_2_0_mini", "project_id": None, "worker_id": "me"}), \
         patch.object(routes.repo, "get_recovery_request_id_for_generation", return_value=None), \
         patch.object(routes.repo, "gen_recipe", return_value=recipe), \
         patch.object(routes, "submit_gen_request", submit):
        if rejected:
            with pytest.raises(HTTPException) as error:
                asyncio.run(routes.create_gen_request(body, SimpleNamespace()))
            assert error.value.status_code == 422 and error.value.detail == AUDIO_ONLY
            assert error.value.headers == routes.NOT_STARTED
            submit.assert_not_awaited()
        else:
            with pytest.raises(RuntimeError, match="reached submit"):
                asyncio.run(routes.create_gen_request(body, SimpleNamespace()))


@pytest.mark.parametrize("kinds,rejected", [(["audio"], True), (["video", "audio"], False)])
def test_mcp_plan_rejects_at_prepare(monkeypatch, kinds, rejected):
    async def models(*_args):
        return [{"job_set_type": "seedance_2_0_mini"}]

    async def schema(_model):
        return {"params": [{"name": "duration", "type": "integer"}]}

    monkeypatch.setattr(mcp_v2, "_models", models)
    monkeypatch.setattr(mcp_v2.generation, "model_params", schema)
    monkeypatch.setattr(mcp_v2, "_workspace", lambda *_args: {"scope": "personal", "id": None})
    monkeypatch.setattr(mcp_v2, "_references", lambda *_args: refs(*kinds))
    monkeypatch.setattr(mcp_v2, "_still_current", lambda *_args: None)
    item = {"model": "seedance_2_0_mini", "params": {"duration": 4}, "reference_ids": ["r"] * len(kinds)}
    if rejected:
        with pytest.raises(HTTPException) as error:
            asyncio.run(mcp_v2._validate_items(None, [item], {}))
        assert error.value.status_code == 422
        assert error.value.headers == {"X-MVHub-MCP-Error": "invalid_input"}
    else:
        asyncio.run(mcp_v2._validate_items(None, [item], {}))
        assert [ref["type"] for ref in item["references"]] == kinds

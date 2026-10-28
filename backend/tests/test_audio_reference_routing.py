"""오디오 레퍼런스가 에이전트에서 CLI 의 --audio-references 로 나가는지(가짜 CLI — 과금 없음).

프런트가 만든 본문의 오디오(type audio · @AudioN, Seed Audio 는 audio_references)를 그대로 받는다
(frontend/tests/audioReferenceRouting.test.ts). 기록: docs/status/오디오_레퍼런스_검수_2026-10-28.md
"""
import importlib.util
from pathlib import Path
from unittest.mock import MagicMock

import pytest


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

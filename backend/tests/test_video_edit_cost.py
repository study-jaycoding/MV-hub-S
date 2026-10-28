"""영상 수정 견적 — 고칠 영상의 힉스필드 작업 id(video_ref)를 영상 수정 모델 견적에만 --video-references 로 붙이고,
값이 영상 길이를 따르므로 견적 캐시를 영상별로 나눈다(Jay 2026-10-28 '작업 id 견적 넣기'). CLI 는 가짜."""
import asyncio
from unittest.mock import AsyncMock

import pytest
from pydantic import ValidationError

from app.routers.generation import CostIn
from app.services import cli_bridge as cli

V4 = "9abf27e3-e932-4f39-87b0-3c278c6b21c8"
V8 = "fb3d63c1-5e0c-4edb-bd9c-7b2914ffbe9b"


def _fresh_caches(monkeypatch):
    monkeypatch.setattr(cli, "_CALL_CACHE", {})
    monkeypatch.setattr(cli, "_PARAM_NAMES_CACHE", {})
    monkeypatch.setattr(cli, "_PARAM_NAMES_SAVED_AT", {})
    monkeypatch.setattr(cli, "_COST_CACHE", {})
    monkeypatch.setattr(cli, "_cost_loaded", True)
    monkeypatch.setattr(cli, "_ensure_cost_writer", lambda: None)


def _schema(job_type, *names):
    return {"job_type": job_type, "type": "video", "params": [{"name": n} for n in names]}


def test_video_edit_cost_sends_the_video_and_keys_cache_by_video(monkeypatch):
    async def scenario():
        _fresh_caches(monkeypatch)
        run = AsyncMock(side_effect=[_schema("kling_video_edit", "mode", "prompt", "video_references", "image_references"),
                                     {"credits": 8}, {"credits": 16}])
        monkeypatch.setattr(cli, "_run_json", run)
        await cli.get_model_params("kling_video_edit")
        four = await cli.estimate_cost("kling_video_edit", {"mode": "pro"}, video_ref=V4)
        eight = await cli.estimate_cost("kling_video_edit", {"mode": "pro"}, video_ref=V8)
        again = await cli.estimate_cost("kling_video_edit", {"mode": "pro"}, video_ref=V4)  # 같은 영상 = 캐시
        assert (four, eight, again) == ({"credits": 8}, {"credits": 16}, {"credits": 8})
        costs = [call.args for call in run.call_args_list if call.args[:2] == ("generate", "cost")]
        assert len(costs) == 2
        assert [args[args.index("--video-references") + 1] for args in costs] == [V4, V8]
        assert costs[0][costs[0].index("--mode") + 1] == "pro"
    asyncio.run(scenario())


def test_video_ref_is_ignored_for_models_that_do_not_edit_a_video(monkeypatch):
    async def scenario():
        _fresh_caches(monkeypatch)
        run = AsyncMock(side_effect=[_schema("nano_banana_flash", "prompt", "resolution"), {"credits": 1.5}])
        monkeypatch.setattr(cli, "_run_json", run)
        await cli.get_model_params("nano_banana_flash")
        assert await cli.estimate_cost("nano_banana_flash", {"resolution": "2k"}, "x", video_ref=V4) == {"credits": 1.5}
        assert "--video-references" not in run.call_args_list[-1].args
    asyncio.run(scenario())


@pytest.mark.parametrize("bad", ["../etc/passwd", "--mode", "9abf27e3", "9abf27e3-e932-4f39-87b0-3c278c6b21c8 --x"])
def test_video_ref_must_be_a_uuid(bad):
    with pytest.raises(ValidationError):
        CostIn(model="kling_video_edit", video_ref=bad)
    assert CostIn(model="kling_video_edit", video_ref=V4).video_ref == V4

"""Diagnostic boundaries only; no browser, server or existing data is touched."""
import importlib.util
from pathlib import Path

import pytest

spec = importlib.util.spec_from_file_location("camera_compare", Path(__file__).parents[1] / "browser_measure/camera_compare.py")
camera = importlib.util.module_from_spec(spec)
spec.loader.exec_module(camera)


def test_fixture_is_repeatable_and_has_no_external_references():
    scene = camera.fixture()
    assert scene == camera.fixture()
    assert len(scene["cards"]) == len({c["id"] for c in scene["cards"]}) == 2000
    assert all(c["kind"] == "text" and set(c) == {"id", "kind", "x", "y", "w", "h", "text"} for c in scene["cards"])


@pytest.mark.parametrize("url,method", [
    ("http://192.168.1.171:8010/api/scenes/backup", "PUT"),
    ("http://127.0.0.1:8012/api/scenes/backup", "PUT"),
    ("http://127.0.0.1:54321/api/gen-requests", "POST"),
    ("http://127.0.0.1:54321/api/resolve/status", "GET"),
    ("http://127.0.0.1:54321/api/projects", "POST"),
])
def test_external_and_non_scene_writes_blocked(url, method):
    assert not camera.allowed_request(url, method, {"http://127.0.0.1:54321"})


def test_owned_scene_write_allowed():
    assert camera.allowed_request("http://127.0.0.1:54321/api/scenes/backup", "PUT", {"http://127.0.0.1:54321"})


def test_input_window_and_event_counts_keep_boundary_frames():
    probe = {"wheel": [10, 20], "gaps": [[0, 11], [110, 150], [151, 190]],
             "events": [[9, "camera", 0], [15, "tx_start", 0], [19, "bake", 2]],
             "idb": [[9, 12], [120, 121]], "net": [[5, 0]]}
    result = camera.op_result(probe, 9, 21)
    assert result["wheel_events"] == 2 and result["gaps33"] == 2
    assert result["events"]["camera"] == 0 and result["events"]["tx_start"] == 1
    assert result["baked_frames"] == 1 and result["idb_overlap"] == result["net_overlap"] == 1


def test_changed_or_missing_anchor_cannot_silently_change_observation(tmp_path):
    path = tmp_path / "source.ts"
    path.write_text("same\nsame", encoding="utf-8")
    with pytest.raises(ValueError, match="not unique"):
        camera.replace_once(path, "same", "new")
    assert path.read_text(encoding="utf-8") == "same\nsame"

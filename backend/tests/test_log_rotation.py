from __future__ import annotations

import importlib.util
from pathlib import Path


def _module():
    path = Path(__file__).resolve().parents[2] / "tools" / "rotate_text_log.py"
    spec = importlib.util.spec_from_file_location("rotate_text_log_test", path)
    module = importlib.util.module_from_spec(spec)
    assert spec and spec.loader
    spec.loader.exec_module(module)
    return module


def test_text_log_rotation_keeps_bounded_numbered_generations(tmp_path):
    rotation = _module()
    log = tmp_path / "sample.log"
    log.write_text("first", encoding="utf-8")
    assert rotation.rotate_text_log(log, max_bytes=2, keep=2)
    assert not log.exists()
    assert (tmp_path / "sample.log.1").read_text(encoding="utf-8") == "first"

    log.write_text("second", encoding="utf-8")
    assert rotation.rotate_text_log(log, max_bytes=2, keep=2)
    log.write_text("third", encoding="utf-8")
    assert rotation.rotate_text_log(log, max_bytes=2, keep=2)

    assert (tmp_path / "sample.log.1").read_text(encoding="utf-8") == "third"
    assert (tmp_path / "sample.log.2").read_text(encoding="utf-8") == "second"
    assert not (tmp_path / "sample.log.3").exists()


def test_small_or_missing_log_is_left_untouched(tmp_path):
    rotation = _module()
    log = tmp_path / "sample.log"
    assert not rotation.rotate_text_log(log, max_bytes=10, keep=3)
    log.write_text("ok", encoding="utf-8")
    assert not rotation.rotate_text_log(log, max_bytes=10, keep=3)
    assert log.read_text(encoding="utf-8") == "ok"

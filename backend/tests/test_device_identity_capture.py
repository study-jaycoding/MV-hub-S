"""Device identity initialization uses synthetic files, without backup uploads."""

from __future__ import annotations

import json
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from unittest.mock import Mock

import pytest

from app.services import worker_backup as service


@pytest.mark.parametrize("trial", range(5))
def test_concurrent_first_capture_returns_one_persisted_identity(tmp_path, monkeypatch, trial):
    path = tmp_path / "device.json"
    monkeypatch.setattr(service, "DEVICE_IDENTITY_PATH", path)
    real_write = service.atomic_write_text
    write_lock = threading.Lock()
    start = threading.Barrier(4)

    def delayed_write(*args, **kwargs):
        # Widen the missing-file window, but don't manufacture OS rename failures.
        time.sleep(0.04)
        with write_lock:
            return real_write(*args, **kwargs)

    monkeypatch.setattr(service, "atomic_write_text", delayed_write)
    capture = getattr(service, "device_identity", service._device_identity)

    def read():
        start.wait(timeout=2)
        return capture()

    with ThreadPoolExecutor(max_workers=4) as pool:
        results = list(pool.map(lambda _: read(), range(4)))
    stored = json.loads(path.read_text("utf-8"))
    assert all(result == stored for result in results)
    assert len({result["device_id"] for result in results}) == 1


def test_capture_preserves_an_existing_device_identity(tmp_path, monkeypatch):
    path = tmp_path / "device.json"
    expected = {"device_id": "a" * 32, "device_name": "Synthetic device"}
    path.write_text(json.dumps(expected), encoding="utf-8")
    monkeypatch.setattr(service, "DEVICE_IDENTITY_PATH", path)
    writer = Mock(side_effect=AssertionError("An unchanged identity must not be rewritten"))
    monkeypatch.setattr(service, "atomic_write_text", writer)
    assert getattr(service, "device_identity", service._device_identity)() == expected
    writer.assert_not_called()


def test_failed_identity_persistence_returns_no_identity(tmp_path, monkeypatch):
    monkeypatch.setattr(service, "DEVICE_IDENTITY_PATH", tmp_path / "device.json")
    monkeypatch.setattr(service, "atomic_write_text", Mock(side_effect=OSError("synthetic")))
    with pytest.raises(OSError):
        getattr(service, "device_identity", service._device_identity)()

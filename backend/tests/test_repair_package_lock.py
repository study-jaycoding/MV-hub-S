from __future__ import annotations

import importlib.util
import json
import subprocess
from pathlib import Path


def _module():
    path = Path(__file__).resolve().parents[2] / "tools" / "repair_package_lock.py"
    spec = importlib.util.spec_from_file_location("repair_package_lock", path)
    module = importlib.util.module_from_spec(spec)
    assert spec and spec.loader
    spec.loader.exec_module(module)
    return module


def _git(root: Path, *args: str) -> bytes:
    result = subprocess.run(
        ["git", *args], cwd=root, capture_output=True, check=True
    )
    return result.stdout


def _repo(tmp_path: Path) -> tuple[Path, Path, bytes]:
    root = tmp_path / "repo"
    lock = root / "frontend" / "package-lock.json"
    lock.parent.mkdir(parents=True)
    original = b'{"name":"app","packages":{"":{"engines":{"node":">=22"},"dependencies":{"a":"1"}}}}\n'
    lock.write_bytes(original)
    _git(root, "init", "--quiet")
    _git(root, "config", "user.email", "test@example.com")
    _git(root, "config", "user.name", "Test")
    _git(root, "add", "frontend/package-lock.json")
    _git(root, "commit", "--quiet", "-m", "initial")
    return root, lock, original


def test_repairs_order_only_lock_rewrite(tmp_path):
    repair = _module()
    root, lock, original = _repo(tmp_path)
    data = json.loads(original)
    lock.write_text(json.dumps(data, indent=4, sort_keys=True), encoding="utf-8")

    assert repair.repair_if_semantically_equal(root, lock) == "restored"
    assert lock.read_bytes() == original
    assert not _git(root, "status", "--porcelain").strip()


def test_preserves_real_lock_change(tmp_path):
    repair = _module()
    root, lock, _ = _repo(tmp_path)
    data = json.loads(lock.read_text(encoding="utf-8"))
    data["packages"][""]["dependencies"]["a"] = "2"
    lock.write_text(json.dumps(data), encoding="utf-8")

    assert repair.repair_if_semantically_equal(root, lock) == "different"
    assert _git(root, "status", "--porcelain").strip()

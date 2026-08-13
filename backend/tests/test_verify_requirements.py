from __future__ import annotations

import importlib.util
from pathlib import Path


def _module():
    path = Path(__file__).resolve().parents[2] / "tools" / "verify_requirements.py"
    spec = importlib.util.spec_from_file_location("verify_requirements", path)
    module = importlib.util.module_from_spec(spec)
    assert spec and spec.loader
    spec.loader.exec_module(module)
    return module


def test_verifies_only_named_pins_and_ignores_unrelated_packages(tmp_path, monkeypatch):
    verifier = _module()
    requirements = tmp_path / "requirements.txt"
    requirements.write_text("alpha==1.2.3\nbeta[extra]==4.5.6\n", encoding="utf-8")
    versions = {"alpha": "1.2.3", "beta": "4.5.6", "unrelated": "999"}
    monkeypatch.setattr(verifier.importlib.metadata, "version", versions.__getitem__)

    assert verifier.verify(requirements) == []


def test_reports_missing_mismatch_and_unpinned_lines(tmp_path, monkeypatch):
    verifier = _module()
    requirements = tmp_path / "requirements.txt"
    requirements.write_text(
        "missing==1\nwrong==2\nloose>=3\n", encoding="utf-8"
    )

    def version(name):
        if name == "missing":
            raise verifier.importlib.metadata.PackageNotFoundError(name)
        return "1"

    monkeypatch.setattr(verifier.importlib.metadata, "version", version)
    errors = verifier.verify(requirements)

    assert any("missing" in error for error in errors)
    assert any("wrong: 1 installed (expected 2)" in error for error in errors)
    assert any("unsupported requirement" in error for error in errors)

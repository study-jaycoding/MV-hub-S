# -*- coding: utf-8 -*-
"""Verify only MV Hub's exactly pinned Python distributions.

``pip check`` inspects every package installed in a shared interpreter and can
fail because of unrelated tools. MV Hub requirements are all ``name==version``
pins, so verify this file directly without judging other applications.
"""
from __future__ import annotations

import importlib.metadata
import re
import sys
from pathlib import Path


PIN = re.compile(r"^([A-Za-z0-9_.-]+)(?:\[[^]]+\])?==([^;\s]+)$")


def verify(requirements: Path) -> list[str]:
    errors: list[str] = []
    for number, raw in enumerate(
        requirements.read_text(encoding="utf-8").splitlines(), start=1
    ):
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        match = PIN.match(line)
        if not match:
            errors.append(f"line {number}: unsupported requirement {line!r}")
            continue
        name, expected = match.groups()
        try:
            actual = importlib.metadata.version(name)
        except importlib.metadata.PackageNotFoundError:
            errors.append(f"{name}: missing (expected {expected})")
            continue
        if actual != expected:
            errors.append(f"{name}: {actual} installed (expected {expected})")
    return errors


def main(argv: list[str]) -> int:
    if len(argv) != 2:
        print("usage: verify_requirements.py <requirements.txt>")
        return 2
    path = Path(argv[1]).resolve()
    try:
        errors = verify(path)
    except OSError as exc:
        print(f"requirements verification failed: {exc}")
        return 1
    if errors:
        for error in errors:
            print(f"[dependency] {error}")
        return 1
    print(f"    verified {path.name}: all pinned packages match.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))

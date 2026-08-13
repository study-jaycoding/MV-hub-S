# -*- coding: utf-8 -*-
"""Undo npm-version-only package-lock rewrites without hiding real edits.

Older launchers ran ``npm install`` on every boot. npm 11 can reorder JSON keys
written by npm 10, leaving a tracked file dirty even though the parsed lock data
is identical. That later blocks ``git pull``. This helper restores the exact
HEAD bytes only when both JSON documents are structurally equal.
"""
from __future__ import annotations

import json
import subprocess
from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent
LOCK = ROOT / "frontend" / "package-lock.json"


def repair_if_semantically_equal(root: Path = ROOT, lock: Path = LOCK) -> str:
    if not lock.is_file():
        return "missing"
    status = subprocess.run(
        ["git", "status", "--porcelain", "--", "frontend/package-lock.json"],
        cwd=root,
        capture_output=True,
        text=True,
        check=False,
    )
    if status.returncode != 0 or not status.stdout.strip():
        return "clean"
    head = subprocess.run(
        ["git", "show", "HEAD:frontend/package-lock.json"],
        cwd=root,
        capture_output=True,
        check=False,
    )
    if head.returncode != 0:
        return "unavailable"
    try:
        working_data = json.loads(lock.read_text(encoding="utf-8"))
        head_data = json.loads(head.stdout.decode("utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError):
        return "different"
    if working_data != head_data:
        return "different"
    lock.write_bytes(head.stdout)
    return "restored"


def main() -> int:
    result = repair_if_semantically_equal()
    if result == "restored":
        print("    cleaned npm-only package-lock formatting change.")
    elif result == "different":
        print("    package-lock has real local changes - leaving it untouched.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

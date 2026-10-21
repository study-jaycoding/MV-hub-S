"""Local coordinator admission gate. It cannot prevent startup/background DB writes."""
from __future__ import annotations

import json
import os
from pathlib import Path
import threading

from . import release_contract

_ROOT = Path(__file__).resolve().parents[3]
_LOCK = threading.Lock()
_ACTIVE = 0


def _read(path: Path) -> dict:
    if path.stat().st_size > release_contract.MAX_JSON:
        raise ValueError("activation_record_too_large")
    value = json.loads(path.read_text(encoding="utf-8-sig"))
    if not isinstance(value, dict):
        raise ValueError("activation_record_invalid")
    return value


def admission_state() -> str:
    control = os.environ.get("MVHUB_ACTIVATION_CONTROL", "")
    if not control:
        return "normal"
    try:
        root = Path(os.environ["MVHUB_ACTIVATION_ROOT"])
        path = Path(control)
        if not root.is_absolute() or not path.is_absolute() or str(root).startswith("\\\\"):
            return "blocked"
        path.resolve().relative_to(root.resolve())
        for ancestor in (path, *path.parents):
            if ancestor.is_symlink() or bool(getattr(ancestor.stat(), "st_file_attributes", 0) & 1024):
                return "blocked"
            if ancestor == root:
                break
        value = _read(path)
        nonce = os.environ["MVHUB_EXECUTION_NONCE"]
        if value.get("format_version") != 1 or value.get("execution_nonce") != nonce:
            return "blocked"
        if value.get("state") == "normal":
            return "normal"
        if value.get("state") != "activated":
            return "blocked"
        journal_path = Path(value["journal"])
        if not journal_path.is_absolute():
            return "blocked"
        journal_path.resolve().relative_to(root.resolve())
        for ancestor in (journal_path, *journal_path.parents):
            if ancestor.is_symlink() or bool(getattr(ancestor.stat(), 'st_file_attributes', 0) & 1024):
                return 'blocked'
            if ancestor == root:
                break
        journal = _read(journal_path)
        if (journal.get("run_id") != value.get("run_id") or journal.get("execution_nonce") != nonce or
                journal.get("phase") not in {"ready", "committed"} or
                journal.get("business_writes_possible") is not True or journal.get("db_mutation_possible") is not True):
            return "blocked"
        return "activated"
    except (OSError, ValueError, KeyError, TypeError):
        return "blocked"


def runtime_identity() -> dict:
    try:
        descriptor = _read(_ROOT / "build-manifest.json")
        build_id = str(descriptor.get("build_id") or "")
    except (OSError, ValueError):
        build_id = os.environ.get("MVHUB_BUILD_ID", "")
    with _LOCK:
        active = _ACTIVE
    return {"process_id": os.getpid(), "execution_nonce": os.environ.get("MVHUB_EXECUTION_NONCE", ""),
            "build_id": build_id, "role": os.environ.get("MVHUB_PROCESS_ROLE", "unknown"),
            "admission": admission_state(), "active_http": active}


class ActivationAdmissionMiddleware:
    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        global _ACTIVE
        kind = scope["type"]
        if kind not in {"http", "websocket"} or scope.get("path") in {"/api/ready", "/api/health"}:
            return await self.app(scope, receive, send)
        with _LOCK:
            blocked = admission_state() == "blocked"
            if not blocked and kind == "http":
                _ACTIVE += 1
        if blocked:
            if kind == "websocket":
                await send({"type": "websocket.close", "code": 1013})
            else:
                await send({"type": "http.response.start", "status": 503, "headers": [(b"retry-after", b"5")]})
                await send({"type": "http.response.body", "body": b"Activation pending"})
            return
        try:
            await self.app(scope, receive, send)
        finally:
            if kind == "http":
                with _LOCK:
                    _ACTIVE -= 1

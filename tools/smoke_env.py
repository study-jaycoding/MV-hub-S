"""Compatibility entry point; load the shared stdlib helper without importing app."""
from __future__ import annotations

import importlib.util
from pathlib import Path

_path = Path(__file__).resolve().parents[1] / "backend/app/services/isolated_env.py"
_spec = importlib.util.spec_from_file_location("_mvhub_isolated_env", _path)
if _spec is None or _spec.loader is None:
    raise ImportError("isolated environment helper is unavailable")
_helper = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_helper)

build_smoke_env = _helper.build_smoke_env
validate_smoke_paths = _helper.validate_smoke_paths
_local_path = _helper._local_path
_PATH_KEYS = _helper._PATH_KEYS
_PROFILE_KEYS = _helper._PROFILE_KEYS

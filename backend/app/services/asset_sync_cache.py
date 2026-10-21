"""Account/server-scoped, verified copies of authorized canonical assets."""
from __future__ import annotations

import hashlib
import json
import os
import re
import tempfile
import threading
import weakref
from collections import OrderedDict
from pathlib import Path

from fastapi import HTTPException

from .. import config
from . import asset_io
from .media_types import ASSET_CONTENT_TYPES
from .path_safety import safe_join


_locks_guard = threading.Lock()
_locks = weakref.WeakValueDictionary()
_digests = OrderedDict()


def file_digest(path, *, force=False):
    """Cache bytes, never authorization; only reuse an unchanged file stamp."""
    # shortcut: same-size edits preserving mtime need forced /verify hashing to be detected.
    stamp = path.stat()
    key = (path, stamp.st_size, stamp.st_mtime_ns)
    with _locks_guard:
        if not force and key in _digests:
            _digests.move_to_end(key)
            return _digests[key]
        _digests.pop(key, None)
    digest = asset_io.sha256_file(path)
    after = path.stat()
    if (after.st_size, after.st_mtime_ns) != key[1:]:
        return None
    if digest is not None:
        with _locks_guard:
            _digests[key] = digest
            _digests.move_to_end(key)
            if len(_digests) > 1024:
                _digests.popitem(last=False)
    return digest


def _metadata(info):
    if not isinstance(info, dict):
        raise HTTPException(status_code=502, detail='asset_metadata_mismatch')
    digest = info.get('sha256')
    size = info.get('bytes')
    location = info.get('location_id')
    name = info.get('name')
    if (not isinstance(digest, str) or not re.fullmatch('[a-f0-9]{64}', digest)
            or info.get('asset_content_id') != 'sha256:' + digest
            or type(size) is not int or not 0 < size <= asset_io.UPLOAD_MAX_BYTES
            or not isinstance(location, str) or not re.fullmatch('[a-f0-9]{32}', location)
            or info.get('state') != 'ready'
            or info.get('file_path') != 'asset-sync:' + location
            or info.get('url') != '/api/asset-sync/files/' + location
            or any(not isinstance(info.get(key), str) or not info[key] or len(info[key]) > 512
                   for key in ('owner_uid', 'project_id', 'storage_id', 'root_revision'))
            or not isinstance(name, str) or not 0 < len(name) <= 255
            or any(char in name for char in '/\\') or any(ord(char) < 32 for char in name)):
        raise HTTPException(status_code=502, detail='asset_metadata_mismatch')
    extension = Path(name).suffix.lower()
    if extension not in ASSET_CONTENT_TYPES:
        raise HTTPException(status_code=415, detail='unsupported_asset_type')
    return digest, size, location, extension


def _verified(path, digest, size):
    try:
        return path.is_file() and path.stat().st_size == size and file_digest(path) == digest
    except OSError:
        return False


def cached_file(info, *, account_key, owner_uid, server_origin, download, check_context):
    """Call only after a fresh authenticated /locations response; never cache permission."""
    digest, size, location, extension = _metadata(info)
    check_context()
    scope = hashlib.sha256(json.dumps([account_key, owner_uid, server_origin]).encode()).hexdigest()
    root = config.DATA_DIR / 'asset-download-cache'
    root.mkdir(parents=True, exist_ok=True)
    path = safe_join(root, scope + '/' + digest + extension)
    if path is None:
        raise HTTPException(status_code=409, detail='unsafe_asset_cache_path')
    path.parent.mkdir(parents=True, exist_ok=True)
    path = safe_join(root, scope + '/' + digest + extension)
    if path is None:
        raise HTTPException(status_code=409, detail='unsafe_asset_cache_path')
    with _locks_guard:
        lock = _locks.get(str(path))
        if lock is None:
            lock = threading.Lock()
            _locks[str(path)] = lock
    # Keep a strong reference while waiting, but do not retain a lock for every old asset.
    with lock:
        check_context()
        if _verified(path, digest, size):
            check_context()
            return path
        with tempfile.NamedTemporaryFile(dir=path.parent, prefix='.download-', suffix='.part', delete=False) as handle:
            temporary = Path(handle.name)
        try:
            download('/api/asset-sync/files/' + location, temporary, max_bytes=size)
            check_context()
            if not _verified(temporary, digest, size):
                raise HTTPException(status_code=502, detail='asset_download_mismatch')
            stamp = temporary.stat()
            with temporary.open('r+b') as handle:
                os.fsync(handle.fileno())
            check_context()
            os.replace(temporary, path)
            # Rename preserves the verified stamp; carry its digest to the final path.
            with _locks_guard:
                key = (temporary, stamp.st_size, stamp.st_mtime_ns)
                verified = _digests.pop(key, None)
                if verified is not None:
                    _digests[(path, stamp.st_size, stamp.st_mtime_ns)] = verified
            check_context()
            return path
        finally:
            temporary.unlink(missing_ok=True)

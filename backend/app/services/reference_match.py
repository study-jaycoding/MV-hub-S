"""Conservative, bounded reference matching; source assets are read-only."""
from __future__ import annotations

import asyncio
import contextvars
import hashlib
import io
import shutil
import tempfile
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from PIL import Image, ImageChops, ImageOps

from . import thumbs
from .async_tools import to_thread_non_abandon
from .path_safety import path_comparison_key, safe_join

MATCH_SECONDS = 15.0
SHORTLIST_CELL_DIFF = 10.0
MAX_ORIGINAL_CANDIDATES = 3
ORIGINAL_WIDTH = 512
ORIGINAL_CELL_SIZE = 32
ORIGINAL_MATCH_DIFF = 3.5
ORIGINAL_OTHER_DIFF = 5.0
MAX_ORIGINAL_HEIGHT = 2048
MAX_ORIGINAL_PIXELS = 67_108_864
_workers = ThreadPoolExecutor(max_workers=2, thread_name_prefix="reference-match")
_slot = threading.BoundedSemaphore(1)


class _SizeLimit(OSError):
    pass


def image_suffix(head: bytes) -> set[str]:
    if head.startswith(b"\x89PNG\r\n\x1a\n"):
        return {".png"}
    if head.startswith(b"\xff\xd8\xff"):
        return {".jpg", ".jpeg"}
    if head[:4] == b"RIFF" and head[8:12] == b"WEBP":
        return {".webp"}
    return set()


def prepare_attachment(path: Path):
    """Match ensure_thumb's EXIF/RGB/256px/JPEG-q82 pipeline without disk cache."""
    try:
        with Image.open(path) as source:
            if getattr(source, "n_frames", 1) != 1:
                return None, "animated"
            if source.width * source.height > MAX_ORIGINAL_PIXELS:
                raise _SizeLimit("attachment pixel limit")
            try:
                oriented = ImageOps.exif_transpose(source)
            except Exception:
                oriented = source
            ratio = oriented.width / oriented.height
            picture = oriented.convert("RGB")
            picture.thumbnail((256, 256), Image.Resampling.LANCZOS)
            encoded = io.BytesIO()
            picture.save(encoded, "JPEG", quality=82)
        encoded.seek(0)
        with Image.open(encoded) as decoded:
            return (decoded.convert("RGB").resize((192, 108), Image.Resampling.LANCZOS), ratio), None
    except _SizeLimit:
        return None, "size_limit"
    except Exception:
        return None, "unreadable"


def cell_difference(first: Image.Image, second: Image.Image) -> float:
    difference = ImageChops.difference(first, second)
    # Float channels preserve fractional cell means.
    return max(channel.convert("F").resize((16, 9), Image.Resampling.BOX).getextrema()[1]
               for channel in difference.split())


def _check_deadline(expired):
    if expired():
        raise TimeoutError("matching deadline")


def _original_size(source):
    width, height = source.size
    if width * height > MAX_ORIGINAL_PIXELS:
        raise _SizeLimit("original pixel limit")
    # PNG's overridden getexif() can decode pixels; inspect header metadata only here.
    previous_exif = source._exif
    try:
        orientation = Image.Image.getexif(source).get(274, 1)
    finally:
        source._exif = previous_exif
    if orientation in (5, 6, 7, 8):
        width, height = height, width
    target_height = max(16, round(ORIGINAL_WIDTH * height / width))
    if target_height > MAX_ORIGINAL_HEIGHT:
        raise _SizeLimit("original height limit")
    return ORIGINAL_WIDTH, target_height


def _decode_original(source, expired):
    _check_deadline(expired)
    if getattr(source, "n_frames", 1) != 1:
        raise OSError("animated original")
    _check_deadline(expired)
    size = _original_size(source)
    _check_deadline(expired)
    with ImageOps.exif_transpose(source) as oriented:
        _check_deadline(expired)
        if _original_size(oriented) != size:
            raise OSError("original orientation changed")
        picture = oriented.convert("RGB")
    try:
        _check_deadline(expired)
        return picture, size
    except BaseException:
        picture.close()
        raise


def _original_difference(root, candidate, attachment, expired):
    _check_deadline(expired)
    target = safe_join(root, candidate["path"])
    if target is None:
        raise OSError("unsafe asset")
    _check_deadline(expired)
    before = target.stat()
    if f"{before.st_mtime_ns}-{before.st_size}" != candidate["version"]:
        raise OSError("asset changed")
    _check_deadline(expired)
    with Image.open(target) as source:
        picture, size = _decode_original(source, expired)
    try:
        _check_deadline(expired)
        with picture.resize(size, Image.Resampling.LANCZOS) as resized:
            _check_deadline(expired)
            with attachment.resize(size, Image.Resampling.LANCZOS) as attached:
                _check_deadline(expired)
                with ImageChops.difference(attached, resized) as difference:
                    cells = (ORIGINAL_WIDTH // ORIGINAL_CELL_SIZE, max(1, size[1] // ORIGINAL_CELL_SIZE))
                    score = 0.0
                    for channel in difference.split():
                        with channel:
                            _check_deadline(expired)
                            with channel.convert("F") as floating:
                                _check_deadline(expired)
                                with floating.resize(cells, Image.Resampling.BOX) as reduced:
                                    _check_deadline(expired)
                                    score = max(score, reduced.getextrema()[1])
        _check_deadline(expired)
        after = target.stat()
        if (after.st_mtime_ns, after.st_size) != (before.st_mtime_ns, before.st_size):
            raise OSError("asset changed")
        _check_deadline(expired)
        return score
    finally:
        picture.close()


def _nodes(children):
    for node in children:
        if node.get("type") == "dir":
            yield from _nodes(node.get("children", []))
        elif node.get("type") == "image":
            yield node


def _snapshot_cache_path(root, node):
    target = root / node["path"]
    # shortcut: duplicates thumbs.cache_path to avoid source stat; update together if its key format changes.
    key = hashlib.sha1(f"{path_comparison_key(target)}|{node['version']}|256".encode("utf-8")).hexdigest()
    return thumbs.THUMB_DIR / f"{key}.jpg"


def _candidate(root, node, attachment, expired):
    if expired():
        raise TimeoutError("matching deadline")
    cached = _snapshot_cache_path(root, node)
    if not thumbs._is_complete_file(cached):
        if expired():
            raise TimeoutError("matching deadline")
        target = safe_join(root, node["path"])
        if target is None:
            raise OSError("unsafe asset")
        if expired():
            raise TimeoutError("matching deadline")
        generated = thumbs.ensure_thumb(target, 256)
        if expired():
            raise TimeoutError("matching deadline")
        if generated is None or generated != cached:
            raise OSError("thumbnail unavailable or asset changed")
    if expired():
        raise TimeoutError("matching deadline")
    with Image.open(cached) as source:
        thumb_ratio = source.width / source.height
        picture = source.convert("RGB").resize((192, 108), Image.Resampling.LANCZOS)
    difference = cell_difference(attachment[0], picture)
    if expired():
        raise TimeoutError("matching deadline")
    current = (root / node["path"]).stat()
    if f"{current.st_mtime_ns}-{current.st_size}" != node["version"]:
        raise OSError("asset changed")
    return ({**node, "cell_diff": difference,
             "ratio_matches": 0.98 <= thumb_ratio / attachment[1] <= 1.02}, thumb_ratio)


def _confirm_candidate(root, candidate, thumb_ratio, attachment, expired):
    if expired():
        raise TimeoutError("matching deadline")
    target = safe_join(root, candidate["path"])
    if target is None:
        raise OSError("unsafe asset")
    before = target.stat()
    if f"{before.st_mtime_ns}-{before.st_size}" != candidate["version"]:
        raise OSError("asset changed")
    if expired():
        raise TimeoutError("matching deadline")
    with Image.open(target) as source:
        if getattr(source, "n_frames", 1) != 1:
            return None
        width, height = source.size
    if expired():
        raise TimeoutError("matching deadline")
    # The thumbnail has EXIF orientation applied; avoid decoding the original for getexif().
    ratio = width / height
    if abs(1 / ratio - thumb_ratio) < abs(ratio - thumb_ratio):
        ratio = 1 / ratio
    after = target.stat()
    if (after.st_mtime_ns, after.st_size) != (before.st_mtime_ns, before.st_size):
        raise OSError("asset changed")
    return {**candidate, "ratio_matches": 0.98 <= ratio / attachment[1] <= 1.02}


def _attachment_snapshot(path):
    snapshot = tempfile.TemporaryFile()
    try:
        with open(path, "rb") as source:
            shutil.copyfileobj(source, snapshot, 1024 * 1024)
        snapshot.seek(0)
        return snapshot
    except BaseException:
        snapshot.close()
        raise


async def match_reference(attachment_path, load_tree):
    """One admitted operation, no queue; timeout never frees a still-running worker."""
    empty = {"attempted": False, "complete": False, "linked": False, "candidates": []}
    if not _slot.acquire(blocking=False):
        return {**empty, "reason": "busy"}
    # A timed-out decoder may still be reading; it owns this anonymous disk copy,
    # so the request may commit/remove its upload temp without closing the decoder's file.
    copied = []
    def copy_attachment():
        snapshot = _attachment_snapshot(attachment_path)
        copied.append(snapshot)  # Cancellation may arrive after copying but before assignment below.
        return snapshot
    try:
        snapshot = await to_thread_non_abandon(copy_attachment)
    except Exception:
        _slot.release()
        return {**empty, "reason": "unreadable"}
    except BaseException:
        try:
            if copied:
                copied[0].close()
        finally:
            _slot.release()
        raise
    deadline = time.monotonic() + MATCH_SECONDS
    stopped = threading.Event()
    lock = threading.Lock()
    progress = {**empty, "attempted": True}

    def expired():
        return stopped.is_set() or time.monotonic() >= deadline

    def compare():
        try:
            attachment, reason = prepare_attachment(snapshot)
            if attachment is None:
                with lock:
                    progress.update(attempted=False, reason=reason)
                return
            if expired():
                with lock:
                    progress["reason"] = "timeout"
                return
            root, tree = load_tree()
            if expired():
                with lock:
                    progress["reason"] = "timeout"
                return
            root = root.resolve()
            ranked, leaders, failures = [], [], 0
            for node in _nodes(tree.children):
                if expired():
                    break
                try:
                    candidate, thumb_ratio = _candidate(root, node, attachment, expired)
                    ranked.append((candidate, thumb_ratio))
                    leaders.append(candidate)
                    leaders.sort(key=lambda item: (item["cell_diff"], item["path"]))
                    del leaders[5:]
                    with lock:
                        progress["candidates"] = list(leaders)
                except Exception:
                    failures += 1
            ranked.sort(key=lambda item: (item[0]["cell_diff"], item[0]["path"]))
            candidates = []
            for candidate, thumb_ratio in ranked:
                if expired() or len(candidates) == 5:
                    break
                try:
                    confirmed = _confirm_candidate(root, candidate, thumb_ratio, attachment, expired)
                    if confirmed is not None:
                        candidates.append(confirmed)
                except Exception:
                    failures += 1
            shortlist = [candidate for candidate in candidates if candidate["cell_diff"] <= SHORTLIST_CELL_DIFF]
            size_limited = False
            if 1 <= len(shortlist) <= MAX_ORIGINAL_CANDIDATES and not expired():
                attached = None
                try:
                    snapshot.seek(0)
                    _check_deadline(expired)
                    with Image.open(snapshot) as source:
                        attached, _size = _decode_original(source, expired)
                    for candidate in shortlist:
                        if expired():
                            break
                        try:
                            candidate["original_diff"] = _original_difference(root, candidate, attached, expired)
                        except _SizeLimit:
                            failures += 1
                            size_limited = True
                        except Exception:
                            failures += 1
                except _SizeLimit:
                    failures += 1
                    size_limited = True
                except Exception:
                    failures += 1
                finally:
                    if attached is not None:
                        attached.close()
            complete = tree.complete and failures == 0 and not expired()
            linked = bool(complete and 1 <= len(shortlist) <= MAX_ORIGINAL_CANDIDATES
                          and shortlist[0] is candidates[0]
                          and candidates[0]["ratio_matches"]
                          and shortlist[0]["original_diff"] <= ORIGINAL_MATCH_DIFF
                          and all(candidate["original_diff"] >= ORIGINAL_OTHER_DIFF for candidate in shortlist[1:]))
            with lock:
                progress.update(complete=complete, linked=linked)
                if not expired():
                    progress["candidates"] = candidates
                if not complete:
                    progress["reason"] = "timeout" if expired() else "size_limit" if size_limited else "incomplete"
        except Exception:
            with lock:
                progress["reason"] = "unavailable"
        finally:
            snapshot.close()
            _slot.release()

    context = contextvars.copy_context()
    try:
        future = asyncio.get_running_loop().run_in_executor(_workers, context.run, compare)
    except BaseException:
        snapshot.close()
        _slot.release()
        raise
    try:
        done, _pending = await asyncio.wait({future}, timeout=max(0, deadline - time.monotonic()))
        if not done:
            stopped.set()
            with lock:
                return {**progress, "candidates": list(progress["candidates"]),
                        "complete": False, "linked": False, "reason": "timeout"}
        future.result()
        with lock:
            return {**progress, "candidates": list(progress["candidates"])}
    except BaseException:
        stopped.set()
        raise

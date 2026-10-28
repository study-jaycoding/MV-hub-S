"""Conservative, bounded reference matching; source assets are read-only."""
from __future__ import annotations

import asyncio
import contextvars
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
from .path_safety import safe_join

MATCH_SECONDS = 15.0
_workers = ThreadPoolExecutor(max_workers=2, thread_name_prefix="reference-match")
_slot = threading.BoundedSemaphore(1)


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
    except Exception:
        return None, "unreadable"


def cell_difference(first: Image.Image, second: Image.Image) -> float:
    difference = ImageChops.difference(first, second)
    # Float channels preserve the fractional cell means at the 2.5 threshold.
    return max(channel.convert("F").resize((16, 9), Image.Resampling.BOX).getextrema()[1]
               for channel in difference.split())


def _nodes(children):
    for node in children:
        if node.get("type") == "dir":
            yield from _nodes(node.get("children", []))
        elif node.get("type") == "image":
            yield node


def _candidate(root, node, attachment, expired):
    if expired():
        raise TimeoutError("matching deadline")
    target = safe_join(root, node["path"])
    if target is None:
        raise OSError("unsafe asset")
    before = target.stat()
    if f"{before.st_mtime_ns}-{before.st_size}" != node.get("version"):
        raise OSError("asset changed")
    with Image.open(target) as source:
        if getattr(source, "n_frames", 1) != 1:
            return None
        width, height = source.size
    if expired():
        raise TimeoutError("matching deadline")
    cached = thumbs.ensure_thumb(target, 256)
    if cached is None:
        raise OSError("thumbnail unavailable")
    if expired():
        raise TimeoutError("matching deadline")
    with Image.open(cached) as source:
        # The thumbnail has EXIF orientation applied; avoid decoding a warm PNG for getexif().
        thumb_ratio, ratio = source.width / source.height, width / height
        if abs(1 / ratio - thumb_ratio) < abs(ratio - thumb_ratio):
            ratio = 1 / ratio
        picture = source.convert("RGB").resize((192, 108), Image.Resampling.LANCZOS)
    after = target.stat()
    if (after.st_mtime_ns, after.st_size) != (before.st_mtime_ns, before.st_size):
        raise OSError("asset changed")
    return {**node, "cell_diff": cell_difference(attachment[0], picture),
            "ratio_matches": 0.98 <= ratio / attachment[1] <= 1.02}


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
            candidates, failures, compared = [], 0, 0
            for node in _nodes(tree.children):
                if expired():
                    break
                try:
                    candidate = _candidate(root, node, attachment, expired)
                    if candidate is None:
                        continue
                    compared += 1
                    candidates.append(candidate)
                    candidates.sort(key=lambda item: (item["cell_diff"], item["path"]))
                    del candidates[5:]
                    with lock:
                        progress["candidates"] = list(candidates)
                except Exception:
                    failures += 1
            complete = tree.complete and failures == 0 and not expired()
            linked = bool(complete and compared and candidates[0]["cell_diff"] <= 2.5
                          and candidates[0]["ratio_matches"]
                          and (compared == 1 or candidates[1]["cell_diff"] >= 4.0))
            with lock:
                progress.update(complete=complete, linked=linked)
                if not complete:
                    progress["reason"] = "timeout" if expired() else "incomplete"
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

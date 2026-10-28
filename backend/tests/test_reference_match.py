"""Synthetic images and blocked local reads cover the matching contract."""
import asyncio
import threading
import time

import pytest
from PIL import Image, ImageDraw

from app.services import asset_tree, reference_match as match, thumbs


@pytest.fixture
def images(tmp_path, monkeypatch):
    monkeypatch.setattr(thumbs, "THUMB_DIR", tmp_path / "thumbs")
    root = tmp_path / "originals"
    root.mkdir()
    def save(name, color, size=(192, 108)):
        path = root / name
        Image.new("RGB", size, color).save(path)
        return path
    return root, save


def compare(root, attachment):
    return asyncio.run(match.match_reference(attachment,
        lambda: (root, asset_tree.read_project_tree_snapshot(root, fresh=True))))


def test_identical_and_distinct_rgb_sources(images):
    root, save = images
    first = save("source.png", (255, 0, 0))
    save("same_gray_other_color.png", (0, 130, 0))
    result = compare(root, first)
    assert result["complete"] and result["linked"]
    assert result["candidates"][0]["name"] == "source.png"
    assert result["candidates"][1]["cell_diff"] >= 4


def test_cell_mean_keeps_fraction_at_threshold():
    first = Image.new("RGB", (192, 108))
    second = first.copy()
    ImageDraw.Draw(second).rectangle((0, 0, 5, 11), fill=(5, 0, 0))
    assert match.cell_difference(first, second) == 2.5


@pytest.mark.parametrize("best,second,linked", [(2.5, 4.0, True), (2.5001, 4.0, False), (2.5, 3.999, False)])
def test_exact_score_thresholds(images, monkeypatch, best, second, linked):
    root, save = images
    first = save("first.png", "red")
    save("second.png", "blue")
    def candidate(_root, node, _attachment, _expired):
        return {**node, "cell_diff": best if node["name"] == "first.png" else second, "ratio_matches": True}
    monkeypatch.setattr(match, "_candidate", candidate)
    assert compare(root, first)["linked"] is linked


def test_ties_and_low_contrast_alternative_block_link(images):
    root, save = images
    first = save("first.png", (120, 120, 120))
    save("low_contrast.png", (122, 122, 122))
    result = compare(root, first)
    assert result["complete"] and not result["linked"]
    assert result["candidates"][1]["cell_diff"] < 4
    save("same.png", (120, 120, 120))
    assert compare(root, first)["linked"] is False


def test_ratio_difference_blocks_flat_color_match(images, tmp_path):
    root, save = images
    save("wide.png", (20, 30, 40))
    attachment = tmp_path / "portrait.png"
    Image.new("RGB", (108, 192), (20, 30, 40)).save(attachment)
    result = compare(root, attachment)
    assert result["complete"] and not result["linked"]


def test_animated_webp_is_not_compared(images):
    root, _save = images
    animation = root / "animated.webp"
    Image.new("RGB", (16, 16), "red").save(animation, save_all=True,
        append_images=[Image.new("RGB", (16, 16), "blue")], duration=100, loop=0)
    assert match.prepare_attachment(animation) == (None, "animated")


@pytest.mark.parametrize("failure", ["thumb", "version", "tree"])
def test_incomplete_reads_never_link(images, monkeypatch, failure):
    root, save = images
    first = save("first.png", "red")
    original = thumbs.ensure_thumb
    if failure == "thumb":
        monkeypatch.setattr(thumbs, "ensure_thumb", lambda *args: None)
    elif failure == "version":
        def replace(path, width):
            cached = original(path, width)
            path.write_bytes(b"changed")
            return cached
        monkeypatch.setattr(thumbs, "ensure_thumb", replace)
    else:
        real = asset_tree.read_project_tree_snapshot
        monkeypatch.setattr(asset_tree, "read_project_tree_snapshot", lambda *a, **kw:
            asset_tree.AssetTreeSnapshot(real(*a, **kw).children, True, truncated=True))
    result = compare(root, first)
    assert not result["complete"] and not result["linked"]


@pytest.mark.parametrize("stage", ["attachment", "tree", "thumbnail"])
def test_timeout_retains_slot_and_stops_new_work(images, monkeypatch, stage):
    root, save = images
    first = save("first.png", "red")
    for index in range(9):
        save(f"other{index}.png", "blue")
    entered, release, ended = threading.Event(), threading.Event(), threading.Event()
    calls = []
    real = match._candidate
    real_prepare = match.prepare_attachment
    def prepare(source):
        if stage == "attachment":
            entered.set()
            assert release.wait(3)
        return real_prepare(source)
    monkeypatch.setattr(match, "prepare_attachment", prepare)
    def candidate(*args):
        calls.append(args[1]["path"])
        if stage == "thumbnail":
            entered.set()
            assert release.wait(3)
        return real(*args)
    def tree():
        if stage == "tree":
            entered.set()
            assert release.wait(3)
        return root, asset_tree.read_project_tree_snapshot(root, fresh=True)
    monkeypatch.setattr(match, "_candidate", candidate)
    monkeypatch.setattr(match, "MATCH_SECONDS", 0.1)
    async def exercise():
        try:
            result = await match.match_reference(first, tree)
            assert entered.is_set()
            assert not result["complete"] and not result["linked"]
            for _ in range(3):
                busy = await match.match_reference(first, tree)
                assert busy["reason"] == "busy" and not busy["attempted"]
        finally:
            release.set()
        deadline = time.monotonic() + 3
        while time.monotonic() < deadline:
            if match._slot.acquire(blocking=False):
                match._slot.release()
                ended.set()
                break
            await asyncio.sleep(0.01)
    asyncio.run(exercise())
    assert ended.is_set()
    assert len(calls) == (1 if stage == "thumbnail" else 0)
    assert match._workers._max_workers == 2


def test_candidate_count_is_bounded(images):
    root, save = images
    first = save("first.png", "red")
    for index in range(8):
        save(f"similar{index}.png", (255 - index, 0, 0))
    assert len(compare(root, first)["candidates"]) == 5


def test_cancellation_during_copy_closes_snapshot_and_keeps_slot_until_copy_finishes(images, monkeypatch):
    _root, save = images
    first = save("first.png", "red")
    entered, release = threading.Event(), threading.Event()
    held = []
    original = match._attachment_snapshot
    def copy(path):
        snapshot = original(path)
        held.append(snapshot)
        entered.set()
        assert release.wait(3)
        return snapshot
    monkeypatch.setattr(match, "_attachment_snapshot", copy)
    async def exercise():
        task = asyncio.create_task(match.match_reference(first, lambda: pytest.fail("cancelled request scanned")))
        try:
            deadline = time.monotonic() + 2
            while not entered.is_set() and time.monotonic() < deadline:
                await asyncio.sleep(0.01)
            assert entered.is_set()
            task.cancel()
            await asyncio.sleep(0.01)
            assert not task.done() and not held[0].closed
            assert (await match.match_reference(first, lambda: None))["reason"] == "busy"
        finally:
            release.set()
        with pytest.raises(asyncio.CancelledError):
            await task
        assert held[0].closed
        assert match._slot.acquire(blocking=False)
        match._slot.release()
    asyncio.run(exercise())


def test_warm_comparison_does_not_decode_original_pixels(images, monkeypatch):
    root, save = images
    first = save("first.png", "red")
    thumbs.ensure_thumb(first, 256)
    original = Image.Image.load
    def load(picture, *args, **kwargs):
        if getattr(picture, "filename", None) == str(first):
            raise AssertionError("warm comparison decoded original")
        return original(picture, *args, **kwargs)
    monkeypatch.setattr(Image.Image, "load", load)
    assert compare(root, first)["linked"]


def test_metadata_deadline_does_not_start_thumbnail(images, monkeypatch):
    root, save = images
    first = save("first.png", "red")
    entered, release = threading.Event(), threading.Event()
    original = Image.open
    def open_image(path, *args, **kwargs):
        if path == first:
            entered.set()
            assert release.wait(3)
        return original(path, *args, **kwargs)
    calls = []
    monkeypatch.setattr(match.Image, "open", open_image)
    monkeypatch.setattr(thumbs, "ensure_thumb", lambda *args: calls.append(args))
    monkeypatch.setattr(match, "MATCH_SECONDS", 0.1)
    async def exercise():
        try:
            result = await match.match_reference(first, lambda: (root, asset_tree.read_project_tree_snapshot(root, fresh=True)))
            assert entered.is_set() and result["reason"] == "timeout"
        finally:
            release.set()
        deadline = time.monotonic() + 3
        while time.monotonic() < deadline:
            if match._slot.acquire(blocking=False):
                match._slot.release()
                return
            await asyncio.sleep(0.01)
        pytest.fail("worker did not finish")
    asyncio.run(exercise())
    assert calls == []


@pytest.mark.parametrize("kind", ["nodes", "depth", "read"])
def test_tree_completeness_is_cached_with_its_own_scan(images, monkeypatch, kind):
    root, save = images
    save("one.png", "red")
    save("two.png", "blue")
    if kind == "nodes":
        monkeypatch.setattr(asset_tree, "_TREE_MAX_NODES", 1)
    elif kind == "depth":
        monkeypatch.setattr(asset_tree, "_TREE_MAX_DEPTH", 0)
        (root / "nested").mkdir()
        Image.new("RGB", (8, 8)).save(root / "nested" / "deep.png")
    else:
        original = asset_tree.os.scandir
        def failing(path):
            if path == root:
                raise PermissionError("isolated")
            return original(path)
        monkeypatch.setattr(asset_tree.os, "scandir", failing)
    first = asset_tree.read_project_tree_snapshot(root, fresh=True)
    other = root.parent / "empty"
    other.mkdir()
    assert asset_tree.read_project_tree_snapshot(other).complete
    cached = asset_tree.read_project_tree_snapshot(root)
    assert not first.complete and not cached.complete and not cached.scanned
    assert first.children is cached.children
    assert first.truncated == cached.truncated and first.failures == cached.failures


def test_combined_tree_keeps_missing_internal_folder_and_failure_distinct(tmp_path, monkeypatch):
    assert asset_tree.read_combined_tree_snapshot(tmp_path, ("imports", "captures")).complete
    (tmp_path / "imports").mkdir()
    real = asset_tree.os.scandir
    def failing(path):
        if path == tmp_path / "imports":
            raise PermissionError("isolated")
        return real(path)
    monkeypatch.setattr(asset_tree.os, "scandir", failing)
    failed = asset_tree.read_combined_tree_snapshot(tmp_path, ("imports", "captures"), fresh=True)
    cached = asset_tree.read_combined_tree_snapshot(tmp_path, ("imports", "captures"))
    assert failed.failures == cached.failures == 1
    assert not cached.complete

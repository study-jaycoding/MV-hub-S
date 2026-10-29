"""Synthetic images and blocked local reads cover the matching contract."""
import asyncio
import threading
import time
from pathlib import Path

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
        return ({**node, "cell_diff": best if node["name"] == "first.png" else second,
                 "ratio_matches": True}, 192 / 108)
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


def test_finalist_deadline_does_not_start_next_original(images, monkeypatch):
    root, save = images
    first = save("first.png", "red")
    second = save("second.png", "blue")
    for path in (first, second):
        thumbs.ensure_thumb(path, 256)
    entered, release = threading.Event(), threading.Event()
    original = Image.open
    opened = []
    def open_image(path, *args, **kwargs):
        if path in (first, second):
            opened.append(path)
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
    assert opened == [first]


@pytest.mark.parametrize("name", ["one.png", "한글 name.png", "nested/three.png"])
def test_snapshot_cache_key_matches_thumbs_cache_path(images, name):
    root, save = images
    (root / name).parent.mkdir(parents=True, exist_ok=True)
    source = save(name, "red")
    version = source.stat()
    node = {"path": name, "version": f"{version.st_mtime_ns}-{version.st_size}"}
    assert match._snapshot_cache_path(root.resolve(), node) == thumbs.cache_path(source.resolve(), 256)


def test_warm_scoring_stats_each_original_once_and_only_opens_five_finalists(images, monkeypatch):
    root, save = images
    originals = {save(f"source{index}.png", (255 - index * 25, 0, 0)) for index in range(8)}
    for source in originals:
        thumbs.ensure_thumb(source, 256)
    tree = asset_tree.read_project_tree_snapshot(root, fresh=True)
    first = root / "source0.png"
    real_candidate, real_open, real_stat, real_join = match._candidate, Image.open, Path.stat, match.safe_join
    scoring, opened, violations = [], [], []
    scoring_stats = dict.fromkeys(originals, 0)
    def candidate(*args):
        scoring.append(True)
        try:
            return real_candidate(*args)
        finally:
            scoring.pop()
    def stat(path, *args, **kwargs):
        if path in originals and scoring:
            scoring_stats[path] += 1
        return real_stat(path, *args, **kwargs)
    def open_image(path, *args, **kwargs):
        if isinstance(path, (str, Path)) and Path(path) in originals:
            opened.append(Path(path))
            if scoring:
                violations.append(("open", path))
                raise AssertionError("scoring opened original")
        return real_open(path, *args, **kwargs)
    def join(*args):
        if scoring:
            violations.append(("safe_join", args))
            raise AssertionError("warm scoring resolved original")
        return real_join(*args)
    monkeypatch.setattr(match, "_candidate", candidate)
    monkeypatch.setattr(match, "safe_join", join)
    monkeypatch.setattr(Path, "stat", stat)
    monkeypatch.setattr(Image, "open", open_image)
    monkeypatch.setattr(thumbs, "ensure_thumb", lambda *args: pytest.fail("warm scoring generated thumbnail"))
    result = asyncio.run(match.match_reference(first, lambda: (root, tree)))
    assert result["complete"] and result["linked"]
    assert violations == []
    assert scoring_stats == dict.fromkeys(originals, 1)
    assert len(opened) == 5 and len(set(opened)) == 5


@pytest.mark.parametrize("extra_count", [0, 6])
def test_animated_leader_is_replaced_by_next_static_candidate(images, tmp_path, monkeypatch, extra_count):
    root, save = images
    animation = root / "a-animated.webp"
    Image.new("RGB", (192, 108), "red").save(animation, lossless=True, save_all=True,
        append_images=[Image.new("RGB", (192, 108), "blue")], duration=100, loop=0)
    still = save("b-still.png", "red")
    for index in range(extra_count):
        save(f"other{index}.png", "blue")
    originals = set(root.iterdir())
    for source in originals:
        thumbs.ensure_thumb(source, 256)
    attachment = tmp_path / "attachment.png"
    attachment.write_bytes(still.read_bytes())
    real_open, opened = Image.open, []
    def open_image(path, *args, **kwargs):
        if isinstance(path, (str, Path)) and Path(path) in originals:
            opened.append(Path(path))
        return real_open(path, *args, **kwargs)
    monkeypatch.setattr(Image, "open", open_image)
    result = compare(root, attachment)
    assert result["complete"] and result["linked"]
    assert result["candidates"][0]["name"] == still.name
    assert all(candidate["name"] != animation.name for candidate in result["candidates"])
    assert opened[0] == animation and len(opened) == min(5, extra_count + 1) + 1
    assert len(result["candidates"]) == min(5, extra_count + 1)


def test_warm_snapshot_version_change_prevents_link(images, tmp_path):
    root, save = images
    first = save("first.png", "red")
    attachment = tmp_path / "attachment.png"
    attachment.write_bytes(first.read_bytes())
    thumbs.ensure_thumb(first, 256)
    tree = asset_tree.read_project_tree_snapshot(root, fresh=True)
    save("first.png", "blue", size=(100, 80))
    result = asyncio.run(match.match_reference(attachment, lambda: (root, tree)))
    assert not result["complete"] and not result["linked"]
    assert result["reason"] == "incomplete" and result["candidates"] == []


def test_warm_nonfinalist_version_change_prevents_link(images):
    root, save = images
    originals = [save(f"source{index}.png", (255 - index * 25, 0, 0)) for index in range(8)]
    for source in originals:
        thumbs.ensure_thumb(source, 256)
    tree = asset_tree.read_project_tree_snapshot(root, fresh=True)
    save("source7.png", "blue", size=(100, 80))
    result = asyncio.run(match.match_reference(originals[0], lambda: (root, tree)))
    assert result["candidates"][0]["name"] == originals[0].name
    assert originals[7].name not in [candidate["name"] for candidate in result["candidates"]]
    assert not result["complete"] and not result["linked"]
    assert result["reason"] == "incomplete"


@pytest.mark.parametrize("outcome", ["correct", "different_path", "missing", "unsafe"])
def test_cold_thumbnail_requires_matching_snapshot_key(images, monkeypatch, outcome):
    root, save = images
    first = save("first.png", "red")
    real_ensure, calls = thumbs.ensure_thumb, []
    def ensure(path, width):
        calls.append((path, width))
        if outcome == "missing":
            return None
        cached = real_ensure(path, width)
        return cached.with_name("changed-version.jpg") if outcome == "different_path" else cached
    monkeypatch.setattr(thumbs, "ensure_thumb", ensure)
    if outcome == "unsafe":
        monkeypatch.setattr(match, "safe_join", lambda *args: None)
    result = compare(root, first)
    assert result["complete"] is (outcome == "correct")
    assert result["linked"] is (outcome == "correct")
    assert calls == ([] if outcome == "unsafe" else [(first.resolve(), 256)])


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

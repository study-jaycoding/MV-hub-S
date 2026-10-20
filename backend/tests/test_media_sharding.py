import asyncio
import hashlib
import sqlite3

import pytest

from app import db
from app.services import media_cache


@pytest.mark.parametrize("target_bytes", [None, b"", b"different", b"original"])
def test_startup_preserves_shared_legacy_paths_and_all_databases(tmp_path, monkeypatch, target_bytes):
    media = tmp_path / "media"
    media.mkdir()
    flat = media / "synthetic.png"
    flat.write_bytes(b"original")
    target = media / "sy" / flat.name
    if target_bytes is not None:
        target.parent.mkdir()
        target.write_bytes(target_bytes)
    for name in ("active.db", "other-account.db", "trash.db"):
        with sqlite3.connect(tmp_path / name) as connection:
            for table in ("asset", "reference"):
                connection.execute(f'CREATE TABLE "{table}" (file_path TEXT, thumbnail_path TEXT)')
                connection.execute(f'INSERT INTO "{table}" VALUES (?, ?)',
                                   ("/media/synthetic.png", "/media/synthetic.png"))

    def snapshot():
        return {path.relative_to(tmp_path): hashlib.sha256(path.read_bytes()).hexdigest()
                for path in tmp_path.rglob("*") if path.is_file()}

    before = snapshot()
    monkeypatch.setattr(media_cache, "MEDIA_DIR", media)

    def unexpected_connection(*args, **kwargs):
        pytest.fail("Legacy migration must not rewrite a selected DB")

    monkeypatch.setattr(db, "get_connection", unexpected_connection)
    media_cache.migrate_sharding()
    media_cache.migrate_sharding()
    assert snapshot() == before
    result = asyncio.run(media_cache.cache_url_result("/media/synthetic.png"))
    assert result.path == "/media/synthetic.png" and result.status == "already"


def test_startup_does_not_create_missing_media_directory(tmp_path, monkeypatch):
    media = tmp_path / "missing"
    monkeypatch.setattr(media_cache, "MEDIA_DIR", media)
    media_cache.migrate_sharding()
    assert not media.exists()


def test_new_download_still_uses_sharded_storage(tmp_path, monkeypatch):
    monkeypatch.setattr(media_cache, "MEDIA_DIR", tmp_path)
    monkeypatch.setattr(media_cache, "_PRESERVED_QUOTA_STATE", media_cache._PreservedQuotaState())

    def download(url, target):
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(b"disposable downloaded fixture")

    monkeypatch.setattr(media_cache, "_download", download)
    result = asyncio.run(media_cache.cache_url_result("https://cdn.example.com/disposable.png"))
    assert result.path is not None
    relative = result.path.removeprefix("/media/")
    shard, filename = relative.split("/")
    assert shard == filename[:2]
    assert (tmp_path / relative).read_bytes() == b"disposable downloaded fixture"


@pytest.mark.parametrize("shard_exists", [False, True])
def test_cache_lookup_and_sync_reuse_legacy_or_sharded_file(tmp_path, monkeypatch, shard_exists):
    from app.repo import _common

    monkeypatch.setattr(media_cache, "MEDIA_DIR", tmp_path)
    url = "https://cdn.example.com/cached-fixture.png"
    shard_rel = media_cache.local_rel_for(url)
    filename = shard_rel.rsplit("/", 1)[-1]
    flat = tmp_path / filename
    flat.write_bytes(b"legacy fixture")
    if shard_exists:
        shard = tmp_path / shard_rel.removeprefix("/media/")
        shard.parent.mkdir()
        shard.write_bytes(b"sharded fixture")
    expected = shard_rel if shard_exists else f"/media/{filename}"

    def unexpected_download(*args):
        pytest.fail("Existing media must work even when the remote URL has expired")

    monkeypatch.setattr(media_cache, "_download", unexpected_download)
    result = asyncio.run(media_cache.cache_url_result(url))
    assert result.path == expected and result.status == "already"
    assert media_cache.is_cached(url)
    assert _common._cached_or_remote(url, True) == (expected, expected, url)
    assert _common._cached_or_remote(url, False) == (expected, None, url)
    assert flat.read_bytes() == b"legacy fixture"


def test_empty_legacy_file_is_not_a_cache_hit(tmp_path, monkeypatch):
    monkeypatch.setattr(media_cache, "MEDIA_DIR", tmp_path)
    url = "https://cdn.example.com/empty-fixture.png"
    filename = media_cache.local_rel_for(url).rsplit("/", 1)[-1]
    (tmp_path / filename).write_bytes(b"")
    assert media_cache.cached_rel_for(url) is None
    assert not media_cache.is_cached(url)


@pytest.mark.parametrize("change_during_lookup", [False, True])
def test_cached_result_rejects_an_old_database_operation(monkeypatch, change_during_lookup):
    epoch = db.pool_epoch()
    operation = (("", None), epoch)

    def lookup(url):
        if not change_during_lookup:
            pytest.fail("A stale operation must be rejected before cache lookup")
        monkeypatch.setattr(db, "_pool_epoch", epoch + 1)
        return "/media/legacy.png"

    monkeypatch.setattr(media_cache, "cached_rel_for", lookup)
    if not change_during_lookup:
        monkeypatch.setattr(db, "_pool_epoch", epoch + 1)
    token = db._share_operation.set(operation)
    try:
        with pytest.raises(db.DatabaseEpochChanged):
            asyncio.run(media_cache.cache_url_result("https://cdn.example.com/cached.png"))
    finally:
        db._share_operation.reset(token)

from __future__ import annotations

import importlib.util
import hashlib
import json
import os
import sqlite3
import pytest
from contextlib import closing
from pathlib import Path


def _module():
    path = Path(__file__).resolve().parents[2] / "tools" / "backup_replicate.py"
    spec = importlib.util.spec_from_file_location("backup_replicate", path)
    module = importlib.util.module_from_spec(spec)
    assert spec and spec.loader
    spec.loader.exec_module(module)
    return module


def _sqlite(path: Path, value: str) -> None:
    with closing(sqlite3.connect(path)) as conn:
        conn.execute("CREATE TABLE sample(value TEXT)")
        conn.execute("INSERT INTO sample VALUES(?)", (value,))
        conn.commit()


def _local_set(tmp_path, monkeypatch, stamp='20261018_010101_000001'):
    from app.services import backup
    source = tmp_path / 'content_hub.db'
    if not source.exists():
        with closing(sqlite3.connect(source)) as conn:
            conn.execute('CREATE TABLE generation(id TEXT PRIMARY KEY)')
            conn.execute("INSERT INTO generation VALUES('g1')")
            conn.commit()
        with closing(sqlite3.connect(tmp_path / 'content_hub_trash.db')) as conn:
            conn.execute('CREATE TABLE trashed(id TEXT PRIMARY KEY)')
    monkeypatch.setattr(backup, 'MANAGE_DB_PATH', tmp_path / 'no-manage.db')
    return backup._backup_now_for_scope(source, tmp_path / 'backups', stamp)


def test_local_set_replica_preserves_and_verifies_metadata(tmp_path, monkeypatch):
    from app.services import backup_manifest
    replicate = _module()
    monkeypatch.setattr(replicate, 'log', lambda _: None)
    content = _local_set(tmp_path, monkeypatch)
    dest = tmp_path / 'replica' / content.name
    assert replicate.copy_local_set(content, dest) == 'copied'
    assert backup_manifest.read_local(dest) == backup_manifest.read_local(content)
    assert replicate.copy_local_set(content, dest) == 'skip'
    with closing(sqlite3.connect(dest)) as conn:
        conn.execute("UPDATE generation SET id='broken'")
        conn.commit()
    assert replicate.copy_local_set(content, dest) == 'copied'
    assert backup_manifest.read_local(dest) == backup_manifest.read_local(content)


def test_local_set_replica_rejects_false_sidecar(tmp_path, monkeypatch):
    from app.services import backup_manifest
    replicate = _module()
    monkeypatch.setattr(replicate, 'log', lambda _: None)
    content = _local_set(tmp_path, monkeypatch)
    path = backup_manifest.local_path(content)
    manifest = json.loads(path.read_text('utf-8'))
    manifest['roles']['trash']['sha256'] = '0' * 64
    path.write_text(backup_manifest.canonical(backup_manifest.seal(manifest)), encoding='utf-8')
    dest = tmp_path / 'replica' / content.name
    assert replicate.copy_local_set(content, dest) == 'fail'
    assert not dest.exists()


def test_local_set_prune_keeps_or_removes_all_members(tmp_path, monkeypatch):
    from app.services import backup_manifest
    replicate = _module()
    monkeypatch.setattr(replicate, 'log', lambda _: None)
    monkeypatch.setattr(replicate, 'KEEP_PER_DIR', 1)
    content = _local_set(tmp_path, monkeypatch)
    dest = tmp_path / 'replica' / content.name
    assert replicate.copy_local_set(content, dest) == 'copied'
    trash = dest.with_name(dest.name.replace('content_hub_', 'content_trash_'))
    # One member remains in the existing newest-N files: retain its entire set.
    assert replicate.prune_dir(dest.parent, set()) == 0
    assert all(path.exists() for path in (dest, trash, backup_manifest.local_path(dest)))
    fresh = dest.parent / '20261018_020202_deadbeef.db'
    _sqlite(fresh, 'new')
    os.utime(fresh, (dest.stat().st_mtime + 10, dest.stat().st_mtime + 10))
    assert replicate.prune_dir(dest.parent, set()) == 2
    assert not any(path.exists() for path in (dest, trash, backup_manifest.local_path(dest)))


def test_legacy_single_db_rotation_does_not_claim_foreign_metadata(tmp_path, monkeypatch):
    replicate = _module()
    monkeypatch.setattr(replicate, 'KEEP_PER_DIR', 0)
    path = tmp_path / '20261018_020202_deadbeef.db'
    _sqlite(path, 'legacy')
    unrelated = path.with_suffix('.manifest.json')
    unrelated.write_text('{}', encoding='utf-8')
    assert replicate.prune_dir(tmp_path, set()) == 1
    assert unrelated.exists()


def test_main_copies_local_manifest_in_same_unit(tmp_path, monkeypatch):
    from app.services import backup_manifest
    replicate = _module()
    monkeypatch.setattr(replicate, 'ROOT', tmp_path / 'code')
    content = _local_set(tmp_path, monkeypatch)
    target = tmp_path / 'replica'
    monkeypatch.setattr(replicate, '_sources', lambda: [('backups', content.parent)])
    monkeypatch.setattr(replicate, 'replica_root', lambda: target)
    monkeypatch.setattr(replicate, 'STATUS_FILE', tmp_path / 'status.json')
    monkeypatch.setattr(replicate, 'log', lambda _: None)
    assert replicate.main() == 0
    assert backup_manifest.read_local(target / 'backups' / content.name) == backup_manifest.read_local(content)


@pytest.mark.parametrize('sub', ['backups', 'db-backups'])
def test_main_excludes_local_baseline_copies(tmp_path, monkeypatch, sub):
    replicate = _module()
    source = tmp_path / 'source'
    private = source / 'account/pre-dev2-baseline'
    private.mkdir(parents=True)
    _sqlite(private / 'content_hub.db.pre-dev2-baseline-20261021.db', 'local only')
    # Even a normal-looking set under the private folder must not be replicated.
    content = _local_set(private, monkeypatch)
    legacy = source / '20261021_010101_deadbeef.db'
    _sqlite(legacy, 'normal')
    target = tmp_path / 'replica'
    monkeypatch.setattr(replicate, 'ROOT', tmp_path / 'code')
    monkeypatch.setattr(replicate, 'DATA_DIR', tmp_path / 'data')
    monkeypatch.setattr(replicate, '_sources', lambda: [(sub, source)])
    monkeypatch.setattr(replicate, 'replica_root', lambda: target)
    monkeypatch.setattr(replicate, 'STATUS_FILE', tmp_path / 'status.json')
    monkeypatch.setattr(replicate, 'log', lambda _: None)
    assert replicate.main() == 0
    assert (target / sub / legacy.name).is_file()
    assert not (target / sub / private.relative_to(source)).exists()
    assert content.is_file()


def test_unpublished_local_set_does_not_poison_next_replica_cycle(tmp_path, monkeypatch):
    from app.services import backup, backup_manifest
    replicate = _module()
    stamp = '20261018_010101_000001'
    original = os.replace
    def fail_content(source, dest):
        if Path(dest).name == f'content_hub_{stamp}.db':
            raise OSError('injected content publish failure')
        return original(source, dest)
    with monkeypatch.context() as patch:
        patch.setattr(backup.os, 'replace', fail_content)
        with pytest.raises(OSError, match='injected'):
            _local_set(tmp_path, patch, stamp)
    unpublished = tmp_path / 'backups' / f'content_hub_{stamp}.db'
    assert backup_manifest.local_path(unpublished).exists() and not unpublished.exists()
    fresh = _local_set(tmp_path, monkeypatch, '20261018_010102_000001')
    target = tmp_path / 'replica'
    monkeypatch.setattr(replicate, 'ROOT', tmp_path / 'code')
    monkeypatch.setattr(replicate, '_sources', lambda: [('backups', fresh.parent)])
    monkeypatch.setattr(replicate, 'replica_root', lambda: target)
    monkeypatch.setattr(replicate, 'STATUS_FILE', tmp_path / 'status.json')
    monkeypatch.setattr(replicate, 'log', lambda _: None)
    assert replicate.main() == 0
    assert backup_manifest.read_local(target / 'backups' / fresh.name) == backup_manifest.read_local(fresh)
    assert backup_manifest.local_path(unpublished).exists()  # 원본 잔재 삭제가 해결책이 아니다.
    assert not any(stamp in path.name for path in target.rglob('*'))


def test_local_set_extra_destination_role_fails_without_overwriting(tmp_path, monkeypatch):
    replicate = _module()
    monkeypatch.setattr(replicate, 'log', lambda _: None)
    content = _local_set(tmp_path, monkeypatch)
    dest = tmp_path / 'replica' / content.name
    assert replicate.copy_local_set(content, dest) == 'copied'
    extra = dest.with_name(dest.name.replace('content_hub_', 'manage_hub_'))
    _sqlite(extra, 'preserve me')
    before = {path.name: path.read_bytes() for path in dest.parent.iterdir()}
    assert replicate.copy_local_set(content, dest) == 'fail'
    assert {path.name: path.read_bytes() for path in dest.parent.iterdir()} == before


def test_local_set_source_stat_error_is_not_unpublished(tmp_path, monkeypatch):
    replicate = _module()
    content = _local_set(tmp_path, monkeypatch)
    target = tmp_path / 'replica'
    monkeypatch.setattr(replicate, 'ROOT', tmp_path / 'code')
    monkeypatch.setattr(replicate, '_sources', lambda: [('backups', content.parent)])
    monkeypatch.setattr(replicate, 'replica_root', lambda: target)
    monkeypatch.setattr(replicate, 'STATUS_FILE', tmp_path / 'status.json')
    monkeypatch.setattr(replicate, 'log', lambda _: None)
    original = Path.stat
    def denied(path, *args, **kwargs):
        if path == content:
            raise PermissionError('injected access denied')
        return original(path, *args, **kwargs)
    monkeypatch.setattr(Path, 'stat', denied)
    assert replicate.main() == 1
    assert json.loads(replicate.STATUS_FILE.read_text('utf-8'))['error_code'] == 'source_unavailable'


def test_copy_validates_replica_before_publish(tmp_path):
    replicate = _module()
    src = tmp_path / "source.db"
    dest = tmp_path / "replica" / "source.db"
    _sqlite(src, "ok")

    assert replicate.copy_one(src, dest) == "copied"
    assert replicate._sqlite_valid(dest)
    assert not dest.with_suffix(".db.part").exists()


def test_corrupt_source_is_not_published(tmp_path, monkeypatch):
    replicate = _module()
    monkeypatch.setattr(replicate, "log", lambda _message: None)
    src = tmp_path / "broken.db"
    dest = tmp_path / "replica" / "broken.db"
    src.write_bytes(b"not sqlite")

    assert replicate.copy_one(src, dest) == "fail"
    assert not dest.exists()
    assert not dest.with_suffix(".db.part").exists()


def test_same_metadata_but_corrupt_replica_is_replaced(tmp_path):
    replicate = _module()
    src = tmp_path / "source.db"
    dest = tmp_path / "replica" / "source.db"
    _sqlite(src, "fresh")
    dest.parent.mkdir(parents=True)
    dest.write_bytes(b"x" * src.stat().st_size)
    os.utime(dest, (src.stat().st_atime, src.stat().st_mtime))

    assert replicate.copy_one(src, dest) == "copied"
    with closing(sqlite3.connect(dest)) as conn:
        assert conn.execute("SELECT value FROM sample").fetchone()[0] == "fresh"


def _backup_set(root: Path) -> tuple[Path, dict]:
    root.mkdir(parents=True, exist_ok=True)
    content = root / "content-source.db"
    trash = root / "trash-source.db"
    _sqlite(content, "content")
    _sqlite(trash, "trash")
    roles = {
        "content": {
            "size": content.stat().st_size,
            "sha256": hashlib.sha256(content.read_bytes()).hexdigest(),
        },
        "trash": {
            "size": trash.stat().st_size,
            "sha256": hashlib.sha256(trash.read_bytes()).hexdigest(),
        },
    }
    backup_set_id = hashlib.sha256(
        json.dumps(roles, sort_keys=True, separators=(",", ":")).encode()
    ).hexdigest()
    folder = root / backup_set_id
    folder.mkdir()
    (folder / "content.db").write_bytes(content.read_bytes())
    (folder / "trash.db").write_bytes(trash.read_bytes())
    manifest = {
        "format": "mvhub-worker-backup-set",
        "format_version": 1,
        "backup_set_id": backup_set_id,
        "roles": roles,
    }
    (folder / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
    return folder, manifest


def test_backup_set_is_replicated_with_manifest_as_one_publish(tmp_path, monkeypatch):
    replicate = _module()
    monkeypatch.setattr(replicate, "log", lambda _message: None)
    source, manifest = _backup_set(tmp_path / "source")
    destination = tmp_path / "replica" / source.name

    assert replicate.copy_set(source, destination) == "copied"
    assert replicate._set_manifest(destination) == manifest
    assert replicate.copy_set(source, destination) == "skip"
    assert not list(destination.parent.glob(".setpart-*"))


def test_invalid_set_never_publishes_partial_directory(tmp_path, monkeypatch):
    replicate = _module()
    monkeypatch.setattr(replicate, "log", lambda _message: None)
    source, _manifest = _backup_set(tmp_path / "source")
    (source / "trash.db").write_bytes(b"corrupt")
    destination = tmp_path / "replica" / source.name

    assert replicate.copy_set(source, destination) == "fail"
    assert not destination.exists()
    assert not list(destination.parent.glob(".setpart-*"))


def test_disabled_replica_writes_structured_non_success_status(tmp_path, monkeypatch):
    replicate = _module()
    status_file = tmp_path / "replica-status.json"
    monkeypatch.setattr(replicate, "STATUS_FILE", status_file)
    monkeypatch.setattr(replicate, "TARGET_FILE", tmp_path / "missing-target.txt")
    monkeypatch.delenv("CONTENT_HUB_BACKUP_REPLICA_DIR", raising=False)
    monkeypatch.setattr(replicate, "log", lambda _message: None)

    assert replicate.main() == 0
    status = json.loads(status_file.read_text("utf-8"))
    assert status["state"] == "disabled"
    assert status["configured"] is False
    assert status["last_success_at"] is None
    assert "target" not in status


def test_status_write_failure_returns_failure_without_exposing_exception(
    tmp_path, monkeypatch
):
    replicate = _module()
    messages: list[str] = []
    monkeypatch.setattr(replicate, "STATUS_FILE", tmp_path / "blocked" / "status.json")
    monkeypatch.setattr(replicate, "TARGET_FILE", tmp_path / "missing-target.txt")
    monkeypatch.delenv("CONTENT_HUB_BACKUP_REPLICA_DIR", raising=False)
    monkeypatch.setattr(replicate, "log", messages.append)
    monkeypatch.setattr(Path, "mkdir", lambda *_args, **_kwargs: (_ for _ in ()).throw(OSError("secret-path")))

    assert replicate.main() == 1
    assert any("status_write_failed" in message for message in messages)
    assert all("secret-path" not in message for message in messages)


def test_source_enumeration_failure_records_safe_structured_failure(tmp_path, monkeypatch):
    replicate = _module()
    monkeypatch.setattr(replicate, 'ROOT', tmp_path / 'code')
    source = tmp_path / "source"
    source.mkdir()
    target = tmp_path / "replica"
    status_file = tmp_path / "status.json"
    messages: list[str] = []

    class BrokenSource(type(source)):
        def rglob(self, _pattern):
            raise OSError("private-source-path")

    broken_source = BrokenSource(source)
    monkeypatch.setattr(replicate, "_sources", lambda: [("backups", broken_source)])
    monkeypatch.setattr(replicate, "replica_root", lambda: target)
    monkeypatch.setattr(replicate, "STATUS_FILE", status_file)
    monkeypatch.setattr(replicate, "log", messages.append)

    assert replicate.main() == 1
    status = json.loads(status_file.read_text("utf-8"))
    assert status["state"] == "failed"
    assert status["error_code"] == "source_unavailable"
    assert all("private-source-path" not in message for message in messages)


def test_main_replicates_legacy_and_set_backups_and_records_success(tmp_path, monkeypatch):
    replicate = _module()
    monkeypatch.setattr(replicate, 'ROOT', tmp_path / 'code')
    auto = tmp_path / "source" / "backups"
    uploaded = tmp_path / "source" / "db-backups"
    auto.mkdir(parents=True)
    uploaded.mkdir(parents=True)
    _sqlite(auto / "content_hub_1.db", "server")
    sets_root = uploaded / "account" / "sets"
    _backup_set(sets_root)
    target = tmp_path / "external-device"
    status_file = tmp_path / "replica-status.json"
    monkeypatch.setattr(
        replicate,
        "_sources",
        lambda: [("backups", auto), ("db-backups", uploaded)],
    )
    monkeypatch.setattr(replicate, "STATUS_FILE", status_file)
    monkeypatch.setattr(replicate, "replica_root", lambda: target)
    monkeypatch.setattr(replicate, "log", lambda _message: None)

    assert replicate.main() == 0
    status = json.loads(status_file.read_text("utf-8"))
    assert status["state"] == "success"
    assert status["last_success_at"]
    assert status["failed"] == 0
    assert (target / "backups" / "content_hub_1.db").is_file()
    replicated_sets = list((target / "db-backups" / "account" / "sets").glob("[0-9a-f]*"))
    assert len(replicated_sets) == 1
    assert replicate._set_manifest(replicated_sets[0]) is not None

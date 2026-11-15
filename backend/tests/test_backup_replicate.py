from __future__ import annotations

import importlib.util
import hashlib
import json
import os
import sqlite3
import pytest
from contextlib import closing
from pathlib import Path
from datetime import datetime, timedelta, timezone


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


@pytest.mark.parametrize('legacy', [False, True])
def test_c3_nas_keeps_calendar_sets_after_source_rotation(tmp_path, monkeypatch, legacy):
    from app.services import backup, backup_manifest
    replicate = _module()
    monkeypatch.setattr(replicate, 'log', lambda _: None)
    now = datetime(2026, 11, 15, 3, tzinfo=timezone.utc).timestamp()
    monkeypatch.setattr(replicate.time, 'time', lambda: now)
    template = _local_set(tmp_path, monkeypatch)
    manifest = backup_manifest.read_local(template)
    payloads = {role: path.read_bytes() for role, path in backup_manifest.local_paths(template, manifest).items()}
    dest = tmp_path / 'nas'
    dest.mkdir()
    paths = []
    ages = [day * 86400 for day in range(65, 0, -1)] + [hour * 600 for hour in range(10, 0, -1)]
    for age in ages:
        ts = now - age
        stamp = datetime.fromtimestamp(ts, timezone.utc).strftime('%Y%m%d_%H%M%S')
        content = dest / f'content_hub_{stamp}.db'
        members = backup_manifest.local_paths(content, manifest)
        for role, path in members.items():
            path.write_bytes(payloads[role])
            # Copy/restore time is not capture time.
            os.utime(path, (now, now))
        if not legacy:
            value = backup_manifest.seal({**manifest, 'captured_at': datetime.fromtimestamp(ts, timezone.utc).isoformat()})
            backup_manifest.local_path(content).write_text(backup_manifest.canonical(value), encoding='utf-8')
        paths.append((content, ts))
    expected = {p.name for p, _ in paths[-7:]}
    seen_days, seen_weeks = set(), set()
    today = datetime.fromtimestamp(now, backup.KEEP_TZ).date()
    monday = today - timedelta(days=today.weekday())
    for path, ts in reversed(paths):
        day = datetime.fromtimestamp(ts, backup.KEEP_TZ).date()
        week = day - timedelta(days=day.weekday())
        if (0 <= (today - day).days < 14 and day not in seen_days
                or 0 <= (monday - week).days < 56 and week not in seen_weeks):
            expected.add(path.name)
        seen_days.add(day)
        seen_weeks.add(week)
    # Even a single source member protects the entire oldest set, outside all windows.
    protected = paths[0][0].name.replace('content_hub_', 'content_trash_')
    expected.add(paths[0][0].name)
    orphan = dest / 'content_trash_20260101_010101.db'
    orphan.write_bytes(b'orphan')
    removed = replicate.prune_dir(dest, {protected})
    assert {p.name for p in dest.glob('content_hub_*.db')} == expected
    assert removed == 2 * (len(paths) - len(expected))
    assert orphan.exists()
    for content, _ in paths:
        assert content.with_name(content.name.replace('content_hub_', 'content_trash_')).exists() == (content.name in expected)
        if not legacy:
            assert backup_manifest.local_path(content).exists() == (content.name in expected)


def test_c3_clock_skew_logs_and_records_retention_pause(tmp_path, monkeypatch):
    replicate = _module()
    source = tmp_path / 'source'
    source.mkdir()
    future = source / 'content_hub_20990101_010101.db'
    _sqlite(future, 'future')
    target = tmp_path / 'replica'
    dest = target / 'backups'
    dest.mkdir(parents=True)
    for day in range(1, 9):
        _sqlite(dest / f'content_hub_202001{day:02d}_010101.db', 'old')
    monkeypatch.setattr(replicate, 'ROOT', tmp_path / 'code')
    monkeypatch.setattr(replicate, '_sources', lambda: [('backups', source)])
    monkeypatch.setattr(replicate, 'replica_root', lambda: target)
    monkeypatch.setattr(replicate, 'STATUS_FILE', tmp_path / 'status.json')
    monkeypatch.setattr(replicate, 'LOG', tmp_path / 'replica.log')
    monkeypatch.setattr(replicate.time, 'time', lambda: datetime(2026, 11, 15, tzinfo=timezone.utc).timestamp())

    assert replicate.main() == 0
    assert len(list(dest.glob('content_hub_*.db'))) == 9
    status = json.loads(replicate.STATUS_FILE.read_text('utf-8'))
    assert status['state'] == 'success'
    assert status['retention_blocked'] == 'clock_skew'
    assert 'clock_skew' in replicate.LOG.read_text('utf-8')

    # The next run recomputes the warning and resumes retention when the clock catches up.
    monkeypatch.setattr(replicate.time, 'time', lambda: datetime(2100, 1, 1, tzinfo=timezone.utc).timestamp())
    assert replicate.main() == 0
    assert json.loads(replicate.STATUS_FILE.read_text('utf-8'))['retention_blocked'] is None
    assert len(list(dest.glob('content_hub_*.db'))) == 7


@pytest.mark.parametrize('stat_denied', [False, True])
def test_c3_missing_nas_folder_does_not_hold_cleared_pause(tmp_path, monkeypatch, stat_denied):
    replicate = _module()
    source = tmp_path / 'source'
    incomplete = source / 'incomplete'
    incomplete.mkdir(parents=True)
    marker = incomplete / 'content_hub_20200101_010101.manifest.json'
    marker.write_text('{}', encoding='utf-8')
    _sqlite(source / 'content_hub_20990101_010101.db', 'future')
    target = tmp_path / 'replica'
    missing = target / 'backups' / 'incomplete'
    monkeypatch.setattr(replicate, 'ROOT', tmp_path / 'code')
    monkeypatch.setattr(replicate, '_sources', lambda: [('backups', source)])
    monkeypatch.setattr(replicate, 'replica_root', lambda: target)
    monkeypatch.setattr(replicate, 'STATUS_FILE', tmp_path / 'status.json')
    monkeypatch.setattr(replicate, 'log', lambda _: None)
    monkeypatch.setattr(replicate.time, 'time', lambda: datetime(2026, 11, 15, tzinfo=timezone.utc).timestamp())
    assert replicate.main() == 0
    assert json.loads(replicate.STATUS_FILE.read_text('utf-8'))['retention_blocked'] == 'clock_skew'
    assert not missing.exists()

    monkeypatch.setattr(replicate.time, 'time', lambda: datetime(2100, 1, 1, tzinfo=timezone.utc).timestamp())
    with monkeypatch.context() as fault:
        if stat_denied:
            original = Path.stat
            def stat(path, *args, **kwargs):
                if path == missing:
                    raise PermissionError('fixture')
                return original(path, *args, **kwargs)
            fault.setattr(Path, 'stat', stat)
        assert replicate.main() == 0
    result = json.loads(replicate.STATUS_FILE.read_text('utf-8'))
    assert result['retention_blocked'] == ('clock_skew' if stat_denied else None)
    assert marker.read_text('utf-8') == '{}'
    assert not missing.exists()


@pytest.mark.parametrize('stop,expected_state', [
    ('target_unavailable', 'failed'), ('target_unsafe', 'failed'),
    ('source_unavailable', 'failed'), ('no_source', 'no_source'),
    ('empty_source', 'success'), ('prune_unreadable', 'success'), ('partial_prune', 'success'),
    ('worker_only', 'success'),
])
def test_c3_retention_pause_survives_unassessed_run(tmp_path, monkeypatch, stop, expected_state):
    replicate = _module()
    source = tmp_path / 'source'
    source.mkdir()
    _sqlite(source / 'content_hub_20200101_010101.db', 'old')
    child = source / 'child'
    child.mkdir()
    _sqlite(child / 'content_hub_20200102_010101.db', 'old')
    empty = tmp_path / 'empty'
    empty.mkdir()
    target = tmp_path / 'replica'
    monkeypatch.setattr(replicate, 'ROOT', tmp_path / 'code')
    monkeypatch.setattr(replicate, '_sources', lambda: [('backups', source)])
    monkeypatch.setattr(replicate, 'replica_root', lambda: target)
    monkeypatch.setattr(replicate, 'STATUS_FILE', tmp_path / 'status.json')
    monkeypatch.setattr(replicate, 'log', lambda _: None)
    tid = replicate.target_id(str(target))
    assert replicate._write_status('success', target_id=tid, retention_blocked='clock_skew')
    with monkeypatch.context() as fault:
        if stop == 'target_unavailable':
            original = Path.mkdir
            def mkdir(path, *args, **kwargs):
                if path == target:
                    raise PermissionError('fixture')
                return original(path, *args, **kwargs)
            fault.setattr(Path, 'mkdir', mkdir)
        elif stop == 'target_unsafe':
            fault.setattr(replicate, 'target_overlaps', lambda _: True)
        elif stop == 'source_unavailable':
            class BrokenSource(type(source)):
                def rglob(self, pattern, **kwargs):
                    raise OSError('fixture')
            fault.setattr(replicate, '_sources', lambda: [('backups', BrokenSource(source))])
        elif stop in ('no_source', 'empty_source'):
            fault.setattr(replicate, '_sources', lambda: [('backups', empty if stop == 'empty_source' else tmp_path / 'missing')])
        elif stop == 'worker_only':
            _sqlite(empty / '20200101_010101_deadbeef.db', 'worker')
            fault.setattr(replicate, '_sources', lambda: [('db-backups', empty)])
        else:
            original = Path.glob
            def glob(path, pattern, **kwargs):
                if path == target / 'backups' or stop == 'prune_unreadable' and path == target / 'backups' / 'child':
                    raise PermissionError('fixture')
                return original(path, pattern, **kwargs)
            fault.setattr(Path, 'glob', glob)
        assert replicate.main() == (1 if expected_state == 'failed' else 0)
    result = json.loads(replicate.STATUS_FILE.read_text('utf-8'))
    assert result['state'] == expected_state
    assert result['retention_blocked'] == 'clock_skew'
    assert replicate.main() == 0
    assert json.loads(replicate.STATUS_FILE.read_text('utf-8'))['retention_blocked'] is None


@pytest.mark.parametrize('target', ['new-target', None])
def test_c3_retention_pause_is_not_transferred_to_another_target(tmp_path, monkeypatch, target):
    replicate = _module()
    monkeypatch.setattr(replicate, 'STATUS_FILE', tmp_path / 'status.json')
    assert replicate._write_status('success', target_id='old-target', retention_blocked='clock_skew')
    assert replicate._write_status('failed' if target else 'disabled', target_id=target)
    assert not json.loads(replicate.STATUS_FILE.read_text('utf-8')).get('retention_blocked')


@pytest.mark.skipif(os.name != 'nt', reason='Windows server console')
@pytest.mark.parametrize('state,reason,old_target,visible', [
    ('success', 'clock_skew', False, True),
    ('failed', 'clock_skew', False, True),
    ('success', None, False, False),
    ('success', 'clock_skew', True, False),
    ('success', 'policy_invalid', False, True),
])
def test_c3_console_shows_current_retention_pause(tmp_path, monkeypatch, state, reason, old_target, visible):
    from types import SimpleNamespace
    from unittest.mock import Mock
    monkeypatch.syspath_prepend(str(Path(__file__).resolve().parents[2] / 'tools'))
    from server_console import backup_helper, ui
    replicate = _module()
    monkeypatch.setattr(replicate, 'STATUS_FILE', tmp_path / 'status.json')
    monkeypatch.setattr(replicate, 'configured_target', lambda: (r'\\NAS\backup', 'file'))
    current_id = replicate.target_id(r'\\NAS\backup')
    assert replicate._write_status(state, target_id='old' if old_target else current_id,
                                   retention_blocked=reason)
    before = replicate.STATUS_FILE.read_bytes()
    setting = backup_helper.status(replicate)
    app = SimpleNamespace(status=None, backup_view={'setting': setting}, backup_shown='',
                          backup_busy=False, drill_busy=False, _backup_card=Mock(), _fill_sets=Mock())
    for name in ('backup_entry', 'backup_task', 'backup_reasons', 'backup_sets', 'drill_note',
                 'backup_save', 'backup_run', 'drill_button'):
        setattr(app, name, Mock())
    ui.App._show_backup(app)
    text = app.backup_reasons.configure.call_args.kwargs['text']
    assert ('세트 정리 멈춤' in text) == visible
    if visible:
        assert reason in text
        if reason == 'clock_skew':
            assert '서버 시계' in text and '미래 이름' in text
    nas = next(call.args for call in app._backup_card.call_args_list if call.args[0] == 'nas')
    assert nas[1] == ('아직 안 함' if old_target else '정상' if state == 'success' else '실패')
    assert replicate.STATUS_FILE.read_bytes() == before
    setting['result']['retention_blocked'] = None
    ui.App._show_backup(app)
    assert '세트 정리 멈춤' not in app.backup_reasons.configure.call_args.kwargs['text']


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
    monkeypatch.setattr(replicate, 'SERVER_RETENTION', {'recent': 1, 'daily_days': 0, 'weekly_weeks': 0})
    content = _local_set(tmp_path, monkeypatch)
    dest = tmp_path / 'replica' / content.name
    assert replicate.copy_local_set(content, dest) == 'copied'
    trash = dest.with_name(dest.name.replace('content_hub_', 'content_trash_'))
    # Retention counts complete sets, regardless of the number of members.
    assert replicate.prune_dir(dest.parent, set()) == 0
    assert all(path.exists() for path in (dest, trash, backup_manifest.local_path(dest)))
    fresh = _local_set(tmp_path, monkeypatch, '20261018_020202_000001')
    assert replicate.copy_local_set(fresh, dest.parent / fresh.name) == 'copied'
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


@pytest.mark.parametrize('prefix', ['content_trash_', 'manage_hub_'])
def test_c3_orphan_roles_keep_latest_30_and_protect_source(tmp_path, prefix):
    replicate = _module()
    files = []
    for index in range(35):
        path = tmp_path / f'{prefix}20261001_010101_{index:06d}.db'
        path.write_bytes(b'legacy')
        os.utime(path, (1000 + index, 1000 + index))
        files.append(path)
    assert replicate.prune_dir(tmp_path, {files[0].name}) == 4
    assert set(tmp_path.glob('*.db')) == {files[0], *files[-30:]}


def test_c3_set_members_bypass_single_file_limit(tmp_path, monkeypatch):
    from app.services import backup_manifest
    replicate = _module()
    content = _local_set(tmp_path, monkeypatch)
    dest = tmp_path / 'replica' / content.name
    assert replicate.copy_local_set(content, dest) == 'copied'
    # A content-only legacy backup is also a set under backup._set_complete.
    legacy = dest.parent / 'content_hub_20200101_010101.db'
    _sqlite(legacy, 'legacy')
    before = {p.name: p.read_bytes() for p in dest.parent.iterdir()}
    monkeypatch.setattr(replicate, 'KEEP_PER_DIR', 0)
    assert replicate.prune_dir(dest.parent, set()) == 0
    assert {p.name: p.read_bytes() for p in dest.parent.iterdir()} == before
    assert backup_manifest.read_local(dest) is not None


@pytest.mark.parametrize('anchor', [
    'content_hub_20200101_010101.manifest.json',
    'content_hub_20200101_010101.keep.json',
    'agent_chat_20200101_010101.db',
    'asset_mounts_20200101_010101.json',
])
def test_c3_incomplete_set_members_bypass_single_file_limit(tmp_path, monkeypatch, anchor):
    replicate = _module()
    for name in (anchor, 'content_trash_20200101_010101.db', 'manage_hub_20200101_010101.db'):
        (tmp_path / name).write_bytes(b'incomplete')
    before = {p.name: p.read_bytes() for p in tmp_path.iterdir()}
    monkeypatch.setattr(replicate, 'KEEP_PER_DIR', 0)
    assert replicate.prune_dir(tmp_path, set()) == 0
    assert {p.name: p.read_bytes() for p in tmp_path.iterdir()} == before


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


def _v3_server_set(root: Path, *, absent=()):
    from test_worker_offdisk_backup import _server_v3_fixture
    from app.services import backup_manifest
    import shutil
    value, paths = _server_v3_fixture(root / 'input', absent=absent)
    folder = root / 'artist' / 'sets' / value['backup_set_id']
    folder.mkdir(parents=True)
    for role, path in paths.items():
        shutil.copyfile(path, folder / backup_manifest.WORKER_FILENAMES[role])
    (folder / 'manifest.json').write_text(backup_manifest.canonical(value), encoding='utf-8')
    return folder, value


@pytest.mark.parametrize('absent', [(), ('agent_chat', 'asset_mounts')])
def test_v3_server_set_nas_full_roundtrip_and_pruning(tmp_path, monkeypatch, absent):
    from app.services import backup_manifest
    replicate = _module()
    monkeypatch.setattr(replicate, 'log', lambda _: None)
    source_root = tmp_path / 'source'
    source, value = _v3_server_set(source_root, absent=absent)
    assert replicate._set_manifest(source) == value
    paths = backup_manifest.worker_paths(value, source, check_present=True)
    assert all(replicate._is_our_set_file(source_root, path) for path in paths.values())
    dest = tmp_path / 'replica/artist/sets' / source.name
    assert replicate.copy_set(source, dest) == 'copied'
    assert replicate.copy_set(source, dest) == 'skip'
    assert replicate._set_manifest(dest) == value
    assert {p.name: p.read_bytes() for p in dest.iterdir()} == {p.name: p.read_bytes() for p in source.iterdir()}
    monkeypatch.setattr(replicate, 'KEEP_PER_DIR', 0)
    assert replicate.prune_set_root(dest.parent, {dest.name}) == 0
    assert replicate.prune_set_root(dest.parent, set()) == 1
    assert not dest.exists()


@pytest.mark.parametrize('stage', ['.setpart-fixture', '.setold-fixture'])
def test_v3_agent_nas_leftovers_are_owned(tmp_path, stage):
    replicate = _module()
    path = tmp_path / 'artist/sets' / stage / 'agent_chat.db'
    assert replicate._is_our_set_file(tmp_path, path)


@pytest.mark.parametrize('damage', ['absent_file', 'absent_directory', 'stat_error', 'json_tamper'])
def test_v3_nas_rejects_hidden_or_unreadable_members(tmp_path, monkeypatch, damage):
    replicate = _module()
    source, value = _v3_server_set(tmp_path, absent=('agent_chat',))
    agent = source / 'agent_chat.db'
    if damage == 'absent_file': agent.write_bytes(b'unexpected')
    elif damage == 'absent_directory': agent.mkdir()
    elif damage == 'json_tamper':
        path = source / 'asset_mounts.json'
        path.write_bytes(path.read_bytes().replace(b'old', b'new'))
    else:
        original = Path.stat
        def stat(path, *args, **kwargs):
            if path == agent: raise PermissionError('fixture')
            return original(path, *args, **kwargs)
        monkeypatch.setattr(Path, 'stat', stat)
    assert replicate._set_manifest(source) is None


@pytest.mark.parametrize('damage', ['copy', 'staged'])
def test_v3_nas_copy_failure_preserves_existing_copy(tmp_path, monkeypatch, damage):
    replicate = _module()
    monkeypatch.setattr(replicate, 'log', lambda _: None)
    source, _ = _v3_server_set(tmp_path / 'source')
    dest = tmp_path / 'replica' / source.name
    assert replicate.copy_set(source, dest) == 'copied'
    before = {p.name: p.read_bytes() for p in dest.iterdir()}
    original_manifest = replicate._set_manifest
    monkeypatch.setattr(replicate, '_set_manifest', lambda folder, **kw:
                        None if folder == dest else original_manifest(folder, **kw))
    original_copy = replicate.shutil.copyfile
    def copy(src, dst, **kwargs):
        if damage == 'copy' and Path(src).name == 'agent_chat.db': raise OSError('fixture NAS outage')
        result = original_copy(src, dst, **kwargs)
        if damage == 'staged' and Path(src).name == 'asset_mounts.json':
            Path(dst).write_bytes(Path(dst).read_bytes() + b' ')
        return result
    monkeypatch.setattr(replicate.shutil, 'copyfile', copy)
    assert replicate.copy_set(source, dest) == 'fail'
    assert {p.name: p.read_bytes() for p in dest.iterdir()} == before
    assert not list(dest.parent.glob('.setpart-*'))


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

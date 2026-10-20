import importlib
from pathlib import Path

import pytest

from app import db, schema_compat


@pytest.fixture
def probe(monkeypatch):
    monkeypatch.syspath_prepend(str(Path(__file__).resolve().parents[2] / 'tools'))
    return importlib.import_module('install_db_probe')


def test_checkpoint_uses_private_copies_and_preserves_original_set(probe, tmp_path):
    root = tmp_path / 'install'
    path = root / 'backend/data/db/content_hub.db'
    path.parent.mkdir(parents=True)
    db.init_db(path)
    before = probe.file_set([('content', path)])
    result = probe.snapshot(root, tmp_path / 'checkpoint', {}, schema_compat.inspect_database)
    assert probe.file_set([('content', path)]) == before
    assert result[0]['status'] == 'compatible'
    assert result[0]['database_id'] == schema_compat.inspect_database(path, 'content').database_id
    assert 'install' not in str(result) and str(path) not in str(result)
    checkpoint = tmp_path / 'checkpoint' / result[0]['checkpoint']
    assert probe.file_digest(checkpoint) == result[0]['sha256']


def test_actual_content_v2_checkpoint_blocks_v1_program_rollback(probe, tmp_path):
    from app.services.install_journal import rollback_decision
    root = tmp_path / 'install'
    path = root / 'backend/data/db/content_hub.db'
    path.parent.mkdir(parents=True)
    db.init_db(path)
    rows = probe.snapshot(root, tmp_path / 'checkpoint', {}, schema_compat.inspect_database)
    assert rows[0]['schema_version'] == 2
    assert 'content_share_commands' in rows[0]['components']
    record = {'db_mutation_possible': True, 'checkpoints': rows}
    previous = {'db_schema': {'read_min': 1, 'read_max': 1, 'write_min': 1, 'write_max': 1},
                'reader_protocol': 1, 'writer_protocol': 2,
                'supported_components': list(rows[0]['components'])}
    assert rollback_decision(record, rows, previous) == 'recovery_required'
    previous['db_schema'].update(read_max=2, write_max=2)
    previous['supported_components'].remove('content_share_commands')
    assert rollback_decision(record, rows, previous) == 'recovery_required'
    previous['supported_components'].append('content_share_commands')
    assert rollback_decision(record, rows, previous) == 'program_only'


def test_parent_explicit_db_and_all_account_databases_are_included(probe, tmp_path):
    data = tmp_path / 'data'
    names = ['db/content_hub.db', 'db/acct/a/content_hub.db', 'db/acct/a/content_hub_trash.db', 'db/manage_hub.db']
    for name in names:
        path = data / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(b'fixture discovery only')
    explicit = tmp_path / 'explicit.db'
    explicit.write_bytes(b'fixture')
    rows = probe.database_paths(tmp_path, {'CONTENT_HUB_DATA': str(data), 'CONTENT_HUB_DB': str(explicit)})
    assert {path for _, path in rows} == {data / n for n in names} | {explicit}


def test_changing_source_after_copy_aborts_checkpoint(probe, tmp_path):
    root = tmp_path / 'install'
    path = root / 'backend/data/db/content_hub.db'
    path.parent.mkdir(parents=True)
    db.init_db(path)
    from app.services.backup_verify import create_database_set_snapshot
    def mutate(sources, targets):
        create_database_set_snapshot(sources, targets)
        with path.open('ab') as stream:
            stream.write(b'fixture mutation')
    with pytest.raises(ValueError, match='changed_while'):
        probe.snapshot(root, tmp_path / 'checkpoint', {}, schema_compat.inspect_database, snapshotter=mutate)


def test_relative_or_network_db_override_is_refused_before_copy(probe, tmp_path):
    for override in ['relative.db', r'\\fixture-server\share\content.db']:
        with pytest.raises(ValueError, match='local_absolute'):
            probe.database_paths(tmp_path, {'CONTENT_HUB_DB': override})

"""Isolated provenance integration checks; no real server, provider or user media."""
import hashlib
import asyncio
import importlib.util
import io
import json
import sqlite3
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import pytest

from app import db, repo
from app import schema_compat
from app.repo import asset_registry, asset_sync, gen_requests, identity, projects
from app.services.worker_backup import metadata_summary
from app.services.db_scrub import strip_transfer_secrets, scrub_test_snapshot_db
from app.services import asset_sync as sync
from app.models import PendingRequestOut
from app.usecases.gen_requests import GenRequestCommand, repair_canvas_generation_links, submit_gen_request
from app.routers import asset_sync as sync_api
from fastapi import HTTPException


@pytest.fixture
def content(tmp_path, monkeypatch):
    db.flush_pool()
    path = tmp_path / 'content.db'
    monkeypatch.setenv('CONTENT_HUB_DB', str(path))
    db.init_db(path)
    repo.ensure_default_worker()
    yield path
    db.flush_pool()


def test_actual_digest_not_client_claim_and_reference_order(content):
    sha = hashlib.sha256(b'actual submitted bytes').hexdigest()
    token = 'asset-sync:' + 'a' * 32
    gid = repo.create_local_generation({
        'prompt': 'test', 'references': [
            {'file_path': token, 'role': '@Image2', 'asset_content_id': 'sha256:' + 'f' * 64},
            {'file_path': 'asset:captures|other.png', 'role': '@Image1'},
        ]}, 'me', creator_uid='user_a')
    assert 'asset_content_id' not in gen_requests.gen_recipe(gid)['references'][0]
    with db.get_connection() as conn:
        gen_requests._attach_submission_ref_digests(conn, gid, {'ref_digests': {
            token: {'sha256': sha, 'bytes': 22},
            'asset:captures|other.png': {'sha256': sha, 'bytes': 22},
        }})
    refs = gen_requests.gen_recipe(gid)['references']
    assert [r['role'] for r in refs] == ['@Image2', '@Image1']
    assert refs[0]['file_path'] == token
    assert all(r['asset_content_id'] == 'sha256:' + sha for r in refs)
    with db.get_connection() as conn:
        assert conn.execute('SELECT count(*) FROM asset_blob').fetchone()[0] == 1


def test_content_protocol_survives_claim_and_http_serialization(content):
    gid = repo.create_local_generation({'prompt': 'test'}, 'me', creator_uid='user_a')
    gen_requests.create_gen_request('test@example.invalid', 'user_a', gid, 'create', {
        'model': 'test', 'prompt': 'test', 'asset_content_protocol': 1, 'project_id': 'project-a'})
    pending = gen_requests.claim_pending_requests('test@example.invalid', lease_owner='agent', submission_stage_capable=True)
    wire = PendingRequestOut.model_validate(pending[0]).model_dump()
    assert wire['asset_content_protocol'] == 1 and wire['project_id'] == 'project-a'


@pytest.mark.parametrize('legacy', [False, True])
def test_regeneration_preserves_reference_positions_and_legacy_order(content, legacy):
    parent = repo.create_local_generation({'prompt': 'parent', 'model': 'nano-banana', 'references': [
        {'file_path': 'asset:captures|first.png', 'role': '@Image1'},
        {'file_path': 'asset:captures|second.png', 'role': '@Image2'},
    ]}, 'me', creator_uid='user_a')
    with db.get_connection() as conn:
        conn.execute('UPDATE gen_reference SET position=' + ('NULL' if legacy else '1-position')
                     + ' WHERE generation_id=?', (parent,))
        expected_positions = [r[0] for r in conn.execute(
            'SELECT position FROM gen_reference WHERE generation_id=? ORDER BY COALESCE(position,rowid),rowid', (parent,))]
    expected = [r['role'] for r in gen_requests.gen_recipe(parent)['references']]
    command = GenRequestCommand(kind='regenerate', email='test@example.invalid', creator_uid='user_a',
        worker_id='me', source_gen_id=parent, workspace={'scope': 'personal'}, data=None)
    with patch('app.usecases.gen_requests.MANAGE_ENABLED', False), patch('app.usecases.gen_requests.journal_generation_event'):
        child = asyncio.run(submit_gen_request(command))['id']
    with db.get_connection() as conn:
        positions = [r[0] for r in conn.execute(
            'SELECT position FROM gen_reference WHERE generation_id=? ORDER BY COALESCE(position,rowid),rowid', (child,))]
    assert positions == expected_positions
    assert [r['role'] for r in gen_requests.gen_recipe(child)['references']] == expected


@pytest.mark.parametrize('same_url', [False, True])
def test_source_url_submission_links_exact_reference_ids(content, tmp_path, same_url):
    refs = [{'file_path': f'asset:captures|{n}.png', 'source_url': f'https://cdn.example.invalid/{0 if same_url else n}.png',
             'type': 'image', 'role': f'@Image{n + 1}'} for n in range(2)]
    gid = repo.create_local_generation({'prompt': 'test', 'model': 'nano-banana', 'references': refs},
                                      'me', creator_uid='user_a', workspace={'scope': 'personal'})
    recipe = gen_requests.gen_recipe(gid)
    cache = {}
    for index, ref in enumerate(recipe['references']):
        path = tmp_path / f'{index}.png'
        path.write_bytes(b'actual submitted bytes' + bytes([0 if same_url else index]))
        cache[ref['file_path']] = str(path)
    request = {'id': 'r', 'claim_phase': 'claimed', 'asset_content_protocol': 1, **recipe}
    agent = _agent()

    def begin(_server, _token, _rid, _owner, fingerprint):
        with db.get_connection() as conn:
            gen_requests._attach_submission_ref_digests(conn, gid, fingerprint)
        return True

    with patch.object(agent, '_allowed_params', return_value=set()), \
            patch.object(agent, '_preserve_reference', return_value=True), \
            patch.object(agent, '_ensure_request_workspace', return_value=('test-workspace', None)), \
            patch.object(agent, '_begin_submission', side_effect=begin) as reported, \
            patch.object(agent, '_run_cli_json', return_value=(['12345678-1234-1234-1234-123456789abc'], None)), \
            patch.object(agent, '_outbox_add'), patch.object(agent, '_anchor_with_retry', return_value=True):
        assert agent._submit_one('http://hub', 'fake-token', 'cli', 'test@example.invalid', request,
                                 cache, {}, agent.Lock(), agent.Lock(), 'agent')
    with db.get_connection() as conn:
        rows = conn.execute('SELECT r.file_path,r.content_sha,r.asset_content_id FROM reference r '
                            'JOIN gen_reference gr ON gr.reference_id=r.id WHERE gr.generation_id=? ORDER BY gr.position', (gid,)).fetchall()
    for source, submitted, row in zip(refs, recipe['references'], rows):
        digest = hashlib.sha256(Path(cache[submitted['file_path']]).read_bytes()).hexdigest()
        assert row['file_path'] == source['file_path']
        assert row['content_sha'] == digest and row['asset_content_id'] == 'sha256:' + digest
    assert len(reported.call_args.args[4]['ref_digests']) == 2


@pytest.mark.parametrize('invalid_id', [None, '', 1, ['invalid']])
def test_submission_invalid_reference_id_never_falls_back_to_path(content, invalid_id):
    gid = repo.create_local_generation({'prompt': 'test', 'references': [{'file_path': 'asset:captures|same.png'}]},
                                      'me', creator_uid='user_a')
    with db.get_connection() as conn:
        gen_requests._attach_submission_ref_digests(conn, gid, {'ref_digests': {
            'asset:captures|same.png': {'sha256': 'a' * 64, 'bytes': 1, 'reference_id': invalid_id}}})
        assert conn.execute('SELECT asset_content_id FROM reference').fetchone()[0] is None


def test_submission_reference_id_cannot_bind_another_generation_or_fallback(content):
    data = {'prompt': 'test', 'references': [{'file_path': 'asset:captures|same.png'}]}
    first = repo.create_local_generation(data, 'me', creator_uid='user_a')
    second = repo.create_local_generation(data, 'me', creator_uid='user_a')
    with db.get_connection() as conn:
        other_id = conn.execute('SELECT reference_id FROM gen_reference WHERE generation_id=?', (second,)).fetchone()[0]
        gen_requests._attach_submission_ref_digests(conn, first, {'ref_digests': {
            'asset:captures|same.png': {'sha256': 'a' * 64, 'bytes': 1, 'reference_id': other_id}}})
        assert all(r[0] is None for r in conn.execute('SELECT asset_content_id FROM reference'))


def test_legacy_digest_cannot_mix_old_sha_with_new_content_id(content):
    gid = repo.create_local_generation({'prompt': 'test', 'references': [{'file_path': 'asset:captures|known.png'}]},
                                      'me', creator_uid='user_a')
    with db.get_connection() as conn:
        conn.execute('UPDATE reference SET content_sha=?,content_bytes=1', ('a' * 64,))
        gen_requests._attach_submission_ref_digests(conn, gid, {'ref_digests': {
            'asset:captures|known.png': {'sha256': 'b' * 64, 'bytes': 2}}})
        row = conn.execute('SELECT content_sha,content_bytes,asset_content_id FROM reference').fetchone()
    assert tuple(row) == ('a' * 64, 1, None)


def test_regeneration_does_not_certify_parent_unverified_reference(content):
    parent = repo.create_local_generation({'prompt': 'parent', 'references': [
        {'file_path': 'asset:captures|legacy.png', 'source_url': 'https://cdn.example.invalid/legacy.png'}]},
        'me', creator_uid='user_a')
    child = repo.import_generation(parent, 'me', creator_uid='user_a')
    child_ref = gen_requests.gen_recipe(child)['references'][0]['reference_id']
    with db.get_connection() as conn:
        gen_requests._attach_submission_ref_digests(conn, child, {'ref_digests': {
            child_ref: {'sha256': 'a' * 64, 'bytes': 1, 'reference_id': child_ref}}})
        rows = conn.execute('SELECT gr.generation_id,r.id,r.asset_content_id FROM gen_reference gr '
                            'JOIN reference r ON r.id=gr.reference_id').fetchall()
    by_generation = {r['generation_id']: r for r in rows}
    assert by_generation[parent]['asset_content_id'] is None
    assert by_generation[parent]['id'] != child_ref
    assert by_generation[child]['asset_content_id'] == 'sha256:' + 'a' * 64


def test_legacy_sha_without_cid_remains_an_expected_input(content, tmp_path):
    gid = repo.create_local_generation({'prompt': 'parent', 'model': 'nano-banana', 'references': [
        {'file_path': 'asset:captures|legacy.png'}]}, 'me', creator_uid='user_a')
    with db.get_connection() as conn:
        conn.execute('UPDATE reference SET content_sha=?,content_bytes=1', ('a' * 64,))
    recipe = gen_requests.gen_recipe(gid)
    assert recipe['references'][0]['asset_content_id'] == 'sha256:' + 'a' * 64
    actual = tmp_path / 'changed.png'
    actual.write_bytes(b'changed bytes')
    agent = _agent()
    with patch.object(agent, '_allowed_params', return_value=set()), patch.object(agent, '_fail') as failed, \
            patch.object(agent, '_run_cli_json') as paid, patch.object(agent, '_preserve_reference') as preserved:
        assert agent._submit_one('http://hub', 'fake-token', 'cli', 'test@example.invalid',
            {'id': 'r', 'asset_content_protocol': 1, **recipe},
            {'asset:captures|legacy.png': str(actual)}, {}, agent.Lock(), agent.Lock(), 'agent') is None
    failed.assert_called_once()
    paid.assert_not_called()
    preserved.assert_not_called()
    with db.get_connection() as conn:
        assert conn.execute('SELECT asset_content_id FROM reference').fetchone()[0] is None


def test_placeholder_retry_ignores_internal_reference_ids_but_preserves_claim_identity(content):
    link = {'attempt_id': 'attempt_1234567890_refs', 'generation_id': 'generation_1234567890_refs',
            'scene_id': 'scene-a', 'card_id': 'card-a'}
    command = GenRequestCommand(kind='create', email='test@example.invalid', creator_uid='user_a', worker_id='me',
        source_gen_id=None, workspace={'scope': 'personal'}, canvas_link=link,
        data={'prompt': 'test', 'model': 'nano-banana', 'references': [
            {'file_path': 'asset:captures|one.png', 'type': 'image', 'role': '@Image1'}]})
    with patch('app.usecases.gen_requests.MANAGE_ENABLED', False), patch('app.usecases.gen_requests.journal_generation_event'):
        with patch('app.usecases.gen_requests.repo.activate_canvas_gen_request', side_effect=RuntimeError('before activation')):
            with pytest.raises(RuntimeError, match='before activation'):
                asyncio.run(submit_gen_request(command))
        assert asyncio.run(submit_gen_request(command))['id'] == link['generation_id']
    claimed = gen_requests.claim_pending_requests('test@example.invalid', workspace_capable=True,
        lease_owner='agent', submission_stage_capable=True)
    wire = PendingRequestOut.model_validate(claimed[0]).model_dump()
    assert wire['references'][0]['reference_id'] == gen_requests.gen_recipe(link['generation_id'])['references'][0]['reference_id']


def test_new_request_claim_keeps_expected_identity_without_certifying_it(content, tmp_path):
    with db.get_connection() as conn:
        conn.execute("INSERT INTO project(id,name) VALUES('p','Project')")
    source = tmp_path / 'input.png'
    source.write_bytes(b'changed after selection')
    ref = 'asset:captures|one.png'
    expected = 'sha256:' + hashlib.sha256(b'original selection').hexdigest()
    command = GenRequestCommand(kind='create', email='test@example.invalid', creator_uid='user_a', worker_id='me',
        source_gen_id=None, workspace={'scope': 'personal'}, data={'prompt': 'test', 'model': 'nano-banana',
        'project_id': 'p', 'references': [{'file_path': ref, 'type': 'image', 'role': '@Image1', 'asset_content_id': expected}]})
    with patch('app.usecases.gen_requests.MANAGE_ENABLED', False), patch('app.usecases.gen_requests.journal_generation_event'):
        created = asyncio.run(submit_gen_request(command))
    with db.get_connection() as conn:
        assert conn.execute('SELECT asset_content_id FROM reference').fetchone()[0] is None
    claimed = gen_requests.claim_pending_requests('test@example.invalid', workspace_capable=True, lease_owner='agent', submission_stage_capable=True)
    wire = PendingRequestOut.model_validate(claimed[0]).model_dump()
    assert wire['references'][0]['expected_asset_content_id'] == expected
    agent = _agent()
    with patch.object(agent, '_allowed_params', return_value=set()), patch.object(agent, '_fail') as failed, \
            patch.object(agent, '_run_cli_json') as paid, patch.object(agent, '_preserve_reference') as preserved:
        agent._submit_one('http://hub', 'fake-token', 'cli', 'test@example.invalid', wire,
                          {ref: str(source)}, {}, agent.Lock(), agent.Lock(), 'agent')
    failed.assert_called_once()
    paid.assert_not_called()
    preserved.assert_not_called()
    assert repo.get_generation(created['id'])['project_id'] == 'p'


def test_orphan_repair_claim_keeps_preservation_protocol_and_project(content):
    with db.get_connection() as conn:
        conn.execute("INSERT INTO project(id,name) VALUES('p','Project')")
    link = {'attempt_id': 'attempt_1234567890_a', 'generation_id': 'generation_1234567890_a', 'scene_id': 'scene-a', 'card_id': 'card-a'}
    repo.create_local_generation({'prompt': 'orphan', 'project_id': 'p'}, 'me', creator_uid='user_a',
                                 workspace={'scope': 'personal'}, generation_id=link['generation_id'])
    repair_canvas_generation_links('test@example.invalid', 'user_a', [link])
    claimed = gen_requests.claim_pending_requests('test@example.invalid', workspace_capable=True, lease_owner='agent', submission_stage_capable=True)
    wire = PendingRequestOut.model_validate(claimed[0]).model_dump()
    assert wire['asset_content_protocol'] == 1 and wire['project_id'] == 'p'


def test_project_assets_root_is_explicit_and_mirror_omission_preserves(content, tmp_path):
    project = projects.create_project('Root test', created_by='user_a', asset_root_path=str(tmp_path / 'assets'))
    pid = project['id']
    projects.set_render_root(pid, str(tmp_path / 'render'))
    projects.cache_projects([{'id': pid, 'name': 'Root test'}])
    assert projects.get_project(pid)['asset_root_path'] == str(tmp_path / 'assets')
    projects.cache_projects([{'id': pid, 'name': 'Root test', 'asset_root_path': None}])
    assert projects.get_project(pid)['asset_root_path'] is None
    with pytest.raises(ValueError):
        projects.set_asset_root(pid, r'..\outside')


@pytest.mark.parametrize('state', ['queued', 'uploading', 'ready', 'retrying', 'verification_failed', 'project_required'])
def test_root_change_requeues_with_old_receipt_but_cancels_stale_lease(content, tmp_path, state):
    project = projects.create_project('Root migration', created_by='user_a', asset_root_path=str(tmp_path / 'old-assets'))
    source = tmp_path / 'capture.png'
    source.write_bytes(b'old bytes')
    with db.get_connection() as conn:
        asset_sync.register_local(conn, path=source, file_path='asset:captures|one.png',
            digest=hashlib.sha256(source.read_bytes()).hexdigest(), size=9, media_type='image',
            owner_uid='user_a', project_id=project['id'], server_origin='http://example.invalid', account_key='a')
        receipt = json.dumps({'location_id': 'a' * 32, 'root_revision': 'old-root'})
        conn.execute("UPDATE asset_sync_outbox SET state=?,receipt_json=?,storage_id='old',root_revision='old-root',lease_token='stale',lease_until=9999999999,next_retry_at=123", (state, receipt))
        file = asset_registry.RegistryFile('old.png', 9, 1, 'a' * 64, 'ok')
        asset_registry.apply_plan(conn, project['id'], {'inserts': [('old-reg', file)], 'updates': [], 'events': []})
    projects.cache_projects([{'id': project['id'], 'name': project['name'], 'asset_root_path': str(tmp_path / 'new-assets')}])
    with db.get_connection() as conn:
        row = conn.execute('SELECT * FROM asset_sync_outbox').fetchone()
        assert row['state'] == 'queued' and row['lease_token'] is None and row['storage_id'] == ''
        assert row['root_revision'] == '' and row['lease_until'] is None and row['next_retry_at'] == 0
        assert row['receipt_json'] == receipt
        assert conn.execute('SELECT state FROM asset_registry').fetchone()[0] == 'missing'
        assert not asset_sync.settle(conn, {**dict(row), 'lease_token': 'stale'}, receipt={'location_id': 'b' * 32})


def test_uid_collision_preserves_old_location_alias_and_idempotency(content, tmp_path):
    source = tmp_path / 'capture.png'
    source.write_bytes(b'test image')
    sha = hashlib.sha256(source.read_bytes()).hexdigest()
    with db.get_connection() as conn:
        args = dict(path=source, file_path='asset:captures|one.png', digest=sha,
                    size=10, media_type='image', project_id='p', account_key='a',
                    server_origin='http://example.invalid')
        asset_sync.register_local(conn, owner_uid='acct:a', **args)
        asset_sync.register_local(conn, owner_uid='user_a', **args)
        old_id = conn.execute("SELECT location_id FROM asset_location WHERE owner_uid='acct:a'").fetchone()[0]
        new_id = conn.execute("SELECT location_id FROM asset_location WHERE owner_uid='user_a'").fetchone()[0]
        assert old_id != new_id
        identity.remap_creator_uid(conn, 'acct:a', 'user_a')
        assert asset_sync.resolve_location_id(conn, old_id) == new_id
        assert conn.execute('PRAGMA foreign_key_check').fetchall() == []
        assert conn.execute('SELECT count(*) FROM asset_sync_outbox').fetchone()[0] == 1
        conn.execute("UPDATE asset_sync_outbox SET state='ready'")
        identity.remap_creator_uid(conn, 'acct:a', 'user_a')
        assert conn.execute('SELECT state FROM asset_sync_outbox').fetchone()[0] == 'ready'
    assert source.read_bytes() == b'test image'


def test_owned_content_cannot_be_claimed_by_path_alias_or_reference_metadata(content, tmp_path):
    source = tmp_path / 'private.png'
    source.write_bytes(b'private bytes')
    forged = tmp_path / 'other.png'
    forged.write_bytes(b'other bytes')
    actual_sha = hashlib.sha256(source.read_bytes()).hexdigest()
    with db.get_connection() as conn:
        asset_sync.register_local(conn, path=source, file_path='/media/private.png', digest=actual_sha,
                                 size=13, media_type='image', owner_uid='user_a')
        asset_sync.register_local(conn, path=forged, file_path='/media/private.png',
                                 digest=hashlib.sha256(forged.read_bytes()).hexdigest(), size=11, media_type='image', owner_uid='user_b')
    gid = repo.create_local_generation({'prompt': 'claim', 'references': [{'file_path': '/media/private.png',
        'asset_content_id': 'sha256:' + actual_sha}]}, 'me', creator_uid='user_b')
    with db.get_connection() as conn:
        conn.execute('UPDATE reference SET asset_content_id=? WHERE id IN (SELECT reference_id FROM gen_reference WHERE generation_id=?)',
                     ('sha256:' + actual_sha, gid))
    assert sync.owns_local_content(source, 'user_a')
    assert not sync.owns_local_content(source, 'user_b')
    assert sync.owns_local_content(forged, 'user_b')


def test_private_media_ownership_is_rechecked_on_copied_bytes(content, tmp_path, monkeypatch):
    source = tmp_path / 'mutable.png'
    source.write_bytes(b'owned bytes')
    with db.get_connection() as conn:
        asset_sync.register_local(conn, path=source, file_path='/media/mutable.png',
            digest=hashlib.sha256(source.read_bytes()).hexdigest(), size=11, media_type='image', owner_uid='user_b')
    assert sync.owns_local_content(source, 'user_b')
    source.write_bytes(b'changed private bytes')
    monkeypatch.setattr(sync_api.active_account, 'active_uid', lambda: 'user_b')
    monkeypatch.setattr(sync_api.config, 'ASSETS_ROOT', tmp_path / 'local-assets')
    request = SimpleNamespace(state=SimpleNamespace(account=None))
    with pytest.raises(HTTPException) as denied:
        sync_api._snapshot_registration(sync_api.RegisterIn(file_path='/media/mutable.png'), request, source)
    assert denied.value.status_code == 403
    assert not list((tmp_path / 'local-assets' / 'imports').glob('*.part'))


def test_asset_only_backup_is_meaningful(content):
    with db.get_connection() as conn:
        asset_sync.register_verified_blob(conn, 'a' * 64, 1, 'image')
    assert metadata_summary(content)['assets'] == 1
    assert metadata_summary(content)['meaningful_records'] >= 1


def test_asset_schema_and_ledger_roll_back_together_on_failure(content, tmp_path):
    path = tmp_path / 'failed-upgrade.db'
    record = schema_compat.record_baseline_in_transaction

    def fail_asset_record(conn, component, **kwargs):
        if component == 'content_asset_sync':
            raise RuntimeError('simulated metadata failure')
        return record(conn, component, **kwargs)

    with patch.object(schema_compat, 'record_baseline_in_transaction', fail_asset_record):
        with pytest.raises(RuntimeError, match='simulated metadata failure'):
            db.init_db(path)
    with sqlite3.connect(path) as conn:
        assert conn.execute("SELECT name FROM sqlite_master WHERE name='asset_blob'").fetchone() is None
        assert conn.execute("SELECT migration_id FROM schema_migrations WHERE migration_id='content_asset_sync.v1'").fetchone() is None
    db.init_db(path)
    assert 'content_asset_sync' in schema_compat.inspect_database(path, 'content').components


@pytest.mark.parametrize('profile', ['transfer', 'snapshot'])
def test_ephemeral_upload_capabilities_are_not_exported(content, profile):
    with db.get_connection() as conn:
        conn.execute("INSERT INTO asset_upload_token(token,asset_content_id,owner_uid,project_id,storage_id,root_revision,relative_path,original_name,bytes,media_type,expires_at) "
                     "VALUES('fake-capability',?,'user_a','p','storage','root','imp_cap/User/file.png','file.png',1,'image',9999999999)", ('sha256:' + 'a' * 64,))
    if profile == 'transfer':
        strip_transfer_secrets(content)
    else:
        scrub_test_snapshot_db(content, create_test_admin=False)
    with db.get_connection() as conn:
        assert conn.execute('SELECT count(*) FROM asset_upload_token').fetchone()[0] == 0


@pytest.mark.parametrize('managed,updated_at', [
    (False, '2026-10-21T00:00:02Z'),
    (True, '2026-10-21T00:00:01Z'),
    (True, '2026-10-21T00:00:02Z'),
])
def test_stale_registry_scan_cannot_override_verified_upload(content, managed, updated_at):
    with db.get_connection() as conn:
        conn.execute("INSERT INTO project(id,name) VALUES('p','P')")
        file = asset_registry.RegistryFile('imp_cap/User/a.png', 1, 1, 'a' * 64, 'ok')
        asset_registry.apply_plan(conn, 'p', {'inserts': [('reg', file)], 'updates': [], 'events': []}, now=updated_at)
        cid = asset_sync.register_verified_blob(conn, 'a' * 64, 1, 'image')
        if managed:
            conn.execute("INSERT INTO asset_location(location_id,asset_content_id,owner_uid,project_id,storage_id,kind,path,registry_asset_id) "
                         "VALUES(?,?, 'user_a','p','storage','server','imp_cap/User/a.png','reg')", ('b' * 32, cid))
        stale = {'inserts': [('duplicate', file)], 'updates': [('reg', {'state': 'missing'})],
                 'events': [('reg', 'missing', file.path, None, file.sha256, 1),
                            ('duplicate', 'new', file.path, None, file.sha256, 1)]}
        assert asset_registry.apply_plan(conn, 'p', stale, scan_started_at='2026-10-21T00:00:01Z') == {}
        rows = conn.execute('SELECT registry_asset_id,state FROM asset_registry').fetchall()
        assert [tuple(r) for r in rows] == [('reg', 'present')]
        assert conn.execute('SELECT count(*) FROM asset_registry_event').fetchone()[0] == 0


@pytest.mark.parametrize('location', [None, ('server', 'missing'), ('local', 'ready')])
def test_same_second_scan_detects_move_without_server_ready_location(content, location):
    started_at = '2026-10-21T00:00:01Z'
    with db.get_connection() as conn:
        conn.execute("INSERT INTO project(id,name) VALUES('p','P')")
        original = asset_registry.RegistryFile('assets/CH/a.png', 1, 1, 'a' * 64, 'ok')
        asset_registry.apply_plan(conn, 'p', {'inserts': [('reg', original)], 'updates': [], 'events': []}, now=started_at)
        if location:
            cid = asset_sync.register_verified_blob(conn, original.sha256, original.bytes, 'image')
            conn.execute("INSERT INTO asset_location(location_id,asset_content_id,owner_uid,project_id,storage_id,kind,state,path,registry_asset_id) "
                         "VALUES(?,?,'user_a','p','storage',?,?,?,'reg')", ('b' * 32, cid, *location, original.path))
        moved = asset_registry.RegistryFile('assets/CH/a_final.png', 1, 1, original.sha256, 'ok')
        plan = asset_registry.plan_changes(asset_registry.registry_rows(conn, 'p'), asset_registry.RegistryScan(True, [moved]))
        assert asset_registry.apply_plan(conn, 'p', plan, now=started_at, scan_started_at=started_at) == {'moved': 1}
        assert [tuple(r) for r in conn.execute('SELECT registry_asset_id,path FROM asset_registry')] == [('reg', moved.path)]
        assert [tuple(r) for r in conn.execute('SELECT kind,path,old_path FROM asset_registry_event')] == [
            ('moved', moved.path, original.path)]


def _agent():
    spec = importlib.util.spec_from_file_location('asset_provenance_agent', Path(__file__).resolve().parents[2] / 'agent_push.py')
    agent = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(agent)
    return agent


def test_agent_preserves_streamed_actual_bytes_with_pinned_account(tmp_path):
    agent = _agent()
    source = tmp_path / 'capture.png'
    source.write_bytes(b'actual bytes')
    sha = hashlib.sha256(source.read_bytes()).hexdigest()
    captured = {}

    def opened(request, **kwargs):
        captured['headers'] = dict(request.header_items())
        captured['body'] = b''.join(request.data)
        return io.BytesIO(json.dumps({'asset_content_id': 'sha256:' + sha}).encode())

    with patch.object(agent.urllib.request, 'urlopen', opened):
        assert agent._preserve_reference('http://hub', 'fake-token', 'asset:captures|one.png',
                                         str(source), {'sha256': sha, 'bytes': 12},
                                         {'project_id': 'p'}, 'a@example.invalid')
    assert captured['headers']['X-mvhub-expect-account'] == 'a@example.invalid'
    assert b'actual bytes' in captured['body'] and b'asset:captures|one.png' in captured['body']
    assert int(captured['headers']['Content-length']) == len(captured['body'])


def test_agent_stops_before_paid_submit_if_input_preservation_fails(tmp_path):
    agent = _agent()
    source = tmp_path / 'capture.png'
    source.write_bytes(b'actual bytes')
    ref = 'asset:captures|one.png'
    request = {'id': 'r', 'model': 'nano-banana', 'prompt': 'test', 'params': {},
               'asset_content_protocol': 1, 'references': [{'file_path': ref, 'type': 'image', 'role': '@Image1'}]}
    with patch.object(agent, '_allowed_params', return_value=set()), \
            patch.object(agent, '_preserve_reference', return_value=False), \
            patch.object(agent, '_fail') as failed, \
            patch.object(agent, '_run_cli_json') as paid:
        assert agent._submit_one('http://hub', 'fake-token', 'higgsfield', 'a@example.invalid', request,
                                 {ref: str(source)}, {}, agent.Lock(), agent.Lock(), 'agent') is None
    failed.assert_called_once()
    paid.assert_not_called()


def test_agent_resolves_only_valid_canonical_location_tokens():
    agent = _agent()
    with patch.object(agent, '_download_ref', return_value='temporary.png') as download:
        assert agent._resolve_ref('http://hub', 'fake-token', 'asset-sync:' + 'a' * 32) == ('temporary.png', 'temporary.png')
        assert download.call_args.args[2] == 'http://hub/api/asset-sync/files/' + 'a' * 32
        assert agent._resolve_ref('http://hub', 'fake-token', 'asset-sync:../bad') == (None, None)
        assert download.call_count == 1


@pytest.mark.parametrize('content_type,extension', [('video/x-matroska', '.mkv'), ('audio/flac', '.flac'), ('image/bmp', '.bmp'), ('audio/aac', '.aac'), ('video/x-msvideo', '.avi')])
def test_extensionless_canonical_download_preserves_supported_media(content_type, extension):
    agent = _agent()
    response = io.BytesIO(b'media bytes')
    response.headers = {'Content-Type': content_type}
    with patch.object(agent.urllib.request, 'urlopen', return_value=response):
        downloaded = agent._download_ref('http://hub', 'fake-token', 'http://hub/api/asset-sync/files/' + 'a' * 32, '')
    assert downloaded and downloaded.endswith(extension)
    Path(downloaded).unlink()

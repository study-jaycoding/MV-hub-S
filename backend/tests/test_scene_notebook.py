"""Notebook transaction contracts, using only a temporary content database."""
import json
import pytest
from app import active_account, config, db
from app.repo import scene_notebook as store, scenes_backup as legacy
from app.services.scene_writer import WriterConflict


@pytest.fixture
def notebook_db(tmp_path, monkeypatch):
    monkeypatch.setenv('CONTENT_HUB_DB', str(tmp_path / 'notebook.db'))
    monkeypatch.setattr(config, 'AUTH_ENABLED', False)
    monkeypatch.setenv('CONTENT_HUB_SCENE_WRITER_TEST', '1')
    pin = active_account.set_override('')
    db.flush_pool()
    db.init_db()
    yield tmp_path
    db.flush_pool()
    active_account.reset_override(pin)


def scene(sid='s', name='X', **extra):
    return {'id': sid, 'data': json.dumps({'id': sid, 'name': name, 'cards': [], **extra})}


def seed(owner='u', items=None, attempt='a', lease='lease'):
    items = [scene()] if items is None else items
    return store.start(owner, lease, {'attempt_id': attempt, 'expected_count': len(items),
                                     'upserts': items, 'order': [i['id'] for i in items], 'commit': True})


def base(sid='s', owner='u'):
    return next(i['base'] for i in store.notebook(owner)['items'] if i['id'] == sid)


def push(request_id, **kwargs):
    return store.sync('u', '', {'request_id': request_id, **kwargs})


def test_delete_intent_retry_revive_and_late_delete(notebook_db):
    seed()
    original = base()
    intent = {'id': 's', 'intent_id': 'd1', 'base': original}
    result = push('d', deletes=[intent])
    assert result == push('d', deletes=[intent])
    assert legacy.list_scene_backups('u') == []
    assert push('d2', deletes=[{**intent, 'intent_id': 'd2'}])['deletes'][0]['status'] == 'deleted'
    # No GET between delete and undo: the response itself supplies the tombstone revision.
    revive = {**scene(), 'revive': True, 'intent_id': 'r1', 'base': result['deletes'][0]['base']}
    assert push('r', upserts=[revive])['results'][0]['status'] == 'saved'
    assert push('late', deletes=[intent])['deletes'][0]['status'] == 'kept'
    assert len(legacy.list_scene_backups('u')) == 1


def test_receipt_reuse_cannot_change_body(notebook_db):
    seed()
    payload = {'upserts': [{**scene(name='Y'), 'base': base()}]}
    first = push('retry', **payload)
    assert push('retry', **payload) == first
    with pytest.raises(WriterConflict, match='request_id_reused'):
        push('retry', upserts=[scene(name='Z')])


def test_conflict_copies_once_and_keeps_original(notebook_db):
    seed()
    old = base()
    push('edit', upserts=[{**scene(name='Y'), 'base': old}])
    copied = push('conflict', upserts=[{**scene(name='Z'), 'base': old}])['results'][0]
    assert copied['status'] == 'copied'
    assert push('conflict2', upserts=[{**scene(name='Z'), 'base': old}])['results'][0]['target_id'] == copied['target_id']
    rows = store.notebook('u')['items']
    assert len(rows) == 2
    assert json.loads(next(r['data'] for r in rows if r['id'] == 's'))['name'] == 'Y'


def test_atomic_rollback_includes_scene_and_delete(notebook_db):
    seed()
    with pytest.raises(ValueError, match='duplicate order'):
        push('bad', upserts=[{**scene(name='Y'), 'base': base()}], order={'ids': ['s','s']})
    assert json.loads(store.notebook('u')['items'][0]['data'])['name'] == 'X'
    with db.get_connection() as conn:
        assert conn.execute('SELECT COUNT(*) FROM scene_request_receipt').fetchone()[0] == 0


def test_start_staging_crash_empty_browser_and_commit_retry(notebook_db):
    legacy.sync_scene_backups('u', '', [scene('old')], [])
    store.start('u', 'gone', {'attempt_id': 'partial', 'expected_count': 2, 'upserts': [scene()], 'order': ['s','s2']})
    assert [r['id'] for r in legacy.list_scene_backups('u')] == ['old']
    result = seed(items=[], attempt='empty', lease='next')
    assert [r['id'] for r in store.notebook('u')['items']] == ['old']
    # A new valid lease may retrieve the committed attempt's receipt, not start again.
    assert seed(items=[], attempt='empty', lease='third') == result
    with pytest.raises(WriterConflict, match='already_started'):
        seed(attempt='again')


def test_start_archives_same_id_and_all_old_rows(notebook_db):
    legacy.sync_scene_backups('u', '', [scene(name='old'), scene('hidden')], [])
    seed()
    with db.get_connection() as conn:
        archived = conn.execute("SELECT scene_id,data FROM scene_archive WHERE reason='before_start'").fetchall()
    assert {r['scene_id'] for r in archived} == {'s','hidden'}
    assert len(store.notebook('u')['items']) == 1


def test_start_oversize_never_publishes_partial(notebook_db):
    legacy.sync_scene_backups('u', '', [scene('old')], [])
    with pytest.raises(store.StartTooBig):
        seed(items=[scene(), scene('huge', padding='x' * store.MAX_SCENE_BYTES)])
    assert not store.is_started('u')
    assert [r['id'] for r in legacy.list_scene_backups('u')] == ['old']


def test_post_start_too_big_is_per_scene_result(notebook_db):
    seed()
    result = push('big', upserts=[{**scene(padding='x' * store.MAX_SCENE_BYTES), 'base': base()}])
    assert result['results'][0]['status'] == 'too_big'
    assert json.loads(store.notebook('u')['items'][0]['data'])['name'] == 'X'


def test_order_conflict_keeps_server_order_and_appends_new(notebook_db):
    seed(items=[scene('a'), scene('b')])
    order = store.notebook('u')['order']
    push('order1', order={**order, 'ids': ['b','a']})
    result = push('order2', upserts=[scene('c')], order={**order, 'ids': ['a','c','b']})
    assert result['order']['ids'] == ['b','a','c']


def test_restore_old_rows_establishes_book_and_invalidates_receipts(notebook_db):
    legacy.sync_scene_backups('u', '', [scene()], [])
    old = store.notebook('u')['history_id']
    with store.transaction() as conn:
        store.restore_history(conn)
    assert store.is_started('u')
    assert store.notebook('u')['history_id'] != old
    with pytest.raises(WriterConflict, match='already_started'):
        seed()


def test_history_reuse_hash_mismatch_never_overwrites(notebook_db):
    seed()
    old = base()
    with db.get_connection() as conn:
        data = scene(name='restored')['data']
        conn.execute('UPDATE scene_backup SET data=?,data_hash=?,rev_hash=? WHERE scene_id=?',
                     (data, legacy._hash(data), legacy._hash(data), 's'))
    assert push('stale', upserts=[{**scene(name='local'), 'base': old}])['results'][0]['status'] == 'copied'


def test_remap_live_collision_and_deleted_live_policy(notebook_db):
    seed(owner='old', items=[scene(), scene('dead')])
    seed(owner='new', items=[scene(name='other'), scene('dead', name='live')])
    with store.transaction() as conn:
        conn.execute("UPDATE scene_backup SET deleted_at='now',rev=rev+1 WHERE owner_uid='old' AND scene_id='dead'")
        before = store.history(conn)
        store.remap(conn, 'old', 'new')
        assert store.history(conn) != before
    rows = store.notebook('new')['items']
    assert len(rows) == 3
    assert json.loads(next(r['data'] for r in rows if r['id'] == 'dead'))['name'] == 'live'
    assert not store.is_started('old')


def test_cleanup_removes_book_first_and_archive_last(notebook_db):
    seed()
    with store.transaction() as conn:
        store.cleanup(conn, 'u')
        assert conn.execute('SELECT COUNT(*) FROM scene_archive').fetchone()[0] == 0
        assert conn.execute('SELECT COUNT(*) FROM scene_backup').fetchone()[0] == 0


def test_restore_init_is_gated_but_started_book_is_always_fenced(notebook_db, monkeypatch):
    legacy.sync_scene_backups('u', '', [scene()], [])
    monkeypatch.delenv('CONTENT_HUB_SCENE_WRITER_TEST')
    db.init_db(scene_restore=True)
    assert not store.is_started('u')
    monkeypatch.setenv('CONTENT_HUB_SCENE_WRITER_TEST', '1')
    db.init_db(scene_restore=True)
    assert store.is_started('u')
    before = store.notebook('u')['history_id']
    monkeypatch.delenv('CONTENT_HUB_SCENE_WRITER_TEST')
    db.init_db(scene_restore=True)
    assert store.notebook('u')['history_id'] != before


def test_repeated_empty_remap_keeps_history(notebook_db):
    seed(owner='new')
    before = store.notebook('new')['history_id']
    with store.transaction() as conn:
        assert store.remap(conn, 'missing', 'new') == 0
    assert store.notebook('new')['history_id'] == before


def test_backup_summary_separates_retained_bodies(notebook_db):
    from app.services.worker_backup import metadata_summary
    seed()
    legacy.sync_scene_backups('u', '', [scene(name='Y')], [])
    push('delete', deletes=[{'id': 's', 'intent_id': 'd', 'base': base()}])
    summary = metadata_summary(db.get_db_path(), include_retained=True)
    assert summary['canvases'] == 1  # normalized X copy is live
    assert summary['canvas_retained'] == 2  # original tombstone and archived X


def test_receipts_bounded_per_owner_and_lost_response_retry_retained(notebook_db, monkeypatch):
    monkeypatch.setattr(store, 'MAX_REQUEST_RECEIPTS', 2)
    seed()
    seed(owner='other')
    store.sync('other', '', {'request_id': 'keep'})
    push('old')
    payload = {'upserts': [{**scene(name='Y'), 'base': base()}]}
    response = push('lost-response', **payload)
    store.sync('u', 'project', {'request_id': 'new'})
    assert push('lost-response', **payload) == response
    with db.get_connection() as conn:
        rows = {(r['owner_uid'], r['request_id']) for r in conn.execute('SELECT * FROM scene_request_receipt')}
        assert rows == {('u', 'lost-response'), ('u', 'new'), ('other', 'keep')}


def test_already_deleted_response_can_revive_without_lookup(notebook_db):
    seed()
    intent = {'id': 's', 'intent_id': 'd', 'base': base()}
    push('delete', deletes=[intent])
    repeated = push('again', deletes=[intent])['deletes'][0]
    assert repeated['base']['rev'] == 2
    revived = push('undo', upserts=[{**scene(), 'revive': True, 'intent_id': 'undo', 'base': repeated['base']}])
    assert revived['results'][0]['status'] == 'saved'
    assert revived['results'][0]['target_id'] == 's'


def test_start_chunk_snapshot_and_attempt_fences(notebook_db):
    body = {'attempt_id': 'a', 'expected_count': 2, 'order': ['s', 't'], 'upserts': [scene()]}
    store.start('u', 'lease', body)
    with pytest.raises(WriterConflict, match='start_snapshot_changed'):
        store.start('u', 'lease', {**body, 'upserts': [scene(name='changed')]})
    for changed in ({'expected_count': 3}, {'order': ['t', 's']}, {'project_id': 'new'}):
        with pytest.raises(WriterConflict, match='start_attempt_changed'):
            store.start('u', 'lease', {**body, **changed, 'upserts': [scene('t')]})
    with pytest.raises(WriterConflict, match='start_attempt_changed'):
        store.start('u', 'new-lease', body)
    result = store.start('u', 'lease', {**body, 'upserts': [scene('t')], 'commit': True})
    assert result['status'] == 'committed'
    assert len(store.notebook('u')['items']) == 2


def test_identity_remap_entry_point_preserves_notebook_and_replaces_history(notebook_db):
    from app.repo.identity import remap_creator_uid
    seed(owner='old', items=[scene(), scene('dead')])
    seed(owner='new', items=[scene(name='new'), scene('dead', name='live')])
    with store.transaction() as conn:
        conn.execute("UPDATE scene_backup SET deleted_at='deleted',rev=rev+1 WHERE owner_uid='old' AND scene_id='dead'")
        previous = store.history(conn)
        remap_creator_uid(conn, 'old', 'new')
        assert store.history(conn) != previous
    state = store.notebook('new')
    assert len(state['items']) == 3
    assert set(state['order']['ids']) == {r['id'] for r in state['items']}
    assert not store.is_started('old')


def test_new_write_after_restore_must_reconcile_old_history(notebook_db):
    seed()
    before = base()
    with store.transaction() as conn:
        store.restore_history(conn)
    response = push('stale-after-restore', upserts=[{**scene(name='unsent'), 'base':before}])
    assert response['results'][0]['status'] == 'copied'
    assert json.loads(next(i['data'] for i in store.notebook('u')['items'] if i['id']=='s'))['name'] == 'X'


def test_existing_edited_fork_is_not_overwritten_by_remap(notebook_db):
    seed(owner='old', items=[scene(name='incoming')])
    seed(owner='new', items=[scene(name='canonical')])
    with store.transaction() as conn:
        copied = store.copy_scene(conn, 'new', '', 's', scene(name='incoming')['data'])
        target = copied['scene_id']
        changed = scene(target, name='edited-copy')
        store.write_row(conn, 'new', '', target, changed['data'], 'edited-copy')
        store.remap(conn, 'old', 'new')
    names = {json.loads(r['data'])['name'] for r in store.notebook('new')['items']}
    assert names == {'canonical','edited-copy','[옛 창] incoming'}


def test_server_created_copy_is_in_tab_order(notebook_db):
    seed()
    legacy.sync_scene_backups('u', '', [scene(name='Y')], [])
    state = store.notebook('u')
    assert len(state['order']['ids']) == 2
    assert set(state['order']['ids']) == {r['id'] for r in state['items']}


def test_remap_legacy_source_without_order_adds_copy_tab(notebook_db):
    legacy.sync_scene_backups('old', '', [scene(name='incoming')], [])
    seed(owner='new')
    with store.transaction() as conn:
        store.remap(conn, 'old', 'new')
    state = store.notebook('new')
    assert len(state['items']) == 2
    assert set(state['order']['ids']) == {r['id'] for r in state['items']}


def test_card_links_alone_still_merit_backup_without_counting_as_canvases(notebook_db):
    from app.services.worker_backup import metadata_summary
    with db.get_connection() as conn:
        conn.execute("INSERT INTO scene_card_generation(owner_uid,scene_id,card_id,generation_id) VALUES('u','s','c','g')")
    result = metadata_summary(db.get_db_path())
    assert result['canvases'] == 0
    assert result['meaningful_records'] > 0
    assert 'canvas_retained' not in result

"""옛 결과·서버에서 옮겨진 공유물의 전송 줄을 일꾼이 잇는다."""
import hashlib
from unittest.mock import patch

import pytest

from app import active_account, config, db, repo
from app.repo import asset_sync, projects
from app.services import asset_backfill, shared_connection
from app.shared_server_config import K_URL

SERVER = 'http://server'


@pytest.fixture
def world(tmp_path, monkeypatch):
    db.flush_pool()
    path = tmp_path / 'content.db'
    monkeypatch.setenv('CONTENT_HUB_DB', str(path))
    db.init_db(path)
    repo.ensure_default_worker()
    repo.set_setting(K_URL, SERVER)
    monkeypatch.setattr(active_account, 'account_key', lambda: 'acct')
    monkeypatch.setattr(active_account, 'active_uid', lambda: 'user_a')
    monkeypatch.setattr(shared_connection, 'token', lambda: 'tok')
    monkeypatch.setattr(config, 'MEDIA_DIR', tmp_path / 'media')
    monkeypatch.setattr(config, 'ASSETS_ROOT', tmp_path / 'assets')
    (tmp_path / 'media' / 'comfy').mkdir(parents=True)
    asset_backfill.reset()
    yield tmp_path
    asset_backfill.reset()
    db.flush_pool()


def _result(world, name, *, project=None, creator='user_a', write=True, content_id=None, bytes_=b'png-bytes'):
    gid = 'g-' + name
    repo.create_local_generation({'model': 'comfy', 'prompt': 'p'}, 'me', generation_id=gid)
    if write:
        (world / 'media' / 'comfy' / f'{name}.png').write_bytes(b'\x89PNG\r\n\x1a\n' + name.encode() + bytes_)
    with db.get_connection() as conn:
        conn.execute("UPDATE generation SET status='done', creator_uid=?, project_id=? WHERE id=?", (creator, project, gid))
        if content_id:
            asset_sync.register_verified_blob(conn, content_id[7:], 4, 'image')
        conn.execute('INSERT INTO asset(id,generation_id,type,file_path,asset_content_id) VALUES(?,?,?,?,?)',
                     ('a-' + name, gid, 'image', f'/media/comfy/{name}.png', content_id))
    return gid


def _project(name='Q'):
    return projects.create_project(name, created_by='user_a')['id']


def _content(gid):
    with db.get_connection() as conn:
        return conn.execute('SELECT asset_content_id FROM asset WHERE generation_id=?', (gid,)).fetchone()[0]


def _lines(project):
    with db.get_connection() as conn:
        return [dict(row) for row in conn.execute('SELECT * FROM asset_sync_outbox WHERE project_id=?', (project,))]


def _tick(at=0.0):
    with patch.object(asset_backfill, '_post', return_value={'items': {}}):
        asset_backfill.tick(at)


def test_an_old_result_without_an_id_gets_one_and_a_line(world):
    project = _project()
    gid = _result(world, 'old', project=project)
    _tick()
    content = _content(gid)
    assert content and content.startswith('sha256:')
    lines = _lines(project)
    assert len(lines) == 1 and lines[0]['state'] == 'queued' and lines[0]['server_origin'] == SERVER and lines[0]['account_key'] == 'acct'


def test_the_snapshot_keeps_the_bytes_when_the_original_goes_away(world):
    project = _project()
    gid = _result(world, 'snap', project=project)
    _tick()
    (world / 'media' / 'comfy' / 'snap.png').unlink()
    with db.get_connection() as conn:
        row = conn.execute("SELECT path FROM asset_location WHERE kind='local' AND asset_content_id=?", (_content(gid),)).fetchone()
    assert 'imports' in row['path']
    from pathlib import Path
    assert Path(row['path']).is_file()


def test_an_id_without_a_local_copy_is_registered_when_the_bytes_match(world):
    project = _project()
    source = b'\x89PNG\r\n\x1a\nmatchsame'
    content = 'sha256:' + hashlib.sha256(source).hexdigest()
    gid = _result(world, 'match', project=project, content_id=content, write=False)
    (world / 'media' / 'comfy' / 'match.png').write_bytes(source)
    with db.get_connection() as conn:
        conn.execute('UPDATE asset_blob SET bytes=? WHERE asset_content_id=?', (len(source), content))
    _tick()
    assert _content(gid) == content
    assert [line['asset_content_id'] for line in _lines(project)] == [content]


def test_a_recorded_id_that_disagrees_with_the_file_changes_nothing(world):
    project = _project()
    content = 'sha256:' + 'e' * 64
    gid = _result(world, 'differs', project=project, content_id=content)
    _tick()
    assert _content(gid) == content
    assert _lines(project) == []


def test_a_missing_file_does_not_stop_the_rows_after_it(world):
    project = _project()
    _result(world, 'absent', project=project, write=False)
    after = _result(world, 'after', project=project)
    _tick()
    assert _content(after)
    assert len(_lines(project)) == 1


def test_an_unreadable_file_is_skipped_too(world):
    project = _project()
    _result(world, 'broken', project=project)
    after = _result(world, 'behind', project=project)
    real = asset_backfill._snapshot
    def snapshot(path):
        if path.name == 'broken.png':
            raise OSError('locked')
        return real(path)
    with patch.object(asset_backfill, '_snapshot', side_effect=snapshot):
        _tick()
    assert _content(after)


def test_oversized_files_are_left_alone(world):
    project = _project()
    gid = _result(world, 'huge', project=project)
    with patch('app.services.asset_io.UPLOAD_MAX_BYTES', 4):
        _tick()
    assert _content(gid) is None


@pytest.mark.parametrize('case', ['deleted', 'someone_else', 'archived', 'no_project'])
def test_rows_that_are_not_ours_to_touch(world, case):
    project = _project()
    gid = _result(world, case, project=None if case == 'no_project' else project, creator='user_b' if case == 'someone_else' else 'user_a')
    with db.get_connection() as conn:
        if case == 'deleted':
            conn.execute("UPDATE generation SET deleted_at='2026-11-02' WHERE id=?", (gid,))
        if case == 'archived':
            conn.execute('UPDATE project SET archived=1 WHERE id=?', (project,))
    _tick()
    assert _content(gid) is None and _lines(project) == []


def test_inputs_follow_the_same_rule(world):
    project = _project()
    gid = _result(world, 'with-input', project=project)
    digest = hashlib.sha256(b'input').hexdigest()
    with db.get_connection() as conn:
        cid = asset_sync.register_local(conn, path='C:/x.png', file_path='/api/comfy/inputs/s/x.png', digest=digest, size=4, media_type='image',
                                        owner_uid='user_a', project_id=None, server_origin=SERVER, account_key='acct')['asset_content_id']
        conn.execute("INSERT INTO reference(id,type,file_path,asset_content_id) VALUES('r1','image','/api/comfy/inputs/s/x.png',?)", (cid,))
        conn.execute("INSERT INTO gen_reference(generation_id,reference_id) VALUES(?, 'r1')", (gid,))
    _tick()
    assert {line['asset_content_id'] for line in _lines(project)} == {cid, _content(gid)}


def test_a_deleted_content_stays_deleted(world):
    project = _project()
    content = 'sha256:' + hashlib.sha256(b'gone').hexdigest()
    with db.get_connection() as conn:
        asset_sync.register_local(conn, path='C:/g.png', file_path='/media/comfy/del.png', digest=content[7:], size=4, media_type='image',
                                  owner_uid='user_a', project_id='elsewhere', server_origin=SERVER, account_key='acct')
        conn.execute("UPDATE asset_sync_outbox SET state='deleted'")
    _result(world, 'del', project=project, content_id=content, write=False)
    _tick()
    assert _lines(project) == []


def test_a_context_change_during_the_copy_stops_applying(world):
    project = _project()
    _result(world, 'first', project=project)
    second = _result(world, 'second', project=project)
    real = asset_backfill._bring_up
    def switch(row, *args):
        real(row, *args)
        repo.set_setting(K_URL, 'http://other')
    with patch.object(asset_backfill, '_bring_up', side_effect=switch):
        _tick()
    assert _lines(project) == []
    assert _content(second) is None


def test_one_pass_per_context(world):
    project = _project()
    _tick()  # 빈 패스 — 끝난 것으로 안다
    gid = _result(world, 'later', project=project)
    _tick()
    assert _content(gid) is None
    repo.set_setting(K_URL, 'http://other')
    _tick()
    assert _content(gid)


def test_more_than_a_batch_finishes_over_ticks(world):
    project = _project()
    with patch.object(asset_backfill, 'SCAN_BATCH', 2):
        for index in range(5):
            _result(world, f'many{index}', project=project)
        for _ in range(4):
            _tick()
    assert len(_lines(project)) == 5


# ── 서버에서 옮겨진 공유물 ──
def _shared(gid):
    with db.get_connection() as conn:
        conn.execute("INSERT INTO share(id,generation_id,shared_by,visibility) VALUES(?,?,'me','team')", ('s-' + gid, gid))


def _registered(world, name):
    gid = _result(world, name)
    with db.get_connection() as conn:
        digest = hashlib.sha256(name.encode()).hexdigest()
        cid = asset_sync.register_local(conn, path='C:/p.png', file_path=f'/media/comfy/{name}.png', digest=digest, size=4, media_type='image',
                                        owner_uid='user_a', project_id=None, server_origin=SERVER, account_key='acct')['asset_content_id']
        conn.execute('UPDATE asset SET asset_content_id=? WHERE generation_id=?', (cid, gid))
    _shared(gid)
    return gid, cid


def test_a_move_made_on_the_server_gets_a_line_and_the_local_row_stays(world):
    project = _project()
    gid, cid = _registered(world, 'moved')
    with patch.object(asset_backfill, '_post', return_value={'items': {gid: {'project_id': project, 'assets': []}}}) as call:
        asset_backfill.tick(100.0)
    assert call.call_args.args == (SERVER, 'tok', '/api/generations/batch', {'gen_ids': [gid]})
    assert [line['asset_content_id'] for line in _lines(project)] == [cid]
    assert repo.get_generation(gid)['project_id'] is None


@pytest.mark.parametrize('reply', [{'items': {}, 'missing': ['x']}, {'items': {'x': {'project_id': None}}}, {'items': 'no'}, 'not json', OSError('down')])
def test_nothing_learned_changes_nothing(world, reply):
    project = _project()
    gid, _ = _registered(world, 'quiet')
    with patch.object(asset_backfill, '_post', side_effect=[reply]):
        asset_backfill.tick(100.0)
    assert _lines(project) == []
    assert repo.get_generation(gid)['project_id'] is None


def test_a_failed_batch_does_not_hold_its_place(world):
    with patch.object(asset_backfill, 'SCAN_BATCH', 1):
        first, _ = _registered(world, 'turn1')
        second, _ = _registered(world, 'turn2')
        asked = []
        def fail(_origin, _token, _path, body):
            asked.append(body['gen_ids'][0])
            raise OSError('too big or down')
        with patch.object(asset_backfill, '_post', side_effect=fail):
            asset_backfill.tick(100.0)
            asset_backfill.tick(200.0)
            asset_backfill.tick(300.0)  # 끝까지 갔다 — 빈 차례로 처음으로 돌아간다
            asset_backfill.tick(400.0)
    assert asked == [first, second, first]


def test_the_scan_waits_a_minute_between_batches(world):
    _registered(world, 'minute')
    with patch.object(asset_backfill, '_post', return_value={'items': {}}) as call:
        asset_backfill.tick(100.0)
        asset_backfill.tick(130.0)
    assert call.call_count == 1


def test_a_blank_server_id_is_linked_only_once_the_file_is_there(world):
    project = _project()
    gid, cid = _registered(world, 'blank')
    item = {'project_id': project, 'assets': [{'file_path': '/media/comfy/blank.png', 'asset_content_id': None}], 'references': []}
    calls = []
    def server(_origin, _token, path, _body):
        calls.append(path)
        return {'items': {gid: item}}
    with patch.object(asset_backfill, '_post', side_effect=server):
        asset_backfill.tick(100.0)
        assert '/api/asset-sync/link-output' not in calls
        with db.get_connection() as conn:
            conn.execute("UPDATE asset_sync_outbox SET state='ready' WHERE project_id=?", (project,))
        asset_backfill._scan.remote_after = 0
        asset_backfill.tick(200.0)
    assert calls[-1] == '/api/asset-sync/link-output'


def test_the_backfill_runs_apart_from_the_transfers(world):
    """보충이 느리거나 던져도 전송은 따로 돈다 — 전송 일꾼은 보충을 부르지 않고, 보충은 던져도 다음 차례가 온다."""
    import asyncio
    from app.services import asset_sync as sync
    async def stop_after(_seconds):
        raise asyncio.CancelledError
    with patch.object(asset_backfill, 'tick', side_effect=RuntimeError('broken')) as tick, \
            patch.object(sync, 'process_one', return_value=False), patch.object(sync, 'verify_one', return_value=False), \
            patch('app.services.asset_destination.process_one', return_value=False), \
            patch('asyncio.sleep', stop_after):
        with pytest.raises(asyncio.CancelledError):
            asyncio.run(sync.run_worker())
        tick.assert_not_called()
        with pytest.raises(asyncio.CancelledError):
            asyncio.run(sync.run_backfill())
        tick.assert_called_once()


def test_a_later_output_of_the_same_generation_is_not_lost_at_a_batch_edge(world):
    project = _project()
    with patch.object(asset_backfill, 'SCAN_BATCH', 1):
        gid = _result(world, 'edge', project=project)
        (world / 'media' / 'comfy' / 'edge2.png').write_bytes(b'\x89PNG\r\n\x1a\nedge2')
        with db.get_connection() as conn:
            conn.execute("INSERT INTO asset(id,generation_id,type,file_path) VALUES('a-edge2',?,'image','/media/comfy/edge2.png')", (gid,))
        for _ in range(3):
            _tick()
    assert len(_lines(project)) == 2


def test_a_server_switch_during_a_remote_copy_does_not_carry_the_old_project(world):
    project = _project()
    gid = _result(world, 'switch')
    _shared(gid)
    real = asset_backfill._bring_up
    def switch(row, *args):
        real(row, *args)
        repo.set_setting(K_URL, 'http://other')
    with patch.object(asset_backfill, '_post', return_value={'items': {gid: {'project_id': project}}}), \
            patch.object(asset_backfill, '_bring_up', side_effect=switch):
        asset_backfill.tick(100.0)
    assert _lines(project) == []


def test_a_server_switch_during_the_snapshot_registers_nothing(world):
    project = _project()
    gid = _result(world, 'mid-copy', project=project)
    real = asset_backfill._snapshot
    def switch(path):
        taken = real(path)
        repo.set_setting(K_URL, 'http://other')
        return taken
    with patch.object(asset_backfill, '_snapshot', side_effect=switch):
        _tick()
    assert _content(gid) is None
    with db.get_connection() as conn:
        assert conn.execute('SELECT count(*) FROM asset_sync_outbox').fetchone()[0] == 0
        assert conn.execute("SELECT count(*) FROM asset_location WHERE kind='local'").fetchone()[0] == 0


def test_every_line_goes_to_the_context_the_scan_started_in(world):
    project = _project()
    gid = _result(world, 'pinned', project=project)
    real = asset_sync.queue_moved_outputs
    seen = []
    def queue(conn, ids, target, destination=None):
        seen.append(destination)
        return real(conn, ids, target, destination)
    with patch.object(asset_sync, 'queue_moved_outputs', side_effect=queue):
        _tick()
    assert seen == [('acct', SERVER)]
    assert _content(gid)


def test_a_failed_link_is_tried_again_and_an_old_server_is_ignored(world):
    project = _project()
    gid, _ = _registered(world, 'relink')
    with db.get_connection() as conn:
        conn.execute("INSERT INTO asset_sync_outbox(sync_id,asset_content_id,local_location_id,owner_uid,project_id,account_key,server_origin,state,updated_at) "
                     "SELECT 'x',asset_content_id,local_location_id,owner_uid,?,account_key,server_origin,'ready',0 FROM asset_sync_outbox LIMIT 1", (project,))
    item = {'project_id': project, 'assets': [{'file_path': '/media/comfy/relink.png'}], 'references': []}
    links = []
    def server(_origin, _token, path, _body):
        if path.endswith('link-output'):
            links.append(path)
            raise OSError('down' if len(links) == 1 else 'HTTP 404 on an old server')
        return {'items': {gid: item}}
    with patch.object(asset_backfill, '_post', side_effect=server):
        asset_backfill.tick(100.0)
        asset_backfill._scan.remote_after = 0
        asset_backfill.tick(200.0)
    assert len(links) == 2


def test_no_token_means_no_work(world, monkeypatch):
    monkeypatch.setattr(shared_connection, 'token', lambda: None)
    gid = _result(world, 'offline', project=_project())
    with patch.object(asset_backfill, '_post') as call:
        asset_backfill.tick(100.0)
    call.assert_not_called()
    assert _content(gid) is None

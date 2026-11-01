"""프로젝트 없는 로컬 결과의 새 공유 막기 — 공유 서버에서 share 행을 새로 만드는 모든 입구."""
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import pytest

from app import config, db, repo
from app.repo import identity, projects, share_commands
from app.repo.share import ShareProjectRequired, import_bundle_item
from app.routers import publish as publish_router
from app.routers._share_authority import http_call
from app.usecases import share as share_usecase


@pytest.fixture
def content(tmp_path, monkeypatch):
    db.flush_pool()
    path = tmp_path / 'content.db'
    monkeypatch.setenv('CONTENT_HUB_DB', str(path))
    db.init_db(path)
    repo.ensure_default_worker()
    with db.get_connection() as conn:
        identity.ensure_worker(conn, 'user_a', 'A', 'team')
    yield path
    db.flush_pool()


@pytest.fixture
def server(monkeypatch):
    monkeypatch.setattr(config, 'AUTH_ENABLED', True)


def _result(name, *, project=None, file_path=None, source_url=None):
    gid = 'g-' + name
    repo.create_local_generation({'model': 'comfy', 'prompt': 'p'}, 'me', generation_id=gid)
    with db.get_connection() as conn:
        conn.execute("UPDATE generation SET status='done', creator_uid='user_a', project_id=? WHERE id=?", (project, gid))
        conn.execute('INSERT INTO asset(id,generation_id,type,file_path,source_url) VALUES(?,?,?,?,?)',
                     ('a-' + name, gid, 'image', file_path or f'/media/comfy/{name}.png', source_url))
    return gid


def _shared(gid):
    return bool(repo.get_generation(gid).get('shared'))


def test_publish_refuses_a_local_result_without_a_project(content, server):
    gid = _result('p1')
    with pytest.raises(ShareProjectRequired):
        repo.publish(gid, 'user_a')
    assert not _shared(gid)


def test_standalone_mode_does_not_block(content):
    gid = _result('p2')
    repo.publish(gid, 'user_a')
    assert _shared(gid)


@pytest.mark.parametrize('kwargs', [{'file_path': 'https://cdn.example/x.png'}, {'source_url': 'https://cdn.example/x.png'},
                                    {'file_path': 'asset-sync:' + 'a' * 32}])
def test_results_others_can_reach_are_shared(content, server, kwargs):
    gid = _result('p3', **kwargs)
    repo.publish(gid, 'user_a')
    assert _shared(gid)


def test_a_result_in_a_project_is_shared(content, server):
    project = projects.create_project('P', created_by='user_a')['id']
    gid = _result('p4', project=project)
    repo.publish(gid, 'user_a')
    assert _shared(gid)


def test_finalize_refuses_when_it_would_be_a_new_share(content, server):
    gid = _result('f1')
    with pytest.raises(ShareProjectRequired):
        repo.finalize_generation_with_share(gid, 'user_a', 'user_a')
    assert not _shared(gid)
    with db.get_connection() as conn:
        assert conn.execute('SELECT is_final FROM generation WHERE id=?', (gid,)).fetchone()[0] == 0


def test_finalize_of_an_already_shared_row_passes(content, server):
    gid = _result('f2')
    with db.get_connection() as conn:
        conn.execute("INSERT INTO share(id,generation_id,shared_by,visibility) VALUES('s1',?,'user_a','team')", (gid,))
    repo.finalize_generation_with_share(gid, 'user_a', 'user_a')
    assert repo.get_generation(gid)['is_final']


def test_final_review_refuses_the_legacy_final_without_a_share(content, server):
    gid = _result('r1')
    with db.get_connection() as conn:
        conn.execute('UPDATE generation SET is_final=1 WHERE id=?', (gid,))
    with pytest.raises(ShareProjectRequired):
        repo.transition_final_review(gid, 'shared', 'user_a')
    assert not _shared(gid)


def test_releasing_a_final_is_never_blocked(content, server):
    gid = _result('r2')
    with db.get_connection() as conn:
        conn.execute("INSERT INTO share(id,generation_id,shared_by,visibility) VALUES('s2',?,'user_a','team')", (gid,))
        conn.execute('UPDATE generation SET is_final=1 WHERE id=?', (gid,))
    repo.release_final(gid)
    assert not repo.get_generation(gid)['is_final'] and _shared(gid)


def _command(gid, kind='publish'):
    with db.get_connection() as conn:
        state = share_commands.state(conn, gid)
    return {'operation_id': 'op-' + gid, 'target_id': gid, 'command_kind': kind, 'expected_revision': state['share_revision'],
            'workspace_scope': state.get('workspace_scope') or 'unknown', 'workspace_id': state.get('workspace_id'), 'parameters': {}, 'db_generation': None}


def _actor(_conn):
    return SimpleNamespace(actor_id='acct:a@x', shared_by='user_a', finalizer='user_a', author_uids={'user_a'}, final_actor=None,
                           authorize=lambda gen, kind=None: None)


@pytest.mark.parametrize('kind', ['publish', 'finalize'])
def test_a_share_command_is_refused_in_its_transaction(content, server, kind):
    gid = _result('c-' + kind)
    with pytest.raises(Exception) as caught:
        http_call(share_usecase.execute, _actor, _command(gid, kind))
    assert caught.value.status_code == 409 and '프로젝트' in caught.value.detail
    assert not _shared(gid)
    with db.get_connection() as conn:
        assert share_commands.receipt(conn, 'acct:a@x', 'op-' + gid) is None


def _item(anchor, *, project=None, file_path='/media/comfy/b.png'):
    return {'generation': {'id': anchor, 'model': 'comfy', 'prompt': 'p', 'params': {}, 'status': 'done', 'created_at': '2026-11-02 00:00:00',
                           'creator_uid': 'user_a', 'project_id': project, 'folder_path': None, 'workspace_scope': 'unknown'},
            'asset': {'type': 'image', 'file_path': file_path}, 'references': [], 'tags': [], 'auto_tags': [], 'comments': []}


def _publish_bundle(item):
    return import_bundle_item(item, 'me', 'user_a', None, {'user_a'})


def _server_rows(anchor):
    with db.get_connection() as conn:
        return (conn.execute('SELECT count(*) FROM generation WHERE id=? OR job_id=?', (anchor, anchor)).fetchone()[0],
                conn.execute('SELECT count(*) FROM asset WHERE file_path=?', ('/media/comfy/b.png',)).fetchone()[0])


def test_a_new_bundle_leaves_nothing_behind(content):
    assert _publish_bundle(_item('n1')) == 'blocked'
    assert _server_rows('n1') == (0, 0)


def test_a_bundle_with_a_remote_address_passes(content):
    assert _publish_bundle(_item('n2', file_path='https://cdn.example/x.png')) == 'inserted'


def test_republishing_a_shared_row_passes_even_without_a_project(content):
    assert import_bundle_item(_item('n3'), 'me', 'user_a') == 'inserted'  # 이 규칙 전에 공유된 행
    assert _publish_bundle(_item('n3')) != 'blocked'


def test_sharing_again_after_unsharing_is_blocked(content):
    assert import_bundle_item(_item('n4'), 'me', 'user_a') == 'inserted'
    with db.get_connection() as conn:
        conn.execute('DELETE FROM share WHERE generation_id IN (SELECT id FROM generation WHERE job_id=? OR id=?)', ('n4', 'n4'))
    assert _publish_bundle(_item('n4')) == 'blocked'


def test_the_hub_message_names_the_reason():
    assert '프로젝트가 없는 로컬 결과' in Path(publish_router.__file__).read_text(encoding='utf-8')


def test_the_non_proxy_entry_skips_only_that_item(content, server, monkeypatch):
    project = projects.create_project('P', created_by='user_a')['id']
    blocked, passed = _result('b1'), _result('b2', project=project)
    monkeypatch.setattr(publish_router, 'require_edit_generation', lambda request, gen: None)
    monkeypatch.setattr(publish_router, 'actor_id', lambda request: 'user_a')
    with patch.object(publish_router._proxy, 'proxying', return_value=False):
        out = publish_router.publish_to_shared(publish_router.PublishToSharedIn(gen_ids=[blocked, passed]), SimpleNamespace())
    assert out['published'] == 1 and out['blocked'] == 1 and '프로젝트' in out['message']
    assert _shared(passed) and not _shared(blocked)

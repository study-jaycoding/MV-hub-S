"""파일을 보낼 사람이 없는 이동·공유를 입구에서 막는다. 업로드 권한은 넓히지 않는다."""
import hashlib
import io
import urllib.error
from types import SimpleNamespace
from unittest.mock import patch

import pytest
from fastapi import HTTPException

from app import active_account, db, repo
from app.repo import asset_sync, identity, projects
from app.repo.asset_sync import UNDELIVERABLE_MESSAGE, UndeliverableMove, pending_delivery, undeliverable_generations
from app.repo.share import import_bundle_item
from app.routers import _delivery, _proxy
from app.routers.asset_sync import LinkOutputIn, link_output
from app.services import asset_sync as sync
from app.shared_server_config import K_URL


@pytest.fixture
def content(tmp_path, monkeypatch):
    db.flush_pool()
    path = tmp_path / 'content.db'
    monkeypatch.setenv('CONTENT_HUB_DB', str(path))
    db.init_db(path)
    repo.ensure_default_worker()
    with db.get_connection() as conn:
        for uid in ('user_a', 'user_n'):
            identity.ensure_worker(conn, uid, uid, 'team')
    yield path
    db.flush_pool()


def _output(name, *, creator='user_a', project=None, file_path=None, source_url=None, content_id=True):
    gid = 'g-' + name
    repo.create_local_generation({'model': 'comfy', 'prompt': 'p'}, 'me', generation_id=gid)
    cid = 'sha256:' + hashlib.sha256(name.encode()).hexdigest() if content_id else None
    with db.get_connection() as conn:
        conn.execute("UPDATE generation SET status='done', creator_uid=?, project_id=? WHERE id=?", (creator, project, gid))
        if cid:
            asset_sync.register_verified_blob(conn, cid[7:], 4, 'image')
        conn.execute('INSERT INTO asset(id,generation_id,type,file_path,source_url,asset_content_id) VALUES(?,?,?,?,?,?)',
                     ('a-' + name, gid, 'image', file_path or f'/media/comfy/{name}.png', source_url, cid))
    return gid


def _project(name='Q'):
    return projects.create_project(name, created_by='owner')['id']


def _member(project, uid, role='creator'):
    with db.get_connection() as conn:
        conn.execute('INSERT INTO project_member(project_id,creator_uid,project_role) VALUES(?,?,?) '
                     'ON CONFLICT(project_id,creator_uid) DO UPDATE SET project_role=excluded.project_role', (project, uid, role))


def _project_of(gid):
    return repo.get_generation(gid)['project_id']


def test_a_move_nobody_can_upload_changes_nothing(content):
    project = _project()
    gid = _output('blocked')
    with pytest.raises(UndeliverableMove):
        repo.assign_to_project([gid], project, check_delivery=True)
    assert _project_of(gid) is None


def test_a_member_with_a_role_moves(content):
    project = _project()
    _member(project, 'user_a')
    gid = _output('member')
    assert repo.assign_to_project([gid], project, check_delivery=True) == 1
    assert _project_of(gid) == project


def test_a_member_row_without_a_role_cannot_upload(content):
    project = _project()
    _member(project, 'user_a', None)
    gid = _output('no-role')
    with pytest.raises(UndeliverableMove):
        repo.assign_to_project([gid], project, check_delivery=True)


@pytest.mark.parametrize('kwargs', [{'file_path': 'https://cdn.example/x.png'}, {'source_url': 'https://cdn.example/x.png'}])
def test_results_with_a_remote_address_move_freely(content, kwargs):
    project = _project()
    gid = _output('remote', **kwargs)
    assert repo.assign_to_project([gid], project, check_delivery=True) == 1


def test_unassigning_needs_no_upload(content):
    project = _project()
    gid = _output('unassign', project=project)
    assert repo.assign_to_project([gid], None, check_delivery=True) == 1
    assert _project_of(gid) is None


def test_a_file_already_in_the_project_needs_no_upload(content):
    project = _project()
    gid = _output('there')
    cid = 'sha256:' + hashlib.sha256(b'there').hexdigest()
    with db.get_connection() as conn:
        conn.execute("INSERT INTO asset_location(location_id,asset_content_id,owner_uid,project_id,storage_id,root_revision,kind,path) "
                     "VALUES('l1',?,'user_a',?,'s','r','server','p')", (cid, project))
    assert repo.assign_to_project([gid], project, check_delivery=True) == 1


def _ready_line(gid, project, origin, account='acct'):
    cid = 'sha256:' + hashlib.sha256(gid[2:].encode()).hexdigest()
    with db.get_connection() as conn:
        conn.execute("INSERT INTO asset_location(location_id,asset_content_id,owner_uid,project_id,storage_id,kind,path,original_file_path) "
                     "VALUES('loc',?,'user_a','','s','local','p','f')", (cid,))
        conn.execute("INSERT INTO asset_sync_outbox(sync_id,asset_content_id,local_location_id,owner_uid,project_id,account_key,server_origin,state,updated_at) "
                     "VALUES('sync',?,'loc','user_a',?,?,?,'ready',0)", (cid, project, account, origin))


def test_a_finished_line_counts_only_for_the_current_server_and_account(content, monkeypatch):
    project = _project()
    monkeypatch.setattr(active_account, 'account_key', lambda: 'acct')
    repo.set_setting(K_URL, 'http://now')
    gid = _output('old-server')
    _ready_line(gid, project, 'http://old')
    with db.get_connection() as conn:
        assert pending_delivery(conn, [gid], project) == [(gid, 'user_a')]
        conn.execute("UPDATE asset_sync_outbox SET server_origin='http://now', account_key='someone'")
        assert pending_delivery(conn, [gid], project) == [(gid, 'user_a')]
        conn.execute("UPDATE asset_sync_outbox SET account_key='acct'")
        assert pending_delivery(conn, [gid], project) == []


def test_only_inputs_with_a_content_id_count(content):
    project = _project()
    gid = _output('http-result', file_path='https://cdn.example/x.png')
    with db.get_connection() as conn:
        conn.execute("INSERT INTO reference(id,type,file_path) VALUES('old','image','asset:p|old.png')")
        conn.execute("INSERT INTO gen_reference(generation_id,reference_id) VALUES(?, 'old')", (gid,))
        assert pending_delivery(conn, [gid], project) == []
        asset_sync.register_verified_blob(conn, 'c' * 64, 4, 'image')
        conn.execute("UPDATE reference SET asset_content_id=? WHERE id='old'", ('sha256:' + 'c' * 64,))
        assert pending_delivery(conn, [gid], project) == [(gid, 'user_a')]


def test_read_all_alone_does_not_upload(content):
    """read_all 은 프로젝트 역할이 아니다 — 업로드 입구와 같은 판정."""
    project = _project()
    gid = _output('pm', creator='user_pm')
    with db.get_connection() as conn:
        conn.execute("INSERT INTO account(email,password_hash,name,global_role,status,creator_uid) VALUES('pm@x','h','PM','product_manager','approved','user_pm')")
        assert undeliverable_generations(conn, [gid], project) == [gid]


def test_an_alias_author_is_seen_as_the_account(content):
    project = _project()
    _member(project, 'user_real')
    gid = _output('alias', creator='acct:a@x')
    with db.get_connection() as conn:
        conn.execute("INSERT INTO account(email,password_hash,name,global_role,status,creator_uid) VALUES('a@x','h','A','member','approved','user_real')")
        assert undeliverable_generations(conn, [gid], project) == []


def test_workspace_tag_is_gated_the_same(content):
    team = {'id': 'ws1', 'name': 'Team'}
    project = projects.create_project('Only', created_by='owner', workspace={'scope': 'team', 'id': 'ws1', 'name': 'Team'})['id']
    gid = _output('tag')
    with pytest.raises(UndeliverableMove):
        repo.set_generation_workspace_batch([gid], 'assign', team, check_delivery=True)
    assert _project_of(gid) is None
    _member(project, 'user_a')
    repo.set_generation_workspace_batch([gid], 'assign', team, check_delivery=True)
    assert _project_of(gid) == project


def _item(anchor, *, creator, project=None, file_path='/media/comfy/b.png'):
    return {'generation': {'id': anchor, 'model': 'comfy', 'prompt': 'p', 'params': {}, 'status': 'done', 'created_at': '2026-11-02 00:00:00',
                           'creator_uid': creator, 'project_id': project, 'folder_path': None, 'workspace_scope': 'unknown'},
            'asset': {'type': 'image', 'file_path': file_path}, 'references': [], 'tags': [], 'auto_tags': [], 'comments': []}


def _rows(anchor):
    with db.get_connection() as conn:
        return conn.execute('SELECT count(*) FROM generation WHERE id=? OR job_id=?', (anchor, anchor)).fetchone()[0]


def test_a_bundle_into_a_project_of_a_non_member_rolls_back(content):
    project = _project()
    assert import_bundle_item(_item('b1', creator='user_n', project=project), 'me', 'user_n', None, {'user_n'}) == 'blocked'
    assert _rows('b1') == 0


def test_a_bundle_cannot_lean_on_a_claimed_author(content):
    """번들의 작성자 주장이 아니라 인증 계정으로 판정한다 — 구성원을 작성자로 적어도 올릴 사람은 발행자다."""
    project = _project()
    _member(project, 'user_m')
    assert import_bundle_item(_item('b2', creator='user_m', project=project), 'me', 'user_n', None, {'user_n'}) == 'blocked'
    assert _rows('b2') == 0


def test_a_member_publishes_into_the_project(content):
    project = _project()
    _member(project, 'user_a')
    assert import_bundle_item(_item('b3', creator='user_a', project=project), 'me', 'user_a', None, {'user_a'}) == 'inserted'
    assert _rows('b3') == 1


def test_republishing_without_moving_is_not_gated(content):
    project = _project()
    _member(project, 'user_a')
    assert import_bundle_item(_item('b4', creator='user_a', project=project), 'me', 'user_a', None, {'user_a'}) == 'inserted'
    with db.get_connection() as conn:
        conn.execute("DELETE FROM project_member WHERE creator_uid='user_a'")
    assert import_bundle_item(_item('b4', creator='user_a', project=project), 'me', 'user_a', None, {'user_a'}) != 'blocked'


def test_local_import_without_an_account_is_not_gated(content):
    project = _project()
    assert import_bundle_item(_item('b5', creator='user_n', project=project), 'me', 'user_n') != 'blocked'


# ── 허브 입구 ──
@pytest.fixture
def hub(monkeypatch):
    monkeypatch.setattr(_proxy, 'proxying', lambda: True)
    monkeypatch.setattr(active_account, 'active_uid', lambda: 'user_a')


def test_hub_refuses_when_this_account_has_no_role(content, hub):
    gid = _output('hub-no')
    with patch.object(_proxy, 'proxy_json', return_value=[{'uid': 'user_a', 'roles': []}, {'uid': 'user_b', 'roles': ['creator']}]), \
            pytest.raises(HTTPException) as caught:
        _delivery.require_hub_delivery([gid], 'p1')
    assert caught.value.status_code == 403 and caught.value.detail == UNDELIVERABLE_MESSAGE


def test_hub_passes_a_403_from_the_member_list_as_no_role(content, hub):
    gid = _output('hub-403')
    with patch.object(_proxy, 'proxy_json', side_effect=HTTPException(403, 'x')), pytest.raises(HTTPException) as caught:
        _delivery.require_hub_delivery([gid], 'p1')
    assert caught.value.detail == UNDELIVERABLE_MESSAGE


def test_hub_lets_a_member_through(content, hub):
    gid = _output('hub-yes')
    with patch.object(_proxy, 'proxy_json', return_value=[{'uid': 'user_a', 'roles': ['creator']}]):
        assert _delivery.require_hub_delivery([gid], 'p1') is True


@pytest.mark.parametrize('failure', [HTTPException(502, 'down'), HTTPException(404, 'old'), OSError('gone')])
def test_hub_still_moves_when_the_server_cannot_say(content, hub, failure):
    gid = _output('hub-down')
    with patch.object(_proxy, 'proxy_json', side_effect=failure):
        assert _delivery.require_hub_delivery([gid], 'p1') is False


def test_the_notice_is_silent_when_all_is_well(content, hub):
    with patch.object(_delivery.asset_backfill, 'missing_files', return_value=0):
        assert _delivery.delivery_notice(['g'], 'p1', True) == {}


def test_the_notice_says_what_it_could_not_confirm(content, hub):
    with patch.object(_delivery.asset_backfill, 'missing_files', return_value=2):
        assert _delivery.delivery_notice(['g'], 'p1', False) == {'delivery_unverified': True, 'missing_files': 2}


def test_the_notice_is_only_for_a_move_into_a_project_on_a_hub(content, monkeypatch):
    with patch.object(_delivery.asset_backfill, 'missing_files', return_value=2):
        assert _delivery.delivery_notice(['g'], None, False) == {}
        monkeypatch.setattr(_proxy, 'proxying', lambda: False)
        assert _delivery.delivery_notice(['g'], 'p1', False) == {}


def test_hub_does_not_ask_when_nothing_needs_sending(content, hub):
    gid = _output('hub-http', file_path='https://cdn.example/x.png')
    with patch.object(_proxy, 'proxy_json') as asked:
        _delivery.require_hub_delivery([gid], 'p1')
    asked.assert_not_called()


# ── 전송 상태 ──
def _line(sync_id, state, *, error=None, origin='http://now', account='acct', owner='user_a'):
    cid = 'sha256:' + hashlib.sha256(sync_id.encode()).hexdigest()
    with db.get_connection() as conn:
        asset_sync.register_verified_blob(conn, cid[7:], 4, 'image')
        conn.execute("INSERT OR IGNORE INTO asset_location(location_id,asset_content_id,owner_uid,project_id,storage_id,kind,path,original_file_path) "
                     "VALUES(?,?,?,'','s','local','p','f')", ('l' + sync_id, cid, owner))
        conn.execute("INSERT INTO asset_sync_outbox(sync_id,asset_content_id,local_location_id,owner_uid,project_id,account_key,server_origin,state,last_error_code,updated_at) "
                     "VALUES(?,?,?,?,'p',?,?,?,?,0)", (sync_id, cid, 'l' + sync_id, owner, account, origin, state, error))


def _state(sync_id):
    with db.get_connection() as conn:
        return conn.execute('SELECT state FROM asset_sync_outbox WHERE sync_id=?', (sync_id,)).fetchone()[0]


def test_the_summary_counts_this_server_and_sorts_what_retry_can_fix(content):
    _line('q', 'queued'); _line('u', 'uploading'); _line('r', 'retrying', error='asset_transfer_failed'); _line('rr', 'recovery_required')
    _line('v', 'verification_failed'); _line('f', 'retrying', error='asset_project_forbidden'); _line('root', 'retrying', error='asset_root_required')
    _line('none', 'project_required'); _line('gone', 'deleted'); _line('done', 'ready')
    _line('old', 'retrying', error='asset_transfer_failed', origin='http://old'); _line('other', 'retrying', account='someone')
    with db.get_connection() as conn:
        assert asset_sync.transfer_summary(conn, 'user_a', 'acct', 'http://now') == {'waiting': 2, 'failed': 2, 'needs_check': 3}


def test_retry_touches_only_what_it_can_fix_on_this_server(content):
    _line('r', 'retrying', error='asset_transfer_failed'); _line('rr', 'recovery_required'); _line('f', 'retrying', error='asset_project_forbidden')
    _line('old', 'retrying', error='asset_transfer_failed', origin='http://old'); _line('v', 'verification_failed')
    with db.get_connection() as conn:
        asset_sync.retry_failed(conn, 'user_a', 'acct', 'http://now')
    assert [_state(name) for name in ('r', 'rr', 'f', 'old', 'v')] == ['queued', 'queued', 'retrying', 'retrying', 'verification_failed']


@pytest.mark.parametrize('code,body,expected', [
    (403, b'{"detail":"x"}', 'asset_project_forbidden'), (409, b'{"detail":"asset_root_required"}', 'asset_root_required'),
    (409, b'{"detail":"project_unavailable"}', 'project_unavailable'), (409, b'{"detail":"other"}', 'asset_transfer_failed'),
    (500, b'not json', 'asset_transfer_failed')])
def test_the_worker_names_the_errors_retry_cannot_fix(code, body, expected):
    error = urllib.error.HTTPError('http://x', code, 'x', {}, io.BytesIO(body))
    assert sync._transfer_error(error) == expected


def test_a_stuck_line_finishes_by_itself_when_the_role_arrives(content):
    """자동 재시도는 그대로다 — 확인 필요는 표시일 뿐 줄을 멈추지 않는다."""
    _line('f', 'retrying', error='asset_project_forbidden', origin='http://server')
    with db.get_connection() as conn:
        conn.execute("UPDATE asset_sync_outbox SET next_retry_at=0")
        assert asset_sync.claim(conn, 'user_a', 'http://server', 'acct')['sync_id'] == 'f'


# ── 서버 행의 빈 내용 ID ──
def _request(uid='user_a', email='a@x'):
    return SimpleNamespace(state=SimpleNamespace(account={'email': email, 'creator_uid': uid}))


def _located(project, name, owner='user_a'):
    cid = 'sha256:' + hashlib.sha256(name.encode()).hexdigest()
    with db.get_connection() as conn:
        asset_sync.register_verified_blob(conn, cid[7:], 4, 'image')
        conn.execute("INSERT INTO asset_location(location_id,asset_content_id,owner_uid,project_id,storage_id,root_revision,kind,path) "
                     "VALUES(?,?,?,?,'s','r','server','p')", (hashlib.md5(name.encode()).hexdigest(), cid, owner, project))
    return cid


def _link(gid, cid, file_path, request=None):
    return link_output(LinkOutputIn(anchor=gid, asset_content_id=cid, file_path=file_path), request or _request())


def _content_of(gid):
    with db.get_connection() as conn:
        return conn.execute('SELECT asset_content_id FROM asset WHERE generation_id=?', (gid,)).fetchone()[0]


def test_link_fills_only_an_empty_id_and_repeats_safely(content):
    project = _project()
    gid = _output('link', project=project, content_id=False)
    cid = _located(project, 'link')
    assert _link(gid, cid, '/media/comfy/link.png')['linked'] is True
    assert _content_of(gid) == cid
    assert _link(gid, cid, '/media/comfy/link.png')['linked'] is False


def test_link_fills_an_input_and_keeps_its_place(content):
    project = _project()
    gid = _output('link-input', project=project)
    with db.get_connection() as conn:
        conn.execute("INSERT INTO reference(id,type,file_path,source) VALUES('r9','image','/api/comfy/inputs/s/i.png','이름')")
        conn.execute("INSERT INTO gen_reference(generation_id,reference_id,role,position) VALUES(?, 'r9', '@Image1', 3)", (gid,))
    cid = _located(project, 'input-bytes')
    assert _link(gid, cid, '/api/comfy/inputs/s/i.png')['linked'] is True
    with db.get_connection() as conn:
        row = conn.execute("SELECT r.asset_content_id,r.source,gr.role,gr.position FROM reference r JOIN gen_reference gr ON gr.reference_id=r.id WHERE r.id='r9'").fetchone()
    assert tuple(row) == (cid, '이름', '@Image1', 3)


def _shared_input(project):
    mine = _output('link-mine', project=project)
    theirs = _output('link-theirs', creator='user_b')
    with db.get_connection() as conn:
        conn.execute("INSERT INTO reference(id,type,file_path,source) VALUES('shared','image','/api/comfy/inputs/s/shared.png','이름')")
        conn.execute("INSERT INTO gen_reference(generation_id,reference_id,role) VALUES(?, 'shared', '@Image1'),(?, 'shared', '@Image1')", (mine, theirs))
    return mine, theirs


def _refs_of(gid):
    with db.get_connection() as conn:
        return [tuple(row) for row in conn.execute(
            'SELECT r.id,r.asset_content_id,r.source,gr.role,gr.position FROM gen_reference gr JOIN reference r ON r.id=gr.reference_id '
            'WHERE gr.generation_id=? ORDER BY COALESCE(gr.position,gr.rowid),gr.rowid', (gid,))]


def test_link_copies_an_input_row_someone_else_also_uses(content):
    project = _project()
    mine, theirs = _shared_input(project)
    cid = _located(project, 'shared-bytes')
    assert _link(mine, cid, '/api/comfy/inputs/s/shared.png')['linked'] is True
    assert _refs_of(theirs) == [('shared', None, '이름', '@Image1', None)]
    copied = _refs_of(mine)[0]
    assert copied[0] != 'shared' and copied[1:] == (cid, '이름', '@Image1', None)


def test_link_repeated_makes_no_second_copy(content):
    project = _project()
    mine, _ = _shared_input(project)
    cid = _located(project, 'shared-again')
    _link(mine, cid, '/api/comfy/inputs/s/shared.png')
    assert _link(mine, cid, '/api/comfy/inputs/s/shared.png')['linked'] is False
    with db.get_connection() as conn:
        assert conn.execute("SELECT count(*) FROM reference WHERE file_path='/api/comfy/inputs/s/shared.png'").fetchone()[0] == 2


def test_link_at_the_same_time_makes_no_second_copy(content):
    import threading
    project = _project()
    mine, _ = _shared_input(project)
    cid = _located(project, 'shared-race')
    start = threading.Barrier(2)
    results = []
    def run():
        start.wait()
        results.append(_link(mine, cid, '/api/comfy/inputs/s/shared.png')['linked'])
    threads = [threading.Thread(target=run) for _ in range(2)]
    [thread.start() for thread in threads]
    [thread.join() for thread in threads]
    assert sorted(results) == [False, True]
    with db.get_connection() as conn:
        assert conn.execute("SELECT count(*) FROM reference WHERE file_path='/api/comfy/inputs/s/shared.png'").fetchone()[0] == 2


def test_link_keeps_the_order_of_rows_without_a_position(content):
    project = _project()
    mine, _ = _shared_input(project)
    with db.get_connection() as conn:
        conn.execute("INSERT INTO reference(id,type,file_path) VALUES('after','image','/api/comfy/inputs/s/after.png')")
        conn.execute("INSERT INTO gen_reference(generation_id,reference_id,role) VALUES(?, 'after', '@Image2')", (mine,))
    cid = _located(project, 'shared-order')
    _link(mine, cid, '/api/comfy/inputs/s/shared.png')
    assert [row[3] for row in _refs_of(mine)] == ['@Image1', '@Image2']


def test_link_fills_every_blank_row_with_that_path(content):
    project = _project()
    gid = _output('link-two', project=project)
    with db.get_connection() as conn:
        conn.execute("INSERT INTO reference(id,type,file_path) VALUES('one','image','/media/comfy/same.png'),('two','image','/media/comfy/same.png')")
        conn.execute("INSERT INTO gen_reference(generation_id,reference_id,role) VALUES(?, 'one', '@Image1'),(?, 'two', '@Image2')", (gid, gid))
    cid = _located(project, 'same-path')
    _link(gid, cid, '/media/comfy/same.png')
    assert [row[1] for row in _refs_of(gid)] == [cid, cid]


def test_link_skips_a_row_recorded_with_other_bytes(content):
    project = _project()
    gid = _output('link-diff', project=project)
    cid = _located(project, 'diff-bytes')
    with db.get_connection() as conn:
        conn.execute("INSERT INTO reference(id,type,file_path,content_sha,content_bytes) VALUES('other','image','/media/comfy/d.png',?,9),('blank','image','/media/comfy/d.png',NULL,NULL)", ('f' * 64,))
        conn.execute("INSERT INTO gen_reference(generation_id,reference_id,role) VALUES(?, 'other', '@Image1'),(?, 'blank', '@Image2')", (gid, gid))
    _link(gid, cid, '/media/comfy/d.png')
    assert [(row[0], row[1]) for row in _refs_of(gid)] == [('other', None), ('blank', cid)]


def test_link_treats_a_recorded_size_of_zero_as_recorded(content):
    project = _project()
    gid = _output('link-zero', project=project)
    cid = _located(project, 'zero-bytes')
    with db.get_connection() as conn:
        conn.execute("INSERT INTO reference(id,type,file_path,content_bytes) VALUES('zero','image','/media/comfy/z.png',0)")
        conn.execute("INSERT INTO gen_reference(generation_id,reference_id) VALUES(?, 'zero')", (gid,))
    with pytest.raises(HTTPException):
        _link(gid, cid, '/media/comfy/z.png')


def test_link_refuses_when_every_blank_row_has_other_bytes(content):
    project = _project()
    gid = _output('link-diff2', project=project)
    cid = _located(project, 'diff-bytes2')
    with db.get_connection() as conn:
        conn.execute("INSERT INTO reference(id,type,file_path,content_sha) VALUES('only','image','/media/comfy/e.png',?)", ('f' * 64,))
        conn.execute("INSERT INTO gen_reference(generation_id,reference_id) VALUES(?, 'only')", (gid,))
    with pytest.raises(HTTPException) as caught:
        _link(gid, cid, '/media/comfy/e.png')
    assert caught.value.status_code == 409
    assert _refs_of(gid)[0][1] is None


def test_link_refuses_another_authors_row(content):
    project = _project()
    gid = _output('link-other', creator='user_b', project=project, content_id=False)
    cid = _located(project, 'link-other', 'user_b')
    with pytest.raises(HTTPException) as caught:
        _link(gid, cid, '/media/comfy/link-other.png')
    assert caught.value.status_code == 403
    assert _content_of(gid) is None


def test_link_needs_a_ready_location(content):
    project = _project()
    gid = _output('link-none', project=project, content_id=False)
    with pytest.raises(HTTPException) as caught:
        _link(gid, 'sha256:' + 'd' * 64, '/media/comfy/link-none.png')
    assert caught.value.status_code == 409
    assert _content_of(gid) is None


def test_link_does_not_replace_an_existing_id(content):
    project = _project()
    gid = _output('link-keep', project=project)
    before = _content_of(gid)
    cid = _located(project, 'something-else')
    with pytest.raises(HTTPException) as caught:
        _link(gid, cid, '/media/comfy/link-keep.png')
    assert caught.value.status_code == 409
    assert _content_of(gid) == before


def test_link_skips_http_results_and_deleted_rows(content):
    project = _project()
    url = 'https://cdn.example/x.png'
    remote = _output('link-http', project=project, file_path=url, content_id=False)
    cid = _located(project, 'link-http')
    with pytest.raises(HTTPException) as caught:
        _link(remote, cid, url)
    assert caught.value.status_code == 404
    gone = _output('link-gone', project=project, content_id=False)
    with db.get_connection() as conn:
        conn.execute("UPDATE generation SET deleted_at='2026-11-02' WHERE id=?", (gone,))
    with pytest.raises(HTTPException) as caught:
        _link(gone, cid, '/media/comfy/link-gone.png')
    assert caught.value.status_code == 404

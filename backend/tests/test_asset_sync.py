from __future__ import annotations

import hashlib
import sqlite3
import time
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app import db
from app.repo import asset_sync as ledger
from app.routers import asset_sync as api
from app.services import asset_sync as sync


PNG = b'\x89PNG\r\n\x1a\n' + b'asset test payload'


@pytest.fixture
def storage(tmp_path,monkeypatch):
    path=db.init_db(tmp_path/'content.db')
    monkeypatch.setenv('CONTENT_HUB_DB',str(path))
    conn=sqlite3.connect(path,isolation_level=None)
    conn.row_factory=sqlite3.Row
    conn.execute("INSERT INTO project(id,name,asset_root_path) VALUES('p','Project',?)",(str(tmp_path/'assets'),))
    conn.execute("INSERT INTO project(id,name,asset_root_path) VALUES('q','Other project',?)",(str(tmp_path/'other'),))
    yield conn,tmp_path
    conn.close()


def prep(conn,*,owner='user_a',name='제이',digest=None,project='p',filename='capture.png',size=len(PNG)):
    result=sync.prepare(conn,owner_uid=owner,display_name=name,project_id=project,digest=digest or hashlib.sha256(PNG).hexdigest(),size=size,media_type='image',original_name=filename)
    conn.commit()
    return result


def upload(conn,base,ticket,*,owner='user_a',content=PNG):
    tmp=base/'input.png'
    tmp.write_bytes(content)
    result=sync.accept_upload(conn,ticket['token'],owner,tmp,hashlib.sha256(content).hexdigest(),len(content))
    conn.commit()
    return result


def test_roundtrip_owner_folder_dedup_restore_and_content_identity(storage):
    conn,base=storage
    ticket=prep(conn)
    assert conn.execute('SELECT count(*) FROM asset_blob').fetchone()[0]==0  # prepare is untrusted
    result=upload(conn,base,ticket)
    assert result['asset_content_id']=='sha256:'+hashlib.sha256(PNG).hexdigest()
    assert result['file_path']=='asset-sync:'+result['location_id']
    files=list((base/'assets'/'imp_cap'/'제이').glob('*.png'))
    assert len(files)==1 and files[0].read_bytes()==PNG
    again=prep(conn,filename='different.png')
    assert again['state']=='ready' and again['location_id']==result['location_id']
    # A DB-only restore must not claim that absent bytes are ready.
    files[0].unlink()
    restored=prep(conn)
    assert restored['state']=='upload_required'
    assert upload(conn,base,restored)['location_id']==result['location_id']


def test_same_name_different_users_and_projects_are_separate(storage):
    conn,base=storage
    one=upload(conn,base,prep(conn))
    two=upload(conn,base,prep(conn,owner='user_b'),owner='user_b')
    three=upload(conn,base,prep(conn,project='q'))
    assert len({one['location_id'],two['location_id'],three['location_id']})==3
    labels=[r[0] for r in conn.execute("SELECT folder_label FROM asset_owner_folder WHERE project_id='p'")]
    assert '제이' in labels and len(set(map(str.casefold,labels)))==2
    assert conn.execute('SELECT count(*) FROM asset_blob').fetchone()[0]==1


def test_media_hash_size_owner_root_and_nonoverwrite_boundaries(storage):
    conn,base=storage
    ticket=prep(conn)
    with pytest.raises(sync.SyncError,match='expired'):
        upload(conn,base,ticket,owner='someone_else')
    with pytest.raises(sync.SyncError,match='digest_mismatch'):
        upload(conn,base,ticket,content=PNG+b'bad')
    conn.execute("UPDATE project SET asset_root_path=? WHERE id='p'",(str(base/'changed'),))
    with pytest.raises(sync.SyncError,match='context_changed'):
        upload(conn,base,ticket)
    bad=prep(conn,digest=hashlib.sha256(b'<script>html</script>').hexdigest(),size=21)
    with pytest.raises(sync.SyncError,match='media_mismatch|digest_mismatch'):
        upload(conn,base,bad,content=b'<script>html</script>')
    new=prep(conn)
    token=conn.execute('SELECT relative_path FROM asset_upload_token WHERE token=?',(new['token'],)).fetchone()[0]
    path=base/'changed'/token
    path.parent.mkdir(parents=True,exist_ok=True)
    path.write_bytes(b'preserve this unrelated content')
    with pytest.raises(sync.SyncError,match='destination_conflict'):
        upload(conn,base,new)
    assert path.read_bytes()==b'preserve this unrelated content'


def test_folder_sanitization_freezes_display_name_and_path_traversal(storage):
    conn,base=storage
    ticket=prep(conn,name='../CON: /')
    result=upload(conn,base,ticket)
    folder=conn.execute('SELECT folder_label FROM asset_owner_folder').fetchone()[0]
    assert '/' not in folder and '\\' not in folder and ':' not in folder
    assert prep(conn,name='changed')['location_id']==result['location_id']
    with pytest.raises(sync.SyncError,match='unsafe_asset_path'):
        sync._file_path(base/'assets','../secret')


def test_local_outbox_account_scope_lease_recovery_and_restart(storage):
    conn,base=storage
    source=base/'capture.png'
    source.write_bytes(PNG)
    args=dict(path=source,file_path='asset:captures|one.png',digest=hashlib.sha256(PNG).hexdigest(),size=len(PNG),media_type='image',owner_uid='user_a',project_id='p',server_origin='http://example.invalid',account_key='a')
    result=ledger.register_local(conn,**args)
    assert result['sync_state']=='queued'
    assert ledger.claim(conn,'user_b','http://example.invalid','b') is None
    conn.commit()
    assert ledger.claim(conn,'user_a','http://example.invalid','a',now=time.time()) is not None
    conn.commit()
    assert ledger.claim(conn,'user_a','http://example.invalid','a',now=time.time()) is None
    conn.commit()
    recovered=ledger.claim(conn,'user_a','http://example.invalid','a',now=time.time()+601)
    conn.commit()
    assert recovered is not None
    assert not ledger.settle(conn,{**recovered,'lease_token':'stale'},receipt={'location_id':'wrong'})
    assert ledger.settle(conn,recovered,receipt={'location_id':'good','file_path':'asset-sync:good','storage_id':'server','root_revision':'root'})
    rows=ledger.status_rows(conn,'user_a')
    assert rows[0]['server_file_path']=='asset-sync:good'
    assert rows[0]['original_file_path']=='asset:captures|one.png'
    assert ledger.status_rows(conn,'user_b')==[]


def test_http_upload_stream_and_immutable_file_download(storage,monkeypatch):
    conn,base=storage
    app=FastAPI()
    app.include_router(api.router)
    monkeypatch.setattr(api,'require_project_role',lambda *a,**kw:None)
    monkeypatch.setattr(api,'actor_id',lambda request:'user_a')
    monkeypatch.setattr(api._proxy,'proxying',lambda:False)
    with TestClient(app) as client:
        result=client.post('/api/asset-sync/prepare',json={'project_id':'p','sha256':hashlib.sha256(PNG).hexdigest(),'bytes':len(PNG),'media_type':'image','original_name':'capture.png'})
        assert result.status_code==200,result.text
        ticket=result.json()
        result=client.put('/api/asset-sync/uploads/'+ticket['token'],content=PNG)
        assert result.status_code==200,result.text
        receipt=result.json()
        downloaded=client.get('/api/asset-sync/files/'+receipt['location_id'])
        assert downloaded.status_code==200 and downloaded.content==PNG
        assert downloaded.headers['x-content-type-options']=='nosniff'
        assert client.post('/api/asset-sync/prepare',json={'project_id':'p','sha256':'bad','bytes':1,'media_type':'image','original_name':'bad.png'}).status_code==422


def test_project_tree_hides_only_display_not_registry_scan():
    from app.routers.assets import _tree_hidden_names
    from app.services.asset_registry_scan import hidden_name
    assert 'imp_cap' in _tree_hidden_names('Project',auto_project=True)
    assert not hidden_name('imp_cap')


def test_worker_queues_local_first_and_settles_only_verified_server_receipt(storage,monkeypatch):
    conn,base=storage
    source=base/'local.png'
    source.write_bytes(PNG)
    origin='http://sync.invalid'
    monkeypatch.setattr(sync.active_account,'active_uid',lambda:'user_a')
    monkeypatch.setattr(sync.active_account,'account_key',lambda:'')
    monkeypatch.setattr(sync.shared_connection,'base_url',lambda:origin)
    monkeypatch.setattr(sync.shared_connection,'token',lambda:'test-only-token')
    local=sync.register_local(source,'asset:captures|one.png',hashlib.sha256(PNG).hexdigest(),len(PNG),'image','user_a','p')
    assert local['sync_state']=='queued' and not (base/'assets').exists()
    def call(server,token,path,body):
        assert server==origin and path=='/api/asset-sync/prepare'
        with db.get_connection() as connection:
            return sync.prepare(connection,owner_uid='user_a',display_name='제이',project_id=body['project_id'],digest=body['sha256'],size=body['bytes'],media_type=body['media_type'],original_name=body['original_name'])
    def transfer(server,token,ticket,row):
        with db.get_connection() as connection:
            return sync.accept_upload(connection,ticket['token'],'user_a',Path(row['path']),row['sha256'],row['bytes'])
    monkeypatch.setattr(sync,'_json_call',call)
    monkeypatch.setattr(sync,'_upload',transfer)
    assert sync.process_one()
    rows=ledger.status_rows(conn,'user_a')
    assert rows[0]['state']=='ready' and rows[0]['server_file_path'].startswith('asset-sync:')
    assert rows[0]['server_origin']==origin
    assert source.read_bytes()==PNG  # server promotion keeps local cache
    assert len(list((base/'assets'/'imp_cap'/'제이').glob('*.png')))==1
    assert not sync.process_one()


def test_worker_rejects_wrong_owner_ack_and_does_not_publish_ready(storage,monkeypatch):
    conn,base=storage
    source=base/'local.png'
    source.write_bytes(PNG)
    monkeypatch.setattr(sync.active_account,'active_uid',lambda:'user_a')
    monkeypatch.setattr(sync.active_account,'account_key',lambda:'')
    monkeypatch.setattr(sync.shared_connection,'base_url',lambda:'http://sync.invalid')
    monkeypatch.setattr(sync.shared_connection,'token',lambda:'test-only-token')
    sync.register_local(source,'asset:captures|one.png',hashlib.sha256(PNG).hexdigest(),len(PNG),'image','user_a','p')
    monkeypatch.setattr(sync,'_json_call',lambda *args:{'owner_uid':'someone_else','state':'ready'})
    assert sync.process_one()
    row=ledger.status_rows(conn,'user_a')[0]
    assert row['state']=='retrying' and row['server_file_path'] is None
    assert row['last_error_code']=='asset_receipt_mismatch'
    assert source.read_bytes()==PNG


def test_server_location_alias_keeps_old_canonical_token_readable(storage,monkeypatch):
    conn,base=storage
    result=upload(conn,base,prep(conn))
    alias='a'*32
    conn.execute('INSERT INTO asset_location_alias VALUES(?,?)',(alias,result['location_id']))
    app=FastAPI()
    app.include_router(api.router)
    monkeypatch.setattr(api,'require_project_role',lambda *a,**kw:None)
    monkeypatch.setattr(api._proxy,'proxying',lambda:False)
    with TestClient(app) as client:
        assert client.get('/api/asset-sync/files/'+alias).content==PNG
        assert client.get('/api/asset-sync/files/bad-id').status_code==404


def test_remote_api_enforces_write_membership_and_read_acl(storage,monkeypatch):
    from app import deps
    conn,base=storage
    result=upload(conn,base,prep(conn))
    monkeypatch.setattr(deps,'AUTH_ENABLED',True)
    monkeypatch.setattr(api._proxy,'proxying',lambda:False)
    app=FastAPI()
    @app.middleware('http')
    async def account(request,call_next):
        request.state.account={'creator_uid':'user_a','global_role':'admin'}
        return await call_next(request)
    app.include_router(api.router)
    body={'project_id':'p','sha256':hashlib.sha256(PNG).hexdigest(),'bytes':len(PNG),'media_type':'image','original_name':'capture.png'}
    with TestClient(app) as client:
        # Admin read_all can read project media, but cannot write without membership.
        assert client.post('/api/asset-sync/prepare',json=body).status_code==403
        assert client.get('/api/asset-sync/files/'+result['location_id']).status_code==200
        conn.execute("INSERT INTO project_member VALUES('p','user_a','creator')")
        assert client.post('/api/asset-sync/prepare',json=body).status_code==200


def test_local_ingest_hashes_bytes_without_waiting_for_remote_and_rejects_remote_peer(storage,monkeypatch):
    conn,base=storage
    monkeypatch.setattr(api.config,'ASSETS_ROOT',base/'local-assets')
    monkeypatch.setattr(api,'actor_id',lambda request:'user_a')
    monkeypatch.setattr(api.active_account,'active_uid',lambda:'user_a')
    app=FastAPI()
    app.include_router(api.local_router)
    with TestClient(app,base_url='http://127.0.0.1',client=('127.0.0.1',5000)) as client:
        first=client.post('/api/local-asset-sync/ingest',data={'original_file_path':'https://example.invalid/input.png','target_project_id':'p'},files={'file':('input.png',PNG,'image/png')})
        assert first.status_code==200,first.text
        body=first.json()
        assert body['sync_state']=='queued' and body['bytes']==len(PNG)
        assert body['asset_content_id']=='sha256:'+hashlib.sha256(PNG).hexdigest()
        assert not (base/'assets').exists()
        second=client.post('/api/local-asset-sync/ingest',data={'original_file_path':'other.png','target_project_id':'p'},files={'file':('renamed.png',PNG,'image/png')})
        assert second.json()['asset_content_id']==body['asset_content_id']
        assert len(list((base/'local-assets'/'imports').glob('*.png')))==1
    with TestClient(app,base_url='http://127.0.0.1',client=('198.51.100.2',5000)) as client:
        assert client.get('/api/local-asset-sync/status').status_code==403


def test_local_resolve_restored_content_ids_uses_server_and_keeps_origin(storage,monkeypatch):
    conn,base=storage
    cid='sha256:'+hashlib.sha256(PNG).hexdigest()
    monkeypatch.setattr(api._proxy,'proxying',lambda:True)
    monkeypatch.setattr(api._proxy,'base_url',lambda:'http://sync.invalid')
    monkeypatch.setattr(api._proxy,'proxy_json',lambda *args,**kwargs:{'items':[{'asset_content_id':cid,'project_id':'p','owner_uid':'user_a','location_id':'a'*32,'state':'ready','file_path':'asset-sync:'+'a'*32}]})
    request=__import__('types').SimpleNamespace()
    monkeypatch.setattr(api,'actor_id',lambda request:'user_a')
    monkeypatch.setattr(api.active_account,'active_uid',lambda:'user_a')
    rows=api.local_resolve(api.ResolveIn(project_id='p',asset_content_ids=[cid]),request)['items']
    assert rows[0]['server_origin']=='http://sync.invalid' and rows[0]['server_file_path']=='asset-sync:'+'a'*32


def test_verified_media_registration_can_refine_unknown_agent_type(storage):
    conn,base=storage
    sha=hashlib.sha256(PNG).hexdigest()
    cid=ledger.register_verified_blob(conn,sha,len(PNG),'application/octet-stream')
    assert ledger.register_verified_blob(conn,sha,len(PNG),'image')==cid
    assert conn.execute('SELECT media_type FROM asset_blob WHERE asset_content_id=?',(cid,)).fetchone()[0]=='image'
    with pytest.raises(ValueError,match='content_conflict'):
        ledger.register_verified_blob(conn,sha,len(PNG)+1,'image')


def test_asset_sync_component_has_fixed_versioned_boundary_and_rejects_old_reader(storage,monkeypatch):
    from app import schema_compat
    from types import MappingProxyType
    conn,base=storage
    inspection=schema_compat.inspect_schema(conn,'content')
    assert inspection.schema_version==2 and 'content_asset_sync' in inspection.components
    original=dict(schema_compat.BASELINES)
    old={key:value for key,value in original.items() if key!='content_asset_sync'}
    monkeypatch.setattr(schema_compat,'BASELINES',MappingProxyType(old))
    with pytest.raises(schema_compat.SchemaCompatibilityError,match='unknown_migration'):
        schema_compat.inspect_schema(conn,'content')


def test_register_media_canonical_reuse_and_expected_content_guard(storage,monkeypatch):
    conn,base=storage
    media=base/'media'
    media.mkdir()
    (media/'result.png').write_bytes(PNG)
    monkeypatch.setattr(api.config,'MEDIA_DIR',media)
    monkeypatch.setattr(api.config,'ASSETS_ROOT',base/'local-assets')
    monkeypatch.setattr(api.active_account,'active_uid',lambda:'user_a')
    monkeypatch.setattr(api,'actor_id',lambda request:'user_a')
    monkeypatch.setattr(api._proxy,'proxying',lambda:False)
    app=FastAPI()
    app.include_router(api.local_router)
    cid='sha256:'+hashlib.sha256(PNG).hexdigest()
    ledger.register_local(conn,path=media/'result.png',file_path='/media/result.png',digest=hashlib.sha256(PNG).hexdigest(),size=len(PNG),media_type='image',owner_uid='user_a')
    with TestClient(app,base_url='http://127.0.0.1',client=('127.0.0.1',5000)) as client:
        body={'file_path':'/media/result.png','target_project_id':'p','expected_asset_content_id':cid}
        result=client.post('/api/local-asset-sync/register',json=body)
        assert result.status_code==200,result.text
        assert result.json()['asset_content_id']==cid
        assert client.post('/api/local-asset-sync/register',json={**body,'expected_asset_content_id':'sha256:'+'0'*64}).status_code==409
        server=upload(conn,base,prep(conn))
        copied=client.post('/api/local-asset-sync/register',json={'file_path':server['file_path'],'target_project_id':'q','expected_asset_content_id':cid})
        assert copied.status_code==200,copied.text
        assert copied.json()['target_project_id']=='q' and copied.json()['asset_content_id']==cid
        assert client.post('/api/local-asset-sync/register',json={'file_path':'https://example.invalid/arbitrary.png'}).status_code==400
        assert client.post('/api/local-asset-sync/register',json={'file_path':'/media/../secret.png'}).status_code==404


def test_register_account_switch_keeps_admitted_owner_and_account(storage,monkeypatch):
    from starlette.requests import Request
    from app import active_account
    conn,base=storage
    media=base/'media'
    media.mkdir()
    (media/'result.png').write_bytes(PNG)
    monkeypatch.setattr(api.config,'MEDIA_DIR',media)
    monkeypatch.setattr(api.config,'ASSETS_ROOT',base/'local-assets')
    monkeypatch.setattr(active_account,'_POINTER',base/'active.json')
    monkeypatch.setattr(active_account,'_cache',[False,None])
    active_account.set_active('a@example.invalid','user_a')
    ledger.register_local(conn,path=media/'result.png',file_path='/media/result.png',digest=hashlib.sha256(PNG).hexdigest(),size=len(PNG),media_type='image',owner_uid='user_a',account_key='a@example.invalid')
    original=api._snapshot_registration
    def switched(body,request,path):
        active_account.set_active('b@example.invalid','user_b')
        return original(body,request,path)
    monkeypatch.setattr(api,'_snapshot_registration',switched)
    request=Request({'type':'http','method':'POST','path':'/','headers':[(b'x-mvhub-expect-account',b'acct:a@example.invalid')],'client':('127.0.0.1',5000)})
    result=api.local_register(api.RegisterIn(file_path='/media/result.png',target_project_id='p'),request)
    row=conn.execute('SELECT owner_uid,account_key FROM asset_sync_outbox').fetchone()
    assert result['sync_state']=='queued' and tuple(row)==('user_a','a@example.invalid')
    assert active_account.capture_account_pin()==('b@example.invalid','user_b')


def test_same_content_with_conflicting_extensions_has_one_server_file(storage):
    conn,base=storage
    jpg_named=prep(conn,filename='wrong.jpg')
    png_named=prep(conn,filename='correct.png')
    one=upload(conn,base,jpg_named)
    two=upload(conn,base,png_named)
    assert one['location_id']==two['location_id']
    assert len(list((base/'assets'/'imp_cap'/'제이').glob('*')))==1


def test_root_change_requeues_with_cas_receipt_and_remote_resolve_proof(storage,monkeypatch):
    conn,base=storage
    source=base/'local.png'
    source.write_bytes(PNG)
    monkeypatch.setattr(sync.active_account,'active_uid',lambda:'user_a')
    monkeypatch.setattr(sync.active_account,'account_key',lambda:'')
    monkeypatch.setattr(sync.shared_connection,'base_url',lambda:'http://sync.invalid')
    monkeypatch.setattr(sync.shared_connection,'token',lambda:'test-only-token')
    monkeypatch.setattr(api,'actor_id',lambda request:'user_a')
    monkeypatch.setattr(api,'require_project_role',lambda *args,**kw:None)
    sync.register_local(source,'asset:captures|one.png',hashlib.sha256(PNG).hexdigest(),len(PNG),'image','user_a','p')
    def call(server,token,path,body):
        with db.get_connection() as connection:
            return sync.prepare(connection,owner_uid='user_a',display_name='제이',project_id=body['project_id'],digest=body['sha256'],size=body['bytes'],media_type=body['media_type'],original_name=body['original_name'])
    def transfer(server,token,ticket,row):
        with db.get_connection() as connection:
            return sync.accept_upload(connection,ticket['token'],'user_a',Path(row['path']),row['sha256'],row['bytes'])
    monkeypatch.setattr(sync,'_json_call',call)
    monkeypatch.setattr(sync,'_upload',transfer)
    assert sync.process_one()
    first=ledger.status_rows(conn,'user_a')[0]
    conn.execute("UPDATE project SET asset_root_path=? WHERE id='p'",(str(base/'new-root'),))
    conn.execute("UPDATE asset_sync_outbox SET state='queued',storage_id='',root_revision='',next_retry_at=0")
    assert ledger.status_rows(conn,'user_a')[0]['state']=='queued'  # old receipt cannot override row state
    assert sync.process_one()
    second=ledger.status_rows(conn,'user_a')[0]
    assert second['state']=='ready' and second['location_id']!=first['location_id']
    assert second['supersedes_location_id']==first['location_id']
    assert second['storage_id']==first['storage_id'] and second['root_revision']!=first['root_revision']
    body=api.ResolveIn(project_id='p',asset_content_ids=[first['asset_content_id']],previous_location_ids={first['asset_content_id']:[first['location_id'],'f'*32]})
    rows=api.resolve(body,__import__('types').SimpleNamespace())['items']
    assert any(row.get('supersedes_location_id')==first['location_id'] for row in rows)
    assert not any(row.get('supersedes_location_id')=='f'*32 for row in rows)


def test_local_proxy_rejects_remote_file_reader_and_upload_relay(storage,monkeypatch):
    conn,base=storage
    monkeypatch.setattr(api._proxy,'proxying',lambda:True)
    app=FastAPI()
    app.include_router(api.router)
    with TestClient(app,base_url='http://127.0.0.1',client=('198.51.100.2',5000)) as client:
        assert client.get('/api/asset-sync/files/'+'a'*32).status_code==403
        assert client.put('/api/asset-sync/uploads/'+'a'*32,content=PNG).status_code==404


def test_unknown_upload_result_keeps_server_context_pin(storage,monkeypatch):
    conn,base=storage
    source=base/'local.png'
    source.write_bytes(PNG)
    monkeypatch.setattr(sync.active_account,'active_uid',lambda:'user_a')
    monkeypatch.setattr(sync.active_account,'account_key',lambda:'')
    monkeypatch.setattr(sync.shared_connection,'base_url',lambda:'http://sync.invalid')
    monkeypatch.setattr(sync.shared_connection,'token',lambda:'test-only-token')
    sync.register_local(source,'asset:captures|one.png',hashlib.sha256(PNG).hexdigest(),len(PNG),'image','user_a','p')
    def prepare_call(server,token,path,body):
        with db.get_connection() as connection:
            return sync.prepare(connection,owner_uid='user_a',display_name='제이',project_id=body['project_id'],digest=body['sha256'],size=body['bytes'],media_type=body['media_type'],original_name=body['original_name'])
    monkeypatch.setattr(sync,'_json_call',prepare_call)
    monkeypatch.setattr(sync,'_upload',lambda *args:(_ for _ in ()).throw(OSError('unknown result')))
    assert sync.process_one()
    first=ledger.status_rows(conn,'user_a')[0]
    assert first['state']=='retrying' and first['storage_id'] and first['root_revision']
    conn.execute("UPDATE project SET asset_root_path=? WHERE id='p'",(str(base/'new-root'),))
    conn.execute('UPDATE asset_sync_outbox SET next_retry_at=0')
    assert sync.process_one()
    assert ledger.status_rows(conn,'user_a')[0]['last_error_code']=='asset_context_changed'


def test_asset_root_mount_and_registry_do_not_change_render_results_root(storage,monkeypatch):
    from app.routers import assets
    from app.services import asset_registry,project_folders
    from types import SimpleNamespace
    conn,base=storage
    asset_root=str(base/'assets')
    render_root=str(base/'production')
    project={'id':'p','name':'Project','asset_root_path':asset_root,'render_root_path':render_root}
    monkeypatch.setattr(assets,'MANAGE_ENABLED',True)
    monkeypatch.setattr(assets.repo,'list_projects',lambda **kwargs:{'projects':[project]})
    monkeypatch.setattr(asset_registry.repo,'get_project',lambda pid:project)
    monkeypatch.setattr(project_folders,'effective_root_path',lambda pid:render_root)
    assert assets._auto_project_mounts(SimpleNamespace())[0]['path']==asset_root
    assert asset_registry.pm_projects()==[('p','Project',asset_root)]
    assert asset_registry.AssetRegistryController()._results_root('p',asset_root)==render_root
    from app.services.asset_registry_helper import HelperController
    helper=HelperController()
    helper._lease={'unc':asset_root,'results_unc':render_root}
    assert helper._results_root('p',asset_root)==render_root


def test_asset_root_context_uses_same_mapping_proof_for_reads_and_writes(storage,monkeypatch):
    from app.services.path_safety import asset_storage_context
    conn,base=storage
    monkeypatch.setattr(sync.config,'ASSET_REGISTRY_DRIVES',r'Q:=\\example.invalid\assets')
    conn.execute("UPDATE project SET asset_root_path=? WHERE id='p'",(r'Q:\project',))
    expected=asset_storage_context(r'Q:\project',r'Q:=\\example.invalid\assets')
    actual=sync.root_context(conn,'p')
    assert actual[:2]==expected
    assert asset_storage_context('../relative') is None


def test_registry_discards_scan_from_previous_explicit_asset_root(storage):
    from app.services import asset_registry
    from app.repo import asset_registry as registry
    conn,base=storage
    scan=registry.RegistryScan(True,[registry.RegistryFile('old.png',len(PNG),1,hashlib.sha256(PNG).hexdigest(),'ok')])
    result=asset_registry.AssetRegistryController()._apply('p','Project',scan,{'root':str(base/'old-root'),'state':'ok','complete':True,'clean':True})
    assert result=={'discarded_root_changed':1}
    assert not conn.execute("SELECT 1 FROM asset_registry WHERE project_id='p'").fetchone()


def test_register_rejects_adopting_another_accounts_unshared_media(storage,monkeypatch):
    conn,base=storage
    media=base/'media'
    media.mkdir()
    path=media/'private.png'
    path.write_bytes(PNG)
    ledger.register_local(conn,path=path,file_path='/media/private.png',digest=hashlib.sha256(PNG).hexdigest(),size=len(PNG),media_type='image',owner_uid='user_a')
    monkeypatch.setattr(api.config,'MEDIA_DIR',media)
    monkeypatch.setattr(api.config,'ASSETS_ROOT',base/'local-assets')
    monkeypatch.setattr(api.active_account,'active_uid',lambda:'user_b')
    monkeypatch.setattr(api,'actor_id',lambda request:'user_b')
    app=FastAPI()
    app.include_router(api.local_router)
    with TestClient(app,base_url='http://127.0.0.1',client=('127.0.0.1',5000)) as client:
        result=client.post('/api/local-asset-sync/register',json={'file_path':'/media/private.png','target_project_id':'p'})
        assert result.status_code==403
    assert ledger.status_rows(conn,'user_b')==[]


def test_archived_project_keeps_authorized_history_reads_and_blocks_new_writes(storage,monkeypatch):
    from app import deps
    from app.repo.asset_locations import verified_locations
    conn,base=storage
    result=upload(conn,base,prep(conn))
    pending=prep(conn,digest=hashlib.sha256(PNG+b'new').hexdigest(),size=len(PNG)+3)
    conn.execute("UPDATE project SET archived=1 WHERE id='p'")
    conn.execute("INSERT INTO project_member VALUES('p','user_a','creator')")
    monkeypatch.setattr(deps,'AUTH_ENABLED',True)
    monkeypatch.setattr(api._proxy,'proxying',lambda:False)
    app=FastAPI()
    actor=['user_a']
    @app.middleware('http')
    async def account(request,call_next):
        request.state.account={'creator_uid':actor[0],'global_role':'member'}
        return await call_next(request)
    app.include_router(api.router)
    with TestClient(app) as client:
        assert client.get('/api/asset-sync/files/'+result['location_id']).content==PNG
        assert client.get('/api/asset-sync/locations/'+result['location_id']).status_code==200
        body={'project_id':'p','asset_content_ids':[result['asset_content_id']]}
        assert client.post('/api/asset-sync/resolve',json=body).json()['items'][0]['location_id']==result['location_id']
        create={'project_id':'p','sha256':hashlib.sha256(PNG).hexdigest(),'bytes':len(PNG),'media_type':'image','original_name':'capture.png'}
        assert client.post('/api/asset-sync/prepare',json=create).status_code==409
        assert client.put('/api/asset-sync/uploads/'+pending['token'],content=PNG+b'new').status_code==409
        actor[0]='non_member'
        assert client.get('/api/asset-sync/files/'+result['location_id']).status_code==403
        assert client.post('/api/asset-sync/resolve',json=body).status_code==403
    key=('user_a','p',result['asset_content_id'])
    assert verified_locations(conn,[key])[key]['location']['location_id']==result['location_id']

"""Authenticated project asset storage and account-local synchronization APIs."""
from __future__ import annotations

import json
import re
import hashlib
import uuid
from pathlib import Path
from typing import Literal
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Request, UploadFile, File, Form
from fastapi.responses import FileResponse
from starlette.background import BackgroundTask
from pydantic import BaseModel, Field

from .. import active_account, config, db, rbac
from ..deps import actor_id, require_project_role
from ..repo import asset_sync as ledger
from ..services import asset_io, asset_sync as sync, asset_sync_cache
from ..services import shared_connection
from ..services.async_tools import to_thread_non_abandon
from ..services.media_types import asset_content_type
from ..services.path_safety import safe_join
from ..services.request_guards import require_local_machine_request
from . import _proxy


router = APIRouter(prefix='/api/asset-sync',tags=['asset-sync'])


def local_guard(request: Request):
    require_local_machine_request(request,'로컬 Asset 보관 상태는 이 PC에서만 조회할 수 있습니다')


local_router = APIRouter(prefix='/api/local-asset-sync',tags=['local-asset-sync'],dependencies=[Depends(local_guard)])


class PrepareIn(BaseModel):
    project_id: str = Field(min_length=1,max_length=100)
    sha256: str = Field(pattern='^[a-f0-9]{64}$')
    bytes: int = Field(gt=0,le=asset_io.UPLOAD_MAX_BYTES)
    media_type: Literal['image','video','audio']
    original_name: str = Field(min_length=1,max_length=255)


class ResolveIn(BaseModel):
    project_id: str = Field(min_length=1,max_length=100)
    asset_content_ids: list[Annotated[str,Field(pattern='^sha256:[a-f0-9]{64}$')]] = Field(default_factory=list,max_length=500)
    previous_location_ids: dict[str,list[Annotated[str,Field(pattern='^[a-f0-9]{32}$')]]] = Field(default_factory=dict,max_length=500)


class VerifyIn(BaseModel):
    location_id: str = Field(pattern='^[a-f0-9]{32}$')
    asset_content_id: str = Field(pattern='^sha256:[a-f0-9]{64}$')
    project_id: str = Field(min_length=1, max_length=100)
    storage_id: str = Field(min_length=1, max_length=100)
    root_revision: str = Field(min_length=1, max_length=100)


class RegisterIn(BaseModel):
    file_path: str = Field(min_length=1,max_length=2048)
    target_project_id: str | None = Field(default=None,max_length=100)
    target_workspace_id: str | None = Field(default=None,max_length=100)
    expected_asset_content_id: str | None = Field(default=None,pattern='^sha256:[a-f0-9]{64}$')


def _local_owner(request):
    account=getattr(getattr(request,'state',None),'account',None)
    return actor_id(request) if account else (active_account.active_uid() or actor_id(request))


@local_router.get('/generations/{gen_id}/bundle')
def generation_bundle(gen_id: str, request: Request, allow_incomplete: bool = False):
    from ..services import asset_bundle
    from .library import get_generation
    with db.pinned_share_operation(capture_local_operation(request)):
        connection = (_proxy.base_url(), _proxy.token())
        with _proxy.pinned_connection(connection):
            generation = get_generation(gen_id, request)
            def source(record, cid):
                with db.get_connection() as conn:
                    rows = conn.execute(
                        "SELECT path FROM asset_location WHERE kind='local' AND state='ready' "
                        "AND owner_uid=? AND asset_content_id=?",
                        (_local_owner(request), cid)).fetchall()
                for row in rows:
                    path = Path(row['path'])
                    if path.is_file() and asset_io.sha256_file(path) == cid[7:]:
                        return path
                try:
                    path, _ = _registration_source(record.get('file_path') or '', request)
                    return path
                except HTTPException as exc:
                    if exc.status_code in (401, 403):
                        raise
                    raise ValueError('asset_bytes_unavailable') from exc
            try:
                path = asset_bundle.build_bundle(generation, source, allow_incomplete=allow_incomplete)
            except asset_bundle.IncompleteBundle as exc:
                raise HTTPException(status_code=409, detail={
                    'code': 'asset_bundle_incomplete', 'missing': exc.missing}) from exc
            except ValueError as exc:
                raise HTTPException(status_code=400, detail=str(exc)) from exc
            try:
                db.require_share_operation_epoch()
                if (shared_connection.base_url(), shared_connection.token()) != connection:
                    raise HTTPException(status_code=409, detail='asset_connection_changed')
            except BaseException:
                path.unlink(missing_ok=True)
                raise
            return FileResponse(path, media_type='application/zip', filename='generation-bundle.zip',
                headers={'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff'},
                background=BackgroundTask(path.unlink, missing_ok=True))


capture_local_operation=sync.capture_local_operation


def _translate(exc):
    raise HTTPException(status_code=409,detail=str(exc)) from exc


@router.post('/verify')
def verify(body: VerifyIn, request: Request):
    require_project_role(request, body.project_id, *rbac.PROJECT_ROLES, read_only=True)
    owner = actor_id(request)
    result = {**body.model_dump(), 'owner_uid': owner, 'state': 'unknown'}
    with db.get_connection() as conn:
        row = conn.execute(
            "SELECT * FROM asset_location WHERE location_id=? AND owner_uid=? AND project_id=? "
            "AND asset_content_id=? AND storage_id=? AND root_revision=? AND kind='server'",
            (body.location_id, owner, body.project_id, body.asset_content_id, body.storage_id, body.root_revision)).fetchone()
    if row is None:
        return result
    try:
        sync.checked_server_location(row, force_hash=True)
        result['state'] = 'ready'
    except sync.SyncError as exc:
        result['state'] = {
            'asset_server_copy_missing': 'missing', 'asset_server_copy_changed': 'changed',
            'asset_storage_unavailable': 'unavailable', 'asset_deleted': 'deleted',
            'asset_context_changed': 'context_changed',
        }.get(str(exc), 'unavailable')
    return result


@router.post('/prepare')
def prepare(body: PrepareIn,request: Request):
    require_project_role(request,body.project_id,*rbac.PROJECT_ROLES)
    account = getattr(request.state,'account',None) or {}
    try:
        return sync.prepare(owner_uid=actor_id(request),display_name=account.get('name') or '',
            project_id=body.project_id,digest=body.sha256,size=body.bytes,media_type=body.media_type,original_name=body.original_name)
    except sync.SyncError as exc:
        _translate(exc)


@router.put('/uploads/{token}')
async def upload(token: str,request: Request):
    if await to_thread_non_abandon(_proxy.proxying):
        # The durable worker streams directly to its pinned server; the generic proxy buffers bodies.
        raise HTTPException(status_code=404,detail='asset_upload_server_only')
    if len(token) != 32:
        raise HTTPException(status_code=404,detail='asset_upload_expired')
    owner = actor_id(request)
    def ticket_info():
        with db.get_connection() as conn:
            row = conn.execute('SELECT * FROM asset_upload_token WHERE token=? AND owner_uid=?',(token,owner)).fetchone()
        if row:
            require_project_role(request,row['project_id'],*rbac.PROJECT_ROLES)
        return dict(row) if row else None
    ticket = await to_thread_non_abandon(ticket_info)
    if not ticket:
        raise HTTPException(status_code=404,detail='asset_upload_expired')
    length = request.headers.get('content-length')
    if length is not None and (not length.isdecimal() or int(length) != ticket['bytes']):
        raise HTTPException(status_code=400,detail='asset_size_mismatch')
    class Body:
        def __init__(self): self.iterator = request.stream().__aiter__()
        async def read(self,size=-1):
            try: return await self.iterator.__anext__()
            except StopAsyncIteration: return b''
    folder = config.DATA_DIR / 'asset-upload-staging'
    await to_thread_non_abandon(folder.mkdir,parents=True,exist_ok=True)
    try:
        tmp,size,digest = await asset_io.stream_upload_tmp(Body(),folder,max_bytes=ticket['bytes'])
    except asset_io.UploadTooLarge as exc:
        raise HTTPException(status_code=413,detail='asset_size_mismatch') from exc
    try:
        return await to_thread_non_abandon(sync.accept_upload,token,owner,tmp,digest,size)
    except (sync.SyncError, db.DatabaseEpochChanged) as exc:
        _translate(exc)
    finally:
        await to_thread_non_abandon(tmp.unlink,missing_ok=True)


@router.post('/resolve')
def resolve(body: ResolveIn,request: Request):
    if sum(map(len,body.previous_location_ids.values()))>1000:
        raise HTTPException(status_code=413,detail='too_many_asset_locations')
    require_project_role(request,body.project_id,*rbac.PROJECT_ROLES,read_only=True)
    items=[]
    # Owner scoped lookup avoids exposing the existence of another user's content.
    for cid in set(body.asset_content_ids):
        with db.get_connection() as conn:
            rows=conn.execute("SELECT * FROM asset_location WHERE asset_content_id=? AND project_id=? AND owner_uid=? AND kind='server'",(cid,body.project_id,actor_id(request))).fetchall()
        for row in rows:
            try:
                sync.checked_server_location(row)
                receipt=sync._receipt(row)
                items.append(receipt)
                with db.get_connection() as conn:
                    for previous_id in set(body.previous_location_ids.get(cid,[])):
                        previous=conn.execute("SELECT * FROM asset_location WHERE location_id=? AND owner_uid=? AND project_id=? AND asset_content_id=? AND storage_id=? AND kind='server'",(ledger.resolve_location_id(conn,previous_id),actor_id(request),body.project_id,cid,row['storage_id'])).fetchone()
                        if previous and previous_id!=receipt['location_id']:
                            items.append({**receipt,'supersedes_location_id':previous_id})
            except sync.SyncError:
                continue
    return {'items':items}


def _response(path, name=None):
    content_type = asset_content_type(path.name)
    if content_type is None:
        raise HTTPException(status_code=415,detail='unsupported_asset_type')
    return FileResponse(path,media_type=content_type,filename=name or path.name,content_disposition_type='inline',
        headers={'X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'none'; sandbox",'Cache-Control':'private, no-cache'})


def _remote_cached_file(location_id,request):
    connection=(_proxy.base_url(),_proxy.token())
    owner=_local_owner(request)
    account_key=active_account.account_key() or ''
    def check_context():
        db.require_share_operation_epoch()
        if ((shared_connection.base_url(),shared_connection.token()) != connection
                or _local_owner(request) != owner or (active_account.account_key() or '') != account_key):
            raise HTTPException(status_code=409,detail='asset_connection_changed')
    check_context()
    # The server repeats its project ACL check even when this PC already has the bytes.
    info=_proxy.proxy_json('GET','/api/asset-sync/locations/'+location_id)
    path=asset_sync_cache.cached_file(info,account_key=account_key,owner_uid=owner,
        server_origin=connection[0],download=_proxy.stream_download,check_context=check_context)
    return path,info['name']


@router.get('/files/{location_id}')
def get_file(location_id: str,request: Request):
    if not re.fullmatch('[a-f0-9]{32}',location_id):
        raise HTTPException(status_code=404,detail='asset_not_found')
    if _proxy.proxying():
        local_guard(request)
        with db.pinned_share_operation(capture_local_operation(request)):
            with _proxy.pinned_connection((_proxy.base_url(),_proxy.token())):
                # The original owner retains its already verified local copy, including offline use.
                with db.get_connection() as conn:
                    rows=conn.execute("SELECT o.receipt_json,l.path,b.sha256,b.bytes,l.original_name FROM asset_sync_outbox o JOIN asset_location l ON l.location_id=o.local_location_id JOIN asset_blob b ON b.asset_content_id=o.asset_content_id WHERE o.owner_uid=? AND o.receipt_json IS NOT NULL AND o.server_origin=?",(_local_owner(request),_proxy.base_url())).fetchall()
                for row in rows:
                    receipt=json.loads(row['receipt_json'])
                    if location_id in (receipt.get('location_id'),receipt.get('supersedes_location_id')):
                        path=Path(row['path'])
                        if path.is_file() and path.stat().st_size==row['bytes'] and asset_io.sha256_file(path)==row['sha256']:
                            return _response(path,row['original_name'])
                path,name=_remote_cached_file(location_id,request)
                return _response(path,name)
    with db.get_connection() as conn:
        location_id=ledger.resolve_location_id(conn,location_id)
        row=conn.execute("SELECT * FROM asset_location WHERE location_id=? AND kind='server'",(location_id,)).fetchone()
        if not row:
            raise HTTPException(status_code=404,detail='asset_not_found')
        require_project_role(request,row['project_id'],*rbac.PROJECT_ROLES,read_only=True)
    try:
        path=sync.checked_server_location(row)
    except sync.SyncError as exc:
        _translate(exc)
    return _response(path,row['original_name'])


@router.get('/locations/{location_id}')
def location_info(location_id: str,request: Request):
    if not re.fullmatch('[a-f0-9]{32}',location_id):
        raise HTTPException(status_code=404,detail='asset_not_found')
    with db.get_connection() as conn:
        location_id=ledger.resolve_location_id(conn,location_id)
        row=conn.execute("SELECT l.*,b.sha256,b.bytes FROM asset_location l JOIN asset_blob b USING(asset_content_id) WHERE location_id=? AND kind='server'",(location_id,)).fetchone()
        if not row:
            raise HTTPException(status_code=404,detail='asset_not_found')
        require_project_role(request,row['project_id'],*rbac.PROJECT_ROLES,read_only=True)
    try: sync.checked_server_location(row)
    except sync.SyncError as exc: _translate(exc)
    return {**sync._receipt(row),'sha256':row['sha256'],'bytes':row['bytes'],'name':Path(row['path']).name}


@local_router.get('/receipts')
@local_router.get('/status')
def local_status(request: Request,project_id: str | None=None):
    from ..services import asset_destination
    with db.get_connection() as conn:
        return {'items':ledger.status_rows(conn,_local_owner(request),project_id),
                'destinations': asset_destination.status(conn, _local_owner(request))}


@local_router.post('/resolve')
def local_resolve(body: ResolveIn,request: Request):
    data=local_status(request,body.project_id)
    data['items']=[r for r in data['items'] if r['asset_content_id'] in body.asset_content_ids]
    ready={r['asset_content_id'] for r in data['items'] if r['state']=='ready' and r.get('server_origin')==_proxy.base_url()}
    missing=[cid for cid in body.asset_content_ids if cid not in ready or body.previous_location_ids.get(cid)]
    if missing and _proxy.proxying():
        remote=_proxy.proxy_json('POST','/api/asset-sync/resolve',body={'project_id':body.project_id,'asset_content_ids':missing,'previous_location_ids':{cid:body.previous_location_ids[cid] for cid in missing if cid in body.previous_location_ids}})
        for row in remote.get('items') or []:
            if row.get('asset_content_id') in missing and row.get('project_id')==body.project_id:
                data['items'].append({**row,'server_origin':_proxy.base_url(),'server_file_path':row.get('file_path'),'target_project_id':body.project_id})
    return data


@local_router.post('/register')
def local_register(body: RegisterIn,request: Request):
    with db.pinned_share_operation(capture_local_operation(request)):
        connection=(_proxy.base_url(),_proxy.token())
        with _proxy.pinned_connection(connection):
            path,cleanup=_registration_source(body.file_path,request)
            try:
                result=_snapshot_registration(body,request,path)
                if (shared_connection.base_url(),shared_connection.token()) != connection:
                    raise HTTPException(status_code=409,detail='asset_connection_changed')
                return result
            finally:
                if cleanup:
                    path.unlink(missing_ok=True)


def _registration_source(file_path,request):
    from . import assets
    owner=_local_owner(request)
    if file_path.startswith('asset-sync:'):
        location_id=file_path[len('asset-sync:'):]
        if not re.fullmatch('[a-f0-9]{32}',location_id):
            raise HTTPException(status_code=400,detail='invalid_asset_location')
        with db.get_connection() as conn:
            rows=conn.execute("SELECT o.receipt_json,l.path,b.sha256,b.bytes FROM asset_sync_outbox o JOIN asset_location l ON l.location_id=o.local_location_id JOIN asset_blob b ON b.asset_content_id=o.asset_content_id WHERE o.owner_uid=? AND o.receipt_json IS NOT NULL AND o.server_origin=?",(owner,_proxy.base_url())).fetchall()
        for row in rows:
            receipt=json.loads(row['receipt_json'])
            if location_id in (receipt.get('location_id'),receipt.get('supersedes_location_id')):
                path=Path(row['path'])
                if path.is_file() and path.stat().st_size==row['bytes'] and asset_io.sha256_file(path)==row['sha256']:
                    return path,False
        if not _proxy.proxying():
            with db.get_connection() as conn:
                canonical=ledger.resolve_location_id(conn,location_id)
                row=conn.execute("SELECT * FROM asset_location WHERE location_id=? AND kind='server'",(canonical,)).fetchone()
                if not row:
                    raise HTTPException(status_code=404,detail='asset_not_found')
                require_project_role(request,row['project_id'],*rbac.PROJECT_ROLES,read_only=True)
            try: return sync.checked_server_location(row),False
            except sync.SyncError as exc: _translate(exc)
        path,_=_remote_cached_file(location_id,request)
        return path,False
    if file_path.startswith('/media/'):
        path=safe_join(config.MEDIA_DIR,file_path[len('/media/'):])
        if path is not None:
            if not sync.owns_local_content(path,owner):
                raise HTTPException(status_code=403,detail='asset_local_ownership_required')
    elif file_path.startswith('/api/comfy/inputs/'):
        # Comfy source endpoints are account-scoped; use only this owner's registered snapshot.
        match=re.fullmatch(r'/api/comfy/inputs/([a-f0-9]{16})/([a-f0-9]{64}\.[a-z0-9]{1,8})',file_path)
        path=safe_join(config.MEDIA_DIR.parent/'comfy-inputs',match[1]+'/'+match[2]) if match else None
        if path is not None and not sync.owns_local_content(path,owner):
            raise HTTPException(status_code=403,detail='asset_local_ownership_required')
    elif file_path.startswith('asset:') and '|' in file_path:
        project,rel=file_path[6:].split('|',1)
        base=assets._safe_project_dir(project,request)
        path=assets._safe_project_resolve(project,base,rel) if base else None
    else:
        raise HTTPException(status_code=400,detail='asset_local_path_required')
    if path is None or not path.is_file():
        raise HTTPException(status_code=404,detail='asset_local_copy_missing')
    return path,False


def _snapshot_registration(body,request,path):
    media_type=asset_io.media_type(path.name)
    if not media_type:
        raise HTTPException(status_code=415,detail='unsupported_asset_type')
    # Pin the actual bytes into managed local storage before queueing mutable project inputs.
    dest=(config.ASSETS_ROOT/'imports').resolve()
    dest.mkdir(parents=True,exist_ok=True)
    tmp=dest/('.snapshot-'+uuid.uuid4().hex+'.part')
    digest=hashlib.sha256()
    size=0
    try:
        with path.open('rb') as source,tmp.open('xb') as output:
            for chunk in iter(lambda:source.read(1024*1024),b''):
                size+=len(chunk)
                if size>asset_io.UPLOAD_MAX_BYTES:
                    raise HTTPException(status_code=413,detail='asset_too_large')
                digest.update(chunk)
                output.write(chunk)
        if body.expected_asset_content_id and body.expected_asset_content_id!='sha256:'+digest.hexdigest():
            raise HTTPException(status_code=409,detail='asset_content_changed')
        managed_input = any(path.resolve().is_relative_to((config.ASSETS_ROOT/folder).resolve())
                            for folder in ('captures','imports'))
        if (body.file_path.startswith(('/media/','/api/comfy/inputs/')) or managed_input) and not sync.owns_local_content(
                tmp,_local_owner(request),digest=digest.hexdigest()):
            raise HTTPException(status_code=403,detail='asset_local_ownership_required')
        saved,_=asset_io.find_or_commit_media(tmp,dest,path.name,digest.hexdigest(),media_type,size)
        result=sync.register_local(saved,body.file_path,digest.hexdigest(),size,media_type,_local_owner(request),body.target_project_id,original_name=path.name)
        return result
    finally:
        tmp.unlink(missing_ok=True)


@local_router.post('/ingest')
async def local_ingest(request: Request,file: UploadFile=File(...),original_file_path: str=Form(...),
                       target_project_id: str=Form(''),target_workspace_id: str=Form('')):
    operation=await to_thread_non_abandon(capture_local_operation,request)
    with db.pinned_share_operation(operation):
        owner=_local_owner(request)
        return await _local_ingest(request,file,original_file_path,target_project_id,target_workspace_id,owner)


async def _local_ingest(request,file,original_file_path,target_project_id,target_workspace_id,owner):
    if len(original_file_path)>2048 or len(target_project_id)>100 or len(target_workspace_id)>100:
        raise HTTPException(status_code=400,detail='invalid_asset_context')
    name=Path((file.filename or '').replace('\\','/')).name
    media_type=asset_io.media_type(name)
    if not media_type:
        raise HTTPException(status_code=415,detail='unsupported_asset_type')
    dest=(config.ASSETS_ROOT/'imports').resolve()
    await to_thread_non_abandon(dest.mkdir,parents=True,exist_ok=True)
    try:
        tmp,size,digest=await asset_io.stream_upload_tmp(file,dest)
    except asset_io.UploadTooLarge as exc:
        raise HTTPException(status_code=413,detail='asset_too_large') from exc
    try:
        if size<=0:
            raise HTTPException(status_code=400,detail='asset_empty')
        def commit_and_register():
            saved,_=asset_io.find_or_commit_media(tmp,dest,name,digest,media_type,size)
            return sync.register_local(saved,original_file_path,digest,size,media_type,
                owner,target_project_id or None,original_name=name)
        return await to_thread_non_abandon(commit_and_register)
    finally:
        await to_thread_non_abandon(tmp.unlink,missing_ok=True)


@local_router.post('/retry')
def retry(request: Request):
    with db.get_connection() as conn:
        conn.execute("UPDATE asset_sync_outbox SET state='queued',next_retry_at=0 WHERE owner_uid=? AND state IN ('retrying','recovery_required')",(_local_owner(request),))
    return local_status(request)

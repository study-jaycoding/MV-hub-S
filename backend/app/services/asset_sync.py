"""Immutable project storage and a resumable local-first transfer worker."""
from __future__ import annotations

import asyncio
import hashlib
import json
import os
import re
import sqlite3
import time
import unicodedata
import urllib.request
import uuid
from contextlib import suppress
from pathlib import Path

from .. import active_account, config, db
from ..deps import expected_account_differs
from ..emailnorm import norm_email
from ..repo import asset_sync as ledger
from . import asset_io, asset_sync_cache, shared_connection
from .async_tools import to_thread_non_abandon
from .media_types import ASSET_CONTENT_TYPES, asset_media_type
from .path_safety import safe_join, asset_storage_context


class SyncError(ValueError):
    pass


def capture_local_operation(request):
    from fastapi import HTTPException
    operation=db.capture_share_operation()
    account=getattr(getattr(request,'state',None),'account',None) or {}
    key=operation[0][0]
    if key and account.get('email') and norm_email(key)!=norm_email(account['email']):
        raise HTTPException(status_code=409,detail='asset_account_changed')
    if expected_account_differs(request,key or account.get('email') or 'local'):
        raise HTTPException(status_code=409,detail='asset_account_changed')
    return operation


def root_context(conn, project_id, *, allow_archived=False):
    row = conn.execute('SELECT asset_root_path,archived FROM project WHERE id=?', (project_id,)).fetchone()
    if not row or (row['archived'] and not allow_archived):
        raise SyncError('project_unavailable')
    context=asset_storage_context(row['asset_root_path'],config.ASSET_REGISTRY_DRIVES)
    if context is None:
        raise SyncError('asset_root_required')
    root,revision=context
    return root,revision,ledger.storage_id(conn)


def _folder(conn, project_id, revision, owner_uid, display_name):
    row = conn.execute('SELECT folder_label FROM asset_owner_folder WHERE project_id=? AND root_revision=? AND owner_uid=?', (project_id,revision,owner_uid)).fetchone()
    if row:
        return row[0]
    label = re.sub(r'[<>:"/\\|?*\x00-\x1f]', '_', unicodedata.normalize('NFC',display_name or '')).strip().rstrip('. ')[:80]
    if not label or re.fullmatch(r'(?i:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?', label):
        label = 'user_' + hashlib.sha256(owner_uid.encode()).hexdigest()[:10]
    candidate = label
    if conn.execute('SELECT 1 FROM asset_owner_folder WHERE project_id=? AND root_revision=? AND folder_cf=?', (project_id,revision,candidate.casefold())).fetchone():
        candidate = label + '_' + hashlib.sha256(owner_uid.encode()).hexdigest()[:12]
    conn.execute('INSERT INTO asset_owner_folder VALUES(?,?,?,?,?)', (project_id,revision,owner_uid,candidate,candidate.casefold()))
    return candidate


def _file_path(root, relative):
    if Path(relative).is_absolute() or '..' in relative.replace('\\','/').split('/'):
        raise SyncError('unsafe_asset_path')
    path = safe_join(root, relative)
    if path is None:
        raise SyncError('unsafe_asset_path')
    return path


def _receipt(row):
    return {k:row[k] for k in ('asset_content_id','location_id','owner_uid','project_id','storage_id','root_revision','registry_asset_id')} | {
        'state':'ready','file_path':'asset-sync:'+row['location_id'],
        'url':'/api/asset-sync/files/'+row['location_id']}


def checked_server_location(row, *, force_hash=False):
    if row['state'] == 'deleted':
        raise SyncError('asset_deleted')
    with db.get_connection() as conn:
        root, revision, sid = root_context(conn,row['project_id'],allow_archived=True)
        if row['root_revision'] != revision or row['storage_id'] != sid:
            raise SyncError('asset_context_changed')
        path = _file_path(root,row['path'])
        blob = conn.execute('SELECT sha256,bytes FROM asset_blob WHERE asset_content_id=?',(row['asset_content_id'],)).fetchone()
    try:
        size = path.stat().st_size
    except FileNotFoundError:
        # Missing SMB roots also raise FileNotFoundError. Only a complete parent listing proves absence.
        parent = root
        try:
            for part in Path(row['path']).parts:
                with os.scandir(parent) as entries:
                    found = any(entry.name.casefold() == part.casefold() for entry in entries)
                if not found:
                    raise SyncError('asset_server_copy_missing')
                parent = parent / part
        except OSError as exc:
            raise SyncError('asset_storage_unavailable') from exc
        raise SyncError('asset_storage_unavailable')
    except OSError as exc:
        raise SyncError('asset_storage_unavailable') from exc
    try:
        digest = asset_sync_cache.file_digest(path, force=force_hash)
    except OSError as exc:
        raise SyncError('asset_storage_unavailable') from exc
    if digest is None:
        raise SyncError('asset_storage_unavailable')
    if size != blob['bytes'] or digest != blob['sha256']:
        raise SyncError('asset_server_copy_changed')
    return path


def prepare(*, owner_uid, display_name, project_id, digest, size, media_type, original_name):
    cid = 'sha256:' + digest
    with db.get_connection() as conn:
        root, revision, sid = root_context(conn,project_id)
        row = conn.execute("SELECT * FROM asset_location WHERE asset_content_id=? AND owner_uid=? AND project_id=? AND root_revision=? AND storage_id=? AND kind='server'",(cid,owner_uid,project_id,revision,sid)).fetchone()
    if row:
        try:
            checked_server_location(row)
            return _receipt(row)
        except SyncError as exc:
            if str(exc) != 'asset_server_copy_missing':
                raise
    ext = Path(original_name).suffix.lower()
    if ext not in ASSET_CONTENT_TYPES or asset_media_type(original_name,include_audio=True) != media_type:
        raise SyncError('unsupported_asset_type')
    with db.get_connection() as conn:
        conn.execute('BEGIN IMMEDIATE')
        if root_context(conn,project_id) != (root, revision, sid):
            raise SyncError('asset_context_changed')
        folder = _folder(conn,project_id,revision,owner_uid,display_name)
        relative = row['path'] if row else f'imp_cap/{folder}/{digest}{ext}'
        token = uuid.uuid4().hex
        conn.execute('DELETE FROM asset_upload_token WHERE expires_at<?', (time.time(),))
        conn.execute('INSERT INTO asset_upload_token VALUES(?,?,?,?,?,?,?,?,?,?,?)', (token,cid,owner_uid,project_id,sid,revision,relative,Path(original_name).name,size,media_type,time.time()+600))
    return {'state':'upload_required','token':token,'asset_content_id':cid,'owner_uid':owner_uid,'project_id':project_id,'storage_id':sid,'root_revision':revision}


def media_header_matches(path: Path, extension: str) -> bool:
    with path.open('rb') as handle:
        head = handle.read(32)
    if extension == '.png': return head.startswith(b'\x89PNG\r\n\x1a\n')
    if extension in ('.jpg','.jpeg'): return head.startswith(b'\xff\xd8\xff')
    if extension == '.gif': return head.startswith((b'GIF87a',b'GIF89a'))
    if extension == '.bmp': return head.startswith(b'BM')
    if extension == '.webp': return head[:4] == b'RIFF' and head[8:12] == b'WEBP'
    if extension in ('.mp4','.mov','.m4a'): return head[4:8] in (b'ftyp',b'moov',b'wide',b'mdat')
    if extension in ('.webm','.mkv'): return head.startswith(b'\x1aE\xdf\xa3')
    if extension in ('.avi','.wav'): return head[:4] == b'RIFF' and head[8:12] == (b'AVI ' if extension == '.avi' else b'WAVE')
    if extension == '.ogg': return head.startswith(b'OggS')
    if extension == '.flac': return head.startswith(b'fLaC')
    if extension == '.mp3': return head.startswith(b'ID3') or (len(head)>1 and head[0] == 255 and head[1]&224 == 224)
    if extension == '.aac': return len(head)>1 and head[0] == 255 and head[1]&246 == 240
    return False


def canonical_extension(path):
    # One byte sequence has one server name, even when two clients supply different extensions.
    for extension in ('.png','.jpg','.gif','.bmp','.webp','.avi','.wav','.ogg','.flac','.aac','.mp3'):
        if media_header_matches(path,extension):
            return extension
    if media_header_matches(path,'.webm'):
        with path.open('rb') as handle:
            return '.webm' if b'webm' in handle.read(4096) else '.mkv'
    if media_header_matches(path,'.mp4'):
        with path.open('rb') as handle:
            brand=handle.read(16)[8:12]
        return '.m4a' if brand in (b'M4A ',b'M4B ') else ('.mov' if brand==b'qt  ' else '.mp4')
    raise SyncError('asset_media_mismatch')


def accept_upload(token, owner_uid, tmp, digest, size):
    with db.pinned_share_operation():
        with db.get_connection() as conn:
            ticket = conn.execute('SELECT * FROM asset_upload_token WHERE token=? AND owner_uid=? AND expires_at>?',(token,owner_uid,time.time())).fetchone()
            if not ticket:
                raise SyncError('asset_upload_expired')
            if ticket['asset_content_id'] != 'sha256:'+digest or ticket['bytes'] != size:
                raise SyncError('asset_digest_mismatch')
            root, revision, sid = root_context(conn,ticket['project_id'])
            if revision != ticket['root_revision'] or sid != ticket['storage_id']:
                raise SyncError('asset_context_changed')
            deleted_args = (ticket['asset_content_id'], owner_uid, ticket['project_id'], sid, revision)
            deleted_query = ("SELECT 1 FROM asset_location WHERE asset_content_id=? AND owner_uid=? "
                             "AND project_id=? AND storage_id=? AND root_revision=? AND kind='server' AND state='deleted'")
            if conn.execute(deleted_query, deleted_args).fetchone():
                raise SyncError('asset_deleted')
        extension=canonical_extension(tmp)
        kind=asset_media_type('asset'+extension,include_audio=True)
        if kind != ticket['media_type'] and not (extension in ('.mp4','.mov','.m4a') and ticket['media_type'] in ('audio','video')):
            raise SyncError('asset_media_mismatch')
        relative=str(Path(ticket['relative_path']).with_suffix(extension)).replace('\\','/')
        target = _file_path(root,relative)
        target.parent.mkdir(parents=True,exist_ok=True)
        target = _file_path(root,relative)  # Recheck after creating parents (symlink/junction confinement).
        stage = target.parent / ('.asset-sync-'+uuid.uuid4().hex+'.part')
        try:
            with tmp.open('rb') as source, stage.open('xb') as dest:
                for chunk in iter(lambda:source.read(1024*1024),b''):
                    dest.write(chunk)
                dest.flush()
                os.fsync(dest.fileno())
            try:
                os.link(stage,target)
            except FileExistsError:
                if target.stat().st_size != size or asset_io.sha256_file(target) != digest:
                    raise SyncError('asset_destination_conflict')
            except OSError:
                # Windows rename is atomic and refuses to replace an existing target on SMB.
                if os.name != 'nt':
                    raise
                try:
                    os.rename(stage,target)
                except FileExistsError:
                    if target.stat().st_size != size or asset_io.sha256_file(target) != digest:
                        raise SyncError('asset_destination_conflict')
        finally:
            stage.unlink(missing_ok=True)
        if target.stat().st_size != size or asset_io.sha256_file(target) != digest:
            raise SyncError('asset_storage_verification_failed')
        target_stat = target.stat()
        with db.get_connection() as conn:
            conn.execute('BEGIN IMMEDIATE')
            current = conn.execute('SELECT * FROM asset_upload_token WHERE token=? AND owner_uid=? AND expires_at>?',
                                   (token, owner_uid, time.time())).fetchone()
            if not current:
                raise SyncError('asset_upload_expired')
            if dict(current) != dict(ticket):
                raise SyncError('asset_upload_changed')
            current_root,current_revision,current_sid=root_context(conn,ticket['project_id'])
            if current_root != root or current_revision != revision or current_sid != sid:
                raise SyncError('asset_context_changed')
            if conn.execute(deleted_query, deleted_args).fetchone():
                raise SyncError('asset_deleted')
            ledger.register_verified_blob(conn,digest,size,ticket['media_type'])
            now = time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime())
            rid = uuid.uuid4().hex
            old = conn.execute('SELECT registry_asset_id FROM asset_registry WHERE project_id=? AND path_cf=?',(ticket['project_id'],relative.casefold())).fetchone()
            rid = old[0] if old else rid
            conn.execute("INSERT OR IGNORE INTO asset_registry(registry_asset_id,project_id,path,path_cf,name_cf,sha256,bytes,mtime_ns,state,first_seen,last_seen,updated_at) VALUES(?,?,?,?,?,?,?,?,'present',?,?,?)",(rid,ticket['project_id'],relative,relative.casefold(),target.name.casefold(),digest,size,target_stat.st_mtime_ns,now,now,now))
            conn.execute("UPDATE asset_registry SET state='present',sha256=?,bytes=?,mtime_ns=?,miss_count=0,missing_since=NULL,last_seen=?,updated_at=? WHERE registry_asset_id=?",(digest,size,target_stat.st_mtime_ns,now,now,rid))
            conn.execute("INSERT OR IGNORE INTO asset_location(location_id,asset_content_id,owner_uid,project_id,storage_id,root_revision,kind,path,original_name,registry_asset_id) VALUES(?,?,?,?,?,?,'server',?,?,?)",(uuid.uuid4().hex,ticket['asset_content_id'],owner_uid,ticket['project_id'],sid,revision,relative,ticket['original_name'],rid))
            row = conn.execute("SELECT * FROM asset_location WHERE asset_content_id=? AND owner_uid=? AND project_id=? AND root_revision=? AND storage_id=? AND kind='server'",(ticket['asset_content_id'],owner_uid,ticket['project_id'],revision,sid)).fetchone()
            conn.execute('DELETE FROM asset_upload_token WHERE token=?',(token,))
            return _receipt(row)


def register_local(path, file_path, digest, size, media_type, owner_uid, project_id=None, server_origin=None, original_name=''):
    """Use only on an immutable local snapshot whose bytes were just hashed."""
    with db.get_connection() as conn:
        conn.execute('BEGIN IMMEDIATE')
        return ledger.register_local(conn,path=path,file_path=file_path,digest=digest,size=size,media_type=media_type,owner_uid=owner_uid,
            project_id=project_id or '',server_origin=(shared_connection.base_url() if server_origin is None else server_origin),
            original_name=original_name or Path(path).name,account_key=active_account.account_key() or '')


def owns_local_content(path, owner_uid, *, digest=None):
    """경로/클라이언트 주장이 아니라 이미 검증한 동일 바이트의 소유 증거만 인정한다."""
    path = Path(path)
    if not owner_uid or not path.is_file() or not 0 < path.stat().st_size <= asset_io.UPLOAD_MAX_BYTES:
        return False
    cid = 'sha256:' + (digest or asset_io.sha256_file(path))
    with db.get_connection() as conn:
        return bool(conn.execute(
            "SELECT 1 FROM asset_location WHERE owner_uid=? AND asset_content_id=? AND state='ready' LIMIT 1",
            (owner_uid, cid)).fetchone())


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise SyncError('asset_server_redirect')


_opener = urllib.request.build_opener(_NoRedirect)


def _json_call(origin, token, path, body):
    req = urllib.request.Request(origin+path,data=json.dumps(body).encode(),headers={'Authorization':'Bearer '+token,'Content-Type':'application/json'},method='POST')
    with _opener.open(req,timeout=30) as response:
        return json.loads(response.read(1024*1024))


def _upload(origin, token, ticket, row):
    path = Path(row['path'])
    if not path.is_file() or path.stat().st_size != row['bytes'] or asset_io.sha256_file(path) != row['sha256']:
        raise SyncError('asset_local_copy_missing')
    with path.open('rb') as handle:
        req = urllib.request.Request(origin+'/api/asset-sync/uploads/'+ticket['token'],data=handle,method='PUT',
            headers={'Authorization':'Bearer '+token,'Content-Type':'application/octet-stream','Content-Length':str(row['bytes'])})
        with _opener.open(req,timeout=300) as response:
            return json.loads(response.read(1024*1024))


def process_one():
    # Capture account and DB epoch before any IO; account switches cannot settle into the new account.
    with db.pinned_share_operation():
        owner = active_account.active_uid()
        account_key = active_account.account_key() or ''
        token = shared_connection.token()
        origin = shared_connection.base_url()
        if not owner or not token:
            return False
        with db.get_connection() as conn:
            row = ledger.claim(conn,owner,origin,account_key)
        if not row:
            return False
        receipt = None
        error = None
        try:
            ticket = _json_call(origin,token,'/api/asset-sync/prepare',{'project_id':row['project_id'],'sha256':row['sha256'],'bytes':row['bytes'],'media_type':row['media_type'],'original_name':row['original_name']})
            for key,value in (('owner_uid',owner),('project_id',row['project_id']),('asset_content_id',row['asset_content_id'])):
                if ticket.get(key) != value:
                    raise SyncError('asset_receipt_mismatch')
            if row['storage_id'] and (ticket.get('storage_id') != row['storage_id'] or ticket.get('root_revision') != row['root_revision']):
                raise SyncError('asset_context_changed')
            # Durable context pin precedes the upload and survives unknown results/restarts.
            with db.get_connection() as conn:
                conn.execute('UPDATE asset_sync_outbox SET storage_id=?,root_revision=? WHERE sync_id=? AND lease_token=?',(ticket['storage_id'],ticket['root_revision'],row['sync_id'],row['lease_token']))
            row['storage_id'],row['root_revision']=ticket['storage_id'],ticket['root_revision']
            receipt = ticket if ticket.get('state') == 'ready' else _upload(origin,token,ticket,row)
            for key in ('asset_content_id','owner_uid','project_id','storage_id','root_revision'):
                if receipt.get(key) != ticket.get(key):
                    raise SyncError('asset_receipt_mismatch')
            if receipt.get('state') != 'ready' or not re.fullmatch('[a-f0-9]{32}',receipt.get('location_id','')):
                raise SyncError('asset_receipt_mismatch')
            if receipt.get('file_path') != 'asset-sync:'+receipt['location_id']:
                raise SyncError('asset_receipt_mismatch')
            previous=json.loads(row['receipt_json']) if row['receipt_json'] else {}
            if previous.get('location_id') and previous['location_id']!=receipt['location_id']:
                if previous.get('storage_id')!=receipt['storage_id']:
                    raise SyncError('asset_context_changed')
                receipt['supersedes_location_id']=previous['location_id']
            receipt['server_origin'] = origin
        except Exception as exc:
            receipt = None
            error = str(exc) if isinstance(exc,SyncError) else 'asset_transfer_failed'
        # Reject stale auth/connection and DB replacement, even if the remote call completed.
        if shared_connection.base_url() != origin or shared_connection.token() != token:
            receipt, error = None,'asset_connection_changed'
        with db.get_connection() as conn:
            ledger.settle(conn,row,receipt=receipt,error=error)
        return True


def verify_one():
    """Check one due receipt and repair confirmed loss from a verified, non-deleted local copy."""
    with db.pinned_share_operation():
        owner = active_account.active_uid()
        account_key = active_account.account_key() or ''
        token, origin = shared_connection.token(), shared_connection.base_url()
        if not owner or not token:
            return False
        now = time.time()
        with db.get_connection() as conn:
            conn.execute('BEGIN IMMEDIATE')
            row = conn.execute(
                "SELECT o.*,l.path,l.state local_state,b.sha256,b.bytes FROM asset_sync_outbox o "
                "JOIN asset_location l ON l.location_id=o.local_location_id "
                "JOIN asset_blob b ON b.asset_content_id=o.asset_content_id "
                "WHERE o.owner_uid=? AND o.account_key=? AND o.server_origin=? "
                "AND o.state='ready' AND o.next_retry_at<=? ORDER BY o.next_retry_at LIMIT 1",
                (owner, account_key, origin, now)).fetchone()
            if row is None:
                return False
            row = dict(row)
            conn.execute("UPDATE asset_sync_outbox SET next_retry_at=? WHERE sync_id=? AND state='ready'",
                         (now + 3600, row['sync_id']))
        next_state = 'ready'
        try:
            receipt = json.loads(row['receipt_json'])
            body = {key: receipt[key] for key in
                    ('location_id', 'asset_content_id', 'project_id', 'storage_id', 'root_revision')}
            result = _json_call(origin, token, '/api/asset-sync/verify', body)
            if any(result.get(key) != value for key, value in body.items()) or result.get('owner_uid') != owner:
                raise SyncError('asset_receipt_mismatch')
            state = result.get('state')
            error = None if state == 'ready' else 'asset_' + str(state)
            next_state = {'missing': 'recovery_required', 'deleted': 'deleted',
                          'changed': 'verification_failed'}.get(state, 'ready')
            if state == 'missing' and row['local_state'] == 'ready':
                path = Path(row['path'])
                readable = path.is_file() and path.stat().st_size == row['bytes'] and asset_io.sha256_file(path) == row['sha256']
                if readable:
                    next_state = 'queued'
                else:
                    error = 'asset_local_copy_missing'
        except Exception as exc:
            error = str(exc) if isinstance(exc, SyncError) else 'asset_verification_unavailable'
        if shared_connection.base_url() != origin or shared_connection.token() != token:
            return True
        with db.get_connection() as conn:
            conn.execute(
                "UPDATE asset_sync_outbox SET state=?,last_error_code=?,next_retry_at=? "
                "WHERE sync_id=? AND state='ready' AND receipt_json=? AND owner_uid=? AND account_key=? "
                "AND server_origin=? AND storage_id=? AND root_revision=?",
                (next_state, error, now if next_state == 'queued' else now + 3600,
                 row['sync_id'], row['receipt_json'], owner, account_key, origin, row['storage_id'], row['root_revision']))
        return True


async def run_worker():
    from . import asset_destination
    while True:
        try:
            more = False
            if not config.AUTH_ENABLED:
                more = await to_thread_non_abandon(process_one)
                await to_thread_non_abandon(verify_one)
            more = await to_thread_non_abandon(asset_destination.process_one) or more
        except Exception:
            more = False
        await asyncio.sleep(0.1 if more else 5)


_task = None


def start():
    global _task
    if not config.READ_ONLY and os.getenv('CONTENT_HUB_NO_PROXY','0') != '1' and _task is None:
        _task = asyncio.create_task(run_worker(),name='asset-sync-worker')


async def stop():
    global _task
    task, _task = _task,None
    if task:
        task.cancel()
        with suppress(asyncio.CancelledError):
            await task

"""Content identities and durable, account-scoped transfer state. Caller owns transactions."""
from __future__ import annotations

import json
import re
import sqlite3
import time
import uuid


def register_verified_blob(conn, sha: str, size: int, media_type: str) -> str:
    """Only call with a digest of bytes the server/agent actually read."""
    if not re.fullmatch(r'[0-9a-f]{64}', sha) or size <= 0:
        raise ValueError('invalid_asset_digest')
    cid = 'sha256:' + sha
    row = conn.execute('SELECT bytes FROM asset_blob WHERE asset_content_id=?', (cid,)).fetchone()
    if row is not None and row[0] != size:
        raise ValueError('asset_content_conflict')
    conn.execute('INSERT OR IGNORE INTO asset_blob(asset_content_id,sha256,bytes,media_type) VALUES(?,?,?,?)', (cid, sha, size, media_type))
    if media_type in ('image','video','audio'):
        conn.execute("UPDATE asset_blob SET media_type=? WHERE asset_content_id=? AND media_type NOT IN ('image','video','audio')",(media_type,cid))
    return cid


def storage_id(conn) -> str:
    row = conn.execute('SELECT database_id FROM schema_meta WHERE singleton=1').fetchone()
    if row is None:
        raise ValueError('asset_storage_identity_missing')
    return row[0]


def resolve_location_id(conn, location_id: str) -> str:
    if not re.fullmatch('[a-f0-9]{32}',location_id):
        raise ValueError('invalid_asset_location')
    row=conn.execute('SELECT location_id FROM asset_location_alias WHERE alias_id=?',(location_id,)).fetchone()
    return row[0] if row else location_id


def register_local(conn, *, path, file_path, digest, size, media_type, owner_uid,
                   project_id='', server_origin='', original_name='', account_key='') -> dict:
    cid = register_verified_blob(conn, digest, size, media_type)
    sid = storage_id(conn)
    conn.execute('INSERT OR IGNORE INTO asset_location(location_id,asset_content_id,owner_uid,project_id,storage_id,kind,path,original_file_path,original_name) VALUES(?,?,?,?,?,\'local\',?,?,?)',
                 (uuid.uuid4().hex, cid, owner_uid, '', sid, str(path), file_path, original_name))
    location = conn.execute("SELECT * FROM asset_location WHERE storage_id=? AND owner_uid=? AND asset_content_id=? AND kind='local'", (sid,owner_uid,cid)).fetchone()
    # A cache can be restored by a later import after its earlier file disappeared.
    conn.execute('UPDATE asset_location SET path=?,original_file_path=?,state=\'ready\' WHERE location_id=?', (str(path),file_path,location['location_id']))
    state = 'queued' if project_id else 'project_required'
    conn.execute('INSERT OR IGNORE INTO asset_sync_outbox(sync_id,asset_content_id,local_location_id,owner_uid,project_id,account_key,server_origin,state,updated_at) VALUES(?,?,?,?,?,?,?,?,?)',
                 (uuid.uuid4().hex,cid,location['location_id'],owner_uid,project_id or '',account_key,server_origin,state,time.time()))
    row = conn.execute('SELECT * FROM asset_sync_outbox WHERE asset_content_id=? AND owner_uid=? AND project_id=? AND server_origin=?', (cid,owner_uid,project_id or '',server_origin)).fetchone()
    return {'asset_content_id':cid,'sync_state':row['state'],'local_location_id':location['location_id'],
            'sha256':digest,'bytes':size,
            'target_project_id':project_id or None,'original_file_path':file_path,
            'server_location':json.loads(row['receipt_json']) if row['receipt_json'] and row['state']=='ready' else None}


def claim(conn, owner_uid, server_origin, account_key, now=None):
    now = time.time() if now is None else now
    conn.execute('BEGIN IMMEDIATE')
    row = conn.execute("SELECT o.*,l.path,l.original_file_path,l.original_name,b.sha256,b.bytes,b.media_type FROM asset_sync_outbox o JOIN asset_location l ON l.location_id=o.local_location_id JOIN asset_blob b USING(asset_content_id) WHERE o.owner_uid=? AND o.account_key=? AND o.server_origin=? AND o.project_id<>'' AND o.state IN ('queued','uploading','retrying') AND o.next_retry_at<=? AND (o.lease_until IS NULL OR o.lease_until<?) ORDER BY o.updated_at LIMIT 1", (owner_uid,account_key,server_origin,now,now)).fetchone()
    if not row:
        return None
    token = uuid.uuid4().hex
    conn.execute("UPDATE asset_sync_outbox SET state='uploading',lease_token=?,lease_until=?,attempts=attempts+1 WHERE sync_id=?", (token,now+600,row['sync_id']))
    return {**dict(row),'lease_token':token}


def settle(conn, row, *, receipt=None, error=None):
    state = 'ready' if receipt else 'retrying'
    delay = min(300, 2 ** min(int(row['attempts'])+1, 8))
    result = conn.execute('UPDATE asset_sync_outbox SET state=?,receipt_json=COALESCE(?,receipt_json),last_error_code=?,next_retry_at=?,storage_id=?,root_revision=?,lease_token=NULL,lease_until=NULL,updated_at=? WHERE sync_id=? AND lease_token=?',
        (state,json.dumps(receipt) if receipt else None,error, time.time()+delay,
         (receipt or {}).get('storage_id',row['storage_id']), (receipt or {}).get('root_revision',row['root_revision']),time.time(),row['sync_id'],row['lease_token']))
    return result.rowcount == 1


def status_rows(conn, owner_uid, project_id=None):
    rows = conn.execute('SELECT o.*,l.original_file_path FROM asset_sync_outbox o JOIN asset_location l ON l.location_id=o.local_location_id WHERE o.owner_uid=?' + (' AND o.project_id=?' if project_id is not None else ''), (owner_uid,project_id) if project_id is not None else (owner_uid,)).fetchall()
    return [{**{k:r[k] for k in ('asset_content_id','owner_uid','project_id','server_origin','state','storage_id','root_revision','original_file_path','last_error_code')},
             **(json.loads(r['receipt_json']) if r['receipt_json'] else {}),
             'state':r['state'],
             'target_project_id':r['project_id'],'server_file_path':(json.loads(r['receipt_json']).get('file_path') if r['receipt_json'] else None)} for r in rows]


def generation_output_intent(conn, generation_id, *, deleted):
    """Only an explicit trash/restore operation changes automatic result recovery intent."""
    rows = conn.execute(
        "SELECT DISTINCT a.asset_content_id,g.creator_uid,COALESCE(g.project_id,'') project_id "
        "FROM generation g JOIN asset a ON a.generation_id=g.id "
        "WHERE g.id=? AND a.asset_content_id IS NOT NULL", (generation_id,)).fetchall()
    for row in rows:
        cid, owner, project = row
        if not owner:
            continue
        if deleted and conn.execute(
            "SELECT 1 FROM generation g WHERE g.id<>? AND g.deleted_at IS NULL AND g.creator_uid=? "
            "AND COALESCE(g.project_id,'')=? AND (EXISTS "
            "(SELECT 1 FROM asset a WHERE a.generation_id=g.id AND a.asset_content_id=?) OR EXISTS "
            "(SELECT 1 FROM gen_reference gr JOIN reference r ON r.id=gr.reference_id "
            "WHERE gr.generation_id=g.id AND r.asset_content_id=?)) LIMIT 1",
            (generation_id, owner, project, cid, cid)).fetchone():
            continue
        conn.execute(
            "UPDATE asset_sync_outbox SET state=CASE WHEN ? THEN 'deleted' "
            "WHEN receipt_json IS NOT NULL THEN 'ready' ELSE 'queued' END,"
            "lease_token=NULL,lease_until=NULL,next_retry_at=0,"
            "last_error_code=?,updated_at=? WHERE asset_content_id=? AND owner_uid=? AND project_id=?"
            + (" AND state<>'deleted'" if deleted else " AND state='deleted' AND last_error_code='asset_deleted_in_app'"),
            (deleted, 'asset_deleted_in_app' if deleted else None,
             time.time(), cid, owner, project))

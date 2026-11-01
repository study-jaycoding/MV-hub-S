"""Content identities and durable, account-scoped transfer state. Caller owns transactions."""
from __future__ import annotations

import json
import re
import sqlite3
import time
import uuid

from .. import active_account, rbac
from .asset_locations import _origin as origin_of


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


UNDELIVERABLE_MESSAGE = '작성자가 이 프로젝트의 구성원이 아니라 파일을 보낼 수 없습니다. 작성자를 프로젝트 구성원으로 먼저 추가해 주세요.'
# 다시 시도해도 안 되는 전송 오류 — 역할·저장 위치가 생겨야 끝난다. 자동 재시도는 이어져 그때 스스로 끝난다.
STUCK_ERRORS = ('asset_project_forbidden', 'asset_root_required', 'project_unavailable')


class UndeliverableMove(Exception):
    def __init__(self):
        super().__init__(UNDELIVERABLE_MESSAGE)


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


def queue_moved_outputs(conn, generation_ids, project_id, destination=None):
    """프로젝트로 옮긴 결과와 입력의 로컬 파일을 그 프로젝트로 보낸다 — 전송 줄은 프로젝트마다 따로라 잇지 않으면 다른 PC 가 파일을 못 받는다.
    바이트는 이 PC 의 보관본에서 찾고 목적지는 지금 계정·서버다(옛 서버 줄을 베끼지 않는다). destination=(계정, 서버) — 그 서버에서 얻은 프로젝트라
    문맥을 미리 고정한 호출. 원격 주소가 있으면 그 주소로 받을 수 있어 건드리지 않고, 그 내용의 줄이 전부 지워졌으면 다시 올리지 않는다.
    Caller owns the transaction."""
    account_key, server_origin = destination or (active_account.account_key() or '', origin_of(conn))
    placeholders = ','.join('?' for _ in generation_ids)
    conn.execute(
        "INSERT OR IGNORE INTO asset_sync_outbox(sync_id,asset_content_id,local_location_id,owner_uid,project_id,account_key,server_origin,state,updated_at) "
        "SELECT lower(hex(randomblob(16))),l.asset_content_id,l.location_id,l.owner_uid,?,?,?,'queued',? "
        "FROM asset_location l JOIN ("
        "SELECT g.creator_uid owner,a.asset_content_id content FROM generation g JOIN asset a ON a.generation_id=g.id "
        f"WHERE g.id IN ({placeholders}) AND g.deleted_at IS NULL AND a.file_path NOT LIKE 'http%' "
        "AND COALESCE(a.source_url,'') NOT LIKE 'http%' "
        "UNION SELECT g.creator_uid,r.asset_content_id FROM generation g "
        "JOIN gen_reference gr ON gr.generation_id=g.id JOIN reference r ON r.id=gr.reference_id "
        f"WHERE g.id IN ({placeholders}) AND g.deleted_at IS NULL AND r.file_path NOT LIKE 'http%' "
        "AND COALESCE(r.source_url,'') NOT LIKE 'http%' AND COALESCE(r.share_url,'') NOT LIKE 'http%'"
        ") wanted ON l.asset_content_id=wanted.content AND l.owner_uid=wanted.owner "
        "WHERE l.kind='local' AND l.state='ready' AND COALESCE((SELECT MIN(o.state='deleted') FROM asset_sync_outbox o "
        "WHERE o.asset_content_id=l.asset_content_id AND o.owner_uid=l.owner_uid),0)=0",
        (project_id, account_key, server_origin, time.time(), *generation_ids, *generation_ids))


def _delivered(content_column):
    """그 내용이 이 프로젝트에 이미 있다 — 서버는 위치 행으로, 허브는 지금 서버·계정의 끝난 전송 줄로 안다(옛 서버 줄은 근거가 아니다)."""
    return (f"(EXISTS(SELECT 1 FROM asset_location l WHERE l.kind='server' AND l.state='ready' AND l.project_id=:project "
            f"AND l.owner_uid=g.creator_uid AND l.asset_content_id={content_column}) "
            f"OR EXISTS(SELECT 1 FROM asset_sync_outbox o WHERE o.state='ready' AND o.project_id=:project "
            f"AND o.server_origin=:origin AND o.account_key=:account "
            f"AND o.owner_uid=g.creator_uid AND o.asset_content_id={content_column}))")


def pending_delivery(conn, generation_ids, project_id):
    """이 프로젝트로 아직 보내야 할 파일이 있는 생성물의 (id, 작성자). 내용 ID 없는 입력은 보낼 길이 없어(계약 제외) 세지 않는다."""
    if not generation_ids:
        return []
    names = {f'g{index}': gid for index, gid in enumerate(generation_ids)}
    placeholders = ','.join(':' + name for name in names)
    return [tuple(row) for row in conn.execute(
        f"SELECT g.id,g.creator_uid FROM generation g WHERE (g.id IN ({placeholders}) OR g.job_id IN ({placeholders})) AND g.deleted_at IS NULL AND (EXISTS("
        "SELECT 1 FROM asset a WHERE a.generation_id=g.id AND a.file_path NOT LIKE 'http%' "
        "AND COALESCE(a.source_url,'') NOT LIKE 'http%' "
        f"AND NOT (a.asset_content_id IS NOT NULL AND {_delivered('a.asset_content_id')})"
        ") OR EXISTS(SELECT 1 FROM gen_reference gr JOIN reference r ON r.id=gr.reference_id "
        "WHERE gr.generation_id=g.id AND r.asset_content_id IS NOT NULL AND r.file_path NOT LIKE 'http%' "
        "AND COALESCE(r.source_url,'') NOT LIKE 'http%' AND COALESCE(r.share_url,'') NOT LIKE 'http%' "
        f"AND NOT {_delivered('r.asset_content_id')}))",
        {**names, 'project': project_id, 'origin': origin_of(conn), 'account': active_account.account_key() or ''})]


def _uploader_uids(conn, creator_uid):
    """파일을 올릴 사람 — 옛 acct: 별칭 작성자는 그 계정의 정규 uid 로도 본다(구성원 행은 정규 uid 로 옮겨져 있다)."""
    uids = {creator_uid} if creator_uid else set()
    if creator_uid and creator_uid.startswith('acct:'):
        row = conn.execute('SELECT creator_uid FROM account WHERE email=?', (creator_uid[5:],)).fetchone()
        if row and row[0]:
            uids.add(row[0])
    return uids


def _has_upload_role(conn, project_id, uids):
    """업로드 입구(require_project_role)와 같은 판정 — 구성원 행이 있어도 역할이 비면 못 올린다."""
    if not uids:
        return False
    placeholders = ','.join('?' for _ in uids)
    rows = conn.execute(f'SELECT project_role FROM project_member WHERE project_id=? AND creator_uid IN ({placeholders})',
                        (project_id, *uids)).fetchall()
    return any(rbac.has_any_project_role(row[0], *rbac.PROJECT_ROLES) for row in rows)


def undeliverable_generations(conn, generation_ids, project_id, uploader_uids=None):
    """이 프로젝트로 옮기면 파일을 보낼 사람이 없는 생성물. uploader_uids — 번들처럼 작성자 주장이 아니라 인증 계정으로 판정할 때."""
    return [gid for gid, creator in pending_delivery(conn, generation_ids, project_id)
            if not _has_upload_role(conn, project_id, _uploader_uids(conn, creator) if uploader_uids is None else set(uploader_uids))]


def link_output(conn, anchor, content_id, file_path, author_uids):
    """옛 공유 행의 결과·입력에 비어 있는 내용 ID 를 채운다(서버). ready 위치는 '내가 올린 바이트'의 근거일 뿐 옛 결과와 같다는 독립 증명은 아니라
    작성자 본인 행의 빈 칸에만 쓴다. Caller owns the transaction."""
    gen = conn.execute('SELECT id,creator_uid,project_id,deleted_at FROM generation WHERE id=? OR job_id=? LIMIT 1', (anchor, anchor)).fetchone()
    if gen is None or gen['deleted_at']:
        raise LookupError('generation_missing')
    if gen['creator_uid'] not in author_uids:
        raise PermissionError('asset_link_not_author')
    row = conn.execute(
        "SELECT r.id,r.file_path,r.asset_content_id FROM gen_reference gr JOIN reference r ON r.id=gr.reference_id "
        "WHERE gr.generation_id=? AND r.file_path=? LIMIT 1", (gen['id'], file_path)).fetchone()
    table = 'reference'
    if row is None:
        row = conn.execute('SELECT id,file_path,asset_content_id FROM asset WHERE generation_id=? AND file_path=? LIMIT 1',
                           (gen['id'], file_path)).fetchone()
        table = 'asset'
    if row is None or file_path.startswith('http'):
        raise LookupError('asset_link_target_missing')
    if row['asset_content_id'] == content_id:
        return {'linked': False, 'asset_content_id': content_id}
    if row['asset_content_id']:
        raise ValueError('asset_link_conflict')
    if table == 'reference':  # 입력 행은 여러 생성물이 함께 쓴다 — 남의 생성물까지 바꾸지 않는다
        placeholders = ','.join('?' for _ in author_uids)
        if conn.execute(f"SELECT 1 FROM gen_reference gr JOIN generation g ON g.id=gr.generation_id "
                        f"WHERE gr.reference_id=? AND COALESCE(g.creator_uid,'') NOT IN ({placeholders}) LIMIT 1",
                        (row['id'], *author_uids)).fetchone():
            raise ValueError('asset_link_shared_input')
    if not conn.execute("SELECT 1 FROM asset_location WHERE kind='server' AND state='ready' AND owner_uid=? AND project_id=? AND asset_content_id=? LIMIT 1",
                        (gen['creator_uid'], gen['project_id'], content_id)).fetchone():
        raise ValueError('asset_location_missing')
    conn.execute(f'UPDATE {table} SET asset_content_id=? WHERE id=? AND asset_content_id IS NULL', (content_id, row['id']))
    return {'linked': True, 'asset_content_id': content_id}


def transfer_summary(conn, owner_uid, account_key, server_origin):
    """설정 화면의 전송 상태 — 지금 서버·계정 줄만. 다시 시도로 고칠 수 있는 실패와 사람이 봐야 하는 것을 가른다."""
    rows = conn.execute('SELECT state,last_error_code FROM asset_sync_outbox WHERE owner_uid=? AND account_key=? AND server_origin=?',
                        (owner_uid, account_key, server_origin)).fetchall()
    summary = {'waiting': 0, 'failed': 0, 'needs_check': 0}
    for state, error in rows:
        if state == 'verification_failed' or (state == 'retrying' and error in STUCK_ERRORS):
            summary['needs_check'] += 1
        elif state in ('queued', 'uploading'):
            summary['waiting'] += 1
        elif state in ('retrying', 'recovery_required'):
            summary['failed'] += 1
    return summary


def retry_failed(conn, owner_uid, account_key, server_origin):
    conn.execute("UPDATE asset_sync_outbox SET state='queued',next_retry_at=0 WHERE owner_uid=? AND account_key=? AND server_origin=? "
                 f"AND state IN ('retrying','recovery_required') AND COALESCE(last_error_code,'') NOT IN ({','.join('?' for _ in STUCK_ERRORS)})",
                 (owner_uid, account_key, server_origin, *STUCK_ERRORS))


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
            "WHEN receipt_json IS NOT NULL AND root_revision<>'' THEN 'ready' ELSE 'queued' END,"
            "lease_token=NULL,lease_until=NULL,next_retry_at=0,"
            "last_error_code=?,updated_at=? WHERE asset_content_id=? AND owner_uid=? AND project_id=?"
            + (" AND state<>'deleted'" if deleted else " AND state='deleted' AND last_error_code='asset_deleted_in_app'"),
            (deleted, 'asset_deleted_in_app' if deleted else None,
             time.time(), cid, owner, project))

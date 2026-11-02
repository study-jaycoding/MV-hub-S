"""Private scene keeps; opening restores eligible trash results before linking cards."""
from __future__ import annotations

import hashlib
import json
import math
import secrets
import unicodedata
from datetime import datetime, timezone
from typing import Any

from .. import config
from ..db import get_connection, open_transfer_connections
from ..emailnorm import norm_email
from ..services import trash_transfer
from .trash import attach_trash, detach_trash, _payload_has_usable_asset

DATA_MAX = 8 * 1024 * 1024
SCENE_MAX = 5 * 1024 * 1024
ACCOUNT_MAX = 200 * 1024 * 1024
ROW_MAX = 300
GEN_MAX = 2000
BATCH_SIZE = 500


class KeepConflict(ValueError):
    pass


class KeepAccountGone(Exception):
    """쓰기 잠금 안에서 본 계정이 요청을 인증한 계정이 아니다."""


def encoded(value: Any) -> str:
    return json.dumps(value, ensure_ascii=True, allow_nan=False, sort_keys=True)


def chunks(items):
    for start in range(0, len(items), BATCH_SIZE):
        yield items[start:start + BATCH_SIZE]


def _text(value, limit, *, optional=False, empty=True):
    return (value is None and optional) or (isinstance(value, str) and len(value) <= limit and (empty or bool(value)))


def _finite(value):
    try:
        return not isinstance(value, bool) and isinstance(value, (int, float)) and math.isfinite(value)
    except OverflowError:
        return False


def read_scene(text):
    if not isinstance(text, str) or len(text.encode('utf-8')) > SCENE_MAX:
        raise ValueError('씬이 너무 큽니다')
    try:
        doc = json.loads(text)
        if not isinstance(doc, dict) or doc.get('format') != 'mv-scene' or type(doc.get('version')) is not int or doc['version'] != 1:
            raise ValueError()
        scene = doc['scene']
        if not isinstance(scene, dict) or not isinstance(scene.get('cards'), list):
            raise ValueError()
        if any(not isinstance(card, dict) for card in scene['cards']):
            raise ValueError()
        return scene
    except (ValueError, KeyError, TypeError) as exc:
        raise ValueError('이 앱에서 열 수 없는 보관본입니다') from exc


def scene_generation_ids(scene_text):
    ids = []
    for card in read_scene(scene_text)['cards']:
        values = [card.get('genId')]
        values += card.get('genIds') if isinstance(card.get('genIds'), list) else []
        values += [r.get('source_gen_id') for r in card.get('refs', []) if isinstance(r, dict)] if isinstance(card.get('refs'), list) else []
        cfg = card.get('comfyCfg')
        if isinstance(cfg, dict) and isinstance(cfg.get('outputs'), list):
            values += [o.get('saved_generation_id') for o in cfg['outputs'] if isinstance(o, dict)]
        ids.extend(v for v in values if isinstance(v, str) and v)
    return list(dict.fromkeys(ids))


def generation_timestamp(g):
    stamp = g.get('sort_ts')
    if stamp is None:
        try:
            date = datetime.fromisoformat(g['created_at'].replace('Z', '+00:00'))
            stamp = (date if date.tzinfo else date.replace(tzinfo=timezone.utc)).timestamp()
        except (KeyError, AttributeError, TypeError, ValueError, OverflowError, OSError):
            raise ValueError('생성 시각이 올바르지 않습니다') from None
    if not _finite(stamp):
        raise ValueError('생성 시각이 올바르지 않습니다')
    return stamp


def validate_generation(g):
    bad = ValueError('생성 결과 정보의 형식이 맞지 않습니다')
    if not isinstance(g, dict) or not _text(g.get('id'), 200, empty=False):
        raise bad
    for key, limit in [('job_id', 200), ('display_prompt', 20000), ('model', 512), ('creator_uid', 1024),
                       ('project_id', 512), ('folder_path', 4096), ('workspace_id', 512), ('workspace_name', 512)]:
        if not _text(g.get(key), limit, optional=True):
            raise bad
    if (g.get('source') not in ('local', 'server') or g.get('status') != 'done'
            or not _text(g.get('prompt'), 20000) or not _text(g.get('created_at'), 40, empty=False)
            or g.get('generator') not in (None, 'comfy')
            or g.get('workspace_scope', 'unknown') not in ('unknown', 'personal', 'team')):
        raise bad
    generation_timestamp(g)
    if g.get('params') is not None and (not isinstance(g['params'], dict) or len(encoded(g['params'])) > 64 * 1024):
        raise bad
    aliases = g.get('scene_ids', [g['id']])
    if not isinstance(aliases, list) or not aliases or len(aliases) > GEN_MAX or any(not _text(a, 200, empty=False) for a in aliases):
        raise bad
    assets = g.get('assets')
    if not isinstance(assets, list) or not 1 <= len(assets) <= 32:
        raise bad
    for a in assets:
        if not isinstance(a, dict) or a.get('type') not in ('image', 'video', 'audio'):
            raise bad
        for key in ('file_path', 'thumbnail_path'):
            value = a.get(key)
            if key == 'thumbnail_path' and value is None:
                continue
            if not _text(value, 4096, empty=False) or not value.startswith('https://'):
                raise bad


def validate_keep_envelope(data):
    if not isinstance(data, dict) or type(data.get('v')) is not int or data['v'] != 1:
        raise ValueError('이 앱에서 열 수 없는 보관본입니다')
    if len(encoded(data)) > DATA_MAX:
        raise ValueError('보관본이 너무 큽니다(8 MiB)')
    wanted = set(scene_generation_ids(data.get('scene_text')))
    generations = data.get('generations')
    if not isinstance(generations, list) or len(generations) > GEN_MAX:
        raise ValueError('생성 결과 정보의 형식이 맞지 않습니다')
    seen = set()
    for g in generations:
        validate_generation(g)
        aliases = set(g.get('scene_ids', [g['id']]))
        if not aliases <= wanted or aliases & seen:
            raise ValueError('씬과 생성 결과 정보가 맞지 않습니다')
        seen.update(aliases)


def pack_generation(g, source, scene_id):
    keys = ('id', 'job_id', 'prompt', 'display_prompt', 'model', 'params', 'status', 'created_at', 'sort_ts',
            'creator_uid', 'project_id', 'folder_path', 'generator', 'workspace_id', 'workspace_name')
    item = {k: g.get(k) for k in keys}
    item.update(source=source, scene_ids=[scene_id], workspace_scope=g.get('workspace_scope') or 'unknown')
    item['assets'] = []
    for a in g.get('assets') or []:
        path = a.get('file_path') or ''
        url = path if path.startswith('https://') else a.get('source_url')
        thumb = a.get('thumbnail_path') or ''
        item['assets'].append({'type': a.get('type'), 'file_path': url,
                               'thumbnail_path': thumb if thumb.startswith('https://') else None})
    validate_generation(item)
    return item


def validate_metadata(body):
    name = unicodedata.normalize('NFC', body.get('name', '').strip())
    if not _text(name, 120, empty=False):
        raise ValueError('이름은 1~120자로 입력해 주세요')
    description = body.get('description', '')
    if not _text(description, 2000):
        raise ValueError('설명은 2,000자 이하로 입력해 주세요')
    description = unicodedata.normalize('NFC', description)
    if len(description) > 2000:
        raise ValueError('설명은 2,000자 이하로 입력해 주세요')
    for key in ('project_id', 'project_name'):
        if not _text(body.get(key), 512, optional=key == 'project_name'):
            raise ValueError('프로젝트 정보가 올바르지 않습니다')
    workspace = body.get('workspace') or {}
    if not isinstance(workspace, dict) or any(not _text(workspace.get(k), 512, optional=True) for k in ('id', 'name')):
        raise ValueError('탭 표식이 올바르지 않습니다')
    preview = body.get('preview', [])
    if not isinstance(preview, list) or len(preview) > 200 or len(encoded(preview)) > 8192:
        raise ValueError('미리보기가 너무 큽니다')
    for node in preview:
        if (not isinstance(node, list) or len(node) != 5 or not _text(node[0], 40, empty=False)
                or any(not _finite(v) or not 0 <= v <= 1000 for v in node[1:])):
            raise ValueError('미리보기 형식이 올바르지 않습니다')
    missing = body.get('missing_count', 0)
    if type(missing) is not int or missing < 0:
        raise ValueError('누락 수가 올바르지 않습니다')
    return name, workspace, preview, missing, description


def save_keep(owner, body, account=None):
    owner = norm_email(owner)
    if not owner:
        raise ValueError('계정을 확인할 수 없습니다')
    data = body.get('data')
    validate_keep_envelope(data)
    name, workspace, preview, missing, description = validate_metadata(body)
    raw = encoded(data)
    metadata = (body['project_id'], body.get('project_name'), name, workspace.get('id'), workspace.get('name'),
                len(read_scene(data['scene_text'])['cards']), encoded(preview), missing, description)
    digest = hashlib.sha256(encoded([data, metadata]).encode()).hexdigest()
    oid, revision = body.get('overwrite_id'), body.get('overwrite_revision')
    with get_connection() as conn:
        conn.execute('BEGIN IMMEDIATE')
        if account is not None:
            # 계정 정리도 이 잠금 안에서 이 표를 센다 — 여기서 봐야 지워진 계정의 보관본이 새로 생기지 않는다.
            fresh = conn.execute('SELECT status,password_changed_at FROM account WHERE email=?', (owner,)).fetchone()
            if (not fresh or fresh['status'] != 'approved'
                    or fresh['password_changed_at'] != account.get('password_changed_at')):
                raise KeepAccountGone()
        row = conn.execute('SELECT id,revision,updated_at,data_hash,description FROM scene_keep WHERE owner=? AND project_id=? AND name=?',
                           (owner, body['project_id'], name)).fetchone()
        if oid is not None or revision is not None:
            if not row or row['id'] != oid or row['revision'] != revision:
                return {'status': 'conflict'}
        elif row:
            return {'status': 'exists', **{k: row[k] for k in ('id', 'revision', 'updated_at', 'description')}}
        count, size = conn.execute('SELECT COUNT(*), COALESCE(SUM(data_bytes),0) FROM scene_keep WHERE owner=? AND id<>?',
                                   (owner, row['id'] if row else '')).fetchone()
        if count >= ROW_MAX or size + len(raw) > ACCOUNT_MAX:
            raise ValueError('보관함 용량을 초과했습니다')
        if not row:
            kid = secrets.token_hex(16)
            conn.execute('INSERT INTO scene_keep(id,owner,project_id,project_name,name,workspace_id,workspace_name,'
                         'node_count,preview,missing_count,description,data,data_hash,data_bytes,revision) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,1)',
                         (kid, owner, *metadata, raw, digest, len(raw)))
        else:
            kid = row['id']
            if row['data_hash'] != digest:
                conn.execute("UPDATE scene_keep SET project_id=?,project_name=?,name=?,workspace_id=?,workspace_name=?,"
                             "node_count=?,preview=?,missing_count=?,description=?,data=?,data_hash=?,data_bytes=?,revision=revision+1,"
                             "updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?",
                             (*metadata, raw, digest, len(raw), kid))
        saved = conn.execute('SELECT revision FROM scene_keep WHERE id=?', (kid,)).fetchone()
        return {'status': 'saved', 'id': kid, 'revision': saved['revision'], 'missing_count': missing}


def list_keeps(owner):
    with get_connection() as conn:
        rows = conn.execute('SELECT id,name,project_id,project_name,workspace_id,workspace_name,node_count,preview,'
                            'missing_count,revision,updated_at,description FROM scene_keep WHERE owner=? ORDER BY updated_at DESC,id',
                            (norm_email(owner),)).fetchall()
    result = []
    for row in rows:
        item = dict(row)
        item['preview'] = json.loads(item['preview'])
        workspace_id, workspace_name = item.pop('workspace_id'), item.pop('workspace_name')
        item['workspace'] = {'id': workspace_id, 'name': workspace_name} if workspace_id else None
        result.append(item)
    return result


def get_keep(owner, kid, revision=None):
    with get_connection() as conn:
        row = conn.execute('SELECT data,revision,workspace_id,workspace_name FROM scene_keep WHERE owner=? AND id=?',
                           (norm_email(owner), kid)).fetchone()
    if row is None:
        raise LookupError('보관본을 찾을 수 없습니다')
    if revision is not None and row['revision'] != revision:
        raise KeepConflict('보관본이 바뀌었습니다')
    data = json.loads(row['data'])
    if revision is not None:
        return data
    return {'scene_text': data['scene_text'], 'revision': row['revision'],
            'workspace': {'id': row['workspace_id'], 'name': row['workspace_name']} if row['workspace_id'] else None}


def delete_keep(owner, kid, revision):
    with get_connection() as conn:
        conn.execute('BEGIN IMMEDIATE')
        row = conn.execute('SELECT revision FROM scene_keep WHERE owner=? AND id=?', (norm_email(owner), kid)).fetchone()
        if row is None:
            raise LookupError('보관본을 찾을 수 없습니다')
        if row['revision'] != revision:
            raise KeepConflict('보관본이 바뀌었습니다')
        conn.execute('DELETE FROM scene_keep WHERE owner=? AND id=?', (norm_email(owner), kid))
    return {'ok': True}


def _trash_payload(row):
    try:
        payload = json.loads(row['payload'])
        gen = payload['generation']
        if not isinstance(gen, dict) or gen.get('id') != row['id']:
            return None
        return payload
    except (ValueError, KeyError, TypeError):
        return None


def _failed_payload(payload):
    if payload is None:
        return False
    terminal = payload.get('provider_terminal')
    return (payload['generation'].get('status') == 'failed'
            or isinstance(terminal, dict) and terminal.get('kind') == 'failure')


def _restore_state(conn, generations):
    """One snapshot, shared by trash admission and the final write transaction."""
    ids = list(dict.fromkeys(a for g in generations for a in [g['id'], *g.get('scene_ids', [])]))
    jobs = list(dict.fromkeys(g['job_id'] for g in generations if g.get('job_id')))
    rows, trashed, live_jobs, trash_jobs = {}, {}, {}, {}
    deleting_ids, deleting_jobs = set(), set()
    for column, values in (('id', ids), ('job_id', jobs)):
        for batch in chunks(values):
            ph = ','.join('?' for _ in batch)
            for row in conn.execute(f"SELECT g.*, EXISTS(SELECT 1 FROM asset a WHERE a.generation_id=g.id AND a.file_path<>'') AS has_asset FROM generation g WHERE g.{column} IN ({ph})", batch):
                rows[row['id']] = dict(row)
    ids = list(dict.fromkeys([*ids, *rows]))
    transferring = trash_transfer.enabled(conn)
    for column, values in (('id', ids), ('job_id', jobs)):
        for batch in chunks(values):
            ph = ','.join('?' for _ in batch)
            for row in conn.execute(f'SELECT id,job_id,creator_uid,payload FROM trash.trashed WHERE {column} IN ({ph})', batch):
                trashed[row['id']] = dict(row)
            if transferring:
                transfer_column = 'generation_id' if column == 'id' else column
                for row in conn.execute(f"SELECT generation_id,job_id FROM generation_transfer WHERE direction='delete' AND {transfer_column} IN ({ph})", batch):
                    deleting_ids.add(row['generation_id'])
                    if row['job_id']:
                        deleting_jobs.add(row['job_id'])
    # A job-matched trash ID may already exist in main under a DIFFERENT job.
    # Check the actual candidate IDs too, before the legacy restore can replace them.
    for batch in chunks(list(trashed.keys() - rows.keys())):
        ph = ','.join('?' for _ in batch)
        for row in conn.execute(f"SELECT g.*, EXISTS(SELECT 1 FROM asset a WHERE a.generation_id=g.id AND a.file_path<>'') AS has_asset FROM generation g WHERE g.id IN ({ph})", batch):
            rows[row['id']] = dict(row)
        if transferring:
            deleting_ids.update(row[0] for row in conn.execute(
                f"SELECT generation_id FROM generation_transfer WHERE direction='delete' AND generation_id IN ({ph})", batch))
    for row in trashed.values():
        row['parsed'] = _trash_payload(row)
        if row['job_id']:
            trash_jobs.setdefault(row['job_id'], []).append(row)
            if row['id'] in deleting_ids:
                deleting_jobs.add(row['job_id'])
    for row in rows.values():
        if (row['status'] == 'done' and row['has_asset'] and not row.get('deleted_at')
                and row['id'] not in trashed and row['id'] not in deleting_ids and row.get('job_id')):
            live_jobs.setdefault(row['job_id'], []).append(row['id'])
    return rows, trashed, live_jobs, trash_jobs, deleting_ids, deleting_jobs


def _live_target(g, state):
    rows, trashed, live_jobs, _, deleting_ids, deleting_jobs = state
    job = g.get('job_id') or None
    ids = [g['id'], *g.get('scene_ids', [])]
    if deleting_ids.intersection(ids) or job in deleting_jobs:
        return None, True
    candidates = live_jobs.get(job, []) if job else []
    if candidates:
        if len(candidates) == 1:
            return candidates[0], False
        return (g['id'], False) if g['id'] in candidates else (None, True)
    row = rows.get(g['id'])
    if row:
        if (row['status'] == 'done' and row['has_asset'] and not row.get('deleted_at')
                and row['id'] not in trashed and (row.get('job_id') or None) == job):
            return row['id'], False
        return None, True
    return None, False


def plan_trash_restores(generations, author_uids):
    """Return candidate IDs only; release the snapshot before calling trash restore."""
    with get_connection() as conn:
        attach_trash(conn)
        try:
            conn.execute('BEGIN')
            state = _restore_state(conn, generations)
            rows, trashed, _, trash_jobs, _, _ = state
            planned = []
            for g in generations:
                target, blocked = _live_target(g, state)
                if target or blocked:
                    planned.append(None)
                    continue
                job = g.get('job_id') or None
                matches = {row['id']: row for row in trash_jobs.get(job, [])} if job else {}
                if g['id'] in trashed:
                    matches[g['id']] = trashed[g['id']]
                eligible = []
                for row in matches.values():
                    payload = row['parsed']
                    if (payload is None or _failed_payload(payload) or row['id'] in rows
                            or row['creator_uid'] is not None and row['creator_uid'] not in author_uids):
                        continue
                    gen = payload['generation']
                    if (gen.get('status') != 'done' or gen.get('deleted_at')
                            or (gen.get('job_id') or None) != job):
                        continue
                    try:
                        usable = _payload_has_usable_asset(payload)
                    except (TypeError, AttributeError):
                        usable = False
                    if usable:
                        eligible.append(row['id'])
                planned.append(g['id'] if g['id'] in eligible else eligible[0] if len(eligible) == 1 else None)
            # Two envelope entries must not independently revive two rows of one job.
            per_job = {}
            for g, candidate in zip(generations, planned):
                if candidate and g.get('job_id'):
                    per_job.setdefault(g['job_id'], set()).add(candidate)
            return [None if len(per_job.get(g.get('job_id'), ())) > 1 else candidate
                    for g, candidate in zip(generations, planned)]
        finally:
            if conn.in_transaction:
                conn.execute('ROLLBACK')
            detach_trash(conn)


def has_pending_transfer():
    with get_connection() as conn:
        if not trash_transfer.enabled(conn):
            return False
    # Reuse the protocol's check for both the main receipt and prepared trash work.
    with open_transfer_connections() as (main, other, _, _):
        try:
            trash_transfer._assert_pair_quiescent(main, other)
        except trash_transfer.TransferRecoveryRequired:
            return True
    return False


def restore_keep(data, author_uids):
    validate_keep_envelope(data)
    generations = data['generations']
    id_map, rejected, restored = {}, [], 0
    with get_connection() as conn:
        attach_trash(conn)
        try:
            conn.execute('BEGIN IMMEDIATE')
            state = _restore_state(conn, generations)
            rows, trashed, by_job, trash_jobs, _, _ = state
            for g in generations:
                aliases = g.get('scene_ids', [g['id']])
                job = g.get('job_id') or None
                target, blocked = _live_target(g, state)
                if blocked:
                    rejected.extend(aliases)
                    continue
                if target is None:
                    if (any(key in trashed for key in [g['id'], *aliases])
                            or any(not _failed_payload(row['parsed']) for row in trash_jobs.get(job, []))):
                        rejected.extend(aliases)
                        continue
                    if g['source'] == 'server' and g.get('creator_uid') not in author_uids:
                        continue
                    stamp = generation_timestamp(g)
                    columns = ('id', 'job_id', 'prompt', 'display_prompt', 'model', 'creator_uid', 'generator', 'project_id', 'folder_path',
                               'workspace_id', 'workspace_name', 'created_at')
                    conn.execute('INSERT INTO generation(' + ','.join(columns) + ',worker_id,params,sort_ts,workspace_scope,status,origin) '
                                 'VALUES(' + ','.join('?' for _ in range(len(columns) + 4)) + ", 'done', 'synced')",
                                 (*[g.get(k) for k in columns], config.DEFAULT_WORKER_ID,
                                  encoded(g['params']) if g.get('params') is not None else None, stamp, g.get('workspace_scope', 'unknown')))
                    for a in g['assets']:
                        conn.execute('INSERT INTO asset(id,generation_id,type,file_path,source_url,thumbnail_path) VALUES(?,?,?,?,?,?)',
                                     (secrets.token_hex(16), g['id'], a['type'], a['file_path'], a['file_path'], a.get('thumbnail_path')))
                    restored += 1
                    target = g['id']
                    rows[target] = {**g, 'has_asset': True}
                    if job:
                        by_job.setdefault(job, []).append(target)
                id_map.update({alias: target for alias in aliases})
            conn.execute('COMMIT')
        finally:
            if conn.in_transaction:
                conn.execute('ROLLBACK')
            detach_trash(conn)
    return {'id_map': id_map, 'rejected': rejected, 'restored': restored}

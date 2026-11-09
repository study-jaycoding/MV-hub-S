"""Hub notebook transactions. Callers hold scene_writer.writing for mutations.

Connection-taking helpers never commit: startup, restore and identity remap can
include them in their own atomic operation. Legacy rows/archives stay recoverable.
"""
from __future__ import annotations

import json
import secrets
from contextlib import contextmanager

from ..db import get_connection
from .scenes_backup import MAX_SCENE_BYTES, MAX_SCENE_UPSERTS, MAX_SCENE_DELETES, MAX_SYNC_TOTAL_BYTES, _hash, _fork_copy
from ..services.scene_writer import WriterConflict


class StartTooBig(ValueError):
    def __init__(self, ids):
        self.ids = ids
        super().__init__('start_too_big')


def encode(value):
    return json.dumps(value, ensure_ascii=False, separators=(',', ':'), sort_keys=True)


@contextmanager
def transaction():
    with get_connection() as conn:
        conn.execute('BEGIN IMMEDIATE')
        try:
            yield conn
            conn.commit()
        except BaseException:
            conn.rollback()
            raise


def history(conn):
    return conn.execute("SELECT value FROM app_setting WHERE key='scene_history_id'").fetchone()[0]


def started(conn, owner):
    return conn.execute('SELECT notebook_id FROM scene_notebook WHERE owner_uid=?', (owner,)).fetchone()


def is_started(owner):
    with get_connection() as conn:
        return bool(started(conn, owner))


def row_for(conn, owner, project, sid):
    return conn.execute('SELECT * FROM scene_backup WHERE owner_uid=? AND project_id=? AND scene_id=?',
                        (owner, project, sid)).fetchone()


def version(conn, row):
    return {'history_id': history(conn), 'rev': row['rev'], 'hash': row['data_hash']}


def matches(conn, row, base):
    return bool(row and base and base.get('history_id') == history(conn)
                and base.get('rev') == row['rev'] and base.get('hash') == row['data_hash'])


def parsed_scene(item):
    sid, data = item.get('id'), item.get('data')
    if not isinstance(sid, str) or not sid or len(sid) > 200 or not isinstance(data, str):
        raise ValueError('scene id/data required')
    try:
        parsed = json.loads(data)
    except (ValueError, TypeError):
        raise ValueError('invalid scene JSON') from None
    if not isinstance(parsed, dict) or parsed.get('id') != sid:
        raise ValueError('scene id mismatch')
    return parsed


def write_row(conn, owner, project, sid, data, name, deleted_at=None):
    digest = _hash(data)
    conn.execute('''INSERT INTO scene_backup(owner_uid,project_id,scene_id,name,data,data_hash,rev,rev_hash,deleted_at)
        VALUES(?,?,?,?,?,?,1,?,?) ON CONFLICT(owner_uid,project_id,scene_id) DO UPDATE SET
        name=excluded.name,data=excluded.data,data_hash=excluded.data_hash,rev=scene_backup.rev+1,
        rev_hash=excluded.rev_hash,deleted_at=excluded.deleted_at,updated_at=datetime('now')''',
        (owner, project, sid, name, data, digest, digest, deleted_at))
    return row_for(conn, owner, project, sid)


def archive_row(conn, row, reason):
    conn.execute('''INSERT OR IGNORE INTO scene_archive
        (owner_uid,project_id,scene_id,history_id,reason,data_hash,name,data,rev,deleted_at)
        VALUES(?,?,?,?,?,?,?,?,?,?)''',
        (row['owner_uid'], row['project_id'], row['scene_id'], history(conn), reason,
         row['data_hash'], row['name'], row['data'], row['rev'], row['deleted_at']))


def copy_scene(conn, owner, project, sid, data, *, fixed=False, allow_large=False):
    parsed, digest = json.loads(data), _hash(data)
    salt = ''
    for _ in range(32):
        target, body = _fork_copy(sid, parsed, digest, salt)
        copy = json.loads(body)
        copy['name'] = '[옛 창] ' + (parsed.get('name') or '씬')
        # Passive references survive stripping executable recovery fields.
        copy['backupForkOf']['attempts'] = [
            {'card_id': c.get('id'), 'pendingGenerationAttempts': c.get('pendingGenerationAttempts')}
            for c in (parsed.get('cards') or []) if isinstance(c, dict) and c.get('pendingGenerationAttempts')]
        copy['backupForkOf']['comfyRuns'] = parsed.get('comfyRuns')
        copy['backupForkOf']['comfyCardRuns'] = parsed.get('comfyCardRuns')
        body = encode(copy)
        existing = row_for(conn, owner, project, target)
        if existing is None:
            if not (fixed or allow_large) and len(body.encode('utf-8')) > MAX_SCENE_BYTES:
                return None
            return write_row(conn, owner, project, target, body, copy['name'])
        if fixed or (existing['deleted_at'] is None and existing['data_hash'] == _hash(body)):
            return existing
        salt = existing['data_hash'] + ':' + str(existing['rev'])
    raise WriterConflict('copy_collision')


def normalize_legacy(conn, owner=None):
    """Run before any new writer can erase the legacy-change evidence."""
    args = (owner,) if owner is not None else ()
    scope = ' AND s.owner_uid=?' if owner is not None else ''
    rows = conn.execute('SELECT s.* FROM scene_backup s JOIN scene_notebook n ON n.owner_uid=s.owner_uid '
                        'WHERE s.data_hash IS NOT s.rev_hash' + scope, args).fetchall()
    for row in rows:
        conn.execute('''UPDATE scene_backup SET rev=rev+1,rev_hash=data_hash,deleted_at=NULL
            WHERE owner_uid=? AND project_id=? AND scene_id=?''',
            (row['owner_uid'], row['project_id'], row['scene_id']))
    scope = ' AND a.owner_uid=?' if owner is not None else ''
    archives = conn.execute("SELECT a.* FROM scene_archive a JOIN scene_notebook n ON n.owner_uid=a.owner_uid "
                            "WHERE a.reason='legacy_overwrite' AND a.consumed=0" + scope, args).fetchall()
    for saved in archives:
        current = row_for(conn, saved['owner_uid'], saved['project_id'], saved['scene_id'])
        # Physically deleted originals remain deleted; the archive is sufficient.
        if current and current['data_hash'] != saved['data_hash']:
            copy_scene(conn, saved['owner_uid'], saved['project_id'], saved['scene_id'], saved['data'], fixed=True)
        conn.execute('''UPDATE scene_archive SET consumed=1 WHERE owner_uid=? AND project_id=? AND scene_id=?
            AND history_id=? AND reason=? AND data_hash=?''',
            tuple(saved[k] for k in ('owner_uid','project_id','scene_id','history_id','reason','data_hash')))
    reconcile_orders(conn, owner)


def notebook(owner, project=''):
    with transaction() as conn:
        normalize_legacy(conn, owner)
        book = started(conn, owner)
        rows = conn.execute('SELECT * FROM scene_backup WHERE owner_uid=? AND project_id=? ORDER BY scene_id',
                            (owner, project)).fetchall()
        order = conn.execute('SELECT * FROM scene_tab_order WHERE owner_uid=? AND project_id=?', (owner, project)).fetchone()
        return {'notebook_id': book[0] if book else None, 'history_id': history(conn),
                'items': [{'id': r['scene_id'], 'name': r['name'], 'data': r['data'], 'deleted_at': r['deleted_at'],
                           'base': version(conn, r)} for r in rows],
                'order': {'ids': json.loads(order['ids_json']) if order else [r['scene_id'] for r in rows if not r['deleted_at']],
                          'rev': order['rev'] if order else 0, 'history_id': history(conn)}}


def _set_order(conn, owner, project, ids):
    conn.execute('''INSERT INTO scene_tab_order(owner_uid,project_id,ids_json,rev) VALUES(?,?,?,1)
        ON CONFLICT(owner_uid,project_id) DO UPDATE SET ids_json=excluded.ids_json,rev=scene_tab_order.rev+1''',
        (owner, project, encode(ids)))


def reconcile_orders(conn, owner=None):
    """Server-created copies/revivals must also become visible tabs."""
    owners = [owner] if owner is not None else [r[0] for r in conn.execute('SELECT owner_uid FROM scene_notebook')]
    for uid in owners:
        if not started(conn, uid):
            continue
        projects = conn.execute('SELECT project_id FROM scene_backup WHERE owner_uid=? UNION '
                                'SELECT project_id FROM scene_tab_order WHERE owner_uid=?', (uid, uid)).fetchall()
        for project, in projects:
            live = [r[0] for r in conn.execute('SELECT scene_id FROM scene_backup WHERE owner_uid=? AND project_id=? '
                                             'AND deleted_at IS NULL ORDER BY scene_id', (uid, project))]
            row = conn.execute('SELECT ids_json FROM scene_tab_order WHERE owner_uid=? AND project_id=?', (uid, project)).fetchone()
            prior = json.loads(row[0]) if row else []
            live_set = set(live)
            ids = list(dict.fromkeys(s for s in prior + live if s in live_set))
            if row is None or ids != prior:
                _set_order(conn, uid, project, ids)


def establish(conn, owner):
    conn.execute('INSERT OR IGNORE INTO scene_notebook(owner_uid,notebook_id) VALUES(?,?)', (owner, secrets.token_hex(16)))
    conn.execute('UPDATE scene_backup SET rev_hash=data_hash WHERE owner_uid=? AND deleted_at IS NULL', (owner,))


def start(owner, lease_id, body):
    attempt_id, project = body['attempt_id'], body.get('project_id', '')
    items, expected = body.get('upserts', []), body['expected_count']
    oversized = [i['id'] for i in items if len(i['data'].encode('utf-8')) > MAX_SCENE_BYTES]
    if oversized:
        raise StartTooBig(oversized)
    if len(items) > MAX_SCENE_UPSERTS or sum(len(i['data'].encode('utf-8')) for i in items) > MAX_SYNC_TOTAL_BYTES:
        raise ValueError('start chunk limit exceeded')
    for item in items:
        parsed_scene(item)
    if len({i['id'] for i in items}) != len(items):
        raise ValueError('duplicate scene id')
    with transaction() as conn:
        attempt = conn.execute('SELECT * FROM scene_start_attempt WHERE owner_uid=? AND attempt_id=?', (owner, attempt_id)).fetchone()
        if attempt and attempt['status'] == 'committed' and attempt['history_id'] == history(conn):
            return json.loads(attempt['result_json'])
        if started(conn, owner):
            raise WriterConflict('notebook_already_started')
        if attempt:
            if (attempt['lease_id'], attempt['history_id'], attempt['project_id'], attempt['expected_count'], attempt['order_json']) != (
                    lease_id, history(conn), project, expected, encode(body.get('order', []))):
                raise WriterConflict('start_attempt_changed')
        else:
            conn.execute('DELETE FROM scene_start_item WHERE owner_uid=?', (owner,))
            conn.execute('DELETE FROM scene_start_attempt WHERE owner_uid=?', (owner,))
            conn.execute('''INSERT INTO scene_start_attempt
                (owner_uid,attempt_id,project_id,lease_id,history_id,expected_count,order_json) VALUES(?,?,?,?,?,?,?)''',
                (owner, attempt_id, project, lease_id, history(conn), expected, encode(body.get('order', []))))
        for item in items:
            previous = conn.execute('SELECT data_hash FROM scene_start_item WHERE owner_uid=? AND attempt_id=? AND scene_id=?',
                                    (owner, attempt_id, item['id'])).fetchone()
            if previous and previous[0] != _hash(item['data']):
                raise WriterConflict('start_snapshot_changed')
            conn.execute('INSERT OR IGNORE INTO scene_start_item VALUES(?,?,?,?,?)',
                         (owner, attempt_id, item['id'], item['data'], _hash(item['data'])))
        staged = conn.execute('SELECT * FROM scene_start_item WHERE owner_uid=? AND attempt_id=?', (owner, attempt_id)).fetchall()
        if len(staged) > expected:
            raise ValueError('start count exceeded')
        if not body.get('commit'):
            return {'status': 'staging', 'received_count': len(staged), 'attempt_id': attempt_id}
        if len(staged) != expected:
            raise WriterConflict('start_incomplete')
        live = conn.execute('SELECT * FROM scene_backup WHERE owner_uid=? AND deleted_at IS NULL', (owner,)).fetchall()
        if expected == 0:
            if not live:
                raise WriterConflict('empty_notebook')
            oversized = [r['scene_id'] for r in live if len(r['data'].encode('utf-8')) > MAX_SCENE_BYTES]
            if oversized:
                raise StartTooBig(oversized)
            for pid in {r['project_id'] for r in live}:
                _set_order(conn, owner, pid, [r['scene_id'] for r in live if r['project_id'] == pid])
        else:
            order = body.get('order', [])
            if len(order) != expected or set(order) != {r['scene_id'] for r in staged}:
                raise ValueError('start order must contain every staged scene exactly once')
            for row in live:
                archive_row(conn, row, 'before_start')
            # No notebook exists yet, so the legacy-delete trigger cannot fire.
            conn.execute('DELETE FROM scene_backup WHERE owner_uid=? AND deleted_at IS NULL', (owner,))
            for row in staged:
                data = json.loads(row['data'])
                write_row(conn, owner, project, row['scene_id'], row['data'], data.get('name') or '')
            _set_order(conn, owner, project, order)
        establish(conn, owner)
        conn.execute("UPDATE mcp_canvas_task SET status='cancelled',cancel_reason='scene_hidden' WHERE owner_uid=? AND status='pending' "
                     "AND NOT EXISTS(SELECT 1 FROM scene_backup s WHERE s.owner_uid=mcp_canvas_task.owner_uid "
                     "AND s.project_id='' AND s.scene_id=mcp_canvas_task.scene_id AND s.deleted_at IS NULL)", (owner,))
        result = {'status': 'committed', 'attempt_id': attempt_id, 'notebook_id': started(conn, owner)[0], 'history_id': history(conn)}
        conn.execute("UPDATE scene_start_attempt SET status='committed',result_json=? WHERE owner_uid=? AND attempt_id=?",
                     (encode(result), owner, attempt_id))
        conn.execute('DELETE FROM scene_start_item WHERE owner_uid=? AND attempt_id=?', (owner, attempt_id))
        return result


def sync(owner, project, payload):
    upserts, deletes = payload.get('upserts', []), payload.get('deletes', [])
    if len(upserts) > MAX_SCENE_UPSERTS or len(deletes) > MAX_SCENE_DELETES:
        raise ValueError('scene batch limit exceeded')
    if sum(len(i['data'].encode('utf-8')) for i in upserts) > MAX_SYNC_TOTAL_BYTES:
        raise ValueError('scene batch bytes exceeded')
    ids = [i['id'] for i in upserts] + [i['id'] for i in deletes]
    if len(ids) != len(set(ids)):
        raise ValueError('duplicate or overlapping scene intents')
    parsed = {i['id']: parsed_scene(i) for i in upserts}
    for item in deletes:
        if not item.get('intent_id'):
            raise ValueError('delete intent_id required')
    for item in upserts:
        if item.get('revive') and not item.get('intent_id'):
            raise ValueError('revive intent_id required')
    request_id = payload.get('request_id')
    if not request_id:
        raise ValueError('request_id required')
    request_hash = _hash(encode({k: v for k, v in payload.items() if k != 'token'}))
    with transaction() as conn:
        if not started(conn, owner):
            raise WriterConflict('notebook_not_started')
        normalize_legacy(conn, owner)
        receipt = conn.execute('SELECT * FROM scene_request_receipt WHERE owner_uid=? AND project_id=? AND request_id=?',
                               (owner, project, request_id)).fetchone()
        if receipt:
            if receipt['history_id'] != history(conn) or receipt['request_hash'] != request_hash:
                raise WriterConflict('request_id_reused')
            return json.loads(receipt['result_json'])
        results, delete_results, accepted = [], [], set()
        for item in upserts:
            sid, data = item['id'], item['data']
            current, incoming = row_for(conn, owner, project, sid), _hash(data)
            base = item.get('base')
            status, target = 'saved', sid
            if len(data.encode('utf-8')) > MAX_SCENE_BYTES:
                results.append({'id': sid, 'status': 'too_big', 'target_id': None})
                continue
            # A live same-content retry needs no write; a tombstone needs explicit revival.
            if current and not current['deleted_at'] and current['data_hash'] == incoming:
                status, saved = 'same', current
            elif ((current is None and (not base or base.get('hash') == incoming)) or
                  (matches(conn, current, base) and (not current['deleted_at'] or item.get('revive')))):
                saved = write_row(conn, owner, project, sid, data, parsed[sid].get('name') or '')
            else:
                saved = copy_scene(conn, owner, project, sid, data)
                if saved is None:
                    results.append({'id': sid, 'status': 'too_big', 'target_id': None})
                    continue
                status, target = 'copied', saved['scene_id']
            if status != 'copied':
                accepted.add(sid)
            results.append({'id': sid, 'status': status, 'target_id': target, 'base': version(conn, saved),
                            'intent_id': item.get('intent_id')})
        for item in deletes:
            sid = item['id']
            current = row_for(conn, owner, project, sid)
            if current is None or current['deleted_at'] is not None:
                status = 'deleted'
            elif matches(conn, current, item.get('base')):
                conn.execute("UPDATE scene_backup SET deleted_at=datetime('now'),rev=rev+1,rev_hash=data_hash,updated_at=datetime('now') "
                             'WHERE owner_uid=? AND project_id=? AND scene_id=?', (owner, project, sid))
                status = 'deleted'
            else:
                status = 'kept'
            if status == 'deleted' and project == '':
                conn.execute("UPDATE mcp_canvas_task SET status='cancelled',cancel_reason='scene_deleted' "
                             "WHERE owner_uid=? AND scene_id=? AND status='pending'", (owner, sid))
            delete_results.append({'id': sid, 'status': status, 'intent_id': item['intent_id']})
        live_ids = [r[0] for r in conn.execute('SELECT scene_id FROM scene_backup WHERE owner_uid=? AND project_id=? '
                                             'AND deleted_at IS NULL ORDER BY scene_id', (owner, project))]
        previous = conn.execute('SELECT * FROM scene_tab_order WHERE owner_uid=? AND project_id=?', (owner, project)).fetchone()
        old_order = json.loads(previous['ids_json']) if previous else []
        order = payload.get('order')
        requested = order.get('ids', []) if order else []
        if len(requested) != len(set(requested)):
            raise ValueError('duplicate order ids')
        order_matches = order and order.get('history_id') == history(conn) and order.get('rev') == (previous['rev'] if previous else 0)
        candidates = requested if order_matches else old_order + requested
        merged = list(dict.fromkeys(s for s in candidates + live_ids if s in set(live_ids)))
        if previous is None or merged != old_order:
            _set_order(conn, owner, project, merged)
        done = []
        # Receipt is the durable evidence of an append. Cards may since have been
        # intentionally removed: requiring them again would reattach deleted cards.
        for task_id in payload.get('mcp_complete', []):
            task = conn.execute('SELECT * FROM mcp_canvas_task WHERE id=? AND owner_uid=?', (task_id, owner)).fetchone()
            if not task or project != '' or task['scene_id'] not in accepted:
                continue
            saved = row_for(conn, owner, project, task['scene_id'])
            if saved and not saved['deleted_at'] and task_id in json.loads(saved['data']).get('mcpAttachmentReceipts', []):
                if task['status'] in ('pending', 'done'):
                    conn.execute("UPDATE mcp_canvas_task SET status='done',cancel_reason=NULL WHERE id=?", (task_id,))
                    done.append(task_id)
        order_row = conn.execute('SELECT rev FROM scene_tab_order WHERE owner_uid=? AND project_id=?', (owner, project)).fetchone()
        result = {'results': results, 'deletes': delete_results, 'mcp_done': done, 'history_id': history(conn),
                  'order': {'ids': merged, 'rev': order_row[0], 'history_id': history(conn)}}
        conn.execute('INSERT INTO scene_request_receipt VALUES(?,?,?,?,?,?)',
                     (owner, project, request_id, history(conn), request_hash, encode(result)))
        return result


def restore_history(conn):
    """Supported DB replacement is a new history, never a browser bootstrap."""
    normalize_legacy(conn)
    conn.execute("UPDATE app_setting SET value=? WHERE key='scene_history_id'", (secrets.token_hex(16),))
    conn.execute('DELETE FROM scene_request_receipt')
    conn.execute('DELETE FROM scene_start_item')
    conn.execute('DELETE FROM scene_start_attempt')
    owners = [r[0] for r in conn.execute('SELECT DISTINCT owner_uid FROM scene_backup')]
    for owner in owners:
        establish(conn, owner)
        for project, in conn.execute('SELECT DISTINCT project_id FROM scene_backup WHERE owner_uid=?', (owner,)).fetchall():
            if not conn.execute('SELECT 1 FROM scene_tab_order WHERE owner_uid=? AND project_id=?', (owner, project)).fetchone():
                _set_order(conn, owner, project, [r[0] for r in conn.execute('SELECT scene_id FROM scene_backup WHERE owner_uid=? '
                           'AND project_id=? AND deleted_at IS NULL ORDER BY scene_id', (owner, project))])
    reconcile_orders(conn)


def remap(conn, old, new):
    """The identity transaction owns the SQLite write lock; no inner commit."""
    if not any(conn.execute(f'SELECT 1 FROM {table} WHERE owner_uid=? LIMIT 1', (old,)).fetchone()
               for table in ('scene_backup', 'scene_notebook', 'scene_archive', 'scene_tab_order',
                             'scene_start_attempt', 'scene_start_item', 'scene_request_receipt')):
        return 0
    normalize_legacy(conn, old)
    normalize_legacy(conn, new)
    rows = conn.execute('SELECT * FROM scene_backup WHERE owner_uid=?', (old,)).fetchall()
    has_book = started(conn, old) or started(conn, new)
    for row in rows:
        current = row_for(conn, new, row['project_id'], row['scene_id'])
        if not current or (current['deleted_at'] and not row['deleted_at']):
            write_row(conn, new, row['project_id'], row['scene_id'], row['data'], row['name'], row['deleted_at'])
        elif not current['deleted_at'] and not row['deleted_at'] and current['data_hash'] != row['data_hash']:
            # Remap must preserve even a near-limit source whose copy metadata grows.
            archive_row(conn, row, 'remap')
            copy_scene(conn, new, row['project_id'], row['scene_id'], row['data'], allow_large=True)
    conn.execute('DELETE FROM scene_backup WHERE owner_uid=?', (old,))
    for row in conn.execute('SELECT * FROM scene_tab_order WHERE owner_uid=?', (old,)).fetchall():
        current = conn.execute('SELECT ids_json FROM scene_tab_order WHERE owner_uid=? AND project_id=?', (new, row['project_id'])).fetchone()
        ids = (json.loads(current[0]) if current else []) + json.loads(row['ids_json'])
        ids += [r[0] for r in conn.execute('SELECT scene_id FROM scene_backup WHERE owner_uid=? AND project_id=? AND deleted_at IS NULL',
                                         (new, row['project_id']))]
        live = {r[0] for r in conn.execute('SELECT scene_id FROM scene_backup WHERE owner_uid=? AND project_id=? AND deleted_at IS NULL',
                                          (new, row['project_id']))}
        _set_order(conn, new, row['project_id'], list(dict.fromkeys(s for s in ids if s in live)))
    conn.execute('UPDATE OR IGNORE scene_archive SET owner_uid=? WHERE owner_uid=?', (new, old))
    conn.execute('DELETE FROM scene_archive WHERE owner_uid=?', (old,))
    conn.execute('DELETE FROM scene_notebook WHERE owner_uid=?', (old,))
    for table in ('scene_start_attempt', 'scene_start_item', 'scene_tab_order', 'scene_request_receipt'):
        conn.execute(f'DELETE FROM {table} WHERE owner_uid=?', (old,))
    if has_book:
        establish(conn, new)
        reconcile_orders(conn, new)
    if rows or has_book:
        conn.execute('UPDATE scene_backup SET rev=rev+1,rev_hash=data_hash WHERE owner_uid=?', (new,))
        conn.execute("UPDATE app_setting SET value=? WHERE key='scene_history_id'", (secrets.token_hex(16),))
        conn.execute('DELETE FROM scene_request_receipt')
        conn.execute('DELETE FROM scene_start_item')
        conn.execute('DELETE FROM scene_start_attempt')
    return len(rows)


def cleanup(conn, owner):
    for table in ('scene_notebook', 'scene_backup', 'scene_archive', 'scene_start_item',
                  'scene_start_attempt', 'scene_tab_order', 'scene_request_receipt'):
        conn.execute(f'DELETE FROM {table} WHERE owner_uid=?', (owner,))

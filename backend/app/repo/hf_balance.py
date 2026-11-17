"""Immutable observations and the durable, account/target-scoped forwarding queue."""
from __future__ import annotations

import time
import uuid
import json
import sqlite3
from datetime import datetime, timedelta, timezone

from .. import db_hf_balance
from ..hf_balance_contract import FIELDS, amount, normalize, payload_hash, validate_batch


def observed_iso(view):
    at = view['observed_at_ms']
    return datetime.fromtimestamp(at / 1000, timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z') if at is not None else None


def balance_snapshot(conn, workspace_ids, as_of_ms=None):
    """Reporter-free views; preserve the caller transaction or finish an owned read snapshot."""
    own_snapshot = not conn.in_transaction
    if own_snapshot:
        conn.execute('BEGIN')
    try:
        return _balance_snapshot(conn, workspace_ids, as_of_ms)
    finally:
        if own_snapshot:
            conn.rollback()


def _balance_snapshot(conn, workspace_ids, as_of_ms):
    at = int(time.time() * 1000) if as_of_ms is None else as_of_ms
    exists = conn.execute("SELECT 1 FROM sqlite_master WHERE name='hf_balance_obs'").fetchone()
    views = {}
    for wid in dict.fromkeys(workspace_ids):
        row = latest(conn, wid) if exists else None
        view = dict(workspace_id=wid, credits_c=None, credits=None, observation_id=None, source=None,
                    basis='unavailable', observed_at_ms=None, received_at_ms=None, time_basis='received',
                    time_quality='unavailable', precision_kind=None, precision_error_c=None,
                    age_ms=None, stale=True, reason_codes=[])
        if row and row['basis'] == 'observed':
            for key in ('credits_c', 'observation_id', 'source', 'basis', 'observed_at_ms', 'received_at_ms',
                        'time_quality', 'precision_kind', 'precision_error_c'):
                view[key] = row[key]
            age = max(0, at - row['observed_at_ms'])
            view.update(time_basis='agent', age_ms=age, stale=age > 900000)
            if view['stale']:
                view['reason_codes'].append('stale_observation')
            if row['precision_error_c'] is None:
                view['reason_codes'].append('precision_unknown')
        elif row:
            view.update(basis='conflict', time_quality='conflict', reason_codes=['simultaneous_conflict'])
        else:
            legacy = conn.execute('SELECT credits,last_seen_at FROM workspace_registry WHERE id=?', (wid,)).fetchone()
            try:
                cents = amount(legacy['credits'])[0] if legacy else None
            except ValueError:
                cents = None
            if cents is not None:
                view.update(credits_c=cents, basis='legacy_snapshot', time_quality='legacy', reason_codes=['legacy_snapshot'])
                try:
                    received = datetime.fromisoformat(legacy['last_seen_at'].replace('Z', '+00:00'))
                    view['received_at_ms'] = int((received if received.tzinfo else received.replace(tzinfo=timezone.utc)).timestamp() * 1000)
                except (TypeError, ValueError, AttributeError):
                    pass
            else:
                view['reason_codes'] = ['no_observation']
        view['credits'] = view['credits_c'] / 100 if view['credits_c'] is not None else None
        views[wid] = view
    return views


def partial_totals(views):
    views = list(views)
    unknown = sum(v['credits_c'] is None for v in views)
    legacy = sum(v['basis'] == 'legacy_snapshot' for v in views)
    stale = sum(v['basis'] == 'observed' and v['stale'] for v in views)
    return dict(known_subtotal_c=sum(v['credits_c'] for v in views if v['credits_c'] is not None),
                unknown_workspace_count=unknown, legacy_workspace_count=legacy, stale_workspace_count=stale,
                complete=unknown == 0, fresh=unknown == 0 and legacy == 0 and stale == 0)


def latest(conn, workspace_id):
    try:
        return _latest(conn, workspace_id)
    except sqlite3.OperationalError:
        if db_hf_balance.schema_error(conn):
            return None
        raise


def _latest(conn, workspace_id):
    row = conn.execute("SELECT * FROM hf_balance_obs WHERE workspace_id=? AND time_quality='reported' "
                       "ORDER BY observed_at_ms DESC,observation_id DESC LIMIT 1", (workspace_id,)).fetchone()
    if row is None:
        return None
    if not {'observation_id','source','credits_c','observed_at_ms','received_at_ms','time_quality',
            'precision_kind','precision_error_c'}.issubset(row.keys()):
        return None
    conflict = conn.execute("SELECT 1 FROM hf_balance_obs WHERE workspace_id=? AND time_quality='reported' "
                            'AND observed_at_ms=? AND credits_c<>? LIMIT 1',
                            (workspace_id,row['observed_at_ms'],row['credits_c'])).fetchone()
    if conflict:
        return {'basis': 'conflict', 'credits_c': None}
    return {**dict(row), 'basis': 'observed'}


def mirror(conn, workspace_id, day=None):
    selected = latest(conn, workspace_id)
    if not selected or selected['basis'] != 'observed' or not conn.execute('SELECT 1 FROM workspace_registry WHERE id=?', (workspace_id,)).fetchone():
        return
    conn.execute('UPDATE workspace_registry SET credits=? WHERE id=?',
                 (selected['credits_c'] / 100, workspace_id))
    # Only actual observed days are written. Arrival/retry order never defines first/last.
    if day is None:
        day = datetime.fromtimestamp(selected['observed_at_ms']/1000, timezone(timedelta(hours=9))).date().isoformat()
    start = int(datetime.fromisoformat(day).replace(tzinfo=timezone(timedelta(hours=9))).timestamp()*1000)
    query = ("SELECT credits_c,observed_at_ms FROM hf_balance_obs WHERE workspace_id=? "
             "AND time_quality='reported' AND observed_at_ms>=? AND observed_at_ms<? ")
    args = (workspace_id,start,start+86400000)
    first = conn.execute(query+'ORDER BY observed_at_ms,observation_id LIMIT 1',args).fetchone()
    last = conn.execute(query+'ORDER BY observed_at_ms DESC,observation_id DESC LIMIT 1',args).fetchone()
    if first is not None:
        conn.execute('INSERT INTO workspace_balance_daily(workspace_id,day,credits,first_credits,seen_at) '
                     "VALUES(?,?,?,?,datetime(?/1000.0,'unixepoch')) ON CONFLICT(workspace_id,day) DO UPDATE SET "
                     'credits=excluded.credits,first_credits=excluded.first_credits,seen_at=excluded.seen_at',
                     (workspace_id,day,last[0]/100,first[0]/100,last[1]))


def store(conn, reporter_key, reporter_uid, version, observations, *, target=None,
          receiver='server', received_at_ms=None, changes=None):
    validate_batch(version, observations)
    db_hf_balance.validate(conn)
    now = received_at_ms if received_at_ms is not None else int(time.time()*1000)
    row = conn.execute("SELECT value FROM app_setting WHERE key='balance_database_id'").fetchone()
    database_id = row[0] if row else str(uuid.uuid4())
    if not row:
        conn.execute("INSERT INTO app_setting(key,value) VALUES('balance_database_id',?)", (database_id,))
    receipt = dict(version=1, receiver_kind=receiver, receiver_database_id=database_id,
                   stored=[], conflicts=[], rejected=[])
    workspaces = set()
    for raw in observations:
        try:
            item, kind, error = normalize(raw)
        except ValueError as exc:
            rejection = {'observation_id': raw.get('observation_id') if isinstance(raw, dict) else None,
                         'code': str(exc)}
            if isinstance(raw, dict):
                try:
                    rejection['payload_sha256'] = payload_hash(raw)
                except (ValueError,TypeError):
                    pass
            receipt['rejected'].append(rejection)
            continue
        digest = payload_hash(item)
        key = item['observation_id']
        existing = conn.execute('SELECT * FROM hf_balance_obs WHERE observation_id=? OR '
                                '(reporter_key=? AND collector_id=? AND collection_seq=? AND workspace_id=? AND source=?)',
                                (key, reporter_key, item['collector_id'], item['collection_seq'],
                                 item['workspace_id'], item['source'])).fetchall()
        entry = {'observation_id': key, 'payload_sha256': digest}
        if existing and any(r['observation_id'] != key or r['reporter_key'] != reporter_key or
                            r['payload_sha256'] != digest for r in existing):
            receipt['conflicts'].append(entry)
            continue
        if existing:
            first_received = existing[0]['received_at_ms']
        else:
            first_received = now
            quality = ('reversed' if item['observed_at_ms'] < item['started_at_ms'] else
                       'future' if item['observed_at_ms'] > now + 300000 else 'reported')
            if quality == 'reported':
                query = ("SELECT observed_at_ms FROM hf_balance_obs WHERE reporter_key=? AND collector_id=? "
                         "AND workspace_id=? AND time_quality='reported' AND collection_seq")
                args = (reporter_key,item['collector_id'],item['workspace_id'],item['collection_seq'])
                before = conn.execute(query+'<? ORDER BY collection_seq DESC LIMIT 1',args).fetchone()
                after = conn.execute(query+'>? ORDER BY collection_seq LIMIT 1',args).fetchone()
                if ((before and before[0]>item['observed_at_ms']) or
                        (after and after[0]<item['observed_at_ms'])):
                    quality = 'reversed'
            local = raw.get('local_received_at_ms') if receiver == 'server' else now
            if local is not None and (type(local) is not int or local < 0 or local > now+300000):
                receipt['rejected'].append({**entry, 'code': 'invalid_local_receipt'})
                continue
            columns = list(FIELDS) + ['protocol_version', 'reporter_key', 'reporter_uid',
                                     'local_received_at_ms', 'received_at_ms', 'time_quality',
                                     'precision_kind', 'precision_error_c', 'payload_sha256']
            values = [item[k] for k in FIELDS] + [1, reporter_key, reporter_uid, local, now, quality, kind, error, digest]
            conn.execute(f"INSERT INTO hf_balance_obs({','.join(columns)}) VALUES({','.join('?' for _ in columns)})", values)
            if changes is not None:
                changes.append(key)
        if target:
            conn.execute('INSERT INTO hf_balance_outbox(account_key,target_key,observation_id,queued_at_ms) '
                         'VALUES(?,?,?,?) ON CONFLICT DO NOTHING', (reporter_key, target, key, now))
        receipt['stored'].append({**entry, 'received_at_ms': first_received})
        if (existing and existing[0]['time_quality'] == 'reported') or (not existing and quality == 'reported'):
            day = datetime.fromtimestamp(item['observed_at_ms']/1000, timezone(timedelta(hours=9))).date().isoformat()
            workspaces.add((item['workspace_id'], day))
    for workspace, day in workspaces:
        mirror(conn, workspace, day)
    return receipt


def claim(conn, account_key, target, now, limit=100):
    """Caller holds a short write transaction; never retain it across HTTP."""
    db_hf_balance.validate(conn)
    predicate = "q.state<>'acked' AND account_key=? AND target_key=? AND next_retry_at_ms<=? AND (state IN ('pending','unsupported') OR (state='sending' AND lease_until_ms<=?))"
    args = (account_key, target, now, now)
    gate = conn.execute("SELECT MAX(next_retry_at_ms) FROM hf_balance_outbox WHERE account_key=? AND target_key=? AND state='unsupported'",
                        (account_key, target)).fetchone()[0]
    if gate and gate > now:
        return []
    source = 'hf_balance_outbox q INDEXED BY idx_hf_balance_outbox_active JOIN hf_balance_obs b ON b.observation_id=q.observation_id'
    recent = conn.execute(f'SELECT q.observation_id FROM {source} WHERE {predicate} ORDER BY b.observed_at_ms DESC,q.queued_at_ms DESC,q.observation_id LIMIT ?', (*args, limit//2)).fetchall()
    oldest = conn.execute(f'SELECT q.observation_id FROM {source} WHERE {predicate} ORDER BY q.queued_at_ms,b.observed_at_ms,q.observation_id LIMIT ?', (*args, limit)).fetchall()
    ids = list(dict.fromkeys(row[0] for row in [*recent, *oldest]))[:limit]
    rows = []
    wire_items = []
    for key in ids:
        item = dict(conn.execute('SELECT * FROM hf_balance_obs WHERE observation_id=?', (key,)).fetchone())
        wire = {**{field: item[field] for field in FIELDS}, 'local_received_at_ms': item['received_at_ms']}
        if len(json.dumps({'version':1,'account_email':account_key,'observations':[*wire_items,wire]}).encode()) > 262144:
            break
        wire_items.append(wire)
        lease = str(uuid.uuid4())
        conn.execute("UPDATE hf_balance_outbox SET state='sending',lease_token=?,lease_until_ms=?,attempts=attempts+1,last_attempt_at_ms=? "
                     'WHERE account_key=? AND target_key=? AND observation_id=?', (lease, now+120000, now, account_key, target, key))
        item.update(lease_token=lease, target_key=target, account_key=account_key)
        rows.append(item)
    return rows


def settle(conn, rows, receipt, now, *, code=None):
    db_hf_balance.validate(conn)
    stored = {r['observation_id'] for r in (receipt or {}).get('stored', [])}
    conflicts = {r['observation_id'] for r in (receipt or {}).get('conflicts', [])}
    for row in rows:
        key = row['observation_id']
        state = 'acked' if key in stored else 'conflict' if key in conflicts else 'unsupported' if code == 'unsupported' else 'pending'
        streak_row = conn.execute('SELECT fail_streak FROM hf_balance_outbox WHERE account_key=? AND target_key=? AND observation_id=?',
                                 (row['account_key'], row['target_key'], key)).fetchone()
        streak = (streak_row[0] if streak_row else 0) + 1
        retry = now + (600000 if state == 'unsupported' else min(3600000, 1000 * 2**min(streak, 12)))
        conn.execute('UPDATE hf_balance_outbox SET state=?,fail_streak=?,next_retry_at_ms=?,lease_token=NULL,lease_until_ms=NULL,'
                     'acked_at_ms=?,receiver_database_id=?,last_error_code=? WHERE account_key=? AND target_key=? AND observation_id=? AND lease_token=?',
                     (state, 0 if state == 'acked' else streak, retry, now if state == 'acked' else None,
                      (receipt or {}).get('receiver_database_id'), None if state == 'acked' else code or 'not_acknowledged',
                      row['account_key'], row['target_key'], key, row['lease_token']))


def outbox_status(conn):
    row = conn.execute("SELECT COUNT(*),COALESCE(SUM(fail_streak>0),0),"
                       "COALESCE(SUM(state='conflict'),0),COALESCE(SUM(state='unsupported'),0),"
                       "MIN(queued_at_ms) FROM hf_balance_outbox INDEXED BY idx_hf_balance_outbox_active "
                       "WHERE state<>'acked'").fetchone()
    success = conn.execute("SELECT acked_at_ms FROM hf_balance_outbox WHERE state='acked' "
                           "ORDER BY acked_at_ms DESC LIMIT 1").fetchone()
    error = conn.execute("SELECT last_error_code FROM hf_balance_outbox INDEXED BY idx_hf_balance_outbox_active "
                         "WHERE state<>'acked' AND last_error_code IS NOT NULL "
                         "ORDER BY last_attempt_at_ms DESC LIMIT 1").fetchone()
    return dict(zip(('balance_pending','balance_failed','balance_conflict','balance_unsupported',
                     'balance_oldest_pending_at_ms'), row)) | {
                         'balance_last_success_at_ms':success[0] if success else None,
                         'balance_last_error_code':error[0] if error else None}

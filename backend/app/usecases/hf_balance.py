"""Balance storage orchestration, independent of FastAPI."""
from __future__ import annotations

from .. import db, db_hf_balance
from ..emailnorm import norm_email
from ..repo import hf_balance


def receive(account, email, version, observations, *, target=None, receiver='server'):
    email = norm_email(email)
    if not email or email != norm_email(account.get('email')):
        raise ValueError('account_mismatch')
    with db.get_connection() as conn:
        conn.execute('BEGIN IMMEDIATE')
        changes = []
        receipt = hf_balance.store(conn, email, account.get('creator_uid'), version, observations,
                                   target=target, receiver=receiver, changes=changes)
        return receipt, bool(changes)


def delivery_status():
    with db.get_connection() as conn:
        error = db_hf_balance.schema_error(conn)
        metadata = dict(balance_write_enabled=error is None, balance_error_code=error)
        exists = conn.execute("SELECT 1 FROM sqlite_master WHERE name='hf_balance_outbox'").fetchone()
        if not exists or error:
            return metadata
        return {**hf_balance.outbox_status(conn), **metadata}


def balances(email, workspace_id=None, *, read_all=False, at=None):
    with db.get_connection() as conn:
        conn.execute('BEGIN')
        own = [r[0] for r in conn.execute('SELECT workspace_id FROM workspace_member WHERE account_email=? AND is_available=1',
                                        (norm_email(email),))]
        if workspace_id is not None and workspace_id not in own and not read_all:
            raise PermissionError('workspace_membership')
        views = hf_balance.balance_snapshot(conn, [workspace_id] if workspace_id else own, at)
    return list(views.values())


def account_workspaces(email, reported):
    reported = reported or []
    if not any(isinstance(w, dict) and str(w.get('name') or '').strip() for w in reported):
        return reported
    with db.get_connection() as conn:
        conn.execute('BEGIN')
        tables = {r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('workspace_registry','workspace_member')")}
        if len(tables) != 2:
            return reported
        names = {r['id']: dict(id=r['id'], name=r['name'], plan_type=r['plan_type'],
                              user_role=r['user_role'], is_selected=bool(r['is_selected'])) for r in conn.execute(
                 'SELECT w.id,w.name,w.plan_type,m.user_role,m.is_selected FROM workspace_registry w '
                 'JOIN workspace_member m ON m.workspace_id=w.id WHERE m.account_email=? AND m.is_available=1', (norm_email(email),))}
        views = hf_balance.balance_snapshot(conn, names)
    result = []
    for raw in reported:
        if not isinstance(raw, dict) or not str(raw.get('name') or '').strip():
            result.append(raw)
            continue
        wid = str(raw.get('id') or '')
        if wid in names:
            result.append({**raw, **names[wid], 'credits':views[wid]['credits'], 'balance_meta':views[wid]})
    return result

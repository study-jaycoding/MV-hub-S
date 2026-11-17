"""Balance storage orchestration, independent of FastAPI."""
from __future__ import annotations

from .. import db
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
        exists = conn.execute("SELECT 1 FROM sqlite_master WHERE name='hf_balance_outbox'").fetchone()
        if not exists:
            return {}
        return hf_balance.outbox_status(conn)


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
    raw = {str(w['id']): w for w in reported or [] if isinstance(w, dict) and w.get('id')}
    with db.get_connection() as conn:
        conn.execute('BEGIN')
        names = {r['id']: dict(id=r['id'], name=r['name'], plan_type=r['plan_type'],
                              user_role=r['user_role'], is_selected=bool(r['is_selected'])) for r in conn.execute(
                 'SELECT w.id,w.name,w.plan_type,m.user_role,m.is_selected FROM workspace_registry w '
                 'JOIN workspace_member m ON m.workspace_id=w.id WHERE m.account_email=? AND m.is_available=1', (norm_email(email),))}
        views = hf_balance.balance_snapshot(conn, names)
    return [{**raw.get(wid, {}), **names[wid], 'credits': view['credits'], 'balance_meta': view} for wid,view in views.items()]

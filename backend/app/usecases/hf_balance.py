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

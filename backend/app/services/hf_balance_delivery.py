"""Durable balance forwarding; transport is injected by the router composition root."""
from __future__ import annotations

import time
from urllib.parse import urlsplit

from .. import config, db, db_hf_balance
from ..emailnorm import norm_email
from ..hf_balance_contract import FIELDS, matching_ack
from ..repo import hf_balance
from . import shared_connection


def enabled():
    import os
    return (config.MANAGE_ENABLED and not config.AUTH_ENABLED and not config.READ_ONLY
            and config.EXTERNAL_RECOVERY_ENABLED
            and os.environ.get('CONTENT_HUB_NO_PROXY', '').lower() not in ('1','true','yes','on'))


def drain(push, *, account_key, target, current, clock=None):
    account_key = norm_email(account_key)
    if not enabled() or not account_key or not target:
        return {'pushed': 0}
    clock = clock or (lambda: int(time.time()*1000))
    def unchanged():
        account, url = current()
        return norm_email(account) == account_key and url == target and enabled()
    if not unchanged():
        return {'pushed': 0}
    # HTTPS upgrades use the current address; never replay the stored HTTP address.
    with db.get_connection() as conn:
        if db_hf_balance.schema_error(conn):
            return {'pushed': 0, 'error_code': 'balance_schema_mismatch'}
        conn.execute('BEGIN IMMEDIATE')
        targets = conn.execute("SELECT DISTINCT target_key FROM hf_balance_outbox INDEXED BY idx_hf_balance_outbox_active WHERE account_key=? AND state<>'acked'", (account_key,)).fetchall()
        rows = []
        for (queued_target,) in targets:
            if (not shared_connection.same_shared_server(queued_target, target)
                    or (urlsplit(queued_target).scheme == 'https' and urlsplit(target).scheme != 'https')):
                continue
            rows += hf_balance.claim(conn, account_key, queued_target, clock(), max(0, 100-len(rows)))
            if len(rows) >= 100:
                break
    if not rows:
        return {'pushed': 0}
    items = [{**{k: row[k] for k in FIELDS}, 'local_received_at_ms': row['received_at_ms']} for row in rows]
    receipt, code = None, None
    try:
        if not unchanged():
            raise ValueError('connection_changed')
        response = push({'version': 1, 'account_email': account_key, 'observations': items})
        receipt = matching_ack(response, items, 'server')
        if not unchanged():
            raise ValueError('connection_changed')
    except Exception as exc:
        receipt = None
        code = 'unsupported' if getattr(exc, 'status_code', None) in (404,405) or str(exc) == 'invalid_ack' else 'delivery_failed'
    with db.get_connection() as conn:
        conn.execute('BEGIN IMMEDIATE')
        hf_balance.settle(conn, rows, receipt, clock(), code=code)
    return {'pushed': len(receipt['stored']) if receipt else 0, 'failed': len(rows) if not receipt else 0}

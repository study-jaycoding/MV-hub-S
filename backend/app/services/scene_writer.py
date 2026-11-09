"""Single-process canvas leases. Lock order: account transition -> lease -> SQLite.

No timer or WS disconnect grants ownership. Every mutation revalidates the lease
inside the same critical section that commits its database transaction.
"""
from __future__ import annotations

import hashlib
import os
import secrets
import threading
import time
from contextlib import contextmanager
from dataclasses import dataclass

from .. import active_account, config, db

TTL_SECONDS = 90.0
HANDOFF_SECONDS = 5.0


class WriterConflict(ValueError):
    def __init__(self, code: str):
        self.code = code
        super().__init__(code)


def enabled() -> bool:
    # 로컬 허브 기본 켬(Jay 2026-11-10). CONTENT_HUB_SCENE_WRITER=0 = 현장에서 옛 계약으로 끄는 스위치.
    return not config.AUTH_ENABLED and os.environ.get('CONTENT_HUB_SCENE_WRITER', '1') != '0'


@dataclass
class Lease:
    token: str
    browser_id: str
    tab_id: str
    epoch: int
    expires: float
    generation: str


class SceneWriter:
    def __init__(self, clock=time.monotonic):
        self.boot_id = secrets.token_hex(16)
        self.clock = clock
        self._registry_lock = threading.Lock()
        self._locks: dict[tuple, threading.RLock] = {}
        self._leases: dict[tuple, Lease] = {}
        self._requests: dict[tuple, dict] = {}

    def key(self, owner):
        return (str(db.get_db_path().resolve()), active_account.account_key() or '', owner)

    @contextmanager
    def locked(self, owner):
        with active_account.transition_lock:
            key = self.key(owner)
            with self._registry_lock:
                lock = self._locks.setdefault(key, threading.RLock())
            with lock:
                yield key

    def current(self, key):
        lease = self._leases.get(key)
        if lease and (lease.epoch != active_account.account_epoch() or lease.expires <= self.clock()):
            self._leases.pop(key, None)
            lease = None
        return lease

    def require(self, key, token):
        lease = self.current(key)
        if not lease or not token or not secrets.compare_digest(lease.token, token):
            raise WriterConflict('writer_required')
        return lease

    @contextmanager
    def writing(self, owner, token):
        with self.locked(owner) as key:
            yield self.require(key, token)

    @contextmanager
    def closing(self, owner, token):
        """Commit pending edits before another writer can claim the account.

        A failed write keeps the lease. Do not recheck its clock after the DB
        commit: the same lock has excluded renewal, takeover and account changes.
        """
        with self.locked(owner) as key:
            yield self.require(key, token)
            self._leases.pop(key, None)

    def action(self, owner, action, browser_id='', tab_id='', token=None, request_id=None):
        with self.locked(owner) as key:
            lease = self.current(key)
            now = self.clock()
            if action == 'status':
                return self._status(key)
            if action == 'release':
                self.require(key, token)
                self._leases.pop(key, None)
                return self._status(key)
            if action == 'renew':
                lease = self.require(key, token)
                lease.expires = now + TTL_SECONDS
                return self._status(key, include_token=True)
            if not browser_id or not tab_id:
                raise ValueError('browser_id and tab_id required')
            if action == 'request':
                pending = self._requests.get(key)
                generation = lease.generation if lease else None
                if not pending or (pending['browser_id'], pending['tab_id'], pending['generation']) != (browser_id, tab_id, generation):
                    pending = dict(request_id=secrets.token_hex(16), browser_id=browser_id,
                                   tab_id=tab_id, generation=generation, requested_at=now)
                    self._requests[key] = pending
                return {**self._status(key), 'request_id': pending['request_id'],
                        'force_after_ms': max(0, int((pending['requested_at'] + HANDOFF_SECONDS - now) * 1000))}
            if action == 'force':
                pending = self._requests.get(key)
                if not pending or pending['request_id'] != request_id or (pending['browser_id'], pending['tab_id']) != (browser_id, tab_id):
                    raise WriterConflict('handoff_request_required')
                if lease and pending['generation'] != lease.generation:
                    raise WriterConflict('writer_changed')
                if now < pending['requested_at'] + HANDOFF_SECONDS:
                    raise WriterConflict('handoff_wait')
            elif action == 'claim':
                if lease:
                    if token:
                        self.require(key, token)
                        lease.expires = now + TTL_SECONDS
                        return self._status(key, include_token=True)
                    raise WriterConflict('writer_busy')
            else:
                raise ValueError('unknown writer action')
            value = secrets.token_urlsafe(32)
            self._leases[key] = Lease(value, browser_id, tab_id, active_account.account_epoch(),
                                      now + TTL_SECONDS, hashlib.sha256(value.encode()).hexdigest())
            self._requests.pop(key, None)
            return self._status(key, include_token=True)

    def _status(self, key, include_token=False):
        lease = self.current(key)
        result = {'boot_id': self.boot_id, 'account_epoch': active_account.account_epoch(),
                  'writer': None, 'handoff': self._requests.get(key)}
        if lease:
            result['writer'] = {'browser_id': lease.browser_id, 'tab_id': lease.tab_id,
                                'generation': lease.generation,
                                'expires_in_ms': max(0, int((lease.expires - self.clock()) * 1000))}
            if include_token:
                result['token'] = lease.token
        return result


writer = SceneWriter()

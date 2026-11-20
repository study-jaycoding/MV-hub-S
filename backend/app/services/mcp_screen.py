"""Ephemeral external-screen capabilities. No panel turns, persistence or command replay."""
from __future__ import annotations

import hashlib
import hmac
import secrets
import threading
import time
from dataclasses import dataclass, field
from typing import Any

from fastapi import HTTPException

PRESENCE_SECONDS = 25.0
ACTION_SECONDS = 30.0
LIMITS = {"canvas.create_nodes": 10, "canvas.connect": 20, "library.set_hidden": 100}


def digest(value: str) -> str:
    return hashlib.sha256(value.encode()).hexdigest()


def refuse(code: str, status=409):
    raise HTTPException(status, code, headers={"X-MVHub-MCP-Error": code})


@dataclass
class Receiver:
    id: str
    secret_hash: str
    binding: tuple
    account: str
    context: Any
    seq: int
    epoch: int
    workspace: dict
    scene_id: str | None
    visible: bool
    enabled: bool
    expires: float


@dataclass
class Action:
    id: str
    receiver: Receiver
    epoch: int
    context: Any
    name: str
    args: dict
    expires: float
    state: str = "pending"
    token_hash: str = ""
    result: dict | None = None
    ended: float = 0
    settled: threading.Event = field(default_factory=threading.Event)


class ScreenService:
    def __init__(self, clock=time.monotonic):
        self.clock = clock
        self.lock = threading.RLock()
        self.receivers: dict[str, Receiver] = {}
        self.selected: dict[str, str] = {}
        self.tickets: dict[str, tuple] = {}
        self.actions: dict[str, Action] = {}
        self.usage: list[tuple] = []
        self.requests: list[tuple] = []

    def _close(self, action, result=None):
        if action.settled.is_set():
            return
        status = "unknown" if action.state == "claimed" else "expired_unclaimed"
        summary = "화면 실행 여부를 확인하지 못했어요. 화면을 확인하고 자동 재실행하지 마세요." if status == "unknown" else "화면이 받기 전에 기한이 지났어요."
        action.result = result or {"status": status, "ok": False, "summary": summary, "data": {}}
        action.state = action.result["status"]
        action.ended = self.clock()
        action.settled.set()

    def _clean(self):
        now = self.clock()
        for action in self.actions.values():
            if action.expires <= now:
                self._close(action)
        self.receivers = {k: r for k, r in self.receivers.items() if r.expires > now}
        self.tickets = {k: v for k, v in self.tickets.items() if v[-1] > now}
        self.usage = [v for v in self.usage if v[0] > now - 60]
        self.requests = [v for v in self.requests if v[0] > now - 60]
        ended = sorted((a for a in self.actions.values() if a.settled.is_set()), key=lambda a: a.ended, reverse=True)
        keep = {a.id for a in ended[:256] if a.ended > now - 60}
        self.actions = {k: a for k, a in self.actions.items() if not a.settled.is_set() or k in keep}

    def register(self, binding, account, context, body):
        with self.lock:
            self._clean()
            if any(r.account == account and (r.binding[:4], r.binding[6]) != (binding[:4], binding[6]) for r in self.receivers.values()):
                self.invalidate(account)
            if len(self.receivers) >= 128 or sum(r.account == account for r in self.receivers.values()) >= 16:
                refuse("screen_busy", 429)
            secret = secrets.token_urlsafe(32)
            r = Receiver(secrets.token_urlsafe(24), digest(secret), binding, account, context,
                         body.seq, body.epoch, body.workspace.model_dump(include={"scope", "id"}), body.scene_id,
                         body.visible, body.enabled, self.clock() + PRESENCE_SECONDS)
            self.receivers[r.id] = r
            if body.select:
                self.selected[account] = r.id
            return r, secret

    def invalidate(self, account=None):
        with self.lock:
            ids = {r.id for r in self.receivers.values() if account is None or r.account == account}
            self.receivers = {k: r for k, r in self.receivers.items() if k not in ids}
            self.tickets = {k: t for k, t in self.tickets.items() if t[1] not in ids}
            self.selected = {k: v for k, v in self.selected.items() if account is not None and k != account}
            for a in self.actions.values():
                if a.receiver.id in ids:
                    self._close(a)
            self._clean()

    def authenticate(self, receiver_id, secret, binding):
        with self.lock:
            self._clean()
            r = self.receivers.get(receiver_id)
            if not r or r.binding != binding or not hmac.compare_digest(r.secret_hash, digest(secret)):
                refuse("screen_receiver_invalid", 403)
            return r

    def update(self, r, body):
        with self.lock:
            if body.seq <= r.seq:
                refuse("screen_stale")
            ws = body.workspace.model_dump(include={"scope", "id"})
            changed = (ws, body.scene_id, body.visible, body.enabled) != (r.workspace, r.scene_id, r.visible, r.enabled)
            if body.epoch < r.epoch or (changed and body.epoch <= r.epoch):
                refuse("screen_stale")
            r.seq, r.epoch = body.seq, body.epoch
            r.workspace, r.scene_id, r.visible, r.enabled = ws, body.scene_id, body.visible, body.enabled
            r.expires = self.clock() + PRESENCE_SECONDS
            if body.select:
                if not r.visible or not r.enabled:
                    refuse("screen_unavailable")
                self.selected[r.account] = r.id
            for a in self.actions.values():
                if a.receiver is r and (a.epoch != r.epoch or not r.visible or not r.enabled):
                    self._close(a)

    def target(self, account):
        with self.lock:
            self._clean()
            candidates = [r for r in self.receivers.values() if r.account == account and r.visible and r.enabled]
            selected = self.selected.get(account)
            if selected:
                candidates = [r for r in candidates if r.id == selected]
            if not candidates:
                refuse("screen_unavailable")
            if len(candidates) != 1:
                refuse("screen_ambiguous")
            return candidates[0]

    def ticket(self, r, client_id, epoch):
        with self.lock:
            self._clean()
            if self.target(r.account) is not r or r.epoch != epoch:
                refuse("screen_context_invalid")
            if len(self.tickets) >= 512:
                refuse("screen_busy", 429)
            token = secrets.token_urlsafe(32)
            self.tickets[digest(token)] = (client_id, r.id, r.epoch, self.clock() + 30)
            return {"workspace": dict(r.workspace), "scene_id": r.scene_id, "screen_context": token, "expires_in": 30}

    def consume(self, token, client_id, account):
        with self.lock:
            self._clean()
            ticket = self.tickets.pop(digest(token), None)
            r = self.target(account)
            if not ticket or ticket[:3] != (client_id, r.id, r.epoch):
                refuse("screen_context_invalid")
            return r, r.epoch

    def issue(self, r, epoch, ctx, name, args, cost):
        with self.lock:
            self._clean()
            if self.target(r.account) is not r or r.epoch != epoch:
                refuse("screen_context_invalid")
            active = [a for a in self.actions.values() if not a.settled.is_set()]
            if len(active) >= 8 or any(a.receiver.account == r.account for a in active):
                refuse("screen_busy", 429)
            cid = ctx.client["id"]
            for column, key in ((1, cid), (2, r.account)):
                rows = [u for u in self.usage if u[column] == key]
                if name in LIMITS and sum(u[4] for u in rows if u[3] == name) + cost > LIMITS[name]:
                    refuse("screen_limit", 429)
            self.usage.append((self.clock(), cid, r.account, name, cost))
            a = Action(secrets.token_urlsafe(24), r, epoch, ctx, name, args, self.clock() + ACTION_SECONDS)
            self.actions[a.id] = a
            return a

    def rate(self, client_id, account):
        with self.lock:
            self._clean()
            if sum(v[1] == client_id for v in self.requests) >= 30 or sum(v[2] == account for v in self.requests) >= 60:
                refuse("screen_limit", 429)
            self.requests.append((self.clock(), client_id, account))

    def lookup(self, action_id, r):
        with self.lock:
            self._clean()
            a = self.actions.get(action_id)
            if not a or a.receiver is not r:
                refuse("screen_action_invalid", 403)
            return a

    def claim(self, a):
        with self.lock:
            self._clean()
            r = a.receiver
            if a.state != "pending" or self.target(r.account) is not r or r.epoch != a.epoch:
                refuse("screen_action_closed")
            token = secrets.token_urlsafe(32)
            a.state, a.token_hash = "claimed", digest(token)
            return {"token": token, "name": a.name, "args": a.args, "epoch": a.epoch,
                    "workspace": dict(r.workspace), "client_name": a.context.client["name"]}

    def finish(self, a, token, ok, summary, data):
        with self.lock:
            self._clean()
            if (a.state != "claimed" or a.receiver.epoch != a.epoch or not a.receiver.visible or not a.receiver.enabled
                    or not hmac.compare_digest(a.token_hash, digest(token))):
                return False
            self._close(a, {"status": "done" if ok else "failed", "ok": ok, "summary": summary, "data": data})
            self._clean()
            return True

    def expire(self, a):
        with self.lock:
            self._close(a)
            self._clean()


service = ScreenService()

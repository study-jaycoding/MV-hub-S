"""Local MCP transport only; the paired browser owns API access and human approval."""
from __future__ import annotations

import asyncio
import hashlib
import hmac
import json
import secrets
import time
from uuid import uuid4


class BrokerError(ValueError):
    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status


def digest(value: str) -> str:
    return hashlib.sha256(value.encode()).hexdigest()


class McpBroker:
    METHODS = {"read_context", "prepare_generation_plan", "get_plan", "request_execution", "execute_generation_plan"}
    APP_TTL = 45
    REQUEST_TTL = 120
    PAIR_TTL = 120

    def __init__(self):
        self.client: dict | None = None
        self.requests: dict[str, dict] = {}
        self.changed = asyncio.Event()

    def _wake(self):
        self.changed.set()
        self.changed = asyncio.Event()

    def _live(self) -> bool:
        c = self.client
        return bool(c and time.monotonic() - c["seen"] < (self.APP_TTL if c.get("binding") else self.PAIR_TTL))

    def connect(self, secret: str, name: str) -> dict:
        hashed = digest(secret)
        if self._live():
            if not hmac.compare_digest(self.client["secret"], hashed):
                message = ("다른 MCP 연결이 사용 중입니다. 앱에서 연결을 해제하세요." if self.client["binding"]
                           else "다른 MCP 연결 코드가 발급되어 있습니다. 코드 만료(최대 2분) 후 다시 연결하세요.")
                raise BrokerError(409, message)
        else:
            self.client = {"id": str(uuid4()), "secret": hashed, "code": f"{secrets.randbelow(1000000):06d}",
                           "name": name, "seen": time.monotonic(), "binding": None, "tab": None}
            self.requests.clear()
            self._wake()
        return {"client_id": self.client["id"], "pair_code": self.client["code"],
                "paired": bool(self.client["binding"]), "can_execute": self.client.get("can_execute", False)}

    def client_guard(self, secret: str, *, paired: bool = True):
        if not self.client or not hmac.compare_digest(self.client["secret"], digest(secret)):
            raise BrokerError(403, "MCP 연결을 확인할 수 없습니다.")
        if not self._live():
            raise BrokerError(409, "app_not_connected: 앱에서 다시 연결하세요.")
        if paired and not self.client.get("binding"):
            raise BrokerError(409, "not_paired: 앱의 AI 연결에서 연결 코드를 확인하세요.")

    def pair(self, code: str, binding: str, tab: str, *, allow_execution: bool = False) -> dict:
        c = self.client
        if not c or not self._live() or not hmac.compare_digest(c["code"], code):
            raise BrokerError(403, "연결 코드가 틀렸거나 만료되었습니다.")
        if c.get("binding") and (c["binding"] != binding or c["tab"] != digest(tab)):
            raise BrokerError(409, "다른 앱 탭에 연결되어 있습니다.")
        if not c.get("binding"):
            c["can_execute"] = allow_execution
        c.update(binding=binding, tab=digest(tab), seen=time.monotonic())
        self._wake()
        return {"client_id": c["id"], "name": c["name"], "can_execute": c.get("can_execute", False)}

    def require_execution(self):
        if not self._live() or not self.client.get("binding") or not self.client.get("can_execute"):
            raise BrokerError(409, "execution_not_granted: 앱에서 연결을 해제하고 실행 허용으로 다시 연결하세요.")

    def app_guard(self, binding: str, tab: str):
        c = self.client
        if not c or not c.get("binding") or not self._live():
            raise BrokerError(409, "연결이 만료되었습니다. 다시 연결하세요.")
        if not hmac.compare_digest(c["tab"], digest(tab)):
            raise BrokerError(403, "연결한 앱 탭이 아닙니다.")
        if not hmac.compare_digest(c["binding"], binding):
            self.close()
            raise BrokerError(403, "계정이나 로그인 세션이 바뀌었습니다. 다시 연결하세요.")
        c["seen"] = time.monotonic()

    def close(self):
        self.client = None
        self.requests.clear()
        self._wake()

    def enqueue(self, method: str, args: dict) -> dict:
        if method not in self.METHODS:
            raise BrokerError(422, "지원하지 않는 MCP 도구입니다.")
        if method == "execute_generation_plan":
            self.require_execution()
        now = time.monotonic()
        self.requests = {k: v for k, v in self.requests.items() if now - v["created"] < self.REQUEST_TTL}
        if sum(r["state"] != "done" for r in self.requests.values()) >= 8:
            raise BrokerError(429, "MCP 요청이 많습니다. 기존 요청이 끝난 뒤 다시 시도하세요.")
        # 완료 응답은 재조회할 수 있게 잠시 보존하되 대기 슬롯과 메모리를 차지하지 않게 제한한다.
        while len(self.requests) >= 32:
            oldest = next(k for k, r in self.requests.items() if r["state"] == "done")
            del self.requests[oldest]
        rid = str(uuid4())
        self.requests[rid] = {"id": rid, "method": method, "args": args, "created": now,
                              "state": "queued", "result": None, "error": None}
        self._wake()
        return {"id": rid}

    async def next(self, binding: str, tab: str, timeout: float = 25) -> dict:
        deadline = time.monotonic() + timeout
        while True:
            self.app_guard(binding, tab)
            # A second poll must not dispatch another action while the first is running.
            active = [r for r in self.requests.values() if time.monotonic() - r["created"] < self.REQUEST_TTL]
            if not any(r["state"] == "running" for r in active):
                for r in active:
                    if r["state"] == "queued":
                        r["state"] = "running"
                        return {"request": {k: r[k] for k in ("id", "method", "args")}}
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                return {"request": None}
            event = self.changed
            try:
                await asyncio.wait_for(event.wait(), remaining)
            except TimeoutError:
                return {"request": None}

    def reply(self, rid: str, result: dict | None, error: str | None):
        r = self.requests.get(rid)
        if not r or time.monotonic() - r["created"] >= self.REQUEST_TTL:
            raise BrokerError(404, "MCP 요청이 만료되었습니다.")
        if r["state"] != "running":
            raise BrokerError(409, "응답 대기 중인 요청이 아닙니다.")
        if len(json.dumps(result, ensure_ascii=False).encode()) > 256 * 1024:
            raise BrokerError(413, "결과가 너무 큽니다. 조회 범위를 줄이세요.")
        r.update(state="done", result=result, error=error)
        self._wake()

    async def result(self, secret: str, rid: str, timeout: float = 25) -> dict:
        deadline = time.monotonic() + timeout
        while True:
            self.client_guard(secret)
            r = self.requests.get(rid)
            if not r or time.monotonic() - r["created"] >= self.REQUEST_TTL:
                raise BrokerError(404, "MCP 요청이 만료되었습니다. 실행 여부는 앱에서 확인하세요.")
            if r["state"] == "done":
                return {"status": "done", "result": r["result"], "error": r["error"]}
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                return {"status": "pending"}
            event = self.changed
            try:
                await asyncio.wait_for(event.wait(), remaining)
            except TimeoutError:
                return {"status": "pending"}

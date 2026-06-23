"""WebSocket 진행률 푸시 (Phase 3).

생성 잡의 상태 전이(pending→running→done/failed)를 연결된 모든 UI 에 broadcast 한다.
higgsfield 는 퍼센트가 아니라 상태 전이를 주므로, 가짜 진행바 대신 coarse 한
상태를 그대로 푸시한다(advisor 지침).
"""

from __future__ import annotations

import asyncio
from typing import Any, Optional

from fastapi import WebSocket

# 변경 알림 디바운스(초) — 일괄 트리아지(컬러 연타 등)에서 한 번만 broadcast 하도록 합친다.
_NOTIFY_DEBOUNCE = 0.4


class ConnectionManager:
    def __init__(self) -> None:
        self._active: set[WebSocket] = set()
        self._lock = asyncio.Lock()
        self._pending_notify: Optional[asyncio.Task] = None

    async def connect(self, ws: WebSocket) -> None:
        await ws.accept()
        async with self._lock:
            self._active.add(ws)

    async def disconnect(self, ws: WebSocket) -> None:
        async with self._lock:
            self._active.discard(ws)

    async def broadcast(self, message: dict[str, Any]) -> None:
        async with self._lock:
            targets = list(self._active)
        dead: list[WebSocket] = []
        for ws in targets:
            try:
                await ws.send_json(message)
            except Exception:
                dead.append(ws)
        if dead:
            async with self._lock:
                for ws in dead:
                    self._active.discard(ws)

    def notify_mutation(self) -> None:
        """로컬 데이터 변경(태그·소스·컬러·코멘트·프로젝트 등)을 다른 클라이언트에 알린다.
        같은 계정을 여러 기기/탭에서 열어도 한쪽 변경이 즉시 반영되게 한다.
        연타(일괄 트리아지)에 대비해 짧은 윈도우로 coalesce — reload 폭주를 막는다.
        프론트는 'synced' 를 받으면 전체 reload 하므로 그 타입을 재사용."""
        if self._pending_notify and not self._pending_notify.done():
            return  # 이미 예약됨 → 이 변경은 다음 broadcast 에 합쳐진다
        try:
            self._pending_notify = asyncio.create_task(self._debounced_notify())
        except RuntimeError:
            pass  # 이벤트 루프 없음(테스트 등) — 알림 생략

    async def _debounced_notify(self) -> None:
        await asyncio.sleep(_NOTIFY_DEBOUNCE)
        await self.broadcast({"type": "synced"})


# 앱 전역 단일 인스턴스
manager = ConnectionManager()

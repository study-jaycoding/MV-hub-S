"""비동기 유틸 — to_thread 의 non-abandon 변형(R7 코덱스 P1).

``asyncio.to_thread`` 를 그대로 await 하면 요청 task 취소 시 즉시 CancelledError 가
올라오고 스레드는 계속 돈다 — 호출자가 스레드가 아직 쓰는 임시파일·업로드 핸들을 먼저
정리하거나 lock 을 먼저 풀 수 있다. 자원 소유권이 스레드에 있는 구간은 이 변형으로
'스레드 완료까지 기다린 뒤' 취소를 다시 올린다(db_backup._store_backup_limited 선례).
"""
from __future__ import annotations

import asyncio
import contextlib

import anyio


async def to_thread_non_abandon(func, /, *args, **kwargs):
    worker = asyncio.create_task(asyncio.to_thread(func, *args, **kwargs))
    try:
        return await asyncio.shield(worker)
    except asyncio.CancelledError:
        # AnyIO의 지속 취소가 대기를 헛돌게 하지 않는다. 직접 task.cancel()은
        # 여전히 들어오므로 asyncio.shield도 유지해 스레드보다 먼저 정리하지 않는다.
        with anyio.CancelScope(shield=True):
            while not worker.done():
                with contextlib.suppress(asyncio.CancelledError, Exception):
                    await asyncio.shield(worker)
        if not worker.cancelled():
            worker.exception()  # 완료와 취소가 겹쳐도 예외를 회수한다. 취소가 우선이다.
        raise

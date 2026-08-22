"""비동기 유틸 — to_thread 의 non-abandon 변형(R7 코덱스 P1).

``asyncio.to_thread`` 를 그대로 await 하면 요청 task 취소 시 즉시 CancelledError 가
올라오고 스레드는 계속 돈다 — 호출자가 스레드가 아직 쓰는 임시파일·업로드 핸들을 먼저
정리하거나 lock 을 먼저 풀 수 있다. 자원 소유권이 스레드에 있는 구간은 이 변형으로
'스레드 완료까지 기다린 뒤' 취소를 다시 올린다(db_backup._store_backup_limited 선례).
"""
from __future__ import annotations

import asyncio
import contextlib


async def to_thread_non_abandon(func, /, *args, **kwargs):
    worker = asyncio.create_task(asyncio.to_thread(func, *args, **kwargs))
    try:
        return await asyncio.shield(worker)
    except asyncio.CancelledError:
        # 응답 task 취소는 보존하되, 스레드가 끝날 때까지 자원(임시파일·lock 구간)을
        # 넘겨주지 않는다. ★대기 자체도 계속 shield(코덱스 재확인 P1) — 맨 await 로
        # 기다리면 '반복 취소'가 worker 를 취소시켜 helper 가 스레드보다 먼저 반환했다.
        # 스레드의 예외는 취소 전파를 가리지 않게 삼킨다(취소가 우선).
        while not worker.done():
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await asyncio.shield(worker)
        raise

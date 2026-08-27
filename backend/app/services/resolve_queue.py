"""취소되지 않는 실행 단위 — Resolve 직접 전송이 쓰는 유일한 잔존 함수.

큐 설계(``docs/DESIGN_RESOLVE_QUEUE_V3_2026-08-24.md``)는 superseded 다. 2026-08-25 ``aa0985b9`` 로 직접 전송
(요청 한 건 안에서 준비·반입·저장)이 복원된 뒤 이 모듈의 접수·상태 전이·claim·스캔·복구 코드는 호출자가 없었고,
2026-08-27 에 전담 워커(``resolve_queue_worker``)와 함께 삭제했다. 남은 것은 ``run_non_abandon`` 하나이며
``routers/resolve_integration`` 의 ``/transfers``·``/transfers/retry`` 가 '가져오기 실행 + manifest 저장' 을
한 단위로 끝내는 데 쓴다. 옛 v3 manifest 파일(``@davinci`` 아래 ``.mvhub``)은 이 모듈이 읽지도 지우지도 않는다.
"""

from __future__ import annotations

import asyncio
import contextlib


# ── 취소되지 않는 실행 단위 ────────────────────────────────────────────────────
async def run_non_abandon(coro):
    """시작한 코루틴 단위를 끝까지 보장한다(취소는 끝난 뒤 전파).

    '가져오기 실행 + manifest 저장'처럼 결과 기록까지가 한 단위인 구간에 쓴다.
    단순 non-abandon to_thread 로는 실행만 살고 저장이 유기될 수 있다.
    """
    worker = asyncio.create_task(coro)
    try:
        return await asyncio.shield(worker)
    except asyncio.CancelledError:
        while not worker.done():
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await asyncio.shield(worker)
        if not worker.cancelled():
            with contextlib.suppress(Exception):
                worker.result()
        raise

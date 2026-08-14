"""로컬 허브의 PM 텔레메트리를 현재 실행 모드에 맞게 전달한다.

라우터 계층의 공유 서버 프록시와 서비스 계층의 outbox 드레이너를 연결한다. 생성 요청처럼
응답을 늦추면 안 되는 경로에서는 ``schedule_telemetry_drain``으로 짧게 묶어서 전송한다.
"""

from __future__ import annotations

import asyncio
import logging
import threading

from .. import repo
from ..config import MANAGE_ENABLED
from ..services.operational_logging import log_event
from ..services.telemetry_drain import drain_isolated_telemetry, drain_remote_telemetry
from . import _proxy


_logger = logging.getLogger("mvhub.telemetry")
_drain_lock = threading.Lock()
_drain_task: asyncio.Task[None] | None = None
_drain_version = 0
_DEBOUNCE_SECONDS = 0.05


def drain_telemetry() -> None:
    """dirty 텔레메트리를 현재 실행 모드에 맞는 단 하나의 대상으로 반영한다."""
    if not MANAGE_ENABLED:
        return
    # ingest의 동기 flush와 생성 상태의 백그라운드 flush가 겹쳐 같은 묶음을 중복 전송하지 않게 한다.
    with _drain_lock:
        if _proxy.proxying():
            drain_remote_telemetry(
                lambda items: _proxy.proxy_json(
                    "POST", "/api/manage/telemetry/push", body={"items": items}
                ),
                my_uid=repo.get_my_uid(),
            )
            return
        # test_dev는 운영 서버로 보내지 않고 복사된 테스트 폴더 안에서만 집계한다.
        drain_isolated_telemetry()


async def _drain_soon() -> None:
    """동시에 들어온 상태 변경은 한 묶음으로 보내고, 전송 중 새 변경은 한 번 더 보낸다."""
    global _drain_task
    try:
        await asyncio.sleep(_DEBOUNCE_SECONDS)
        while True:
            version = _drain_version
            try:
                await asyncio.to_thread(drain_telemetry)
            except Exception as exc:  # noqa: BLE001 - 텔레메트리가 생성 흐름을 막지 않게
                log_event(
                    _logger,
                    "telemetry_background_drain_failed",
                    level=logging.WARNING,
                    error_type=type(exc).__name__,
                )
            # 전송하는 동안 새 변경 요청이 없었다면 종료한다. 있었다면 최신 상태를 한 번 더 보낸다.
            if version == _drain_version:
                return
            await asyncio.sleep(0)
    finally:
        _drain_task = None


def schedule_telemetry_drain() -> bool:
    """생성 응답을 기다리게 하지 않고 텔레메트리 전송을 예약한다.

    같은 이벤트 루프에서 이미 예약·전송 중이면 새 작업을 만들지 않고 버전만 올린다. 호출자가
    동기 테스트 문맥이면 예약하지 않으며, 기존 ingest 동기 드레인이 안전망으로 남는다.
    """
    global _drain_task, _drain_version
    if not MANAGE_ENABLED:
        return False
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        return False

    _drain_version += 1
    if _drain_task is None or _drain_task.done():
        _drain_task = loop.create_task(_drain_soon(), name="telemetry-drain")
    return True


async def wait_for_telemetry_drain(timeout: float = 10.0) -> bool:
    """앱 종료 전 예약된 전송이 DB 작업을 끝낼 짧은 시간을 준다.

    재시작을 무기한 막지는 않으며, 제한시간이 지나도 작업 자체를 강제 취소하지 않아 전송 중인
    동기 스레드가 갑자기 끊겼다고 오인하지 않게 한다.
    """
    task = _drain_task
    if task is None or task.done():
        return True
    try:
        await asyncio.wait_for(asyncio.shield(task), timeout=max(0.01, float(timeout)))
        return True
    except asyncio.TimeoutError:
        return False

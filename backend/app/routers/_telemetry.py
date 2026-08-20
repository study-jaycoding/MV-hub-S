"""로컬 허브의 PM 텔레메트리를 현재 실행 모드에 맞게 전달한다.

라우터 계층의 공유 서버 프록시와 서비스 계층의 outbox 드레이너를 연결한다. 생성 요청처럼
응답을 늦추면 안 되는 경로에서는 ``schedule_telemetry_drain``으로 짧게 묶어서 전송한다.
"""

from __future__ import annotations

import asyncio
import logging
import threading
import time

from .. import repo
from ..config import MANAGE_ENABLED
from ..services.operational_logging import log_event
from ..services.account_report_delivery import drain_remote_account_reports
from ..services.telemetry_drain import drain_isolated_telemetry, drain_remote_telemetry
from . import _proxy


_logger = logging.getLogger("mvhub.telemetry")
_drain_state = threading.Condition()
_drain_in_flight = False
_drain_requested = False
_scheduler_lock = threading.Lock()
_scheduler_loop: asyncio.AbstractEventLoop | None = None
_drain_task: asyncio.Task[None] | None = None
_drain_version = 0
_DEBOUNCE_SECONDS = 0.05


def touch_generation_telemetry(gen_id: str | None) -> None:
    """공유/최종/발행으로 상태 차원이 바뀐 내 로컬 생성물을 텔레메트리 dirty 표시.

    best-effort·MANAGE 게이트 — 실패해도 호출 흐름(공유·발행·최종)엔 무영향이고, 전송은
    다음 drain 이 처리한다. ★단일 정의: 예전엔 share.py 와 publish.py 에 같은 함수가
    복붙돼 있었고, 실제로 발행 경로에만 누락돼 is_shared 팩트가 안 오르던 사고가 있었다."""
    if not MANAGE_ENABLED or not gen_id:
        return
    try:
        from ..repo import manage as _m

        _m.mark_telemetry_dirty([gen_id])
    except Exception:  # noqa: BLE001
        pass


def _drain_once() -> None:
    """현재 outbox 스냅샷을 한 번 반영한다. 상태 락 밖에서만 호출한다."""
    if _proxy.proxying():
        my_uid = repo.get_my_uid()
        if MANAGE_ENABLED:
            drain_remote_telemetry(
                lambda items: _proxy.proxy_json(
                    "POST", "/api/manage/telemetry/push", body={"items": items}
                ),
                my_uid=my_uid,
            )
            # 계정 보고 outbox 도 MANAGE 사이드카다 — off 설치본에서 이 드레인이 돌면
            # list_due_account_reports 의 _ensure_schema 가 "사이드카 테이블을 만들지 않는다"는
            # 계약(ingest.py 의 레거시 인라인 경로 주석)을 깨고 테이블을 몰래 생성한다.
            # off 는 예전처럼 ingest 인라인 best-effort 만 쓴다.
            drain_remote_account_reports(
                lambda payload: _proxy.proxy_json(
                    "POST", "/api/ingest/account-report", body=payload
                ),
                creator_uid=my_uid,
            )
        return
    # test_dev는 운영 서버로 보내지 않고 복사된 테스트 폴더 안에서만 집계한다.
    drain_isolated_telemetry()


def drain_telemetry() -> bool:
    """dirty 텔레메트리를 한 작업자가 반영하되 네트워크 동안 상태 락은 놓는다.

    이미 전송 중이면 기다리지 않고 후속 전송 표시만 남긴다. 현재 작업자는 네트워크 왕복 뒤
    표시를 확인해 outbox를 한 번 더 읽으므로 전송 중 생긴 변경도 빠뜨리지 않는다.
    """
    global _drain_in_flight, _drain_requested
    if not MANAGE_ENABLED and not _proxy.proxying():
        return False

    # 이 락은 소유권 표시를 바꾸는 몇 줄에만 사용한다. DB 준비·네트워크·DB 정산은 모두 락 밖이다.
    with _drain_state:
        if _drain_in_flight:
            _drain_requested = True
            return False
        _drain_in_flight = True

    try:
        while True:
            # 여기까지 들어오기 전의 요청은 이번 outbox 조회에 포함되므로 표시를 소비한다.
            with _drain_state:
                _drain_requested = False
            _drain_once()
            with _drain_state:
                if _drain_requested:
                    continue
                _drain_in_flight = False
                _drain_state.notify_all()
                return True
    except BaseException:
        with _drain_state:
            _drain_in_flight = False
            _drain_state.notify_all()
        raise


def bind_telemetry_loop(loop: asyncio.AbstractEventLoop) -> None:
    """동기 FastAPI 라우터도 같은 이벤트 루프에 전송을 예약할 수 있게 연결한다."""
    global _scheduler_loop
    with _scheduler_lock:
        _scheduler_loop = loop


def unbind_telemetry_loop(loop: asyncio.AbstractEventLoop | None = None) -> None:
    """종료한 이벤트 루프를 동기 라우터가 다시 사용하지 않게 해제한다."""
    global _scheduler_loop
    with _scheduler_lock:
        if loop is None or _scheduler_loop is loop:
            _scheduler_loop = None


def _schedule_on_loop() -> None:
    """바인딩된 이벤트 루프 스레드에서만 task 상태를 변경한다."""
    global _drain_task, _drain_version
    if not MANAGE_ENABLED and not _proxy.proxying():
        return
    _drain_version += 1
    if _drain_task is None or _drain_task.done():
        _drain_task = asyncio.create_task(_drain_soon(), name="telemetry-drain")


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

    같은 이벤트 루프에서 이미 예약·전송 중이면 새 작업을 만들지 않고 버전만 올린다. 동기 FastAPI
    워커에서도 시작 때 연결한 메인 루프로 게시하며, 앱 밖 동기 문맥처럼 연결된 루프가 없으면
    False를 반환하고 outbox는 다음 기회의 안전망으로 남는다.
    """
    if not MANAGE_ENABLED and not _proxy.proxying():
        return False
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        loop = None

    if loop is not None:
        bind_telemetry_loop(loop)
        _schedule_on_loop()
        return True

    # 동기 FastAPI 라우터는 anyio 워커 스레드에서 실행된다. 시작 때 저장한 메인 루프에 콜백만
    # 게시하고 즉시 반환해 ingest 응답이 공유 서버 네트워크를 기다리지 않게 한다.
    with _scheduler_lock:
        target = _scheduler_loop
    if target is None or target.is_closed() or not target.is_running():
        return False
    try:
        target.call_soon_threadsafe(_schedule_on_loop)
        return True
    except RuntimeError:
        return False


def _wait_for_drain_idle(timeout: float) -> bool:
    deadline = time.monotonic() + max(0.0, timeout)
    with _drain_state:
        while _drain_in_flight:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                return False
            _drain_state.wait(remaining)
    return True


async def wait_for_telemetry_drain(timeout: float = 10.0) -> bool:
    """앱 종료 전 예약된 전송이 DB 작업을 끝낼 짧은 시간을 준다.

    재시작을 무기한 막지는 않으며, 제한시간이 지나도 작업 자체를 강제 취소하지 않아 전송 중인
    동기 스레드가 갑자기 끊겼다고 오인하지 않게 한다.
    """
    started = time.monotonic()
    # 동기 워커가 call_soon_threadsafe로 막 게시한 콜백도 먼저 task로 승격시킨다.
    await asyncio.sleep(0)
    task = _drain_task
    try:
        if task is not None and not task.done():
            remaining = max(0.01, float(timeout) - (time.monotonic() - started))
            await asyncio.wait_for(asyncio.shield(task), timeout=remaining)
    except asyncio.TimeoutError:
        return False
    remaining = max(0.0, float(timeout) - (time.monotonic() - started))
    return await asyncio.to_thread(_wait_for_drain_idle, remaining)

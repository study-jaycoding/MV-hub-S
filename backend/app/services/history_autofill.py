"""과거 생성 이력 자동 보충 오케스트레이션 — gap 감지·쿨다운·startup audit·실행 잠금.

routers/ingest 에 있던 것을 서비스로 옮겼다: syncer(서비스)가 gap 감지 시 자동 실행을
불러야 하는데 services→routers 역방향 import 는 계층 규칙 위반이자 순환이었다
(test_architecture_boundaries). 적재 코어(_ingest_core — 신원 검증 포함)는 라우터 소유라
여기서 import 하지 않고, 라우터가 import 시점에 bind_ingest_hooks 로 걸어준다(단방향).

작업 상태는 프로세스 메모리(설정 화면 조회용), gap·쿨다운·최근 성공은 DB
(history_import_audit — 재시작 생존). 토큰은 지역 변수로만 쓰고 저장하지 않는다.
"""

from __future__ import annotations

import asyncio
import logging
import os
from datetime import datetime, timezone
from typing import Any, Callable

from fastapi import HTTPException

from .. import active_account, repo
from ..config import AUTH_ENABLED, EXTERNAL_RECOVERY_ENABLED, LOCAL_AGENT_PAIR_SECRET, MANAGE_ENABLED
from ..emailnorm import norm_email
from . import cli_bridge, higgsfield_history
from .mcp_ingest import mcp_item_to_cli

_logger = logging.getLogger("mvhub.account_reports")

# 과거 전체 가져오기는 여러 페이지라 HTTP 한 요청을 오래 붙잡지 않는다. 작업은 이 로컬 허브의
# 백그라운드 task로 돌고 설정 화면은 상태만 짧게 조회한다. 앱을 재시작하면 작업 상태도 사라지지만
# DB 반영은 페이지마다 끝나므로 다시 시작하면 멱등 업서트로 안전하게 처음부터 보충된다.
_HISTORY_STATES: dict[str, dict[str, Any]] = {}
_HISTORY_TASKS: dict[str, asyncio.Task] = {}
_HISTORY_LOOP: asyncio.AbstractEventLoop | None = None

# 자동 시작 '예약' task(gap 감지 → auto_start_history_import). import task 와 달리
# _HISTORY_TASKS 에 들어가기 전 단계라 어디에도 안 잡혀 있었다 — 종료가 취소하지 못해
# teardown 뒤에 claim DB 쓰기·전체 순회가 시작될 수 있었다. 여기 등록해 먼저 취소한다.
_HISTORY_STARTERS: set[asyncio.Task] = set()

# 종료 개시 플래그. 동기 ingest 워커가 이미 call_soon_threadsafe 로 예약해 둔 spawn 이
# stop 이후에 실행되는 '늦은 예약'을 막는다(취소할 대상이 아직 없던 창).
_HISTORY_STOPPING = False

# 자동 보충 실패가 재시작 때마다 외부 MCP를 두드리지 않게 DB 쿨다운을 둔다. 성공 audit은
# 하루 한 번이면 충분하며 둘 다 운영 환경에서 초 단위로 조정할 수 있다.
HISTORY_AUTO_COOLDOWN_SECONDS = float(
    os.environ.get("CONTENT_HUB_HISTORY_AUTO_COOLDOWN", str(6 * 60 * 60))
)
HISTORY_AUTO_AUDIT_SECONDS = float(
    os.environ.get("CONTENT_HUB_HISTORY_AUDIT_INTERVAL", str(24 * 60 * 60))
)

# 적재 코어와 텔레메트리 스케줄러는 라우터 계층 소유 — import 대신 부팅 시 주입받는다.
_INGEST_RUNNER: Callable[..., Any] | None = None
_SCHEDULE_TELEMETRY: Callable[[], None] | None = None


def bind_ingest_hooks(
    ingest_runner: Callable[..., Any],
    schedule_telemetry: Callable[[], None] | None = None,
) -> None:
    """routers/ingest 가 import 시점에 자신의 적재 코어를 걸어준다(단방향 의존)."""
    global _INGEST_RUNNER, _SCHEDULE_TELEMETRY
    _INGEST_RUNNER = ingest_runner
    _SCHEDULE_TELEMETRY = schedule_telemetry


def _history_key() -> str:
    """현재 로컬 계정별 작업 키. 서버 모드에서는 이 기능 자체를 막는다."""
    from ..active_account import account_key

    # test_dev는 AUTH on이지만 일회성 로컬 pairing key로 작업자 PC임을 확정할 수 있다.
    # 이때 account_key()는 서버 규칙상 None이므로 실제 로그인 계정 이메일을 호출부에서 덧붙인다.
    return norm_email(account_key()) or "local"


def _history_idle() -> dict[str, Any]:
    return {
        "state": "idle",
        "pages": 0,
        "received": 0,
        "inserted": 0,
        "updated": 0,
        "unchanged": 0,
        "skipped": 0,
        "errors": 0,
        "message": "",
        "started_at": None,
        "finished_at": None,
        "automatic": False,
    }


def _history_audit_email(key: str) -> str:
    if key != "local":
        return norm_email(key)
    return norm_email((repo.get_provider() or {}).get("email")) or key


def _history_snapshot(key: str) -> dict[str, Any]:
    snapshot = dict(_HISTORY_STATES.get(key) or _history_idle())
    audit = repo.get_history_import_audit(_history_audit_email(key))
    detected = audit.get("gap_detected_at")
    auto_started = audit.get("last_auto_started_at")
    snapshot.update(
        gap_detected_at=detected,
        gap_resolved=bool(detected and audit.get("gap_resolved_at")),
        gap_auto_started=bool(detected and auto_started and auto_started >= detected),
    )
    return snapshot


def _history_server_forbidden() -> bool:
    return AUTH_ENABLED and not LOCAL_AGENT_PAIR_SECRET


def _history_auto_forbidden() -> bool:
    # 복원 드릴·격리 실행은 부팅 때 외부 CLI/MCP를 건드리지 않는 기존 안전 게이트를 따른다.
    return _history_server_forbidden() or not EXTERNAL_RECOVERY_ENABLED


def _capture_history_scope() -> str:
    """현재 계정 DB 키만 전환 락 아래 캡처한다. 느린 작업은 이 락 밖에서 돈다."""
    with active_account.transition_lock:
        return active_account.account_key() or ""


def bind_history_loop(loop: asyncio.AbstractEventLoop) -> None:
    global _HISTORY_LOOP, _HISTORY_STOPPING
    _HISTORY_LOOP = loop
    _HISTORY_STOPPING = False  # 새 부팅 — 지난 종료의 차단 플래그를 푼다.


def unbind_history_loop(loop: asyncio.AbstractEventLoop) -> None:
    global _HISTORY_LOOP
    if _HISTORY_LOOP is loop:
        _HISTORY_LOOP = None


def schedule_history_auto_start(account_email: str) -> None:
    """동기 ingest 워커에서 메인 루프의 자동 보충 task 생성만 예약한다."""
    loop = _HISTORY_LOOP
    if loop is None or loop.is_closed() or _HISTORY_STOPPING:
        return

    def _spawn() -> None:
        # 예약과 실행 사이에 종료가 시작됐으면 새 작업을 만들지 않는다.
        if _HISTORY_STOPPING:
            return
        task = asyncio.create_task(
            auto_start_history_import(account_email, reason="gap"),
            name="history-gap-auto-start",
        )
        _HISTORY_STARTERS.add(task)
        task.add_done_callback(_HISTORY_STARTERS.discard)

    loop.call_soon_threadsafe(_spawn)


def _history_account(account_email: str) -> dict:
    if AUTH_ENABLED:
        return repo.get_account(account_email) or {"email": account_email}
    return {"email": "local", "creator_uid": repo.get_my_uid()}


def _start_history_task(
    key: str,
    acc: dict,
    *,
    automatic: bool,
    account_scope: str | None = None,
) -> bool:
    # 한 CLI 자격으로 계정 둘을 동시에 순회하지 않는다. 키별 dict는 상태 조회용으로 유지하되
    # 실제 실행 잠금은 프로세스 전체에서 하나다.
    if any(task and not task.done() for task in _HISTORY_TASKS.values()):
        return False
    # 이미 스코프를 캡처한 호출자(라우트는 워커 스레드에서 캡처)는 그 키를 넘긴다 —
    # 이 함수는 create_task 때문에 이벤트 루프에서 돌아야 해 여기서 락을 잡으면 안 된다.
    captured_scope = _capture_history_scope() if account_scope is None else account_scope
    _HISTORY_STATES[key] = {
        **_history_idle(),
        "state": "running",
        "automatic": automatic,
        "message": (
            "누락 가능성을 감지해 과거 이력을 자동 확인하는 중…"
            if automatic
            else "Higgsfield 과거 이력을 확인하는 중…"
        ),
        "started_at": datetime.now(timezone.utc).isoformat(),
    }
    _HISTORY_TASKS[key] = asyncio.create_task(
        _run_history_import(key, dict(acc), account_scope=captured_scope),
        name=f"history-import:{key}",
    )
    return True


async def auto_start_history_import(
    account_email: str,
    *,
    reason: str,
    started_at: datetime | None = None,
) -> bool:
    """gap 또는 시작 audit을 해당 로컬 CLI 계정의 기존 history 작업으로 연결한다."""
    if _history_auto_forbidden():
        return False
    email = norm_email(account_email)
    if not email:
        return False
    account_scope = _capture_history_scope()
    account_override = active_account.set_override(account_scope or "")
    try:
        local_key = _history_key()
        if local_key != "local" and norm_email(local_key) != email:
            _logger.warning(
                "history_auto_account_mismatch reason=%s requested=%s active=%s",
                reason,
                email,
                local_key,
            )
            return False
        if any(task and not task.done() for task in _HISTORY_TASKS.values()):
            return False
        claimed = await asyncio.to_thread(
            repo.claim_history_auto_start,
            email,
            HISTORY_AUTO_COOLDOWN_SECONDS,
            started_at=started_at,
        )
        if not claimed:
            return False
        return _start_history_task(email, _history_account(email), automatic=True)
    finally:
        active_account.reset_override(account_override)


async def startup_history_audit() -> bool:
    """로컬 허브 시작 때 최근 성공이 오래됐으면 한 번만 전체 이력을 확인한다."""
    if _history_auto_forbidden():
        return False
    account_scope = _capture_history_scope()
    account_override = active_account.set_override(account_scope or "")
    try:
        try:
            status = await cli_bridge.get_account_status(timeout=10.0)
        except Exception as exc:  # noqa: BLE001 — 미로그인/CLI 불가는 다음 시작·gap 기회로 넘긴다.
            _logger.warning("history_startup_audit_skipped error_type=%s", type(exc).__name__)
            return False
        email = norm_email((status or {}).get("email"))
        if not (status or {}).get("connected") or not email:
            _logger.warning("history_startup_audit_skipped reason=cli_not_logged_in")
            return False
        audit = await asyncio.to_thread(repo.get_history_import_audit, email)
        unresolved_gap = bool(
            audit.get("gap_detected_at") and not audit.get("gap_resolved_at")
        )
        if not unresolved_gap:
            recent = await asyncio.to_thread(
                repo.history_success_is_recent,
                email,
                HISTORY_AUTO_AUDIT_SECONDS,
            )
            if recent:
                return False
        return await auto_start_history_import(email, reason="startup")
    finally:
        active_account.reset_override(account_override)


async def stop_history_imports() -> None:
    """종료 중 자동 audit/history task가 계정 DB를 다시 여는 경합을 막는다.

    ★순서: starter(자동 시작 예약) → import task. 반대로 하면 import 를 정리하는 사이
    살아 있던 starter 가 새 import task 를 만들어, teardown 뒤에 claim DB 쓰기와
    최대 10,000페이지 순회가 시작된다.
    ※취소 시점에 이미 기록된 6시간 claim 은 그대로 남는다(현행과 동일 — 다음 쿨다운
      만료 전까지 자동 재시도가 없을 뿐, 수동 시작·다음 startup audit 은 가능).
    """
    global _HISTORY_STOPPING
    _HISTORY_STOPPING = True
    starters = [task for task in list(_HISTORY_STARTERS) if task and not task.done()]
    for task in starters:
        task.cancel()
    if starters:
        await asyncio.gather(*starters, return_exceptions=True)
    tasks = [task for task in _HISTORY_TASKS.values() if task and not task.done()]
    for task in tasks:
        task.cancel()
    if tasks:
        await asyncio.gather(*tasks, return_exceptions=True)


async def _run_history_import(
    key: str,
    acc: dict,
    *,
    account_scope: str | None = None,
) -> None:
    state = _HISTORY_STATES[key]
    captured_scope = (
        _capture_history_scope() if account_scope is None else account_scope
    )
    account_override = active_account.set_override(captured_scope or "")
    token = ""
    try:
        runner = _INGEST_RUNNER
        if runner is None:
            # 라우터가 아직 hook 을 안 걸었다 — 정상 부팅 순서(라우터 import 후 lifespan)에선
            # 불가능하지만, 테스트/부분 import 에서 조용히 잘못 적재되는 것보단 명시 실패가 낫다.
            raise higgsfield_history.HistoryFetchError("적재 코어가 아직 준비되지 않았습니다")
        account_status = await cli_bridge.get_account_status(timeout=30.0)
        if not account_status.get("connected") or not account_status.get("email"):
            raise higgsfield_history.HistoryFetchError(
                "Higgsfield CLI 로그인이 필요합니다. CLI에 로그인한 뒤 다시 눌러주세요."
            )
        audit_email = norm_email(account_status.get("email")) or _history_audit_email(key)
        token = await cli_bridge.get_auth_token(timeout=30.0)
        cursor: int | float | str | None = None
        seen_cursors: set[str] = set()
        for _page_number in range(10_000):
            page = await higgsfield_history.fetch_page(token, cursor, size=100)
            jobs = [mcp_item_to_cli(item) for item in page.items]
            out = await asyncio.to_thread(
                runner,
                acc,
                jobs,
                None,
                account_status,
            )
            state["pages"] += 1
            state["received"] += len(page.items)
            state["inserted"] += out.inserted
            state["updated"] += out.updated
            state["unchanged"] += out.unchanged
            state["skipped"] += out.skipped
            state["errors"] += out.errors
            state["message"] = f"과거 생성물 확인 중 · {state['received']}건"
            next_cursor = page.next_cursor
            if next_cursor is None:
                state["state"] = "complete"
                state["message"] = f"가져오기 완료 · 총 {state['received']}건 확인"
                state["finished_at"] = datetime.now(timezone.utc).isoformat()
                await asyncio.to_thread(repo.complete_history_import, audit_email)
                if MANAGE_ENABLED and _SCHEDULE_TELEMETRY:
                    _SCHEDULE_TELEMETRY()
                return
            marker = str(next_cursor).strip()
            if not marker or marker in seen_cursors:
                raise higgsfield_history.HistoryFetchError(
                    "Higgsfield 페이지 정보가 반복되어 안전하게 중단했습니다"
                )
            seen_cursors.add(marker)
            cursor = next_cursor
            await asyncio.sleep(0)
        raise higgsfield_history.HistoryFetchError(
            "과거 이력이 너무 많아 안전 상한에서 중단했습니다"
        )
    except asyncio.CancelledError:
        state["state"] = "failed"
        state["message"] = "프로그램이 종료되어 중단됐습니다. 다시 누르면 이어서 보충됩니다."
        state["finished_at"] = datetime.now(timezone.utc).isoformat()
        raise
    except (cli_bridge.CLIError, higgsfield_history.HistoryFetchError, HTTPException) as exc:
        state["state"] = "failed"
        state["message"] = str(getattr(exc, "detail", None) or exc)
        state["finished_at"] = datetime.now(timezone.utc).isoformat()
        if state.get("automatic"):
            _logger.warning("history_auto_import_failed error_type=%s", type(exc).__name__)
    except Exception as exc:  # noqa: BLE001 — 백그라운드 task 예외 유실 방지
        _logger.exception("history_import_failed", extra={"error_type": type(exc).__name__})
        state["state"] = "failed"
        state["message"] = "과거 생성물 가져오기에 실패했습니다. 다시 시도해 주세요."
        state["finished_at"] = datetime.now(timezone.utc).isoformat()
    finally:
        token = ""  # 토큰을 전역 상태나 로그에 남기지 않는다.
        _HISTORY_TASKS.pop(key, None)
        active_account.reset_override(account_override)

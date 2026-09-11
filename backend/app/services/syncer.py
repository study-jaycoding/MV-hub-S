"""힉스필드 주기 동기화 (실시간성).

`generate list --json` 은 무료 읽기이므로 백그라운드에서 주기적으로 끌어와
다른 기기·웹·MCP 로 만들어진 잡(생성/결과물/실패)을 자동 반영한다. 변동이 있으면
WS 로 push 해 프론트가 즉시 새로고침하게 한다.

⚠️ 과도기 기능(push 모델 — project_content_hub_push_model): 이 주기 동기화는 **서버에 붙은
   힉스필드 CLI 계정(=하우스/jay) 본인 것만** 끌어온다. 본질적으로는 그 사람도 로컬→push 가
   맞지만, 서버가 jay PC 에 얹혀 있는 동안의 편의로 유지한다. 서버를 다른 머신으로 옮기면
   `CONTENT_HUB_SERVER_SYNC=0` 으로 끄고 전원 push 에이전트로 일원화한다.
   비용 호출(generate create)은 서버가 하지 않는다 — 전원 로컬 CLI(gen-request).
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import os
import time
from typing import Callable, Optional

from .. import active_account, repo
from ..config import AUTH_ENABLED, DEFAULT_WORKER_ID, LOCAL_AGENT_PAIR_SECRET, MANAGE_ENABLED
from ..generation_result import normalize_job_result
from ..ws import manager
from . import cli_bridge, history_autofill
from .async_tools import to_thread_non_abandon
from .operational_logging import log_event


_log = logging.getLogger("mvhub.syncer")

# 서버측 주기 동기화 on/off(과도기 게이트). 0/false 면 주기 루프를 아예 안 띄운다 — 서버가
# 하우스 PC 밖으로 이전됐을 때 전원 push 에이전트로 일원화하는 스위치. 기본 on.
SERVER_SYNC_ENABLED = os.environ.get("CONTENT_HUB_SERVER_SYNC", "1").lower() in ("1", "true", "yes", "on")

# 주기(초). 0 이하이면 비활성. generate list 는 무료지만 과도한 호출 방지로 기본 20초.
SYNC_INTERVAL = float(os.environ.get("CONTENT_HUB_SYNC_INTERVAL", "20"))

# 갭 경보 워터마크: 한 번의 동기화에서 신규(inserted)가 이 수 이상이면 100-window 밖으로
# 못 본 잡이 밀려났을 수 있다는 신호(CLI 는 최신 100개·페이지네이션 불가).
# 받는 즉시 더 끌어올 방법은 없으므로 경보만 남기고, 사용자가 web/타 소스 export 로 보완.
SYNC_WATERMARK = int(os.environ.get("CONTENT_HUB_SYNC_WATERMARK", "85"))

# 유령 '생성중' 카드 자동 정리 age 가드(초). 힉스필드에서 사라진(rejected/expired) 잡이 동기화본
# pending/running 으로 남아 세션 내내 '생성중'에 멈추는 것을 정리한다(gen_request 없는 synced active
# 만 좁게 겨냥). 방금 제출된 잡의 일시 not-found 오판을 피하려 이 시간(기본 5분) 이상 된 것만
# 검증·정리 대상으로 삼는다. 실제 삭제는 generate get 이 '없음' 확정한 것만.
STUCK_SYNCED_AGE = float(os.environ.get("CONTENT_HUB_STUCK_SYNCED_AGE", "300"))

# 중복 정리가 실패한 경우 신규 insert가 없는 다음 주기에도 한 번 더 시도한다. 성공하면 즉시 해제해
# 평상시의 "insert가 있을 때만 정리" 비용 계약은 그대로 유지한다.
_duplicate_reconcile_pending = False


def _capture_account_scope() -> str:
    """CLI 대기 전에 계정 DB 키만 전환 락 아래 짧게 캡처한다. 느린 작업은 락 밖에서 돈다."""
    with active_account.transition_lock:
        return active_account.account_key() or ""


async def sync_now(
    worker_id: Optional[str] = None, *, account_scope: Optional[str] = None
) -> dict[str, int]:
    """CLI 에서 최근 생성 이력을 끌어와 업서트. 카운트 반환.
    신규가 워터마크 이상이면 gap_warning=1 을 함께 반환(누락 위험 알림).

    DB 업서트는 ① 한 트랜잭션 배치(repo.apply_synced_jobs, fsync 1회) + ② to_thread 워커
    스레드에서 수행한다 — 이전엔 잡마다 커넥션·fsync 를 메인 이벤트 루프에서 돌려, 20초 주기마다
    들어오는 HTTP 요청(관리자 창 등)을 그 사이 통째로 밀리게 했다(체감 딜레이의 정체).

    ★DB 를 '쓰는' to_thread 는 to_thread_non_abandon 으로 돈다 — 순정 to_thread 는 취소 즉시
    반환하고 스레드는 계속 써서, PeriodicSync.stop() 이 끝난 뒤(실측 중앙값 0.069ms)에도 87~106ms
    동안 DB 쓰기가 이어졌다(lifespan 의 DB 정리와 겹칠 수 있는 구간). 읽기 전용 to_thread 는
    그대로 둔다(방치돼도 부수효과 없음). CLI 호출 횟수·캐시·리프레시 정책은 불변 — 종료 대기만 추가."""
    global _duplicate_reconcile_pending

    # ★계정 범위를 CLI 대기 '전에' 못 박는다 — 주기가 20초라 로그인/계정 전환과 겹치기 쉽고,
    # 그러면 A 계정 CLI 로 받은 잡이 전환된 B 계정 DB 에 적재됐다. 캡처는 워커 스레드에서
    # (transition_lock 은 로그인 마이그레이션·DB 복원 동안 통째로 잡혀 있다).
    # override 는 DB 라우팅만 바꾼다 — CLI 호출 횟수·순서·캐시 정책은 그대로다.
    # account_scope 를 받았으면 그 값을 쓴다 — 배경 실행(워크스페이스 전환 뒤)은 **예약한 쪽이**
    # 요청 시점에 캡처해 넘긴다. 여기서 다시 캡처하면 그 사이 바뀐 계정으로 적재될 수 있다.
    if account_scope is None:
        account_scope = await asyncio.to_thread(_capture_account_scope)
    jobs = await cli_bridge.list_jobs()
    account_token = active_account.set_override(account_scope)
    try:
        wid = worker_id or DEFAULT_WORKER_ID
        changed_job_ids: set[str] = set()
        counts = await to_thread_non_abandon(
            repo.apply_synced_jobs,
            jobs,
            wid,
            changed_job_ids=changed_job_ids,
            track_telemetry=MANAGE_ENABLED,
        )
        counts["fetched"] = len(jobs)
        counts["telemetry_pending"] = 0
        if MANAGE_ENABLED:
            # 실제 outbox 표시는 generation 업서트와 같은 트랜잭션에서 끝났다. 여기서는 전송 실패로
            # 남아 있는 과거 대기열까지 포함해 다음 드레인 여부만 읽는다.
            from ..repo import manage as manage_repo
            try:
                status = await asyncio.to_thread(manage_repo.telemetry_outbox_status)
                counts["telemetry_pending"] = int(status.get("pending") or 0)
            except Exception as exc:  # noqa: BLE001 — 데이터는 원자적으로 보존됐고 다음 주기에 재조회
                counts["telemetry_pending"] = int(counts.get("telemetry_dirty") or 0) + int(
                    counts.get("telemetry_backfilled") or 0
                )
                log_event(
                    _log,
                    "sync_telemetry_status_failed",
                    level=logging.WARNING,
                    error_type=type(exc).__name__,
                )
        # 신규 적재가 있으면 그 자리에서 중복 정리 — create/sync 레이스로 생긴 중복 2행(로컬 placeholder +
        # 동기화본)이 다음 재시작까지 남지 않게 한다(예전엔 reconcile 가 부팅 때 1회뿐이라 런타임 내내
        # 그리드·카운트에 중복 노출). 중복 없으면 GROUP BY HAVING>1 이 빈 결과라 사실상 무비용.
        if counts.get("inserted") or _duplicate_reconcile_pending:
            try:
                counts["reconciled"] = await to_thread_non_abandon(repo.reconcile_duplicates)
            except Exception as exc:  # noqa: BLE001 — 동기화 결과는 보존하고 다음 주기에 다시 시도
                _duplicate_reconcile_pending = True
                # 예외 원문에는 DB 값이 섞일 수 있어 기록하지 않는다. 타입과 고정된 영향 요약만 남긴다.
                log_event(
                    _log,
                    "sync_duplicate_reconcile_failed",
                    level=logging.WARNING,
                    error_type=type(exc).__name__,
                    error_summary="duplicate reconcile deferred until next sync",
                )
            else:
                _duplicate_reconcile_pending = False
        # 워터마크 초과 = 누락 위험. 100개를 꽉 채워 가져왔는데 대부분이 신규면 더 의심.
        counts["gap_warning"] = 1 if (
            counts["inserted"] >= SYNC_WATERMARK and len(jobs) >= 100
        ) else 0
        if counts["gap_warning"]:
            email = await _house_account_email()
            if email:
                await to_thread_non_abandon(repo.mark_history_gap, email)
                # 공유 팀 서버는 계정별 CLI 자격을 갖지 않으므로 기록·경보만 남긴다. 로컬 허브와
                # test_dev pairing 모드만 history 자동 보충(서비스 계층)을 시작한다.
                if not AUTH_ENABLED or LOCAL_AGENT_PAIR_SECRET:
                    await history_autofill.auto_start_history_import(email, reason="gap")
        return counts
    finally:
        active_account.reset_override(account_token)


async def reconcile_stuck_synced() -> int:
    """유령 '생성중' 카드(힉스필드에서 사라진 잡의 pending/running 동기화본)를 자동 정리.
    좁은 후보만 generate get 으로 검증해, '삭제됨(False)' 확정된 것만 휴지통으로 보낸다.
    확인불가(None)·존재(True)는 절대 안 건드린다 → 진짜 진행중 잡 오살 방지. 반환: 정리 건수.
    정상 시 후보 0건이라 CLI 호출도 0(사실상 무비용)."""
    cutoff = time.time() - STUCK_SYNCED_AGE
    house_uid: Optional[str] = None
    if AUTH_ENABLED:
        email = await _house_account_email()
        if not email:
            return 0
        account = await asyncio.to_thread(repo.get_account, email)
        house_uid = str((account or {}).get("creator_uid") or "").strip() or None
        if not house_uid:
            return 0
        cands = await asyncio.to_thread(
            repo.list_stuck_synced_active,
            STUCK_SYNCED_AGE,
            house_uid,
        )
    else:
        cands = await asyncio.to_thread(repo.list_stuck_synced_active, STUCK_SYNCED_AGE)
    if not cands:
        return 0
    trashed = 0
    for gen_id, job_id in cands:
        exists = await cli_bridge.job_exists(job_id)
        if exists is False:  # 힉스필드에서 사라짐 확정 → 유령 카드 휴지통행(soft delete, 복구 가능)
            if house_uid is not None:
                moved = await to_thread_non_abandon(
                    repo.move_to_trash_if_stuck_synced,
                    gen_id,
                    job_id,
                    cutoff,
                    house_uid,
                )
            else:
                moved = await to_thread_non_abandon(
                    repo.move_to_trash_if_stuck_synced,
                    gen_id,
                    job_id,
                    cutoff,
                )
            if moved:
                trashed += 1
    return trashed


_house_email: Optional[str] = None


async def _house_account_email() -> Optional[str]:
    """서버에 붙은 CLI(하우스) 계정 이메일 — 재조정 후보 스코프용. 1회 조회 후 캐시."""
    global _house_email
    if _house_email is None:
        with contextlib.suppress(Exception):
            acct = await cli_bridge.get_account_status()
            _house_email = (acct.get("email") or "").lower() or None
    return _house_email


async def reconcile_local_house() -> int:
    """하우스 계정의 '실제 상태 미확정'(확인중/유실된 running, job_id 보유) 로컬 카드를 서버 CLI 로
    generate get 해 실제 상태로 보정한다 — 하우스도 로컬 실행이므로 fulfill 유실·모호실패가 날 수 있다.
    팀원 카드는 그 사람 에이전트가 담당(계정 소유권). 서버 CLI 는 하우스 잡만 조회 가능하므로 후보를
    하우스 이메일로 좁힌다. 조회만(과금 없음). 반환: 보정 건수."""
    email = await _house_account_email()
    if not email:
        return 0
    cands = await asyncio.to_thread(repo.list_reconcile_candidates, email)
    if not cands:
        return 0
    applied_n = 0
    for c in cands:
        raw = await cli_bridge.get_job_raw(c["job_id"])
        if not raw:
            continue  # 확인불가/삭제/파싱실패 → 안 건드림
        parsed = cli_bridge.parse_job(raw)
        result = normalize_job_result(parsed)
        if result.status in ("pending", "running"):
            continue  # 아직 처리중 → 확인중 유지
        applied = await to_thread_non_abandon(
            repo.apply_reconcile,
            c["gen_id"],
            result.job_id,
            asset_type=result.asset_type,
            asset_path=result.asset_path,
            asset_thumb=result.asset_thumb,
            created_at=result.created_at,
            sort_ts=result.sort_ts,
            status=result.status,
            error=result.error,
            provider_status=str(raw.get("status") or raw.get("job_status") or "").strip().lower(),
        )
        if applied:
            applied_n += 1
    return applied_n


class SwitchSync:
    """워크스페이스 전환 뒤의 동기화를 요청 경로 밖에서 돌리는 단일 배경 작업.

    전환 응답을 CLI 동기화(실측 `generate list --size 100` ≈1.9초)에 묶지 않는다. 전환은 바로
    끝내고, 새 공간의 잡은 뒤에서 끌어와 끝나면 `synced` 로 알려 화면이 스스로 다시 읽게 한다.

    ★계정 DB 키는 **예약하는 쪽이** 요청 시점에 캡처해 넘긴다 — 실행 시점엔 계정이 바뀌었을 수 있다.
    ★진행 중이면 새 작업을 만들지 않고 '한 번 더' 표시만 남겨 합친다. 빠른 연속 전환이 CLI 조회와
     DB 쓰기를 겹겹이 쌓지 않게 하고, 마지막 요청의 계정 범위로 한 번 더 돈다.
    ★`synced` 알림은 '가장 최근 전환이냐'와 **무관하게** 보낸다. 이미 DB 에 들어간 변경은 그 뒤
     어느 공간을 고르든 화면이 읽어야 한다 — 전환 순번으로 버리면 그 변경을 다시 읽을 계기가 없다.
    """

    _OnDone = Optional[Callable[[dict[str, int]], None]]

    def __init__(self) -> None:
        self._task: Optional[asyncio.Task] = None
        self._again: Optional[tuple[str, "SwitchSync._OnDone"]] = None
        self._closing = False

    def arm(self) -> None:
        """lifespan 시작 — 앞선 실행의 종료 표시를 푼다(한 프로세스에서 앱을 여러 번 띄우는 테스트)."""
        self._closing = False

    async def schedule(self, on_done: "SwitchSync._OnDone" = None) -> bool:
        """전환 직후 동기화를 예약한다. 예약했으면 True, 종료 중이라 받지 않았으면 False.

        on_done 은 동기화가 끝날 때마다 카운트와 함께 불린다(텔레메트리 드레인 예약처럼 라우터
        계층이 붙이는 짧은 후속). 예외를 던지지 않아야 한다."""
        if self._closing:
            return False
        scope = await asyncio.to_thread(_capture_account_scope)
        # ★대기 뒤 다시 본다 — 캡처를 기다리는 동안 stop() 이 끝났을 수 있고, 그러면 회수된 뒤에
        #  새 작업이 시작된다(코덱스 리뷰에서 메모리 재현으로 확인).
        if self._closing:
            return False
        if self._task is not None and not self._task.done():
            self._again = (scope, on_done)  # 진행 중 — 끝난 뒤 마지막 요청으로 한 번 더
            return True
        self._task = asyncio.create_task(self._run(scope, on_done), name="switch-sync")
        return True

    async def _run(self, scope: str, on_done: "SwitchSync._OnDone") -> None:
        while True:
            try:
                counts = await sync_now(account_scope=scope)
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # noqa: BLE001 — 배경 작업이 죽어도 다음 전환·주기가 재시도
                log_event(
                    _log,
                    "switch_sync_failed",
                    level=logging.WARNING,
                    error_type=type(exc).__name__,
                )
            else:
                if counts.get("inserted") or counts.get("updated"):
                    await manager.broadcast_all({"type": "synced"})
                if on_done is not None:
                    # ★예약 당시의 계정 범위 안에서 부른다 — sync_now 는 반환 전에 override 를 풀기
                    #  때문에, 그냥 부르면 그 사이 바뀐 계정의 outbox 를 보고 예약하게 된다.
                    token = active_account.set_override(scope)
                    try:
                        on_done(counts)
                    except Exception as exc:  # noqa: BLE001 — 후속 실패가 동기화를 되돌리지 않는다
                        log_event(
                            _log,
                            "switch_sync_on_done_failed",
                            level=logging.WARNING,
                            error_type=type(exc).__name__,
                        )
                    finally:
                        active_account.reset_override(token)
            pending, self._again = self._again, None
            if pending is None or self._closing:
                return
            scope, on_done = pending

    async def stop(self) -> None:
        """종료 회수 — 새 예약을 막고 진행 중 작업을 취소·대기한다. DB 쓰기는 sync_now 안에서
        to_thread_non_abandon 이라, 여기서 돌아온 시점엔 그 스레드도 이미 끝나 있다."""
        self._closing = True
        self._again = None
        task, self._task = self._task, None
        if task is not None:
            task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await task


switch_sync = SwitchSync()


class PeriodicSync:
    def __init__(self, interval: float = SYNC_INTERVAL) -> None:
        self._interval = interval
        self._task: Optional[asyncio.Task] = None

    def start(self) -> None:
        if not SERVER_SYNC_ENABLED:
            print("[syncer] 서버측 주기 동기화 비활성(CONTENT_HUB_SERVER_SYNC=0) — 전원 push 에이전트 모드")
            return
        if self._interval <= 0:
            return  # 비활성
        if self._task is None or self._task.done():
            self._task = asyncio.create_task(self._run(), name="periodic-sync")

    async def stop(self) -> None:
        """루프 취소 + 회수. 반환 시점에 이 루프의 DB 쓰기 스레드는 이미 끝나 있다 —
        쓰기 to_thread 가 non-abandon 이라 취소가 스레드 완료 뒤에야 여기까지 올라온다.
        (CLI 대기·읽기 구간에서 취소되면 종전처럼 즉시 반환 — 종료 지연 없음.)"""
        if self._task:
            self._task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._task
            self._task = None

    async def _run(self) -> None:
        while True:
            await asyncio.sleep(self._interval)
            try:
                c = await sync_now()
                if c.get("telemetry_pending") or c.get("telemetry_dirty"):
                    # 주기 동기화는 AUTH on 공유 서버에서만 시작되므로 로컬 관리 DB로 즉시 반영한다.
                    # 네트워크 프록시를 거치지 않아 이벤트 루프 밖 워커에서 안전하게 처리할 수 있다.
                    from .telemetry_drain import drain_isolated_telemetry

                    await to_thread_non_abandon(drain_isolated_telemetry)
                if c.get("gap_warning"):
                    print(
                        f"[periodic-sync] ⚠ 갭 경보: 신규 {c['inserted']}건 — "
                        f"100-window 밖으로 밀린 잡이 있을 수 있음. web/타 소스 export 로 보완 필요."
                    )
                    # 전체 reload 신호(데이터 아님) — AUTH on 다계정 서버에서도 전원이 받아야 하므로
                    # 계정 스코프 broadcast 가 아니라 broadcast_all 을 쓴다(ws.broadcast 는 이제 정확 스코프).
                    await manager.broadcast_all(
                        {"type": "gap_warning", "inserted": c["inserted"]}
                    )
                # 신규/상태변동이 있으면 프론트에 새로고침 신호.
                if c["inserted"] or c["updated"]:
                    await manager.broadcast_all({"type": "synced"})
                # 유령 '생성중' 카드(힉스필드에서 사라진 잡) 자동 정리 — 후보 없으면 무비용.
                stuck = await reconcile_stuck_synced()
                if stuck:
                    print(f"[periodic-sync] 유령 '생성중' 카드 {stuck}건 정리(힉스필드에서 사라진 잡)")
                    await manager.broadcast_all({"type": "synced"})
                # 하우스 계정 로컬 카드의 '실제 상태 미확정'(확인중/유실된 running) 보정 — 후보 없으면 무비용.
                fixed = await reconcile_local_house()
                if fixed:
                    print(f"[periodic-sync] 미확정 로컬 카드 {fixed}건 실제 상태로 보정")
                    await manager.broadcast_all({"type": "synced"})
            except asyncio.CancelledError:
                raise
            except cli_bridge.CLIError as exc:
                # CLI 일시 불가도 운영 상태에 남기고 다음 주기에 재시도한다. 예외 원문은 토큰·URL이
                # 섞일 수 있으므로 구조화 로그에는 안전한 타입만 기록한다.
                log_event(
                    _log,
                    "periodic_sync_cli_failed",
                    level=logging.WARNING,
                    error_type=type(exc).__name__,
                )
            except Exception as exc:  # noqa: BLE001 — 워커가 죽지 않도록 격리
                log_event(
                    _log,
                    "periodic_sync_failed",
                    level=logging.ERROR,
                    error_type=type(exc).__name__,
                    exc_info=True,
                )


periodic_sync = PeriodicSync()

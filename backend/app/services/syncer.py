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
from typing import Optional

from .. import repo
from ..config import AUTH_ENABLED, DEFAULT_WORKER_ID, LOCAL_AGENT_PAIR_SECRET, MANAGE_ENABLED
from ..generation_result import normalize_job_result
from ..ws import manager
from . import cli_bridge, history_autofill
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


async def sync_now(worker_id: Optional[str] = None) -> dict[str, int]:
    """CLI 에서 최근 생성 이력을 끌어와 업서트. 카운트 반환.
    신규가 워터마크 이상이면 gap_warning=1 을 함께 반환(누락 위험 알림).

    DB 업서트는 ① 한 트랜잭션 배치(repo.apply_synced_jobs, fsync 1회) + ② to_thread 워커
    스레드에서 수행한다 — 이전엔 잡마다 커넥션·fsync 를 메인 이벤트 루프에서 돌려, 20초 주기마다
    들어오는 HTTP 요청(관리자 창 등)을 그 사이 통째로 밀리게 했다(체감 딜레이의 정체)."""
    jobs = await cli_bridge.list_jobs()
    wid = worker_id or DEFAULT_WORKER_ID
    changed_job_ids: set[str] = set()
    counts = await asyncio.to_thread(
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
    if counts.get("inserted"):
        with contextlib.suppress(Exception):
            counts["reconciled"] = await asyncio.to_thread(repo.reconcile_duplicates)
    # 워터마크 초과 = 누락 위험. 100개를 꽉 채워 가져왔는데 대부분이 신규면 더 의심.
    counts["gap_warning"] = 1 if (
        counts["inserted"] >= SYNC_WATERMARK and len(jobs) >= 100
    ) else 0
    if counts["gap_warning"]:
        email = await _house_account_email()
        if email:
            await asyncio.to_thread(repo.mark_history_gap, email)
            # 공유 팀 서버는 계정별 CLI 자격을 갖지 않으므로 기록·경보만 남긴다. 로컬 허브와
            # test_dev pairing 모드만 history 자동 보충(서비스 계층)을 시작한다.
            if not AUTH_ENABLED or LOCAL_AGENT_PAIR_SECRET:
                await history_autofill.auto_start_history_import(email, reason="gap")
    return counts


async def reconcile_stuck_synced() -> int:
    """유령 '생성중' 카드(힉스필드에서 사라진 잡의 pending/running 동기화본)를 자동 정리.
    좁은 후보만 generate get 으로 검증해, '삭제됨(False)' 확정된 것만 휴지통으로 보낸다.
    확인불가(None)·존재(True)는 절대 안 건드린다 → 진짜 진행중 잡 오살 방지. 반환: 정리 건수.
    정상 시 후보 0건이라 CLI 호출도 0(사실상 무비용)."""
    cands = await asyncio.to_thread(repo.list_stuck_synced_active, STUCK_SYNCED_AGE)
    if not cands:
        return 0
    trashed = 0
    for gen_id, job_id in cands:
        exists = await cli_bridge.job_exists(job_id)
        if exists is False:  # 힉스필드에서 사라짐 확정 → 유령 카드 휴지통행(soft delete, 복구 가능)
            if await asyncio.to_thread(repo.delete_generation, gen_id):
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
        applied = await asyncio.to_thread(
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

                    await asyncio.to_thread(drain_isolated_telemetry)
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

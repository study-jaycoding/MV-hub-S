"""FastAPI 엔트리 (Phase 2/3).

앱 팩토리: 시작 시 DB 초기화 + 기본 작업자 시드, 잡 큐 워커 기동,
라우터·정적 미디어·WebSocket 마운트.

실행: uvicorn app.main:app  (backend/ 에서)
⚠️ Windows 에서는 --reload 금지 — SelectorEventLoop 이 강제돼 CLI subprocess 가 깨진다.
"""

from __future__ import annotations

import asyncio
import time
import logging
import os
import sys
import warnings
from contextlib import asynccontextmanager, suppress

# Windows 함정: CLI 브리지(asyncio subprocess)는 Proactor 이벤트 루프가 필요하다.
# 아래처럼 import 시점에 Proactor 정책을 박아두면 일반 실행(uvicorn app.main:app)에서는
# subprocess 가 동작한다. 단, uvicorn --reload 는 리로더가 SelectorEventLoop 을 강제하므로
# 이 정책으로도 막을 수 없다(NotImplementedError) → Windows 에서는 --reload 없이 실행.
if sys.platform == "win32":
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", DeprecationWarning)
        try:
            asyncio.set_event_loop_policy(asyncio.WindowsProactorEventLoopPolicy())
        except Exception:
            pass

from fastapi import FastAPI, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from . import repo
from .config import (
    ALLOW_REMOTE_AUTH_OFF,
    AUTH_ENABLED,
    BACKEND_DIR,
    CORS_ORIGINS,
    DATA_DIR,
    EXTERNAL_RECOVERY_ENABLED,
    FRONTEND_DIST,
    MANAGE_ENABLED,
    MEDIA_DIR,
    ensure_dirs,
)
from .db import init_db, maintenance_active
from .deps import session_token
from .mutation_notify import (
    CLIENT_ID_HEADER,
    DOMAIN_ASSETS,
    DOMAIN_LIBRARY,
    DOMAIN_MANAGE,
    MUTATION_DOMAINS_HEADER,
    MUTATION_ID_HEADER,
    notification_domains,
    parse_mutation_origin,
)
from .static_files import ImmutableStaticFiles
from .services.test_snapshot import SNAPSHOT_EXPORT_ENV, SNAPSHOT_EXPORT_PATH
from .routers import (
    _proxy,
    assets,
    auth,
    comfy,
    db_backup,
    db_transfer,
    gen_requests,
    generation,
    ingest,
    library,
    members,
    notifications,
    projects,
    publish,
    release_update,
    resolve_integration,
    scenes,
    share,
    sync,
)
from .services import auth as auth_svc
from .services.agent_signals import agent_signals
from .services.backup import periodic_backup
from .services.worker_backup import (
    periodic_worker_backup,
    queue_backup_set,
    queue_latest_local_backup,
)
from .services.temp_sweeper import periodic_sweeper
from .services.media_preservation import periodic_media_preservation
from .services.share_state_reconciler import (
    configure_share_state_router_deps,
    periodic_share_state_reconciler,
)
from .services.operational_logging import (
    compact_runtime_snapshot,
    configure_operational_logging,
    log_event,
    should_log_http_request,
)
from .services.operational_health import (
    OperationalAlertTracker,
    database_readiness,
    operations_snapshot,
)
from .services.request_guards import is_loopback_host
from .services.upload_limits import UploadBodyLimitMiddleware
from .services.runtime_metrics import metrics as runtime_metrics
from .services.path_safety import safe_join
from .services.remote_realtime import RemoteRealtimeBridge, relay_event
from .services.syncer import periodic_sync
from .usecases.gen_requests import shutdown_request_estimates
from .ws import manager

_runtime_log = logging.getLogger("mvhub.runtime")
_SLOW_REQUEST_MS = float(os.environ.get("CONTENT_HUB_SLOW_REQUEST_MS", "1000"))
_METRICS_LOG_INTERVAL = max(
    0.0,
    float(os.environ.get("CONTENT_HUB_METRICS_LOG_INTERVAL", "60")),
)
_operational_alerts = OperationalAlertTracker()


def _remote_realtime_config() -> tuple[str, str] | None:
    """현재 활성 로컬 계정의 공유 서버 연결값. 로그인·계정전환 때 자동으로 달라진다."""
    if not _proxy.is_worker_hub():
        return None
    token = _proxy.token()
    if not token:
        return None
    return _proxy.base_url(), token


remote_realtime_bridge = RemoteRealtimeBridge(
    _remote_realtime_config,
    lambda event: relay_event(event, manager),
)


async def _runtime_report_loop(interval: float) -> None:
    """주기적으로 집계 지표를 회전 로그에 남긴다. 개인 식별정보는 기록하지 않는다."""
    while True:
        await asyncio.sleep(interval)
        try:
            # 디스크 스냅샷의 미디어 폴더 재귀 스캔이 이벤트 루프를 막지 않게 스레드에서 수집.
            snapshot = await asyncio.to_thread(runtime_metrics.snapshot)
            snapshot["websocket"] = await manager.stats()
            snapshot["remote_realtime"] = remote_realtime_bridge.stats()
            snapshot["agents"] = agent_signals.stats()
            snapshot["operations"] = await asyncio.to_thread(operations_snapshot)
            for alert in _operational_alerts.events(snapshot):
                event = alert.pop("event")
                log_event(_runtime_log, event, level=logging.WARNING, **alert)
            log_event(
                _runtime_log,
                "runtime_snapshot",
                snapshot=compact_runtime_snapshot(snapshot),
            )
        except asyncio.CancelledError:
            raise
        except Exception:  # noqa: BLE001 — 관측 실패가 앱을 중단하지 않게 하고 장애는 남긴다.
            log_event(
                _runtime_log,
                "runtime_snapshot_failed",
                level=logging.ERROR,
                exc_info=True,
            )


def _should_bootstrap_admin() -> bool:
    """일반 인증 서버에만 초기 관리자를 만들고 다운로드 전용 서버에는 만들지 않는다."""
    return AUTH_ENABLED and os.environ.get(SNAPSHOT_EXPORT_ENV, "").strip() != "1"


def _log_worker_backup_bootstrap_failure() -> None:
    log_event(
        _runtime_log,
        "worker_backup_bootstrap_queue_failed",
        level=logging.ERROR,
        exc_info=True,
    )


async def _worker_backup_bootstrap() -> None:
    """기존 로컬 백업의 outbox 보강을 readiness 밖에서 수행하고 실제 스레드까지 추적한다."""
    loop = asyncio.get_running_loop()
    work = loop.run_in_executor(None, queue_latest_local_backup)
    try:
        await asyncio.shield(work)
    except asyncio.CancelledError:
        # run_in_executor 작업은 Task.cancel()만으로 멈추지 않는다. 종료 중에도 실제 복사·검증이
        # 끝날 때까지 기다려 상태 DB를 periodic worker 정리와 겹치지 않게 한다.
        try:
            await asyncio.shield(work)
        except Exception:  # noqa: BLE001 — 로컬 백업은 보존하고 실패만 운영 로그에 남긴다.
            _log_worker_backup_bootstrap_failure()
        raise
    except Exception:  # noqa: BLE001 — 로컬 백업은 보존하고 다음 주기에서 다시 보강한다.
        _log_worker_backup_bootstrap_failure()
    finally:
        # 기존 순서(queue 보강 뒤 worker 시작)는 유지하되 둘 다 readiness와 분리한다.
        periodic_worker_backup.start()


def _start_worker_backup_bootstrap() -> asyncio.Task[None]:
    return asyncio.create_task(
        _worker_backup_bootstrap(), name="worker-backup-bootstrap"
    )


@asynccontextmanager
async def _application_lifespan(app: FastAPI):
    log_path = configure_operational_logging()
    log_event(_runtime_log, "startup_begin", log_file=log_path.name)
    runtime_report_task: asyncio.Task | None = None
    history_audit_task: asyncio.Task | None = None
    worker_backup_bootstrap_task: asyncio.Task | None = None
    # 시작: DB 스키마 적용(멱등) + 기본 작업자 + 미디어 디렉터리 + 잡 큐 워커
    init_db()
    ensure_dirs()
    # 팀 매니징 텔레메트리 저장소(manage_hub.db) — 콘텐츠 DB와 분리된 별도 파일. MANAGE 켰을 때만.
    if MANAGE_ENABLED:
        from .manage_db import backfill_workspace_names, init_manage_db

        init_manage_db()
        backfill_workspace_names(repo.list_workspace_options())
    repo.ensure_default_worker()
    # Comfy in-flight 잡은 메모리만으로는 재시작 뒤 결과를 회수할 수 없다. 풀 자동복구 대신
    # 이전 prompt_id 를 운영 로그에 남기고 Cloud 취소를 best-effort 로 시도한 뒤 흔적을 비운다.
    comfy.recover_interrupted_run_jobs()
    # 부트스트랩 관리자 — 서버(AUTH on)면 admin 계정을 자동 생성(없을 때만). '따로 안 만들어도
    # 처음부터 admin 이 있게'. 기본 admin@millionvolt.com / admin1985, env 로 변경 가능.
    if _should_bootstrap_admin():
        import secrets as _secrets

        _ae = (os.environ.get("CONTENT_HUB_ADMIN_EMAIL") or "admin@millionvolt.com").strip()
        # 고정 기본 비번은 사용하지 않는다. env 미지정 시 1회용 비밀번호를 별도 파일에만
        # 기록하고 콘솔/운영 로그에는 절대 출력하지 않는다.
        _ap = os.environ.get("CONTENT_HUB_ADMIN_PASSWORD")
        _ap_generated = not _ap
        # 이미 있는 관리자는 비밀번호·역할을 절대 건드리지 않는다. 특히 사용자가 1회용
        # 파일을 지운 뒤 재부팅해도 쓸모없는 새 비밀번호 파일을 만들지 않는다.
        if repo.get_account(_ae) is None:
            if _ap_generated:
                _secret_path = DATA_DIR / "bootstrap_admin_password.txt"
                if _secret_path.exists():
                    _ap = _secret_path.read_text(encoding="utf-8").strip()
                    if len(_ap) < 6:
                        raise RuntimeError("bootstrap admin password file is invalid")
                else:
                    _ap = _secrets.token_urlsafe(12)
                    _secret_path.parent.mkdir(parents=True, exist_ok=True)
                    # 먼저 비밀번호를 안전하게 보관한 뒤 계정을 만든다. 파일 기록이 실패하면
                    # 알 수 없는 비밀번호의 관리자 계정이 생기지 않고 부팅 실패 로그가 남는다.
                    with _secret_path.open("x", encoding="utf-8") as _secret_file:
                        _secret_file.write(_ap + "\n")
                    try:
                        _secret_path.chmod(0o600)
                    except OSError:
                        pass
            if repo.ensure_admin_account(_ae, _ap):
                print("[startup] 부트스트랩 관리자 자동 생성 완료")
                if _ap_generated:
                    print(f"[startup] 1회용 비밀번호 파일: {_secret_path}")
                    print("[startup] 로그인 후 비밀번호를 변경하고 해당 파일을 삭제하세요.")
    # 미디어 디렉터리 샤딩(1회 이전, 멱등) — 평면 /media/<sha> → /media/<2>/<sha>. 핫 폴더 비대화 방지.
    from .services import media_cache

    sharded = media_cache.migrate_sharding()
    if sharded:
        print(f"[startup] 미디어 {sharded}개를 샤딩 디렉터리로 이전")
    # 크래시/재시작 복구: CLI 호출 전 만료 claim은 재큐잉하고, 호출 뒤 job_id가 없는 모호한
    # 결말은 recovery_required로 격리한다. lease 만료만으로 유료 생성을 다시 실행하지 않는다.
    expired_claims = repo.sweep_expired_generation_claims()
    if expired_claims:
        requeued = sum(item["action"] == "requeued" for item in expired_claims)
        quarantined = len(expired_claims) - requeued
        print(
            f"[startup] 만료 생성 claim 복구: 재큐잉 {requeued}개, "
            f"수동 확인 격리 {quarantined}개"
        )
    # 영속 gen_request가 없는 옛 인메모리 고아만 failed로 정리한다.
    orphaned = repo.fail_orphaned_jobs()
    if orphaned:
        print(f"[startup] 요청 기록 없는 옛 고아 잡 {orphaned}개를 failed 로 정리")
    # create/sync 레이스로 생긴 중복(같은 결과물 2행) 병합 정리
    dups = repo.reconcile_duplicates()
    if dups:
        print(f"[startup] 중복 동기화본 {dups}개를 병합 정리")
    # DRY-RUN(읽기 전용): acct:<email> 잔재가 어느 테이블에 얼마나 남았는지 실측 로그.
    # 실제 전면 리맵 전, 오염 규모·매핑 정확성을 눈으로 확인하기 위함(변경 없음).
    try:
        plan = repo.creator_uid_remap_plan()
        if plan["total_acct_rows"]:
            print(
                f"[startup][dry-run] acct: 잔재 총 {plan['total_acct_rows']}행 "
                f"({len(plan['changes'])} 항목) — 전면 리맵 후보:"
            )
            for c in plan["changes"]:
                tgt = ("→ " + c["new"]) if c["new"] else "✗ 매핑없음(고아·자동제외)"
                print(f"           {c['table']}.{c['col']}  {c['old']} x{c['count']}  {tgt}")
            if plan["unmapped"]:
                print(
                    f"[startup][dry-run] ★account 에 대응 없는 acct: {len(plan['unmapped'])}종 "
                    f"— 자동 리맵 제외(수동 확인 필요)"
                )
    except Exception as _e:  # noqa: BLE001 — 진단 로그라 실패해도 부팅 막지 않음
        print(f"[startup][dry-run] remap plan 스킵: {_e}")
    # 과거 acct:<email> 잔재를 account.creator_uid(user_) 로 전 테이블 일괄 정합(1회·멱등).
    # 앞으로의 전환은 set_account_hf_creator 가 push 시점에 자동 정합하므로 재발 없음.
    remapped = repo.migrate_all_acct_to_creator_uid()
    if remapped:
        print(f"[startup] 옛 신원(acct:) {remapped}행을 계정 uid 로 통합")
    # 옛 소프트삭제(deleted_at) 잔존 → 새 휴지통 DB 로 이전(1회, 멱등). 카운트 유령 제거.
    legacy = repo.migrate_legacy_soft_deleted()
    if legacy:
        print(f"[startup] 옛 소프트삭제 {legacy}개를 휴지통 DB 로 이전")
    # 크래시로 휴지통 이동/복원이 한쪽 DB 에만 반영돼 같은 id 가 메인·휴지통에 둘 다 남은 흔적 정리
    # (메인 본을 정답으로 두고 휴지통 복사본 제거 — 데이터 손실 없음). ★위 legacy 이전이 만든 중복까지
    # 같은 부팅에서 잡도록 migrate_legacy_soft_deleted '뒤'에 둔다.
    try:
        td = repo.reconcile_with_main()
        if td:
            print(f"[startup] 휴지통 중복(크래시 흔적) {td}개 정리")
    except Exception as e:  # noqa: BLE001 — 정리 실패가 부팅을 막지 않게
        print(f"[startup] 휴지통 정리 건너뜀: {e}")
    # 생성자 식별자(result_url user_<id>) 백필 — 팀 워크스페이스 작성자 구분
    cu = repo.backfill_creator_uids()
    if cu:
        print(f"[startup] 생성자 uid {cu}개 백필")
    # 제공자 신원 — CLI account status 이메일로 기본값 캡처(공유 파일명·작성자 표기 기준).
    # 사용자가 바꾼 이름은 절대 안 덮어씀. CLI 오프라인이면 조용히 건너뜀(다음 기회).
    if EXTERNAL_RECOVERY_ENABLED:
        try:
            from .services import cli_bridge

            # 부팅이 외부 CLI 응답에 오래 묶이지 않게 짧은 타임아웃 — 실패 시 다음 기회에 캡처(무해).
            status = await cli_bridge.get_account_status(timeout=8.0)
            repo.capture_provider_identity(status.get("email") or None)
        except Exception as e:  # noqa: BLE001 — 신원 캡처 실패가 부팅을 막지 않게
            print(f"[startup] 제공자 신원 캡처 건너뜀: {e}")
    else:
        print("[startup] 외부 복구 비활성(CONTENT_HUB_EXTERNAL_RECOVERY=0) — CLI 신원 캡처 생략")
    # 로그인 계정 ↔ 생성자(creator) 연결 보장(멱등) — 소유자=힉스필드 uid, 그 외=acct:<email>.
    # 이래야 신규 계정이 멤버·프로젝트 후보에 뜨고, '내 작업'이 계정별로 분리된다.
    linked = repo.link_accounts_to_creators()
    if linked:
        print(f"[startup] 계정 {linked}개를 생성자에 연결")
    # 썸네일 사전 생성(백그라운드 데몬, 1회) — 첫 프로젝트 선택·스크롤에서도 생성 지연 없이 즉시 표시.
    # 살짝 throttle 해 시작 직후 CPU 스파이크를 피한다(PIL 은 C 구간서 GIL 해제 → 응답성 유지).
    import threading

    from .services import thumbs

    def _prewarm() -> None:
        try:
            # 그리드가 쓰는 두 버킷(256/512)을 파일 단위로 함께 — 512 만 구우면 100% 배율(256 요청)에서 전부 미스.
            n = thumbs.prewarm_generation_thumbs(throttle=0.005)
            if n:
                print(f"[startup] 썸네일 {n}개 사전 생성 완료(백그라운드)")
        except Exception as e:  # noqa: BLE001
            print(f"[startup] 썸네일 사전 생성 건너뜀: {e}")

    threading.Thread(target=_prewarm, daemon=True, name="thumb-prewarm").start()
    # 주기 동기화는 서버 직결 로컬 허브(AUTH off)에선 끈다 — 데이터는 서버가 정답이고 적재는
    # 에이전트(push)가 한다. 로컬에서 20초마다 CLI 동기화+broadcast 하면 라이브러리가 계속
    # 새로고침돼(로딩 깜빡임) 불필요. 서버(AUTH on)에서만 동작(거기도 CLI 없으면 무해 no-op).
    if AUTH_ENABLED:
        periodic_sync.start()
    if _proxy.is_worker_hub():
        # 로컬 스냅샷 성공 뒤에만 전송 세트를 만들고, 네트워크 전송은 별도 자식 프로세스가
        # 영속 outbox에서 수행한다. 서버 본체·격리 테스트에는 이 부수효과를 붙이지 않는다.
        periodic_backup.set_completed_callback(queue_backup_set)
        worker_backup_bootstrap_task = _start_worker_backup_bootstrap()
    else:
        periodic_backup.set_completed_callback(None)
    periodic_backup.start()  # DB 자동 백업(서버 운영) — 시작 1회 + 주기, 회전 보관
    periodic_sweeper.start()  # 묵은 임시파일(.part/.tmp/comfy 입력/%TEMP%) 청소 + 캐시 eviction
    periodic_media_preservation.start()  # 공유·최종 원본 보존(영속 큐·재시작 복구·용량 상한)
    # 계층 경계(services→routers 금지) 때문에 reconciler 의 라우터 의존은 여기서 주입한다.
    from .routers import _proxy as _share_proxy
    from .routers._telemetry import touch_generation_telemetry

    configure_share_state_router_deps(
        proxy=_share_proxy, touch_telemetry=touch_generation_telemetry
    )
    periodic_share_state_reconciler.start()  # 공유 서버 권위 상태 → 로컬 공유/골드 미러 수렴
    # 어셋 폴더 실시간 감시(watchdog) — 파일 추가/변경 시 WS 로 알려 프론트가 새로고침 없이 갱신.
    # 인증 여부와 분리한다. AUTH on 개발 모드도 로컬 브라우저가 /api/assets/tree 로 조회한 폴더는
    # 외부 편집기로 바뀔 수 있다. 접근 권한은 라우터가 강제하고, 감시기는 조회된 폴더만 lazy 등록한다.
    from .services import asset_watcher

    runtime_loop = asyncio.get_running_loop()
    agent_signals.bind_loop(runtime_loop)
    asset_watcher.start(runtime_loop)
    # 동기 ingest 라우터(anyio 워커)가 텔레메트리 네트워크 전송을 기다리지 않고 이 루프의
    # 단일 백그라운드 drain에 예약할 수 있게 한다.
    from .routers._telemetry import bind_telemetry_loop

    bind_telemetry_loop(runtime_loop)
    from .services.history_autofill import bind_history_loop, startup_history_audit

    bind_history_loop(runtime_loop)
    # 공유 팀 서버는 계정별 CLI 자격이 없으므로 절대 실행하지 않는다. 로컬 허브만 최근 성공
    # audit을 백그라운드로 시작하며, 미로그인은 경고만 남기고 다음 시작·gap 기회로 넘긴다.
    history_audit_task = asyncio.create_task(
        startup_history_audit(), name="history-startup-audit"
    )
    # 위임 모드의 브라우저는 로컬 /ws만 본다. 프로세스당 원격 연결 하나가 다른 PC의 공유 서버
    # 변경 신호를 받아 로컬 소켓 전체에 중계한다(미로그인 상태면 task는 연결 없이 대기).
    if _proxy.is_worker_hub():
        remote_realtime_bridge.start()
        # 업데이트/재시작 전에 남은 생성정보 전송 대기열도 자동으로 한 번 정리한다.
        # 로그인 토큰이 없는 PC에서는 drain_telemetry가 조용히 건너뛴다.
        from .routers._telemetry import schedule_telemetry_drain

        schedule_telemetry_drain()
    if _METRICS_LOG_INTERVAL > 0:
        runtime_report_task = asyncio.create_task(
            _runtime_report_loop(_METRICS_LOG_INTERVAL),
            name="runtime-metrics-log",
        )
    log_event(_runtime_log, "startup_ready")
    try:
        yield
    finally:
        # 종료: 주기 백업 + 주기 동기화 + 어셋 감시 정리
        if runtime_report_task:
            runtime_report_task.cancel()
            try:
                await runtime_report_task
            except asyncio.CancelledError:
                pass
        await shutdown_request_estimates()
        # 새 로컬 백업·outbox 등록을 먼저 멈춘 뒤 전송 자식 프로세스를 정리한다.
        await periodic_backup.stop()
        if worker_backup_bootstrap_task:
            worker_backup_bootstrap_task.cancel()
            with suppress(asyncio.CancelledError):
                await worker_backup_bootstrap_task
        await periodic_worker_backup.stop()
        periodic_backup.set_completed_callback(None)
        await periodic_sweeper.stop()
        await periodic_share_state_reconciler.stop()
        await periodic_media_preservation.stop()
        await remote_realtime_bridge.stop()
        if MANAGE_ENABLED or _proxy.is_worker_hub():
            # 백그라운드 전송이 동적 계정 DB를 쓰는 도중 프로세스 종료/테스트 정리가 겹치지 않게 한다.
            from .routers._telemetry import wait_for_telemetry_drain

            await wait_for_telemetry_drain()
        from .routers._telemetry import unbind_telemetry_loop

        unbind_telemetry_loop(runtime_loop)
        from .services.history_autofill import stop_history_imports, unbind_history_loop

        if history_audit_task and not history_audit_task.done():
            history_audit_task.cancel()
            with suppress(asyncio.CancelledError):
                await history_audit_task
        await stop_history_imports()
        unbind_history_loop(runtime_loop)
        agent_signals.unbind_loop(runtime_loop)
        if AUTH_ENABLED:
            await periodic_sync.stop()
        asset_watcher.stop()
        log_event(_runtime_log, "shutdown_complete")


@asynccontextmanager
async def lifespan(app: FastAPI):
    """시작·종료 어느 단계에서 실패해도 원인을 구조화 로그에 남긴다."""
    phase = "startup"
    try:
        async with _application_lifespan(app):
            phase = "running"
            try:
                yield
            finally:
                phase = "shutdown"
    except BaseException:  # noqa: BLE001 — CancelledError/종료 신호도 단계 구분 후 그대로 전달
        if phase != "running":
            log_event(
                _runtime_log,
                "startup_failed" if phase == "startup" else "shutdown_failed",
                level=logging.ERROR,
                phase=phase,
                exc_info=True,
            )
        raise


app = FastAPI(title="Millionvolt Hub", version="0.1.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=[o.strip() for o in CORS_ORIGINS if o.strip()],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
    expose_headers=[MUTATION_ID_HEADER, MUTATION_DOMAINS_HEADER],
)

app.include_router(library.router)
app.include_router(generation.router)
app.include_router(share.router)
app.include_router(sync.router)
app.include_router(assets.router)
app.include_router(projects.router)
app.include_router(members.router)
app.include_router(notifications.router)
app.include_router(ingest.router)
app.include_router(gen_requests.router)
app.include_router(publish.router)
app.include_router(release_update.router)
app.include_router(resolve_integration.router)
app.include_router(auth.router)
app.include_router(db_transfer.router)
app.include_router(db_backup.router)
app.include_router(comfy.router)
app.include_router(scenes.router)

# ── PM 대시보드(분리형 사이드카) — 플래그 on 일 때만 등록 ────────────────────────
# 기본 off: import 자체를 안 해 라우터·사이드카 테이블이 전혀 생기지 않는다(운영 무영향).
# 켜면 /api/manage/* 활성. 설계: PM_DASHBOARD_DESIGN.md.
if MANAGE_ENABLED:
    from .routers import manage

    app.include_router(manage.router)


# ── AUTH off 원격 차단 ─────────────────────────────────────────────────────
# 인증을 끈 개인/개발 모드는 로컬 PC 전용이다. HOST 를 실수로 0.0.0.0 으로 열어도 LAN 에서
# 라이브러리·에셋 파일·DB 작업을 무인증으로 호출하지 못하게 HTTP 전체를 막는다.
# ── 인증 enforcement 미들웨어 (로드맵 §4-6 '서버가 매번 검증') ─────────────────
# AUTH_ENABLED 일 때만 작동. 보호 경로(/api/* 와 /media/*)는 승인된 세션을 요구한다.
# 토큰은 Authorization: Bearer <token> 또는 세션 쿠키(ch_session — img/태그·WS 용).
# 검증되면 request.state.account 에 계정을 싣는다. 정적 SPA 는 공개, /ws 는 핸들러에서 검증.
# /api/agent/download(agent_push.py)은 공개 — MV_agent.bat 이 인증 없이 curl 로 받게.
# 스크립트엔 비밀이 없다(클라이언트 코드일 뿐, 실제 push 는 여전히 허브 로그인 필요).
_AUTH_PUBLIC_PREFIXES = (
    "/api/auth/",
    "/api/health",
    "/api/ready",
    "/api/agent/download",
    "/api/agent/local-pair-token",
)
_AUTH_PUBLIC_PATHS = frozenset(
    {
        SNAPSHOT_EXPORT_PATH,
        # Resolve 내부 메뉴 스크립트는 브라우저 로그인 쿠키를 읽을 수 없다. 두 주소는
        # 각 라우터에서 현재 PC 요청만 허용하므로 인증 예외를 정확히 이 경로에만 둔다.
        "/api/resolve/transfers/pending",
        "/api/resolve/transfers/manual-result",
    }
)
_SNAPSHOT_SERVER_PATHS = frozenset({SNAPSHOT_EXPORT_PATH, "/api/health", "/api/ready"})


@app.middleware("http")
async def auth_enforcement(request: Request, call_next):
    request.state.account = None
    path = request.url.path
    # test_push-db의 LAN 서버는 DB 다운로드만을 위한 일시적 서버다. 가입·로그인·일반 DB API와
    # 정적 UI까지 닫아, 원본 DB에 계정이 0개인 경우에도 외부인이 첫 관리자로 가입할 수 없게 한다.
    if (
        os.environ.get(SNAPSHOT_EXPORT_ENV, "").strip() == "1"
        and path not in _SNAPSHOT_SERVER_PATHS
    ):
        return JSONResponse({"detail": "테스트 스냅샷 다운로드 전용 서버입니다"}, status_code=404)
    # 토큰(헤더 또는 쿠키)이 있으면 모드와 무관하게 계정을 실어둔다(/me·관리자 검증·표시에).
    token = session_token(request)
    if token:
        email = auth_svc.verify_token(token)
        if email:
            # SQLite busy_timeout 대기는 이벤트 루프가 아니라 워커 스레드에서 기다린다.
            # 계정 상태는 즉시 반영해야 하므로 여기서는 TTL 캐시를 두지 않는다.
            acc = await asyncio.to_thread(repo.get_account, email)
            if acc and acc["status"] == "approved":
                # 비번 변경/리셋 후엔 그 이전 발급 토큰을 거부(탈취 대응). 스탬프 없는 계정
                # (한 번도 안 바꿈)은 검사 생략 → 배포 시 기존 세션 일괄 로그아웃 방지.
                pcat = acc.get("password_changed_at")
                if not pcat or auth_svc.token_password_stamp(token) == pcat:
                    request.state.account = acc
    if not AUTH_ENABLED:
        return await call_next(request)
    # 보호: /api/*(로그인·가입·헬스 제외) + /media/*. 정적 SPA·/ws 는 여기서 제외.
    # 테스트 DB 다운로드는 일반 계정 로그인 대신 별도의 일회용 코드로 라우터에서 검증한다.
    # 정확히 이 경로만 예외로 두어 /api/db/export 같은 일반 DB API는 계속 세션 인증을 요구한다.
    api_public = path.startswith(_AUTH_PUBLIC_PREFIXES) or path in _AUTH_PUBLIC_PATHS
    api_protected = path.startswith("/api/") and not api_public
    media_protected = path.startswith("/media")
    if (api_protected or media_protected) and request.state.account is None:
        return JSONResponse(
            {"detail": "로그인이 필요합니다"},
            status_code=401,
            headers={_proxy.AUTH_STATE_HEADER: _proxy.AUTH_STATE_INVALID},
        )
    response = await call_next(request)
    if response.status_code == 401:
        # 인증된 요청 자체가 업무 규칙(예: 현재 비밀번호 불일치)으로 거부된 401은
        # 세션 만료가 아니다. 브라우저가 저장 토큰을 지우지 않도록 의미를 명시한다.
        response.headers[_proxy.AUTH_STATE_HEADER] = (
            _proxy.AUTH_STATE_PRESERVED
            if request.state.account is not None
            else _proxy.AUTH_STATE_INVALID
        )
    return response


# ── 변경 전파 미들웨어 ────────────────────────────────────────────────────────
# 한 클라이언트의 쓰기를 DB 저장만 하지 않고 데이터 영역별 갱신 신호로 전파한다.
# library 는 같은 계정에, Assets·PM은 데이터 없는 전역 신호로 보내며 디바운스는 ws.manager가 담당한다.
# 본 서버와 위임 프록시는 mutation_notify의 같은 판정 계약을 사용한다.
@app.middleware("http")
async def mutation_notify(request: Request, call_next):
    response = await call_next(request)
    try:
        path = request.url.path
        domains = notification_domains(request.method, path, response.status_code)
        if domains:
            from .deps import realtime_scope

            acc = getattr(request.state, "account", None)
            origin = parse_mutation_origin(
                request.headers.get(CLIENT_ID_HEADER),
                request.headers.get(MUTATION_ID_HEADER),
            )
            if DOMAIN_LIBRARY in domains:
                # 라이브러리 비공개 데이터는 변경한 계정의 탭/기기에만 알린다.
                manager.notify_mutation(realtime_scope(acc), origin)
            if DOMAIN_ASSETS in domains:
                manager.notify_domain("assets_changed", origin)
            if DOMAIN_MANAGE in domains:
                manager.notify_domain("manage_changed", origin)
            if origin:
                # 프론트는 요청 id와 변경 영역을 함께 확인한 경우에만 자기 알림을 생략한다.
                # 이 헤더는 인증·권한 판단에는 사용하지 않는다.
                response.headers[MUTATION_ID_HEADER] = origin[1]
                response.headers[MUTATION_DOMAINS_HEADER] = ",".join(domains)
    except Exception:  # noqa: BLE001 — 알림 실패가 응답을 막지 않게
        pass
    return response


# ── 서버 직결 데이터-프록시 (최외곽) ──────────────────────────────────────────
# 로컬 허브(위임 모드)에서 데이터 요청을 통째로 공유 서버로 중계한다. 가장 마지막에 등록해
# 최외곽에서 먼저 돌며, 데이터 경로면 로컬 라우터에 닿기 전에 단락(서버 응답 verbatim).
# 서버 본체(AUTH on)·미로그인 허브는 통과해 자기 라우터로 처리.
@app.middleware("http")
async def data_proxy(request: Request, call_next):
    return await _proxy.data_proxy_middleware(request, call_next)


# multipart 파싱·로컬→공유서버 프록시가 본문을 읽기 전에 전체 바이트 상한을 강제한다.
# AUTH off 원격 가드는 이 뒤에 등록되어 더 바깥에서 불필요한 원격 본문을 먼저 거부한다.
app.add_middleware(UploadBodyLimitMiddleware)


# ★최외곽 가드(가장 마지막 등록 = 가장 먼저 실행) — AUTH off 인데 LAN 에 노출된 경우, data_proxy
# 가 데이터 경로를 서버로 단락시키기 전에 원격 요청을 전부 차단한다. 프록시보다 바깥에 있어야
# 프록시 데이터 GET(팀 목록 등)까지 막힌다(안쪽에 두면 프록시 단락에 가려져 새던 허점 정정).
@app.middleware("http")
async def auth_off_remote_guard(request: Request, call_next):
    if not AUTH_ENABLED and not ALLOW_REMOTE_AUTH_OFF:
        host = (request.client.host if request.client else "") or ""
        if not is_loopback_host(host):
            return JSONResponse(
                {"detail": "AUTH off 모드는 로컬에서만 접근할 수 있습니다"},
                status_code=403,
            )
    return await call_next(request)


# 가장 바깥쪽 운영 관측 — 인증 거부·프록시 단락까지 포함한 실제 사용자 요청을 센다.
@app.middleware("http")
async def runtime_observation(request: Request, call_next):
    started = runtime_metrics.request_begin()
    status = 500
    try:
        response = await call_next(request)
        status = response.status_code
        return response
    finally:
        route = request.scope.get("route")
        # 라우팅 전에 인증 거부되거나 존재하지 않는 URL은 raw path 를 통계 key 로 쓰지 않는다.
        # 공격자가 매번 다른 URL을 보내도 RuntimeMetrics Counter 가 무한히 늘지 않게 한 버킷으로 합친다.
        route_path = getattr(route, "path", None) or "_unmatched"
        elapsed_ms = runtime_metrics.request_end(
            started=started,
            status=status,
            method=request.method,
            path=route_path,
        )
        if should_log_http_request(
            route_path,
            status,
            elapsed_ms,
            slow_request_ms=_SLOW_REQUEST_MS,
        ):
            try:
                log_event(
                    _runtime_log,
                    "http_request",
                    level=logging.ERROR if status >= 500 else logging.WARNING,
                    method=request.method,
                    # 실제 UUID/이름 대신 라우트 템플릿만 남겨 진단성과 개인정보 보호를 함께 지킨다.
                    path=route_path,
                    status=status,
                    elapsed_ms=round(elapsed_ms, 2),
                )
            except Exception:
                pass  # 로그 I/O 실패가 사용자 응답을 막지 않게


# 로컬에 받아둔 미디어 원본 서빙(현재는 원격 URL 직접 사용, 향후 byte-cache 용).
# StaticFiles 는 마운트 시점에 디렉터리가 있어야 하므로 먼저 생성한다.
ensure_dirs()
app.mount("/media", StaticFiles(directory=str(MEDIA_DIR)), name="media")


def _pinned_cli_version() -> str | None:
    """이 코드가 핀한 Higgsfield CLI 버전(hf_cli_version.txt 첫 줄). 없거나 못 읽으면 None.
    utf-8-sig: Windows 편집기가 붙인 BOM(\\ufeff)이 버전 문자열에 섞여 false mismatch 나는 것 방지(코덱스)."""
    try:
        txt = (BACKEND_DIR.parent / "hf_cli_version.txt").read_text("utf-8-sig")
        return txt.strip().splitlines()[0].strip() or None
    except Exception:  # noqa: BLE001
        return None


@app.get("/api/health")
def health():
    from .services import cli_bridge

    return {
        "status": "ok",
        "cli_available": cli_bridge.cli_available(),
        # 로컬 허브에서 공유 서버 실시간 연결이 살아 있는지 토큰·주소 없이 확인한다.
        "remote_realtime": remote_realtime_bridge.stats(),
        # 이 프로세스의 코드가 핀한 CLI 버전 — 워커 배치가 서버 값과 대조하는 버전 게이트용.
        "cli_version": _pinned_cli_version(),
    }


@app.get("/api/ready")
def ready():
    """로드밸런서·운영 점검용 준비 상태. 핵심 DB 테이블을 읽지 못하면 503."""
    if maintenance_active():
        # 의도적인 DB 교체는 서버 사망이 아니다. DB 게이트가 풀릴 때까지 여기서 기다리면
        # 워치독에는 HTTP 무응답으로 보여 정상 유지보수 중인 서버를 종료할 수 있다.
        return JSONResponse(
            {"status": "maintenance", "retry_after_seconds": 5},
            status_code=503,
            headers={"Retry-After": "5"},
        )
    result = database_readiness()
    if result["ready"]:
        return {"status": "ready", "checks": result["checks"]}
    log_event(
        logging.getLogger("mvhub.ready"),
        "readiness_failed",
        level=logging.ERROR,
        failed_checks=result["failed_checks"],
        checks=result["checks"],
    )
    return JSONResponse(
        {"status": "not_ready", "failed_checks": result["failed_checks"]},
        status_code=503,
    )


@app.get("/api/admin/runtime")
async def runtime_status(request: Request):
    """관리자 전용 운영 지표. 계정·프롬프트·URL 같은 사용자 데이터는 포함하지 않는다."""
    from .deps import require_admin

    require_admin(request)
    # 디스크 스냅샷의 미디어 폴더 재귀 스캔이 이벤트 루프를 막지 않게 스레드에서 수집.
    snapshot = await asyncio.to_thread(runtime_metrics.snapshot)
    snapshot["websocket"] = await manager.stats()
    snapshot["remote_realtime"] = remote_realtime_bridge.stats()
    snapshot["agents"] = agent_signals.stats()
    snapshot["operations"] = await asyncio.to_thread(operations_snapshot)
    return snapshot


@app.get("/api/admin/generation-events")
def generation_events(
    request: Request,
    generation_id: str | None = None,
    request_id: str | None = None,
    limit: int = 200,
):
    """관리자 전용 장기 생성 상태 이력. 사용자 콘텐츠·결과 URL은 포함하지 않는다."""
    from .deps import require_admin

    require_admin(request)
    return repo.list_generation_events(
        generation_id=generation_id,
        request_id=request_id,
        limit=limit,
    )


@app.get("/api/admin/audit-events")
def audit_events(request: Request, project_id: str | None = None, limit: int = 200):
    """관리자 전용 중요 변경 감사 기록."""
    from .deps import require_admin

    require_admin(request)
    return repo.list_audit_events(project_id=project_id, limit=limit)


@app.get("/api/cli-check")
def cli_check():
    """워커 코드가 공유 서버와 최신으로 맞는지 확인 — 로컬 코드핀(hf_cli_version.txt) vs 서버 기대버전.

    프록시(로컬 허브)면 공유 서버 /api/health.cli_version 을 대신 조회해 대조한다(배치는 서버 URL 을
    모르므로, URL 을 아는 허브가 대신 확인). 등가성만 판단: 서버 버전이 있고 코드핀과 다르면
    code_stale(서버가 먼저 업데이트된 배포 중간 상태 등) → 배치가 생성을 끈다. 서버 없음/불통/형식이상
    이면 ok(로컬 핀 신뢰, 오프라인·단독 안전). CLI 만 올리면 낡은 코드가 새 CLI 에서 깨지므로
    '코드 업데이트'가 정답 — 여기선 CLI 자동설치가 아니라 코드-서버 정합만 본다."""
    pin = _pinned_cli_version()
    server: str | None = None
    # 워커 로컬 허브면 토큰 유무와 무관하게 서버 버전 확인(코덱스: 토큰 없는 첫 실행 워커 우회 차단).
    # /api/health 는 공개라 로그인 전에도 조회 가능. base_url() 은 DB 설정 없으면 env/기본값으로 폴백.
    if _proxy.is_worker_hub():
        try:
            status, body = _proxy.raw_request(
                "GET", f"{_proxy.base_url()}/api/health", token=_proxy.token(), timeout=8
            )
            if status == 200 and isinstance(body, dict):
                v = body.get("cli_version")
                server = v.strip() if isinstance(v, str) and v.strip() else None
        except Exception:  # noqa: BLE001
            server = None
    stale = bool(server and pin and server != pin)
    return {"pin": pin, "server": server, "status": "code_stale" if stale else "ok"}


@app.get("/api/backups")
def list_backups(request: Request):
    """보관 중인 DB 백업 목록(최신순). 운영/관리자용 — AUTH on 이면 admin 만."""
    from .deps import require_admin
    from .services.backup import list_backups_info

    require_admin(request)
    return list_backups_info()


@app.post("/api/backup")
async def trigger_backup(request: Request):
    """수동 DB 백업 즉시 실행(회전 포함). 관리자/운영용 — AUTH on 이면 admin 만."""
    from .deps import require_admin
    from .services.backup import backup_now

    require_admin(request)
    path = await asyncio.to_thread(backup_now)
    return {"ok": path is not None, "file": path.name if path else None}


def _websocket_session_token(ws: WebSocket, cookie_name: str) -> str | None:
    """WS 인증 토큰. 헤더를 붙일 수 있는 백엔드 브리지는 Bearer를 우선 사용한다."""
    authorization = ws.headers.get("authorization") or ""
    bearer = (
        authorization[7:].strip()
        if authorization.lower().startswith("bearer ")
        else None
    )
    # 브라우저=cookie, 구버전 클라이언트=query. 새 코드가 query를 만들지는 않는다.
    return bearer or ws.cookies.get(cookie_name) or ws.query_params.get("token")


# WS 수신 루프 파라미터 — 프로토콜 ping 비활성(serve.py) 전제의 앱 레벨 살아있음 판정.
# 클라이언트 하트비트는 25초(브라우저 progressSocket "ping"·원격 브리지 remote_realtime).
_WS_RECV_TIMEOUT_SECONDS = 45.0
_WS_GHOST_SECONDS = 90.0  # 하트비트 3주기 이상 무수신 = FIN 없는 사망으로 판정
_WS_AUTH_RECHECK_SECONDS = 45.0


# WS 1008 사유 토큰 — 프론트(progressSocket)가 이 문자열로 분기하므로 바꾸면 계약 위반.
# "authentication required" = 진짜 인증 실패(토큰 무효·미승인·비번 변경) → 재로그인 유도.
# "auth-off-local-only"   = AUTH off 서버에 원격(비-loopback) 접속 — 인증 실패가 아니라
#                            HTTP 403 "AUTH off 모드는 로컬 전용"과 같은 정책 거부.
_WS_REASON_AUTH_REQUIRED = "authentication required"
_WS_REASON_AUTH_OFF_LOCAL_ONLY = "auth-off-local-only"


async def _reject_websocket_policy(ws: WebSocket, reason: str = _WS_REASON_AUTH_REQUIRED) -> None:
    """핸드셰이크를 완료한 뒤 1008로 닫아 브라우저의 무한 재접속을 막는다.

    accept 전에 close 하면 Uvicorn은 HTTP 403으로 거절하고 브라우저에는 1006만 보여준다.
    클라이언트는 1008만 영구 정책 거부로 구분하므로, 데이터는 보내지 않고 연결 직후 닫는다.
    """
    await ws.accept()
    await ws.close(code=1008, reason=reason)


def _log_browser_presence(event: str, counts: dict[str, int]) -> None:
    """개인 식별정보 없이 현재 브라우저 연결 수만 즉시 기록한다."""
    log_event(
        _runtime_log,
        event,
        connections=counts.get("connections", 0),
        connected_accounts=counts.get("authenticated_accounts", 0),
    )


async def _disconnect_websocket(ws: WebSocket) -> None:
    counts = await manager.disconnect(ws)
    if counts is not None:
        _log_browser_presence("browser_disconnected", counts)


@app.websocket("/ws")
async def websocket_endpoint(ws: WebSocket):
    """생성 진행률 push 채널. AUTH_ENABLED 면 세션 토큰을 검증한 뒤 수락."""
    account_uid: str | None = None
    if not AUTH_ENABLED and not ALLOW_REMOTE_AUTH_OFF:
        host = (ws.client.host if ws.client else "") or ""
        if not is_loopback_host(host):
            # 인증 실패가 아니라 "로컬 전용" 정책 거부 — 프론트가 토큰을 지우거나
            # 로그인 화면으로 보내지 않도록 사유를 구분해 보낸다.
            await _reject_websocket_policy(ws, reason=_WS_REASON_AUTH_OFF_LOCAL_ONLY)
            return
    if AUTH_ENABLED:
        from .deps import SESSION_COOKIE, realtime_scope

        token = _websocket_session_token(ws, SESSION_COOKIE)
        email = auth_svc.verify_token(token) if token else None
        acc = await asyncio.to_thread(repo.get_account, email) if email else None
        pcat = acc.get("password_changed_at") if acc else None
        stale_password_token = bool(pcat and auth_svc.token_password_stamp(token) != pcat)
        if not acc or acc["status"] != "approved" or stale_password_token:
            await _reject_websocket_policy(ws)
            return
        # email 기반 스코프(progress·mutation 과 동일 규칙) — creator_uid NULL·리맵에도 안정.
        account_uid = realtime_scope(acc)
    counts = await manager.connect(ws, account_uid)
    _log_browser_presence("browser_connected", counts)
    try:
        # 프로토콜 ping 은 껐으므로(100명 ping 몰림 1011 방지 — serve.py) 살아있음 판정은
        # 앱 레벨 텍스트 수신으로 한다: 브라우저 25초 "ping"(progressSocket)·원격 브리지
        # 25초 하트비트(remote_realtime). 90초(=주기 3배+여유) 무수신이면 FIN 없는 사망
        # (와이파이 단절·절전)으로 보고 서버가 닫는다 — 안 닫으면 manager._active 에 유령
        # 연결이 쌓여 브로드캐스트 비용·운영 지표가 왜곡된다.
        last_received = time.monotonic()
        last_auth_check = last_received
        while True:
            got_message = False
            try:
                await asyncio.wait_for(ws.receive_text(), timeout=_WS_RECV_TIMEOUT_SECONDS)
                got_message = True
            except asyncio.TimeoutError:
                pass
            # manager 가 이 연결을 수거(전송 timeout/큐 초과)했는데 close 가 유실된 드문 경우,
            # receive loop 만 살아남아 유령이 된다 — 스스로 닫고 나간다(브라우저 재연결 유도).
            if not manager.is_tracked(ws):
                await ws.close(code=1001)
                return
            now = time.monotonic()
            if got_message:
                last_received = now
            elif now - last_received >= _WS_GHOST_SECONDS:
                await ws.close(code=1001)  # going away — 유령 연결 수거(정리는 finally)
                return
            # ★연결 시점에만 인증하면, 그 뒤 관리자가 계정을 정지(rejected/pending)하거나 비번을
            # 리셋해도 기존 소켓은 계속 진행률·알림을 받는다 → 주기 재검증으로 끊는다.
            # 재검증은 메시지 수신마다가 아니라 45초 주기 — 100명×25초 ping 이 전부 DB 조회가
            # 되던 부하를 줄인다(정지 반영 지연 상한은 기존과 같은 ~45초).
            if AUTH_ENABLED and now - last_auth_check >= _WS_AUTH_RECHECK_SECONDS:
                last_auth_check = now
                acc2 = await asyncio.to_thread(repo.get_account, email) if email else None
                pcat2 = acc2.get("password_changed_at") if acc2 else None
                if (
                    not acc2
                    or acc2["status"] != "approved"
                    or (pcat2 and auth_svc.token_password_stamp(token) != pcat2)
                ):
                    # 주기 재검증 실패 = 진짜 인증 실패 — 최초 거부와 같은 사유를 붙여
                    # 프론트가 reason 없는 1008을 추측하지 않게 한다.
                    await ws.close(code=1008, reason=_WS_REASON_AUTH_REQUIRED)
                    return
    except WebSocketDisconnect:
        pass
    except Exception:
        # 예상한 WebSocketDisconnect 외의 예외를 숨기면 장시간 연결이 끊겨도 운영 로그에는
        # 원인이 전혀 남지 않는다. 토큰·이메일은 기록하지 않고 인증 스코프 존재 여부만 남긴다.
        _runtime_log.exception(
            "WebSocket handler error (authenticated_scope=%s)",
            account_uid is not None,
        )
    finally:
        # CancelledError(강제 종료·테스트 lifespan 재사용)까지 포함해 어떤 경로로 나가도
        # manager 등록과 sender task 를 정리한다. disconnect 는 멱등이라 중복 호출 무해.
        await _disconnect_websocket(ws)


# ── 서버 모드: 빌드된 프론트엔드(dist) 서빙 ──────────────────────────────────
# 백엔드가 프론트를 같은 오리진에서 제공 → 프론트의 상대경로가 그대로 동작하고
# CORS 도 불필요. dist 가 없으면(개발: Vite dev server 사용) 이 블록은 건너뛴다.
# 라우터·/media 마운트보다 *뒤*에 등록해야 API 경로를 가리지 않는다.
if FRONTEND_DIST.is_dir():
    _ASSETS_DIR = FRONTEND_DIST / "assets"
    if _ASSETS_DIR.is_dir():
        app.mount(
            "/assets",
            ImmutableStaticFiles(directory=str(_ASSETS_DIR)),
            name="spa-assets",
        )

    @app.get("/{full_path:path}", include_in_schema=False)
    async def spa_fallback(full_path: str):
        """SPA 진입점. 실제 파일이면 그 파일을, 아니면 index.html 을 돌려준다.
        알 수 없는 /api·/ws·/media 요청은 200(index.html)으로 삼키지 않고 404 로."""
        if full_path.startswith(("api/", "ws", "media/")):
            raise HTTPException(status_code=404, detail="Not Found")
        # 경로 탈출 방지: dist 바깥을 가리키면 거부(문자열 prefix 대신 safe_join=relative_to 검증)
        candidate = safe_join(FRONTEND_DIST, full_path)
        if candidate and candidate.is_file():
            return FileResponse(str(candidate))
        # index.html 은 캐시 금지 — 빌드 때 바뀐 해시 자산(특히 CSS)을 가리키는데, 브라우저가
        # 옛 index.html 을 캐시하면 지워진 옛 CSS 를 요청해 404 → 디자인 깨짐(자산은 해시라 영구캐시 OK).
        return FileResponse(
            str(FRONTEND_DIST / "index.html"),
            headers={"Cache-Control": "no-cache, must-revalidate"},
        )
else:
    print(f"[startup] 프론트엔드 dist 없음 → API 전용 모드 ({FRONTEND_DIST})")


def run() -> None:
    """`python -m app.main` — 서버 모드 실행(0.0.0.0 바인딩, env 로 host/port 재정의).
    ⚠️ Windows 에서 --reload 는 금지(SelectorEventLoop 강제로 CLI subprocess 깨짐)이라
    여기서도 reload=False 고정. CLI 와 동일한 검증된 실행 경로."""
    import uvicorn

    from .config import HOST, PORT

    uvicorn.run("app.main:app", host=HOST, port=PORT, reload=False, log_level="info")


if __name__ == "__main__":
    run()

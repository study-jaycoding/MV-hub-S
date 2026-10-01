"""앱 부팅 백그라운드 작업과 예외 종료 cleanup 수명주기 회귀."""

from __future__ import annotations

import asyncio
import threading
from contextlib import ExitStack
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app import main
from app.routers import _telemetry
from app.services import asset_watcher, history_autofill, media_cache


def test_worker_backup_bootstrap_leaves_readiness_and_waits_for_copy_on_cancel():
    started = threading.Event()
    release = threading.Event()

    def slow_bootstrap() -> None:
        started.set()
        release.wait(timeout=2)

    async def scenario() -> None:
        with patch.object(
            main, "queue_latest_local_backup", side_effect=slow_bootstrap
        ), patch.object(main.periodic_worker_backup, "start") as worker_start:
            task = main._start_worker_backup_bootstrap()
            assert await asyncio.to_thread(started.wait, 1)
            assert not task.done()  # readiness 경로는 이 작업을 await하지 않는다.
            task.cancel()
            await asyncio.sleep(0.01)
            assert not task.done()  # 취소 뒤에도 실제 executor 작업 종료를 기다린다.
            release.set()
            with pytest.raises(asyncio.CancelledError):
                await task
            worker_start.assert_called_once_with()

    try:
        asyncio.run(scenario())
    finally:
        release.set()


def test_lifespan_injected_exception_still_runs_cleanup_in_original_order(tmp_path):
    cleanup_order: list[str] = []

    def async_cleanup(name: str):
        async def run() -> None:
            cleanup_order.append(name)

        return run

    fake_repo = SimpleNamespace(
        ensure_default_worker=lambda: None,
        sweep_expired_generation_claims=lambda: [],
        fail_orphaned_jobs=lambda: 0,
        reconcile_duplicates=lambda: 0,
        creator_uid_remap_plan=lambda: {
            "total_acct_rows": 0,
            "changes": [],
            "unmapped": [],
        },
        migrate_all_acct_to_creator_uid=lambda: 0,
        migrate_legacy_soft_deleted=lambda: 0,
        reconcile_with_main=lambda: 0,
        backfill_creator_uids=lambda: 0,
        link_accounts_to_creators=lambda: 0,
    )

    async def scenario() -> None:
        with ExitStack() as stack:
            stack.enter_context(patch.object(main, "repo", fake_repo))
            stack.enter_context(patch.object(main, "AUTH_ENABLED", False))
            stack.enter_context(patch.object(main, "MANAGE_ENABLED", False))
            stack.enter_context(patch.object(main, "EXTERNAL_RECOVERY_ENABLED", False))
            stack.enter_context(patch.object(main, "_METRICS_LOG_INTERVAL", 0))
            stack.enter_context(
                patch.object(
                    main,
                    "configure_operational_logging",
                    return_value=Path(tmp_path) / "runtime.jsonl",
                )
            )
            stack.enter_context(patch.object(main, "log_event"))
            stack.enter_context(patch.object(main, "init_db"))
            stack.enter_context(patch.object(main, "ensure_dirs"))
            stack.enter_context(patch.object(main, "_should_bootstrap_admin", return_value=False))
            stack.enter_context(patch.object(main.comfy, "recover_interrupted_run_jobs"))
            stack.enter_context(patch.object(media_cache, "migrate_sharding", return_value=0))
            stack.enter_context(patch("threading.Thread", return_value=MagicMock()))
            stack.enter_context(patch.object(main.periodic_sync, "start"))
            stack.enter_context(patch.object(main.periodic_backup, "start"))
            stack.enter_context(patch.object(main.periodic_sweeper, "start"))
            stack.enter_context(patch.object(main.periodic_media_preservation, "start"))
            stack.enter_context(patch.object(main.periodic_share_state_reconciler, "start"))
            stack.enter_context(patch.object(main, "configure_share_state_router_deps"))
            stack.enter_context(patch.object(main._proxy, "is_worker_hub", return_value=False))
            stack.enter_context(patch.object(asset_watcher, "start"))
            stack.enter_context(
                patch.object(asset_watcher, "stop", side_effect=lambda: cleanup_order.append("asset"))
            )
            stack.enter_context(patch.object(_telemetry, "bind_telemetry_loop"))
            stack.enter_context(
                patch.object(
                    _telemetry,
                    "unbind_telemetry_loop",
                    side_effect=lambda _loop: cleanup_order.append("telemetry-unbind"),
                )
            )
            stack.enter_context(
                patch.object(history_autofill, "startup_history_audit", AsyncMock(return_value=None))
            )
            stack.enter_context(patch.object(history_autofill, "bind_history_loop"))
            stack.enter_context(
                patch.object(
                    history_autofill,
                    "stop_history_imports",
                    side_effect=async_cleanup("history"),
                )
            )
            stack.enter_context(
                patch.object(
                    history_autofill,
                    "unbind_history_loop",
                    side_effect=lambda _loop: cleanup_order.append("history-unbind"),
                )
            )
            stack.enter_context(
                patch.object(
                    main,
                    "shutdown_request_estimates",
                    side_effect=async_cleanup("estimates"),
                )
            )
            stack.enter_context(
                patch.object(main.periodic_backup, "stop", side_effect=async_cleanup("backup"))
            )
            stack.enter_context(
                patch.object(
                    main.periodic_worker_backup,
                    "stop",
                    side_effect=async_cleanup("worker-backup"),
                )
            )
            stack.enter_context(
                patch.object(main.periodic_sweeper, "stop", side_effect=async_cleanup("sweeper"))
            )
            stack.enter_context(
                patch.object(
                    main.periodic_share_state_reconciler,
                    "stop",
                    side_effect=async_cleanup("share-state"),
                )
            )
            stack.enter_context(
                patch.object(
                    main.periodic_media_preservation,
                    "stop",
                    side_effect=async_cleanup("media-preservation"),
                )
            )
            stack.enter_context(patch.object(main.remote_realtime_bridge, "start"))
            stack.enter_context(
                patch.object(
                    main.remote_realtime_bridge,
                    "stop",
                    side_effect=async_cleanup("remote-realtime"),
                )
            )

            with pytest.raises(RuntimeError, match="injected"):
                async with main._application_lifespan(main.app):
                    raise RuntimeError("injected")

    asyncio.run(scenario())
    assert cleanup_order == [
        "estimates",
        "backup",
        "worker-backup",
        "sweeper",
        "share-state",
        "media-preservation",
        "remote-realtime",
        # 텔레메트리를 예약할 수 있는 생산자(동기화·이력 보충)를 먼저 멈춘다 — 뒤에 멈추면 그들이
        # 끝나면서 드레인을 다시 예약하고 루프 연결까지 되살린다(2026-09-11 코덱스 리뷰).
        "history",
        "telemetry-unbind",
        "history-unbind",
        "asset",
    ]


def test_read_only_copy_server_starts_nothing_that_reaches_outside_the_copy(tmp_path):
    """서버 이사 연습·복원 드릴(READ_ONLY) — 사본 DB 의 경로로 운영 Comfy 입력 폴더를 청소하거나(청소기),
    NAS 를 훑거나(대장), CDN 을 받거나(media 보존), CLI 동기화를 돌리지 않는다. 자동 백업은 사본 폴더 안이라 그대로."""
    fake_repo = SimpleNamespace(
        ensure_default_worker=lambda: None,
        sweep_expired_generation_claims=lambda: [],
        fail_orphaned_jobs=lambda: 0,
        reconcile_duplicates=lambda: 0,
        creator_uid_remap_plan=lambda: {"total_acct_rows": 0, "changes": [], "unmapped": []},
        migrate_all_acct_to_creator_uid=lambda: 0,
        migrate_legacy_soft_deleted=lambda: 0,
        reconcile_with_main=lambda: 0,
        backfill_creator_uids=lambda: 0,
        link_accounts_to_creators=lambda: 0,
    )
    started: dict[str, MagicMock] = {}

    async def scenario() -> None:
        with ExitStack() as stack:
            for name, value in (
                ("repo", fake_repo),
                ("AUTH_ENABLED", True),
                ("READ_ONLY", True),
                ("MANAGE_ENABLED", False),
                ("EXTERNAL_RECOVERY_ENABLED", False),
                ("MEDIA_PRESERVATION_ENABLED", True),
                ("ASSET_REGISTRY_ENABLED", True),
                ("_METRICS_LOG_INTERVAL", 0),
            ):
                stack.enter_context(patch.object(main, name, value))
            stack.enter_context(
                patch.object(main, "configure_operational_logging", return_value=Path(tmp_path) / "runtime.jsonl")
            )
            for name in ("log_event", "init_db", "ensure_dirs", "configure_share_state_router_deps"):
                stack.enter_context(patch.object(main, name))
            stack.enter_context(patch.object(main, "_should_bootstrap_admin", return_value=False))
            stack.enter_context(patch.object(main, "shutdown_request_estimates", AsyncMock()))
            stack.enter_context(patch.object(main.comfy, "recover_interrupted_run_jobs"))
            stack.enter_context(patch.object(media_cache, "migrate_sharding", return_value=0))
            stack.enter_context(patch("threading.Thread", return_value=MagicMock()))
            stack.enter_context(patch.object(main._proxy, "is_worker_hub", return_value=False))
            for label, service in (
                ("sync", main.periodic_sync),
                ("backup", main.periodic_backup),
                ("sweeper", main.periodic_sweeper),
                ("media", main.periodic_media_preservation),
                ("share", main.periodic_share_state_reconciler),
                ("registry", main.asset_registry_controller),
            ):
                started[label] = stack.enter_context(patch.object(service, "start"))
                stack.enter_context(patch.object(service, "stop", AsyncMock()))
            stack.enter_context(patch.object(asset_watcher, "start"))
            stack.enter_context(patch.object(asset_watcher, "stop"))
            stack.enter_context(patch.object(_telemetry, "bind_telemetry_loop"))
            stack.enter_context(patch.object(_telemetry, "unbind_telemetry_loop"))
            stack.enter_context(
                patch.object(history_autofill, "startup_history_audit", AsyncMock(return_value=None))
            )
            stack.enter_context(patch.object(history_autofill, "bind_history_loop"))
            stack.enter_context(patch.object(history_autofill, "stop_history_imports", AsyncMock()))
            stack.enter_context(patch.object(history_autofill, "unbind_history_loop"))

            async with main._application_lifespan(main.app):
                pass

    asyncio.run(scenario())
    for label in ("sync", "sweeper", "media", "registry"):
        assert not started[label].called, label
    assert started["backup"].called


def test_read_only_server_refuses_changes_but_lets_people_sign_in(monkeypatch):
    """저장·미러(렌더 폴더 쓰기·이동)·push·설정 변경은 403, 로그인 예외는 정확한 (메서드, 경로) 쌍만."""
    from fastapi.testclient import TestClient

    order = [item.kwargs["dispatch"].__name__ if item.kwargs.get("dispatch") else item.cls.__name__ for item in main.app.user_middleware]
    assert order.index("read_only_guard") < order.index("data_proxy")  # 프록시가 서버로 넘기기 전에 막는다
    client = TestClient(main.app, client=("127.0.0.1", 50000))
    monkeypatch.setattr(main, "READ_ONLY", True)
    for method, path in (
        ("POST", "/api/manage/save-finals?project_id=p"),
        ("POST", "/api/manage/save-finals/mirror?project_id=p"),
        ("DELETE", "/api/anything"),
        ("PATCH", "/api/auth/accounts/a@b.c/status"),
        ("PUT", "/api/auth/access"),  # 예외는 POST 만
    ):
        response = client.request(method, path)
        assert response.status_code == 403, (method, path)
        assert "읽기 전용" in response.json()["detail"]
    assert client.post("/api/auth/access", json={}).status_code == 422  # 예외 — 라우터까지 간다(본문 검사)
    assert client.get("/api/no-such-route").status_code == 404  # 읽기는 그대로

    monkeypatch.setattr(main, "READ_ONLY", False)
    response = client.post("/api/no-such-route")
    assert response.status_code != 403 and "읽기 전용" not in str(response.json().get("detail"))

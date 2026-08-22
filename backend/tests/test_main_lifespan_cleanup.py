"""부분 부팅 실패와 종료 실패에서도 lifespan cleanup 계약을 지키는지 검증한다."""

from __future__ import annotations

import asyncio
from contextlib import ExitStack
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app import main
from app.routers import _telemetry
from app.services import asset_watcher, cli_bridge, history_autofill, media_cache


def _fake_repo() -> SimpleNamespace:
    return SimpleNamespace(
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


def _patch_startup_dependencies(
    stack: ExitStack, tmp_path: Path, *, auth_enabled: bool = False
) -> None:
    stack.enter_context(patch.object(main, "repo", _fake_repo()))
    stack.enter_context(patch.object(main, "AUTH_ENABLED", auth_enabled))
    stack.enter_context(patch.object(main, "MANAGE_ENABLED", False))
    stack.enter_context(patch.object(main, "EXTERNAL_RECOVERY_ENABLED", False))
    stack.enter_context(patch.object(main, "_METRICS_LOG_INTERVAL", 0))
    stack.enter_context(
        patch.object(
            main,
            "configure_operational_logging",
            return_value=tmp_path / "runtime.jsonl",
        )
    )
    stack.enter_context(patch.object(main, "log_event"))
    stack.enter_context(patch.object(main, "init_db"))
    stack.enter_context(patch.object(main, "ensure_dirs"))
    stack.enter_context(patch.object(main, "_should_bootstrap_admin", return_value=False))
    stack.enter_context(patch.object(main.comfy, "recover_interrupted_run_jobs"))
    stack.enter_context(patch.object(media_cache, "migrate_sharding", return_value=0))
    stack.enter_context(patch("threading.Thread", return_value=MagicMock()))
    stack.enter_context(patch.object(main, "configure_share_state_router_deps"))
    stack.enter_context(patch.object(main._proxy, "is_worker_hub", return_value=False))
    stack.enter_context(
        patch.object(history_autofill, "startup_history_audit", AsyncMock(return_value=None))
    )


def _async_event(events: list[str], name: str, error: BaseException | None = None):
    async def run(*_args, **_kwargs) -> None:
        events.append(name)
        if error is not None:
            raise error

    return run


def _sync_event(events: list[str], name: str, error: BaseException | None = None):
    def run(*_args, **_kwargs) -> None:
        events.append(name)
        if error is not None:
            raise error

    return run


def test_partial_startup_failure_cleans_only_started_services_and_keeps_cause(tmp_path):
    events: list[str] = []
    startup_error = RuntimeError("share-state startup failed")
    cleanup_error = RuntimeError("backup cleanup failed")

    async def scenario() -> None:
        with ExitStack() as stack:
            _patch_startup_dependencies(stack, tmp_path)
            stack.enter_context(patch.object(main.periodic_sync, "start"))
            stack.enter_context(patch.object(main.periodic_sync, "stop", AsyncMock()))
            stack.enter_context(patch.object(main.periodic_backup, "set_completed_callback"))
            stack.enter_context(
                patch.object(
                    main.periodic_backup,
                    "start",
                    side_effect=_sync_event(events, "start:backup"),
                )
            )
            stack.enter_context(
                patch.object(
                    main.periodic_backup,
                    "stop",
                    side_effect=_async_event(events, "stop:backup", cleanup_error),
                )
            )
            stack.enter_context(
                patch.object(
                    main.periodic_sweeper,
                    "start",
                    side_effect=_sync_event(events, "start:sweeper"),
                )
            )
            stack.enter_context(
                patch.object(
                    main.periodic_sweeper,
                    "stop",
                    side_effect=_async_event(events, "stop:sweeper"),
                )
            )
            stack.enter_context(
                patch.object(
                    main.periodic_media_preservation,
                    "start",
                    side_effect=_sync_event(events, "start:media"),
                )
            )
            stack.enter_context(
                patch.object(
                    main.periodic_media_preservation,
                    "stop",
                    side_effect=_async_event(events, "stop:media"),
                )
            )
            stack.enter_context(
                patch.object(
                    main.periodic_share_state_reconciler,
                    "start",
                    side_effect=_sync_event(events, "start:share-state", startup_error),
                )
            )
            stack.enter_context(
                patch.object(
                    main.periodic_share_state_reconciler,
                    "stop",
                    side_effect=_async_event(events, "stop:share-state"),
                )
            )
            stack.enter_context(patch.object(main.periodic_worker_backup, "stop", AsyncMock()))
            stack.enter_context(patch.object(main.remote_realtime_bridge, "stop", AsyncMock()))
            stack.enter_context(patch.object(asset_watcher, "stop"))
            stack.enter_context(patch.object(main, "shutdown_request_estimates", AsyncMock()))
            stack.enter_context(patch.object(cli_bridge, "flush_cost_cache", AsyncMock()))

            with pytest.raises(RuntimeError) as exc_info:
                async with main._application_lifespan(main.app):
                    pytest.fail("startup failure must prevent entering the lifespan body")

            assert exc_info.value is startup_error

    asyncio.run(scenario())
    assert events == [
        "start:backup",
        "start:sweeper",
        "start:media",
        "start:share-state",
        "stop:backup",
        "stop:sweeper",
        "stop:media",
    ]


@pytest.mark.parametrize("error_type", [RuntimeError, asyncio.CancelledError])
def test_shutdown_failure_attempts_remaining_cleanup_and_reraises_first_error(
    tmp_path, error_type
):
    events: list[str] = []
    shutdown_error = error_type("backup stop failed")

    async def scenario() -> None:
        with ExitStack() as stack:
            _patch_startup_dependencies(stack, tmp_path)
            stack.enter_context(patch.object(main.periodic_sync, "start"))
            stack.enter_context(patch.object(main.periodic_sync, "stop", AsyncMock()))
            stack.enter_context(patch.object(main.periodic_backup, "start"))
            stack.enter_context(
                patch.object(
                    main.periodic_backup,
                    "stop",
                    side_effect=_async_event(events, "backup", shutdown_error),
                )
            )
            stack.enter_context(
                patch.object(
                    main.periodic_backup,
                    "set_completed_callback",
                    side_effect=_sync_event(events, "backup-callback"),
                )
            )
            stack.enter_context(patch.object(main.periodic_sweeper, "start"))
            stack.enter_context(
                patch.object(
                    main.periodic_sweeper,
                    "stop",
                    side_effect=_async_event(events, "sweeper"),
                )
            )
            stack.enter_context(patch.object(main.periodic_media_preservation, "start"))
            stack.enter_context(
                patch.object(
                    main.periodic_media_preservation,
                    "stop",
                    side_effect=_async_event(events, "media"),
                )
            )
            stack.enter_context(patch.object(main.periodic_share_state_reconciler, "start"))
            stack.enter_context(
                patch.object(
                    main.periodic_share_state_reconciler,
                    "stop",
                    side_effect=_async_event(events, "share-state"),
                )
            )
            stack.enter_context(
                patch.object(
                    main.periodic_worker_backup,
                    "stop",
                    side_effect=_async_event(events, "worker-backup"),
                )
            )
            stack.enter_context(patch.object(main.remote_realtime_bridge, "start"))
            stack.enter_context(
                patch.object(
                    main.remote_realtime_bridge,
                    "stop",
                    side_effect=_async_event(events, "remote-realtime"),
                )
            )
            stack.enter_context(patch.object(main.agent_signals, "bind_loop"))
            stack.enter_context(
                patch.object(
                    main.agent_signals,
                    "unbind_loop",
                    side_effect=_sync_event(events, "agent-unbind"),
                )
            )
            stack.enter_context(patch.object(asset_watcher, "start"))
            stack.enter_context(
                patch.object(asset_watcher, "stop", side_effect=_sync_event(events, "asset"))
            )
            stack.enter_context(patch.object(_telemetry, "bind_telemetry_loop"))
            stack.enter_context(
                patch.object(
                    _telemetry,
                    "unbind_telemetry_loop",
                    side_effect=_sync_event(events, "telemetry-unbind"),
                )
            )
            stack.enter_context(patch.object(history_autofill, "bind_history_loop"))
            stack.enter_context(
                patch.object(
                    history_autofill,
                    "stop_history_imports",
                    side_effect=_async_event(events, "history"),
                )
            )
            stack.enter_context(
                patch.object(
                    history_autofill,
                    "unbind_history_loop",
                    side_effect=_sync_event(events, "history-unbind"),
                )
            )
            stack.enter_context(
                patch.object(
                    main,
                    "shutdown_request_estimates",
                    side_effect=_async_event(events, "estimates"),
                )
            )
            stack.enter_context(
                patch.object(
                    cli_bridge,
                    "flush_cost_cache",
                    side_effect=_async_event(events, "cost-cache"),
                )
            )

            with pytest.raises(error_type) as exc_info:
                async with main._application_lifespan(main.app):
                    events.clear()

            assert exc_info.value is shutdown_error

    asyncio.run(scenario())
    assert events == [
        "estimates",
        "cost-cache",
        "backup",
        "worker-backup",
        "backup-callback",
        "sweeper",
        "share-state",
        "media",
        "remote-realtime",
        "telemetry-unbind",
        "history",
        "history-unbind",
        "agent-unbind",
        "asset",
    ]


def test_normal_lifespan_keeps_existing_startup_and_shutdown_order(tmp_path):
    events: list[str] = []

    async def scenario() -> None:
        with ExitStack() as stack:
            _patch_startup_dependencies(stack, tmp_path, auth_enabled=True)
            stack.enter_context(
                patch.object(
                    main.periodic_sync,
                    "start",
                    side_effect=_sync_event(events, "start:sync"),
                )
            )
            stack.enter_context(
                patch.object(
                    main.periodic_sync,
                    "stop",
                    side_effect=_async_event(events, "stop:sync"),
                )
            )
            stack.enter_context(
                patch.object(
                    main.periodic_backup,
                    "set_completed_callback",
                    side_effect=_sync_event(events, "backup-callback"),
                )
            )
            for service, name in (
                (main.periodic_backup, "backup"),
                (main.periodic_sweeper, "sweeper"),
                (main.periodic_media_preservation, "media"),
                (main.periodic_share_state_reconciler, "share-state"),
            ):
                stack.enter_context(
                    patch.object(
                        service,
                        "start",
                        side_effect=_sync_event(events, f"start:{name}"),
                    )
                )
                stack.enter_context(
                    patch.object(
                        service,
                        "stop",
                        side_effect=_async_event(events, f"stop:{name}"),
                    )
                )
            stack.enter_context(
                patch.object(
                    main.periodic_worker_backup,
                    "stop",
                    side_effect=_async_event(events, "stop:worker-backup"),
                )
            )
            stack.enter_context(patch.object(main.remote_realtime_bridge, "start"))
            stack.enter_context(
                patch.object(
                    main.remote_realtime_bridge,
                    "stop",
                    side_effect=_async_event(events, "stop:remote-realtime"),
                )
            )
            stack.enter_context(
                patch.object(
                    main.agent_signals,
                    "bind_loop",
                    side_effect=_sync_event(events, "bind:agent"),
                )
            )
            stack.enter_context(
                patch.object(
                    main.agent_signals,
                    "unbind_loop",
                    side_effect=_sync_event(events, "unbind:agent"),
                )
            )
            stack.enter_context(
                patch.object(
                    asset_watcher,
                    "start",
                    side_effect=_sync_event(events, "start:asset"),
                )
            )
            stack.enter_context(
                patch.object(
                    asset_watcher,
                    "stop",
                    side_effect=_sync_event(events, "stop:asset"),
                )
            )
            stack.enter_context(
                patch.object(
                    _telemetry,
                    "bind_telemetry_loop",
                    side_effect=_sync_event(events, "bind:telemetry"),
                )
            )
            stack.enter_context(
                patch.object(
                    _telemetry,
                    "unbind_telemetry_loop",
                    side_effect=_sync_event(events, "unbind:telemetry"),
                )
            )
            stack.enter_context(
                patch.object(
                    history_autofill,
                    "bind_history_loop",
                    side_effect=_sync_event(events, "bind:history"),
                )
            )
            stack.enter_context(
                patch.object(
                    history_autofill,
                    "stop_history_imports",
                    side_effect=_async_event(events, "stop:history"),
                )
            )
            stack.enter_context(
                patch.object(
                    history_autofill,
                    "unbind_history_loop",
                    side_effect=_sync_event(events, "unbind:history"),
                )
            )
            stack.enter_context(
                patch.object(
                    main,
                    "shutdown_request_estimates",
                    side_effect=_async_event(events, "stop:estimates"),
                )
            )
            stack.enter_context(
                patch.object(
                    cli_bridge,
                    "flush_cost_cache",
                    side_effect=_async_event(events, "flush:cost-cache"),
                )
            )

            async with main._application_lifespan(main.app):
                events.append("ready")

    asyncio.run(scenario())
    assert events == [
        "start:sync",
        "backup-callback",
        "start:backup",
        "start:sweeper",
        "start:media",
        "start:share-state",
        "bind:agent",
        "start:asset",
        "bind:telemetry",
        "bind:history",
        "ready",
        "stop:estimates",
        "flush:cost-cache",
        "stop:backup",
        "stop:worker-backup",
        "backup-callback",
        "stop:sweeper",
        "stop:share-state",
        "stop:media",
        "stop:remote-realtime",
        "unbind:telemetry",
        "stop:history",
        "unbind:history",
        "unbind:agent",
        "stop:sync",
        "stop:asset",
    ]

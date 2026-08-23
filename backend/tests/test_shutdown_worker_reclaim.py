"""종료 회수 계약 — 주기 동기화 DB 쓰기와 썸네일 사전 생성 데몬을 종료가 실제로 회수한다.

배경(실측):
· PeriodicSync.stop() 이 to_thread 워커를 회수하지 않아, stop 반환(중앙값 0.069ms) 뒤
  87~106ms 에 DB 쓰기가 실제로 일어났다(10/10 재현). lifespan 의 DB 정리와 겹칠 수 있는 구간.
· 종료 시 썸네일 prewarm 데몬이 살아 있어 원본 rename 이 WinError 32 로 실패하고,
  종료 뒤에도 JPG 가 기록됐다.

여기서 고정하는 계약:
1) stop() 이 반환한 시점에 그 루프의 DB 쓰기 스레드는 이미 끝나 있다(쓰기 to_thread = non-abandon).
2) prewarm 스윕은 파일 단위로 중단 신호를 확인하고, 처리 중이던 파일의 두 버킷은 마저 끝낸다.
3) lifespan cleanup 이 중단 신호를 세우고 제한 시간 join 으로 prewarm 스레드를 실제로 회수한다.
"""

from __future__ import annotations

import asyncio
import threading
import time
import unittest
from contextlib import ExitStack, contextmanager
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import pytest

from app import main
from app.routers import _telemetry
from app.services import (
    asset_watcher,
    history_autofill,
    media_cache,
    server_relocation,
    syncer,
    thumbs,
)


# ── 1. periodic sync — 종료 후 늦은 DB 쓰기 ────────────────────────────────
class PeriodicSyncReclaimTests(unittest.TestCase):
    """실측 재현 방식 그대로: 워커 스레드를 게이트로 잡아두고 stop() 반환 시점을 판정한다."""

    def test_stop_waits_for_in_flight_sync_db_write(self):
        entered = threading.Event()
        wrote = threading.Event()

        def apply_jobs(items, worker_id, *, changed_job_ids, track_telemetry):
            entered.set()
            # 실측의 87~106ms 쓰기 구간 재현 — 이 구간에 stop() 이 겹친다.
            time.sleep(0.2)
            wrote.set()
            return {"inserted": 0, "updated": 0, "unchanged": 0, "errors": 0}

        async def scenario() -> tuple[bool, bool]:
            worker = syncer.PeriodicSync(interval=0.01)
            with (
                patch.object(syncer, "SERVER_SYNC_ENABLED", True),
                patch.object(syncer, "MANAGE_ENABLED", False),
                patch.object(syncer, "_duplicate_reconcile_pending", False),
                patch.object(syncer.cli_bridge, "list_jobs", AsyncMock(return_value=[])),
                patch.object(syncer.repo, "apply_synced_jobs", side_effect=apply_jobs),
                patch.object(syncer, "reconcile_stuck_synced", AsyncMock(return_value=0)),
                patch.object(syncer, "reconcile_local_house", AsyncMock(return_value=0)),
            ):
                worker.start()
                try:
                    entered_ok = await asyncio.to_thread(entered.wait, 5.0)
                    await worker.stop()
                finally:
                    await worker.stop()  # 실패 경로에서도 태스크를 남기지 않는다(멱등).
                # ★핵심 계약: stop() 이 돌아온 시점에 쓰기는 이미 끝나 있다.
                #   순정 to_thread 는 여기서 False 였다(stop 0.069ms → 쓰기 87~106ms).
                return entered_ok, wrote.is_set()

        entered_ok, write_done = asyncio.run(scenario())
        self.assertTrue(entered_ok, "동기화 워커 스레드가 진입하지 못했다")
        self.assertTrue(write_done, "stop() 반환 뒤에도 DB 쓰기가 진행 중이었다")

    def test_cancelled_stuck_cleanup_waits_for_trash_write(self):
        """같은 루프 안의 다른 쓰기 경로(유령 카드 휴지통행)도 방치되지 않는다."""
        entered = threading.Event()
        wrote = threading.Event()

        def move_to_trash(*_args, **_kwargs):
            entered.set()
            time.sleep(0.2)
            wrote.set()
            return True

        async def scenario() -> tuple[bool, bool]:
            with (
                patch.object(syncer, "AUTH_ENABLED", False),
                patch.object(
                    syncer.repo,
                    "list_stuck_synced_active",
                    return_value=[("gen-1", "job-1")],
                ),
                patch.object(syncer.cli_bridge, "job_exists", AsyncMock(return_value=False)),
                patch.object(
                    syncer.repo, "move_to_trash_if_stuck_synced", side_effect=move_to_trash
                ),
            ):
                task = asyncio.ensure_future(syncer.reconcile_stuck_synced())
                entered_ok = await asyncio.to_thread(entered.wait, 5.0)
                task.cancel()
                cancelled = False
                try:
                    await task
                except asyncio.CancelledError:
                    cancelled = True
                self.assertTrue(cancelled)
                return entered_ok, wrote.is_set()

        entered_ok, write_done = asyncio.run(scenario())
        self.assertTrue(entered_ok, "휴지통 쓰기 스레드가 진입하지 못했다")
        self.assertTrue(write_done, "취소 뒤에도 휴지통 쓰기가 진행 중이었다")


# ── 2-a. thumbs prewarm — 중단 체크 포인트 ─────────────────────────────────
class PrewarmStopCheckpointTests(unittest.TestCase):
    ROWS = [{"file_path": "/media/aa/a.png"}, {"file_path": "/media/bb/b.png"}]
    ALL_BUCKETS = [("a.png", 256), ("a.png", 512), ("b.png", 256), ("b.png", 512)]

    def _run_prewarm(self, should_stop):
        """DB·디스크 없이 스윕 루프 자체(파일 순회·버킷 인터리브·중단 지점)만 돌린다."""
        processed: list[tuple[str, int]] = []
        connection = SimpleNamespace(
            execute=lambda _sql: SimpleNamespace(fetchall=lambda: self.ROWS)
        )

        @contextmanager
        def fake_connection():
            yield connection

        def fake_ensure(target: Path, width: int):
            processed.append((target.name, width))
            return Path(f"/thumbs/{target.name}.{width}.jpg")  # 새로 구운 것으로 카운트

        with (
            patch("app.db.get_connection", side_effect=fake_connection),
            patch.object(thumbs, "_media_target", side_effect=Path),
            patch.object(
                thumbs, "cache_path", side_effect=lambda t, w: Path(f"/missing/{t.name}.{w}")
            ),
            patch.object(thumbs, "ensure_thumb", side_effect=fake_ensure),
            patch.object(thumbs, "evict_thumb_cache") as evict,
        ):
            made = thumbs.prewarm_generation_thumbs(should_stop=should_stop)
        return made, processed, evict

    def test_stop_signal_skips_remaining_files_but_finishes_current_file(self):
        calls = {"n": 0}

        def should_stop() -> bool:
            # 두 번째 파일 직전(=첫 파일의 두 버킷을 마친 뒤)에 종료 신호가 도착한 상황.
            calls["n"] += 1
            return calls["n"] > 1

        made, processed, evict = self._run_prewarm(should_stop)
        # 처리 중이던 파일은 두 버킷을 마저 끝내고(인터리브 계약), 다음 파일은 시작하지 않는다.
        self.assertEqual(processed, [("a.png", 256), ("a.png", 512)])
        self.assertEqual(made, 2)  # 부분 결과는 그대로 유효
        # 중단 시 evict 는 생략 — 종료 join 을 폴더 전체 스캔만큼 늘리지 않는다.
        evict.assert_not_called()

    def test_stop_checked_once_per_file_when_never_signalled(self):
        seen = {"n": 0}

        def should_stop() -> bool:
            seen["n"] += 1
            return False

        made, processed, evict = self._run_prewarm(should_stop)
        self.assertEqual(processed, self.ALL_BUCKETS)
        self.assertEqual(made, 4)
        self.assertEqual(seen["n"], len(self.ROWS))  # 버킷 단위가 아니라 파일 단위 확인
        evict.assert_called_once_with()

    def test_without_stop_callable_behavior_is_unchanged(self):
        made, processed, evict = self._run_prewarm(None)
        self.assertEqual(processed, self.ALL_BUCKETS)
        self.assertEqual(made, 4)
        evict.assert_called_once_with()


# ── 2-b. lifespan cleanup — 제한 시간 join ────────────────────────────────
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


def _patch_lifespan_with_real_threads(stack: ExitStack, tmp_path: Path) -> None:
    """test_main_lifespan_cleanup 의 부팅 스텁과 같되 threading.Thread 는 진짜로 둔다 —
    회수 계약은 실제 스레드에서만 검증된다."""
    stack.enter_context(patch.object(main, "repo", _fake_repo()))
    stack.enter_context(patch.object(main, "AUTH_ENABLED", False))
    stack.enter_context(patch.object(main, "MANAGE_ENABLED", False))
    stack.enter_context(patch.object(main, "EXTERNAL_RECOVERY_ENABLED", False))
    stack.enter_context(patch.object(main, "_METRICS_LOG_INTERVAL", 0))
    stack.enter_context(
        patch.object(
            main, "configure_operational_logging", return_value=tmp_path / "runtime.jsonl"
        )
    )
    stack.enter_context(patch.object(main, "log_event"))
    stack.enter_context(patch.object(main, "init_db"))
    stack.enter_context(patch.object(main, "ensure_dirs"))
    stack.enter_context(patch.object(main, "_should_bootstrap_admin", return_value=False))
    stack.enter_context(patch.object(main.comfy, "recover_interrupted_run_jobs"))
    stack.enter_context(patch.object(media_cache, "migrate_sharding", return_value=0))
    stack.enter_context(patch.object(server_relocation, "refresh", return_value=None))
    stack.enter_context(patch.object(main, "configure_share_state_router_deps"))
    stack.enter_context(patch.object(main._proxy, "is_worker_hub", return_value=False))
    stack.enter_context(
        patch.object(history_autofill, "startup_history_audit", AsyncMock(return_value=None))
    )
    stack.enter_context(patch.object(history_autofill, "bind_history_loop"))
    stack.enter_context(patch.object(history_autofill, "stop_history_imports", AsyncMock()))
    stack.enter_context(patch.object(history_autofill, "unbind_history_loop"))
    stack.enter_context(patch.object(_telemetry, "bind_telemetry_loop"))
    stack.enter_context(patch.object(_telemetry, "unbind_telemetry_loop"))
    stack.enter_context(patch.object(asset_watcher, "start"))
    stack.enter_context(patch.object(asset_watcher, "stop"))
    stack.enter_context(patch.object(main, "shutdown_request_estimates", AsyncMock()))
    stack.enter_context(patch.object(main.periodic_sync, "start"))
    stack.enter_context(patch.object(main.periodic_sync, "stop", AsyncMock()))
    stack.enter_context(patch.object(main.periodic_backup, "start"))
    stack.enter_context(patch.object(main.periodic_backup, "stop", AsyncMock()))
    stack.enter_context(patch.object(main.periodic_backup, "set_completed_callback"))
    stack.enter_context(patch.object(main.periodic_worker_backup, "stop", AsyncMock()))
    stack.enter_context(patch.object(main.periodic_sweeper, "start"))
    stack.enter_context(patch.object(main.periodic_sweeper, "stop", AsyncMock()))
    stack.enter_context(patch.object(main.periodic_media_preservation, "start"))
    stack.enter_context(patch.object(main.periodic_media_preservation, "stop", AsyncMock()))
    stack.enter_context(patch.object(main.periodic_share_state_reconciler, "start"))
    stack.enter_context(
        patch.object(main.periodic_share_state_reconciler, "stop", AsyncMock())
    )
    stack.enter_context(patch.object(main.periodic_resolve_queue, "start"))
    stack.enter_context(patch.object(main.periodic_resolve_queue, "stop", AsyncMock()))
    stack.enter_context(patch.object(main.remote_realtime_bridge, "start"))
    stack.enter_context(patch.object(main.remote_realtime_bridge, "stop", AsyncMock()))


def test_lifespan_stops_and_joins_thumb_prewarm_thread(tmp_path):
    started = threading.Event()
    finished = threading.Event()
    saw_stop: list[bool] = []

    def fake_prewarm(*, throttle, should_stop):
        started.set()
        # 종료 신호가 올 때까지 도는 스윕 — 실측의 '종료 뒤에도 계속 굽던' 데몬 재현.
        for _ in range(2000):
            if should_stop():
                saw_stop.append(True)
                break
            time.sleep(0.005)
        finished.set()
        return 0

    running_during_lifespan: list[bool] = []

    async def scenario() -> None:
        with ExitStack() as stack:
            _patch_lifespan_with_real_threads(stack, tmp_path)
            stack.enter_context(
                patch.object(thumbs, "prewarm_generation_thumbs", side_effect=fake_prewarm)
            )
            async with main._application_lifespan(main.app):
                assert await asyncio.to_thread(started.wait, 5.0)
                # 종료 전에는 계속 돈다 — 회수는 cleanup 의 책임이다.
                running_during_lifespan.append(not finished.is_set())

    try:
        asyncio.run(scenario())
        assert running_during_lifespan == [True]
        # ★핵심 계약: lifespan 이 빠져나온 시점에 스레드는 중단 신호를 보고 이미 끝나 있다.
        assert saw_stop == [True], "prewarm 이 중단 신호를 확인하지 않았다"
        assert finished.is_set(), "lifespan 종료가 prewarm 스레드를 join 하지 않았다"
        assert all(
            t.name != "thumb-prewarm" or not t.is_alive() for t in threading.enumerate()
        )
    finally:
        finished.wait(3.0)


def test_lifespan_survives_prewarm_that_ignores_stop_signal(tmp_path):
    """daemon=True 최후 안전망 — join 이 상한을 넘겨도 종료는 계속 진행된다(경고만)."""
    release = threading.Event()
    started = threading.Event()

    def stubborn_prewarm(*, throttle, should_stop):
        started.set()
        release.wait(10.0)  # 중단 신호를 무시하는 스윕
        return 0

    async def scenario() -> None:
        with ExitStack() as stack:
            _patch_lifespan_with_real_threads(stack, tmp_path)
            stack.enter_context(patch.object(main, "_THUMB_PREWARM_JOIN_TIMEOUT", 0.05))
            stack.enter_context(
                patch.object(thumbs, "prewarm_generation_thumbs", side_effect=stubborn_prewarm)
            )
            async with main._application_lifespan(main.app):
                assert await asyncio.to_thread(started.wait, 5.0)
            # cleanup_error 로 승격되지 않고 정상 종료돼야 한다(예외 없이 여기 도달).

    try:
        asyncio.run(scenario())
    finally:
        release.set()


if __name__ == "__main__":
    pytest.main([__file__])

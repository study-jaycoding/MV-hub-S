# 백그라운드 작업 목록

> 이 파일은 `python tools/gen_inventory.py` 가 코드에서 뽑아 만든다. **손으로 고치지 않는다** — 다음 생성 때 사라진다.
> 코드와 어긋나면 `backend/tests/test_docs_inventory_fresh.py` 가 실패한다. 그때는 위 명령을 다시 돌리고 문서 커밋으로 올린다.

뽑는 규칙과 한계:

- **① 기동 때** = `backend/app/main.py` 의 lifespan(`@asynccontextmanager`) 안에서 부르는 `X.start()`·`threading.Thread`·`asyncio.create_task`·`start_*`/`schedule_*` 호출. **조건** 은 그 호출을 둘러싼 `if` 를 소스 그대로 옮긴 것이다 — 실행 모드(공유 서버 본체 / 작업자 허브 / test_dev)별 차이가 여기서 갈린다.
- **② 응답 뒤** = FastAPI `BackgroundTasks.add_task(…)`. **③ 그 밖의 동시성 시작점** = `Thread`·`Timer`·`asyncio.create_task`·`ensure_future`·`run_coroutine_threadsafe` 자리 전부다(`backend/app`·`backend/*.py`·루트 `*.py`). **오래 도는 루프**(①의 `X.start()` 가 안에서 띄우는 `self._run()` 류)와 **짧게 끝나는 내부 태스크**(소켓 송신기·단일 비행 등)가 섞여 있으니 대상 칸으로 구분한다. 요청 하나 동안만 도는 `asyncio.to_thread` 는 뺐다.
- **④ 작업자 에이전트** = `agent_push.py` 를 인자와 함께 실행하는 스크립트(`--watch` 가 상주 모드)와, 그 파일에서 `while True:` 를 가진 함수. 뒤쪽은 **상주 루프 후보일 뿐**이다 — 파일을 끝까지 읽는 짧은 반복도 같은 꼴이라 섞여 있다(상주 루프의 본체는 `main`).
- 주기·간격·중지 방법은 기계로 안 나온다 — 정의 모듈의 머리말과 [환경변수 목록](env_vars.md)의 `*_INTERVAL` 을 본다.

## ① 기동 때 시작되는 것 (lifespan)

| 대상 | 방식 | 조건 | 정의 모듈 |
| --- | --- | --- | --- |
| `cli_bridge.start_model_refreshes` | 호출 | 항상 | `backend/app/services/cli_bridge.py` |
| `_prewarm (name=thumb-prewarm)` | Thread | not _proxy.is_shared_team_server() | `backend/app/main.py` |
| `server_relocation.refresh (name=server-relocation-boot)` | Thread | 항상 | `backend/app/services/server_relocation.py` |
| `periodic_sync` | start() | AUTH_ENABLED | `backend/app/services/syncer.py` |
| `_start_worker_backup_bootstrap` | 호출 | _proxy.is_worker_hub() | `backend/app/main.py` |
| `periodic_backup` | start() | 항상 | `backend/app/services/backup.py` |
| `periodic_sweeper` | start() | 항상 | `backend/app/services/temp_sweeper.py` |
| `periodic_media_preservation` | start() | MEDIA_PRESERVATION_ENABLED | `backend/app/services/media_preservation.py` |
| `periodic_share_state_reconciler` | start() | 항상 | `backend/app/services/share_state_reconciler.py` |
| `asset_watcher` | start() | 항상 | `backend/app/services/asset_watcher.py` |
| `startup_history_audit() (name=history-startup-audit)` | create_task | 항상 | `backend/app/services/history_autofill.py` |
| `startup_thumbnail_repair() (name=thumbnail-repair)` | create_task | 항상 | `backend/app/services/thumbnail_repair.py` |
| `remote_realtime_bridge` | start() | _proxy.is_worker_hub() | `backend/app/main.py` |
| `resolve_selection_monitor` | start() | not _proxy.is_shared_team_server() | `backend/app/services/resolve_selection_monitor.py` |
| `schedule_telemetry_drain` | 호출 | _proxy.is_worker_hub() | `backend/app/routers/_telemetry.py` |
| `_runtime_report_loop(_METRICS_LOG_INTERVAL) (name=runtime-metrics-log)` | create_task | _METRICS_LOG_INTERVAL > 0 | `backend/app/main.py` |

## ② 응답 뒤에 도는 것 (BackgroundTasks)

| 파일 | 함수 | 대상 |
| --- | --- | --- |
| `backend/app/routers/assets.py` | `project_tree` | `thumbs.prewarm_asset_thumbs` |
| `backend/app/routers/library.py` | `_schedule_remote_thumb_prewarm` | `thumbs.prewarm_remote_thumbs` |
| `backend/app/routers/library.py` | `_stamped_download` | `lambda: tmp.unlink(missing_ok=True)` |
| `backend/app/routers/library.py` | `download_media` | `lambda: tmp.unlink(missing_ok=True)` |
| `backend/app/routers/share.py` | `finalize` | `_preserve_final_media` ×2 |

## ③ 그 밖의 동시성 시작점

| 파일 | 함수 | 방식 | 대상 |
| --- | --- | --- | --- |
| `backend/app/main.py` | `_start_worker_backup_bootstrap` | create_task | `_worker_backup_bootstrap() (name=worker-backup-bootstrap)` |
| `backend/app/repo/share_state_intents.py` | `async_share_state_action_locks` | create_task | `asyncio.to_thread(_hold_sync_gate) (name=share-state-identity-gate)` |
| `backend/app/routers/_telemetry.py` | `_schedule_on_loop` | create_task | `_drain_soon() (name=telemetry-drain)` |
| `backend/app/routers/comfy.py` | `_start_run` | Thread | `_run_comfy_job_worker` |
| `backend/app/routers/comfy.py` | `collect_unresolved_run` | Thread | `_collect_run_worker` |
| `backend/app/routers/gen_requests.py` | `_release_claim_on_abort` | create_task | `release_claim(acc["email"], realtime_scope(acc), rid, agent_id)` |
| `backend/app/services/asset_watcher.py` | `_Watcher._ensure_health_timer_locked` | Timer | `self._health_check` |
| `backend/app/services/asset_watcher.py` | `_Watcher._flush` | run_coroutine_threadsafe | `manager.broadcast_all( {"type": "assets_changed", "projects": projects…` |
| `backend/app/services/asset_watcher.py` | `_Watcher._start_timer_locked` | Timer | `self._flush` |
| `backend/app/services/async_tools.py` | `to_thread_non_abandon` | create_task | `asyncio.to_thread(func, *args, **kwargs)` |
| `backend/app/services/backup.py` | `PeriodicBackup.start` | create_task | `self._run() (name=periodic-backup)` |
| `backend/app/services/cli_bridge.py` | `_ensure_cost_writer` | create_task | `_cost_writer()` |
| `backend/app/services/cli_bridge.py` | `_single_flight_task` | create_task | `factory()` |
| `backend/app/services/history_autofill.py` | `_start_history_task` | create_task | `_run_history_import(key, dict(acc), account_scope=captured_scope)` |
| `backend/app/services/history_autofill.py` | `schedule_history_auto_start._spawn` | create_task | `auto_start_history_import(account_email, reason="gap") (name=history-gap-auto-start)` |
| `backend/app/services/media_preservation.py` | `PeriodicMediaPreservation.start` | create_task | `self._run() (name=media-preservation)` |
| `backend/app/services/media_preservation.py` | `_claim_and_process_non_abandon` | create_task | `_claim_and_process(gen_id, account_key)` |
| `backend/app/services/remote_realtime.py` | `RemoteRealtimeBridge._consume` | create_task | `websocket.recv()` |
| `backend/app/services/remote_realtime.py` | `RemoteRealtimeBridge.start` | create_task | `self._run() (name=remote-realtime-bridge)` |
| `backend/app/services/resolve_queue.py` | `run_non_abandon` | create_task | `coro` |
| `backend/app/services/resolve_selection_monitor.py` | `ResolveSelectionMonitor._start_process` | create_task | `self._read_selections(self._process) (name=resolve-selection-reader)` |
| `backend/app/services/resolve_selection_monitor.py` | `ResolveSelectionMonitor.start` | create_task | `self._run() (name=resolve-selection-monitor)` |
| `backend/app/services/share_state_reconciler.py` | `PeriodicShareStateReconciler.start` | create_task | `self._run() (name=share-state-reconciler)` |
| `backend/app/services/syncer.py` | `PeriodicSync.start` | create_task | `self._run() (name=periodic-sync)` |
| `backend/app/services/temp_sweeper.py` | `PeriodicSweeper.start` | create_task | `self._run() (name=temp-sweeper)` |
| `backend/app/services/worker_backup.py` | `PeriodicWorkerBackupUpload.start` | create_task | `self._run() (name=periodic-worker-backup)` |
| `backend/app/usecases/gen_requests.py` | `_schedule_request_estimate` | create_task | `_record_request_estimate(gen_id, account_email, payload)` |
| `backend/app/usecases/hf_missing.py` | `trash_missing_generations.existence` | create_task | `_ask(key)` |
| `backend/app/ws.py` | `ConnectionManager._debounced_notify` | create_task | `self._debounced_notify()` |
| `backend/app/ws.py` | `ConnectionManager._deliver` | create_task | `self._collect(client, "overflow")` |
| `backend/app/ws.py` | `ConnectionManager._schedule_notify` | create_task | `self._debounced_notify()` |
| `backend/app/ws.py` | `ConnectionManager.connect` | create_task | `self._sender_loop(client)` |

## ④ 작업자 에이전트 (`agent_push.py`)

실행하는 스크립트: `MV_agent.bat`

| `while True` 를 가진 함수(상주 루프 후보) |
| --- |
| `_file_fingerprint` |
| `_masked_password_input` |
| `_upload_for_media` |
| `execute_pending` |
| `main` |
| `wait_for_local_pair` |

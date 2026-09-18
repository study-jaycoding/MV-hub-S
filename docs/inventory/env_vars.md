# 환경변수 목록

> 이 파일은 `python tools/gen_inventory.py` 가 코드에서 뽑아 만든다. **손으로 고치지 않는다** — 다음 생성 때 사라진다.
> 코드와 어긋나면 `backend/tests/test_docs_inventory_fresh.py` 가 실패한다. 그때는 위 명령을 다시 돌리고 문서 커밋으로 올린다.

뽑는 규칙과 한계:

- **직접 읽는 파일** = 환경변수를 그 자리에서 읽는 코드다. 파이썬은 AST 로 찾는다: 첫 인자가 대문자 문자열이고 호출 대상 이름에 `env` 가 들어간 호출(`os.getenv`·`os.environ.get`·`_env_int` 류), `environ["X"]`, `"X" in os.environ`, 그리고 `for v in ("A", "B"): os.environ.get(v)` 꼴. 프런트는 `import.meta.env.X`·`process.env.X`.
- `config.py` 가 읽어 **상수로 내보낸 값**(`AUTH_ENABLED` 등)을 쓰는 모듈은 여기 안 나온다 — 그 상수 이름으로 다시 찾는다.
- **기본값** 은 호출의 둘째 인자 소스 그대로다. `os.environ.get("X") or "기본"` 처럼 호출 밖에서 주는 기본값과, 이름을 조립해 읽는 변수는 안 잡힌다. 이름에 PASSWORD·SECRET·TOKEN·KEY 가 들어가면 기본값을 가린다.
- **설정하는 곳** = 코드가 읽는 이름을 `.bat`/`.ps1` 이 `set X=`·`$env:X =` 로 주는 자리와 파이썬의 `os.environ["X"] = …`.
- 스캔 범위는 `backend/app`·`backend/*.py`(서버 기동기 `serve.py` 등)·루트 `*.py`(`agent_push.py` 등)·`tools`·`release`·`deploy`·`frontend/src` 다. **시험 폴더(`backend/tests`·`frontend/tests`)는 보지 않는다** — 시험 전용 변수는 여기 없다.

제품 환경변수 126개.

| 이름 | 기본값 | 직접 읽는 파일 | 설정하는 곳 |
| --- | --- | --- | --- |
| `BACKEND` | — | `frontend/vite.config.ts` | `test_dev.bat` |
| `CONTENT_HUB_ACCESS_LOG` | `"0"` | `backend/serve.py` | — |
| `CONTENT_HUB_ADMIN_EMAIL` | — | `backend/app/main.py` | — |
| `CONTENT_HUB_ADMIN_PASSWORD` | — | `backend/app/main.py` | — |
| `CONTENT_HUB_ALLOW_REMOTE_AUTH_OFF` | `"0"` | `backend/app/config.py` | — |
| `CONTENT_HUB_ASSETS_DIR` | `str(DATA_DIR / "assets")` | `backend/app/config.py` | — |
| `CONTENT_HUB_ASSET_TREE_CACHE_TTL` | `"30"` | `backend/app/services/asset_tree.py` | — |
| `CONTENT_HUB_ASSET_UPLOAD_TOTAL_MAX_BYTES` | `1024 * MIB` | `backend/app/services/upload_limits.py` | — |
| `CONTENT_HUB_AUTH` | `"0"` | `backend/app/config.py` | `MV_agent.bat` `MV_server.bat` `test_dev.bat` `test_dev_server.bat` `test_push-db.bat` |
| `CONTENT_HUB_AUTH_SECRET` | — | `backend/app/services/auth.py` | — |
| `CONTENT_HUB_BACKUP_CHANGE_DEBOUNCE` | `"300"` | `backend/app/services/backup.py` | — |
| `CONTENT_HUB_BACKUP_DIR` | `""` `DATA_DIR / "backups"` | `backend/app/services/backup.py` `tools/backup_replicate.py` | — |
| `CONTENT_HUB_BACKUP_INTERVAL` | `str(24 * 3600)` | `backend/app/services/backup.py` | — |
| `CONTENT_HUB_BACKUP_KEEP` | `"7"` | `backend/app/services/backup.py` | — |
| `CONTENT_HUB_BACKUP_MIN_INTERVAL` | `"900"` | `backend/app/services/backup.py` | — |
| `CONTENT_HUB_BACKUP_POLL_INTERVAL` | `"30"` | `backend/app/services/backup.py` | — |
| `CONTENT_HUB_BACKUP_REPLICA_DIR` | `""` | `backend/app/services/operational_health.py` `tools/backup_replicate.py` | — |
| `CONTENT_HUB_COMFY_POLL_ERROR_RETRIES` | `5` | `backend/app/routers/comfy.py` | — |
| `CONTENT_HUB_COMFY_RUN_JOB_TTL_SEC` | `60 * 60` | `backend/app/routers/comfy.py` | — |
| `CONTENT_HUB_COMFY_TIMEOUT_SEC` | `60 * 30` | `backend/app/routers/comfy.py` | — |
| `CONTENT_HUB_COMFY_UPLOAD_FILE_MAX_BYTES` | `256 * MIB` | `backend/app/services/upload_limits.py` | — |
| `CONTENT_HUB_COMFY_UPLOAD_MAX_FILES` | `64` | `backend/app/services/upload_limits.py` | — |
| `CONTENT_HUB_COMFY_UPLOAD_TOTAL_MAX_BYTES` | `512 * MIB` | `backend/app/services/upload_limits.py` | — |
| `CONTENT_HUB_COMFY_URL` | — | `backend/app/routers/comfy.py` | — |
| `CONTENT_HUB_CORS` | `"http://localhost:5173,http://127.0.0.1:5173"` | `backend/app/config.py` | — |
| `CONTENT_HUB_COST_TTL` | `7 * 86400` | `backend/app/services/cli_bridge.py` | — |
| `CONTENT_HUB_DATA` | `BACKEND_DIR / "data"` `Path(__file__).resolve().parent / "data"` `str(REPO_ROOT / "backend" / "data")` | `backend/app/config.py` `backend/cleanup_orphan_creators.py` `tools/deploy_fence_check.py` `tools/endurance_probe.py` `tools/server_move.py` | `test_dev.bat` `test_dev_server.bat` `test_push-db.bat` `tools/load_test_100.py` |
| `CONTENT_HUB_DB` | `""` `None` | `backend/app/db_paths.py` `backend/app/routers/db_transfer.py` `backend/cleanup_orphan_creators.py` `tools/deploy_fence_check.py` `tools/endurance_probe.py` `tools/preflight_task_workspace.py` `tools/server_move.py` `tools/verify_generation_submission_recovery.py` | `test_dev.bat` `test_dev_server.bat` `test_push-db.bat` `tools/load_test_100.py` `tools/preflight_task_workspace.py` `tools/verify_generation_submission_recovery.py` |
| `CONTENT_HUB_DB_BACKEND` | `"sqlite"` | `backend/app/db.py` | — |
| `CONTENT_HUB_DB_POOL` | `"1"` | `backend/app/db.py` | — |
| `CONTENT_HUB_DB_UPLOAD_FILE_MAX_BYTES` | `512 * MIB` | `backend/app/services/upload_limits.py` | — |
| `CONTENT_HUB_DEFAULT_PROJECT` | `"v001"` | `backend/app/config.py` | — |
| `CONTENT_HUB_DEVICE_IDENTITY_FILE` | `str(DATA_DIR / "device_identity.json")` | `backend/app/services/worker_backup.py` | — |
| `CONTENT_HUB_ENDURANCE_BACKUP_FILE` | — | `tools/endurance_probe.py` | — |
| `CONTENT_HUB_ENDURANCE_CYCLE_FILE` | — | `tools/endurance_probe.py` | — |
| `CONTENT_HUB_ENDURANCE_PROBE` | — | `tools/endurance_probe.py` | — |
| `CONTENT_HUB_ENDURANCE_STOP_FILE` | — | `tools/endurance_probe.py` | — |
| `CONTENT_HUB_ENDURANCE_WS_GHOST_SECONDS` | — | `tools/endurance_probe.py` | — |
| `CONTENT_HUB_ENDURANCE_WS_RECV_TIMEOUT` | — | `tools/endurance_probe.py` | — |
| `CONTENT_HUB_ESTIMATE_CONCURRENCY` | `2` | `backend/app/services/cli_bridge.py` | — |
| `CONTENT_HUB_EXTERNAL_RECOVERY` | `"1"` | `backend/app/config.py` | — |
| `CONTENT_HUB_FFMPEG` | — | `backend/app/services/video_convert.py` | — |
| `CONTENT_HUB_FFMPEG_CONCURRENCY` | `"3"` | `backend/app/services/thumbs.py` | — |
| `CONTENT_HUB_FOLDER_TREE_CACHE_TTL` | `"30"` | `backend/app/services/project_folders.py` | — |
| `CONTENT_HUB_FRONTEND_DIST` | `BACKEND_DIR.parent / "frontend" / "dist"` | `backend/app/config.py` | — |
| `CONTENT_HUB_HISTORY_AUDIT_INTERVAL` | `str(24 * 60 * 60)` | `backend/app/services/history_autofill.py` | — |
| `CONTENT_HUB_HISTORY_AUTO_COOLDOWN` | `str(6 * 60 * 60)` | `backend/app/services/history_autofill.py` | — |
| `CONTENT_HUB_HOST` | `"0.0.0.0" if AUTH_ENABLED else "127.0.0.1"` | `backend/app/config.py` `tools/endurance_probe.py` | `MV_agent.bat` `MV_server.bat` |
| `CONTENT_HUB_LOCAL_AGENT_PAIR_SECRET` | `(표시 안 함)` | `backend/app/config.py` | `test_dev.bat` |
| `CONTENT_HUB_LOCAL_HOSTS` | `""` | `backend/app/services/request_guards.py` | — |
| `CONTENT_HUB_LOGIN_VERIFY_CONCURRENCY` | `""` | `backend/app/routers/auth.py` | — |
| `CONTENT_HUB_LOG_DIR` | `DATA_DIR / "logs"` `ROOT / "backend" / "data" / "logs"` | `backend/app/services/operational_logging.py` `tools/log_viewer.py` | — |
| `CONTENT_HUB_LOG_KEEP` | `"5"` | `backend/app/services/operational_logging.py` | — |
| `CONTENT_HUB_LOG_MAX_BYTES` | `str(10 * 1024 * 1024)` | `backend/app/services/operational_logging.py` | — |
| `CONTENT_HUB_MANAGE` | `"1"` | `backend/app/config.py` | `MV_agent.bat` `MV_server.bat` `test_dev_server.bat` `test_push-db.bat` |
| `CONTENT_HUB_MEDIA` | `DATA_DIR / "media"` | `backend/app/config.py` | — |
| `CONTENT_HUB_MEDIA_CACHE_MAX_BYTES` | `str(1024 * 1024 * 1024)` | `backend/app/services/media_cache.py` | — |
| `CONTENT_HUB_MEDIA_CACHE_MIN_FREE_BYTES` | `str(1024 * 1024 * 1024)` | `backend/app/services/media_cache.py` | — |
| `CONTENT_HUB_MEDIA_CACHE_WAIT_SECONDS` | `"3.0"` | `backend/app/services/media_cache.py` | — |
| `CONTENT_HUB_MEDIA_PRESERVATION` | `"0"` `None` | `backend/app/config.py` `tools/server_move.py` | `tools/server_move.py` |
| `CONTENT_HUB_MEDIA_PRESERVATION_INTERVAL_SECONDS` | `"30"` | `backend/app/services/media_preservation.py` | — |
| `CONTENT_HUB_MEDIA_PRESERVATION_MAX_ATTEMPTS` | `"5"` | `backend/app/services/media_preservation.py` | — |
| `CONTENT_HUB_MEDIA_PRESERVATION_STARTUP_DELAY_SECONDS` | `"10"` | `backend/app/services/media_preservation.py` | — |
| `CONTENT_HUB_METRICS_LOG_INTERVAL` | `"60"` | `backend/app/main.py` | — |
| `CONTENT_HUB_METRICS_SAMPLE_MAX` | `"5000"` | `backend/app/services/runtime_metrics.py` | — |
| `CONTENT_HUB_NO_PROXY` | `""` | `backend/app/routers/_proxy.py` `backend/app/services/operational_health.py` `backend/app/services/telemetry_drain.py` `tools/endurance_probe.py` | `test_dev.bat` `test_dev_server.bat` `test_push-db.bat` |
| `CONTENT_HUB_PORT` | `"0"` `"8000"` `"8010"` | `backend/app/config.py` `run_agent_session.py` `tools/endurance_probe.py` `tools/server_watchdog.py` | `MV_agent.bat` `MV_server.bat` |
| `CONTENT_HUB_PRESERVED_MEDIA_MAX_BYTES` | `str(50 * 1024 * 1024 * 1024)` | `backend/app/services/media_cache.py` | — |
| `CONTENT_HUB_REMOTE_THUMB_CONCURRENCY` | `"4"` | `backend/app/services/thumbs.py` | — |
| `CONTENT_HUB_RESOLVE_CONNECT_ATTEMPTS` | `"3"` | `backend/app/services/resolve_bridge.py` | — |
| `CONTENT_HUB_RESOLVE_CONNECT_RETRY_DELAY_SECONDS` | `"0.4"` | `backend/app/services/resolve_bridge.py` | — |
| `CONTENT_HUB_RESOLVE_IMPORT_ATTEMPTS` | `"2"` | `backend/app/services/resolve_bridge.py` | — |
| `CONTENT_HUB_RESOLVE_IMPORT_BATCH_SIZE` | `"50"` | `backend/app/services/resolve_bridge.py` | — |
| `CONTENT_HUB_RESOLVE_IMPORT_RETRY_DELAY_SECONDS` | `"0.35"` | `backend/app/services/resolve_bridge.py` | — |
| `CONTENT_HUB_RESOLVE_INSTALL_DIR` | `""` | `backend/app/services/resolve_bridge.py` `backend/app/services/resolve_diagnostics.py` | — |
| `CONTENT_HUB_RESOLVE_MANIFEST_CHECKPOINT_ITEMS` | `"10"` | `backend/app/services/resolve_transfer.py` | — |
| `CONTENT_HUB_RESOLVE_MIN_FREE_BYTES` | `str(256 * 1024 * 1024)` | `backend/app/services/resolve_transfer.py` | — |
| `CONTENT_HUB_RESOLVE_SCRIPT_API` | `""` | `backend/app/services/resolve_bridge.py` | — |
| `CONTENT_HUB_RESOLVE_SCRIPT_LIB` | `""` | `backend/app/services/resolve_bridge.py` | — |
| `CONTENT_HUB_RESOLVE_SELECTION_POLL_SECONDS` | `"0.05"` | `backend/app/services/resolve_selection_worker.py` | — |
| `CONTENT_HUB_RESOLVE_STATUS_TIMEOUT_SECONDS` | `"8"` | `backend/app/services/resolve_status_runner.py` | — |
| `CONTENT_HUB_RESTART_LIMIT` | `"5"` | `tools/server_supervisor.py` | — |
| `CONTENT_HUB_SERVER_ALERT_PATH` | `""` | `tools/server_supervisor.py` | — |
| `CONTENT_HUB_SERVER_SYNC` | `"1"` | `backend/app/services/syncer.py` | `MV_server.bat` `test_dev.bat` `test_dev_server.bat` `test_push-db.bat` |
| `CONTENT_HUB_SERVICE_NAME` | `"mvhub-backend"` | `backend/app/services/operational_logging.py` | — |
| `CONTENT_HUB_SHARED` | `DATA_DIR / "shared"` | `backend/app/config.py` | — |
| `CONTENT_HUB_SHARED_URL` | — | `backend/app/services/shared_connection.py` | `MV_agent.bat` |
| `CONTENT_HUB_SHARE_RECONCILE_INTERVAL_SECONDS` | `"30"` | `backend/app/services/share_state_reconciler.py` | — |
| `CONTENT_HUB_SLOW_REQUEST_MS` | `"1000"` | `backend/app/main.py` | — |
| `CONTENT_HUB_SSL_CERTFILE` | `""` | `backend/serve.py` | — |
| `CONTENT_HUB_SSL_KEYFILE` | `(표시 안 함)` | `backend/serve.py` | — |
| `CONTENT_HUB_STABLE_SECONDS` | `"120"` | `tools/server_supervisor.py` | — |
| `CONTENT_HUB_STUCK_SYNCED_AGE` | `"300"` | `backend/app/services/syncer.py` | — |
| `CONTENT_HUB_SYNC_INTERVAL` | `"20"` | `backend/app/services/syncer.py` | — |
| `CONTENT_HUB_SYNC_WATERMARK` | `"85"` | `backend/app/services/syncer.py` | — |
| `CONTENT_HUB_TASK` | — | `tools/server_watchdog.py` | `task_launch.bat` |
| `CONTENT_HUB_TASK_READ_CACHE_TTL` | `"0.75"` | `backend/app/repo/manage_tasks.py` `backend/app/routers/manage.py` | — |
| `CONTENT_HUB_THUMB_CACHE_MAX_BYTES` | `str(1024 * 1024 * 1024)` | `backend/app/services/thumbs.py` | — |
| `CONTENT_HUB_THUMB_EVICT_SCAN_INTERVAL` | `"60"` | `backend/app/services/thumbs.py` | — |
| `CONTENT_HUB_THUMB_FAILURE_TTL_SECONDS` | `"3600"` | `backend/app/services/media_cache.py` | — |
| `CONTENT_HUB_THUMB_REPAIR_BUDGET` | `"120"` | `backend/app/services/thumbnail_repair.py` | — |
| `CONTENT_HUB_THUMB_REPAIR_DELAY` | `"20"` | `backend/app/services/thumbnail_repair.py` | — |
| `CONTENT_HUB_THUMB_SOURCE_CACHE_MAX_BYTES` | `str(2 * 1024 * 1024 * 1024)` | `backend/app/services/media_cache.py` | — |
| `CONTENT_HUB_THUMB_SOURCE_FILE_MAX_BYTES` | `str(128 * 1024 * 1024)` | `backend/app/services/media_cache.py` | — |
| `CONTENT_HUB_UPLOAD_MAX_BYTES` | `str(media_cache._MAX_BYTES)` | `backend/app/services/asset_io.py` | — |
| `CONTENT_HUB_VIDEO_THUMB_PREWARM_LIMIT` | `"400"` | `backend/app/services/thumbs.py` | — |
| `CONTENT_HUB_WORKER_BACKUP_OUTBOX_DIR` | `str(DATA_DIR / "worker-backup-outbox")` | `backend/app/services/worker_backup.py` | — |
| `CONTENT_HUB_WORKER_BACKUP_PENDING_KEEP` | `"10"` | `backend/app/services/worker_backup.py` | — |
| `CONTENT_HUB_WORKER_BACKUP_STARTUP_DELAY_SECONDS` | `"3"` | `backend/app/services/worker_backup.py` | — |
| `CONTENT_HUB_WORKER_BACKUP_STATE_DB` | `str(DATA_DIR / "worker_backup_state.db")` | `backend/app/services/worker_backup.py` | — |
| `CONTENT_HUB_WORKER_BACKUP_UPLOAD_INTERVAL` | `"60"` | `backend/app/services/worker_backup.py` | — |
| `CONTENT_HUB_WORKER_BACKUP_UPLOAD_TIMEOUT` | `"120"` | `backend/app/services/worker_backup.py` | — |
| `CONTENT_HUB_WORKER_ID` | `"me"` | `backend/app/config.py` | — |
| `CONTENT_HUB_WORKER_NAME` | `"나"` | `backend/app/config.py` | — |
| `MVHUB_APP_BROWSER` | `""` | `run_agent_session.py` | — |
| `MVHUB_CLI_MAX_IN_FLIGHT` | `64` | `agent_push.py` | — |
| `MVHUB_CLI_SUBMIT_WORKERS` | `8` | `agent_push.py` | — |
| `MVHUB_CLI_TRACK_BUDGET` | `10` | `agent_push.py` | — |
| `MVHUB_CMDCMDLINE` | `""` | `run_agent_session.py` | `MV_agent.bat` |
| `MVHUB_LOCAL_URLS` | `"http://127.0.0.1:8010,http://127.0.0.1:8012"` | `backend/app/resources/resolve/MVHub_Importer.py` | — |
| `MVHUB_SESSION_GUARDED` | `None` | `run_agent_session.py` | `run_agent_session.py` |
| `MVHUB_SESSION_TOKEN` | `(표시 안 함)` | `agent_push.py` | — |
| `MVHUB_UPDATE_STATE_DIR` | `str(Path(os.environ.get("LOCALAPPDATA") or tempfile.gettempd…` | `backend/app/services/release_update.py` | — |
| `PM_TEST_SNAPSHOT_TOKEN` | — | `tools/refresh_pm_test_data.py` | — |
| `RESOLVE_SCRIPT_API` | `""` | `backend/app/services/resolve_bridge.py` | — |
| `RESOLVE_SCRIPT_LIB` | `""` | `backend/app/services/resolve_bridge.py` | `backend/app/services/resolve_bridge.py` |

## 코드가 읽지 않고 자식 프로세스에 넘기기만 하는 변수

`{**os.environ, "X": 값}` 꼴로 CLI·PowerShell 같은 자식에게 준다(예: 과금 공간을 정하는 `HIGGSFIELD_WORKSPACE_ID`).

| 이름 | 넘기는 파일 |
| --- | --- |
| `HIGGSFIELD_WORKSPACE_ID` | `agent_push.py` |
| `MVHUB_CLIP_LIST` | `backend/app/routers/assets.py` |

## Windows 가 주는 변수 (제품 설정 아님)

| 이름 | 직접 읽는 파일 |
| --- | --- |
| `APPDATA` | `backend/app/services/resolve_script_installer.py` |
| `COMPUTERNAME` | `backend/app/services/worker_backup.py` |
| `LOCALAPPDATA` | `agent_push.py` `backend/app/services/release_update.py` `run_agent_session.py` |
| `PROGRAMDATA` | `backend/app/services/resolve_bridge.py` `backend/app/services/resolve_script_installer.py` |
| `PROGRAMFILES` | `backend/app/services/resolve_bridge.py` `backend/app/services/resolve_diagnostics.py` |

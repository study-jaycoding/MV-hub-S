# 엔드포인트 목록

> 이 파일은 `python tools/gen_inventory.py` 가 코드에서 뽑아 만든다. **손으로 고치지 않는다** — 다음 생성 때 사라진다.
> 코드와 어긋나면 `backend/tests/test_docs_inventory_fresh.py` 가 실패한다. 그때는 위 명령을 다시 돌리고 문서 커밋으로 올린다.

뽑는 규칙과 한계:

- FastAPI 데코레이터(`@router.get(…)`·`@app.get(…)`·`websocket`·`api_route`)를 AST 로 읽는다. 경로 = `APIRouter(prefix=)` + 데코레이터 경로이고, 라우터 안의 `include_router` 는 부모 접두를 물려받는다.
- **중앙 프록시 분류(위임 모드에서)** 는 `routers/_proxy.py` 의 `_LOCAL_PREFIXES`·`_LOCAL_EXACT` 에 `is_local_path` 와 같은 규칙을 적용한 것이다. **실제 중계는 `proxying()` 이 참일 때만** 일어난다 — AUTH off + 공유 서버 토큰 있음 + `CONTENT_HUB_NO_PROXY` 아님(작업자 PC 의 로컬 허브). 공유 서버 본체·test_dev 에서는 `기본 중계` 경로도 자기가 처리한다. `/media`·`/api/media-thumb` 의 서버 보존본 폴백은 별도 예외다.
- `로컬 예외 · 핸들러가 _proxy 호출` 은 핸들러 **본문이 `_proxy` 를 직접 참조**할 때만 붙는다(팀 탭 등에서 핸들러가 골라서 위임). 헬퍼·usecase 를 거쳐 위임하면 안 보이므로, 이 표시가 없다고 위임이 없다는 뜻은 아니다.
- `Depends` 칸은 라우터·데코레이터·핸들러 인자에 직접 적힌 것만이다. 인증 미들웨어와 핸들러 본문의 권한 검사는 안 나온다.

전체 292개.

## `backend/app/main.py` — 10개

| 메서드 | 경로 | 핸들러 | 중앙 프록시 분류(위임 모드에서) | Depends |
| --- | --- | --- | --- | --- |
| `GET` | `/api/admin/audit-events` | `audit_events` | 기본 중계 | — |
| `GET` | `/api/admin/generation-events` | `generation_events` | 기본 중계 | — |
| `GET` | `/api/admin/runtime` | `runtime_status` | 기본 중계 | — |
| `POST` | `/api/backup` | `trigger_backup` | 로컬 예외 | — |
| `GET` | `/api/backups` | `list_backups` | 로컬 예외 | — |
| `GET` | `/api/cli-check` | `cli_check` | 로컬 예외 · 핸들러가 `_proxy` 호출 | — |
| `GET` | `/api/health` | `health` | 로컬 예외 | — |
| `GET` | `/api/ready` | `ready` | 기본 중계 | — |
| `WEBSOCKET` | `/ws` | `websocket_endpoint` | 해당 없음 | — |
| `GET` | `/{full_path:path}` | `spa_fallback` | 해당 없음 | — |

## `backend/app/routers/assets.py` — 18개

| 메서드 | 경로 | 핸들러 | 중앙 프록시 분류(위임 모드에서) | Depends |
| --- | --- | --- | --- | --- |
| `POST` | `/api/assets/capture-discard` | `discard_capture` | 로컬 예외 | `_require_local_assets` |
| `POST` | `/api/assets/capture` | `upload_capture` | 로컬 예외 | `_require_local_assets` |
| `POST` | `/api/assets/clipboard-copy` | `clipboard_copy_files` | 로컬 예외 | `_require_local_assets` |
| `GET` | `/api/assets/file` | `get_file` | 로컬 예외 | `_require_local_assets` |
| `DELETE` | `/api/assets/mounts/{name}` | `del_mount` | 로컬 예외 | `_require_mount_manager` |
| `GET` | `/api/assets/mounts` | `list_mounts` | 로컬 예외 | `_require_local_assets` |
| `POST` | `/api/assets/mounts` | `add_mount` | 로컬 예외 | `_require_mount_manager` |
| `GET` | `/api/assets/projects` | `list_projects` | 로컬 예외 | `_require_local_assets` |
| `POST` | `/api/assets/reference-import` | `upload_reference_import` | 로컬 예외 | `_require_local_assets` |
| `POST` | `/api/assets/reveal` | `reveal_file` | 로컬 예외 | `_require_local_assets` |
| `PUT` | `/api/assets/source` | `asset_set_source` | 로컬 예외 | `_require_local_assets` |
| `PUT` | `/api/assets/sources/batch` | `asset_set_sources_batch` | 로컬 예외 | `_require_local_assets` |
| `POST` | `/api/assets/sources/prune` | `prune_broken_sources` | 로컬 예외 | `_require_local_assets` |
| `POST` | `/api/assets/sources/relink` | `relink_broken_sources` | 로컬 예외 | `_require_local_assets` |
| `GET` | `/api/assets/thumb` | `get_thumb` | 로컬 예외 | `_require_local_assets` |
| `GET` | `/api/assets/tree` | `project_tree` | 로컬 예외 | `_require_local_assets` |
| `POST` | `/api/assets/upload` | `upload_assets` | 로컬 예외 | `_require_local_assets` |
| `GET` | `/api/assets/zip` | `export_zip` | 로컬 예외 | `_require_local_assets` |

## `backend/app/routers/assets_metadata.py` — 11개

| 메서드 | 경로 | 핸들러 | 중앙 프록시 분류(위임 모드에서) | Depends |
| --- | --- | --- | --- | --- |
| `PUT` | `/api/assets/color` | `asset_set_color` | 로컬 예외 | `_assets_access.require_local_assets` |
| `PUT` | `/api/assets/colors/batch` | `asset_set_colors_batch` | 로컬 예외 | `_assets_access.require_local_assets` |
| `PUT` | `/api/assets/comment` | `asset_set_comment` | 로컬 예외 | `_assets_access.require_local_assets` |
| `POST` | `/api/assets/comments/read` | `read_comments` | 로컬 예외 · 핸들러가 `_proxy` 호출 | — |
| `DELETE` | `/api/assets/comments/{comment_id}` | `delete_comment` | 로컬 예외 · 핸들러가 `_proxy` 호출 | — |
| `PUT` | `/api/assets/comments/{comment_id}` | `edit_comment` | 로컬 예외 · 핸들러가 `_proxy` 호출 | — |
| `GET` | `/api/assets/comments` | `list_comments` | 로컬 예외 · 핸들러가 `_proxy` 호출 | — |
| `POST` | `/api/assets/comments` | `add_comment` | 로컬 예외 · 핸들러가 `_proxy` 호출 | — |
| `GET` | `/api/assets/meta` | `asset_meta` | 로컬 예외 · 핸들러가 `_proxy` 호출 | — |
| `PUT` | `/api/assets/tags/batch` | `asset_set_tags_batch` | 로컬 예외 | `_assets_access.require_local_assets` |
| `PUT` | `/api/assets/tags` | `asset_set_tags` | 로컬 예외 | `_assets_access.require_local_assets` |

## `backend/app/routers/auth.py` — 16개

| 메서드 | 경로 | 핸들러 | 중앙 프록시 분류(위임 모드에서) | Depends |
| --- | --- | --- | --- | --- |
| `POST` | `/api/auth/access` | `access` | 기본 중계 | — |
| `PATCH` | `/api/auth/accounts/{email}/global-roles` | `set_global_roles` | 기본 중계 | — |
| `PATCH` | `/api/auth/accounts/{email}/hidden` | `set_hidden` | 기본 중계 | — |
| `POST` | `/api/auth/accounts/{email}/reset-password` | `reset_password` | 기본 중계 | — |
| `PATCH` | `/api/auth/accounts/{email}/status` | `set_status` | 기본 중계 | — |
| `GET` | `/api/auth/accounts` | `list_accounts` | 기본 중계 | — |
| `GET` | `/api/auth/config` | `auth_config` | 로컬 예외 | — |
| `POST` | `/api/auth/login` | `login` | 기본 중계 | — |
| `POST` | `/api/auth/logout` | `logout` | 기본 중계 | — |
| `POST` | `/api/auth/me/name` | `change_my_name` | 기본 중계 | — |
| `POST` | `/api/auth/me/password` | `change_my_password` | 기본 중계 | — |
| `GET` | `/api/auth/me` | `me` | 기본 중계 | — |
| `POST` | `/api/auth/register` | `register` | 기본 중계 | — |
| `POST` | `/api/auth/super-admin/elevate` | `elevate_super_admin` | 기본 중계 | — |
| `POST` | `/api/auth/super-admin/revoke` | `revoke_super_admin` | 기본 중계 | — |
| `GET` | `/api/auth/super-admin/status` | `super_admin_status` | 기본 중계 | — |

## `backend/app/routers/comfy.py` — 11개

| 메서드 | 경로 | 핸들러 | 중앙 프록시 분류(위임 모드에서) | Depends |
| --- | --- | --- | --- | --- |
| `GET` | `/api/comfy/health` | `health` | 로컬 예외 | `_require_local_comfy` |
| `POST` | `/api/comfy/parse` | `parse` | 로컬 예외 | `_require_local_comfy` |
| `GET` | `/api/comfy/run_status` | `run_status` | 로컬 예외 | `_require_local_comfy` |
| `POST` | `/api/comfy/run` | `run` | 로컬 예외 | `_require_local_comfy` |
| `POST` | `/api/comfy/save-to-library` | `save_to_library` | 로컬 예외 | `_require_local_comfy` |
| `GET` | `/api/comfy/settings` | `get_settings` | 로컬 예외 | `_require_local_comfy` |
| `PUT` | `/api/comfy/settings` | `put_settings` | 로컬 예외 | `_require_local_comfy` |
| `GET` | `/api/comfy/subscription` | `subscription` | 로컬 예외 | `_require_local_comfy` |
| `POST` | `/api/comfy/unresolved-runs/dismiss` | `dismiss_unresolved_runs` | 로컬 예외 | `_require_local_comfy` |
| `POST` | `/api/comfy/unresolved-runs/{job_id}/collect` | `collect_unresolved_run` | 로컬 예외 | `_require_local_comfy` |
| `GET` | `/api/comfy/unresolved-runs` | `list_unresolved_runs` | 로컬 예외 | `_require_local_comfy` |

## `backend/app/routers/console.py` — 2개

| 메서드 | 경로 | 핸들러 | 중앙 프록시 분류(위임 모드에서) | Depends |
| --- | --- | --- | --- | --- |
| `POST` | `/api/console/close-app` | `console_close_app` | 로컬 예외 | — |
| `GET` | `/api/console/summary` | `console_summary` | 로컬 예외 | — |

## `backend/app/routers/db_backup.py` — 7개

| 메서드 | 경로 | 핸들러 | 중앙 프록시 분류(위임 모드에서) | Depends |
| --- | --- | --- | --- | --- |
| `GET` | `/api/db-backup/latest-set` | `download_latest_set` | 기본 중계 | — |
| `GET` | `/api/db-backup/latest` | `download_latest` | 기본 중계 | — |
| `POST` | `/api/db-backup/sets/{backup_set_id}/activate` | `activate_backup_set` | 기본 중계 | — |
| `GET` | `/api/db-backup/sets/{backup_set_id}` | `download_backup_set` | 기본 중계 | — |
| `POST` | `/api/db-backup/sets` | `upload_backup_set` | 기본 중계 | — |
| `GET` | `/api/db-backup` | `list_backups` | 기본 중계 | — |
| `POST` | `/api/db-backup` | `upload_backup` | 기본 중계 | — |

## `backend/app/routers/db_transfer.py` — 9개

| 메서드 | 경로 | 핸들러 | 중앙 프록시 분류(위임 모드에서) | Depends |
| --- | --- | --- | --- | --- |
| `GET` | `/api/db/backup-continuity` | `backup_continuity` | 로컬 예외 | — |
| `POST` | `/api/db/backup-retry` | `retry_server_backup` | 로컬 예외 | — |
| `GET` | `/api/db/export-test-snapshot` | `export_test_snapshot` | 로컬 예외 | — |
| `GET` | `/api/db/export` | `export_db` | 로컬 예외 | — |
| `POST` | `/api/db/import` | `import_db` | 로컬 예외 | — |
| `POST` | `/api/db/server-backup` | `server_backup` | 로컬 예외 · 핸들러가 `_proxy` 호출 | — |
| `GET` | `/api/db/server-backups` | `server_backups` | 로컬 예외 · 핸들러가 `_proxy` 호출 | — |
| `POST` | `/api/db/server-restore/{backup_set_id}` | `server_restore_version` | 로컬 예외 · 핸들러가 `_proxy` 호출 | — |
| `POST` | `/api/db/server-restore` | `server_restore` | 로컬 예외 · 핸들러가 `_proxy` 호출 | — |

## `backend/app/routers/gen_requests.py` — 22개

| 메서드 | 경로 | 핸들러 | 중앙 프록시 분류(위임 모드에서) | Depends |
| --- | --- | --- | --- | --- |
| `POST` | `/api/gen-requests/by-generation/{gen_id}/confirm-not-submitted` | `confirm_generation_not_submitted` | 로컬 예외 | — |
| `POST` | `/api/gen-requests/canvas-candidates/claim` | `claim_canvas_generation_candidate` | 로컬 예외 | — |
| `GET` | `/api/gen-requests/canvas-candidates` | `canvas_generation_candidates` | 로컬 예외 | — |
| `GET` | `/api/gen-requests/canvas-history` | `canvas_generation_history` | 로컬 예외 | — |
| `POST` | `/api/gen-requests/canvas-links/repair` | `repair_orphaned_canvas_links` | 로컬 예외 | — |
| `POST` | `/api/gen-requests/canvas-links/resolve` | `resolve_canvas_generation_links` | 로컬 예외 | — |
| `GET` | `/api/gen-requests/deployment-pause` | `generation_deployment_pause` | 로컬 예외 | — |
| `PUT` | `/api/gen-requests/deployment-pause` | `set_generation_deployment_pause` | 로컬 예외 | — |
| `GET` | `/api/gen-requests/pending-exists` | `pending_gen_requests_exist` | 로컬 예외 | — |
| `GET` | `/api/gen-requests/pending` | `pending_gen_requests` | 로컬 예외 | — |
| `GET` | `/api/gen-requests/reconcile-candidates` | `reconcile_candidates` | 로컬 예외 | — |
| `GET` | `/api/gen-requests/recovery-probes` | `recovery_probe_requests` | 로컬 예외 | — |
| `POST` | `/api/gen-requests/{rid}/anchor` | `anchor_gen_request` | 로컬 예외 | — |
| `POST` | `/api/gen-requests/{rid}/begin-submission` | `begin_gen_request_submission` | 로컬 예외 | — |
| `POST` | `/api/gen-requests/{rid}/confirm-not-submitted` | `confirm_gen_request_not_submitted` | 로컬 예외 | — |
| `POST` | `/api/gen-requests/{rid}/fail` | `fail_gen_request` | 로컬 예외 | — |
| `POST` | `/api/gen-requests/{rid}/fulfill` | `fulfill_gen_request` | 로컬 예외 | — |
| `POST` | `/api/gen-requests/{rid}/reconcile` | `reconcile_gen_request` | 로컬 예외 | — |
| `POST` | `/api/gen-requests/{rid}/recovery-probe` | `record_recovery_probe` | 로컬 예외 | — |
| `POST` | `/api/gen-requests/{rid}/recovery-required` | `mark_gen_request_recovery_required` | 로컬 예외 | — |
| `POST` | `/api/gen-requests/{rid}/release-claim` | `release_gen_request_claim` | 로컬 예외 | — |
| `POST` | `/api/gen-requests` | `create_gen_request` | 로컬 예외 | — |

## `backend/app/routers/generation.py` — 40개

| 메서드 | 경로 | 핸들러 | 중앙 프록시 분류(위임 모드에서) | Depends |
| --- | --- | --- | --- | --- |
| `GET` | `/api/account` | `account_status` | 로컬 예외 | — |
| `POST` | `/api/cache-all` | `cache_all` | 로컬 예외 | — |
| `POST` | `/api/cost` | `estimate_cost` | 로컬 예외 | — |
| `GET` | `/api/creators` | `list_creators` | 로컬 예외 · 핸들러가 `_proxy` 호출 | — |
| `POST` | `/api/generation-comments/{comment_id}/seen` | `seen_gen_comment` | 로컬 예외 · 핸들러가 `_proxy` 호출 | — |
| `DELETE` | `/api/generation-comments/{comment_id}` | `delete_gen_comment` | 로컬 예외 · 핸들러가 `_proxy` 호출 | — |
| `PUT` | `/api/generation-comments/{comment_id}` | `edit_gen_comment` | 로컬 예외 · 핸들러가 `_proxy` 호출 | — |
| `POST` | `/api/generations/clear-failed` | `clear_failed` | 로컬 예외 | — |
| `PUT` | `/api/generations/colors/batch` | `set_colors_batch` | 로컬 예외 · 핸들러가 `_proxy` 호출 | — |
| `POST` | `/api/generations/comment-counts` | `gen_comment_counts` | 로컬 예외 · 핸들러가 `_proxy` 호출 | — |
| `PUT` | `/api/generations/tags/batch` | `set_tags_batch` | 로컬 예외 · 핸들러가 `_proxy` 호출 | — |
| `POST` | `/api/generations/trash-hf-missing` | `trash_hf_missing` | 로컬 예외 · 핸들러가 `_proxy` 호출 | — |
| `PUT` | `/api/generations/workspace/batch` | `set_generation_workspace_batch` | 로컬 예외 · 핸들러가 `_proxy` 호출 | — |
| `PUT` | `/api/generations/workspace/team-batch` | `set_team_generation_workspace_batch` | 로컬 예외 · 핸들러가 `_proxy` 호출 | — |
| `PUT` | `/api/generations/{gen_id}/auto-tags` | `set_gen_auto_tags` | 로컬 예외 | — |
| `POST` | `/api/generations/{gen_id}/cache` | `cache_one` | 로컬 예외 | — |
| `PUT` | `/api/generations/{gen_id}/color` | `set_color` | 로컬 예외 | — |
| `PUT` | `/api/generations/{gen_id}/comment` | `set_comment` | 로컬 예외 | — |
| `POST` | `/api/generations/{gen_id}/comments/read` | `read_gen_comments` | 로컬 예외 · 핸들러가 `_proxy` 호출 | — |
| `GET` | `/api/generations/{gen_id}/comments` | `list_gen_comments` | 로컬 예외 · 핸들러가 `_proxy` 호출 | — |
| `POST` | `/api/generations/{gen_id}/comments` | `add_gen_comment` | 로컬 예외 · 핸들러가 `_proxy` 호출 | — |
| `POST` | `/api/generations/{gen_id}/derive-from` | `derive_from` | 로컬 예외 | `resolve_gen_ref` |
| `GET` | `/api/generations/{gen_id}/history-tree` | `get_history_tree` | 로컬 예외 · 핸들러가 `_proxy` 호출 | `resolve_gen_ref` |
| `DELETE` | `/api/generations/{gen_id}/history/{parent_gen_id}` | `remove_history` | 로컬 예외 | `resolve_gen_ref` |
| `GET` | `/api/generations/{gen_id}/history` | `get_history` | 로컬 예외 · 핸들러가 `_proxy` 호출 | `resolve_gen_ref` |
| `POST` | `/api/generations/{gen_id}/history` | `add_history` | 로컬 예외 | `resolve_gen_ref` |
| `GET` | `/api/generations/{gen_id}/metrics` | `gen_metrics` | 로컬 예외 · 핸들러가 `_proxy` 호출 | `resolve_gen_ref` |
| `POST` | `/api/generations/{gen_id}/restore` | `restore_generation` | 로컬 예외 | — |
| `PUT` | `/api/generations/{gen_id}/source` | `set_source` | 로컬 예외 | — |
| `PUT` | `/api/generations/{gen_id}/tags` | `set_tags` | 로컬 예외 | — |
| `DELETE` | `/api/generations/{gen_id}` | `delete_generation` | 로컬 예외 · 핸들러가 `_proxy` 호출 | — |
| `GET` | `/api/models/{job_set_type}/params` | `model_params` | 로컬 예외 | — |
| `GET` | `/api/models` | `list_models` | 로컬 예외 | — |
| `GET` | `/api/sources` | `list_sources` | 로컬 예외 | — |
| `DELETE` | `/api/tags/{tag}` | `delete_tag` | 로컬 예외 | — |
| `GET` | `/api/workspaces/available` | `available_workspaces` | 로컬 예외 · 핸들러가 `_proxy` 호출 | — |
| `GET` | `/api/workspaces/resolve` | `resolve_workspace_by_name` | 로컬 예외 | — |
| `POST` | `/api/workspaces/select` | `select_workspace` | 로컬 예외 | — |
| `POST` | `/api/workspaces/unselect` | `unselect_workspace` | 로컬 예외 | — |
| `GET` | `/api/workspaces` | `list_workspaces` | 로컬 예외 | — |

## `backend/app/routers/generation_views.py` — 2개

| 메서드 | 경로 | 핸들러 | 중앙 프록시 분류(위임 모드에서) | Depends |
| --- | --- | --- | --- | --- |
| `GET` | `/api/generation-views` | `get_generation_views` | 로컬 예외 | — |
| `PUT` | `/api/generation-views` | `put_generation_view` | 로컬 예외 | — |

## `backend/app/routers/ingest.py` — 16개

| 메서드 | 경로 | 핸들러 | 중앙 프록시 분류(위임 모드에서) | Depends |
| --- | --- | --- | --- | --- |
| `GET` | `/api/account/hf` | `my_hf_status` | 기본 중계 | — |
| `GET` | `/api/agent/download` | `download_agent` | 로컬 예외 | — |
| `POST` | `/api/agent/local-pair-token` | `local_agent_pair_token` | 로컬 예외 | — |
| `POST` | `/api/agent/reinspect` | `agent_reinspect` | 로컬 예외 | — |
| `GET` | `/api/agent/run-bat` | `run_agent_bat` | 로컬 예외 | — |
| `GET` | `/api/agent/status` | `agent_status` | 로컬 예외 | — |
| `POST` | `/api/agent/sync` | `agent_sync` | 로컬 예외 | — |
| `GET` | `/api/agent/wait` | `agent_wait` | 로컬 예외 | — |
| `GET` | `/api/credits` | `team_credits` | 기본 중계 | — |
| `POST` | `/api/ingest/account-report` | `ingest_account_report` | 로컬 예외 | — |
| `POST` | `/api/ingest/history/start` | `start_history_import` | 로컬 예외 | — |
| `GET` | `/api/ingest/history/status` | `history_import_status` | 로컬 예외 | — |
| `GET` | `/api/ingest/known-jobs` | `known_jobs` | 로컬 예외 | — |
| `POST` | `/api/ingest/known-jobs` | `known_jobs_diff` | 로컬 예외 | — |
| `POST` | `/api/ingest/mcp` | `ingest_mcp` | 로컬 예외 | — |
| `POST` | `/api/ingest` | `ingest` | 로컬 예외 · 핸들러가 `_proxy` 호출 | — |

## `backend/app/routers/library.py` — 15개

| 메서드 | 경로 | 핸들러 | 중앙 프록시 분류(위임 모드에서) | Depends |
| --- | --- | --- | --- | --- |
| `DELETE` | `/api/auto-tags/{name}` | `delete_auto_tag` | 로컬 예외 | — |
| `GET` | `/api/auto-tags` | `list_auto_tags` | 로컬 예외 | — |
| `POST` | `/api/auto-tags` | `create_auto_tag` | 로컬 예외 | — |
| `GET` | `/api/download` | `download_media` | 로컬 예외 | — |
| `GET` | `/api/facets` | `facets` | 로컬 예외 · 핸들러가 `_proxy` 호출 | — |
| `GET` | `/api/generations-stats` | `generation_stats` | 로컬 예외 · 핸들러가 `_proxy` 호출 | — |
| `POST` | `/api/generations/batch` | `get_generations_batch` | 로컬 예외 · 핸들러가 `_proxy` 호출 | — |
| `POST` | `/api/generations/locate` | `locate_generation_targets` | 로컬 예외 · 핸들러가 `_proxy` 호출 | — |
| `GET` | `/api/generations/{gen_id}` | `get_generation` | 로컬 예외 · 핸들러가 `_proxy` 호출 | — |
| `GET` | `/api/generations` | `list_generations` | 로컬 예외 · 핸들러가 `_proxy` 호출 | — |
| `GET` | `/api/media-thumb` | `media_thumb` | 로컬 예외 · 핸들러가 `_proxy` 호출 | — |
| `POST` | `/api/merge` | `merge_videos` | 로컬 예외 | — |
| `POST` | `/api/stamp/read` | `read_file_stamp` | 로컬 예외 | — |
| `DELETE` | `/api/trash/{gen_id}` | `purge_trashed_item` | 로컬 예외 | — |
| `GET` | `/api/trash` | `list_trash` | 로컬 예외 | — |

## `backend/app/routers/manage.py` — 43개

| 메서드 | 경로 | 핸들러 | 중앙 프록시 분류(위임 모드에서) | Depends |
| --- | --- | --- | --- | --- |
| `GET` | `/api/manage/breakdown` | `breakdown` | 기본 중계 | — |
| `GET` | `/api/manage/credit-plan/my-models` | `credit_plan_my_models` | 기본 중계 | — |
| `GET` | `/api/manage/credit-plan/{workspace_id}/settings` | `credit_plan_settings` | 기본 중계 | — |
| `PUT` | `/api/manage/credit-plan/{workspace_id}` | `put_credit_plan` | 기본 중계 | — |
| `GET` | `/api/manage/credit-plan` | `credit_plan` | 기본 중계 | — |
| `POST` | `/api/manage/hf-missing-apply` | `hf_missing_apply` | 기본 중계 | — |
| `GET` | `/api/manage/hf-missing-candidates` | `hf_missing_candidates` | 기본 중계 | — |
| `POST` | `/api/manage/local-task-previews` | `local_task_previews` | 로컬 예외 · 핸들러가 `_proxy` 호출 | — |
| `GET` | `/api/manage/matrix` | `matrix` | 기본 중계 | — |
| `GET` | `/api/manage/member-table` | `member_table` | 기본 중계 | — |
| `GET` | `/api/manage/planning/{pid}` | `get_planning` | 기본 중계 | — |
| `PUT` | `/api/manage/planning/{pid}` | `put_planning` | 기본 중계 | — |
| `POST` | `/api/manage/project-folders/reveal` | `reveal_project_folder` | 로컬 예외 · 핸들러가 `_proxy` 호출 | — |
| `PATCH` | `/api/manage/project-folders/{pid}/selection` | `patch_project_folder_selection` | 로컬 예외 | — |
| `GET` | `/api/manage/project-folders/{pid}` | `get_project_folder` | 로컬 예외 | — |
| `PUT` | `/api/manage/project-folders/{pid}` | `put_project_folder` | 로컬 예외 · 핸들러가 `_proxy` 호출 | — |
| `GET` | `/api/manage/project-folders` | `project_folder_links` | 로컬 예외 | — |
| `GET` | `/api/manage/project-summary` | `project_summary` | 기본 중계 | — |
| `GET` | `/api/manage/save-finals/content/{gen_id}` | `save_finals_content` | 기본 중계 | — |
| `GET` | `/api/manage/save-finals/targets` | `save_finals_targets` | 기본 중계 | — |
| `GET` | `/api/manage/save-finals` | `save_finals_status` | 로컬 예외 | — |
| `POST` | `/api/manage/save-finals` | `save_finals` | 로컬 예외 | — |
| `GET` | `/api/manage/summary` | `summary` | 기본 중계 | — |
| `GET` | `/api/manage/task-projects` | `list_task_projects` | 기본 중계 | — |
| `POST` | `/api/manage/tasks-batch/delete` | `delete_tasks_batch` | 기본 중계 | — |
| `PATCH` | `/api/manage/tasks-batch/order` | `update_task_order_batch` | 기본 중계 | — |
| `GET` | `/api/manage/tasks-batch` | `list_tasks_batch` | 기본 중계 | — |
| `PATCH` | `/api/manage/tasks/assignees/bulk` | `bulk_set_assignments` | 기본 중계 | — |
| `DELETE` | `/api/manage/tasks/{tid}/assignees/{uid}` | `remove_assignee` | 기본 중계 | — |
| `POST` | `/api/manage/tasks/{tid}/assignees/{uid}` | `add_assignee` | 기본 중계 | — |
| `DELETE` | `/api/manage/tasks/{tid}/generations/{gen_id}` | `unlink_generation` | 기본 중계 | — |
| `POST` | `/api/manage/tasks/{tid}/generations` | `link_generations` | 기본 중계 | — |
| `DELETE` | `/api/manage/tasks/{tid}` | `remove_task` | 기본 중계 | — |
| `PATCH` | `/api/manage/tasks/{tid}` | `patch_task` | 기본 중계 | — |
| `GET` | `/api/manage/tasks` | `list_tasks` | 기본 중계 | — |
| `POST` | `/api/manage/tasks` | `create_task` | 기본 중계 | — |
| `GET` | `/api/manage/team-overview` | `team_overview` | 기본 중계 | — |
| `GET` | `/api/manage/team-timeseries` | `team_timeseries` | 기본 중계 | — |
| `POST` | `/api/manage/telemetry/push` | `telemetry_push` | 기본 중계 | — |
| `GET` | `/api/manage/timeseries` | `timeseries` | 기본 중계 | — |
| `GET` | `/api/manage/usage-detail-export` | `usage_detail_export` | 기본 중계 | — |
| `GET` | `/api/manage/usage-export` | `usage_export` | 기본 중계 | — |
| `GET` | `/api/manage/workspaces` | `manage_workspaces` | 기본 중계 | — |

## `backend/app/routers/members.py` — 2개

| 메서드 | 경로 | 핸들러 | 중앙 프록시 분류(위임 모드에서) | Depends |
| --- | --- | --- | --- | --- |
| `PATCH` | `/api/members/{uid}/global-roles` | `set_member_global_roles` | 기본 중계 | — |
| `GET` | `/api/members` | `list_members` | 기본 중계 | — |

## `backend/app/routers/notifications.py` — 2개

| 메서드 | 경로 | 핸들러 | 중앙 프록시 분류(위임 모드에서) | Depends |
| --- | --- | --- | --- | --- |
| `POST` | `/api/notifications/comments/seen-all` | `seen_all_comment_notifications` | 기본 중계 | — |
| `GET` | `/api/notifications/comments` | `list_comment_notifications` | 기본 중계 | — |

## `backend/app/routers/projects.py` — 17개

| 메서드 | 경로 | 핸들러 | 중앙 프록시 분류(위임 모드에서) | Depends |
| --- | --- | --- | --- | --- |
| `POST` | `/api/projects/assign` | `assign_project` | 로컬 예외 · 핸들러가 `_proxy` 호출 | — |
| `POST` | `/api/projects/folder-counts/batch` | `project_folder_counts_batch` | 로컬 예외 · 핸들러가 `_proxy` 호출 | — |
| `GET` | `/api/projects/members-all` | `list_all_members` | 로컬 예외 · 핸들러가 `_proxy` 호출 | — |
| `GET` | `/api/projects/members-visible` | `list_visible_members` | 로컬 예외 · 핸들러가 `_proxy` 호출 | — |
| `GET` | `/api/projects/my-finalize-roles` | `my_finalize_roles` | 로컬 예외 · 핸들러가 `_proxy` 호출 | — |
| `POST` | `/api/projects/reorder` | `reorder_projects` | 로컬 예외 · 핸들러가 `_proxy` 호출 | — |
| `GET` | `/api/projects/team-fresh` | `team_fresh` | 로컬 예외 · 핸들러가 `_proxy` 호출 | — |
| `GET` | `/api/projects/workspace-options/{workspace_id}/members` | `workspace_option_members` | 로컬 예외 · 핸들러가 `_proxy` 호출 | — |
| `GET` | `/api/projects/workspace-options` | `workspace_options` | 로컬 예외 · 핸들러가 `_proxy` 호출 | — |
| `GET` | `/api/projects/{pid}/folder-counts` | `project_folder_counts` | 로컬 예외 · 핸들러가 `_proxy` 호출 | — |
| `DELETE` | `/api/projects/{pid}/members/{uid}` | `remove_member` | 로컬 예외 · 핸들러가 `_proxy` 호출 | — |
| `GET` | `/api/projects/{pid}/members` | `list_members` | 로컬 예외 · 핸들러가 `_proxy` 호출 | — |
| `PATCH` | `/api/projects/{pid}/members` | `set_member_roles` | 로컬 예외 · 핸들러가 `_proxy` 호출 | — |
| `DELETE` | `/api/projects/{pid}` | `delete_project` | 로컬 예외 · 핸들러가 `_proxy` 호출 | — |
| `PATCH` | `/api/projects/{pid}` | `update_project` | 로컬 예외 · 핸들러가 `_proxy` 호출 | — |
| `GET` | `/api/projects` | `list_projects` | 로컬 예외 · 핸들러가 `_proxy` 호출 | — |
| `POST` | `/api/projects` | `create_project` | 로컬 예외 · 핸들러가 `_proxy` 호출 | — |

## `backend/app/routers/publish.py` — 14개

| 메서드 | 경로 | 핸들러 | 중앙 프록시 분류(위임 모드에서) | Depends |
| --- | --- | --- | --- | --- |
| `POST` | `/api/publish-to-shared/folder` | `publish_folder_to_shared` | 로컬 예외 | — |
| `POST` | `/api/publish-to-shared` | `publish_to_shared` | 로컬 예외 · 핸들러가 `_proxy` 호출 | — |
| `POST` | `/api/share/publish-bundle` | `receive_published_bundle` | 기본 중계 | — |
| `POST` | `/api/shared-server/de-elevate` | `shared_server_de_elevate` | 로컬 예외 | — |
| `POST` | `/api/shared-server/elevate` | `shared_server_elevate` | 로컬 예외 | — |
| `POST` | `/api/shared-server/login` | `shared_server_login` | 로컬 예외 | — |
| `POST` | `/api/shared-server/logout` | `shared_server_logout` | 로컬 예외 | — |
| `POST` | `/api/shared-server/probe` | `probe_shared_server` | 로컬 예외 | — |
| `POST` | `/api/shared-server/register` | `shared_server_register` | 로컬 예외 | — |
| `POST` | `/api/shared-server/relocate` | `relocate_shared_server` | 로컬 예외 | — |
| `POST` | `/api/shared-server/relocation/publish` | `publish_relocation_announcement` | 로컬 예외 | — |
| `GET` | `/api/shared-server/relocation` | `shared_server_relocation` | 로컬 예외 | — |
| `GET` | `/api/shared-server/status` | `shared_server_status` | 로컬 예외 | — |
| `POST` | `/api/shared-server/url` | `set_shared_url` | 로컬 예외 | — |

## `backend/app/routers/release_update.py` — 3개

| 메서드 | 경로 | 핸들러 | 중앙 프록시 분류(위임 모드에서) | Depends |
| --- | --- | --- | --- | --- |
| `GET` | `/api/release-update/latest-metadata` | `release_update_latest_metadata` | 로컬 예외 | — |
| `POST` | `/api/release-update/start` | `release_update_start` | 로컬 예외 | — |
| `GET` | `/api/release-update/status` | `release_update_status` | 로컬 예외 | — |

## `backend/app/routers/resolve_integration.py` — 10개

| 메서드 | 경로 | 핸들러 | 중앙 프록시 분류(위임 모드에서) | Depends |
| --- | --- | --- | --- | --- |
| `GET` | `/api/resolve/diagnostics` | `get_resolve_environment_diagnostics` | 로컬 예외 | — |
| `GET` | `/api/resolve/locks` | `get_resolve_lock_paths` | 로컬 예외 | — |
| `POST` | `/api/resolve/python-install` | `post_resolve_python_install` | 로컬 예외 | — |
| `POST` | `/api/resolve/script/install` | `post_resolve_script_install` | 로컬 예외 | — |
| `GET` | `/api/resolve/script` | `get_resolve_script_status` | 로컬 예외 | — |
| `GET` | `/api/resolve/status` | `get_resolve_connection_status` | 로컬 예외 | — |
| `POST` | `/api/resolve/transfers/manual-result` | `record_manual_resolve_result` | 로컬 예외 | — |
| `GET` | `/api/resolve/transfers/pending` | `pending_resolve_transfers` | 로컬 예외 | — |
| `POST` | `/api/resolve/transfers/retry` | `retry_resolve_transfer` | 로컬 예외 | — |
| `POST` | `/api/resolve/transfers` | `create_resolve_transfer` | 로컬 예외 | — |

## `backend/app/routers/scenes.py` — 4개

| 메서드 | 경로 | 핸들러 | 중앙 프록시 분류(위임 모드에서) | Depends |
| --- | --- | --- | --- | --- |
| `GET` | `/api/scenes/backup` | `list_scene_backups` | 로컬 예외 | — |
| `PUT` | `/api/scenes/backup` | `sync_scene_backups` | 로컬 예외 | — |
| `GET` | `/api/scenes/cards` | `list_scene_card_links` | 로컬 예외 | — |
| `PUT` | `/api/scenes/cards` | `sync_scene_card_links` | 로컬 예외 | — |

## `backend/app/routers/share.py` — 9개

| 메서드 | 경로 | 핸들러 | 중앙 프록시 분류(위임 모드에서) | Depends |
| --- | --- | --- | --- | --- |
| `POST` | `/api/generations/{gen_id}/final-review` | `final_review` | 로컬 예외 · 핸들러가 `_proxy` 호출 | — |
| `POST` | `/api/generations/{gen_id}/finalize` | `finalize` | 로컬 예외 · 핸들러가 `_proxy` 호출 | — |
| `POST` | `/api/generations/{gen_id}/hold` | `hold_generation` | 로컬 예외 | — |
| `POST` | `/api/generations/{gen_id}/import` | `import_to_workspace` | 로컬 예외 · 핸들러가 `_proxy` 호출 | — |
| `POST` | `/api/generations/{gen_id}/publish` | `publish` | 로컬 예외 · 핸들러가 `_proxy` 호출 | — |
| `POST` | `/api/generations/{gen_id}/unfinalize` | `unfinalize` | 로컬 예외 · 핸들러가 `_proxy` 호출 | — |
| `POST` | `/api/generations/{gen_id}/unhold` | `unhold_generation` | 로컬 예외 | — |
| `POST` | `/api/generations/{gen_id}/unpublish` | `unpublish` | 로컬 예외 · 핸들러가 `_proxy` 호출 | — |
| `GET` | `/api/provider` | `get_provider` | 기본 중계 | — |

## `backend/app/routers/sync.py` — 2개

| 메서드 | 경로 | 핸들러 | 중앙 프록시 분류(위임 모드에서) | Depends |
| --- | --- | --- | --- | --- |
| `GET` | `/api/sync-status` | `sync_status` | 로컬 예외 | — |
| `POST` | `/api/sync` | `sync_from_cli` | 로컬 예외 | — |

## `backend/app/routers/update_notices.py` — 7개

| 메서드 | 경로 | 핸들러 | 중앙 프록시 분류(위임 모드에서) | Depends |
| --- | --- | --- | --- | --- |
| `GET` | `/api/update-notices/admin/list` | `list_update_notices_admin` | 기본 중계 | — |
| `POST` | `/api/update-notices/admin/register` | `register_update_notice` | 기본 중계 | — |
| `POST` | `/api/update-notices/admin/{notice_id}/announce` | `announce_update_notice` | 기본 중계 | — |
| `PUT` | `/api/update-notices/admin/{notice_id}/pin` | `pin_update_notice` | 기본 중계 | — |
| `POST` | `/api/update-notices/seen-all` | `seen_all_update_notices` | 기본 중계 | — |
| `POST` | `/api/update-notices/{notice_id}/seen` | `seen_update_notice` | 기본 중계 | — |
| `GET` | `/api/update-notices` | `list_update_notices` | 기본 중계 | — |

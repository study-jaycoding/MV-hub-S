# DB 테이블 목록

> 이 파일은 `python tools/gen_inventory.py` 가 코드에서 뽑아 만든다. **손으로 고치지 않는다** — 다음 생성 때 사라진다.
> 코드와 어긋나면 `backend/tests/test_docs_inventory_fresh.py` 가 실패한다. 그때는 위 명령을 다시 돌리고 문서 커밋으로 올린다.

뽑는 규칙과 한계:

- `backend/schema.sql` 과 제품 파이썬(`backend/app`·`backend/*.py`·루트 `*.py`)의 **문자열 리터럴**(f-string 의 상수 조각 포함, 독스트링 제외)에서 `CREATE TABLE` 을 찾는다.
- **DB** 칸은 DDL 이 있는 파일로 정한다(이 도구의 `DB_FAMILY` 표). `content DB` 는 그때 고른 콘텐츠 DB(`db_paths.get_db_path()` — 계정·모드에 따라 파일이 다르다)이고 `manage_schema.py` 의 PM 테이블도 거기 산다. `manage_hub.db` 는 팀 텔레메트리 전용으로 물리 분리돼 있다.
- **쓰는 모듈** = 리터럴 안의 `INSERT INTO`·`REPLACE INTO`·`UPDATE`·`DELETE FROM <테이블>`, **읽는 모듈** = `FROM`·`JOIN <테이블>`. 테이블 이름 자체를 `{}` 로 끼워 조립한 SQL 과 `FROM a, b` 의 둘째 이름은 못 잡는다 — **빈칸이 '아무도 안 쓴다'는 뜻은 아니다.** 경로는 `backend/app/` 을 뗀 것이다.
- 컬럼은 싣지 않는다. 정의 파일의 `CREATE TABLE` 과 그 뒤 `ALTER TABLE … ADD COLUMN` 마이그레이션을 본다.

테이블 96개.

| 테이블 | DB | 정의 파일 | 쓰는 모듈 | 읽는 모듈 |
| --- | --- | --- | --- | --- |
| `account` | content DB | `backend/schema.sql` | `db_migrations.py` `repo/accounts.py` `repo/identity.py` `routers/db_transfer.py` `services/db_scrub.py` | `backend/cleanup_orphan_creators.py` `db_migrations.py` `repo/accounts.py` `repo/identity.py` `repo/last_admin.py` `repo/manage_credit_plan.py` `repo/manage_member_table.py` `repo/manage_telemetry.py` `repo/project_membership.py` `repo/trash.py` `routers/_share_authority.py` |
| `account_report_delivery_state` | content DB | `repo/manage_schema.py` | `repo/manage_account_reports.py` | `repo/manage_account_reports.py` |
| `account_report_outbox` | content DB | `repo/manage_schema.py` | `repo/manage_account_reports.py` | `repo/manage_account_reports.py` |
| `ai_generation_batch` | content DB | `backend/schema.sql` | `repo/mcp_plans.py` | `repo/mcp_plans.py` |
| `anchor_outbox` | agent_state.db (작업자 PC) | `agent_push.py` | `agent_push.py` | `agent_push.py` |
| `app_setting` | content DB | `backend/schema.sql` | `db.py` `repo/identity.py` `routers/db_transfer.py` `routers/publish.py` `services/asset_registry.py` `services/auth.py` `services/db_scrub.py` | `db_account_dbs.py` `db_migrations.py` `repo/accounts.py` `repo/asset_locations.py` `repo/identity.py` `repo/share_commands.py` `services/asset_registry.py` `services/auth.py` `services/worker_backup.py` |
| `asset` | content DB | `backend/schema.sql` | `backend/cleanup_orphan_creators.py` `repo/generation_delete.py` `repo/generation_sync.py` `repo/generations.py` `repo/result_fingerprint.py` | `repo/asset_sync.py` `repo/assets.py` `repo/folder_cover.py` `repo/generation_rows.py` `repo/generation_sync.py` `repo/generations.py` `repo/generations_query.py` `repo/identity.py` `repo/manage.py` `repo/manage_task_previews.py` `repo/manage_tasks.py` `repo/manage_telemetry.py` `repo/result_fingerprint.py` `repo/share.py` `repo/trash.py` `services/thumbs.py` |
| `asset_blob` | content DB | `db_asset_sync.py` | `repo/asset_sync.py` | `repo/asset_locations.py` `repo/asset_sync.py` `routers/asset_sync.py` `services/asset_destination.py` `services/asset_sync.py` |
| `asset_comment` | content DB | `backend/schema.sql` | `repo/assets.py` | `repo/assets.py` |
| `asset_comment_read` | content DB | `backend/schema.sql` | `repo/assets.py` | `repo/assets.py` |
| `asset_destination_outbox` | content DB | `db_asset_destination.py` | `repo/identity.py` `services/asset_destination.py` | `services/asset_destination.py` |
| `asset_location` | content DB | `db_asset_sync.py` | `repo/asset_sync.py` `routers/assets.py` `services/asset_destination.py` `services/asset_sync.py` | `repo/asset_locations.py` `repo/asset_registry.py` `repo/asset_sync.py` `routers/asset_sync.py` `routers/assets.py` `services/asset_destination.py` `services/asset_sync.py` |
| `asset_location_alias` | content DB | `db_asset_sync.py` | `repo/identity.py` | `repo/asset_sync.py` |
| `asset_meta` | content DB | `backend/schema.sql` | `repo/assets.py` `repo/identity.py` | `db_migrations.py` `repo/assets.py` `repo/identity.py` `repo/sources.py` |
| `asset_owner_folder` | content DB | `db_asset_sync.py` | `services/asset_sync.py` | `services/asset_sync.py` |
| `asset_registry` | content DB | `backend/schema.sql` | `repo/asset_registry.py` `repo/projects.py` `services/asset_sync.py` | `repo/asset_registry.py` `services/asset_sync.py` |
| `asset_registry_event` | content DB | `backend/schema.sql` | `repo/asset_registry.py` | `repo/asset_registry.py` |
| `asset_registry_scan` | content DB | `backend/schema.sql` | `repo/asset_registry.py` | `repo/asset_registry.py` `routers/asset_registry.py` `services/asset_registry.py` |
| `asset_sync_outbox` | content DB | `db_asset_sync.py` | `repo/asset_sync.py` `repo/identity.py` `repo/projects.py` `routers/asset_sync.py` `services/asset_sync.py` | `repo/asset_locations.py` `repo/asset_sync.py` `routers/asset_sync.py` `routers/assets.py` `services/asset_sync.py` |
| `asset_upload_token` | content DB | `db_asset_sync.py` | `repo/identity.py` `services/asset_sync.py` `services/db_scrub.py` | `routers/asset_sync.py` `services/asset_sync.py` |
| `audit_event` | content DB | `backend/schema.sql` | `repo/event_journal.py` | `db_migrations.py` `repo/event_journal.py` `services/operational_health.py` |
| `auto_tag` | content DB | `backend/schema.sql` | `repo/identity.py` `repo/tags.py` | `db_migrations.py` `repo/facets.py` `repo/generation_rows.py` `repo/generations.py` `repo/generations_query.py` `repo/id_resolve.py` `repo/identity.py` `repo/manage_tasks.py` `repo/share.py` `repo/tags.py` `repo/trash.py` |
| `creator` | content DB | `backend/schema.sql` | `backend/cleanup_orphan_creators.py` `repo/accounts.py` `repo/identity.py` | `backend/cleanup_orphan_creators.py` `repo/identity.py` `repo/manage_credit_plan.py` `repo/manage_member_table.py` `repo/manage_telemetry.py` `repo/share.py` `repo/trash.py` |
| `credit_txn` | content DB | `repo/manage_schema.py` | `repo/manage_schema.py` `repo/manage_transactions.py` | `repo/manage.py` `repo/manage_schema.py` `repo/manage_transactions.py` |
| `credit_txn_alias_merged` | content DB | `repo/manage_schema.py` | `repo/manage_schema.py` | `repo/manage_schema.py` |
| `edit_doc_copy` | content DB | `backend/schema.sql` | `repo/edit_docs.py` | `repo/edit_docs.py` |
| `edit_doc_head` | content DB | `backend/schema.sql` | `repo/edit_docs.py` | `repo/edit_docs.py` |
| `final_export` | content DB | `repo/manage_schema.py` | `repo/manage.py` | `repo/manage.py` |
| `final_export_old` | content DB | `repo/manage_schema.py` | `repo/manage.py` | `repo/manage.py` |
| `folder_cover` | content DB | `backend/schema.sql` `db_migrations.py` | `repo/folder_cover.py` | `repo/folder_cover.py` |
| `gen_auto_tag` | content DB | `backend/schema.sql` | `backend/cleanup_orphan_creators.py` `repo/generation_delete.py` `repo/identity.py` `repo/tags.py` | `repo/generation_rows.py` `repo/generations.py` `repo/generations_query.py` `repo/id_resolve.py` `repo/manage_tasks.py` `repo/share.py` `repo/trash.py` |
| `gen_color_overlay` | content DB | `backend/schema.sql` `repo/id_resolve.py` | `repo/id_resolve.py` | `repo/id_resolve.py` |
| `gen_reference` | content DB | `backend/schema.sql` | `backend/cleanup_orphan_creators.py` `repo/generation_delete.py` `repo/generation_references.py` | `repo/asset_registry.py` `repo/asset_sync.py` `repo/gen_requests.py` `repo/generation_rows.py` `repo/generation_sync.py` `repo/generations.py` `repo/history.py` `repo/identity.py` `repo/share.py` `repo/trash.py` |
| `gen_request` | content DB | `backend/schema.sql` | `db_migrations.py` `repo/gen_requests.py` `repo/generations.py` `repo/trash.py` | `repo/_common.py` `repo/gen_requests.py` `repo/generations.py` `repo/mcp_v2.py` `repo/trash.py` `services/operational_health.py` |
| `gen_tag` | content DB | `backend/schema.sql` | `backend/cleanup_orphan_creators.py` `repo/generation_delete.py` `repo/tags.py` | `repo/facets.py` `repo/generation_rows.py` `repo/generations.py` `repo/generations_query.py` `repo/id_resolve.py` `repo/share.py` `repo/sources.py` `repo/tags.py` `repo/trash.py` |
| `gen_tag_overlay` | content DB | `backend/schema.sql` `repo/id_resolve.py` | `repo/id_resolve.py` `repo/tags.py` | `repo/facets.py` `repo/id_resolve.py` |
| `generation` | content DB | `backend/schema.sql` | `backend/cleanup_orphan_creators.py` `db_migrations.py` `repo/gen_requests.py` `repo/generation_delete.py` `repo/generation_sync.py` `repo/generations.py` `repo/identity.py` `repo/projects.py` `repo/share.py` `repo/share_state_intents.py` `repo/trash.py` `repo/workspace_assignments.py` `schema_compat.py` | `backend/cleanup_orphan_creators.py` `db_account_dbs.py` `db_migrations.py` `repo/_common.py` `repo/asset_registry.py` `repo/asset_sync.py` `repo/facets.py` `repo/folder_cover.py` `repo/gen_requests.py` `repo/generation_rows.py` `repo/generation_sync.py` `repo/generation_views.py` `repo/generations.py` `repo/generations_query.py` `repo/history.py` `repo/id_resolve.py` `repo/identity.py` `repo/lineage.py` `repo/manage.py` `repo/manage_analytics.py` `repo/manage_schema.py` `repo/manage_task_activity.py` `repo/manage_task_previews.py` `repo/manage_tasks.py` `repo/manage_telemetry.py` `repo/manage_transactions.py` `repo/mcp_v2.py` `repo/media_preservation.py` `repo/projects.py` `repo/result_fingerprint.py` `repo/scene_cards.py` `repo/share.py` `repo/share_commands.py` `repo/share_state_intents.py` `repo/sources.py` `repo/tags.py` `repo/trash.py` `repo/workspace_assignments.py` `services/operational_health.py` `services/trash_transfer.py` |
| `generation_comment` | content DB | `backend/schema.sql` | `backend/cleanup_orphan_creators.py` `repo/assets.py` `repo/generation_delete.py` `repo/share.py` | `backend/cleanup_orphan_creators.py` `db_migrations.py` `repo/_common.py` `repo/assets.py` `repo/generation_delete.py` `repo/generation_rows.py` `repo/generations_query.py` `repo/manage_tasks.py` `repo/share.py` `repo/trash.py` |
| `generation_comment_read` | content DB | `backend/schema.sql` | `backend/cleanup_orphan_creators.py` `repo/assets.py` `repo/generation_delete.py` | `db_migrations.py` `repo/trash.py` |
| `generation_comment_seen` | content DB | `backend/schema.sql` | `backend/cleanup_orphan_creators.py` `db_migrations.py` `repo/assets.py` `repo/generation_delete.py` | `db_migrations.py` `repo/_common.py` `repo/trash.py` |
| `generation_event` | content DB | `backend/schema.sql` | `backend/schema.sql` `repo/event_journal.py` | `repo/event_journal.py` `services/operational_health.py` |
| `generation_fts` | content DB | `db_migrations.py` | `db_migrations.py` | `repo/generations_query.py` |
| `generation_local_flag` | content DB | `backend/schema.sql` `db_migrations.py` | `repo/generation_sync.py` | `repo/generation_rows.py` |
| `generation_metrics` | content DB | `repo/manage_schema.py` | `repo/manage.py` `repo/manage_schema.py` `repo/manage_transactions.py` | `repo/generations_query.py` `repo/manage_analytics.py` `repo/manage_tasks.py` `repo/manage_telemetry.py` `repo/manage_transactions.py` `repo/trash.py` |
| `generation_transfer` | content / trash DB (B1 transfer) | `services/trash_transfer.py` | `services/trash_transfer.py` | `repo/trash.py` `services/trash_transfer.py` |
| `generation_view` | content DB | `backend/schema.sql` `db_migrations.py` | `repo/generation_views.py` | `repo/generation_views.py` |
| `history` | content DB | `backend/schema.sql` | `backend/cleanup_orphan_creators.py` `repo/generation_delete.py` `repo/lineage.py` `repo/share.py` | `repo/gen_requests.py` `repo/generation_rows.py` `repo/generations_query.py` `repo/history.py` `repo/lineage.py` `repo/share.py` `repo/trash.py` |
| `history_import_audit` | content DB | `backend/schema.sql` | `repo/history_import_audit.py` | `repo/history_import_audit.py` |
| `manage_schema_state` | content DB | `repo/manage_schema.py` | `repo/manage_schema.py` `repo/workspace_console.py` | `repo/console_guard.py` `repo/manage_schema.py` `repo/workspace_console.py` |
| `mcp_canvas_task` | content DB | `backend/schema.sql` | `repo/mcp_v2.py` `repo/scenes_backup.py` | `repo/mcp_v2.py` |
| `mcp_client` | content DB | `backend/schema.sql` | `repo/mcp_v2.py` | `repo/mcp_v2.py` |
| `mcp_generation_plan` | content DB | `backend/schema.sql` | `repo/mcp_v2.py` | `repo/mcp_v2.py` |
| `mcp_reference` | content DB | `backend/schema.sql` | `repo/mcp_v2.py` | `repo/mcp_v2.py` |
| `media_preservation` | content DB | `backend/schema.sql` `db_migrations.py` | `repo/media_preservation.py` `repo/share_state_intents.py` | `repo/generation_rows.py` `repo/media_preservation.py` |
| `meta` | agent_state.db (작업자 PC) | `agent_push.py` | `agent_push.py` | `agent_push.py` |
| `move_operation` | content / trash DB (B1 transfer) | `services/trash_transfer.py` | `services/trash_transfer.py` | `services/trash_transfer.py` |
| `nas_result_file` | content DB | `backend/schema.sql` | `repo/nas_results.py` | `repo/nas_results.py` |
| `nas_result_scan` | content DB | `backend/schema.sql` | `repo/nas_results.py` | `repo/nas_results.py` |
| `project` | content DB | `backend/schema.sql` | `db_migrations.py` `repo/projects.py` | `db_migrations.py` `repo/asset_locations.py` `repo/console_guard.py` `repo/facets.py` `repo/final_moves.py` `repo/generation_rows.py` `repo/generations_query.py` `repo/identity.py` `repo/manage.py` `repo/manage_analytics.py` `repo/manage_credit_plan.py` `repo/manage_member_table.py` `repo/manage_tasks.py` `repo/manage_telemetry.py` `repo/nas_results.py` `repo/project_membership.py` `repo/projects.py` `repo/trash.py` `repo/workspace_assignments.py` `repo/workspace_console.py` `services/asset_destination.py` `services/asset_registry.py` `services/asset_sync.py` |
| `project_folder_link` | content DB | `repo/manage_schema.py` | `repo/manage.py` | `repo/manage.py` `repo/nas_results.py` `routers/assets.py` `services/asset_destination.py` |
| `project_member` | content DB | `backend/schema.sql` | `repo/identity.py` `repo/project_membership.py` `repo/projects.py` | `db_migrations.py` `deps.py` `repo/final_moves.py` `repo/identity.py` `repo/manage_member_table.py` `repo/projects.py` `routers/_share_authority.py` `services/asset_destination.py` |
| `project_member_removed` | content DB | `backend/schema.sql` | `db_migrations.py` `repo/project_membership.py` | `repo/identity.py` `repo/project_membership.py` |
| `project_planning` | content DB | `repo/manage_schema.py` | `repo/manage.py` | `repo/manage.py` `repo/manage_credit_plan.py` `repo/manage_member_table.py` `repo/manage_tasks.py` `repo/workspace_console.py` |
| `project_task` | content DB | `repo/manage_schema.py` | `repo/manage_schema.py` `repo/manage_tasks.py` | `repo/manage.py` `repo/manage_schema.py` `repo/manage_task_activity.py` `repo/manage_tasks.py` |
| `reference` | content DB | `backend/schema.sql` | `repo/asset_registry.py` `repo/gen_requests.py` `repo/generation_references.py` `repo/generation_sync.py` `repo/generations.py` | `repo/asset_registry.py` `repo/asset_sync.py` `repo/gen_requests.py` `repo/generation_rows.py` `repo/generations.py` `repo/history.py` `repo/identity.py` `repo/share.py` `repo/trash.py` `routers/assets.py` |
| `release_update_notice` | content DB | `backend/schema.sql` | `repo/release_update_notices.py` | `repo/release_update_notices.py` |
| `release_update_notice_seen` | content DB | `backend/schema.sql` | `repo/release_update_notices.py` | `repo/release_update_notices.py` |
| `scene_backup` | content DB | `backend/schema.sql` | `repo/scenes_backup.py` | `repo/mcp_v2.py` `repo/scenes_backup.py` |
| `scene_card_generation` | content DB | `backend/schema.sql` | `repo/gen_requests.py` `repo/identity.py` `repo/scene_cards.py` | `repo/gen_requests.py` `repo/identity.py` `repo/scene_cards.py` |
| `share` | content DB | `backend/schema.sql` | `backend/cleanup_orphan_creators.py` `db_migrations.py` `repo/generation_delete.py` `repo/share.py` `repo/share_commands.py` `repo/share_state_intents.py` | `backend/cleanup_orphan_creators.py` `db_migrations.py` `repo/_visibility.py` `repo/assets.py` `repo/facets.py` `repo/folder_cover.py` `repo/generation_rows.py` `repo/generations_query.py` `repo/identity.py` `repo/lineage.py` `repo/manage.py` `repo/manage_analytics.py` `repo/manage_task_activity.py` `repo/manage_tasks.py` `repo/manage_telemetry.py` `repo/media_preservation.py` `repo/projects.py` `repo/share.py` `repo/share_commands.py` `repo/sources.py` `repo/trash.py` `repo/workspace_assignments.py` |
| `share_command_receipt` | content DB | `db_share_commands.py` | `repo/share_commands.py` | `repo/share_commands.py` |
| `share_state_intent` | content DB | `backend/schema.sql` `db_migrations.py` | `repo/share_state_intents.py` | `repo/share_state_intents.py` |
| `super_admin_session` | content DB | `backend/schema.sql` | `repo/super_admin_sessions.py` | `repo/super_admin_sessions.py` |
| `tag` | content DB | `backend/schema.sql` | `repo/tags.py` | `repo/facets.py` `repo/generation_rows.py` `repo/generations.py` `repo/generations_query.py` `repo/id_resolve.py` `repo/share.py` `repo/sources.py` `repo/tags.py` `repo/trash.py` |
| `task_assignment` | content DB | `repo/manage_schema.py` | `repo/manage_schema.py` `repo/manage_tasks.py` | `repo/manage_tasks.py` |
| `task_generation` | content DB | `repo/manage_schema.py` | `repo/manage.py` `repo/manage_tasks.py` | `repo/manage_schema.py` `repo/manage_task_activity.py` `repo/manage_tasks.py` |
| `task_planned_creator` | content DB | `repo/manage_schema.py` | — | — |
| `team_generation_fact` | manage_hub.db | `manage_db.py` | `manage_db.py` | `manage_db.py` `repo/manage_quota.py` `services/nas_results.py` |
| `telemetry_delivery_state` | content DB | `repo/manage_schema.py` | `repo/manage_schema.py` `repo/manage_telemetry.py` | `repo/manage_telemetry.py` |
| `telemetry_outbox` | content DB | `repo/manage_schema.py` | `repo/manage_telemetry.py` | `repo/manage_schema.py` `repo/manage_telemetry.py` |
| `tracked_job` | agent_state.db (작업자 PC) | `agent_push.py` | `agent_push.py` | `agent_push.py` |
| `transfer_protocol` | content / trash DB (B1 transfer) | `services/trash_transfer.py` | `services/trash_transfer.py` | `services/trash_transfer.py` |
| `trashed` | trash DB (ATTACH) | `repo/trash.py` | `repo/trash.py` `services/trash_transfer.py` | `repo/trash.py` `services/trash_transfer.py` |
| `txn_scan` | agent_state.db (작업자 PC) | `agent_push.py` | `agent_push.py` | `agent_push.py` |
| `worker` | content DB | `backend/schema.sql` | `db_account_dbs.py` `repo/identity.py` | `repo/_common.py` `repo/assets.py` `repo/facets.py` `repo/share.py` `repo/sources.py` |
| `worker_backup_delivery_state` | worker_backup_state.db | `services/worker_backup.py` | `services/worker_backup.py` | `services/worker_backup.py` |
| `worker_backup_outbox` | worker_backup_state.db | `services/worker_backup.py` | `services/worker_backup.py` | `services/worker_backup.py` |
| `worker_backup_source_state` | worker_backup_state.db | `services/worker_backup.py` | `services/worker_backup.py` | `services/worker_backup.py` |
| `workspace_balance_daily` | content DB | `backend/schema.sql` | `repo/identity.py` | `repo/manage_credit_plan.py` |
| `workspace_console` | content DB | `repo/manage_schema.py` | `repo/workspace_console.py` | `repo/console_guard.py` `repo/identity.py` `repo/manage_member_table.py` `repo/workspace_console.py` |
| `workspace_credit_group` | content DB | `repo/manage_schema.py` | `repo/manage_credit_plan.py` `repo/manage_schema.py` | `repo/manage_credit_plan.py` |
| `workspace_credit_group_member` | content DB | `repo/manage_schema.py` | `repo/manage_credit_plan.py` | `repo/manage_credit_plan.py` `repo/workspace_console.py` |
| `workspace_credit_plan` | content DB | `repo/manage_schema.py` | `repo/manage_credit_plan.py` `repo/workspace_console.py` | `repo/manage.py` `repo/manage_credit_plan.py` `repo/workspace_console.py` |
| `workspace_credit_topup` | content DB | `repo/manage_schema.py` | `repo/manage_credit_plan.py` | `repo/manage_credit_plan.py` `repo/workspace_console.py` |
| `workspace_member` | content DB | `backend/schema.sql` | `db_migrations.py` `repo/identity.py` | `repo/identity.py` `repo/manage_credit_plan.py` `repo/manage_member_table.py` `repo/project_membership.py` `repo/workspace_assignments.py` `repo/workspace_console.py` |
| `workspace_registry` | content DB | `backend/schema.sql` | `db_migrations.py` `repo/identity.py` | `db_migrations.py` `repo/identity.py` `repo/manage_credit_plan.py` `repo/manage_member_table.py` `repo/workspace_assignments.py` `repo/workspace_console.py` |

## 재구축용 임시 테이블

마이그레이션이 `CREATE TABLE x_new` → 복사 → `ALTER TABLE x_new RENAME TO x` 로 쓰고 버리는 이름이다.

| 테이블 | 정의 파일 |
| --- | --- |
| `asset_meta_new` | `db_migrations.py` |
| `auto_tag_new` | `db_migrations.py` |

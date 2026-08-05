from app.mutation_notify import (
    DOMAIN_ASSETS,
    DOMAIN_LIBRARY,
    DOMAIN_MANAGE,
    notification_domains,
    parse_mutation_origin,
    should_notify_mutation,
)


def test_polling_and_estimate_posts_do_not_broadcast_synced():
    paths = (
        "/api/cost",
        "/api/generations/batch",
        "/api/generations/comment-counts",
        "/api/ingest/known-jobs",
        "/api/projects/folder-counts/batch",
    )
    for path in paths:
        assert not should_notify_mutation("POST", path, 200)


def test_non_library_side_effect_posts_do_not_force_library_reload():
    paths = (
        "/api/comfy/parse",
        "/api/comfy/run",
        "/api/assets/reveal",
        "/api/assets/clipboard-copy",
        "/api/agent/sync",
        "/api/agent/reinspect",
        "/api/manage/telemetry/push",
    )
    for path in paths:
        assert not should_notify_mutation("POST", path, 200)


def test_scene_backup_asset_metadata_and_comfy_settings_use_their_own_refresh_channels():
    assert not should_notify_mutation("PUT", "/api/scenes/backup", 200)
    assert not should_notify_mutation("PUT", "/api/comfy/settings", 200)
    assert not should_notify_mutation("PUT", "/api/assets/files/meta", 200)
    assert not should_notify_mutation("POST", "/api/assets/upload", 200)


def test_shared_server_login_and_settings_do_not_reload_library():
    assert notification_domains("POST", "/api/shared-server/login", 200) == ()
    assert notification_domains("POST", "/api/shared-server/logout", 200) == ()
    assert notification_domains("POST", "/api/shared-server/url", 200) == ()


def test_asset_writes_use_only_the_asset_refresh_channel():
    assert notification_domains("PUT", "/api/assets/files/meta", 200) == (DOMAIN_ASSETS,)
    assert notification_domains("POST", "/api/assets/upload", 200) == (DOMAIN_ASSETS,)
    assert notification_domains("POST", "/api/assets/comments/read", 200) == (DOMAIN_ASSETS,)
    assert notification_domains("POST", "/api/assets/reveal", 200) == ()
    assert notification_domains("POST", "/api/assets/clipboard-copy", 200) == ()


def test_manage_writes_use_manage_channel_and_hf_cleanup_also_changes_library():
    assert notification_domains("POST", "/api/manage/telemetry/push", 200) == (DOMAIN_MANAGE,)
    assert notification_domains("PATCH", "/api/manage/tasks/t1", 200) == (DOMAIN_MANAGE,)
    assert notification_domains("POST", "/api/manage/hf-missing-apply", 200) == (
        DOMAIN_LIBRARY,
        DOMAIN_MANAGE,
    )


def test_real_successful_mutation_still_broadcasts_synced():
    assert should_notify_mutation("PUT", "/api/generations/g1/tags", 200)
    assert should_notify_mutation("POST", "/api/gen-requests", 201)
    assert should_notify_mutation("POST", "/api/comfy/save-to-library", 200)
    assert should_notify_mutation("POST", "/api/projects/assign", 200)
    assert notification_domains("POST", "/api/projects/assign", 200) == (DOMAIN_LIBRARY,)


def test_get_and_failed_mutation_do_not_broadcast_synced():
    assert not should_notify_mutation("GET", "/api/generations", 200)
    assert not should_notify_mutation("POST", "/api/gen-requests", 400)
    assert not should_notify_mutation("POST", "/api/gen-requests", 307)


def test_mutation_origin_accepts_only_bounded_safe_identifiers():
    assert parse_mutation_origin("client_a-123", "mutation_b-456") == (
        "client_a-123",
        "mutation_b-456",
    )
    assert parse_mutation_origin(None, "mutation_b-456") is None
    assert parse_mutation_origin("short", "mutation_b-456") is None
    assert parse_mutation_origin("client_a-123", "../invalid") is None

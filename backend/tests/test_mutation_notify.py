from app.main import should_notify_mutation


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
    )
    for path in paths:
        assert not should_notify_mutation("POST", path, 200)


def test_real_successful_mutation_still_broadcasts_synced():
    assert should_notify_mutation("PUT", "/api/generations/g1/tags", 200)
    assert should_notify_mutation("POST", "/api/gen-requests", 201)
    assert should_notify_mutation("POST", "/api/comfy/save-to-library", 200)
    assert should_notify_mutation("POST", "/api/assets/upload", 200)


def test_get_and_failed_mutation_do_not_broadcast_synced():
    assert not should_notify_mutation("GET", "/api/generations", 200)
    assert not should_notify_mutation("POST", "/api/gen-requests", 400)
    assert not should_notify_mutation("POST", "/api/gen-requests", 307)

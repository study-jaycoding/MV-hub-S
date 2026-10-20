"""An explicit team lookup must not resolve an equal local ID first."""
from unittest.mock import patch

import pytest
from fastapi import HTTPException
from starlette.requests import Request

from app.routers import library


def lookup(authority, *, proxy=True, remote_authority="team", shared=True, remote_error=None, malformed=False):
    remote = {"items": {"same": {"id": "same", "shared": shared, "tags": ["team"]}}, "materials": {}}
    if remote_authority is not None:
        remote["authority"] = remote_authority
    request = Request({"type": "http", "method": "POST", "path": "/api/generations/batch", "headers": []})
    with (
        patch.object(library, "_account_uid", return_value="actor"),
        patch.object(library.repo, "get_generations_with_materials", return_value=(
            {"same": {"id": "same", "shared": shared, "tags": ["local"]}}, {"same": []},
        )) as local,
        patch.object(library, "batch_view_member_projects", return_value=None),
        patch.object(library, "can_view_generation_with_member_projects", return_value=True),
        patch.object(library._proxy, "proxying", return_value=proxy),
        patch.object(library._proxy, "proxy_json", return_value=[] if malformed else remote, side_effect=remote_error) as remote_call,
        patch.object(library, "_overlay_personal_meta"),
        patch.object(library, "_prefer_remote_source_urls"),
    ):
        result = library.get_generations_batch(library.GenerationBatchIn(gen_ids=["same"], authority=authority), request)
        return result, local.call_count, remote_call.call_count


def test_team_id_never_resolves_equal_local_row():
    result, local_reads, remote_reads = lookup("team")
    assert result["items"]["same"]["tags"] == ["team"]
    assert result["authority"] == "team"
    assert local_reads == 0 and remote_reads == 1


def test_local_lookup_never_falls_through_to_remote():
    result, local_reads, remote_reads = lookup("local")
    assert result["items"]["same"]["tags"] == ["local"]
    assert result["authority"] == "local"
    assert local_reads == 1 and remote_reads == 0


def test_legacy_lookup_keeps_local_first_behavior():
    result, local_reads, remote_reads = lookup("lookup")
    assert result["items"]["same"]["tags"] == ["local"]
    assert local_reads == 1 and remote_reads == 0


@pytest.mark.parametrize("marker", [None, "local"])
def test_unproven_remote_team_authority_requires_full_query_fallback(marker):
    with pytest.raises(HTTPException) as failure:
        lookup("team", remote_authority=marker)
    assert failure.value.status_code == 409


@pytest.mark.parametrize("proxy", [True, False])
def test_team_lookup_hides_unshared_records(proxy):
    result, _, _ = lookup("team", proxy=proxy, shared=False)
    assert result["items"] == {}
    assert result["missing"] == ["same"]


@pytest.mark.parametrize("status", [400, 404, 405, 422, 501])
def test_old_remote_rejections_signal_safe_full_query_fallback(status):
    with pytest.raises(HTTPException) as failure:
        lookup("team", remote_error=HTTPException(status, "unsupported"))
    assert failure.value.status_code == 409


def test_malformed_remote_answer_is_not_confirmed_missing():
    with pytest.raises(HTTPException) as failure:
        lookup("team", malformed=True)
    assert failure.value.status_code == 502


def test_team_authority_does_not_hide_permission_failure():
    with pytest.raises(HTTPException) as failure:
        lookup("team", remote_error=HTTPException(403, "forbidden"))
    assert failure.value.status_code == 403

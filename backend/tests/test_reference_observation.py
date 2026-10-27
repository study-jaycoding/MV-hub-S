"""제출 지문과 CLI 원본 반환 배열의 독립 대조. 생성 성공/실패 판정과 분리한다."""

import pytest
import json

from app import db, repo
from app.repo.gen_requests import _reference_delivery_check, record_reference_observation, _safe_submitted_refs


def submitted(*ids):
    return [{"position": i, "type": "image", "role": "image", "upload_id": value}
            for i, value in enumerate(ids)]


def job(*ids):
    return {"id": "job", "params": {"medias": [
        {"role": "image", "data": {"id": value, "url": "https://cdn.example/private?token=secret"}}
        for value in ids
    ]}}


@pytest.mark.parametrize("expected,actual,status", [
    (("a", "b"), ("a", "b"), "matched"),
    (("a", "b"), ("b", "a"), "returned_order_difference"),
    (("a", "b"), ("a",), "missing"),
    (("a", "b"), ("a", "c"), "different_file"),
    (("a", "b"), ("a", "a"), "duplicate"),
    (("a", "a"), ("a", "a"), "matched"),
    (("a",), (), "missing"),
])
def test_identity_and_raw_returned_order(expected, actual, status):
    result = _reference_delivery_check(submitted(*expected), job(*actual))
    assert result["status"] == status
    assert [ref.get("upload_id") for ref in result["observed_refs"]] == list(actual)
    assert "private" not in str(result) and "secret" not in str(result)


@pytest.mark.parametrize("payload", [{}, {"params": {}}, {"params": {"medias": None}}])
def test_missing_response_schema_is_unverifiable(payload):
    assert _reference_delivery_check(submitted("a"), payload)["status"] == "unverifiable"


def test_same_count_does_not_prove_local_file_identity():
    local = [{"position": 0, "type": "image", "role": "image", "sha256": "a" * 64}]
    assert _reference_delivery_check(local, job("remote-id"))["status"] == "unverifiable"


def test_role_difference_does_not_get_hidden_by_same_ids():
    payload = job("a")
    payload["params"]["medias"][0]["role"] = "end_image"
    assert _reference_delivery_check(submitted("a"), payload)["status"] == "role_difference"


def test_returned_hash_proves_identity_without_an_upload_id():
    sha = "a" * 64
    local = [{"position": 0, "type": "image", "role": "image", "sha256": sha}]
    raw = {"params": {"input_images": [{"sha256": sha}]}}
    assert _reference_delivery_check(local, raw)["status"] == "matched"
    raw["params"]["input_images"][0]["sha256"] = "b" * 64
    assert _reference_delivery_check(local, raw)["status"] == "different_file"


def test_same_upload_with_conflicting_digest_is_not_accepted():
    source = [{**submitted("a")[0], "sha256": "a" * 64}]
    raw = job("a")
    raw["params"]["medias"][0]["data"]["sha256"] = "b" * 64
    assert _reference_delivery_check(source, raw)["status"] == "different_file"


def test_unknown_role_is_not_reported_as_proven_difference():
    raw = job("a")
    raw["params"]["medias"][0].pop("role")
    assert _reference_delivery_check(submitted("a"), raw)["status"] == "unverifiable"


def test_submitted_information_drops_paths_and_arbitrary_secret_fields():
    clean = _safe_submitted_refs([{**submitted("a")[0], "file_path": "private.png", "token": "secret",
                                  "source_url": "https://cdn.test?token=secret", "sha256": "a" * 64}])
    assert clean == [{**submitted("a")[0], "sha256": "a" * 64}]


@pytest.fixture
def observation_db(tmp_path, monkeypatch):
    monkeypatch.setenv("CONTENT_HUB_DB", str(tmp_path / "content.db"))
    db.flush_pool()
    db.init_db()
    repo.ensure_default_worker()
    fingerprint = {"params": {"quality": "high"}, "submitted_refs": submitted("a", "b"),
                   "reference_roles": ["image", "image"], "legacy": "preserve"}
    gen_id = repo.create_local_generation({"model": "model", "prompt": "test"}, "me")
    rid = repo.create_gen_request("artist@example.com", "artist", gen_id, "create", {})
    with db.get_connection() as conn:
        conn.execute("UPDATE generation SET job_id='job' WHERE id=?", (gen_id,))
        conn.execute("UPDATE gen_request SET submission_fingerprint=? WHERE id=?", (json.dumps(fingerprint), rid))
    yield rid, fingerprint
    db.flush_pool()


def test_observation_storage_is_scoped_idempotent_and_keeps_submission(observation_db):
    rid, original = observation_db
    assert record_reference_observation(rid, job("a", "b"), account_email="other@example.com")["changed"] is False
    result = record_reference_observation(rid, job("a", "b"), account_email="artist@example.com")
    assert result == {"changed": True, "status": "matched"}
    assert record_reference_observation(rid, job("a", "b"), account_email="artist@example.com") == {"changed": False, "status": "matched"}
    stored = json.loads(repo.get_gen_request(rid)["submission_fingerprint"])
    assert {key: value for key, value in stored.items() if key != "delivery_check"} == original
    assert "private" not in str(stored) and "secret" not in str(stored)
    foreign = {**job("b", "a"), "id": "other-job"}
    assert not record_reference_observation(rid, foreign, account_email="artist@example.com")["changed"]
    assert json.loads(repo.get_gen_request(rid)["submission_fingerprint"]) == stored


def test_old_agent_default_empty_refs_are_not_zero_input_proof(observation_db):
    rid, original = observation_db
    with db.get_connection() as conn:
        conn.execute("UPDATE gen_request SET submission_fingerprint=? WHERE id=?",
                     (json.dumps({**original, "submitted_refs": []}), rid))
    assert record_reference_observation(rid, job(), account_email="artist@example.com")["status"] == "unverifiable"

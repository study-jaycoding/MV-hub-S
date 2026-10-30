"""Canvas admission/completion/recovery with real SQLite and a fake provider."""
import json
from concurrent.futures import ThreadPoolExecutor
from uuid import uuid4

import pytest
from fastapi import HTTPException

from app import active_account, db, repo
from app.repo import comfy_canvas_runs as runs
from app.routers import comfy
from app.services import comfy_run_journal as journal
from test_comfy_run_journal import h  # noqa: F401


def descriptor(**changes):
    return {"attempt_id": str(uuid4()), "run_group_id": str(uuid4()), "group_seq": 1,
            "copy_index": 0, "scene_id": "scene", "card_id": "card",
            "config_fp": "config", "input_fp": "input", **changes}


def start(h, attempt, **changes):
    values = dict(request=h.request(), content='{"1":{"class_type":"SaveImage","inputs":{}}}',
                  param_values="{}", media_meta="[]", media=[], canvas_run=json.dumps(attempt),
                  save_meta='{"name":"test workflow"}')
    values.update(changes)
    return comfy.run(**values)["job_id"]


def resolve(h, attempt):
    return comfy.resolve_canvas_runs(comfy.CanvasResolveReq(attempt_ids=[attempt["attempt_id"]]), h.request())["runs"][0]


def restart(h):
    h.starts.clear()
    comfy._RUN_JOBS.clear()
    journal._JOURNAL_BOOTSTRAPPED.clear()


def test_attempt_record_precedes_thread_and_lost_response_returns_original_job(h):
    attempt = descriptor()
    job = start(h, attempt)
    assert runs.get(attempt["attempt_id"])["job_id"] == job
    assert resolve(h, attempt)["state"] == "accepted"
    restart(h)
    assert resolve(h, attempt)["state"] == "unknown"
    assert start(h, attempt) == job
    assert not h.starts
    h.mocks["submit"].assert_not_called()


def test_concurrent_attempt_starts_only_one_job(h):
    attempt = descriptor()
    with ThreadPoolExecutor(max_workers=2) as pool:
        jobs = list(pool.map(lambda _: start(h, attempt), range(2)))
    assert jobs[0] == jobs[1]
    assert len(h.starts) == 1


@pytest.mark.parametrize("change", [{"param_values": '{"seed":2}'}, {"save_meta": '{"name":"changed"}'}, {"project_id": "other"}])
def test_same_attempt_different_request_is_conflict(h, change):
    attempt = descriptor()
    start(h, attempt)
    with pytest.raises(HTTPException) as error:
        start(h, attempt, **change)
    assert error.value.status_code == 409
    assert len(h.starts) == 1


def test_mixed_outputs_saved_without_browser_and_ack_is_idempotent(h):
    entry = h.successful(2)
    entry["outputs"]["2"] = {"text": ["preserved text"]}
    attempt = descriptor()
    job = start(h, attempt)
    h.drain()
    result = resolve(h, attempt)
    assert result["state"] == "saved"
    assert len(result["outputs"]) == 3
    assert len([out for out in result["outputs"] if out.get("generation_id")]) == 2
    assert h.rows() == []
    assert comfy.run_status(job, h.request())["result_revision"] == result["result_revision"]
    ack = comfy.CanvasAckReq(attempt_id=attempt["attempt_id"], result_revision=result["result_revision"], disposition="attached")
    first = comfy.ack_canvas_run(ack, h.request())
    assert first == comfy.ack_canvas_run(ack, h.request())
    assert first["state"] == "linked"
    restart(h)
    assert resolve(h, attempt) == first
    assert start(h, attempt) == job
    assert not h.starts


@pytest.mark.parametrize("disposition", ["attached", "superseded", "card_missing"])
def test_text_only_receipt_and_revision_guard(h, disposition):
    entry = h.successful(0)
    entry["outputs"]["1"] = {"text": ["only text"]}
    attempt = descriptor()
    start(h, attempt)
    h.drain()
    result = resolve(h, attempt)
    assert result["state"] == "saved" and result["outputs"][0]["text"] == "only text"
    assert not h.rows()
    with pytest.raises(HTTPException) as error:
        comfy.ack_canvas_run(comfy.CanvasAckReq(attempt_id=attempt["attempt_id"], result_revision=result["result_revision"] - 1, disposition=disposition), h.request())
    assert error.value.status_code == 409
    assert comfy.ack_canvas_run(comfy.CanvasAckReq(attempt_id=attempt["attempt_id"], result_revision=result["result_revision"], disposition=disposition), h.request())["state"] == "linked"


def test_second_download_failure_keeps_text_and_resumes_original_attempt(h):
    entry = h.successful(2)
    entry["outputs"]["2"] = {"text": ["text before media"]}
    good = h.mocks["download_view"].side_effect

    def partial(target, item, dst, **kwargs):
        if item["filename"].endswith("1.png"):
            raise comfy.comfy_client.ComfyError("synthetic failure", status_code=403)
        good(target, item, dst, **kwargs)

    h.mocks["download_view"].side_effect = partial
    attempt = descriptor()
    job = start(h, attempt)
    h.drain()
    first = resolve(h, attempt)
    assert first["state"] == "needs_collect"
    assert any(out.get("text") == "text before media" for out in first["outputs"])
    saved_id = next(out["generation_id"] for out in first["outputs"] if out.get("generation_id"))
    restart(h)
    h.mocks["download_view"].side_effect = good
    collect = comfy.collect_unresolved_run(job, h.request())["job_id"]
    assert collect != job
    h.drain()
    result = resolve(h, attempt)
    assert result["state"] == "saved"
    assert saved_id in [out.get("generation_id") for out in result["outputs"]]
    with db.get_connection() as conn:
        assert conn.execute("SELECT COUNT(*) FROM generation WHERE generator='comfy'").fetchone()[0] == 2
    assert runs.get(attempt["attempt_id"])["job_id"] == job
    assert h.mocks["submit"].call_count == 1


def test_unavailable_stays_unresolved_until_dismiss(h):
    h.successful(1)
    h.mocks["download_view"].side_effect = comfy.comfy_client.ComfyError("gone", status_code=410)
    attempt = descriptor()
    job = start(h, attempt)
    h.drain()
    assert resolve(h, attempt)["state"] == "needs_collect"
    assert h.rows()
    comfy.dismiss_unresolved_runs(comfy.DismissRunsReq(job_ids=[job], acknowledged=True), h.request())
    assert resolve(h, attempt)["state"] == "dismissed"
    assert not h.rows()


def test_ack_pending_does_not_consume_journal_capacity(h, monkeypatch):
    monkeypatch.setattr(journal, "CAP", 1)
    h.successful()
    first = descriptor()
    start(h, first)
    h.drain()
    assert resolve(h, first)["state"] == "saved"
    second = descriptor()
    start(h, second)
    h.drain()
    assert resolve(h, second)["state"] == "saved"


def test_other_account_or_device_cannot_resolve_or_ack(h, monkeypatch):
    h.successful()
    attempt = descriptor()
    start(h, attempt)
    h.drain()
    result = resolve(h, attempt)
    h.device["device_id"] = "2" * 32
    assert resolve(h, attempt)["state"] == "origin_mismatch"
    with pytest.raises(HTTPException):
        comfy.ack_canvas_run(comfy.CanvasAckReq(attempt_id=attempt["attempt_id"], result_revision=result["result_revision"], disposition="attached"), h.request())
    monkeypatch.setattr(active_account, "_cache", [True, {"email": "b@example.invalid", "uid": None}])
    assert resolve(h, attempt)["state"] == "not_found"


def test_generation_commit_then_journal_ack_failure_reconciles_without_duplicate(h, monkeypatch):
    h.successful()
    original = repo.set_setting

    def fail_ack(key, value):
        if key == journal.KEY and json.loads(value)["runs"] == []:
            raise OSError("synthetic ack failure")
        return original(key, value)

    attempt = descriptor()
    start(h, attempt)
    monkeypatch.setattr(repo, "set_setting", fail_ack)
    h.drain()
    assert runs.get(attempt["attempt_id"])["state"] == "saved"
    assert h.rows()
    monkeypatch.setattr(repo, "set_setting", original)
    restart(h)
    assert resolve(h, attempt)["state"] == "saved"
    assert not h.rows()
    with db.get_connection() as conn:
        assert conn.execute("SELECT COUNT(*) FROM generation WHERE generator='comfy'").fetchone()[0] == 1


def test_deleted_generation_is_not_recreated_by_resave(h):
    h.successful()
    attempt = descriptor()
    start(h, attempt)
    h.drain()
    output = resolve(h, attempt)["outputs"][0]
    with db.get_connection() as conn:
        conn.execute("DELETE FROM asset WHERE generation_id=?", (output["generation_id"],))
        conn.execute("DELETE FROM generation WHERE id=?", (output["generation_id"],))
    url = "/media/" + output["output_key"]
    body = comfy.SaveToLibraryReq(outputs=[comfy.ComfyOutputItem(url=url, kind="image")])
    assert comfy.save_to_library(body, h.request())["saved"][0]["generation_id"] == output["generation_id"]
    assert resolve(h, attempt)["outputs"][0]["state"] == "deleted"
    with db.get_connection() as conn:
        assert conn.execute("SELECT COUNT(*) FROM generation WHERE generator='comfy'").fetchone()[0] == 0


def test_failed_second_save_resumes_locally_without_provider(h, monkeypatch):
    h.successful(2)
    original = repo.create_comfy_generation

    def fail_second(**kwargs):
        with db.get_connection() as conn:
            count = conn.execute("SELECT COUNT(*) FROM generation WHERE generator='comfy'").fetchone()[0]
        if count:
            raise RuntimeError("synthetic second save failure")
        return original(**kwargs)

    monkeypatch.setattr(repo, "create_comfy_generation", fail_second)
    attempt = descriptor()
    start(h, attempt)
    h.drain()
    first = resolve(h, attempt)
    assert first["state"] == "needs_collect"
    assert sum(bool(out.get("generation_id")) for out in first["outputs"]) == 1
    restart(h)
    monkeypatch.setattr(repo, "create_comfy_generation", original)
    before = {key: mock.call_count for key, mock in h.mocks.items()}
    pending = comfy.list_unresolved_runs(h.request())["runs"][0]
    assert pending["can_resave"]
    body = comfy.SaveToLibraryReq(outputs=[comfy.ComfyOutputItem(url=out["url"], kind=out["kind"])
                                           for out in pending["outputs"] if out["downloaded"] and not out["acked"]])
    comfy.save_to_library(body, h.request())
    assert resolve(h, attempt)["state"] == "saved"
    assert before == {key: mock.call_count for key, mock in h.mocks.items()}
    assert not h.rows()


def test_text_is_durable_before_first_download_and_output_write_failure_stops_download(h, monkeypatch):
    entry = h.successful()
    entry["outputs"]["2"] = {"text": ["durable before media"]}
    attempt = descriptor()
    original_download = h.mocks["download_view"].side_effect

    def check(target, item, dst, **kwargs):
        row = runs.get(attempt["attempt_id"])
        assert row["outputs_enumerated"]
        assert any(out.get("text") == "durable before media" for out in row["outputs"])
        original_download(target, item, dst, **kwargs)

    h.mocks["download_view"].side_effect = check
    start(h, attempt)
    h.drain()
    assert resolve(h, attempt)["state"] == "saved"
    h.mocks["download_view"].reset_mock()
    second = descriptor()
    start(h, second)
    original_record = runs.record_outputs

    def fail_outputs(*_args, **_kwargs):
        raise OSError("synthetic disk failure")

    monkeypatch.setattr(runs, "record_outputs", fail_outputs)
    h.drain()
    h.mocks["download_view"].assert_not_called()
    monkeypatch.setattr(runs, "record_outputs", original_record)
    assert resolve(h, second)["state"] == "needs_collect"


def test_unknown_without_journal_can_be_dismissed(h):
    attempt = descriptor()
    job = start(h, attempt)
    restart(h)
    listed = comfy.list_unresolved_runs(h.request())["runs"]
    assert listed[0]["job_id"] == job and listed[0]["can_dismiss"]
    req = comfy.DismissRunsReq(job_ids=[job], acknowledged=True)
    comfy.dismiss_unresolved_runs(req, h.request())
    assert resolve(h, attempt)["state"] == "dismissed"
    assert comfy.dismiss_unresolved_runs(req, h.request()) == {"dismissed": 1}


def test_http_contract_accepts_multipart_and_returns_fixed_receipt_shape(h):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    app = FastAPI()
    app.include_router(comfy.router)
    h.successful()
    attempt = descriptor()
    with TestClient(app) as client:
        started = client.post("/api/comfy/run", data={"content": '{"1":{"class_type":"SaveImage","inputs":{}}}',
                              "canvas_run": json.dumps(attempt), "save_meta": '{"name":"HTTP"}'})
        assert started.status_code == 200, started.text
        h.drain()
        resolved = client.post("/api/comfy/canvas-runs/resolve", json={"attempt_ids": [attempt["attempt_id"]]}).json()["runs"][0]
        assert set(resolved) == {"attempt_id", "state", "result_revision", "outputs", "origin"}
        assert set(resolved["outputs"][0]) == {"output_key", "kind", "generation_id", "state"}
        ack = client.post("/api/comfy/canvas-runs/ack", json={"attempt_id": attempt["attempt_id"],
                          "result_revision": resolved["result_revision"], "disposition": "superseded"})
        assert ack.status_code == 200 and ack.json()["state"] == "linked"


def test_detail_missing_keeps_unreceived_output_and_preserved_text(h):
    entry = h.successful()
    entry["outputs"]["2"] = {"text": ["kept text"]}
    h.mocks["download_view"].side_effect = comfy.comfy_client.ComfyError("gone", status_code=410)
    attempt = descriptor()
    job = start(h, attempt)
    h.drain()
    restart(h)
    h.mocks["cloud_job_detail"].side_effect = comfy.comfy_client.ComfyError("missing detail", status_code=404)
    comfy.collect_unresolved_run(job, h.request())
    h.drain()
    result = resolve(h, attempt)
    assert result["state"] == "needs_collect"
    assert any(out["state"] == "unavailable" for out in result["outputs"])
    assert any(out.get("text") == "kept text" for out in result["outputs"])
    assert h.rows() and h.mocks["submit"].call_count == 1

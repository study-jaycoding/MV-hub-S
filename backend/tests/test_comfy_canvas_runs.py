"""Canvas admission/completion/recovery with real SQLite and a fake provider."""
import json
from contextlib import contextmanager
from concurrent.futures import ThreadPoolExecutor
from types import SimpleNamespace
from unittest.mock import Mock
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


@pytest.mark.parametrize("cause", ["scheme", "dns", "connect_refused", "tls_cert", "remote_failure"])
def test_confirmed_failure_releases_journal_before_browser_ack(h, monkeypatch, cause):
    monkeypatch.setattr(journal, "CAP", 1)
    for _ in range(3):
        h.successful()
        if cause == "remote_failure":
            h.mocks["cloud_job_status"].return_value = "failed"
        else:
            h.mocks["submit"].side_effect = comfy.comfy_client.ComfyError("synthetic", cause_kind=cause)
        attempt = descriptor()
        start(h, attempt)
        h.drain()
        assert runs.get(attempt["attempt_id"])["state"] == "failed"
        assert not h.rows()
        result = resolve(h, attempt)
        ack = comfy.CanvasAckReq(attempt_id=attempt["attempt_id"], result_revision=result["result_revision"], disposition="attached")
        assert comfy.ack_canvas_run(ack, h.request())["state"] == "linked"
        assert comfy.ack_canvas_run(ack, h.request())["state"] == "linked"
    h.successful()
    h.start()  # The legacy admission path also has its capacity back.
    h.drain()
    assert h.mocks["submit"].call_count == 4


def test_unknown_submission_retains_journal_and_capacity_limit(h, monkeypatch):
    monkeypatch.setattr(journal, "CAP", 1)
    h.mocks["submit"].side_effect = comfy.comfy_client.ComfyError("lost response", cause_kind="timeout")
    attempt = descriptor()
    start(h, attempt)
    h.drain()
    assert resolve(h, attempt)["state"] == "unknown"
    assert len(h.rows()) == 1
    second = descriptor()
    start(h, second)
    h.drain()
    assert resolve(h, second)["state"] == "failed"
    assert len(h.rows()) == 1
    assert h.mocks["submit"].call_count == 1


def test_enumerated_empty_success_is_failed_and_releases_journal(h):
    h.successful(0)
    attempt = descriptor()
    start(h, attempt)
    h.drain()
    result = resolve(h, attempt)
    assert result["state"] == "failed"
    assert result["outputs"] == []
    assert not h.rows()
    assert comfy.ack_canvas_run(comfy.CanvasAckReq(attempt_id=attempt["attempt_id"],
        result_revision=result["result_revision"], disposition="attached"), h.request())["state"] == "linked"


def test_restart_retries_failed_journal_cleanup_without_reading_secrets(h, monkeypatch):
    h.mocks["submit"].side_effect = comfy.comfy_client.ComfyError("refused", cause_kind="connect_refused")
    attempt = descriptor()
    start(h, attempt)
    with monkeypatch.context() as patch:
        patch.setattr(comfy, "_ack_canvas_journal", lambda *_: None)
        h.drain()
    assert h.rows()
    restart(h)
    with monkeypatch.context() as patch:
        patch.setattr(comfy, "_raw_settings", lambda: pytest.fail("local reconciliation must not read keys"))
        comfy.recover_interrupted_run_jobs()
    assert not h.rows()
    assert resolve(h, attempt)["state"] == "failed"


@pytest.mark.parametrize("outcome", ["saved", "needs_collect", "unknown", "failed", "empty"])
def test_unchanged_reconciliation_does_not_acquire_sql_write_lock(h, monkeypatch, outcome):
    h.successful(0 if outcome == "empty" else 1)
    if outcome == "needs_collect":
        h.mocks["download_view"].side_effect = comfy.comfy_client.ComfyError("gone", status_code=410)
    elif outcome in ("unknown", "failed"):
        h.mocks["submit"].side_effect = comfy.comfy_client.ComfyError("synthetic", cause_kind="timeout" if outcome == "unknown" else "connect_refused")
    attempt = descriptor()
    start(h, attempt)
    h.drain()
    before = resolve(h, attempt)
    statements = []
    original = runs.get_connection

    @contextmanager
    def traced():
        with original() as conn:
            conn.set_trace_callback(statements.append)
            try:
                yield conn
            finally:
                conn.set_trace_callback(None)

    monkeypatch.setattr(runs, "get_connection", traced)
    assert resolve(h, attempt) == before
    assert not [sql for sql in statements if sql.upper().startswith(("BEGIN IMMEDIATE", "UPDATE", "INSERT", "DELETE"))]


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
        assert set(resolved["outputs"][0]) == {"output_key", "kind", "generation_id", "state", "url"}
        assert resolved["outputs"][0]["url"] == "/media/" + resolved["outputs"][0]["output_key"]
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


def _answer(mock, value):
    mock.side_effect = value if isinstance(value, Exception) else None
    mock.return_value = value


MISSING_DETAILS = [comfy.comfy_client.ComfyError("missing detail", status_code=404),
                   comfy.comfy_client.ComfyError("gone", status_code=410),
                   None, {}, {"status": "done"}, {"outputs": None}, {"outputs": []}]


def _lost_first_detail(h):
    """원격은 성공했는데 첫 상세 조회가 실패해 출력 목록을 못 남긴 실행."""
    entry = h.successful()
    h.mocks["cloud_job_detail"].side_effect = comfy.comfy_client.ComfyError("gone", status_code=410)
    return entry


@pytest.mark.parametrize("missing", MISSING_DETAILS)
def test_missing_detail_before_any_listing_stays_collectable(h, missing):
    entry = _lost_first_detail(h)
    attempt = descriptor()
    job = start(h, attempt)
    h.drain()
    restart(h)
    _answer(h.mocks["cloud_job_detail"], missing)
    comfy.collect_unresolved_run(job, h.request())
    h.drain()
    assert resolve(h, attempt)["state"] == "needs_collect"
    row = next(item for item in h.rows() if item["job_id"] == job)
    assert row["prompt_id"] and not row.get("outputs_enumerated") and row["last_error_class"] == "detail_failed"
    restart(h)
    _answer(h.mocks["cloud_job_detail"], entry)
    comfy.collect_unresolved_run(job, h.request())
    h.drain()
    assert resolve(h, attempt)["state"] == "saved"
    assert h.mocks["submit"].call_count == 1


def test_run_status_keeps_media_urls_for_the_next_node(h):
    """캔버스 실행도 결과의 outputs 는 {kind,url,text} 다 — 뒤 노드가 이 url 로 입력을 만든다. 영수증은 resolve 로 받는다."""
    entry = h.successful(2)
    entry["outputs"]["2"] = {"text": ["next node text"]}
    attempt = descriptor()
    job = start(h, attempt)
    h.drain()
    status = comfy.run_status(job, h.request())
    media = [out for out in status["outputs"] if out["kind"] == "image"]
    assert len(media) == 2 and all(out["url"].startswith("/media/comfy/") for out in media)
    assert {"kind": "text", "text": "next node text"} in status["outputs"]
    resolved = resolve(h, attempt)
    assert status["attempt_id"] == attempt["attempt_id"] and status["state"] == "saved"
    assert status["result_revision"] == resolved["result_revision"] and status["origin"] == resolved["origin"]
    assert all("output_key" in out for out in resolved["outputs"])


SAVE_TEXT = '{"1":{"class_type":"SaveText","inputs":{"file":"out.txt"}}}'


def _stop_before_text_record(h, monkeypatch, attempt):
    """저널에 빈 목록을 남긴 뒤 글자를 기록하기 전에 멈춘 실행."""
    entry = h.successful(0)
    entry["outputs"]["1"] = {"text": ["only in history"]}
    job = start(h, attempt)

    def stop(*_args, **_kwargs):
        raise OSError("synthetic stop")

    with monkeypatch.context() as patch:
        patch.setattr(comfy, "_record_canvas_outputs", stop)
        h.drain()
    restart(h)
    return job, entry


def test_stop_before_text_record_stays_collectable_and_keeps_journal(h, monkeypatch):
    attempt = descriptor()
    job, _ = _stop_before_text_record(h, monkeypatch, attempt)
    assert resolve(h, attempt)["state"] == "needs_collect"
    row = next(item for item in h.rows() if item["job_id"] == job)
    assert row["outputs_enumerated"] and row["prompt_id"] and not row["outputs"]
    comfy.collect_unresolved_run(job, h.request())
    h.drain()
    result = resolve(h, attempt)
    assert result["state"] == "saved" and result["outputs"][0]["text"] == "only in history"
    assert h.mocks["submit"].call_count == 1


def test_detail_gone_after_stop_before_text_record_does_not_confirm_empty(h, monkeypatch):
    attempt = descriptor()
    job, entry = _stop_before_text_record(h, monkeypatch, attempt)
    restart(h)
    _answer(h.mocks["cloud_job_detail"], comfy.comfy_client.ComfyError("missing detail", status_code=404))
    comfy.collect_unresolved_run(job, h.request())
    h.drain()
    assert resolve(h, attempt)["state"] == "needs_collect"
    assert any(item["job_id"] == job for item in h.rows())


def test_journal_with_media_still_moves_to_canvas_record(h, monkeypatch):
    h.successful()
    attempt = descriptor()
    start(h, attempt)

    def fail_outputs(*_args, **_kwargs):
        raise OSError("synthetic disk failure")

    with monkeypatch.context() as patch:
        patch.setattr(runs, "record_outputs", fail_outputs)
        h.drain()
    restart(h)
    result = resolve(h, attempt)
    assert result["state"] == "needs_collect" and [out["kind"] for out in result["outputs"]] == ["image"]


@pytest.mark.parametrize("failure", [comfy.comfy_client.ComfyError("busy", status_code=503), OSError("synthetic stop")])
def test_saved_text_read_failure_is_not_empty_and_collect_reads_it_again(h, monkeypatch, failure):
    h.successful(0)
    view = Mock(side_effect=failure)
    monkeypatch.setattr(comfy.comfy_client, "view_bytes", view)
    attempt = descriptor()
    job = start(h, attempt, content=SAVE_TEXT)
    h.drain()
    assert resolve(h, attempt)["state"] == "needs_collect"
    assert any(item["job_id"] == job for item in h.rows())
    restart(h)
    view.side_effect = None
    view.return_value = b"from file"
    comfy.collect_unresolved_run(job, h.request())
    h.drain()
    result = resolve(h, attempt)
    assert result["state"] == "saved" and result["outputs"][0]["text"] == "from file"
    assert h.mocks["submit"].call_count == 1


@pytest.mark.parametrize("status", [404, 410])
def test_saved_text_file_gone_with_nothing_else_is_failed(h, monkeypatch, status):
    h.successful(0)
    monkeypatch.setattr(comfy.comfy_client, "view_bytes", Mock(side_effect=comfy.comfy_client.ComfyError("gone", status_code=status)))
    attempt = descriptor()
    start(h, attempt, content=SAVE_TEXT)
    h.drain()
    assert resolve(h, attempt)["state"] == "failed"
    assert not h.rows()


IMAGE_AND_TEXT = '{"1":{"class_type":"SaveImage","inputs":{}},"2":{"class_type":"SaveText","inputs":{"file":"out.txt"}}}'
TWO_TEXTS = '{"1":{"class_type":"SaveText","inputs":{"file":"a.txt"}},"2":{"class_type":"SaveText","inputs":{"file":"b.txt"}}}'


def _listed(h, job):
    return next(item for item in comfy.list_unresolved_runs(h.request())["runs"] if item["job_id"] == job)


def _of(result, kind):
    return [out for out in result["outputs"] if out["kind"] == kind]


@pytest.mark.parametrize("failure", [
    comfy.comfy_client.ComfyError("busy", status_code=503),
    comfy.comfy_client.ComfyError("cut off", cause_kind="tls_cert"),
    comfy.comfy_client.ComfyError("denied", True, status_code=401),
])
def test_media_with_unread_text_stays_collectable_and_collect_finishes_it(h, monkeypatch, failure):
    h.successful()
    view = Mock(side_effect=failure)
    monkeypatch.setattr(comfy.comfy_client, "view_bytes", view)
    attempt = descriptor()
    job = start(h, attempt, content=IMAGE_AND_TEXT)
    h.drain()
    with pytest.raises(HTTPException):
        comfy.run_status(job, h.request())  # 일부만 받은 결과로 뒤 노드가 돌지 않는다
    result = resolve(h, attempt)
    assert result["state"] == "needs_collect"
    image = _of(result, "image")[0]
    assert image["state"] == "saved" and image["generation_id"] and image["url"].startswith("/media/comfy/")
    row = next(item for item in h.rows() if item["job_id"] == job)
    assert row["phase"] == "result_pending" and row["text_files_unread"]
    assert _listed(h, job)["can_collect"]
    restart(h)
    assert resolve(h, attempt)["state"] == "needs_collect"  # 조정·부팅 복원도 saved 로 바꾸지 않는다
    assert _listed(h, job)["can_collect"]
    view.side_effect = None
    view.return_value = b"from file"
    comfy.collect_unresolved_run(job, h.request())
    h.drain()
    result = resolve(h, attempt)
    assert result["state"] == "saved"
    assert _of(result, "text")[0]["text"] == "from file"
    assert [out["generation_id"] for out in _of(result, "image")] == [image["generation_id"]]  # 미디어를 두 번 저장하지 않는다
    assert h.mocks["submit"].call_count == 1 and not h.rows()


def test_one_unread_file_of_a_text_only_run_survives_restart_and_collect(h, monkeypatch):
    h.successful(0)
    files = {"a.txt": b"first"}

    def view(_target, params):
        if params["filename"] not in files:
            raise comfy.comfy_client.ComfyError("busy", status_code=503)
        return files[params["filename"]]

    monkeypatch.setattr(comfy.comfy_client, "view_bytes", view)
    attempt = descriptor()
    job = start(h, attempt, content=TWO_TEXTS)
    h.drain()
    result = resolve(h, attempt)
    assert result["state"] == "needs_collect" and [out["text"] for out in _of(result, "text")] == ["first"]
    restart(h)
    assert resolve(h, attempt)["state"] == "needs_collect"
    assert _listed(h, job)["can_collect"]  # 부팅 정리가 prompt_id 든 저널을 지우지 않았다
    files["b.txt"] = b"second"
    comfy.collect_unresolved_run(job, h.request())
    h.drain()
    result = resolve(h, attempt)
    assert result["state"] == "saved" and sorted(out["text"] for out in _of(result, "text")) == ["first", "second"]
    assert not h.rows()


def test_collect_without_workflow_does_not_clear_unread_text(h, monkeypatch):
    h.successful()
    monkeypatch.setattr(comfy.comfy_client, "view_bytes", Mock(side_effect=comfy.comfy_client.ComfyError("busy", status_code=503)))
    attempt = descriptor()
    job = start(h, attempt, content=IMAGE_AND_TEXT)
    h.drain()
    state = json.loads(repo.get_setting(journal.KEY))
    next(item for item in state["runs"] if item["job_id"] == job)["execution_snapshot"].pop("workflow")
    repo.set_setting(journal.KEY, json.dumps(state))
    restart(h)
    comfy.collect_unresolved_run(job, h.request())
    h.drain()
    assert resolve(h, attempt)["state"] == "needs_collect"
    row = next(item for item in h.rows() if item["job_id"] == job)
    assert row["text_files_unread"] and row["phase"] == "result_pending"


def test_saved_text_read_is_retried_before_it_counts_as_unread(h, monkeypatch):
    h.successful()
    view = Mock(side_effect=[comfy.comfy_client.ComfyError("busy", status_code=503), b"from file"])
    monkeypatch.setattr(comfy.comfy_client, "view_bytes", view)
    attempt = descriptor()
    job = start(h, attempt, content=IMAGE_AND_TEXT)
    h.drain()
    assert comfy.run_status(job, h.request())["state"] == "saved"
    assert view.call_count == 2 and _of(resolve(h, attempt), "text")[0]["text"] == "from file"
    assert not h.rows()


@pytest.mark.parametrize("status", [400, 404, 410])
def test_missing_text_file_finishes_with_the_media(h, monkeypatch, status):
    h.successful()
    monkeypatch.setattr(comfy.comfy_client, "view_bytes", Mock(side_effect=comfy.comfy_client.ComfyError("gone", status_code=status)))
    attempt = descriptor()
    start(h, attempt, content=IMAGE_AND_TEXT)
    h.drain()
    result = resolve(h, attempt)
    assert result["state"] == "saved" and [out["kind"] for out in result["outputs"]] == ["image"]
    assert not h.rows()


def test_stop_before_read_text_is_recorded_keeps_the_flag_and_the_journal(h, monkeypatch):
    h.successful()
    monkeypatch.setattr(comfy.comfy_client, "view_bytes", Mock(return_value=b"from file"))
    attempt = descriptor()
    job = start(h, attempt, content=IMAGE_AND_TEXT)
    real = runs.record_outputs
    calls = []

    def fail_second(*args, **kwargs):
        calls.append(1)
        if len(calls) == 2:
            raise OSError("synthetic stop")
        return real(*args, **kwargs)

    with monkeypatch.context() as patch:
        patch.setattr(runs, "record_outputs", fail_second)
        h.drain()
    assert next(item for item in h.rows() if item["job_id"] == job)["text_files_unread"]
    restart(h)
    assert resolve(h, attempt)["state"] == "needs_collect"
    comfy.collect_unresolved_run(job, h.request())
    h.drain()
    result = resolve(h, attempt)
    assert result["state"] == "saved" and _of(result, "text")[0]["text"] == "from file" and len(_of(result, "image")) == 1


def test_dismiss_is_the_way_out_of_a_text_that_never_reads(h, monkeypatch):
    h.successful()
    monkeypatch.setattr(comfy.comfy_client, "view_bytes", Mock(side_effect=comfy.comfy_client.ComfyError("busy", status_code=503)))
    attempt = descriptor()
    job = start(h, attempt, content=IMAGE_AND_TEXT)
    h.drain()
    assert _listed(h, job)["can_dismiss"]
    comfy.dismiss_unresolved_runs(comfy.DismissRunsReq(job_ids=[job], acknowledged=True), h.request())
    result = resolve(h, attempt)
    assert result["state"] == "dismissed" and _of(result, "image")[0]["generation_id"]
    assert not h.rows()


def test_plain_run_reads_saved_text_once_and_still_finishes(h, monkeypatch):
    h.successful()
    view = Mock(side_effect=comfy.comfy_client.ComfyError("busy", status_code=503))
    monkeypatch.setattr(comfy.comfy_client, "view_bytes", view)
    job = comfy.run(request=h.request(), content=IMAGE_AND_TEXT, param_values="{}", media_meta="[]", media=[])["job_id"]
    h.drain()
    assert view.call_count == 1
    assert [out["kind"] for out in comfy.run_status(job, h.request())["outputs"]] == ["image"]


def test_resolve_gives_a_url_only_to_media_that_arrived():
    def row(state, kind="image", key="comfy/a.png"):
        return {"output_key": key, "kind": kind, "state": state, "metadata": {}}

    outputs = [row("saved"), row("ready"), row("pending"), row("unavailable"), row("deleted"), row("text", "text", "text:abc")]
    resolved = runs.resolution({"attempt_id": "a", "state": "saved", "result_revision": 1, "hub_id": "h", "device_id": "d", "outputs": outputs})
    assert [out.get("url") for out in resolved["outputs"]] == ["/media/comfy/a.png", "/media/comfy/a.png", None, None, None, None]


def test_plain_run_with_missing_detail_stays_in_unresolved_list_and_collects_later(h):
    entry = _lost_first_detail(h)
    job = h.start()
    h.drain()
    restart(h)
    comfy.collect_unresolved_run(job, h.request())
    h.drain()
    listed = comfy.list_unresolved_runs(h.request())["runs"]
    assert [item["job_id"] for item in listed] == [job] and listed[0]["can_collect"]
    restart(h)
    _answer(h.mocks["cloud_job_detail"], entry)
    comfy.collect_unresolved_run(job, h.request())
    h.drain()
    assert not [item for item in h.rows() if item["job_id"] == job and not item.get("outputs_enumerated")]
    assert h.mocks["submit"].call_count == 1


def test_local_history_without_outputs_is_not_an_empty_result(h):
    """로컬은 상태를 본 응답을 그대로 쓴다 — 받자마자 같은 검사를 지나야 한다."""
    h.settings["comfy_target"] = "local"
    entry = h.successful()
    h.mocks["get_history"].side_effect = comfy.comfy_client.ComfyError("lost", cause_kind="transport")
    attempt = descriptor()
    job = start(h, attempt)
    h.drain()
    assert resolve(h, attempt)["state"] == "needs_collect"
    restart(h)
    _answer(h.mocks["get_history"], {"status": {"completed": True}})
    comfy.collect_unresolved_run(job, h.request())
    h.drain()
    assert resolve(h, attempt)["state"] == "needs_collect"
    assert next(item for item in h.rows() if item["job_id"] == job)["last_error_class"] == "detail_failed"
    restart(h)
    _answer(h.mocks["get_history"], {"status": {"completed": True}, **entry})
    comfy.collect_unresolved_run(job, h.request())
    h.drain()
    assert resolve(h, attempt)["state"] == "saved"
    assert h.mocks["submit"].call_count == 1


def test_detail_that_really_has_no_outputs_is_still_failed(h):
    _lost_first_detail(h)
    attempt = descriptor()
    job = start(h, attempt)
    h.drain()
    restart(h)
    _answer(h.mocks["cloud_job_detail"], {"outputs": {}})
    comfy.collect_unresolved_run(job, h.request())
    h.drain()
    assert resolve(h, attempt)["state"] == "failed"
    assert not [item for item in h.rows() if item["job_id"] == job]


def _stamped(text, modified_at, margin=0.05):
    data = comfy.comfy_client.StampedBytes(text)
    data.modified_at, data.margin = modified_at, margin
    return data


def _finished(entry, seconds):
    entry["status"] = {"messages": [["execution_start", {"timestamp": 0}], ["execution_success", {"timestamp": int(seconds * 1000)}]]}
    return entry


def test_text_file_changed_after_the_run_is_another_run_and_says_so(h, monkeypatch):
    _finished(h.successful(0), 1000.2)
    monkeypatch.setattr(comfy.comfy_client, "view_bytes", Mock(return_value=_stamped(b"other run", 1000.7)))  # 같은 초 안의 덮어쓰기
    attempt = descriptor()
    start(h, attempt, content=SAVE_TEXT)
    h.drain()
    result = resolve(h, attempt)
    assert result["state"] == "failed" and not result["outputs"] and "덮어써" in result["message"]
    assert not h.rows()  # 다시 읽어도 이 실행의 글자는 없다 — 못 읽은 것과 다르다


def test_image_stays_when_its_text_file_was_overwritten(h, monkeypatch):
    _finished(h.successful(), 1000.2)
    monkeypatch.setattr(comfy.comfy_client, "view_bytes", Mock(return_value=_stamped(b"other run", 1000.7)))
    attempt = descriptor()
    start(h, attempt, content=IMAGE_AND_TEXT)
    h.drain()
    result = resolve(h, attempt)
    assert result["state"] == "saved" and len(_of(result, "image")) == 1 and not _of(result, "text")


@pytest.mark.parametrize("stamp,margin,kept", [
    (1000.2, 0.05, True),  # 끝 시각 그대로
    (999.0, 0.05, True),  # 캐시 실행은 파일을 다시 쓰지 않아 더 이르다
    (1000.24, 0.05, True),  # 여유 안 — 한계로 기록했다
    (1000.3, 0.05, False),
    (1002.1, 2.0, True),  # Last-Modified 는 초로 올림된다
    (1002.3, 2.0, False),
    (None, 0.0, True),  # 시각을 모르면 판정하지 않는다
])
def test_text_file_time_against_the_end_of_the_run(h, monkeypatch, stamp, margin, kept):
    _finished(h.successful(0), 1000.2)
    monkeypatch.setattr(comfy.comfy_client, "view_bytes", Mock(return_value=_stamped(b"text", stamp, margin)))
    attempt = descriptor()
    start(h, attempt, content=SAVE_TEXT)
    h.drain()
    assert [out["text"] for out in _of(resolve(h, attempt), "text")] == (["text"] if kept else [])


def test_collect_later_does_not_attach_text_of_another_run(h, monkeypatch):
    _finished(h.successful(0), 1000.2)
    view = Mock(side_effect=comfy.comfy_client.ComfyError("busy", status_code=503))
    monkeypatch.setattr(comfy.comfy_client, "view_bytes", view)
    attempt = descriptor()
    job = start(h, attempt, content=SAVE_TEXT)
    h.drain()
    assert resolve(h, attempt)["state"] == "needs_collect"
    restart(h)
    view.side_effect = None
    view.return_value = _stamped(b"other run", 2000.0)
    comfy.collect_unresolved_run(job, h.request())
    h.drain()
    result = resolve(h, attempt)
    assert result["state"] == "failed" and not result["outputs"]


def test_no_end_time_reads_the_file_as_before(h, monkeypatch):
    h.successful(0)
    monkeypatch.setattr(comfy.comfy_client, "view_bytes", Mock(return_value=_stamped(b"text", 9e9)))
    attempt = descriptor()
    start(h, attempt, content=SAVE_TEXT)
    h.drain()
    assert [out["text"] for out in _of(resolve(h, attempt), "text")] == ["text"]


@pytest.mark.parametrize("messages,expected", [
    ([["execution_success", {"timestamp": 1500}]], 1.5),
    ([["execution_error", {"timestamp": 2000}]], 2.0),
    ([["execution_start", {"timestamp": 1}], ["execution_interrupted", {"timestamp": 3000}]], 3.0),
    ([["execution_start", {"timestamp": 1}]], None),
    ([["execution_success", {}]], None),
    ("broken", None),
])
def test_finished_at_reads_history_messages(messages, expected):
    assert comfy.comfy_client.finished_at({"status": {"messages": messages}}) == expected


@pytest.mark.parametrize("entry", [{}, {"status": "completed"}, {"status": None}, {"status": {}}])
def test_finished_at_without_local_history_status(entry):
    assert comfy.comfy_client.finished_at(entry) is None  # Cloud 상세의 status 는 글자다


@pytest.mark.parametrize("headers,expected", [
    ({"ETag": '"18e3e3991f03c4cc-c"', "Last-Modified": "Sun, 01 Nov 2026 10:02:04 GMT"}, (1793527323.4134315, 0.05)),  # 실제 ComfyUI 응답
    ({"Last-Modified": "Sun, 01 Nov 2026 10:02:04 GMT"}, (1793527324.0, 2.0)),
    ({"ETag": '"abc-12"', "Last-Modified": "Sun, 01 Nov 2026 10:02:04 GMT"}, (1793527324.0, 2.0)),  # 나노초 시각이 아닌 ETag
    ({"ETag": '"d41d8cd98f00b204e9800998ecf8427e"'}, (None, 0.0)),
    ({"Last-Modified": "not a date"}, (None, 0.0)),
    ({}, (None, 0.0)),
])
def test_file_stamp_from_view_headers(headers, expected):
    assert comfy.comfy_client._file_stamp(headers) == pytest.approx(expected) if expected[0] else comfy.comfy_client._file_stamp(headers) == expected


@pytest.mark.parametrize("status", [400, 401, 402, 403, 404, 413, 429])
def test_refused_submission_is_failed_with_its_reason_and_leaves_no_journal(h, status):
    h.successful(0)
    h.mocks["submit"].side_effect = comfy.comfy_client.ComfyError(f"ComfyUI 오류 (HTTP {status}): 없는 노드", status_code=status)
    attempt = descriptor()
    start(h, attempt)
    h.drain()
    result = resolve(h, attempt)
    assert result["state"] == "failed" and "없는 노드" in result["message"]
    assert not h.rows()


@pytest.mark.parametrize("error", [
    comfy.comfy_client.ComfyError("timeout", status_code=408),
    comfy.comfy_client.ComfyError("broken", status_code=500),
    comfy.comfy_client.ComfyError("broken", status_code=502),
    comfy.comfy_client.ComfyError("lost", cause_kind="timeout"),
])
def test_submission_that_may_have_been_accepted_stays_unknown(h, error):
    h.successful(0)
    h.mocks["submit"].side_effect = error
    attempt = descriptor()
    start(h, attempt)
    h.drain()
    result = resolve(h, attempt)
    assert result["state"] == "unknown" and "message" not in result
    assert h.rows()[0]["phase"] == "unknown"


def test_failure_reason_is_cut_and_only_on_failed(h):
    h.successful(0)
    h.mocks["submit"].side_effect = comfy.comfy_client.ComfyError("가" * 900, status_code=400)
    attempt = descriptor()
    start(h, attempt)
    h.drain()
    assert len(resolve(h, attempt)["message"]) == 500
    done = descriptor()
    h.successful()
    h.mocks["submit"].side_effect = None
    start(h, done)
    h.drain()
    assert "message" not in resolve(h, done)


def test_failure_reason_write_error_does_not_stop_settling(h, monkeypatch):
    h.successful(0)
    h.mocks["submit"].side_effect = comfy.comfy_client.ComfyError("refused", status_code=400)
    monkeypatch.setattr(comfy.canvas_runs, "record_context", Mock(side_effect=OSError("database is locked")))
    attempt = descriptor()
    job = start(h, attempt)
    h.drain()
    assert resolve(h, attempt)["state"] == "failed" and "message" not in resolve(h, attempt)
    assert comfy._RUN_JOBS[job]["state"] == comfy._RUN_FAILED


def _elapsed_recorder(monkeypatch):
    recorded = []
    monkeypatch.setattr(comfy, "_pm", lambda action: action(SimpleNamespace(record_elapsed=lambda gen, seconds: recorded.append((gen, seconds)))))
    return recorded


def test_auto_saved_output_records_elapsed_once(h, monkeypatch):
    recorded = _elapsed_recorder(monkeypatch)
    h.successful()
    attempt = descriptor()
    start(h, attempt)
    h.drain()
    gen = _of(resolve(h, attempt), "image")[0]["generation_id"]
    assert [item[0] for item in recorded] == [gen] and recorded[0][1] >= 0
    comfy._save_canvas_run(runs.get(attempt["attempt_id"]), SimpleNamespace(), None)  # 다시 저장해도 더 쌓이지 않는다
    assert len(recorded) == 1


def test_output_already_saved_does_not_record_elapsed_again(h, monkeypatch):
    recorded = _elapsed_recorder(monkeypatch)
    h.successful()
    save = comfy.comfy_save.save_output
    monkeypatch.setattr(comfy.comfy_save, "save_output", lambda **kw: {**save(**kw), "existed": True})
    attempt = descriptor()
    start(h, attempt)
    h.drain()
    assert _of(resolve(h, attempt), "image") and not recorded


def test_collect_without_measured_time_records_no_elapsed(h, monkeypatch):
    recorded = _elapsed_recorder(monkeypatch)
    h.successful()
    monkeypatch.setattr(comfy, "_note_canvas_context", Mock())  # 재시작으로 값을 못 남긴 실행
    attempt = descriptor()
    start(h, attempt)
    h.drain()
    assert _of(resolve(h, attempt), "image") and not recorded

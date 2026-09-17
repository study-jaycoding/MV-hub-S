"""실제 임시 SQLite·라우트·워커를 사용한 Comfy 원장 회귀. provider I/O는 전부 대역."""

import copy
import json
import threading
from types import SimpleNamespace
from unittest.mock import Mock

import pytest
from fastapi import HTTPException, Request

from app import active_account, config, db, deps, repo
from app.routers import comfy
from app.services import comfy_client, comfy_run_journal as journal


@pytest.fixture
def h(monkeypatch, tmp_path):
    monkeypatch.setenv("CONTENT_HUB_DB", str(tmp_path / "content.db"))
    monkeypatch.setattr(config, "DATA_DIR", tmp_path)
    monkeypatch.setattr(config, "AUTH_ENABLED", False)
    monkeypatch.setattr(deps, "AUTH_ENABLED", False)
    monkeypatch.setattr(comfy, "AUTH_ENABLED", False)
    monkeypatch.setattr(active_account, "_POINTER", tmp_path / "active.json")
    monkeypatch.setattr(active_account, "_cache", [True, {"email": "a@example.invalid", "uid": None}])
    monkeypatch.setattr(comfy, "MEDIA_DIR", tmp_path / "media")
    monkeypatch.setattr(comfy, "_RUN_JOBS", {})
    monkeypatch.setattr(comfy, "_RUN_SLOTS_ACTIVE", 0)
    monkeypatch.setattr(journal, "_JOURNAL_BOOTSTRAPPED", set())
    monkeypatch.setattr(comfy, "EXTERNAL_RECOVERY_ENABLED", False)
    monkeypatch.setattr(comfy, "update_in_progress", lambda: False)
    device = {"device_id": "1" * 32, "device_name": "synthetic"}
    monkeypatch.setattr(comfy.worker_backup, "device_identity", lambda: dict(device))
    settings = {"comfy_target": "cloud", "comfy_api_key": "synthetic-key", "comfy_url": "http://synthetic.invalid",
                "comfy_input_dir": "", "comfy_concurrency": 3}
    monkeypatch.setattr(comfy, "_raw_settings", lambda: dict(settings))
    monkeypatch.setattr(comfy.time, "sleep", lambda _seconds: None)
    starts = []

    class DeferredThread:
        def __init__(self, *, target, args, **_kwargs):
            self.action = (target, args)

        def start(self):
            starts.append(self.action)

    monkeypatch.setattr(comfy, "threading", SimpleNamespace(Thread=DeferredThread))
    mocks = {}
    for name in ("submit", "cloud_job_status", "cloud_job_detail", "cloud_cancel_pending", "download_view", "get_history"):
        mocks[name] = Mock(side_effect=AssertionError(f"Unconfigured provider call: {name}"))
        monkeypatch.setattr(comfy_client, name, mocks[name])
    mocks["cloud_cancel_pending"].side_effect = None
    db.flush_pool()
    db.init_db()
    repo.ensure_default_worker()

    def request(email=None):
        req = Request({"type": "http", "headers": [], "client": ("127.0.0.1", 10000)})
        req.state.account = {"email": email, "creator_uid": f"acct:{email}"} if email else None
        return req

    def start(req=None):
        return comfy.run(request=req or request(), content='{"1":{"class_type":"SaveImage","inputs":{}}}',
                         param_values="{}", media_meta="[]", media=[])["job_id"]

    def drain():
        while starts:
            target, args = starts.pop(0)
            target(*args)

    def successful(count=1):
        entry = {"outputs": {"1": {"images": [{"filename": f"synthetic-{index}.png", "type": "output", "subfolder": ""}
                                                  for index in range(count)]}}}
        mocks["submit"].side_effect = None
        mocks["submit"].return_value = "synthetic-prompt"
        mocks["cloud_job_status"].side_effect = None
        mocks["cloud_job_status"].return_value = "completed"
        mocks["cloud_job_detail"].side_effect = None
        mocks["cloud_job_detail"].return_value = entry

        def download(_target, item, dst, *, deadline=None):
            assert deadline is not None
            dst.parent.mkdir(parents=True, exist_ok=True)
            dst.write_bytes(item["filename"].encode())

        mocks["download_view"].side_effect = download
        return entry

    state = SimpleNamespace(tmp=tmp_path, device=device, settings=settings, starts=starts, mocks=mocks,
                            request=request, start=start, drain=drain, successful=successful,
                            rows=lambda: json.loads(repo.get_setting(journal.KEY) or '{"runs":[]}')["runs"])
    try:
        yield state
        assert comfy._RUN_SLOTS_ACTIVE == 0
    finally:
        starts.clear()
        db.flush_pool()


def test_unknown_response_is_retained_and_never_resubmitted(h):
    h.mocks["submit"].side_effect = comfy_client.ComfyError("synthetic lost response", cause_kind="timeout")
    job_id = h.start()
    h.drain()
    assert h.rows()[0]["phase"] == "unknown"
    with pytest.raises(HTTPException) as error:
        comfy.run_status(job_id, h.request())
    assert error.value.headers == {"X-Comfy-Unresolved": "1"}
    assert h.mocks["submit"].call_count == 1
    h.mocks["cloud_cancel_pending"].assert_not_called()


@pytest.mark.parametrize("cause", ["scheme", "dns", "connect_refused", "tls_cert"])
def test_only_proven_pre_submit_failure_is_removed(h, cause):
    h.mocks["submit"].side_effect = comfy_client.ComfyError("synthetic", cause_kind=cause)
    h.start()
    h.drain()
    assert h.rows() == []
    assert h.mocks["submit"].call_count == 1


def test_pre_submit_journal_failure_prevents_provider_call(h, monkeypatch):
    job_id = h.start()
    original = repo.set_setting

    def fail(key, value):
        if key == journal.KEY:
            raise OSError("synthetic journal unavailable")
        return original(key, value)

    monkeypatch.setattr(repo, "set_setting", fail)
    h.drain()
    h.mocks["submit"].assert_not_called()
    assert not h.rows()
    assert comfy._RUN_JOBS[job_id]["code"] == 409
    assert comfy.active_run_job_count() == 0


@pytest.mark.parametrize("count", [2, 33, 100])
def test_full_manifest_survives_restart_and_partial_ack(h, count):
    h.successful(count)
    job_id = h.start()
    h.drain()
    row = h.rows()[0]
    assert row["phase"] == "collected" and row["media_output_count"] == count
    assert len(row["outputs"]) == count
    assert all(item["downloaded"] and not item["acked"] for item in row["outputs"])
    assert repo.get_setting(journal.LEGACY_KEY) is None
    journal._JOURNAL_BOOTSTRAPPED.clear()
    comfy._RUN_JOBS.clear()
    listed = comfy.list_unresolved_runs(h.request())
    assert listed["runs"][0]["job_id"] == job_id and listed["used"] == 1
    outputs = listed["runs"][0]["outputs"]
    before_calls = {key: mock.call_count for key, mock in h.mocks.items()}
    # 33번째 이후도 같은 목록으로 복원하며, target/key 변경은 로컬 재저장을 막지 않는다.
    h.settings["comfy_api_key"] = "synthetic-new-key"
    first = comfy.SaveToLibraryReq(outputs=[comfy.ComfyOutputItem(url=outputs[0]["url"], kind="image")])
    comfy.save_to_library(first, h.request())
    assert h.rows()[0]["outputs"][0]["acked"] is True
    assert sum(item["acked"] for item in h.rows()[0]["outputs"]) == 1
    rest = comfy.SaveToLibraryReq(outputs=[comfy.ComfyOutputItem(url=item["url"], kind="image") for item in outputs[1:]])
    comfy.save_to_library(rest, h.request())
    assert h.rows() == []
    assert {key: mock.call_count for key, mock in h.mocks.items()} == before_calls


def test_second_save_failure_keeps_first_ack_and_original_exception(h, monkeypatch):
    h.successful(2)
    h.start()
    h.drain()
    outputs = comfy.list_unresolved_runs(h.request())["runs"][0]["outputs"]
    original = repo.create_comfy_generation
    calls = []

    def save(**kwargs):
        calls.append(kwargs)
        if len(calls) == 2:
            raise RuntimeError("synthetic second DB failure")
        return original(**kwargs)

    monkeypatch.setattr(repo, "create_comfy_generation", save)
    with pytest.raises(RuntimeError, match="synthetic second DB failure"):
        comfy.save_to_library(comfy.SaveToLibraryReq(outputs=[comfy.ComfyOutputItem(url=item["url"], kind="image") for item in outputs]), h.request())
    assert [item["acked"] for item in h.rows()[0]["outputs"]] == [True, False]


def test_terminal_journal_failure_does_not_cancel_or_lose_memory(h, monkeypatch):
    h.successful()
    job_id = h.start()
    original = repo.set_setting

    def fail_terminal(key, value):
        if key == journal.KEY and '"terminal_kind":"success"' in value:
            raise OSError("synthetic terminal journal failure")
        return original(key, value)

    monkeypatch.setattr(repo, "set_setting", fail_terminal)
    h.drain()
    assert comfy._RUN_JOBS[job_id]["state"] == "done"
    assert comfy._RUN_JOBS[job_id]["journal_record"]["phase"] == "collected"
    h.mocks["cloud_cancel_pending"].assert_not_called()


def test_collect_reuses_existing_files_and_retries_only_missing_output(h):
    h.successful(2)
    original_download = h.mocks["download_view"].side_effect

    def fail_second(target, item, dst, **kwargs):
        if item["filename"].endswith("-1.png"):
            raise comfy_client.ComfyError("synthetic transient output")
        return original_download(target, item, dst, **kwargs)

    h.mocks["download_view"].side_effect = fail_second
    original_id = h.start()
    h.drain()
    assert h.rows()[0]["phase"] == "result_pending"
    assert h.mocks["download_view"].call_count == 5  # 첫 출력 1 + 둘째 출력 총 4.
    h.mocks["download_view"].side_effect = original_download
    collect_id = comfy.collect_unresolved_run(original_id, h.request())["job_id"]
    with pytest.raises(HTTPException) as duplicate:
        comfy.collect_unresolved_run(original_id, h.request())
    assert duplicate.value.status_code == 409
    h.drain()
    assert comfy._RUN_JOBS[collect_id]["state"] == "done"
    assert h.mocks["submit"].call_count == 1
    assert h.mocks["download_view"].call_count == 6
    h.mocks["cloud_cancel_pending"].assert_not_called()


def test_old_collect_sequence_cannot_replace_new_manifest(h):
    h.successful()
    original_id = h.start()
    h.drain()
    with journal.edit("a@example.invalid", False) as rows:
        rows[0]["phase"] = "result_pending"
    first_id = comfy.collect_unresolved_run(original_id, h.request())["job_id"]
    old_job = copy.deepcopy(comfy._RUN_JOBS[first_id])
    comfy._RUN_JOBS.pop(first_id)  # active TTL 소실을 모사. 실제 시계/긴 대기 없음.
    second_id = comfy.collect_unresolved_run(original_id, h.request())["job_id"]
    newer = copy.deepcopy(h.rows()[0])
    comfy._RUN_JOBS[first_id] = old_job
    assert not comfy._patch_run_record(first_id, phase="collected", last_error_class="stale")
    assert h.rows()[0] == newer
    assert newer["collect_job_id"] == second_id and newer["collect_seq"] == 2
    h.starts.clear()


def test_global_cap_is_atomic_for_concurrent_pre_submit(h, monkeypatch):
    monkeypatch.setattr(journal, "CAP", 5)
    with comfy._comfy_request_scope(h.request()) as identity:
        rows = [comfy._new_run_record(f"{index:032x}", identity) for index in range(10)]
    barrier = threading.Barrier(10)
    admitted, rejected = [], []

    def insert(row):
        barrier.wait(5)
        try:
            journal.admit(row, False)
            admitted.append(row["job_id"])
        except journal.JournalFull:
            rejected.append(row["job_id"])

    threads = [threading.Thread(target=insert, args=(row,)) for row in rows]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(10)
    assert not any(thread.is_alive() for thread in threads)
    assert len(h.rows()) == len(admitted) == len(rejected) == 5


@pytest.mark.parametrize("auth", [False, True])
def test_legacy_import_is_once_and_preserves_original_bytes(h, monkeypatch, auth):
    monkeypatch.setattr(comfy, "AUTH_ENABLED", auth)
    monkeypatch.setattr(config, "AUTH_ENABLED", auth)
    monkeypatch.setattr(deps, "AUTH_ENABLED", auth)
    raw = '[ {"job_id":"legacy", "prompt_id":"never expose on import", "target":"cloud"} ]'
    repo.set_setting(journal.LEGACY_KEY, raw)
    req = h.request("a@example.invalid") if auth else h.request()
    first = comfy.list_unresolved_runs(req)
    assert first["used"] == (0 if auth else 1)
    assert repo.get_setting(journal.LEGACY_KEY) == raw
    if not auth:
        assert first["runs"][0]["prompt_id"] is None and first["runs"][0]["can_dismiss"]
        with pytest.raises(HTTPException) as error:
            comfy.collect_unresolved_run("legacy", req)
        assert error.value.status_code == 409
        comfy.dismiss_unresolved_runs(comfy.DismissRunsReq(job_ids=["legacy"], acknowledged=True), req)
    else:
        for action in (lambda: comfy.run_status("legacy", req), lambda: comfy.collect_unresolved_run("legacy", req),
                       lambda: comfy.dismiss_unresolved_runs(comfy.DismissRunsReq(job_ids=["legacy"], acknowledged=True), req)):
            with pytest.raises(HTTPException) as error:
                action()
            assert error.value.status_code == 404
    journal._JOURNAL_BOOTSTRAPPED.clear()
    assert comfy.list_unresolved_runs(req)["used"] == 0
    assert repo.get_setting(journal.LEGACY_KEY) == raw
    assert all(mock.call_count == 0 for mock in h.mocks.values())


def test_owner_b_cannot_see_manipulate_or_save_a_output_in_shared_db(h, monkeypatch):
    for module in (comfy, config, deps):
        monkeypatch.setattr(module, "AUTH_ENABLED", True)
    h.successful()
    a, b = h.request("a@example.invalid"), h.request("b@example.invalid")
    job_id = h.start(a)
    h.drain()
    a_list = comfy.list_unresolved_runs(a)
    assert comfy.list_unresolved_runs(b) == {"cap": 200, "used": 0, "runs": []}
    for action in (lambda: comfy.run_status(job_id, b), lambda: comfy.collect_unresolved_run(job_id, b),
                   lambda: comfy.dismiss_unresolved_runs(comfy.DismissRunsReq(job_ids=[job_id], acknowledged=True), b)):
        with pytest.raises(HTTPException) as error:
            action()
        assert error.value.status_code == 404 and error.value.detail == comfy._NOT_FOUND
    before = repo.get_setting(journal.KEY)
    payload = comfy.SaveToLibraryReq(outputs=[comfy.ComfyOutputItem(url=a_list["runs"][0]["outputs"][0]["url"], kind="image")])
    with pytest.raises(HTTPException) as error:
        comfy.save_to_library(payload, b)
    assert error.value.status_code == 403
    assert repo.get_setting(journal.KEY) == before
    with db.get_connection() as conn:
        assert conn.execute("SELECT count(*) FROM generation").fetchone()[0] == 0
    # 공유 설정이 완전히 같아도 owner만으로 구분하며 A는 정상 저장한다.
    comfy.save_to_library(payload, a)
    assert h.rows() == []


def test_device_error_blocks_before_submission(h, monkeypatch):
    monkeypatch.setattr(comfy.worker_backup, "device_identity", Mock(side_effect=OSError("synthetic device unavailable")))
    with pytest.raises(HTTPException) as error:
        h.start()
    assert error.value.status_code == 409
    assert not h.starts and not comfy._RUN_JOBS
    h.mocks["submit"].assert_not_called()


def test_global_200_records_block_other_owner_without_disclosing_identity(h, monkeypatch):
    for module in (comfy, config, deps):
        monkeypatch.setattr(module, "AUTH_ENABLED", True)
    with comfy._comfy_request_scope(h.request("a@example.invalid")) as identity:
        with journal.edit(identity.owner, True) as rows:
            rows.extend(comfy._new_run_record(f"{index:032x}", identity) for index in range(200))
    b = h.request("b@example.invalid")
    assert comfy.list_unresolved_runs(b) == {"cap": 200, "used": 0, "runs": []}
    with pytest.raises(HTTPException) as error:
        h.start(b)
    assert error.value.status_code == 409
    assert "a@example" not in error.value.detail and "200" not in error.value.detail
    assert len(h.rows()) == 200 and not h.starts and comfy.active_run_job_count() == 0
    h.mocks["submit"].assert_not_called()


def test_marker_failure_blocks_before_job_registration(h, monkeypatch):
    repo.set_setting(journal.LEGACY_KEY, '[{"job_id":"old","prompt_id":"p","target":"cloud"}]')
    monkeypatch.setattr(repo, "set_setting", Mock(side_effect=OSError("synthetic marker failure")))
    with pytest.raises(HTTPException) as error:
        h.start()
    assert error.value.status_code == 409
    assert not h.starts and not comfy._RUN_JOBS and not journal._JOURNAL_BOOTSTRAPPED
    h.mocks["submit"].assert_not_called()


def test_lazy_boot_is_per_db_not_request_owner_or_returning_account(h, monkeypatch):
    a_db, b_db = str(h.tmp / "content.db"), str(h.tmp / "b.db")
    req = h.request()
    with comfy._comfy_request_scope(req) as identity:
        a = comfy._new_run_record("a" * 32, identity)
        a.update(phase="running", prompt_id="live-a")
        journal.admit(a, False)
    monkeypatch.setenv("CONTENT_HUB_DB", b_db)
    monkeypatch.setattr(active_account, "_cache", [True, {"email": "b@example.invalid", "uid": None}])
    db.init_db()
    repo.ensure_default_worker()
    repo.set_setting(journal.LEGACY_KEY, '[{"job_id":"old-b","prompt_id":"p","target":"local"}]')
    assert comfy.list_unresolved_runs(req)["used"] == 1
    assert len(journal._JOURNAL_BOOTSTRAPPED) == 2
    monkeypatch.setenv("CONTENT_HUB_DB", a_db)
    monkeypatch.setattr(active_account, "_cache", [True, {"email": "a@example.invalid", "uid": None}])
    assert comfy.list_unresolved_runs(req)["runs"][0]["phase"] == "running"
    journal._JOURNAL_BOOTSTRAPPED.clear()  # 실제 긴 대기 대신 프로세스 재시작의 메모리 초기화를 모사.
    assert comfy.list_unresolved_runs(req)["runs"][0]["phase"] == "orphaned"
    monkeypatch.setenv("CONTENT_HUB_DB", b_db)
    monkeypatch.setattr(active_account, "_cache", [True, {"email": "b@example.invalid", "uid": None}])
    assert comfy.list_unresolved_runs(req)["used"] == 1  # legacy 재이관 없음.
    assert all(mock.call_count == 0 for mock in h.mocks.values())


@pytest.mark.parametrize("phase,terminal,count,outputs,expected", [
    ("submitting", None, 0, [], "unknown"),
    ("running", None, 0, [], "orphaned"),
    ("collecting", "success", 0, [], "result_pending"),
    ("collecting", "success", 1, [{"downloaded": True}], "collected"),
    ("collecting", "success", 2, [{"downloaded": True}], "result_pending"),
])
def test_boot_phase_requires_complete_nonempty_manifest(h, phase, terminal, count, outputs, expected):
    repo.set_setting(journal.KEY, json.dumps({"v": 1, "legacy_imported": True, "runs": [{
        "job_id": "synthetic", "owner": "a@example.invalid", "phase": phase, "terminal_kind": terminal,
        "outputs_enumerated": True, "media_output_count": count, "outputs": outputs,
    }]}))
    rows = journal.read("a@example.invalid", False)
    assert rows[0]["phase"] == expected
    assert all(mock.call_count == 0 for mock in h.mocks.values())


@pytest.mark.parametrize("gate", [[True], [False, True]])
def test_collect_rechecks_update_gate_without_provider_or_claim(h, monkeypatch, gate):
    h.successful()
    original = h.start()
    h.drain()
    with journal.edit("a@example.invalid", False) as rows:
        rows[0]["phase"] = "result_pending"
    before = repo.get_setting(journal.KEY)
    monkeypatch.setattr(comfy, "update_in_progress", Mock(side_effect=gate))
    with pytest.raises(HTTPException) as error:
        comfy.collect_unresolved_run(original, h.request())
    assert error.value.status_code == 409
    assert repo.get_setting(journal.KEY) == before
    assert comfy.active_run_job_count() == 0 and len(comfy._RUN_JOBS) == 1 and not h.starts
    assert h.mocks["submit"].call_count == 1


@pytest.mark.parametrize("changed", ["device", "target"])
def test_collect_rejects_changed_device_or_target(h, changed):
    h.successful()
    original = h.start()
    h.drain()
    with journal.edit("a@example.invalid", False) as rows:
        rows[0]["phase"] = "result_pending"
    if changed == "device":
        h.device["device_id"] = "2" * 32
    else:
        h.settings["comfy_api_key"] = "synthetic-other"
    with pytest.raises(HTTPException) as error:
        comfy.collect_unresolved_run(original, h.request())
    assert error.value.status_code == 403 and not h.starts
    assert h.mocks["submit"].call_count == 1


@pytest.mark.parametrize("status", [404, 410])
def test_unavailable_output_keeps_other_results_and_requires_explicit_dismiss(h, status):
    h.successful(2)
    normal = h.mocks["download_view"].side_effect
    def download(target, item, dst, **kwargs):
        if item["filename"].endswith("-0.png"):
            raise comfy_client.ComfyError("synthetic gone", status_code=status, cause_kind="http_4xx")
        return normal(target, item, dst, **kwargs)
    h.mocks["download_view"].side_effect = download
    job_id = h.start()
    h.drain()
    assert h.mocks["download_view"].call_count == 2
    row = h.rows()[0]
    assert row["phase"] == "result_pending" and row["outputs"][0]["unavailable"] == "provider_gone"
    saved = row["outputs"][1]
    comfy.save_to_library(comfy.SaveToLibraryReq(outputs=[comfy.ComfyOutputItem(url=f"/media/{saved['rel']}", kind="image")]), h.request())
    assert len(h.rows()) == 1 and h.rows()[0]["outputs"][1]["acked"]
    comfy.dismiss_unresolved_runs(comfy.DismissRunsReq(job_ids=[job_id], acknowledged=True), h.request())
    assert not h.rows() and (comfy.MEDIA_DIR / saved["rel"]).is_file()
    h.mocks["cloud_cancel_pending"].assert_not_called()


def test_local_resave_batch_preflights_scope_before_any_generation(h):
    h.successful()
    h.start()
    h.drain()
    row = h.rows()[0]
    valid = "/media/" + row["outputs"][0]["rel"]
    foreign = "/media/comfy/" + "0" * 16 + valid[len("/media/comfy/") + 16:]
    before = repo.get_setting(journal.KEY)
    with pytest.raises(HTTPException) as error:
        comfy.save_to_library(comfy.SaveToLibraryReq(outputs=[comfy.ComfyOutputItem(url=url, kind="image") for url in (valid, foreign)]), h.request())
    assert error.value.status_code == 403 and repo.get_setting(journal.KEY) == before
    with db.get_connection() as conn:
        assert conn.execute("SELECT count(*) FROM generation").fetchone()[0] == 0


def test_old_ack_snapshot_cannot_delete_new_collect_claim(h):
    h.successful()
    original = h.start()
    h.drain()
    row = h.rows()[0]
    with comfy._comfy_request_scope(h.request()) as identity:
        expected = {original: (row["collect_job_id"], row["collect_seq"], row["phase"])}
        with journal.edit(identity.owner, False) as rows:
            rows[0].update(phase="collecting", collect_job_id="new-owner", collect_seq=1)
        comfy._ack_saved_outputs(identity, [{"url": "/media/" + row["outputs"][0]["rel"]}], expected)
    assert len(h.rows()) == 1 and h.rows()[0]["outputs"][0]["acked"] is False


def test_file_replace_before_download_flag_is_repaired_without_redownload(h):
    h.successful()
    original = h.start()
    h.drain()
    with journal.edit("a@example.invalid", False) as rows:
        rows[0]["phase"] = "result_pending"
        rows[0]["outputs"][0]["downloaded"] = False
    comfy.collect_unresolved_run(original, h.request())
    h.drain()
    assert h.rows()[0]["phase"] == "collected"
    assert h.mocks["download_view"].call_count == 1 and h.mocks["submit"].call_count == 1


@pytest.mark.parametrize("alias", ["windows_case", "dot_segment", "encoded_filename", "encoded_separator", "query", "fragment"])
def test_noncanonical_new_scope_cannot_bypass_owner_preflight(h, monkeypatch, alias):
    from fastapi import FastAPI
    from fastapi.staticfiles import StaticFiles
    from fastapi.testclient import TestClient

    for module in (comfy, config, deps):
        monkeypatch.setattr(module, "AUTH_ENABLED", True)
    h.successful()
    h.start(h.request("a@example.invalid"))
    h.drain()
    rel = h.rows()[0]["outputs"][0]["rel"]
    name = rel.split("/")[1]
    variants = {
        "windows_case": "/media/comfy/" + name.upper(),
        "dot_segment": "/media/comfy/../comfy/" + name,
        "encoded_filename": "/media/comfy/%" + format(ord(name[0]), "02X") + name[1:],
        "encoded_separator": "/media/comfy%2F" + name,
        "query": "/media/" + rel + "?synthetic=1",
        "fragment": "/media/" + rel + "#synthetic",
    }
    url = variants[alias]
    app = FastAPI()
    app.mount("/media", StaticFiles(directory=str(comfy.MEDIA_DIR)), name="media")
    with TestClient(app) as client:
        served = client.get(url)
    assert served.status_code == 200 and served.content == (comfy.MEDIA_DIR / rel).read_bytes()
    before = repo.get_setting(journal.KEY)
    status = 200
    try:
        comfy.save_to_library(comfy.SaveToLibraryReq(outputs=[comfy.ComfyOutputItem(url=url, kind="image")]), h.request("b@example.invalid"))
    except HTTPException as error:
        status = error.status_code
    with db.get_connection() as conn:
        created = conn.execute("SELECT count(*) FROM generation").fetchone()[0]
    assert status == 400 and created == 0, f"alias={alias} media_status={served.status_code} save_status={status} generated_rows={created}"
    assert repo.get_setting(journal.KEY) == before


def test_url_alias_reachability_controls_preserve_legacy(h):
    from fastapi import FastAPI
    from fastapi.staticfiles import StaticFiles
    from fastapi.testclient import TestClient

    h.successful()
    h.start()
    h.drain()
    rel = h.rows()[0]["outputs"][0]["rel"]
    name = rel.split("/")[1]
    app = FastAPI()
    app.mount("/media", StaticFiles(directory=str(comfy.MEDIA_DIR)), name="media")
    with TestClient(app) as client:
        # HTTPX+ASGI 계층은 두 번 percent decode할 수 있다. 실제 loopback 비교에서 별도 확인한다.
        twice = client.get("/media/comfy/%25" + format(ord(name[0]), "02X") + name[1:])
        assert twice.status_code == 200  # TestClient 전용 차이. 아래 실제 loopback은 404를 단언한다.
    for url in ("https://synthetic.invalid/media/" + rel, "//synthetic.invalid/media/" + rel):
        with pytest.raises(HTTPException) as error:
            comfy.save_to_library(comfy.SaveToLibraryReq(outputs=[comfy.ComfyOutputItem(url=url, kind="image")]), h.request())
        assert error.value.status_code == 400
    legacy = "/media/comfy/legacy-result.png"
    result = comfy.save_to_library(comfy.SaveToLibraryReq(outputs=[comfy.ComfyOutputItem(url=legacy, kind="image")]), h.request())
    assert len(result["saved"]) == 1 and result["saved"][0]["url"] == legacy
    assert len(h.rows()) == 1  # legacy는 새 원장의 ACK를 건드리지 않는다.


def test_authenticated_loopback_owner_boundary_and_http_decode_control(h, monkeypatch):
    import http.client
    import socket
    import urllib.parse
    from fastapi import FastAPI
    from fastapi.staticfiles import StaticFiles
    import uvicorn
    from app import main
    from app.services import auth

    for module in (comfy, config, deps, main):
        monkeypatch.setattr(module, "AUTH_ENABLED", True)
    # 실제 인증 서명/계정 조회를 합성 임시 DB에서 사용한다. 토큰은 메모리뿐이며 출력하지 않는다.
    for email in ("a@example.invalid", "b@example.invalid"):
        repo.register(email, "synthetic-password-only")
        repo.set_account_status(email, "approved")
    tokens = {who: auth.make_token(who + "@example.invalid") for who in ("a", "b")}
    app = FastAPI()
    app.middleware("http")(main.auth_enforcement)
    app.include_router(comfy.router)
    comfy.MEDIA_DIR.mkdir(parents=True, exist_ok=True)
    app.mount("/media", StaticFiles(directory=str(comfy.MEDIA_DIR)), name="media")
    listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    listener.bind(("127.0.0.1", 0))
    listener.listen(16)
    port = listener.getsockname()[1]
    server = uvicorn.Server(uvicorn.Config(app, host="127.0.0.1", port=port, lifespan="off", log_level="critical", access_log=False))
    thread = threading.Thread(target=lambda: server.run(sockets=[listener]), name="synthetic-comfy-loopback", daemon=True)

    def request(method, path, who=None, body=None, content_type="application/json"):
        headers = {"Content-Type": content_type}
        if who:
            headers["Authorization"] = "Bearer " + tokens[who]
        connection = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
        try:
            connection.request(method, path, body=body, headers=headers)
            response = connection.getresponse()
            return response.status, response.read()
        finally:
            connection.close()

    try:
        thread.start()
        waiter = threading.Event()
        for _ in range(300):
            if server.started:
                break
            waiter.wait(0.01)
        assert server.started
        assert request("GET", "/api/comfy/unresolved-runs")[0] == 401
        h.successful()
        body = urllib.parse.urlencode({"content": '{"1":{"class_type":"SaveImage","inputs":{}}}', "param_values": "{}", "media_meta": "[]"})
        status, raw = request("POST", "/api/comfy/run", "a", body, "application/x-www-form-urlencoded")
        assert status == 200
        job_id = json.loads(raw)["job_id"]
        h.drain()
        status, raw = request("GET", "/api/comfy/unresolved-runs", "b")
        assert status == 200 and json.loads(raw)["runs"] == []
        for method, path, body in (
            ("GET", f"/api/comfy/run_status?job_id={job_id}", None),
            ("POST", f"/api/comfy/unresolved-runs/{job_id}/collect", None),
            ("POST", "/api/comfy/unresolved-runs/dismiss", json.dumps({"job_ids": [job_id], "acknowledged": True})),
        ):
            status, raw = request(method, path, "b", body)
            assert status == 404 and json.loads(raw)["detail"] == comfy._NOT_FOUND
        url = "/media/" + h.rows()[0]["outputs"][0]["rel"]
        payload = json.dumps({"outputs": [{"url": url, "kind": "image"}]})
        assert request("POST", "/api/comfy/save-to-library", "b", payload)[0] == 403
        assert request("GET", url, "b")[0] == 200  # 기존 media 읽기 정책은 이 작업에서 바꾸지 않는다.
        prefix, name = url.rsplit("/", 1)
        assert request("GET", prefix + "/%" + format(ord(name[0]), "02X") + name[1:], "b")[0] == 200
        assert request("GET", prefix + "/%25" + format(ord(name[0]), "02X") + name[1:], "b")[0] == 404
        assert request("POST", "/api/comfy/save-to-library", "a", payload)[0] == 200
        assert not h.rows() and h.mocks["submit"].call_count == 1
    finally:
        server.should_exit = True
        thread.join(8)
        listener.close()
        assert not thread.is_alive() and listener.fileno() == -1


def test_account_switch_after_capture_keeps_settings_uid_worker_and_journal_in_a(h, monkeypatch):
    monkeypatch.delenv("CONTENT_HUB_DB")
    for who in ("a", "b"):
        with active_account.pinned_account_scope((who + "@example.invalid", None)):
            assert db.get_db_path().is_relative_to(h.tmp)
            db.init_db()
            repo.ensure_default_worker()
            repo.set_setting("comfy_url", f"http://{who}.synthetic.invalid")
    original_require = comfy.require_agent_account
    observations = []
    def switch_then_resolve(request):
        active_account._cache[:] = [True, {"email": "b@example.invalid", "uid": "synthetic-b-uid"}]
        account = original_require(request)
        observations.append((active_account.account_key(), account["email"], repo.get_setting("comfy_url")))
        return account
    monkeypatch.setattr(comfy, "require_agent_account", switch_then_resolve)
    def settings():
        assert active_account.account_key() == "a@example.invalid"
        return {**h.settings, "comfy_url": repo.get_setting("comfy_url")}
    monkeypatch.setattr(comfy, "_raw_settings", settings)
    h.successful()
    job_id = h.start()
    assert active_account.account_key() == "b@example.invalid"  # 요청 scope는 복원됐다.
    h.drain()
    assert observations == [("a@example.invalid", "a@example.invalid", "http://a.synthetic.invalid")]
    with active_account.pinned_account_scope(("a@example.invalid", None)):
        assert h.rows()[0]["owner"] == "a@example.invalid"
        assert comfy._RUN_JOBS[job_id]["identity"].settings["comfy_url"] == "http://a.synthetic.invalid"
    with active_account.pinned_account_scope(("b@example.invalid", None)):
        assert repo.get_setting(journal.KEY) is None
    assert h.mocks["submit"].call_count == 1


def test_collect_thread_start_failure_preserves_record_and_releases_activity(h, monkeypatch):
    h.successful()
    original = h.start()
    h.drain()
    with journal.edit("a@example.invalid", False) as rows:
        rows[0].update(phase="result_pending", outputs=[])
    monkeypatch.setattr(comfy, "threading", SimpleNamespace(Thread=Mock(side_effect=OSError("synthetic thread failure"))))
    with pytest.raises(HTTPException) as error:
        comfy.collect_unresolved_run(original, h.request())
    assert error.value.status_code == 500
    assert h.rows()[0]["phase"] == "result_pending" and comfy.active_run_job_count() == 0
    assert h.mocks["submit"].call_count == 1
    h.mocks["cloud_cancel_pending"].assert_not_called()


def test_uid_discovery_does_not_change_same_account_output_scope(h, monkeypatch):
    h.successful()
    h.start()
    h.drain()
    row = h.rows()[0]
    monkeypatch.setattr(active_account, "_cache", [True, {"email": "a@example.invalid", "uid": "synthetic-later-uid"}])
    monkeypatch.setattr(repo, "get_my_uid", lambda: "synthetic-later-uid")
    payload = comfy.SaveToLibraryReq(outputs=[comfy.ComfyOutputItem(url="/media/" + row["outputs"][0]["rel"], kind="image")])
    result = comfy.save_to_library(payload, h.request())
    assert len(result["saved"]) == 1 and not h.rows()
    with db.get_connection() as conn:
        assert conn.execute("SELECT creator_uid FROM generation").fetchone()[0] == "synthetic-later-uid"


@pytest.mark.parametrize("enumerated,text_only,expected", [(False, False, "orphaned"), (True, True, None)])
def test_collecting_boot_restores_prior_phase_or_forgets_actual_text_only(h, enumerated, text_only, expected):
    repo.set_setting(journal.KEY, json.dumps({"v": 1, "legacy_imported": True, "runs": [{
        "job_id": "synthetic", "owner": "a@example.invalid", "phase": "collecting", "prev_phase": "orphaned",
        "terminal_kind": "success", "outputs_enumerated": enumerated, "media_output_count": 0,
        "text_only": text_only, "outputs": [],
    }]}))
    rows = journal.read("a@example.invalid", False)
    assert ([row["phase"] for row in rows]) == ([] if expected is None else [expected])


def test_same_collect_sequence_with_changed_phase_rejects_late_completion(h):
    h.successful()
    original = h.start()
    h.drain()
    with journal.edit("a@example.invalid", False) as rows:
        rows[0]["phase"] = "orphaned"  # 외부 원장 상태 교체 모델, token만 같아도 phase 달라야 거부.
    before = copy.deepcopy(h.rows())
    assert comfy._patch_run_record(original, phase="collected") is False
    assert h.rows() == before


def test_one_post_submit_write_failure_recovers_using_last_persisted_phase(h, monkeypatch):
    h.successful()
    original = repo.set_setting
    failures = []
    def fail_once(key, value):
        if key == journal.KEY and '"phase":"running"' in value and not failures:
            failures.append(True)
            raise OSError("synthetic one post-submit write failure")
        return original(key, value)
    monkeypatch.setattr(repo, "set_setting", fail_once)
    job_id = h.start()
    h.drain()
    assert len(failures) == 1
    assert h.rows()[0]["phase"] == "collected" and h.rows()[0]["prompt_id"] == "synthetic-prompt"
    assert "journal_persisted_phase" not in h.rows()[0]
    assert comfy._RUN_JOBS[job_id]["journal_persisted_phase"] == "collected"
    assert comfy._RUN_JOBS[job_id]["state"] == "done"
    h.mocks["cloud_cancel_pending"].assert_not_called()


@pytest.mark.parametrize("kind", ["trailing_dot", "trailing_space", "ads", "short_name", "legacy_query", "own_uppercase", "double_encoded"])
def test_noncanonical_input_grammar_rejects_win32_and_legacy_aliases(h, monkeypatch, kind):
    h.successful()
    h.start()
    h.drain()
    canonical = "/media/" + h.rows()[0]["outputs"][0]["rel"]
    filename = canonical.rsplit("/", 1)[1]
    variants = {
        "trailing_dot": canonical + ".", "trailing_space": canonical + "%20",
        "ads": canonical + "::$DATA", "short_name": "/media/comfy/" + filename[:6].upper() + "~1.PNG",
        "legacy_query": "/media/comfy/legacy-result.png?v=2", "own_uppercase": "/media/comfy/" + filename.upper(),
        "double_encoded": "/media/comfy/%25" + format(ord(filename[0]), "02X") + filename[1:],
    }
    with comfy._comfy_request_scope(h.request()) as identity:
        # valid를 앞에 둔 mixed batch도 create/ACK/기록 read 이전에 거부된다.
        create = Mock(side_effect=AssertionError("No generation write before full preflight"))
        ack = Mock(side_effect=AssertionError("No ACK before full preflight"))
        read = Mock(side_effect=AssertionError("No journal read inside save before full preflight"))
        monkeypatch.setattr(repo, "create_comfy_generation", create)
        monkeypatch.setattr(comfy, "_ack_saved_outputs", ack)
        monkeypatch.setattr(journal, "read", read)
        with pytest.raises(HTTPException) as error:
            comfy._save_to_library_pinned(comfy.SaveToLibraryReq(outputs=[comfy.ComfyOutputItem(url=url, kind="image")
                for url in (canonical, variants[kind])]), h.request(), identity)
        assert error.value.status_code == 400
        create.assert_not_called()
        ack.assert_not_called()
        read.assert_not_called()


@pytest.mark.parametrize("legacy", ["/media/comfy/0123456789abcdef.png", "/media/ab/0123456789abcdef0123.png"])
def test_canonical_legacy_and_sharded_outputs_remain_accepted(h, legacy):
    result = comfy.save_to_library(comfy.SaveToLibraryReq(outputs=[comfy.ComfyOutputItem(url=legacy, kind="image")]), h.request())
    assert len(result["saved"]) == 1 and result["saved"][0]["url"] == legacy
    assert not h.rows()


def _seed_collectible(h, job_id="a" * 32):
    with comfy._comfy_request_scope(h.request()) as identity:
        row = comfy._new_run_record(job_id, identity)
        row.update(phase="result_pending", prompt_id="synthetic-prompt", terminal_kind="success")
        journal.admit(row, False)
    return row


@pytest.mark.parametrize("action", ["collect", "dismiss"])
def test_stale_jobs_snapshot_cannot_replace_or_delete_a_new_claim(h, monkeypatch, action):
    row = _seed_collectible(h)
    release, snapshot_taken = threading.Event(), threading.Event()
    original_snapshot = comfy._run_job_snapshot
    result = {}

    def snapshot():
        value = original_snapshot()
        if threading.current_thread().name == "synthetic-stale-request":
            snapshot_taken.set()
            assert release.wait(5)
        return value

    def stale_request():
        try:
            if action == "collect":
                comfy.collect_unresolved_run(row["job_id"], h.request())
            else:
                comfy.dismiss_unresolved_runs(comfy.DismissRunsReq(job_ids=[row["job_id"]], acknowledged=True), h.request())
            result["code"] = 200
        except HTTPException as error:
            result["code"] = error.status_code
        except Exception as error:
            result["unexpected"] = error

    monkeypatch.setattr(comfy, "_run_job_snapshot", snapshot)
    thread = threading.Thread(target=stale_request, name="synthetic-stale-request", daemon=True)
    try:
        thread.start()
        assert snapshot_taken.wait(5)
        first = comfy.collect_unresolved_run(row["job_id"], h.request())
        release.set()
        thread.join(5)
        assert not thread.is_alive() and result == {"code": 409}
        assert h.rows()[0]["collect_job_id"] == first["job_id"]
        assert h.rows()[0]["collect_seq"] == 1
        assert len(h.starts) == comfy.active_run_job_count() == 1
        assert not any(mock.call_count for mock in h.mocks.values())
    finally:
        release.set()
        thread.join(5)
        assert not thread.is_alive()


def test_dismiss_winning_before_claim_returns_404_without_worker_or_memory_job(h, monkeypatch):
    row = _seed_collectible(h)
    original_snapshot = comfy._run_job_snapshot
    raced = []

    def snapshot():
        jobs = original_snapshot()
        if not raced:
            raced.append(True)
            assert comfy.dismiss_unresolved_runs(comfy.DismissRunsReq(job_ids=[row["job_id"]], acknowledged=True), h.request()) == {"dismissed": 1}
        return jobs

    monkeypatch.setattr(comfy, "_run_job_snapshot", snapshot)
    with pytest.raises(HTTPException) as error:
        comfy.collect_unresolved_run(row["job_id"], h.request())
    assert error.value.status_code == 404
    assert not h.rows() and not h.starts and not comfy._RUN_JOBS
    assert not any(mock.call_count for mock in h.mocks.values())


def test_dismiss_detects_completion_after_read_then_fresh_retry_succeeds(h, monkeypatch):
    row = _seed_collectible(h)
    with journal.edit(row["owner"], False) as rows:
        rows[0].update(phase="collecting", collect_job_id="synthetic-finished", collect_seq=1)
    original_snapshot = comfy._run_job_snapshot
    completed = []

    def snapshot():
        jobs = original_snapshot()
        if not completed:
            completed.append(True)
            with journal.edit(row["owner"], False) as rows:
                rows[0]["phase"] = "collected"
        return jobs

    monkeypatch.setattr(comfy, "_run_job_snapshot", snapshot)
    request = comfy.DismissRunsReq(job_ids=[row["job_id"]], acknowledged=True)
    with pytest.raises(HTTPException) as error:
        comfy.dismiss_unresolved_runs(request, h.request())
    assert error.value.status_code == 409 and h.rows()[0]["phase"] == "collected"
    assert comfy.list_unresolved_runs(h.request())["runs"][0]["can_dismiss"] is True
    assert comfy.dismiss_unresolved_runs(request, h.request()) == {"dismissed": 1}
    assert not h.rows() and not any(mock.call_count for mock in h.mocks.values())


@pytest.mark.parametrize("missing", [False, True])
def test_claim_normalizes_absent_or_none_collect_sequence(h, missing):
    row = _seed_collectible(h)
    with journal.edit(row["owner"], False) as rows:
        if missing:
            rows[0].pop("collect_seq")
        else:
            rows[0]["collect_seq"] = None
    result = comfy.collect_unresolved_run(row["job_id"], h.request())
    assert h.rows()[0]["collect_seq"] == 1 and h.rows()[0]["collect_job_id"] == result["job_id"]
    assert len(h.starts) == 1 and not any(mock.call_count for mock in h.mocks.values())


def test_batch_dismiss_with_one_changed_claim_preserves_every_selected_record(h, monkeypatch):
    rows = [_seed_collectible(h, char * 32) for char in "abc"]
    original_snapshot = comfy._run_job_snapshot

    def snapshot():
        jobs = original_snapshot()
        with journal.edit(rows[0]["owner"], False) as current:
            current[1].update(phase="collecting", collect_job_id="synthetic-new-owner", collect_seq=1)
        return jobs

    monkeypatch.setattr(comfy, "_run_job_snapshot", snapshot)
    with pytest.raises(HTTPException) as error:
        comfy.dismiss_unresolved_runs(comfy.DismissRunsReq(job_ids=[row["job_id"] for row in rows], acknowledged=True), h.request())
    assert error.value.status_code == 409
    assert [row["job_id"] for row in h.rows()] == [row["job_id"] for row in rows]
    assert h.rows()[1]["collect_seq"] == 1
    assert not any(mock.call_count for mock in h.mocks.values())


def test_unchanged_collect_token_with_missing_memory_owner_keeps_recovery_available(h):
    row = _seed_collectible(h)
    with journal.edit(row["owner"], False) as rows:
        rows[0].update(phase="collecting", collect_job_id="synthetic-absent-owner", collect_seq=4,
                       collect_started_at=comfy.time.time())
    result = comfy.collect_unresolved_run(row["job_id"], h.request())
    assert h.rows()[0]["collect_job_id"] == result["job_id"] and h.rows()[0]["collect_seq"] == 5
    assert len(h.starts) == 1 and not any(mock.call_count for mock in h.mocks.values())


def test_dismiss_read_snapshot_edit_order_adds_one_journal_lock_without_nesting(h, monkeypatch):
    row = _seed_collectible(h)
    events = []
    original_lock, original_snapshot = journal.LOCK, comfy._run_job_snapshot

    class CountedLock:
        def __enter__(self):
            assert not comfy._RUN_JOBS_LOCK.locked()
            original_lock.acquire()
            events.append("journal")

        def __exit__(self, *_args):
            original_lock.release()

    def snapshot():
        assert not original_lock.locked()
        events.append("snapshot")
        return original_snapshot()

    monkeypatch.setattr(journal, "LOCK", CountedLock())
    monkeypatch.setattr(comfy, "_run_job_snapshot", snapshot)
    assert comfy.dismiss_unresolved_runs(comfy.DismissRunsReq(job_ids=[row["job_id"]] * 2, acknowledged=True), h.request()) == {"dismissed": 1}
    # 기존 scope bootstrap/edit 2회 + 새 read 1회. 실행 목록 lock과 중첩하지 않는다.
    assert events == ["journal", "journal", "snapshot", "journal"]
    assert not any(mock.call_count for mock in h.mocks.values())


def test_dismiss_missing_read_record_stays_404_and_checks_in_input_order(h, monkeypatch):
    row = _seed_collectible(h)
    original_owned = comfy._owned_record
    seen = []

    def owned(rows, job_id, owner):
        seen.append(job_id)
        return original_owned(rows, job_id, owner)

    monkeypatch.setattr(comfy, "_owned_record", owned)
    with pytest.raises(HTTPException) as error:
        comfy.dismiss_unresolved_runs(comfy.DismissRunsReq(job_ids=[row["job_id"], row["job_id"], "missing"], acknowledged=True), h.request())
    assert error.value.status_code == 404
    assert seen == [row["job_id"], "missing"]  # read의 missing은 sentinel, edit의 기존 404를 사용한다.
    assert len(h.rows()) == 1


@pytest.mark.parametrize("raw", ["{", '{"v":2,"runs":[]}', '{"v":1,"runs":{}}', '{"v":1,"runs":[{}]}'])
def test_corrupt_journal_blocks_route_family_without_overwrite_or_side_effects(h, raw):
    repo.set_setting(journal.KEY, raw)
    actions = [lambda: h.start(), lambda: comfy.list_unresolved_runs(h.request()),
               lambda: comfy.dismiss_unresolved_runs(comfy.DismissRunsReq(job_ids=["synthetic"], acknowledged=True), h.request()),
               lambda: comfy.save_to_library(comfy.SaveToLibraryReq(outputs=[comfy.ComfyOutputItem(url="/media/comfy/legacy.png", kind="image")]), h.request()),
               lambda: comfy.run_status("synthetic", h.request())]
    for action in actions:
        with pytest.raises(HTTPException) as error:
            action()
        assert error.value.status_code == 409 and repo.get_setting(journal.KEY) == raw
    with db.get_connection() as conn:
        assert conn.execute("SELECT count(*) FROM generation").fetchone()[0] == 0
    assert not any(mock.call_count for mock in h.mocks.values())

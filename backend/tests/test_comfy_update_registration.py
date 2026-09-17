"""Comfy 접수와 업데이트의 순서·회수 계약 — 외부 실행 없는 회귀 검사."""

import io
import threading
from contextlib import nullcontext
from dataclasses import replace
from types import SimpleNamespace
from unittest.mock import Mock

import pytest
from fastapi import HTTPException, Request, UploadFile

from app.routers import comfy
from app.services import release_update


@pytest.fixture
def admission(monkeypatch, tmp_path):
    state = SimpleNamespace(update="available", starts=[], start_error=None)

    class NoExecutionThread:
        def __init__(self, *, target, args, **kwargs):
            self.args = args

        def start(self):
            if state.start_error:
                raise state.start_error
            state.starts.append(self.args[0])

    monkeypatch.setattr(comfy, "_RUN_JOBS", {})
    monkeypatch.setattr(comfy, "_raw_settings", lambda: {"comfy_concurrency": 1})
    identity = comfy._ComfyIdentity(("", None), "local", None, "1" * 32, "2" * 16,
                                   {"comfy_concurrency": 1}, False)
    monkeypatch.setattr(comfy, "_comfy_request_scope", lambda request: nullcontext(replace(identity, settings=comfy._raw_settings())))
    monkeypatch.setattr(comfy.run_journal, "read", lambda *_: [])
    monkeypatch.setattr(comfy, "update_in_progress", lambda: state.update in release_update._ACTIVE_STATES)
    monkeypatch.setattr(comfy, "threading", SimpleNamespace(Thread=NoExecutionThread))
    monkeypatch.setattr(release_update, "UPDATE_STATE_BASE", tmp_path / "update-state")
    monkeypatch.setattr(release_update, "_START_LOCK", threading.Lock())
    assert release_update.state_path(tmp_path).is_relative_to(tmp_path)
    state.forget = Mock()
    monkeypatch.setattr(comfy, "_forget_inflight_run", state.forget)
    return state


def request_run(**kwargs):
    return comfy.run(
        request=Request({"type": "http", "headers": [], "client": ("127.0.0.1", 1)}),
        content=kwargs.get("content", '{"1":{"class_type":"SaveImage","inputs":{}}}'),
        param_values="{}", media_meta=kwargs.get("media_meta", "[]"), media=kwargs.get("media", []),
    )


def fake_updater(monkeypatch, admission, tmp_path, latest=None):
    launches = []

    def write_state(state, message, **kwargs):
        admission.update = state
        return {"state": state}

    monkeypatch.setattr(release_update, "install_mode", lambda *_: "release")
    monkeypatch.setattr(release_update, "_read_version", lambda *_: "old")
    monkeypatch.setattr(release_update, "_load_state", Mock(side_effect=lambda *_: ("ok", {"state": admission.update})))
    monkeypatch.setattr(release_update, "write_state", write_state)
    monkeypatch.setattr(release_update, "fetch_latest", latest or (lambda *_: {"version": "new"}))
    monkeypatch.setattr(release_update, "_launch_bootstrap", lambda *_: launches.append("stub") or 0)
    return launches


def test_fake_updater_active_state_is_classified_before_activity(admission, monkeypatch, tmp_path):
    launches = fake_updater(monkeypatch, admission, tmp_path)
    admission.update = "checking"
    activity = Mock(side_effect=AssertionError("Active stored state must reject before activity lookup"))
    with pytest.raises(release_update.ReleaseUpdateError, match="이미 진행"):
        release_update.start_update(activity_check=activity, root=tmp_path)
    release_update._load_state.assert_called_once_with(tmp_path)
    activity.assert_not_called()
    assert not launches and not release_update.state_path(tmp_path).exists()


@pytest.mark.parametrize("iteration", range(10))
def test_update_first_rejects_before_registration(admission, monkeypatch, iteration):
    admission.update = "checking"
    stage = Mock(return_value=[])
    monkeypatch.setattr(comfy, "_stage_media_uploads", stage)
    with pytest.raises(HTTPException) as error:
        request_run()
    assert error.value.status_code == 409
    assert not comfy._RUN_JOBS and not admission.starts
    assert comfy.active_run_job_count() == 0
    stage.assert_not_called()
    admission.forget.assert_not_called()


@pytest.mark.parametrize("iteration", range(10))
def test_comfy_first_blocks_update(admission, monkeypatch, tmp_path, iteration):
    monkeypatch.setattr(comfy, "_stage_media_uploads", lambda _: [])
    launches = fake_updater(monkeypatch, admission, tmp_path)
    result = request_run()
    assert admission.starts == [result["job_id"]]
    assert comfy.active_run_job_count() == 1
    with pytest.raises(release_update.ReleaseUpdateBusyError):
        release_update.start_update(activity_check=comfy.active_run_job_count, root=tmp_path)
    assert not launches and admission.update == "available"


@pytest.mark.parametrize("iteration", range(10))
def test_update_start_during_staging_sees_registered_job(admission, monkeypatch, tmp_path, iteration):
    launches = fake_updater(monkeypatch, admission, tmp_path)
    staged_counts = []

    def stage(_files):
        staged_counts.append(comfy.active_run_job_count())
        with pytest.raises(release_update.ReleaseUpdateBusyError):
            release_update.start_update(activity_check=comfy.active_run_job_count, root=tmp_path)
        return []

    monkeypatch.setattr(comfy, "_stage_media_uploads", stage)
    result = request_run()
    assert staged_counts == [1]
    assert admission.starts == [result["job_id"]]
    assert not launches


@pytest.mark.parametrize("iteration", range(10))
def test_update_checking_after_first_activity_snapshot_reclaims_request(admission, monkeypatch, tmp_path, iteration):
    entered = threading.Event()
    release = threading.Event()
    errors = []
    upload_path = tmp_path / "staged-input.bin"
    upload_path.write_bytes(b"synthetic")

    def stage(_files):
        entered.set()
        assert release.wait(5), "Staging barrier was not released"
        return [comfy._MediaUpload("synthetic.bin", upload_path, 9)]

    def request_worker():
        try:
            request_run()
        except BaseException as error:
            errors.append(error)

    requester = threading.Thread(target=request_worker)
    activity_counts = []

    def activity():
        count = comfy.active_run_job_count()
        activity_counts.append(count)
        if len(activity_counts) == 1:
            assert count == 0
            requester.start()
            assert entered.wait(5), "Request did not reach staging"
        return count

    def latest(_root):
        assert admission.update == "checking"
        release.set()
        requester.join(5)
        assert not requester.is_alive()
        return {"version": "new"}

    monkeypatch.setattr(comfy, "_stage_media_uploads", stage)
    launches = fake_updater(monkeypatch, admission, tmp_path, latest=latest)
    try:
        result = release_update.start_update(activity_check=activity, root=tmp_path)
    finally:
        release.set()
        if requester.ident is not None:
            requester.join(5)
    assert not requester.is_alive()
    assert result["accepted"] and launches == ["stub"]
    assert activity_counts == [0, 0]
    assert len(errors) == 1 and isinstance(errors[0], HTTPException)
    assert errors[0].status_code == 409
    assert not admission.starts and not comfy._RUN_JOBS
    assert comfy.active_run_job_count() == 0 and not upload_path.exists()
    admission.forget.assert_not_called()


def test_staging_copy_error_cleans_partial_uploads_and_registration(admission, monkeypatch, tmp_path):
    original_temporary_file = comfy.tempfile.NamedTemporaryFile
    monkeypatch.setattr(comfy, "tempfile", SimpleNamespace(
        NamedTemporaryFile=lambda **kwargs: original_temporary_file(dir=tmp_path, **kwargs),
    ))
    original_copy = comfy.upload_limits.copy_stream_limited
    calls = []

    def copy_stream(source, target, **kwargs):
        calls.append(comfy.active_run_job_count())
        if len(calls) == 2:
            raise OSError("Synthetic staging copy failure")
        return original_copy(source, target, **kwargs)

    monkeypatch.setattr(comfy.upload_limits, "copy_stream_limited", copy_stream)
    uploads = [UploadFile(filename="a.png", file=io.BytesIO(b"a")), UploadFile(filename="b.png", file=io.BytesIO(b"b"))]
    try:
        with pytest.raises(OSError, match="Synthetic staging"):
            request_run(media=uploads, media_meta='[{"type":"image"},{"type":"image"}]')
    finally:
        for upload in uploads:
            upload.file.close()
    assert calls == [1, 1]
    assert not list(tmp_path.iterdir()) and not comfy._RUN_JOBS and not admission.starts
    assert comfy.active_run_job_count() == 0
    admission.forget.assert_not_called()


def test_thread_start_error_preserves_existing_failure_cleanup(admission, monkeypatch, tmp_path):
    upload_path = tmp_path / "staged.bin"
    upload_path.write_bytes(b"synthetic")
    monkeypatch.setattr(comfy, "_stage_media_uploads", lambda _: [comfy._MediaUpload("staged.bin", upload_path, 9)])
    admission.start_error = RuntimeError("Synthetic thread start failure")
    with pytest.raises(HTTPException) as error:
        request_run()
    assert error.value.status_code == 500
    assert len(comfy._RUN_JOBS) == 1
    assert next(iter(comfy._RUN_JOBS.values()))["state"] == "failed"
    assert comfy.active_run_job_count() == 0 and not upload_path.exists()
    admission.forget.assert_called_once()


def test_thread_constructor_error_uses_same_failure_cleanup(admission, monkeypatch, tmp_path):
    upload_path = tmp_path / "staged.bin"
    upload_path.write_bytes(b"synthetic")
    monkeypatch.setattr(comfy, "_stage_media_uploads", lambda _: [comfy._MediaUpload("staged.bin", upload_path, 9)])
    constructor = Mock(side_effect=RuntimeError("Synthetic thread constructor failure"))
    monkeypatch.setattr(comfy, "threading", SimpleNamespace(Thread=constructor))
    with pytest.raises(HTTPException) as error:
        request_run()
    assert error.value.status_code == 500
    assert len(comfy._RUN_JOBS) == 1
    assert next(iter(comfy._RUN_JOBS.values()))["state"] == "failed"
    assert comfy.active_run_job_count() == 0 and not upload_path.exists()
    assert not admission.starts
    admission.forget.assert_called_once()


def test_settings_error_does_not_stage_or_register(admission, monkeypatch):
    monkeypatch.setattr(comfy, "_raw_settings", Mock(side_effect=OSError("Synthetic settings read failure")))
    stage = Mock(return_value=[])
    monkeypatch.setattr(comfy, "_stage_media_uploads", stage)
    with pytest.raises(OSError, match="Synthetic settings"):
        request_run()
    assert not comfy._RUN_JOBS and not admission.starts
    stage.assert_not_called()


def test_invalid_json_does_not_stage_or_register(admission, monkeypatch):
    stage = Mock(return_value=[])
    monkeypatch.setattr(comfy, "_stage_media_uploads", stage)
    with pytest.raises(HTTPException) as error:
        request_run(content="{")
    assert error.value.status_code == 400
    assert not comfy._RUN_JOBS and not admission.starts
    stage.assert_not_called()

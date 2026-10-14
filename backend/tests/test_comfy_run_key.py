"""Comfy [실행] 요청표(run_key) — 응답을 잃고 다시 보내도 한 번만 실행한다(Jay 결정 2A, 10-15). 외부 실행 없이 접수 계약만."""

import threading
import time
from contextlib import nullcontext
from dataclasses import replace
from types import SimpleNamespace
from unittest.mock import Mock

import pytest
from fastapi import HTTPException, Request

from app.routers import comfy
from app.services import comfy_run_keys

KEY = "123e4567-e89b-42d3-a456-426614174000"


@pytest.fixture
def admission(monkeypatch, tmp_path):
    state = SimpleNamespace(starts=[], settings={}, staged=[])

    class NoExecutionThread:
        def __init__(self, *, target, args, **kwargs):
            self.args = args

        def start(self):
            state.starts.append(self.args[0])

    monkeypatch.setattr(comfy, "_RUN_JOBS", {})
    monkeypatch.setattr(comfy, "_raw_settings", lambda: {"comfy_concurrency": 1})
    identity = comfy._ComfyIdentity(("a@example.test", None), "a@example.test", None, "1" * 32, "2" * 16, {"comfy_concurrency": 1}, False)
    monkeypatch.setattr(comfy, "_comfy_request_scope", lambda request: nullcontext(replace(identity, settings=comfy._raw_settings())))
    monkeypatch.setattr(comfy.run_journal, "read", lambda *_: [])
    monkeypatch.setattr(comfy, "update_in_progress", lambda: False)
    monkeypatch.setattr(comfy, "threading", SimpleNamespace(Thread=NoExecutionThread))
    monkeypatch.setattr(comfy, "_forget_inflight_run", Mock())
    monkeypatch.setattr(comfy_run_keys.repo, "get_setting", lambda key: state.settings.get(key))
    monkeypatch.setattr(comfy_run_keys.repo, "set_setting", lambda key, value: state.settings.__setitem__(key, value))
    monkeypatch.setattr(comfy_run_keys, "LOCK", threading.Lock())

    def stage(files):  # 파일 이름·바이트를 그대로 임시 파일로(크기가 같아도 내용이 다르면 다른 요청)
        uploads = []
        for index, (name, data) in enumerate(files):
            path = tmp_path / f"staged-{len(state.staged)}-{index}.bin"
            path.write_bytes(data)
            uploads.append(comfy._MediaUpload(name, path, len(data)))
        state.staged.append(uploads)
        return uploads

    monkeypatch.setattr(comfy, "_stage_media_uploads", stage)
    return state


def run(run_key=KEY, media=(), headers=()):
    request = Request({"type": "http", "headers": [(k.lower().encode(), v.encode()) for k, v in headers], "client": ("127.0.0.1", 1)})
    return comfy.run(request=request, content='{"1":{"class_type":"SaveImage","inputs":{}}}', param_values="{}",
                     media_meta="[]" if not media else '[{"type":"image"}]', media=list(media), run_key=run_key)


def test_same_key_same_content_returns_first_job_without_second_execution(admission):
    first = run(media=[("a.png", b"AAAA")])
    again = run(media=[("a.png", b"AAAA")])  # 응답을 잃고 다시 보냈다
    assert again == first
    assert admission.starts == [first["job_id"]]
    assert set(comfy._RUN_JOBS) == {first["job_id"]}  # 두 번째 접수의 임시 잡은 회수
    assert not any(upload.path.exists() for upload in admission.staged[1])  # 그 임시 파일도 정리


def test_same_key_with_same_size_but_different_bytes_is_rejected(admission):
    run(media=[("a.png", b"AAAA")])
    with pytest.raises(HTTPException) as error:
        run(media=[("a.png", b"BBBB")])
    assert error.value.status_code == 409 and "다른 내용" in error.value.detail
    assert len(admission.starts) == 1


def test_key_known_but_job_gone_after_restart_is_not_rerun(admission):
    run()
    comfy._RUN_JOBS.clear()  # 허브가 다시 켜졌다(메모리 잡이 없다)
    with pytest.raises(HTTPException) as error:
        run()
    assert error.value.status_code == 409 and "이미 접수" in error.value.detail
    assert "미해결" not in error.value.detail
    assert len(admission.starts) == 1


def test_without_key_old_behavior_runs_each_time(admission):
    run(run_key="")
    run(run_key="")
    assert len(admission.starts) == 2


def test_key_older_than_retention_is_a_new_request(admission, monkeypatch):
    run()
    real_time = time.time
    monkeypatch.setattr(comfy_run_keys.time, "time", lambda: real_time() + comfy_run_keys.KEEP_SEC + 1)
    run()
    assert len(admission.starts) == 2


def test_invalid_key_and_account_change_and_broken_ledger_are_refused_before_running(admission):
    with pytest.raises(HTTPException) as bad:
        run(run_key="not-a-uuid")
    assert bad.value.status_code == 422
    with pytest.raises(HTTPException) as moved:
        run(headers=[("X-MVHub-Expect-Account", "acct:b@example.test")])  # 그사이 다른 계정으로 바뀌었다
    assert moved.value.status_code == 409 and "계정" in moved.value.detail
    assert run(headers=[("X-MVHub-Expect-Account", "acct:A@Example.test")])["job_id"]  # 같은 계정(대소문자 무관)은 통과
    admission.settings[comfy_run_keys.KEY] = "{망가짐"
    with pytest.raises(HTTPException) as broken:
        run(run_key="223e4567-e89b-42d3-a456-426614174000")
    assert broken.value.status_code == 409 and "실행하지 않았습니다" in broken.value.detail
    assert len(admission.starts) == 1
    assert len(comfy._RUN_JOBS) == 1  # 거절한 접수의 잡은 남지 않는다

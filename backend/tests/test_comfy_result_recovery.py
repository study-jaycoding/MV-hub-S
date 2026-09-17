"""Comfy 결과 회수의 완료 관측·전송·복사 경계. 외부 서버/유료 실행 없음."""

import http.client
import io
import socket
import ssl
import urllib.error
from collections import deque
from contextlib import contextmanager
from types import SimpleNamespace
from unittest.mock import Mock

import pytest

from app.routers import comfy
from app.services import comfy_client


@pytest.fixture
def run_memory(monkeypatch):
    values = {}
    monkeypatch.setattr(comfy, "_RUN_JOBS", {})
    monkeypatch.setattr(comfy.repo, "get_setting", lambda key, default=None: values.get(key, default))
    monkeypatch.setattr(comfy.repo, "set_setting", lambda key, value: values.__setitem__(key, value))
    job_id = comfy._create_run_job()
    monkeypatch.setattr(comfy.comfy_client, "cloud_cancel_pending", Mock())
    monkeypatch.setattr(comfy.time, "sleep", lambda _seconds: None)
    return job_id


@pytest.mark.parametrize("status,kind", [("completed", "success"), ("failed", "failure")])
def test_cloud_terminal_is_in_memory_before_detail(run_memory, monkeypatch, status, kind):
    job_id = run_memory
    monkeypatch.setattr(comfy.comfy_client, "cloud_job_status", lambda *_: status)
    observed = []

    def detail(*_args):
        observed.append(dict(comfy._RUN_JOBS[job_id]))
        raise comfy_client.ComfyError("synthetic detail unavailable")

    monkeypatch.setattr(comfy.comfy_client, "cloud_job_detail", detail)
    with pytest.raises(comfy_client.ComfyError):
        comfy._wait({"cloud": True}, "synthetic-prompt", job_id)
    assert observed
    assert all(row.get("remote_terminal_observed") for row in observed)
    assert all(row.get("terminal_kind") == kind for row in observed)
    comfy.comfy_client.cloud_cancel_pending.assert_not_called()


@pytest.mark.parametrize("terminal_kind", ["success", "failure"])
def test_terminal_memory_blocks_remote_cancel_even_without_journal(run_memory, terminal_kind):
    comfy._update_run_job(
        run_memory, prompt_id="synthetic-prompt", remote_terminal_observed=True,
        terminal_kind=terminal_kind,
    )
    comfy._cancel_remote_run({"cloud": True}, "synthetic-prompt", "synthetic failure", run_memory)
    comfy.comfy_client.cloud_cancel_pending.assert_not_called()
    assert not comfy._RUN_JOBS[run_memory]["cancel_attempted"]


def test_completed_detail_retries_four_attempts_without_submit_or_cancel(run_memory, monkeypatch):
    sleeps = []
    detail = Mock(side_effect=[
        comfy_client.ComfyError("synthetic transient detail") for _ in range(3)
    ] + [{"outputs": {}}])
    monkeypatch.setattr(comfy.time, "sleep", sleeps.append)
    monkeypatch.setattr(comfy.comfy_client, "cloud_job_status", lambda *_: "completed")
    monkeypatch.setattr(comfy.comfy_client, "cloud_job_detail", detail)
    monkeypatch.setattr(comfy.comfy_client, "submit", Mock(side_effect=AssertionError("Never resubmit")))
    assert comfy._wait({"cloud": True}, "synthetic-prompt", run_memory) == {"outputs": {}}
    assert detail.call_count == 4
    assert sleeps == [2.0, 4.0, 8.0]
    comfy.comfy_client.submit.assert_not_called()
    comfy.comfy_client.cloud_cancel_pending.assert_not_called()


@pytest.mark.parametrize("status,kind", [
    ({"completed": True}, "success"),
    ({"status_str": "success"}, "success"),
    ({"status_str": "error"}, "failure"),
])
def test_local_terminal_kind_is_recorded_before_result_or_error(run_memory, monkeypatch, status, kind):
    entry = {"status": status, "outputs": {}}
    monkeypatch.setattr(comfy.comfy_client, "get_history", lambda *_: entry)
    if kind == "failure":
        with pytest.raises(comfy_client.ComfyError):
            comfy._wait({"cloud": False}, "synthetic-prompt", run_memory)
    else:
        assert comfy._wait({"cloud": False}, "synthetic-prompt", run_memory) == entry
    assert comfy._RUN_JOBS[run_memory].get("remote_terminal_observed") is True
    assert comfy._RUN_JOBS[run_memory].get("terminal_kind") == kind


def test_submit_only_opts_out_of_redirects(monkeypatch):
    request = Mock(return_value=(200, b'{"prompt_id":"synthetic-prompt"}'))
    monkeypatch.setattr(comfy_client, "_request", request)
    target = comfy_client.make_target({"comfy_target": "cloud", "comfy_api_key": "synthetic-key"})
    assert comfy_client.submit(target, {"1": {}}) == "synthetic-prompt"
    assert request.call_args.kwargs.get("follow_redirects") is False
    request.reset_mock()
    request.return_value = (200, b'{"status":"completed"}')
    assert comfy_client.cloud_job_status(target, "synthetic-prompt") == "completed"
    assert request.call_args.kwargs.get("follow_redirects", True) is True


@pytest.mark.parametrize("code", [401, 403, 404, 410, 503])
def test_signed_output_response_preserves_provider_status(monkeypatch, code):
    redirect = urllib.error.HTTPError("http://synthetic.invalid/view", 302, "redirect",
                                      {"Location": "https://storage.synthetic.invalid/output"}, io.BytesIO())
    rejected = urllib.error.HTTPError("https://storage.synthetic.invalid/output", code, "synthetic", {}, io.BytesIO(b"synthetic"))
    monkeypatch.setattr(comfy_client, "_NO_REDIRECT_OPENER", SimpleNamespace(open=Mock(side_effect=redirect)))
    monkeypatch.setattr(comfy_client, "assert_public_http_url", lambda _url: None)
    monkeypatch.setattr(comfy_client, "guarded_opener", lambda: SimpleNamespace(open=Mock(side_effect=rejected)))
    with pytest.raises(comfy_client.ComfyError) as error:
        with comfy_client._open_view_stream({"base": "http://synthetic.invalid", "prefix": "", "headers": {}}, {}):
            pytest.fail("Synthetic rejection cannot yield an output stream")
    assert error.value.status_code == code and error.value.auth_error == (code in (401, 403))


@pytest.mark.parametrize("code", [301, 302, 303, 307, 308, 400, 401, 402, 403, 404, 429, 500, 502])
def test_submit_http_errors_keep_status_without_claiming_not_submitted(monkeypatch, code):
    monkeypatch.setattr(comfy_client, "_request", lambda *_args, **_kwargs: (code, b"synthetic response"))
    with pytest.raises(comfy_client.ComfyError) as error:
        comfy_client.submit({"base": "http://synthetic.invalid", "prefix": "", "headers": {}}, {"1": {}})
    assert error.value.status_code == code
    assert error.value.auth_error == (code in (401, 402, 403))
    assert error.value.cause_kind not in ("dns", "connect_refused", "tls_cert", "scheme")


@pytest.mark.parametrize("body", [b"null", b"[]", b"{}", b'{"prompt_id":""}', b'{"prompt_id":3}', b"\xff", b"not-json"])
def test_malformed_submit_response_is_a_structured_unknown_error(monkeypatch, body):
    monkeypatch.setattr(comfy_client, "_request", lambda *_args, **_kwargs: (200, body))
    with pytest.raises(comfy_client.ComfyError) as error:
        comfy_client.submit({"base": "http://synthetic.invalid", "prefix": "", "headers": {}}, {"1": {}})
    assert error.value.cause_kind in ("body_decode", "body_shape")


@pytest.mark.parametrize(
    "reason,expected",
    [
        (socket.gaierror("synthetic DNS"), "dns"),
        (ConnectionRefusedError("synthetic refused"), "connect_refused"),
        (ssl.SSLCertVerificationError("synthetic certificate"), "tls_cert"),
        (ssl.SSLError("synthetic TLS after send"), "transport"),
        (ssl.SSLEOFError("synthetic TLS EOF"), "transport"),
        (ConnectionResetError("synthetic reset"), "transport"),
        (BrokenPipeError("synthetic broken pipe"), "transport"),
        (TimeoutError("synthetic read timeout"), "timeout"),
    ],
)
def test_transport_cause_retains_only_narrow_pre_send_evidence(monkeypatch, reason, expected):
    monkeypatch.setattr(comfy_client.urllib.request, "urlopen", Mock(side_effect=urllib.error.URLError(reason)))
    with pytest.raises(comfy_client.ComfyError) as error:
        comfy_client._request("POST", "http://synthetic.invalid/prompt", json_body={})
    assert error.value.cause_kind == expected


class _PiecewiseRaw(io.RawIOBase):
    """HTTPResponse 내부 실제 read 수를 세는 메모리 소켓. 대기/네트워크 없음."""

    def __init__(self, pieces):
        super().__init__()
        self.pieces = deque(pieces)
        self.read_count = 0
        self.clock = 0.0

    def readable(self):
        return True

    def readinto(self, buffer):
        if not self.pieces:
            return 0
        self.read_count += 1
        self.clock += 1.0
        part = self.pieces.popleft()
        size = min(len(buffer), len(part))
        buffer[:size] = part[:size]
        if size < len(part):
            self.pieces.appendleft(part[size:])
        return size


def _chunked_response(trailers):
    raw = _PiecewiseRaw([
        b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n",
        b"1\r\n", b"A", b"\r\n", b"0\r\n",
        *[f"X-Synthetic-{index}: value\r\n".encode() for index in range(trailers)], b"\r\n",
    ])
    buffered = io.BufferedReader(raw, buffer_size=128)
    response = http.client.HTTPResponse(SimpleNamespace(makefile=lambda _mode: buffered))
    response.begin()
    raw.clock = 0.0
    return response, raw


@pytest.mark.parametrize("trailers", [1, 8, 32])
def test_real_httpresponse_read1_may_consume_many_trailer_reads(trailers):
    response, raw = _chunked_response(trailers)
    try:
        assert response.read1(65536) == b"A"
        before = raw.read_count
        assert response.read1(65536) == b""
        assert raw.read_count - before >= trailers + 2
    finally:
        response.close()
    assert raw.closed


def test_soft_deadline_is_checked_at_copy_loop_boundary(monkeypatch):
    calls = []
    clock = [0.0]

    class Drip:
        def read1(self, size):
            calls.append(size)
            clock[0] += 2.0
            return b"synthetic"

    monkeypatch.setattr(comfy_client.time, "monotonic", lambda: clock[0])
    with pytest.raises(comfy_client.ComfyError):
        comfy_client._copy_stream_deadline(Drip(), io.BytesIO(), 1.0)
    assert calls == [64 * 1024]


def test_real_trailer_read_can_overrun_soft_deadline_inside_one_call(monkeypatch):
    response, raw = _chunked_response(8)
    monkeypatch.setattr(comfy_client.time, "monotonic", lambda: raw.clock)
    try:
        # First body read finishes before budget; the terminal read consumes all
        # trailers before returning. This is intentionally NOT a hard deadline.
        comfy_client._copy_stream_deadline(response, io.BytesIO(), 3.0)
        assert raw.clock > 3.0
        assert not raw.pieces
    finally:
        response.close()
    assert raw.closed


def test_download_without_deadline_keeps_legacy_read_only_stream(monkeypatch, tmp_path):
    payload = b"synthetic legacy output"

    class ReadOnlyStream:
        headers = {"Content-Length": str(len(payload))}

        def __init__(self):
            self.data = io.BytesIO(payload)

        def read(self, size=-1):
            return self.data.read(size)

    @contextmanager
    def opened(*_args):
        yield ReadOnlyStream()

    monkeypatch.setattr(comfy_client, "_open_view_stream", opened)
    target = tmp_path / "output.png"
    comfy_client.download_view({}, {}, target)
    assert target.read_bytes() == payload
    assert not list(tmp_path.glob("*.part"))


def test_expired_soft_budget_starts_no_read(monkeypatch):
    stream = Mock()
    monkeypatch.setattr(comfy_client.time, "monotonic", lambda: 10.0)
    with pytest.raises(comfy_client.ComfyError):
        comfy_client._copy_stream_deadline(stream, io.BytesIO(), 10.0)
    stream.read1.assert_not_called()
    stream.read.assert_not_called()


def test_deadline_stream_without_read1_uses_read_fallback(monkeypatch):
    stream = SimpleNamespace(read=Mock(side_effect=[b"synthetic", b""]))
    monkeypatch.setattr(comfy_client.time, "monotonic", lambda: 0.0)
    output = io.BytesIO()
    comfy_client._copy_stream_deadline(stream, output, 10.0)
    assert output.getvalue() == b"synthetic"
    assert stream.read.call_count == 2


def test_deadline_download_failure_preserves_destination_and_removes_part(monkeypatch, tmp_path):
    clock = [0.0]

    class Drip:
        headers = {}

        def read1(self, _size):
            clock[0] += 2.0
            return b"partial"

    @contextmanager
    def opened(*_args):
        yield Drip()

    monkeypatch.setattr(comfy_client, "_open_view_stream", opened)
    monkeypatch.setattr(comfy_client.time, "monotonic", lambda: clock[0])
    target = tmp_path / "output.png"
    target.write_bytes(b"original complete synthetic output")
    with pytest.raises(comfy_client.ComfyError):
        comfy_client.download_view({}, {}, target, deadline=1.0)
    assert target.read_bytes() == b"original complete synthetic output"
    assert not list(tmp_path.glob("*.part"))

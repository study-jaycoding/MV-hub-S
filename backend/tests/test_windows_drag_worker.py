"""Real temporary IPC children and fake WinAPI only; never start an OS drag."""

from contextlib import contextmanager
import importlib.util
import json
from pathlib import Path
import queue
import subprocess
import sys
import threading
import time
from types import SimpleNamespace

import pytest


_SOURCE = Path(__file__).resolve().parents[1] / "app" / "services" / "windows_drag.py"
_SPEC = importlib.util.spec_from_file_location("windows_drag_worker_under_test", _SOURCE)
native = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(native)
_POPEN = subprocess.Popen


@pytest.fixture
def workers(tmp_path, monkeypatch):
    created = []
    python = [sys.executable]
    source = [""]
    captured = []

    def capture():
        captured.append(True)
        return (1, 2, 3)

    def launch(command, **kwargs):
        assert command == [sys.executable, str(_SOURCE)]
        script = tmp_path / f"worker-{len(created)}.py"
        script.write_text("import json, sys, time\nfrom pathlib import Path\n" + source[0], encoding="utf-8")
        child = _POPEN([python[0], "-u", str(script)], **kwargs)
        created.append(child)
        return child

    monkeypatch.setattr(native, "capture_source", capture)
    monkeypatch.setattr(native, "_gesture_state", lambda: (True, False, True))
    monkeypatch.setattr(native.subprocess, "Popen", launch)
    monkeypatch.setattr(native, "CANCEL_SECONDS", 0.12)
    monkeypatch.setattr(native, "TRACKING_SECONDS", 5)
    yield SimpleNamespace(source=source, created=created, captured=captured, directory=tmp_path, python=python)
    for child in created:
        if child.poll() is None:
            child.kill()
        child.wait(timeout=3)
        for stream in (child.stdin, child.stdout):
            if stream and not stream.closed:
                stream.close()


def _success_worker(record=None):
    store = f"Path({str(record)!r}).write_text(json.dumps(request), encoding='utf-8')\n" if record else ""
    return (
        "request = json.loads(sys.stdin.readline())\n" + store +
        "print(json.dumps({'event': 'drop'}), flush=True)\n"
        "assert json.loads(sys.stdin.readline()) == {'event': 'drop'}\n"
        "print(json.dumps({'event': 'result', 'dropped': True}), flush=True)\n"
    )


@contextmanager
def _cancel_when_created(marker, cancelled):
    stop = threading.Event()

    def watch():
        deadline = time.monotonic() + 3
        while not stop.is_set() and time.monotonic() < deadline:
            if marker.exists():
                cancelled.set()
                return
            stop.wait(0.005)
        if not stop.is_set():
            cancelled.set()

    thread = threading.Thread(target=watch, daemon=True)
    thread.start()
    try:
        yield
    finally:
        stop.set()
        thread.join(timeout=1)
        assert not thread.is_alive()


def _drag(cancelled=None, **kwargs):
    return native.drag_files(["one.png", "two.png"], '[{"path":"one.png"},{"path":"two.png"}]',
                             int(time.time() * 1000), cancelled or threading.Event(), **kwargs)


def test_parent_passes_originals_and_acknowledges_drop_then_reaps_child(workers):
    record = workers.directory / "request.json"
    workers.source[0] = _success_worker(record)
    assert _drag() is True
    request = json.loads(record.read_text(encoding="utf-8"))
    assert request["paths"] == ["one.png", "two.png"]
    assert json.loads(request["payload"]) == [{"path": "one.png"}, {"path": "two.png"}]
    assert request["source"] == [1, 2, 3]
    assert workers.captured == [True]
    assert workers.created[0].returncode == 0
    assert workers.created[0].stdin.closed and workers.created[0].stdout.closed


def test_cancelled_stuck_child_is_exited_before_return_and_next_drag_works(workers):
    ready, command = workers.directory / "ready", workers.directory / "cancel.json"
    workers.source[0] = (
        "json.loads(sys.stdin.readline())\n"
        f"Path({str(ready)!r}).write_text('ready')\n"
        f"Path({str(command)!r}).write_text(sys.stdin.readline())\n"
        "time.sleep(5)\n"
    )
    cancelled = threading.Event()
    with _cancel_when_created(ready, cancelled), pytest.raises(OSError, match="cancellation"):
        _drag(cancelled)
    old = workers.created[0]
    assert old.poll() is not None and old.returncode != 0
    assert old.stdin.closed and old.stdout.closed
    assert json.loads(command.read_text()) == {"event": "cancel"}
    workers.source[0] = _success_worker()
    assert _drag() is True
    assert workers.created[1].pid != old.pid and workers.created[1].returncode == 0


def test_parent_refuses_drop_ack_after_cancellation(workers):
    ready, answer = workers.directory / "ready", workers.directory / "answer.json"
    workers.source[0] = (
        "json.loads(sys.stdin.readline())\n"
        f"Path({str(ready)!r}).write_text('ready')\n"
        "assert json.loads(sys.stdin.readline()) == {'event': 'cancel'}\n"
        "print(json.dumps({'event': 'drop'}), flush=True)\n"
        "answer = json.loads(sys.stdin.readline())\n"
        f"Path({str(answer)!r}).write_text(json.dumps(answer))\n"
        "print(json.dumps({'event': 'result', 'dropped': answer['event'] == 'drop'}), flush=True)\n"
    )
    cancelled = threading.Event()
    with _cancel_when_created(ready, cancelled):
        assert _drag(cancelled) is False
    assert json.loads(answer.read_text()) == {"event": "cancel"}
    assert workers.created[0].returncode == 0


def test_mouse_release_cancels_a_helper_that_never_requests_drop(workers, monkeypatch):
    workers.source[0] = (
        "json.loads(sys.stdin.readline())\n"
        "assert json.loads(sys.stdin.readline()) == {'event': 'cancel'}\n"
        "print(json.dumps({'event':'result','dropped':False}), flush=True)\n"
    )
    monkeypatch.setattr(native, "_gesture_state", lambda: (False, False, True))
    monkeypatch.setattr(native, "RELEASE_SECONDS", 0.06)
    assert _drag() is False
    assert workers.created[0].returncode == 0


def test_pressing_again_does_not_rearm_a_released_gesture(workers, monkeypatch):
    calls = []
    def state():
        calls.append(True)
        return (len(calls) != 2, False, True)
    workers.source[0] = (
        "json.loads(sys.stdin.readline())\n"
        "assert json.loads(sys.stdin.readline()) == {'event': 'cancel'}\n"
        "print(json.dumps({'event':'result','dropped':False}), flush=True)\n"
    )
    monkeypatch.setattr(native, "_gesture_state", state)
    monkeypatch.setattr(native, "RELEASE_SECONDS", 0.03)
    assert _drag() is False
    assert len(calls) < 10


def test_cancel_after_ack_does_not_kill_an_external_drop_in_progress(workers):
    acknowledged = workers.directory / "acknowledged"
    workers.source[0] = (
        "json.loads(sys.stdin.readline())\n"
        "print(json.dumps({'event': 'drop'}), flush=True)\n"
        "assert json.loads(sys.stdin.readline()) == {'event': 'drop'}\n"
        f"Path({str(acknowledged)!r}).write_text('acknowledged')\n"
        "time.sleep(0.3)\n"
        "print(json.dumps({'event': 'result', 'dropped': True}), flush=True)\n"
    )
    cancelled = threading.Event()
    with _cancel_when_created(acknowledged, cancelled):
        assert _drag(cancelled) is True
    assert cancelled.is_set()
    assert workers.created[0].returncode == 0


@pytest.mark.parametrize("output", ["print('invalid-json', flush=True)\n", "sys.exit(7)\n"])
def test_invalid_or_failed_helper_is_reaped_and_not_reported_as_a_drop(workers, output):
    workers.source[0] = "json.loads(sys.stdin.readline())\n" + output
    with pytest.raises(OSError, match="helper failed"):
        _drag()
    assert workers.created[0].poll() is not None
    assert workers.created[0].stdin.closed and workers.created[0].stdout.closed


def test_cancelled_expired_or_unavailable_source_never_spawns(workers, monkeypatch):
    cancelled = threading.Event()
    cancelled.set()
    assert _drag(cancelled) is False
    with pytest.raises(TimeoutError):
        native.drag_files(["one.png"], "[]", 0, threading.Event())
    monkeypatch.setattr(native, "capture_source", lambda: None)
    assert _drag() is False
    assert workers.created == []


def test_captured_source_is_forwarded_without_recapturing_after_file_preparation(workers):
    record = workers.directory / "request.json"
    workers.source[0] = _success_worker(record)
    assert _drag(source=(11, 22, 33)) is True
    assert workers.captured == []
    assert json.loads(record.read_text())["source"] == [11, 22, 33]


@pytest.mark.parametrize("acknowledge", [False, True])
def test_real_worker_handshake_cannot_enter_drop_without_parent_ack(tmp_path, acknowledge):
    entered = tmp_path / "entered-drop"
    script = tmp_path / "worker_handshake.py"
    script.write_text(
        "import importlib.util\nfrom pathlib import Path\n"
        f"spec = importlib.util.spec_from_file_location('native_worker', {_SOURCE.as_posix()!r})\n"
        "native = importlib.util.module_from_spec(spec)\nspec.loader.exec_module(native)\n"
        "def controlled(_paths, _payload, _started, _cancelled, _source, approve_drop):\n"
        "    if not approve_drop(): return False\n"
        f"    Path({str(entered)!r}).write_text('entered after acknowledgement')\n"
        "    return True\n"
        "native._drag_files_on_thread = controlled\nnative._run_worker()\n", encoding="utf-8")
    child = _POPEN([sys.executable, "-u", str(script)], stdin=subprocess.PIPE,
                   stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, encoding="utf-8")
    try:
        child.stdin.write(json.dumps({"paths": ["one.png"], "payload": "[]", "started": 0, "source": [1, 2, 3]}) + "\n")
        child.stdin.flush()
        lines = queue.Queue()
        reader = threading.Thread(target=lambda: lines.put(child.stdout.readline()), daemon=True)
        reader.start()
        assert json.loads(lines.get(timeout=3)) == {"event": "drop"}
        reader.join(timeout=1)
        assert not entered.exists()
        if acknowledge:
            child.stdin.write('{"event":"drop"}\n')
            child.stdin.flush()
        child.wait(timeout=3)
        assert child.returncode == 0, child.stderr.read()
        result = json.loads(child.stdout.read())
        assert result == {"event": "result", "dropped": acknowledge}
        assert entered.exists() is acknowledge
    finally:
        if child.poll() is None:
            child.kill()
        child.wait(timeout=3)
        for stream in (child.stdin, child.stdout, child.stderr):
            stream.close()


@pytest.mark.parametrize("ending", ["normal", "error", "early_detach", "changed_after_attach"])
def test_input_queue_is_created_before_attach_and_always_detached(monkeypatch, ending):
    calls = []
    expected = (1, 2, 3)
    lookups = iter([expected, (9, 8, 7) if ending == "changed_after_attach" else expected])
    monkeypatch.setattr(native, "_source_window", lambda _api: next(lookups))
    api = SimpleNamespace(
        kernel=SimpleNamespace(GetCurrentThreadId=lambda: 77),
        user=SimpleNamespace(
            PeekMessageW=lambda *_args: calls.append("queue") or 0,
            AttachThreadInput=lambda *args: calls.append(args) or 1,
        ),
    )
    if ending == "changed_after_attach":
        with pytest.raises(InterruptedError, match="source changed"):
            with native._input_queue(api, expected):
                pytest.fail("changed source must not enter the drag")
    elif ending == "error":
        with pytest.raises(RuntimeError, match="body failed"):
            with native._input_queue(api, expected):
                raise RuntimeError("body failed")
    else:
        with native._input_queue(api, expected) as detach:
            if ending == "early_detach":
                detach()
                detach()
    assert calls == ["queue", (77, 2, True), (77, 2, False)]


def test_input_queue_rejects_changed_source_before_attaching(monkeypatch):
    calls = []
    monkeypatch.setattr(native, "_source_window", lambda _api: (9, 8, 7))
    api = SimpleNamespace(kernel=SimpleNamespace(GetCurrentThreadId=lambda: 77), user=SimpleNamespace(
        PeekMessageW=lambda *_args: 0, AttachThreadInput=lambda *args: calls.append(args) or 1))
    with pytest.raises(InterruptedError):
        with native._input_queue(api, (1, 2, 3)):
            pytest.fail("changed source must not enter the drag")
    assert calls == []


def test_large_request_to_nonreading_child_is_cancelled_and_writer_is_joined(workers, monkeypatch):
    workers.source[0] = "time.sleep(5)\n"
    monkeypatch.setattr(native, "TRACKING_SECONDS", 0.05)
    monkeypatch.setattr(native, "CANCEL_SECONDS", 0.1)
    threads, killed_while_writing, guard_fired = [], [], []
    writing, guard_stop = threading.Event(), threading.Event()
    thread_type = threading.Thread

    def make_thread(**kwargs):
        thread = thread_type(**kwargs)
        threads.append(thread)
        return thread

    monkeypatch.setattr(native, "threading", SimpleNamespace(Thread=make_thread))
    launch = native.subprocess.Popen

    def observed_launch(*args, **kwargs):
        child = launch(*args, **kwargs)
        stream, kill = child.stdin, child.kill

        class Input:
            def write(self, value):
                writing.set()
                return stream.write(value)

            def flush(self):
                return stream.flush()

            def close(self):
                return stream.close()

            @property
            def closed(self):
                return stream.closed

        def observed_kill():
            killed_while_writing.append(writing.is_set() and len(threads) == 2 and threads[1].is_alive())
            return kill()

        child.stdin, child.kill = Input(), observed_kill
        return child

    monkeypatch.setattr(native.subprocess, "Popen", observed_launch)

    def watchdog():
        if not guard_stop.wait(2):
            guard_fired.append(True)
            for child in workers.created:
                if child.poll() is None:
                    child.kill()

    guard = thread_type(target=watchdog, daemon=True)
    guard.start()
    started = time.monotonic()
    try:
        with pytest.raises(OSError, match="cancellation"):
            native.drag_files(["one.png"], "x" * (2 * 1024 * 1024), int(time.time() * 1000), threading.Event())
    finally:
        guard_stop.set()
        guard.join(timeout=1)
    assert time.monotonic() - started < 2
    assert not guard_fired and not guard.is_alive()
    assert killed_while_writing == [True]
    assert len(threads) == 2 and all(not thread.is_alive() for thread in threads)
    assert workers.created[0].poll() is not None


@pytest.mark.parametrize("output,direct_python", [
    ("print('invalid-json', flush=True)", False),
    ("print('x' * 600, flush=True)", False),
    ("print('[]', flush=True)", False),
    ("print('{\"event\":\"unexpected\"}', flush=True)", False),
    ("print('{\"event\":\"result\",\"dropped\":\"yes\"}', flush=True)", False),
    ("print('{\"event\":\"result\",\"dropped\":true}', flush=True)", False),
    ("__import__('os').close(sys.stdout.fileno())", True),
    ("print('{\"event\":\"result\",\"dropped\":false}', flush=True); __import__('os').close(sys.stdout.fileno())", False),
    ("print('{\"event\":\"result\",\"dropped\":false}', flush=True)", False),
])
def test_protocol_failure_reaps_a_live_child_without_waiting_for_its_exit(workers, output, direct_python):
    if direct_python:
        # The venv redirector itself retains stdout; use the packaged-runtime shape for EOF cases.
        workers.python[0] = sys._base_executable
    ready = workers.directory / "protocol-sent"
    workers.source[0] = (
        "json.loads(sys.stdin.readline())\n"
        f"Path({str(ready)!r}).write_text('ready')\n" + output + "\n"
        "time.sleep(5)\n"
    )
    stop, watchdog_fired = threading.Event(), []

    def watchdog():
        deadline = time.monotonic() + 10
        while not ready.exists() and not stop.wait(.01) and time.monotonic() < deadline:
            pass
        if ready.exists() and not stop.wait(.8):
            watchdog_fired.append(True)
            for child in workers.created:
                if child.poll() is None:
                    child.kill()

    guard = threading.Thread(target=watchdog, daemon=True)
    guard.start()
    try:
        with pytest.raises(OSError, match="helper failed"):
            _drag()
    finally:
        stop.set()
        guard.join(timeout=1)
    assert not watchdog_fired and not guard.is_alive()
    assert workers.created[0].poll() is not None
    assert workers.created[0].stdin.closed and workers.created[0].stdout.closed


def test_after_ack_protocol_error_waits_for_drop_completion_without_killing_child(workers):
    completed = workers.directory / "completed-drop"
    workers.source[0] = (
        "json.loads(sys.stdin.readline())\n"
        "print(json.dumps({'event': 'drop'}), flush=True)\n"
        "assert json.loads(sys.stdin.readline()) == {'event': 'drop'}\n"
        "print('[]', flush=True)\n"
        "time.sleep(0.3)\n"
        f"Path({str(completed)!r}).write_text('external drop completed')\n"
    )
    with pytest.raises(OSError, match="missing result"):
        _drag()
    assert completed.read_text() == "external drop completed"
    assert workers.created[0].returncode == 0
    assert workers.created[0].stdin.closed and workers.created[0].stdout.closed


def test_after_ack_terminal_result_reaps_child_that_does_not_exit(workers):
    workers.python[0] = sys._base_executable
    workers.source[0] = _success_worker() + "time.sleep(5)\n"
    stopped = threading.Event()
    watchdog_fired = []

    def watchdog():
        if not stopped.wait(2):
            watchdog_fired.append(True)
            for child in workers.created:
                if child.poll() is None:
                    child.kill()

    guard = threading.Thread(target=watchdog, daemon=True)
    guard.start()
    try:
        with pytest.raises(OSError, match="did not exit after its result"):
            _drag()
    finally:
        stopped.set()
        guard.join(timeout=1)
    assert not watchdog_fired and not guard.is_alive()
    assert workers.created[0].poll() is not None
    assert workers.created[0].stdin.closed and workers.created[0].stdout.closed

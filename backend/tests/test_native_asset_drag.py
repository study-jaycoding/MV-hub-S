import asyncio
import ctypes as ct
from contextlib import contextmanager
import json
from pathlib import Path
import struct
import sys
import threading
import time
from types import SimpleNamespace
from unittest.mock import patch

from fastapi import HTTPException
from pydantic import ValidationError
import pytest
from starlette.requests import Request

from app import active_account
from app.routers import assets
from app.services import windows_drag as native

_REAL_SAFE_PROJECT_DIR = assets._safe_project_dir
_REAL_CAPTURE_ACCOUNT_PIN = active_account.capture_account_pin


def request(client="127.0.0.1", origin="http://127.0.0.1:5173", expected="local", disconnected=None):
    async def receive():
        if disconnected is not None and disconnected.is_set():
            return {"type": "http.disconnect"}
        return {"type": "http.request", "body": b"", "more_body": False}
    return Request({"type": "http", "method": "POST", "path": "/api/assets/native-drag",
                    "client": (client, 1234), "headers": [(b"host", b"127.0.0.1:8012"),
                    (b"origin", origin.encode()), (b"x-mvhub-expect-account", expected.encode())]}, receive)


@pytest.fixture
def env(tmp_path, monkeypatch):
    monkeypatch.setattr(assets, "AUTH_ENABLED", False)
    monkeypatch.setattr(assets, "_native_drag_lock", threading.Lock())
    monkeypatch.setattr("app.active_account.active_email", lambda: "")
    monkeypatch.setattr("app.active_account.capture_account_pin", lambda: ("", None))
    monkeypatch.setattr(assets, "_safe_project_dir", lambda project, req: tmp_path if project == "P" else None)
    monkeypatch.setattr(native, "available", lambda: True)
    monkeypatch.setattr(native, "capture_source", lambda: (1, 2, 3))
    with patch.object(native, "drag_files", return_value=True) as drag:
        yield tmp_path, drag


def body(paths, **kwargs):
    return assets.NativeDragIn(project="P", paths=paths, started_at_ms=int(time.time() * 1000), **kwargs)


def test_three_files_are_ordered_and_not_zipped(env):
    folder, drag = env
    for name in ("third.png", "first.png", "second.jpg"):
        (folder / name).write_bytes(name.encode())
    result = asyncio.run(assets.native_drag(body(["third.png", "first.png", "second.jpg"]), request()))
    assert result == {"dropped": True}
    paths, payload, _ = drag.call_args.args[:3]
    assert [Path(path).name for path in paths] == ["third.png", "first.png", "second.jpg"]
    assert [item["path"] for item in json.loads(payload)] == ["third.png", "first.png", "second.jpg"]
    assert sorted(p.name for p in folder.iterdir()) == ["first.png", "second.jpg", "third.png"]


@pytest.mark.parametrize("bad", ["missing.png", "../escape.png", "not-media.txt"])
def test_invalid_member_rejects_whole_selection(env, bad):
    folder, drag = env
    (folder / "ok.png").write_bytes(b"original")
    (folder / "not-media.txt").write_bytes(b"text")
    with pytest.raises(HTTPException):
        asyncio.run(assets.native_drag(body(["ok.png", bad]), request()))
    drag.assert_not_called()


@pytest.mark.parametrize("args", [dict(client="192.0.2.7"), dict(origin="https://evil.example"), dict(expected="acct:other@example.test")])
def test_local_origin_and_account_guards_precede_drag(env, args):
    _, drag = env
    with pytest.raises(HTTPException) as error:
        asyncio.run(assets.native_drag(body(["a.png"]), request(**args)))
    assert error.value.status_code in (403, 409)
    drag.assert_not_called()


@pytest.mark.parametrize("after_switch", [("b@example.test", "uid-b"), ("a@example.test", "uid-a-new")])
def test_account_switch_and_aba_keep_header_and_files_on_the_same_pin(env, monkeypatch, after_switch):
    folder, drag = env
    original = ("a@example.test", "uid-a")
    current = [original]
    data = folder / "data"
    monkeypatch.setattr(active_account.config, "AUTH_ENABLED", False)
    monkeypatch.setattr(active_account.config, "DATA_DIR", data)
    monkeypatch.setattr(active_account, "_read_pointer", lambda: {"email": current[0][0], "uid": current[0][1]})
    monkeypatch.setattr(active_account, "capture_account_pin", _REAL_CAPTURE_ACCOUNT_PIN)
    monkeypatch.setattr(active_account, "active_email", active_account.account_key)
    roots = {}
    for email, _uid in (original, ("b@example.test", "uid-b")):
        root = folder / email[0]
        root.mkdir()
        (root / "a.png").write_bytes(email.encode())
        account_dir = active_account.account_dir(email)
        account_dir.mkdir(parents=True)
        (account_dir / "asset_mounts.json").write_text(json.dumps({"mounts": [
            {"name": "P", "path": str(root), "owner": assets.DEFAULT_WORKER_ID},
        ]}), encoding="utf-8")
        roots[email] = root
    seen = []
    def project_dir(project, req):
        assert active_account.transition_lock.acquire(blocking=False)
        active_account.transition_lock.release()
        seen.append((active_account.active_email(), active_account.active_uid()))
        return _REAL_SAFE_PROJECT_DIR(project, req)
    monkeypatch.setattr(assets, "_safe_project_dir", project_dir)
    expected_check = assets.expected_account_differs
    def switch_after_header(req, owner):
        assert owner == original[0]
        result = expected_check(req, owner)
        current[0] = ("b@example.test", "uid-b")
        current[0] = after_switch
        return result
    monkeypatch.setattr(assets, "expected_account_differs", switch_after_header)
    result = asyncio.run(assets.native_drag(body(["a.png"]), request(expected="acct:" + original[0])))
    assert result == {"dropped": True} and seen == [original]
    assert Path(drag.call_args.args[0][0]) == (roots[original[0]] / "a.png").resolve()
    assert active_account.active_email() == after_switch[0]


def test_over_limit_is_rejected_not_truncated():
    with pytest.raises(ValidationError):
        body([f"{index}.png" for index in range(21)])


def test_duplicate_path_is_not_duplicated(env):
    folder, drag = env
    (folder / "a.png").write_bytes(b"a")
    asyncio.run(assets.native_drag(body(["a.png", "a.png"]), request()))
    assert len(drag.call_args.args[0]) == 1


def test_expired_gesture_and_busy_drag_do_not_start(env):
    _, drag = env
    expired = body(["a.png"])
    expired.started_at_ms = 0
    assert asyncio.run(assets.native_drag(expired, request())) == {"dropped": False, "reason": "expired"}
    assets._native_drag_lock.acquire()
    try:
        with pytest.raises(HTTPException) as error:
            asyncio.run(assets.native_drag(body(["a.png"]), request()))
        assert error.value.status_code == 409
    finally:
        assets._native_drag_lock.release()
    drag.assert_not_called()


def test_failure_releases_lock_and_does_not_expose_os_path(env):
    folder, drag = env
    (folder / "a.png").write_bytes(b"a")
    drag.side_effect = OSError("private/path/should-not-leak")
    with pytest.raises(HTTPException) as error:
        asyncio.run(assets.native_drag(body(["a.png"]), request()))
    assert error.value.status_code == 503
    assert "private" not in error.value.detail
    assert assets._native_drag_lock.acquire(blocking=False)
    assets._native_drag_lock.release()


@pytest.mark.parametrize("ending", ["cancel", "disconnect"])
def test_request_ending_signals_worker_and_holds_lock_until_exit(env, ending):
    folder, drag = env
    (folder / "a.png").write_bytes(b"a")
    entered, cancelled_seen, finish, disconnected = (threading.Event() for _ in range(4))

    def worker(_paths, _payload, _started, cancelled, _source):
        entered.set()
        if cancelled.wait(2):
            cancelled_seen.set()
        assert finish.wait(2)
        return False

    drag.side_effect = worker

    async def run():
        task = asyncio.create_task(assets.native_drag(body(["a.png"]), request(disconnected=disconnected)))
        try:
            assert await asyncio.to_thread(entered.wait, 2)
            if ending == "cancel":
                task.cancel()
            else:
                disconnected.set()
            assert await asyncio.to_thread(cancelled_seen.wait, 2)
            assert assets._native_drag_lock.locked()
        finally:
            finish.set()
            if ending == "cancel":
                with pytest.raises(asyncio.CancelledError):
                    await task
            else:
                assert await task == {"dropped": False}
        assert not assets._native_drag_lock.locked()

    asyncio.run(run())


def test_cancelled_file_preparation_keeps_lock_and_skips_next_file(env, monkeypatch):
    folder, drag = env
    for name in ("first.png", "second.png"):
        (folder / name).write_bytes(b"original")
    entered, finish = threading.Event(), threading.Event()
    cancelled_holder, resolved = [], []
    prepare = assets._native_drag_files
    resolve = assets._safe_project_resolve
    def record_cancel(body, req, cancelled):
        cancelled_holder.append(cancelled)
        return prepare(body, req, cancelled)
    def blocked_resolve(project, directory, relative):
        resolved.append(relative)
        if relative == "first.png":
            entered.set()
            assert finish.wait(2)
        return resolve(project, directory, relative)
    monkeypatch.setattr(assets, "_native_drag_files", record_cancel)
    monkeypatch.setattr(assets, "_safe_project_resolve", blocked_resolve)
    async def run():
        task = asyncio.create_task(assets.native_drag(body(["first.png", "second.png"]), request()))
        try:
            assert await asyncio.to_thread(entered.wait, 2)
            task.cancel()
            assert await asyncio.to_thread(cancelled_holder[0].wait, 2)
            task.cancel()  # Repeated cancellation must not abandon the blocked worker.
            assert assets._native_drag_lock.locked() and not task.done()
            with pytest.raises(HTTPException) as error:
                await assets.native_drag(body(["second.png"]), request())
            assert error.value.status_code == 409 and resolved == ["first.png"]
        finally:
            finish.set()
            with pytest.raises(asyncio.CancelledError):
                await task
        assert not assets._native_drag_lock.locked()
    asyncio.run(run())
    assert resolved == ["first.png"]
    drag.assert_not_called()


def test_cancelled_shell_preparation_skips_next_pidl_and_releases_allocations(monkeypatch):
    event = threading.Event()
    parsed, freed, uninitialized = [], [], []
    def parse(path, _bind, output, _flags, _attrs):
        parsed.append(path)
        output._obj.value = 123
        event.set()
        return 0
    api = SimpleNamespace(
        ole=SimpleNamespace(OleInitialize=lambda _reserved: 0,
                            OleUninitialize=lambda: uninitialized.append(True),
                            CoTaskMemFree=lambda pidl: freed.append(pidl.value)),
        shell=SimpleNamespace(SHParseDisplayName=parse),
    )
    monkeypatch.setattr(native, "_api", lambda: api)
    with pytest.raises(InterruptedError):
        with native.data_object(["first.png", "second.png"], "[]", event):
            pytest.fail("cancelled preparation produced an IDataObject")
    assert parsed == ["first.png"] and freed == [123] and uninitialized == [True]


@pytest.mark.parametrize("cancelled,escape,keys,expected", [
    (False, False, 1, 0),
    (False, False, 0, 0x40100),
    (False, False, 2, 0x40100),
    (False, True, 1, 0x40101),
    (True, False, 1, 0x40101),
    (True, False, 0, 0x40101),
])
def test_query_continue_drag_preserves_cancel_escape_and_left_release(cancelled, escape, keys, expected):
    event = threading.Event()
    if cancelled:
        event.set()
    assert native._continue_drag(escape, keys, event) == expected


@pytest.mark.skipif(sys.platform != "win32", reason="Windows callback ABI; no OS drag")
def test_drop_source_callbacks_keep_identity_and_cancel_fail_closed(monkeypatch):
    event = threading.Event()
    with native._drop_source(event) as source:
        query = native._method(source, 0, native.HR, native.PTR, ct.POINTER(native.PTR))
        found = native.PTR()
        iid = (ct.c_ubyte * 16).from_buffer_copy(bytes.fromhex("2101000000000000c000000000000046"))
        assert query(source, ct.cast(iid, native.PTR), ct.byref(found)) == 0 and found.value == source.value
        assert native._method(source, 2, native.DWORD)(source) == 1
        unknown = (ct.c_ubyte * 16)(*([1] * 16))
        assert query(source, ct.cast(unknown, native.PTR), ct.byref(found)) == -2147467262 and not found.value
        continuation = native._method(source, 3, native.HR, ct.c_int, native.DWORD)
        assert continuation(source, False, 1) == 0
        assert continuation(source, True, 1) == native.DRAGDROP_S_CANCEL
        assert continuation(source, False, 0) == native.DRAGDROP_S_DROP
        event.set()
        assert continuation(source, False, 1) == native.DRAGDROP_S_CANCEL
        assert native._method(source, 4, native.HR, native.DWORD)(source, 1) == native.DRAGDROP_S_USEDEFAULTCURSORS
        def broken(*_args):
            raise RuntimeError("callback failed")
        monkeypatch.setattr(native, "_continue_drag", broken)
        assert continuation(source, False, 1) == native.DRAGDROP_S_CANCEL


@pytest.mark.skipif(sys.platform != "win32", reason="Windows callback ABI; no OS drag")
def test_cancel_after_ole_entry_uses_owned_drop_source_and_copy_only(monkeypatch):
    event = threading.Event()
    def do_drag(_window, _data, source, effects, _effect):
        assert source and effects == 1
        event.set()
        return native._method(source, 3, native.HR, ct.c_int, native.DWORD)(source, False, 1)
    api = SimpleNamespace(user=SimpleNamespace(GetAsyncKeyState=lambda _key: 0x8000,
                          GetSystemMetrics=lambda _key: 0, GetCursorPos=lambda _point: True),
                          shell=SimpleNamespace(SHDoDragDrop=do_drag))
    @contextmanager
    def prepared(_paths, _payload, _cancelled):
        yield api, native.PTR(1)
    monkeypatch.setattr(native, "data_object", prepared)
    @contextmanager
    def connected(_api, _source):
        yield lambda: None
    monkeypatch.setattr(native, "_input_queue", connected)
    assert native._drag_files_on_thread(["a.png"], "[]", int(time.time() * 1000), event, (1, 2, 3), lambda: True) is False


@pytest.mark.parametrize("condition", ["cancelled", "expired", "released"])
def test_gesture_ending_during_shell_preparation_never_starts_drag(monkeypatch, condition):
    cancelled = threading.Event()
    api = SimpleNamespace(user=SimpleNamespace(GetAsyncKeyState=lambda _key: 0 if condition == "released" else 0x8000,
                          GetSystemMetrics=lambda _key: 0, GetCursorPos=lambda _point: True),
                          shell=SimpleNamespace(SHDoDragDrop=lambda *_args: pytest.fail("late native drag")))

    @contextmanager
    def prepare(_paths, _payload, _cancelled):
        if condition == "cancelled":
            cancelled.set()
        elif condition == "expired":
            monkeypatch.setattr(native, "start_is_current", lambda _time: False)
        yield api, native.PTR(1)

    monkeypatch.setattr(native, "data_object", prepare)
    @contextmanager
    def connected(_api, _source):
        yield lambda: None
    monkeypatch.setattr(native, "_input_queue", connected)
    if condition == "expired":
        with pytest.raises(TimeoutError):
            native._drag_files_on_thread(["a.png"], "[]", int(time.time() * 1000), cancelled, (1, 2, 3), lambda: True)
    else:
        assert native._drag_files_on_thread(["a.png"], "[]", int(time.time() * 1000), cancelled, (1, 2, 3), lambda: True) is False


@pytest.mark.parametrize("swapped,cursor_available", [(False, True), (True, True), (False, False)])
def test_physical_button_and_input_desktop_guard_prevent_early_drop(monkeypatch, swapped, cursor_available):
    cancelled = threading.Event()
    held, pressed_keys, dropped = [True], [], []

    def key_state(key):
        pressed_keys.append(key)
        return 0x8000 if held[0] else 0

    def do_drag(_window, _data, source, effects, effect):
        continuation = native._method(source, 3, native.HR, ct.c_int, native.DWORD)
        assert effects == 1
        assert continuation(source, False, 0) == 0  # Queued keys may reset at attach.
        held[0] = False
        assert continuation(source, False, 0) == native.DRAGDROP_S_DROP
        effect._obj.value = 1
        return native.DRAGDROP_S_DROP

    api = SimpleNamespace(user=SimpleNamespace(GetAsyncKeyState=key_state,
                          GetSystemMetrics=lambda _key: swapped,
                          GetCursorPos=lambda _point: cursor_available),
                          shell=SimpleNamespace(SHDoDragDrop=do_drag))

    @contextmanager
    def prepared(*_args):
        yield api, native.PTR(1)

    @contextmanager
    def connected(*_args):
        yield lambda: dropped.append("detached")

    monkeypatch.setattr(native, "data_object", prepared)
    monkeypatch.setattr(native, "_input_queue", connected)
    result = native._drag_files_on_thread(["a.png"], "[]", int(time.time() * 1000), cancelled,
                                          (1, 2, 3), lambda: dropped.append("approved") or True)
    assert result is cursor_available
    assert set(pressed_keys) == ({2} if swapped else {1})
    assert dropped == (["detached", "approved"] if cursor_available else [])


def test_custom_pickle_utf16_lengths_and_alignment():
    payload = json.dumps([{"name": "캐릭터🙂.png"}], ensure_ascii=False)
    encoded = native.custom_data(payload)
    assert struct.unpack_from("<II", encoded) == (len(encoded) - 4, 1)
    offset, values = 8, []
    for _ in range(2):
        length = struct.unpack_from("<i", encoded, offset)[0] * 2
        offset += 4
        values.append(encoded[offset:offset + length].decode("utf-16-le"))
        offset += (length + 3) // 4 * 4
    assert values == [native.ASSET_MIME, payload]
    assert offset == len(encoded)


@pytest.mark.skipif(sys.platform != "win32", reason="Actual Windows IDataObject contract")
def test_actual_windows_object_contains_three_files_and_internal_payload(tmp_path):
    paths = []
    for relative in ("one.png", "different/두번째.png", "different/three.jpg"):
        path = tmp_path / relative
        path.parent.mkdir(exist_ok=True)
        path.write_bytes(b"fixture-not-uploaded")
        paths.append(str(path))
    payload = json.dumps([{"project": "P", "path": path, "type": "image"} for path in paths], ensure_ascii=False)
    with native.data_object(paths, payload) as (api, obj):
        api.kernel.GlobalSize.argtypes, api.kernel.GlobalSize.restype = [native.PTR], ct.c_size_t

        def read_format(format_id):
            fmt = native.FormatEtc(format_id, None, 1, -1, 1)
            medium = native.StorageMedium()
            native._check(native._method(obj, 3, native.HR, ct.POINTER(native.FormatEtc), ct.POINTER(native.StorageMedium))(
                obj, ct.byref(fmt), ct.byref(medium)))
            try:
                pointer = api.kernel.GlobalLock(medium.handle)
                assert pointer
                try:
                    return ct.string_at(pointer, api.kernel.GlobalSize(medium.handle))
                finally:
                    api.kernel.GlobalUnlock(medium.handle)
            finally:
                api.ole.ReleaseStgMedium(ct.byref(medium))

        hdrop = read_format(15)
        assert struct.unpack_from("<I", hdrop)[0] == 20
        assert hdrop[20:].decode("utf-16-le").rstrip("\0").split("\0") == paths
        shell_ids = read_format(api.user.RegisterClipboardFormatW("Shell IDList Array"))
        assert struct.unpack_from("<I", shell_ids)[0] == 3
        custom = read_format(api.user.RegisterClipboardFormatW(native.CUSTOM_FORMAT))
        assert custom == native.custom_data(payload)
    assert all(Path(path).read_bytes() == b"fixture-not-uploaded" for path in paths)


def test_disconnect_watcher_absorbed_cancellation_finishes_and_next_drag_works(env):
    folder, drag = env
    (folder / "a.png").write_bytes(b"original")
    entered = threading.Event()
    control = {"entered": False, "stop": False, "swallowed": 0}

    def worker(*_args):
        assert entered.wait(2)
        return True

    drag.side_effect = worker

    async def run():
        owner, watchers = [], []

        async def receive():
            task = asyncio.current_task()
            if task is owner[0]:
                return {"type": "http.request", "body": b"", "more_body": False}
            if not control["entered"]:
                watchers.append(task)
                control["entered"] = True
                entered.set()
                try:
                    await asyncio.Event().wait()
                except asyncio.CancelledError:
                    control["swallowed"] += 1
                    return {"type": "http.request", "body": b"", "more_body": False}
            return {"type": "http.disconnect"} if control["stop"] else {"type": "http.request", "body": b"", "more_body": False}

        req = Request(request().scope, receive)

        async def is_disconnected():
            return (await req.receive())["type"] == "http.disconnect"

        req.is_disconnected = is_disconnected

        async def invoke():
            owner.append(asyncio.current_task())
            return await assets.native_drag(body(["a.png"]), req)

        first = asyncio.create_task(invoke())
        finished_without_fixture_cleanup = False
        try:
            await asyncio.wait({first}, timeout=.4)
            finished_without_fixture_cleanup = first.done()
            assert control["swallowed"] == 1 and drag.call_count == 1
            if first.done():
                assert first.result() == {"dropped": True}
                assert not assets._native_drag_lock.locked()
            else:
                assert assets._native_drag_lock.locked()
                with pytest.raises(HTTPException) as error:
                    await assets.native_drag(body(["a.png"]), request())
                assert error.value.status_code == 409
        finally:
            control["stop"] = True
            done, pending = await asyncio.wait({first}, timeout=1)
            assert not pending and first.result() == {"dropped": True}
            assert watchers and all(task.done() for task in watchers)
            assert not assets._native_drag_lock.locked()
        assert finished_without_fixture_cleanup
        assert await assets.native_drag(body(["a.png"]), request()) == {"dropped": True}
        assert drag.call_count == 2 and not assets._native_drag_lock.locked()

    asyncio.run(run())

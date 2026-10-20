"""Copy-only Windows file drag in an isolated, short-lived OLE process."""

from __future__ import annotations

import ctypes as ct
from ctypes import wintypes
from contextlib import contextmanager, suppress
from functools import lru_cache
import json
import os
from pathlib import Path
import queue
import struct
import subprocess
import sys
import time
import threading
from types import SimpleNamespace

ASSET_MIME = "application/x-ch-asset"
CUSTOM_FORMAT = "Chromium Web Custom MIME Data Format"
START_WINDOW_MS = 1500
TRACKING_SECONDS = 60
CANCEL_SECONDS = 2
RELEASE_SECONDS = 0.5
HR = ct.c_int32
PTR = ct.c_void_p
DWORD = ct.c_uint32
DRAGDROP_S_DROP = 0x40100
DRAGDROP_S_CANCEL = 0x40101
DRAGDROP_S_USEDEFAULTCURSORS = 0x40102


class FormatEtc(ct.Structure):
    _fields_ = [("format", ct.c_uint16), ("target", PTR), ("aspect", DWORD),
                ("index", ct.c_int32), ("medium", DWORD)]


class StorageMedium(ct.Structure):
    _fields_ = [("medium", DWORD), ("handle", PTR), ("release", PTR)]


def custom_data(payload: str) -> bytes:
    # Chromium custom_data_helper.cc: Pickle header, count, UTF-16 string pairs.
    body = struct.pack("<I", 1)
    for text in (ASSET_MIME, payload):
        raw = text.encode("utf-16-le")
        body += struct.pack("<i", len(raw) // 2) + raw + b"\0" * (-len(raw) % 4)
    return struct.pack("<I", len(body)) + body


def start_is_current(started_at_ms: int) -> bool:
    return 0 <= time.time() * 1000 - started_at_ms <= START_WINDOW_MS


@lru_cache(maxsize=1)
def _api():
    if sys.platform != "win32":
        raise OSError("Windows file drag is unavailable")
    api = SimpleNamespace(**{
        name: ct.WinDLL(name + "32", use_last_error=True, winmode=0x800)
        for name in ("ole", "shell", "kernel", "user")
    })
    signatures = (
        (api.ole.OleInitialize, [PTR], HR),
        (api.ole.OleUninitialize, [], None),
        (api.ole.CoTaskMemFree, [PTR], None),
        (api.ole.ReleaseStgMedium, [ct.POINTER(StorageMedium)], None),
        (api.shell.SHParseDisplayName, [ct.c_wchar_p, PTR, ct.POINTER(PTR), DWORD, PTR], HR),
        (api.shell.CIDLData_CreateFromIDArray, [PTR, ct.c_uint, ct.POINTER(PTR), ct.POINTER(PTR)], HR),
        (api.shell.SHDoDragDrop, [PTR, PTR, PTR, DWORD, ct.POINTER(DWORD)], HR),
        (api.kernel.GlobalAlloc, [ct.c_uint, ct.c_size_t], PTR),
        (api.kernel.GlobalLock, [PTR], PTR),
        (api.kernel.GlobalUnlock, [PTR], ct.c_int),
        (api.kernel.GlobalFree, [PTR], PTR),
        (api.user.RegisterClipboardFormatW, [ct.c_wchar_p], ct.c_uint),
        (api.user.GetAsyncKeyState, [ct.c_int], ct.c_int16),
        (api.user.GetSystemMetrics, [ct.c_int], ct.c_int),
        (api.user.GetCursorPos, [ct.POINTER(wintypes.POINT)], ct.c_int),
        (api.user.GetForegroundWindow, [], PTR),
        (api.user.GetWindowThreadProcessId, [PTR, ct.POINTER(DWORD)], DWORD),
        (api.user.GetClassNameW, [PTR, ct.c_wchar_p, ct.c_int], ct.c_int),
        (api.user.PeekMessageW, [ct.POINTER(wintypes.MSG), PTR, ct.c_uint, ct.c_uint, ct.c_uint], ct.c_int),
        (api.user.AttachThreadInput, [DWORD, DWORD, ct.c_int], ct.c_int),
        (api.kernel.GetCurrentThreadId, [], DWORD),
    )
    for function, arguments, result in signatures:
        function.argtypes, function.restype = arguments, result
    return api


def available() -> bool:
    try:
        _api()
        return True
    except (OSError, AttributeError):
        return False


def _check(result: int) -> None:
    if result < 0:
        raise OSError(f"Windows drag failed (0x{result & 0xffffffff:08x})")


def _method(obj, index, result, *arguments):
    table = ct.cast(obj, ct.POINTER(ct.POINTER(PTR))).contents
    return ct.WINFUNCTYPE(result, PTR, *arguments)(table[index])


def _continue_drag(escape_pressed: bool, key_state: int, cancelled: threading.Event) -> int:
    if cancelled.is_set() or escape_pressed:
        return DRAGDROP_S_CANCEL
    return 0 if key_state & 1 else DRAGDROP_S_DROP  # MK_LBUTTON


@contextmanager
def _drop_source(cancelled: threading.Event, primary_down=None, before_drop=None):
    references = [1]

    def add_ref(_this):
        references[0] += 1
        return references[0]

    def release(_this):
        references[0] -= 1
        return references[0]

    def query_interface(this, iid, output):
        if not output:
            return -2147467261  # E_POINTER
        output[0] = None
        try:
            if iid and ct.string_at(iid, 16) in (
                bytes.fromhex("0000000000000000c000000000000046"),  # IUnknown
                bytes.fromhex("2101000000000000c000000000000046"),  # IDropSource
            ):
                output[0] = this
                add_ref(this)
                return 0
            return -2147467262  # E_NOINTERFACE
        except BaseException:
            return -2147418113  # E_UNEXPECTED; never let Python escape a COM callback.

    def query_continue(_this, escape_pressed, key_state):
        try:
            # AttachThreadInput resets queued key state; use the physical button.
            if primary_down is not None:
                key_state = 1 if primary_down() else 0
            result = _continue_drag(bool(escape_pressed), key_state, cancelled)
            if result == DRAGDROP_S_DROP and before_drop is not None:
                return result if before_drop() else DRAGDROP_S_CANCEL
            return result
        except BaseException:
            return DRAGDROP_S_CANCEL

    callbacks = (
        ct.WINFUNCTYPE(HR, PTR, PTR, ct.POINTER(PTR))(query_interface),
        ct.WINFUNCTYPE(DWORD, PTR)(add_ref),
        ct.WINFUNCTYPE(DWORD, PTR)(release),
        ct.WINFUNCTYPE(HR, PTR, ct.c_int, DWORD)(query_continue),
        ct.WINFUNCTYPE(HR, PTR, DWORD)(lambda _this, _effect: DRAGDROP_S_USEDEFAULTCURSORS),
    )
    table = (PTR * len(callbacks))(*(ct.cast(callback, PTR).value for callback in callbacks))
    instance = (PTR * 1)(ct.cast(table, PTR).value)
    source = ct.cast(instance, PTR)
    try:
        # The generator retains callbacks/table/instance until SHDoDragDrop returns.
        yield source
    finally:
        release(source)


def _set_data(api, obj, format_id: int, data: bytes) -> None:
    handle = api.kernel.GlobalAlloc(0x42, len(data))  # moveable, zero-initialized
    if not handle:
        raise ct.WinError(ct.get_last_error())
    try:
        address = api.kernel.GlobalLock(handle)
        if not address:
            raise ct.WinError(ct.get_last_error())
        try:
            ct.memmove(address, data, len(data))
        finally:
            api.kernel.GlobalUnlock(handle)
        fmt = FormatEtc(format_id, None, 1, -1, 1)
        medium = StorageMedium(1, handle, None)
        _check(_method(obj, 7, HR, ct.POINTER(FormatEtc), ct.POINTER(StorageMedium), ct.c_int)(
            obj, ct.byref(fmt), ct.byref(medium), True))
        handle = None  # IDataObject owns the allocation after successful SetData.
    finally:
        if handle:
            api.kernel.GlobalFree(handle)


@contextmanager
def data_object(paths: list[str], payload: str, cancelled: threading.Event | None = None):
    api = _api()
    _check(api.ole.OleInitialize(None))
    obj, pidls = PTR(), []
    try:
        for path in paths:
            if cancelled is not None and cancelled.is_set():
                raise InterruptedError("Drag cancelled")
            pidl = PTR()
            result = api.shell.SHParseDisplayName(path, None, ct.byref(pidl), 0, None)
            pidls.append(pidl)
            _check(result)
        if cancelled is not None and cancelled.is_set():
            raise InterruptedError("Drag cancelled")
        # A desktop PIDL + absolute children supports files from different folders.
        desktop = ct.c_uint16(0)
        children = (PTR * len(pidls))(*(p.value for p in pidls))
        _check(api.shell.CIDLData_CreateFromIDArray(ct.byref(desktop), len(pidls), children, ct.byref(obj)))
        # Exact ordered CF_HDROP, alongside the actual Shell ID list (not an empty CIDA).
        file_list = ("\0".join(paths) + "\0\0").encode("utf-16-le")
        _set_data(api, obj, 15, struct.pack("<IiiII", 20, 0, 0, 0, 1) + file_list)
        format_id = api.user.RegisterClipboardFormatW(CUSTOM_FORMAT)
        if not format_id:
            raise ct.WinError(ct.get_last_error())
        _set_data(api, obj, format_id, custom_data(payload))
        yield api, obj
    finally:
        if obj:
            _method(obj, 2, ct.c_uint32)(obj)
        for pidl in pidls:
            api.ole.CoTaskMemFree(pidl)
        api.ole.OleUninitialize()


def _source_window(api):
    window = api.user.GetForegroundWindow()
    process = DWORD()
    thread = api.user.GetWindowThreadProcessId(window, ct.byref(process)) if window else 0
    name = ct.create_unicode_buffer(128)
    if not thread or not api.user.GetClassNameW(window, name, len(name)) or not name.value.startswith("Chrome_WidgetWin_"):
        raise InterruptedError("Drag source is no longer the browser")
    return int(window), int(thread), process.value


def capture_source():
    try:
        return _source_window(_api())
    except InterruptedError:
        return None


def _gesture_state():
    api = _api()
    point = wintypes.POINT()
    valid = bool(api.user.GetCursorPos(ct.byref(point)))
    button = 2 if api.user.GetSystemMetrics(23) else 1
    return (bool(api.user.GetAsyncKeyState(button) & 0x8000),
            bool(api.user.GetAsyncKeyState(27) & 0x8000), valid)


@contextmanager
def _input_queue(api, expected):
    message = wintypes.MSG()
    api.user.PeekMessageW(ct.byref(message), None, 0, 0, 0)
    current = api.kernel.GetCurrentThreadId()
    if _source_window(api) != tuple(expected):
        raise InterruptedError("Drag source changed")
    if not api.user.AttachThreadInput(current, expected[1], True):
        raise ct.WinError(ct.get_last_error())
    attached = True

    def detach():
        nonlocal attached
        if attached:
            if not api.user.AttachThreadInput(current, expected[1], False):
                raise ct.WinError(ct.get_last_error())
            attached = False

    try:
        if _source_window(api) != tuple(expected):
            raise InterruptedError("Drag source changed")
        yield detach
    finally:
        detach()


def _drag_files_on_thread(paths, payload, started_at_ms, cancelled, source_window, approve_drop):
    if cancelled.is_set():
        return False
    if not start_is_current(started_at_ms):
        raise TimeoutError("Drag gesture expired")
    try:
        with data_object(paths, payload, cancelled) as (api, obj):
            button = 2 if api.user.GetSystemMetrics(23) else 1  # SM_SWAPBUTTON

            def primary_down():
                point = wintypes.POINT()
                if not api.user.GetCursorPos(ct.byref(point)):
                    cancelled.set()  # A different input desktop is not a release.
                return bool(api.user.GetAsyncKeyState(button) & 0x8000)

            with _input_queue(api, source_window) as detach:
                held = primary_down()
                if cancelled.is_set() or not held:
                    return False
                if not start_is_current(started_at_ms):
                    raise TimeoutError("Drag gesture expired")

                def before_drop():
                    detach()  # Do not tie browser input to a slow external Drop handler.
                    return approve_drop()

                with _drop_source(cancelled, primary_down, before_drop) as source:
                    effect = DWORD()
                    result = api.shell.SHDoDragDrop(None, obj, source, 1, ct.byref(effect))
                    _check(result)
                    return result == DRAGDROP_S_DROP and bool(effect.value & 1)
    except InterruptedError:
        return False


def drag_files(paths: list[str], payload: str, started_at_ms: int, cancelled: threading.Event, source=None) -> bool:
    if cancelled.is_set():
        return False
    if not start_is_current(started_at_ms):
        raise TimeoutError("Drag gesture expired")
    source = source or capture_source()
    if source is None:
        return False
    process = subprocess.Popen(
        [sys.executable, str(Path(__file__).resolve())], stdin=subprocess.PIPE,
        stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, encoding="utf-8",
        creationflags=subprocess.CREATE_NO_WINDOW,
    )
    messages, outgoing = queue.Queue(), queue.Queue()

    def read_messages():
        try:
            while line := process.stdout.readline(513):
                if len(line) > 512:
                    break
                message = json.loads(line)
                if not isinstance(message, dict) or message.get("event") not in {"drop", "result"}:
                    break
                if message["event"] == "result" and not isinstance(message.get("dropped"), bool):
                    break
                messages.put(message)
        except (ValueError, OSError):
            pass
        finally:
            messages.put({"event": "closed"})

    reader = threading.Thread(target=read_messages, daemon=True)
    def write_messages():
        try:
            while (value := outgoing.get()) is not None:
                process.stdin.write(json.dumps(value, ensure_ascii=False) + "\n")
                process.stdin.flush()
        except (OSError, ValueError):
            messages.put({"event": "write_failed"})

    writer = threading.Thread(target=write_messages, daemon=True)
    reader.start()
    writer.start()
    dropping, cancel_at, released_at, result = False, None, None, None
    started = time.monotonic()

    def send(value):
        outgoing.put(value)

    try:
        send({"paths": paths, "payload": payload, "started": started_at_ms, "source": source})
        while True:
            if not dropping and cancel_at is None:
                held, escape, input_valid = _gesture_state()
                if not held and released_at is None:
                    released_at = time.monotonic()
                if (cancelled.is_set() or escape or not input_valid or
                        time.monotonic() - started >= TRACKING_SECONDS or
                        released_at is not None and held or
                        released_at is not None and time.monotonic() - released_at >= RELEASE_SECONDS):
                    cancel_at = time.monotonic()
                    send({"event": "cancel"})
            if not dropping and cancel_at is not None and time.monotonic() - cancel_at >= CANCEL_SECONDS:
                raise OSError("Windows drag did not finish cancellation")
            try:
                message = messages.get(timeout=0.02)
            except queue.Empty:
                continue
            event = message.get("event")
            if event == "drop":
                # The child cannot start Drop until this acknowledgement arrives.
                if cancel_at is None and not cancelled.is_set():
                    dropping = True
                    send({"event": "drop"})
                else:
                    send({"event": "cancel"})
            elif event == "result":
                if message["dropped"] and not dropping:
                    raise OSError("Windows drag helper failed: unapproved drop result")
                result = message
                break
            elif event == "closed":
                raise OSError("Windows drag helper failed: missing result")
            elif event == "write_failed":
                raise OSError("Windows drag helper stopped reading")
        try:
            process.wait(timeout=CANCEL_SECONDS)
        except subprocess.TimeoutExpired as error:
            raise OSError("Windows drag helper failed: did not exit after its result") from error
        if process.returncode != 0 or result is None:
            raise OSError("Windows drag helper failed")
        if result.get("reason") == "expired":
            raise TimeoutError("Drag gesture expired")
        if result.get("reason") == "failed":
            raise OSError("Windows drag failed")
        return bool(result.get("dropped"))
    finally:
        # Keep the caller's lock until the helper has actually exited.
        if process.poll() is None and (not dropping or result is not None):
            process.kill()
        process.wait()
        outgoing.put(None)
        writer.join()
        with suppress(OSError):
            process.stdin.close()
        reader.join()
        with suppress(OSError):
            process.stdout.close()


def _run_worker():
    request = json.loads(sys.stdin.readline())
    cancelled, approved = threading.Event(), threading.Event()
    state = ["tracking"]

    def emit(value):
        print(json.dumps(value), flush=True)

    def commands():
        try:
            for line in sys.stdin:
                if json.loads(line).get("event") == "drop":
                    approved.set()
                else:
                    cancelled.set()
        finally:
            cancelled.set()

    def watch_owner():
        started, cancel_at = time.monotonic(), None
        while state[0] != "finished":
            if state[0] != "dropping":
                if time.monotonic() - started >= TRACKING_SECONDS:
                    cancelled.set()
                if cancelled.is_set():
                    cancel_at = cancel_at or time.monotonic()
                    if time.monotonic() - cancel_at >= CANCEL_SECONDS:
                        os._exit(2)  # The OLE loop may never ask QueryContinueDrag again.
            time.sleep(0.02)

    def approve_drop():
        if cancelled.is_set():
            return False
        emit({"event": "drop"})
        deadline = time.monotonic() + 1
        while not cancelled.is_set() and time.monotonic() < deadline:
            if approved.wait(0.02):
                state[0] = "dropping"
                return True
        cancelled.set()
        return False

    threading.Thread(target=commands, daemon=True).start()
    threading.Thread(target=watch_owner, daemon=True).start()
    try:
        dropped = _drag_files_on_thread(request["paths"], request["payload"], request["started"],
                                        cancelled, request["source"], approve_drop)
        emit({"event": "result", "dropped": dropped})
    except TimeoutError:
        emit({"event": "result", "dropped": False, "reason": "expired"})
    except (OSError, ValueError, KeyError):
        emit({"event": "result", "dropped": False, "reason": "failed"})
    finally:
        state[0] = "finished"


if __name__ == "__main__":
    _run_worker()

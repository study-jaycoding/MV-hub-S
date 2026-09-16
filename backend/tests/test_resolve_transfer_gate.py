"""실사용 Resolve/업데이터 대신 임시 설치 폴더와 OS 핸들로 전송 보호를 검증한다."""

from __future__ import annotations

import asyncio
import contextlib
import ctypes
import os
from pathlib import Path
import queue
import subprocess
import sys
import threading
from unittest.mock import Mock

import pytest
from fastapi import HTTPException

from app.routers import resolve_integration
from app.services import resolve_import_worker, resolve_queue, resolve_transfer
from app.services import resolve_transfer_gate as gate

pytestmark = pytest.mark.skipif(os.name != "nt", reason="Windows release handle contract")


@pytest.fixture
def installed(tmp_path, monkeypatch):
    root = tmp_path / "설치 폴더"
    root.mkdir()
    for name in ("INSTALL_SOURCE.txt", "update_release.bat"):
        (root / name).touch()
    monkeypatch.setattr(gate, "APP_ROOT", root)
    return root


@contextlib.contextmanager
def exclusive(root):
    """업데이터와 같은 ReadWrite/FileShare.None. 실제 업데이터를 실행하지 않는다."""
    from ctypes import wintypes

    dll = ctypes.WinDLL("kernel32", use_last_error=True)
    dll.CreateFileW.argtypes = (
        wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD, ctypes.c_void_p,
        wintypes.DWORD, wintypes.DWORD, wintypes.HANDLE,
    )
    dll.CreateFileW.restype = wintypes.HANDLE
    dll.CloseHandle.argtypes = (wintypes.HANDLE,)
    handle = dll.CreateFileW(str(root / gate.LOCK_NAME), 0xC0000000, 0, None, 4, 128, None)
    if handle == ctypes.c_void_p(-1).value:
        raise ctypes.WinError(ctypes.get_last_error())
    try:
        yield
    finally:
        assert dll.CloseHandle(handle)


def assert_update_blocked(root):
    with pytest.raises(OSError) as caught:
        with exclusive(root):
            pytest.fail("active transfer was not protected")
    assert caught.value.winerror == 32


def test_development_does_not_create_lock(tmp_path):
    (tmp_path / "update_release.bat").touch()  # the updater also exists in a development checkout
    with gate.transfer_lease(tmp_path):
        assert not (tmp_path / gate.LOCK_NAME).exists()


def test_multiple_transfers_share_handle_and_empty_file_does_not_block(installed):
    with gate.transfer_lease(), gate.transfer_lease():
        assert_update_blocked(installed)
    assert (installed / gate.LOCK_NAME).stat().st_size == 0
    with exclusive(installed):
        pass
    with gate.transfer_lease():
        assert_update_blocked(installed)


def test_update_blocks_transfer_and_retry_is_immediate(installed):
    with exclusive(installed):
        with pytest.raises(gate.ResolveTransferGateBusy):
            with gate.transfer_lease():
                pytest.fail("entered during update")
    with gate.transfer_lease():
        pass


def test_swap_cannot_bypass_gate_when_release_markers_are_temporarily_absent(installed):
    with exclusive(installed):
        (installed / "update_release.bat").unlink()
        (installed / "INSTALL_SOURCE.txt").unlink()
        with pytest.raises(gate.ResolveTransferGateBusy):
            with gate.transfer_lease():
                pytest.fail("swap bypassed the existing gate")
    with gate.transfer_lease():
        pass  # the empty remaining lock file is not itself busy


def test_handle_is_non_inheritable_and_64_bit_safe(installed, monkeypatch):
    from ctypes import wintypes
    from types import SimpleNamespace

    handle = 0x123456789
    create = Mock(return_value=handle)
    close = Mock(return_value=True)
    monkeypatch.setattr(gate.ctypes, "WinDLL", lambda *_a, **_kw: SimpleNamespace(
        CreateFileW=create, CloseHandle=close,
    ))
    with gate.transfer_lease():
        assert create.call_args.args[3] is None  # no inheritable SECURITY_ATTRIBUTES
        assert create.call_args.args[1:3] == (0xC0000000, 3)
        assert create.restype is wintypes.HANDLE
        assert close.argtypes == (wintypes.HANDLE,)
    close.assert_called_once_with(handle)


def test_handle_is_released_on_error(installed):
    with pytest.raises(ValueError):
        with gate.transfer_lease():
            raise ValueError("body failed")
    with exclusive(installed):
        pass


def test_io_failure_is_not_reported_as_update_busy(installed):
    (installed / gate.LOCK_NAME).mkdir()
    with pytest.raises(gate.ResolveTransferGateError) as caught:
        with gate.transfer_lease():
            pytest.fail("unsafe unprotected transfer")
    assert not isinstance(caught.value, gate.ResolveTransferGateBusy)


@pytest.mark.parametrize("retry", [False, True])
def test_router_maps_busy_to_409_and_counter_recovers(installed, monkeypatch, retry):
    monkeypatch.setattr(resolve_integration, "_require_local_resolve", lambda _: None)
    with exclusive(installed):
        if retry:
            request = resolve_integration.retry_resolve_transfer(
                resolve_integration.ResolveRetryIn(project_id="p", transfer_id="t"), object()
            )
        else:
            request = resolve_integration.create_resolve_transfer(
                resolve_integration.ResolveTransferIn(gen_ids=["g"]), object()
            )
        with pytest.raises(HTTPException) as caught:
            asyncio.run(request)
        assert caught.value.status_code == 409
    assert resolve_transfer.active_transfer_count() == 0


def test_counter_recovers_and_router_returns_503_on_guard_io_error(installed, monkeypatch):
    (installed / gate.LOCK_NAME).mkdir()
    monkeypatch.setattr(resolve_integration, "_require_local_resolve", lambda _: None)
    with pytest.raises(HTTPException) as caught:
        asyncio.run(resolve_integration.create_resolve_transfer(
            resolve_integration.ResolveTransferIn(gen_ids=["g"]), object()
        ))
    assert caught.value.status_code == 503
    assert resolve_transfer.active_transfer_count() == 0


def test_cancelled_transfer_keeps_lease_until_work_and_save_finish(installed):
    async def run():
        started, release = asyncio.Event(), asyncio.Event()
        saved = []

        async def work():
            started.set()
            await release.wait()
            assert_update_blocked(installed)
            saved.append(True)

        async def request():
            async with resolve_transfer.track_active():
                await resolve_queue.run_non_abandon(work())

        task = asyncio.create_task(request())
        await started.wait()
        task.cancel()
        await asyncio.sleep(0)
        task.cancel()  # repeated cancellation must not abandon the worker
        await asyncio.sleep(0)
        assert_update_blocked(installed)
        assert resolve_transfer.active_transfer_count() == 1
        release.set()
        with pytest.raises(asyncio.CancelledError):
            await task
        assert saved == [True]

    asyncio.run(run())
    assert resolve_transfer.active_transfer_count() == 0
    with exclusive(installed):
        pass


def test_child_holds_own_lease_through_import_and_journal_finish(installed, monkeypatch):
    calls = []

    def import_stub(manifest):
        assert_update_blocked(installed)
        calls.append("import")
        return {"status": "complete"}

    def finish_stub(result):
        assert_update_blocked(installed)
        calls.append("finish")

    journal = Mock()
    journal.finish.side_effect = finish_stub
    monkeypatch.setattr(resolve_import_worker, "attempt_journal_path", lambda _: installed / "journal")
    monkeypatch.setattr(resolve_import_worker, "AttemptJournal", lambda *_: journal)
    monkeypatch.setattr(resolve_import_worker, "import_manifest_to_current_project", import_stub)
    assert resolve_import_worker.run({}) == {"status": "complete"}
    assert calls == ["import", "finish"]
    with exclusive(installed):
        pass


def test_child_refuses_before_resolve_if_updater_has_lock(installed, monkeypatch):
    import_stub = Mock()
    journal = Mock()
    monkeypatch.setattr(resolve_import_worker, "AttemptJournal", journal)
    monkeypatch.setattr(resolve_import_worker, "attempt_journal_path", lambda _: installed / "journal")
    monkeypatch.setattr(resolve_import_worker, "import_manifest_to_current_project", import_stub)
    with exclusive(installed):
        result = resolve_import_worker.run({})
    assert result["error_code"] == "update_in_progress"
    assert result["status"] == "unavailable"
    import_stub.assert_not_called()
    journal.assert_not_called()
    assert not (installed / "journal").exists()


def test_child_failure_releases_own_handle(installed, monkeypatch):
    monkeypatch.setattr(
        resolve_import_worker, "import_manifest_to_current_project", Mock(side_effect=ValueError("fail"))
    )
    with pytest.raises(ValueError):
        resolve_import_worker.run({})
    with exclusive(installed):
        pass


@pytest.mark.parametrize("interpreter", list(dict.fromkeys(filter(None, (
    sys.executable, os.environ.get("MVHUB_TEST_RESOLVE_PYTHON"),
)))))
def test_external_python_child_stays_protected_after_parent_lease_closes(installed, interpreter):
    """실제 별도 프로세스; 실행 파일은 임시 설치 루트 밖의 Python이다."""
    code = """
import sys
from pathlib import Path
from app.services import resolve_import_worker as worker, resolve_transfer_gate as gate
gate.APP_ROOT = Path(sys.argv[1])
def importing(manifest):
    print('ready', flush=True)
    sys.stdin.read(1)
    return {'status': 'complete'}
worker.import_manifest_to_current_project = importing
worker.run({})
"""
    child = None
    try:
        with gate.transfer_lease():
            child = subprocess.Popen(
                [interpreter, "-u", "-c", code, str(installed)],
                cwd=Path(__file__).resolve().parents[1],
                stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                text=True, creationflags=subprocess.CREATE_NO_WINDOW,
            )
            # Daemon reader + bounded queue wait: a stuck child is killed by finally.
            output = queue.Queue()
            threading.Thread(target=lambda: output.put(child.stdout.readline()), daemon=True).start()
            assert output.get(timeout=10).strip() == "ready"
        assert_update_blocked(installed)  # parent handle is already gone
        stdout, stderr = child.communicate("x", timeout=10)
        assert child.returncode == 0, stderr
        with exclusive(installed):
            pass
    finally:
        if child is not None:
            if child.poll() is None:
                child.kill()
            child.communicate(timeout=10)


def test_process_crash_releases_handle_without_removing_lock_file(installed):
    code = """
import os, sys
from pathlib import Path
from app.services.resolve_transfer_gate import transfer_lease
with transfer_lease(Path(sys.argv[1])):
    os._exit(7)
"""
    result = subprocess.run(
        [sys.executable, "-c", code, str(installed)],
        cwd=Path(__file__).resolve().parents[1], capture_output=True,
        timeout=10, creationflags=subprocess.CREATE_NO_WINDOW,
    )
    assert result.returncode == 7
    assert (installed / gate.LOCK_NAME).exists()
    with exclusive(installed):
        pass


def test_unrelated_child_does_not_inherit_parent_lease(installed):
    child = None
    try:
        with gate.transfer_lease():
            child = subprocess.Popen(
                [sys.executable, "-u", "-c", "import sys; print('ready', flush=True); sys.stdin.read(1)"],
                stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                text=True, close_fds=False, creationflags=subprocess.CREATE_NO_WINDOW,
            )
            output = queue.Queue()
            threading.Thread(target=lambda: output.put(child.stdout.readline()), daemon=True).start()
            assert output.get(timeout=10).strip() == "ready"
        assert child.poll() is None
        with exclusive(installed):
            pass  # child is alive but did not inherit the parent's handle
        _, stderr = child.communicate("x", timeout=10)
        assert child.returncode == 0, stderr
    finally:
        if child is not None:
            if child.poll() is None:
                child.kill()
            child.communicate(timeout=10)

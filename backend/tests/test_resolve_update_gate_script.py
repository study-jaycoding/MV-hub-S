"""Run only the updater's gate/state control flow, never its install functions.

The actual PowerShell main block is combined with three whitelisted state/error
helpers and inert install/network/process stubs under pytest's temporary root.
No release batch file, user installation, server or DaVinci process is started.
"""
from __future__ import annotations

import base64
from contextlib import contextmanager
import ctypes
from ctypes import wintypes
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
import time

import pytest

from app.services.release_update import _stored_can_update


pytestmark = pytest.mark.skipif(os.name != "nt", reason="Windows sharing contracts")
_ROOT = Path(__file__).resolve().parents[2]
_MARKER = "### MVHUB_" + "UPDATE_POWERSHELL ###"


def _payload() -> str:
    return (_ROOT / "update_release_worker.bat").read_text("utf-8").split(_MARKER)[-1]


def _helper(payload: str, name: str) -> str:
    match = re.search(rf"(?ms)^function {re.escape(name)} \{{.*?(?=^function |\Z)", payload)
    assert match, name
    return match.group(0)


def _ps_command(script_path: Path) -> list[str]:
    return ["powershell.exe", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", str(script_path)]


def _run(script: str) -> subprocess.CompletedProcess[str]:
    with tempfile.TemporaryDirectory(prefix="mvhub-gate-test-") as temp:
        script_path = Path(temp) / "isolated-gate.ps1"
        script_path.write_text(script, encoding="utf-8-sig")
        return subprocess.run(_ps_command(script_path), capture_output=True, text=True, timeout=20)


def _quote(path: Path) -> str:
    return "'" + str(path).replace("'", "''") + "'"


@contextmanager
def _windows_handle(path: Path, *, shared: bool):
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    create = kernel.CreateFileW
    create.argtypes = [
        wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD, ctypes.c_void_p,
        wintypes.DWORD, wintypes.DWORD, wintypes.HANDLE,
    ]
    create.restype = wintypes.HANDLE
    close = kernel.CloseHandle
    close.argtypes = [wintypes.HANDLE]
    close.restype = wintypes.BOOL
    handle = create(str(path), 0xC0000000, 3 if shared else 0, None, 4, 0x80, None)
    if handle == ctypes.c_void_p(-1).value:
        raise ctypes.WinError(ctypes.get_last_error())
    try:
        yield handle
    finally:
        close(handle)


def _isolated_main(
    tmp_path: Path, *, pause_install: bool = False, fail_install: bool = False,
    fail_state: bool = False,
) -> str:
    installed = tmp_path / "installed"
    installed.mkdir(exist_ok=True)
    (installed / "VERSION.txt").write_text("1.0.0", encoding="ascii")
    temp = tmp_path / "updater-temp"
    temp.mkdir(exist_ok=True)
    payload = _payload()
    # Only selected function definitions are used. Network, process termination,
    # archive, rename, rollback and launch functions are intentionally NOT loaded.
    helpers = "\n".join(_helper(payload, name) for name in (
        "Write-UpdateState", "Get-TransientLockCode", "Write-ResolveTransferBusyState",
    ))
    main = payload[payload.index('$TempRoot = Join-Path $env:TEMP ("mvhub-update-') :]
    return f"""
$ErrorActionPreference = 'Stop'
$TargetDir = {_quote(installed)}
$StateFile = {_quote(tmp_path / 'state.json')}
$env:TEMP = {_quote(temp)}
$CurrentVersion = ''
$LatestVersion = ''
$BaseUrl = 'isolated-stub'
$RestartAfterInstall = '0'
$script:RecoveryState = 'not_started'
$script:ProcessesStopped = $false
$script:InstalledComponents = $null
$script:HadRecoveryAssets = $false
{helpers}
{"function Write-UpdateState { throw 'isolated state write failure' }" if fail_state else ''}
function Get-ReleaseFile {{
    param($Name, $Destination)
    [IO.File]::WriteAllText({_quote(tmp_path / 'fetch-called')}, 'yes')
    @{{version='1.1.0'; file='fake.zip'; sha256=('a' * 64)}} |
        ConvertTo-Json | Set-Content -LiteralPath $Destination -Encoding UTF8
}}
function Move-LeftoversToQuarantine {{}}
function Assert-AppLayout {{}}
function Assert-PythonRuntime {{}}
function Assert-BundledCli {{}}
function Start-MvHubAfterFailure {{ throw 'Restart must never run in this harness' }}
function Stop-MvHubProcesses {{ throw 'Process stop must never run in this harness' }}
function Install-Package {{
    [IO.File]::WriteAllText({_quote(tmp_path / 'install-called')}, 'yes')
    {'[void][Console]::ReadLine()' if pause_install else ''}
    {"throw 'isolated install failure'" if fail_install else ''}
}}
{main}
"""


def _state(tmp_path: Path) -> dict:
    return json.loads((tmp_path / "state.json").read_text("utf-8-sig"))


def _assert_clean(tmp_path: Path) -> None:
    assert not list((tmp_path / "updater-temp").iterdir())
    with _windows_handle(tmp_path / "installed" / ".update.lock", shared=False):
        pass


def test_worker_payload_is_ascii_and_parses_without_running():
    raw = (_ROOT / "update_release_worker.bat").read_bytes()
    raw.decode("ascii")
    encoded = base64.b64encode(_payload().encode("utf-8")).decode("ascii")
    result = _run(f"""
$source = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('{encoded}'))
$tokens = $null
$errors = $null
[void][Management.Automation.Language.Parser]::ParseInput($source, [ref]$tokens, [ref]$errors)
if ($errors.Count) {{ $errors | Out-String | Write-Output; exit 1 }}
""")
    assert result.returncode == 0, result.stdout + result.stderr


@pytest.mark.parametrize("recovery", ["not_started", "rolled_back", "recovery_required"])
def test_live_transfer_refuses_update_without_work_and_preserves_retry_state(tmp_path, recovery):
    script = _isolated_main(tmp_path)
    (tmp_path / "state.json").write_text(json.dumps({
        "state": "starting", "latest_version": "1.1.0", "recovery": recovery,
    }), encoding="utf-8")
    with _windows_handle(tmp_path / "installed" / ".resolve-transfer.lock", shared=True):
        result = _run(script)
    assert result.returncode == 18, result.stdout + result.stderr
    assert not (tmp_path / "fetch-called").exists()
    assert not (tmp_path / "install-called").exists()
    state = _state(tmp_path)
    assert state["state"] == ("failed" if recovery == "recovery_required" else "available")
    assert state["latest_version"] == "1.1.0"
    assert state["recovery"] == recovery
    assert "transfer is active" in state["message"]
    _assert_clean(tmp_path)


def test_empty_gate_file_and_finished_transfer_do_not_block_retry(tmp_path):
    script = _isolated_main(tmp_path)
    path = tmp_path / "installed" / ".resolve-transfer.lock"
    with _windows_handle(path, shared=True):
        first = _run(script)
    assert first.returncode == 18
    # Manual first run may have no prior offered version or state file. The UI
    # still offers retry; starting again fetches the latest version afresh.
    assert _state(tmp_path)["latest_version"] == ""
    assert _stored_can_update(_state(tmp_path)) is True
    assert path.exists()
    second = _run(script)
    assert second.returncode == 0, second.stdout + second.stderr
    assert (tmp_path / "install-called").exists()
    assert _state(tmp_path)["state"] == "complete"
    _assert_clean(tmp_path)
    with _windows_handle(path, shared=True):
        pass


def test_duplicate_updater_still_exits_17_without_changing_live_state(tmp_path):
    script = _isolated_main(tmp_path)
    state_file = tmp_path / "state.json"
    original = b'{"state":"installing","message":"do not replace"}'
    state_file.write_bytes(original)
    with _windows_handle(tmp_path / "installed" / ".update.lock", shared=False):
        result = _run(script)
    assert result.returncode == 17, result.stdout + result.stderr
    assert state_file.read_bytes() == original
    assert not (tmp_path / "fetch-called").exists()
    _assert_clean(tmp_path)


def test_gate_path_error_is_failure_not_transfer_busy(tmp_path):
    script = _isolated_main(tmp_path)
    (tmp_path / "installed" / ".resolve-transfer.lock").mkdir()
    result = _run(script)
    assert result.returncode not in (0, 17, 18), result.stdout + result.stderr
    assert _state(tmp_path)["state"] == "failed"
    assert not (tmp_path / "fetch-called").exists()
    _assert_clean(tmp_path)


def test_busy_state_write_failure_still_releases_updater_lock_and_temp(tmp_path):
    script = _isolated_main(tmp_path, fail_state=True)
    with _windows_handle(tmp_path / "installed" / ".resolve-transfer.lock", shared=True):
        result = _run(script)
    assert result.returncode not in (0, 17, 18), result.stdout + result.stderr
    assert not (tmp_path / "fetch-called").exists()
    assert not (tmp_path / "install-called").exists()
    _assert_clean(tmp_path)


def test_update_holds_gate_until_finally_and_releases_it_after_failure(tmp_path):
    script = _isolated_main(tmp_path, pause_install=True, fail_install=True)
    script_path = tmp_path / "isolated-gate.ps1"
    script_path.write_text(script, encoding="utf-8-sig")
    process = subprocess.Popen(
        _ps_command(script_path), stdin=subprocess.PIPE, stdout=subprocess.PIPE,
        stderr=subprocess.PIPE, text=True,
    )
    try:
        deadline = time.monotonic() + 12
        while not (tmp_path / "install-called").exists():
            assert process.poll() is None, "isolated updater ended before the install stub"
            assert time.monotonic() < deadline, "isolated updater did not reach install stub"
            time.sleep(0.02)
        with pytest.raises(OSError) as error:
            with _windows_handle(tmp_path / "installed" / ".resolve-transfer.lock", shared=True):
                pytest.fail("transfer acquired the gate during update")
        assert error.value.winerror in (32, 33)
        stdout, stderr = process.communicate("continue\n", timeout=12)
        assert process.returncode not in (0, 17, 18), stdout + stderr
    finally:
        if process.poll() is None:
            process.kill()
        process.communicate(timeout=5)
    assert _state(tmp_path)["state"] == "failed"
    _assert_clean(tmp_path)
    with _windows_handle(tmp_path / "installed" / ".resolve-transfer.lock", shared=True):
        pass


def test_busy_wrapper_preserves_state_and_cleans_before_exit():
    raw = (_ROOT / "update_release_worker.bat").read_text("utf-8")
    batch = raw.split(_MARKER)[0]
    busy = batch[batch.index('if "%UPDATE_EXIT%"=="18"') : batch.index('if not "%UPDATE_EXIT%"=="0"')]
    assert "exit /b 18" in busy
    assert "Set-Content" not in busy
    payload = _payload()
    assert payload.index("$ResolveTransferLockStream.Dispose()") < payload.index("[Environment]::Exit($UpdateExitCode)")
    assert 'Remove-Item -LiteralPath $ResolveTransferLockPath' not in payload
    assert 'Assert-NoActiveResolveImport -Root $TargetDir' in payload


@pytest.mark.parametrize("exit_code", [17, 18])
def test_wrapper_refusal_branch_preserves_exact_exit_and_state(tmp_path, exit_code):
    batch = (_ROOT / "update_release_worker.bat").read_text("utf-8").split(_MARKER)[0]
    branch_start = batch.index(f'if "%UPDATE_EXIT%"=="{exit_code}"')
    branch_end = batch.index('\n)\n', branch_start) + len('\n)\n')
    # Execute only the refusal branch, never the worker's launcher or payload.
    isolated = tmp_path / "refusal-branch.bat"
    isolated.write_text(
        '@echo off\nset "MVHUB_NO_PAUSE=1"\n'
        f'set "UPDATE_EXIT={exit_code}"\n' + batch[branch_start:branch_end] + '\nexit /b 99\n',
        encoding="ascii",
    )
    state_file = tmp_path / "state.json"
    original = b'{"state":"available","message":"preserve this"}'
    state_file.write_bytes(original)
    env = {**os.environ, "MVHUB_UPDATE_STATE_FILE": str(state_file)}
    result = subprocess.run(
        [os.environ["ComSpec"], "/d", "/c", str(isolated)], env=env,
        capture_output=True, text=True, timeout=10,
    )
    assert result.returncode == exit_code, result.stdout + result.stderr
    assert state_file.read_bytes() == original


def test_runtime_gate_files_are_never_swapped_from_a_package(tmp_path):
    package = tmp_path / "fake-package"
    for relative in ("backend/app", "frontend/dist", "runtime/node", "runtime/higgsfield", "runtime/python"):
        (package / relative).mkdir(parents=True)
    (package / ".resolve-transfer.lock").write_text("", encoding="ascii")
    (package / ".update.lock").mkdir()  # malformed packages must not replace lock paths either
    (package / "VERSION.txt").write_text("1.1.0", encoding="ascii")
    (package / "update_release.bat").write_text("inert", encoding="ascii")
    result = _run(_helper(_payload(), "Get-UpdateComponents") + f"""
$components = Get-UpdateComponents -ExtractDir {_quote(package)}
@($components | ForEach-Object {{ $_.Relative }}) | ConvertTo-Json -Compress
""")
    assert result.returncode == 0, result.stdout + result.stderr
    components = json.loads(result.stdout)
    assert ".resolve-transfer.lock" not in components
    assert ".update.lock" not in components
    assert "VERSION.txt" not in components
    assert "update_release.bat" in components

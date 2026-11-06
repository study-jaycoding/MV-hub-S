"""Release contract checks. Never execute an installer or release script; the one worker
function run here touches only a temporary HKCU test key and a test-only mutex name."""
import ast
import ctypes
import os
from pathlib import Path
import re
import subprocess
import threading
from types import SimpleNamespace
import uuid

import pytest

ROOT = Path(__file__).resolve().parents[2]


def test_release_copies_and_allows_handler_and_windowless_runtime():
    script = (ROOT / 'release/make_release.ps1').read_text(encoding='utf-8-sig')
    for name in ('RootFiles', 'AllowedTopLevel'):
        section = re.search(r'\$' + name + r'\s*=\s*@\((.*?)\)', script, re.S).group(1)
        assert '"open_link.py"' in section
    assert '"runtime/python/pythonw.exe"' in script
    excluded = re.search(r'"/XF"([^\r\n]*)', script).group(1)
    assert 'pythonw.exe' not in excluded
    function = script.split('function Assert-PythonRuntimeTree', 1)[1].split('\nfunction ', 1)[0]
    assert '"pythonw.exe"' in function and "'-I', '-S'" in function
    assert '-WindowStyle Hidden' in function and '$WindowlessProbe.ExitCode' in function


def test_install_health_and_update_include_new_files_without_new_swap_branch():
    source = (ROOT / 'backend/app/services/release_update.py').read_text(encoding='utf-8')
    tree = ast.parse(source)
    health = next(n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == '_installation_health')
    literals = [n.value for n in ast.walk(health) if isinstance(n, ast.Constant)]
    assert 'open_link.py' in literals and 'pythonw.exe' in literals
    updater = (ROOT / 'update_release_worker.bat').read_text(encoding='utf-8-sig')
    layout = updater.split('function Assert-AppLayout', 1)[1].split('\nfunction ', 1)[0]
    required = re.search(r'\$Required\s*=\s*@\((.*?)\)', layout, re.S).group(1)
    assert '"open_link.py"' not in required  # old packages still have a valid layout
    runtime = updater.split('function Assert-PythonRuntime', 1)[1].split('\nfunction ', 1)[0]
    conditional = runtime.split('if (Test-Path -LiteralPath (Join-Path $PackageRoot "open_link.py") -PathType Leaf) {', 1)[1]
    assert '"pythonw.exe"' in conditional and "'-I', '-S'" in conditional
    assert '$Windowless' not in runtime.split('if (Test-Path', 1)[0]
    assert '-Label "staged" -PackageRoot $ExtractDir' in updater
    assert '-Label "installed" -PackageRoot $ExtractDir' in updater
    swaps = updater.split('function Get-UpdateComponents', 1)[1].split('\nfunction ', 1)[0]
    assert 'Get-ChildItem' in swaps and 'open_link.py' not in swaps
    qualifier = (ROOT / 'tools/qualify_release_artifact.py').read_text(encoding='utf-8')
    native = next(n for n in ast.parse(qualifier).body if isinstance(n, ast.FunctionDef) and n.name == '_check_native_runtime')
    assert isinstance(native.body[1], ast.If) and isinstance(native.body[1].body[0], ast.Return)
    assert '_check_native_runtime(root)' in qualifier


def test_handler_is_standalone_and_import_does_not_register_or_connect():
    tree = ast.parse((ROOT / 'open_link.py').read_text(encoding='utf-8'))
    imports = [n.module for n in ast.walk(tree) if isinstance(n, ast.ImportFrom)]
    assert all(name == '__future__' or name == 'pathlib' or name == 'types' or name == 'ctypes' for name in imports)
    calls = [n for n in tree.body if isinstance(n, ast.Expr) and isinstance(n.value, ast.Call)]
    assert not calls
    launcher = ast.parse((ROOT / 'run_agent_session.py').read_text(encoding='utf-8'))
    top_calls = [ast.unparse(n) for n in launcher.body if isinstance(n, ast.Expr)]
    assert not any('register_open_link(' in text for text in top_calls)


@pytest.mark.parametrize('missing', ['', 'open_link.py', 'runtime/python/pythonw.exe'])
def test_installation_health_requires_complete_native_link(tmp_path, monkeypatch, missing):
    from app.services import release_update
    files = ['MV_agent.bat', 'update_release.bat', 'run_release_update.ps1', 'update_release_worker.bat',
             'run_agent_session.py', 'open_link.py', 'agent_push.py', 'backend/serve.py',
             'backend/app/main.py', 'frontend/dist/index.html', 'runtime/python/python.exe',
             'runtime/python/pythonw.exe', 'runtime/python/python314.dll', 'runtime/node/node.exe',
             'runtime/higgsfield/node_modules/@higgsfield/cli/bin/higgsfield.js']
    for name in files:
        if name != missing:
            path = tmp_path / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(b'not executable')
    (tmp_path / 'hf_cli_version.txt').write_text('1.2.3')
    (tmp_path / 'runtime/higgsfield/node_modules/@higgsfield/cli/package.json').write_text('{"version":"1.2.3"}')
    monkeypatch.setattr(release_update, '_unfinished_install', lambda root: False)
    def run(argv, **kwargs):
        # This fixture must never execute its fake binaries.
        out = '3.14.0|64' if argv[0].endswith('python.exe') else 'higgsfield 1.2.3'
        return SimpleNamespace(returncode=0, stdout=out, stderr='')
    monkeypatch.setattr(release_update.subprocess, 'run', run)
    assert release_update._installation_health(tmp_path)[0] is (missing != 'runtime/python/pythonw.exe')


@pytest.mark.parametrize('native,pythonw,passes', [(False, False, True), (True, False, False), (True, True, True)])
def test_qualifier_legacy_or_complete_native_package(tmp_path, monkeypatch, native, pythonw, passes):
    monkeypatch.syspath_prepend(str(ROOT / 'tools'))
    import qualify_release_artifact as qualifier
    if native:
        (tmp_path / 'open_link.py').write_text('# fixture')
    if pythonw:
        runtime = tmp_path / 'runtime/python'
        runtime.mkdir(parents=True)
        (runtime / 'pythonw.exe').write_bytes(b'never execute')
    calls = []
    def probe(argv, **kwargs):
        calls.append(argv)
        assert argv[1:3] == ['-I', '-S']
        return SimpleNamespace(returncode=0)
    monkeypatch.setattr(qualifier.subprocess, 'run', probe)
    if passes:
        qualifier._check_native_runtime(tmp_path)
    else:
        # 파일이 없으면 다른 필수 파일과 같이 FileNotFoundError(_required_file), 실행 실패면 ContractError — 둘 다 검정 실패다.
        with pytest.raises((FileNotFoundError, qualifier.c.ContractError)):
            qualifier._check_native_runtime(tmp_path)
    assert bool(calls) is (native and pythonw)


# ---- downgrade / rollback: dangling mvhub:// registration cleanup in the worker


def _payload() -> str:
    raw = (ROOT / 'update_release_worker.bat').read_text(encoding='utf-8')
    return raw.split('### MVHUB_' + 'UPDATE_POWERSHELL ###')[-1]


def _clear_harness(tmp_path: Path) -> Path:
    payload = _payload()
    function = payload[payload.index('function Clear-DanglingOpenLink'):payload.index('function Install-Package')]
    harness = tmp_path / 'clear_link.ps1'
    harness.write_text(
        "param([string]$Root, [string]$KeyPath, [string]$MutexName, [int]$WaitMs = 3000)\n"
        "$ErrorActionPreference = 'Stop'\n" + function +
        "\nClear-DanglingOpenLink -Root $Root -KeyPath $KeyPath -MutexName $MutexName -WaitMs $WaitMs\n"
        "if (Test-Path -LiteralPath $KeyPath) { Write-Host 'KEY=kept' } else { Write-Host 'KEY=gone' }\n",
        encoding='utf-8-sig')
    return harness


@pytest.fixture
def link_key():
    """A throwaway HKCU key standing in for Software\\Classes\\mvhub (the real one is never opened)."""
    import winreg
    base = rf'Software\MVHubTest-{uuid.uuid4().hex}'
    chain = [base, base + r'\mvhub', base + r'\mvhub\shell', base + r'\mvhub\shell\open', base + r'\mvhub\shell\open\command']

    def write(command):
        with winreg.CreateKeyEx(winreg.HKEY_CURRENT_USER, chain[-1], 0, winreg.KEY_SET_VALUE) as key:
            winreg.SetValueEx(key, '', 0, winreg.REG_SZ, command)
    yield SimpleNamespace(ps_path='HKCU:\\' + chain[1], write=write)
    for path in reversed(chain):
        try:
            winreg.DeleteKey(winreg.HKEY_CURRENT_USER, path)
        except FileNotFoundError:
            pass


def _run_clear(tmp_path, root, key, mutex, wait_ms=3000):
    done = subprocess.run(['powershell.exe', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', str(_clear_harness(tmp_path)),
                           '-Root', str(root), '-KeyPath', key.ps_path, '-MutexName', mutex, '-WaitMs', str(wait_ms)],
                          capture_output=True, text=True, encoding='utf-8', errors='replace', timeout=60, check=False)
    assert done.returncode == 0, done.stdout + done.stderr  # never throws into the updater
    return done.stdout


def _command(exe: Path) -> str:
    return f'"{exe}" -I -S "{exe.parents[2] / "open_link.py"}" --port 8472 "%1"'


@pytest.mark.skipif(os.name != 'nt', reason='Windows registry')
@pytest.mark.parametrize('case,expected', [
    ('missing_in_root', 'gone'),        # downgrade done, or rolled back after the new launcher ran once
    ('present', 'kept'),                # downgrade failed and the new tree came back
    ('other_install', 'kept'),
    ('sibling_old_folder', 'kept'),     # <root>-old is another install, not this one
    ('case_only_difference', 'gone'),
    ('unquoted', 'kept'),
    ('unclosed_quote', 'kept'),
])
def test_worker_removes_only_this_installs_dangling_link(tmp_path, link_key, case, expected):
    root = tmp_path / 'MV Hub'
    exe = root / 'runtime' / 'python' / 'pythonw.exe'
    command = {
        'missing_in_root': _command(exe),
        'present': _command(exe),
        'other_install': _command(tmp_path / 'Other' / 'runtime' / 'python' / 'pythonw.exe'),
        'sibling_old_folder': _command(tmp_path / 'MV Hub-old' / 'runtime' / 'python' / 'pythonw.exe'),
        'case_only_difference': _command(Path(str(exe).upper())),
        'unquoted': f'{exe} -I -S x.py "%1"',
        'unclosed_quote': f'"{exe} -I -S x.py %1',
    }[case]
    if case == 'present':
        exe.parent.mkdir(parents=True)
        exe.write_bytes(b'never executed')
    link_key.write(command)
    out = _run_clear(tmp_path, root, link_key, 'Local\\MVHubTest-' + uuid.uuid4().hex)
    assert f'KEY={expected}' in out


@pytest.mark.skipif(os.name != 'nt', reason='Windows registry')
def test_worker_without_registration_is_silent(tmp_path, link_key):
    out = _run_clear(tmp_path, tmp_path / 'MV Hub', link_key, 'Local\\MVHubTest-' + uuid.uuid4().hex)
    assert 'KEY=gone' in out and 'warn' not in out


def _hold_mutex(name, release: threading.Event | None):
    """Own the named mutex on another thread; release=None exits without releasing (abandoned)."""
    from ctypes import wintypes
    kernel32 = ctypes.WinDLL('kernel32', use_last_error=True)
    kernel32.CreateMutexW.argtypes = [ctypes.c_void_p, wintypes.BOOL, wintypes.LPCWSTR]
    kernel32.CreateMutexW.restype = wintypes.HANDLE
    kernel32.WaitForSingleObject.argtypes = [wintypes.HANDLE, wintypes.DWORD]
    kernel32.ReleaseMutex.argtypes = [wintypes.HANDLE]
    kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
    handles, owned = [], threading.Event()

    def run():
        handle = kernel32.CreateMutexW(None, False, name)
        handles.append(handle)
        assert kernel32.WaitForSingleObject(handle, 5000) == 0
        owned.set()
        if release is not None:
            release.wait(30)
            kernel32.ReleaseMutex(handle)
    thread = threading.Thread(target=run)
    thread.start()
    assert owned.wait(10)
    return thread, handles, kernel32


@pytest.mark.skipif(os.name != 'nt', reason='Windows named mutex')
def test_worker_leaves_registration_while_another_process_holds_the_lock(tmp_path, link_key):
    root = tmp_path / 'MV Hub'
    link_key.write(_command(root / 'runtime' / 'python' / 'pythonw.exe'))
    name, release = 'Local\\MVHubTest-' + uuid.uuid4().hex, threading.Event()
    thread, handles, kernel32 = _hold_mutex(name, release)
    try:
        out = _run_clear(tmp_path, root, link_key, name, wait_ms=200)
    finally:
        release.set()
        thread.join(10)
        kernel32.CloseHandle(handles[0])
    assert 'KEY=kept' in out and 'busy' in out


@pytest.mark.skipif(os.name != 'nt', reason='Windows named mutex')
def test_worker_treats_an_abandoned_lock_as_acquired(tmp_path, link_key):
    root = tmp_path / 'MV Hub'
    link_key.write(_command(root / 'runtime' / 'python' / 'pythonw.exe'))
    name = 'Local\\MVHubTest-' + uuid.uuid4().hex
    thread, handles, kernel32 = _hold_mutex(name, None)
    thread.join(10)  # owner thread ended without releasing
    try:
        out = _run_clear(tmp_path, root, link_key, name, wait_ms=200)
    finally:
        kernel32.CloseHandle(handles[0])
    assert 'KEY=gone' in out


def test_worker_calls_cleanup_after_install_and_after_rollback_only():
    payload = _payload()
    main = payload[payload.index('Install-Package -Latest $Latest -TempRoot $TempRoot'):]
    first = main.index('Clear-DanglingOpenLink -Root $TargetDir')
    assert first < main.index('Restart-MvHubAndWaitReady -ExpectedVersion')
    assert main[:first].rstrip().endswith('try {')
    outer = payload[payload.index('$InstallFailure = $_'):]
    outer = outer[:outer.index('throw $InstallFailure')]
    finalize = outer.index('try { Finalize-FailedInstall }')
    gate = outer.index("if ($script:RecoveryState -eq 'rolled_back') {\n            try { Clear-DanglingOpenLink -Root $TargetDir } catch {}")
    assert finalize < gate < outer.index('Write-UpdateState -State "failed"')
    assert payload.count('Clear-DanglingOpenLink -Root $TargetDir') == 2


def test_worker_bat_stays_ascii_and_lock_name_matches_launcher():
    assert all(b < 128 for b in (ROOT / 'update_release_worker.bat').read_bytes())
    tree = ast.parse((ROOT / 'run_agent_session.py').read_text(encoding='utf-8'))
    launcher_name = next(n.value.value for n in tree.body if isinstance(n, ast.Assign)
                         and getattr(n.targets[0], 'id', '') == 'OPEN_LINK_LOCK_NAME')
    assert f"[string]$MutexName = '{launcher_name}'" in _payload()

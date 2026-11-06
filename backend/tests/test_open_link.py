"""Native handler security contracts; no real registry, user directory or Slack."""
import ctypes
import importlib.util
import json
import os
from pathlib import Path
import time
from types import SimpleNamespace
import urllib.error

import pytest

ROOT = Path(__file__).resolve().parents[2]


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


handler = load('native_link_handler_test', ROOT / 'open_link.py')
launcher = load('native_link_launcher_test', ROOT / 'run_agent_session.py')


@pytest.mark.parametrize('url', [
    'MVHUB://open/g?c=c', 'http://open/g?c=c', 'mvhub://other/g?c=c', 'mvhub://open:8/g?c=c',
    'mvhub://open/a/b?c=c', 'mvhub://open/g?c=c&c=d', 'mvhub://open/g?c=c&x=x',
    'mvhub://open/g?c=c#x', 'mvhub://open/g?c=', 'mvhub://open/g?c=c%22',
    'mvhub://open/g?c=c --close-app-window', 'mvhub://open/g?c=c\n', 'mvhub://open/g?c=c\t',
    'mvhub://open/' + 'g' * 201 + '?c=c', 'mvhub://open/g?c=' + 'c' * 513,
])
def test_strict_url(url):
    assert handler.parse_args(['open_link.py', '--port', '8472', url]) is None


def test_argv_and_ids():
    assert handler.parse_args(['x', '--port', '8472', 'mvhub://open/a:b_.-?c=c:1']) == (8472, 'a:b_.-', 'c:1')
    for args in ([], ['x', 'mvhub://open/g?c=c'], ['x', '--port', '0', 'mvhub://open/g?c=c'],
                 ['x', '--port', '65536', 'mvhub://open/g?c=c'],
                 ['x', '--port', '8472', 'mvhub://open/g?c=c', '--close-app-window']):
        assert handler.parse_args(args) is None


@pytest.mark.skipif(os.name != 'nt', reason='Windows command-line parser')
@pytest.mark.parametrize('url,valid', [('mvhub://open/g?c=c', True),
    ('mvhub://open/g?c=c" --close-app-window "', False), ('mvhub://open/g?c=c\\" --port 1', False),
    ('mvhub://open/g?c=c%22', False), ('mvhub://open/g?c=c --close-app-window', False),
    ('mvhub://open/g?c=c\n', False), ('mvhub://open/g?c=c\t', False),
    ('mvhub://open/g?c=' + 'x' * 513, False)])
def test_actual_command_line_to_argv(url, valid):
    from ctypes import wintypes as W
    shell = ctypes.WinDLL('shell32', use_last_error=True)
    shell.CommandLineToArgvW.argtypes = [W.LPCWSTR, ctypes.POINTER(ctypes.c_int)]
    shell.CommandLineToArgvW.restype = ctypes.POINTER(W.LPWSTR)
    kernel = ctypes.WinDLL('kernel32')
    kernel.LocalFree.argtypes = [W.HLOCAL]
    count = ctypes.c_int()
    command = f'"C:\\MV Hub\\pythonw.exe" -I -S "C:\\MV Hub\\open_link.py" --port 8472 "{url}"'
    ptr = shell.CommandLineToArgvW(command, ctypes.byref(count))
    assert ptr
    try:
        argv = [ptr[i] for i in range(count.value)]
    finally:
        kernel.LocalFree(ptr)
    assert bool(handler.parse_args(argv[3:])) is valid


class Registry:
    HKEY_CURRENT_USER = 1
    REG_SZ = 1
    KEY_SET_VALUE = 2
    def __init__(self):
        self.values, self.writes = {}, 0
    def OpenKey(self, hive, path):
        class Key:
            def __enter__(self): return path
            def __exit__(self, *args): return False
        return Key()
    CreateKeyEx = lambda self, hive, path, *args: self.OpenKey(hive, path)
    def QueryValueEx(self, key, name):
        if (key, name) not in self.values: raise FileNotFoundError()
        return self.values[key, name]
    def SetValueEx(self, key, name, reserved, kind, value):
        self.values[key, name] = value, kind
        self.writes += 1


def test_registry_idempotence_all_values_development_and_failure(tmp_path, monkeypatch):
    monkeypatch.delenv('CONTENT_HUB_AUTH', raising=False)
    monkeypatch.setattr(launcher, '_install_root', lambda: tmp_path)
    (tmp_path / 'runtime/python').mkdir(parents=True)
    (tmp_path / 'runtime/python/pythonw.exe').touch()
    (tmp_path / 'open_link.py').touch()
    registry = Registry()
    assert launcher.register_open_link('8472', registry)
    assert registry.writes == 3
    assert launcher.register_open_link('8472', registry) and registry.writes == 3
    assert launcher.register_open_link('8473', registry) and registry.writes == 4
    path = r'Software\Classes\mvhub\shell\open\command'
    assert registry.values[path, ''][0].endswith('--port 8473 "%1"')
    assert '-I -S' in registry.values[path, ''][0]
    registry.values[r'Software\Classes\mvhub', 'URL Protocol'] = ('bad', 1)
    assert launcher.register_open_link('8473', registry) and registry.writes == 5
    monkeypatch.setattr(registry, 'OpenKey', lambda *a: (_ for _ in ()).throw(PermissionError()))
    assert not launcher.register_open_link('8473', registry)
    (tmp_path / '.git').touch()
    assert not launcher.register_open_link('8473', Registry())
    (tmp_path / '.git').unlink()
    (tmp_path / 'runtime/python/pythonw.exe').unlink()
    assert not launcher.register_open_link('8473', Registry())


def test_published_file_per_port_root_and_key_replacement(tmp_path, monkeypatch):
    from app.services import open_link as service
    monkeypatch.setenv('LOCALAPPDATA', str(tmp_path / 'local'))
    monkeypatch.setenv('MVHUB_OPEN_LINK', '1')
    monkeypatch.setattr(service.config, 'AUTH_ENABLED', False)
    monkeypatch.setattr(service.config, 'BACKEND_DIR', ROOT / 'backend')
    monkeypatch.setattr(service.config, 'PORT', 8472)
    monkeypatch.setattr(service, 'session', None)
    service.publish()
    first = service.session
    value = handler.read_connection(ROOT, 8472)
    assert value['key'] == first.key and len(first.key) == 43
    assert launcher._install_id() == handler.install_id(ROOT)
    first.nonces.add('old')
    service.publish()
    assert service.session.key != first.key and service.session.nonces == set()
    newest = handler.read_connection(ROOT, 8472)
    # A stopping cannot delete B's new file: shutdown only drops the in-memory session.
    service.session = None
    assert handler.read_connection(ROOT, 8472) == newest
    monkeypatch.setattr(service.config, 'PORT', 8473)
    service.publish()
    assert handler.read_connection(ROOT, 8472) == newest
    assert handler.read_connection(ROOT, 8473)['port'] == 8473


@pytest.mark.parametrize('bad', [b'{', b'x' * 4097,
    json.dumps({'port': True, 'key': 'k'*43, 'install_root': str(ROOT)}).encode(),
    json.dumps({'port': 8472, 'key': 'k'*42, 'install_root': str(ROOT)}).encode(),
    json.dumps({'port': 8472, 'key': 'k'*43, 'install_root': 'wrong'}).encode()],
    ids=['invalid-json', 'oversize', 'bool-port', 'short-key', 'foreign-install'])
def test_bad_connection(tmp_path, monkeypatch, bad):
    monkeypatch.setenv('LOCALAPPDATA', str(tmp_path))
    path = handler.connection_path(ROOT, 8472)
    path.parent.mkdir(parents=True)
    path.write_bytes(bad)
    with pytest.raises((ValueError, TypeError)):
        handler.read_connection(ROOT, 8472)


def test_handler_proofs_bind_every_field_and_request_nonce():
    key, nonce = 'k' * 43, 'n' * 32
    value = {'result': 'opened', 'hwnd': 42, 'proof': handler.response_proof(key, nonce, 'opened', 42)}
    assert handler.verified_response(json.dumps(value), key, nonce) == ('opened', 42)
    for changes in ({'result': 'denied'}, {'hwnd': 43}, {'hwnd': True}, {'hwnd': -1},
                    {'hwnd': 2**64}, {'result': []}, {'proof': ''}):
        with pytest.raises(ValueError): handler.verified_response(json.dumps(value | changes), key, nonce)
    for other_key, other_nonce in ((key, 'o'*32), ('z'*43, nonce)):
        with pytest.raises(ValueError): handler.verified_response(json.dumps(value), other_key, other_nonce)


def test_http_has_no_key_proxy_or_redirect_and_response_is_bounded(monkeypatch):
    seen = {}
    class Response:
        def __enter__(self): return self
        def __exit__(self, *a): pass
        def read(self, limit):
            assert limit == 4097
            return json.dumps({'result': 'opened', 'hwnd': 0,
                               'proof': handler.response_proof('k'*43, seen['nonce'], 'opened', 0)}).encode()
    class Opener:
        def open(self, request, timeout):
            seen['request'] = request
            seen['nonce'] = request.get_header('X-mvhub-open-nonce')
            assert timeout <= 8
            return Response()
    def build(*handlers):
        assert handlers[0].proxies == {} and isinstance(handlers[1], handler.NoRedirect)
        return Opener()
    monkeypatch.setenv('HTTP_PROXY', 'http://fake-proxy.invalid:8')
    monkeypatch.setattr(handler.urllib.request, 'build_opener', build)
    assert handler.exchange(8472, 'g', 'c', 'k'*43, time.monotonic()+8) == ('opened', 0)
    request = seen['request']
    assert request.full_url == 'http://127.0.0.1:8472/api/open/native'
    assert b'k'*43 not in request.data + str(request.header_items()).encode()
    assert handler.NoRedirect().redirect_request(None, None, 302, '', {}, 'http://other') is None


def test_invalid_proof_never_focuses_and_invalid_args_never_reads(monkeypatch):
    monkeypatch.setattr(handler, 'read_connection', lambda *a: {'key': 'k'*43})
    monkeypatch.setattr(handler, 'exchange', lambda *a: (_ for _ in ()).throw(ValueError()))
    messages = []
    monkeypatch.setattr(handler, 'message_box', messages.append)
    monkeypatch.setattr(handler, 'focus_window', lambda *a: pytest.fail('unverified HWND used'))
    handler.run(['x', '--port', '8472', 'mvhub://open/g?c=c'])
    assert messages == ['restart']
    monkeypatch.setattr(handler, 'read_connection', lambda *a: pytest.fail('invalid input read a file'))
    handler.run(['x', '--port', '8472', 'mvhub://open/g?c=c', '--bad'])


def test_window_never_substitutes_target_and_waits_for_approval(monkeypatch):
    calls = []
    class API:
        attempts = 0
        def approved(self, hwnd, prop):
            calls.append((hwnd, prop)); self.attempts += 1
            return self.attempts == 2
        def focus(self, hwnd): calls.append(hwnd)
    monkeypatch.setattr(handler.time, 'sleep', lambda t: None)
    handler.focus_window(42, ROOT, time.monotonic()+8, API())
    assert calls[-1] == 42 and all(row[0] == 42 for row in calls[:-1])
    assert calls[0][1] == 'MVHubAppWindow_' + launcher._install_id()
    calls.clear()
    handler.focus_window(0, ROOT, time.monotonic()+8, API())
    handler.focus_window(42, ROOT, time.monotonic()-1, API())
    assert calls == []


def test_isolation_drops_both_flags(monkeypatch):
    servers = load('link_isolation_servers', ROOT / 'tools/browser_measure/servers.py')
    env = servers.isolated_base_env({'MVHUB_OPEN_LINK': '1', 'MVHUB_REGISTER_LINK': '1', 'PATH': 'x'})
    assert env == {'PATH': 'x'}
    assert 'MVHUB_OPEN_LINK' not in os.environ and 'MVHUB_REGISTER_LINK' not in os.environ


def test_entire_operation_deadline_and_late_file_read_cannot_send(monkeypatch):
    import threading
    finish = threading.Event()
    sent, messages = [], []
    def read(*a):
        finish.wait(1)
        return {'key': 'k'*43}
    monkeypatch.setattr(handler, 'TIME_BUDGET', 0.02)
    monkeypatch.setattr(handler, 'read_connection', read)
    monkeypatch.setattr(handler, 'exchange', lambda *a: sent.append(1))
    monkeypatch.setattr(handler, 'message_box', messages.append)
    begin = time.monotonic()
    handler.run(['x', '--port', '8472', 'mvhub://open/g?c=c'])
    assert time.monotonic() - begin < 0.5 and messages == ['restart']
    finish.set()
    time.sleep(0.03)
    assert not sent


def test_unapproved_or_dead_window_never_focuses(monkeypatch):
    calls = []
    class API:
        def approved(self, hwnd, prop): return False
        def focus(self, hwnd): calls.append(hwnd)
    ticks = iter([0, 0, 0, 0, 2])
    monkeypatch.setattr(handler.time, 'monotonic', lambda: next(ticks, 3))
    monkeypatch.setattr(handler.time, 'sleep', lambda t: None)
    handler.focus_window(42, ROOT, 8, API())
    assert not calls


def test_win32_restore_and_foreground_refusal_flash_only_verified_hwnd():
    from ctypes import wintypes as W
    api = object.__new__(handler.Windows)
    class Info(ctypes.Structure):
        _fields_ = [('cbSize', W.UINT), ('hwnd', W.HWND), ('dwFlags', W.DWORD),
                    ('uCount', W.UINT), ('dwTimeout', W.DWORD)]
    actions = []
    api.flash_info = Info
    api.u = SimpleNamespace(IsIconic=lambda hwnd: True,
                            ShowWindow=lambda hwnd, cmd: actions.append(('restore', hwnd, cmd)),
                            SetForegroundWindow=lambda hwnd: False,
                            GetForegroundWindow=lambda: 99,
                            FlashWindowEx=lambda ptr: actions.append(('flash', ptr._obj.hwnd)))
    api.focus(42)
    assert actions == [('restore', 42, 9), ('flash', 42)]


@pytest.mark.parametrize('foreground,flashes', [([99, 99, 42], False), ([99] * 100, True)])
def test_accepted_foreground_waits_for_late_activation_before_flashing(foreground, flashes):
    from ctypes import wintypes as W
    api = object.__new__(handler.Windows)
    class Info(ctypes.Structure):
        _fields_ = [('cbSize', W.UINT), ('hwnd', W.HWND), ('dwFlags', W.DWORD),
                    ('uCount', W.UINT), ('dwTimeout', W.DWORD)]
    actions, answers = [], iter(foreground)
    api.flash_info = Info
    api.u = SimpleNamespace(IsIconic=lambda hwnd: False, SetForegroundWindow=lambda hwnd: True,
                            GetForegroundWindow=lambda: next(answers, 99),
                            FlashWindowEx=lambda ptr: actions.append(('flash', ptr._obj.hwnd)))
    api.focus(42)
    assert (actions == [('flash', 42)]) is flashes


def test_key_generation_disabled_does_not_write(monkeypatch):
    from app.services import open_link as service
    monkeypatch.delenv('MVHUB_OPEN_LINK', raising=False)
    monkeypatch.setattr(service, 'session', None)
    monkeypatch.setattr(service.Path, 'mkdir', lambda *a, **k: pytest.fail('unexpected write'))
    service.publish()
    monkeypatch.setenv('MVHUB_OPEN_LINK', '1')
    monkeypatch.setattr(service.config, 'AUTH_ENABLED', True)
    service.publish()
    assert service.session is None


@pytest.mark.parametrize('eligible', [True, False])
def test_child_environment_is_explicit_and_parent_unchanged(monkeypatch, eligible):
    monkeypatch.setenv('SystemRoot', r'C:\Windows')
    monkeypatch.setenv('MVHUB_OPEN_LINK', 'poison')
    monkeypatch.setenv('MVHUB_REGISTER_LINK', 'poison')
    monkeypatch.setattr(launcher, '_native_link_eligible', lambda: eligible)
    captured = {}
    def create(*args):
        captured.update(flags=args[5], environment=''.join(args[6]).rstrip('\0').split('\0'))
        return True
    launcher._create_suspended_process(SimpleNamespace(CreateProcessW=create), ROOT / 'MV_agent.bat')
    assert captured['flags'] & 0x400
    values = dict(item.split('=', 1) for item in captured['environment'] if item and not item.startswith('='))
    assert values.get('MVHUB_OPEN_LINK') == ('1' if eligible else None)
    assert 'MVHUB_REGISTER_LINK' not in values
    assert os.environ['MVHUB_OPEN_LINK'] == 'poison'


def test_registry_contract_without_filesystem_or_real_winreg(monkeypatch):
    monkeypatch.setattr(launcher, '_native_link_eligible', lambda: True)
    registry = Registry()
    assert launcher.register_open_link('8472', registry)
    assert registry.writes == 3
    assert launcher.register_open_link('8472', registry) and registry.writes == 3
    assert not launcher.register_open_link('0', registry)
    assert not launcher.register_open_link('9'*5000, registry)
    assert not launcher.register_open_link('８４７２', registry)
    monkeypatch.setattr(launcher, '_install_root', lambda: ROOT / 'another install')
    assert launcher.register_open_link('8472', registry) and registry.writes == 4
    assert 'another install' in registry.values[r'Software\Classes\mvhub\shell\open\command', ''][0]


def test_registration_writes_only_under_the_lock_and_always_releases(monkeypatch):
    import contextlib
    monkeypatch.setattr(launcher, '_native_link_eligible', lambda: True)
    state = {'held': False}

    class Guarded(Registry):
        def QueryValueEx(self, key, name):
            assert state['held'], 'registry read outside the lock'
            return super().QueryValueEx(key, name)

        def SetValueEx(self, *args):
            assert state['held'], 'registry write outside the lock'
            return super().SetValueEx(*args)
    registry = Guarded()
    assert not launcher.register_open_link('8472', registry, lambda: contextlib.nullcontext(False))
    assert registry.writes == 0  # busy: skip, startup goes on
    events = []

    @contextlib.contextmanager
    def lock():
        events.append('acquire')
        state['held'] = True
        try:
            yield True
        finally:
            state['held'] = False
            events.append('release')
    assert launcher.register_open_link('8472', registry, lock) and registry.writes == 3
    assert events == ['acquire', 'release']
    registry.values.clear()
    monkeypatch.setattr(registry, 'SetValueEx', lambda *a: (_ for _ in ()).throw(PermissionError()))
    assert not launcher.register_open_link('8472', registry, lock)
    assert events[-2:] == ['acquire', 'release']


@pytest.mark.skipif(os.name != 'nt', reason='Windows named mutex')
def test_real_registration_lock_busy_released_and_abandoned():
    import threading
    import uuid
    name = 'Local\\MVHubTest-' + uuid.uuid4().hex
    owned, release = threading.Event(), threading.Event()

    def holder():
        with launcher._open_link_lock(1000, name) as held:
            assert held
            owned.set()
            release.wait(10)
    thread = threading.Thread(target=holder)
    thread.start()
    assert owned.wait(10)
    with launcher._open_link_lock(100, name) as held:
        assert not held  # another thread holds it
    release.set()
    thread.join(10)
    with launcher._open_link_lock(100, name) as held:
        assert held  # released on exit

    from ctypes import wintypes
    kernel32 = ctypes.WinDLL('kernel32', use_last_error=True)
    kernel32.CreateMutexW.argtypes = [ctypes.c_void_p, wintypes.BOOL, wintypes.LPCWSTR]
    kernel32.CreateMutexW.restype = wintypes.HANDLE
    kernel32.WaitForSingleObject.argtypes = [wintypes.HANDLE, wintypes.DWORD]
    kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
    handles = []

    def abandon():
        handles.append(kernel32.CreateMutexW(None, False, name))
        assert kernel32.WaitForSingleObject(handles[0], 1000) == 0  # owns it, ends without releasing
    abandoner = threading.Thread(target=abandon)
    abandoner.start()
    abandoner.join(10)
    try:
        with launcher._open_link_lock(100, name) as held:
            assert held  # WAIT_ABANDONED counts as acquired
    finally:
        kernel32.CloseHandle(handles[0])


def test_isolated_script_invalid_argv_is_silent():
    import subprocess
    import sys
    result = subprocess.run([sys.executable, '-I', '-S', str(ROOT / 'open_link.py'), '--bad'],
                            capture_output=True, timeout=5, check=False)
    assert result.returncode == 0 and not result.stdout and not result.stderr


@pytest.mark.parametrize('failure', ['replace', 'readback'])
def test_publication_failure_never_enables_session(tmp_path, monkeypatch, failure):
    from app.services import open_link as service
    monkeypatch.setenv('LOCALAPPDATA', str(tmp_path))
    monkeypatch.setenv('MVHUB_OPEN_LINK', '1')
    monkeypatch.setattr(service.config, 'AUTH_ENABLED', False)
    monkeypatch.setattr(service, 'session', None)
    if failure == 'replace':
        def fail(*a): raise PermissionError()
        monkeypatch.setattr(service.os, 'replace', fail)
    else:
        monkeypatch.setattr(service.Path, 'read_bytes', lambda self: b'{}')
    service.publish()
    assert service.session is None
    assert not list(tmp_path.rglob('tmp*'))


def test_link_message_has_only_native_url_and_keeps_v4_text():
    from app.services.slack_notify import message
    target = {'kind': 'comment', 'project_name': 'p', 'author_name': '<a>', 'text': '<text>',
              'gen_id': 'server:gen', 'id': 'comment:1'}
    text, blocks = message(target)
    assert '&lt;a&gt;' in text and '&lt;text&gt;' in text
    assert '<mvhub://open/server:gen?c=comment:1|MV hub에서 보기 →>' in blocks[0]['text']['text']
    assert 'http' not in str(blocks)

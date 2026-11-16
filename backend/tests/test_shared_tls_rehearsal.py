"""Windows/Python 3.14 cutover rehearsal; only disposable code, keys and data."""
from __future__ import annotations

from contextlib import closing
import ipaddress
import json
import os
from pathlib import Path
import re
import select
import shutil
import socket
import sqlite3
import ssl
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request
from urllib.parse import urlsplit

import psutil
import pytest


ROOT = Path(__file__).resolve().parents[2]
FORBIDDEN_PORTS = {8010, 8012, 5173}
ADMIN = {'email': 'bootstrap@example.invalid', 'password': 'Synthetic-Admin-2026!'}


def _loopback(url):
    parts = urlsplit(url)
    assert parts.scheme in {'http', 'https'}
    assert ipaddress.ip_address(parts.hostname).is_loopback
    assert parts.port and parts.port not in FORBIDDEN_PORTS
    return url


def _port():
    while True:
        with socket.socket() as sock:
            sock.bind(('127.0.0.1', 0))
            port = sock.getsockname()[1]
        if port not in FORBIDDEN_PORTS:
            return port


class RecordingFront:
    """Byte-transparent relay: observe TLS before the server can reject it."""

    def __init__(self, target):
        self.target = target
        self.first_bytes = []
        self.peer_ports = []
        self.errors = []
        self.stopped = threading.Event()
        self.listener = socket.socket()
        self.listener.bind(('127.0.0.1', 0))
        self.port = self.listener.getsockname()[1]
        assert self.port not in FORBIDDEN_PORTS
        self.listener.listen()
        self.listener.settimeout(.2)
        self.workers = []
        self.thread = threading.Thread(target=self._accept, daemon=True)
        self.thread.start()

    def _accept(self):
        while not self.stopped.is_set():
            try:
                client, peer = self.listener.accept()
            except socket.timeout:
                continue
            except OSError:
                return
            thread = threading.Thread(target=self._relay, args=(client, peer), daemon=True)
            self.workers.append(thread)
            thread.start()

    def _relay(self, client, peer):
        try:
            with client:
                client.settimeout(2)
                first = client.recv(1)
                self.peer_ports.append(peer[1])
                self.first_bytes.append(first)
                if not first:
                    return
                with socket.create_connection(('127.0.0.1', self.target), timeout=2) as upstream:
                    upstream.sendall(first)
                    while not self.stopped.is_set():
                        ready, _, _ = select.select([client, upstream], [], [], .2)
                        for source in ready:
                            data = source.recv(65536)
                            if not data:
                                return
                            (upstream if source is client else client).sendall(data)
        except (ConnectionError, socket.timeout):
            pass  # Expected when a TLS handshake is refused or the server is replaced.
        except OSError as exc:
            if not self.stopped.is_set():
                self.errors.append(type(exc).__name__)

    def close(self):
        self.stopped.set()
        self.listener.close()
        deadline = time.monotonic() + 3
        self.thread.join(max(0, deadline - time.monotonic()))
        for worker in self.workers:
            worker.join(max(0, deadline - time.monotonic()))
        assert not self.thread.is_alive() and not any(t.is_alive() for t in self.workers)
        assert not self.errors, self.errors
        assert all(first == b'\x16' for first in self.first_bytes), 'plaintext or empty connection observed'


class Rehearsal:
    def __init__(self, root):
        self.root = root
        self.backend = root / 'copy' / 'backend'
        self.started = time.monotonic()
        self.deadline = self.started + 210  # Reserve 30 seconds for process and socket cleanup.
        self.processes = []
        self.owned = {}
        self.backup_children = set()
        self.lock = threading.Lock()
        self.done = threading.Event()
        self.expired = False
        self.monitor = threading.Thread(target=self._monitor, daemon=True)
        self.monitor.start()

    def remaining(self, maximum=15):
        remaining = self.deadline - time.monotonic()
        assert remaining > 0, 'rehearsal exceeded its execution budget'
        return min(maximum, remaining)

    def _monitor(self):
        while not self.done.wait(.02):
            with self.lock:
                for process in self.processes:
                    try:
                        parent = psutil.Process(process.pid)
                        if self.owned.get(parent.pid) != parent.create_time():
                            continue
                        for child in parent.children(recursive=True):
                            self.owned[child.pid] = child.create_time()
                            command = child.cmdline()
                            if 'app.services.worker_backup' in command and '--drain-one' in command:
                                self.backup_children.add((child.pid, child.create_time()))
                    except psutil.Error:
                        pass
            if time.monotonic() >= self.deadline:
                self.expired = True
                self.kill_all()
                return

    def owned_alive(self, pid):
        try:
            current = psutil.Process(pid)
            return current.create_time() == self.owned.get(pid) and current.is_running()
        except psutil.NoSuchProcess:
            return False

    def kill(self, process):
        try:
            current = psutil.Process(process.pid)
            if current.create_time() == self.owned.get(process.pid):
                killed = subprocess.run(['taskkill.exe', '/PID', str(process.pid), '/T', '/F'],
                                        capture_output=True, timeout=8,
                                        creationflags=subprocess.CREATE_NO_WINDOW)
                assert killed.returncode == 0 or not self.owned_alive(process.pid), (
                    'taskkill /T /F failed: ' + killed.stderr.decode(errors='replace'))
        except psutil.NoSuchProcess:
            pass
        process.wait(timeout=5)

    def spawn(self, args, env, log):
        with log.open('ab') as output:
            process = subprocess.Popen(args, cwd=self.backend, env=env, stdout=output, stderr=output,
                                       creationflags=subprocess.CREATE_NO_WINDOW)
        with self.lock:
            self.processes.append(process)
            self.owned[process.pid] = psutil.Process(process.pid).create_time()
        return process

    def kill_all(self):
        with self.lock:
            owned = list(self.owned.items())
        for pid, created in owned:
            try:
                process = psutil.Process(pid)
                if process.create_time() == created:
                    process.kill()
            except psutil.NoSuchProcess:
                pass

    def request(self, base, path, *, body=None, context=None, token=None, maximum=15, method=None):
        import server_tls
        _loopback(base)
        headers = {'Content-Type': 'application/json'}
        if token:
            headers['Authorization'] = 'Bearer ' + token
        req = urllib.request.Request(base + path,
                                     data=None if body is None else json.dumps(body).encode(),
                                     headers=headers, method=method)
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}),
                                             urllib.request.HTTPSHandler(context=context), server_tls.NoRedirect())
        try:
            response = opener.open(req, timeout=self.remaining(maximum))
        except urllib.error.HTTPError as exc:
            response = exc
        with response:
            return response.status, json.loads(response.read())

    def wait(self, predicate, *, seconds=30):
        until = time.monotonic() + self.remaining(seconds)
        while time.monotonic() < until:
            if predicate():
                return
            time.sleep(.2)
        pytest.fail('rehearsal readiness/observation deadline exceeded')

    def environment(self, name, port, shared, tls, *, auth):
        from smoke_env import build_smoke_env
        env = build_smoke_env(os.environ, self.root / name,
                              frontend_dist=self.root / 'frontend',
                              python_exe=Path(sys.executable), port=port)
        env.update(CONTENT_HUB_AUTH=str(int(auth)), CONTENT_HUB_READ_ONLY='0',
                   CONTENT_HUB_NO_PROXY=str(int(auth)), CONTENT_HUB_SHARED_URL=_loopback(shared),
                   MVHUB_SERVER_TLS_DIR=str(tls), PYTHONDONTWRITEBYTECODE='1',
                   CONTENT_HUB_AGENT_CHAT='0', CONTENT_HUB_SCENE_WRITER='0',
                   CONTENT_HUB_WORKER_BACKUP_STARTUP_DELAY_SECONDS='600',
                   CONTENT_HUB_WORKER_BACKUP_UPLOAD_TIMEOUT='20',
                   CONTENT_HUB_ADMIN_EMAIL=ADMIN['email'], CONTENT_HUB_ADMIN_PASSWORD=ADMIN['password'],
                   CONTENT_HUB_ACCESS_LOG='0')
        assert 'PROGRAMDATA' not in env
        assert not any(k.upper().endswith('_PROXY') and not k.startswith('CONTENT_HUB_') for k in env)
        return env

    def start(self, env, *, auth):
        for attempt in range(3):
            try:
                return self._start_once(env, auth=auth)
            except PortCollision:
                if attempt == 2:
                    raise
                env['CONTENT_HUB_PORT'] = env['PORT'] = str(_port())

    def _start_once(self, env, *, auth):
        import server_tls
        _loopback(env['CONTENT_HUB_SHARED_URL'])  # Before any app import or child launch.
        assert env['CONTENT_HUB_HOST'] == '127.0.0.1'
        port = int(env['CONTENT_HUB_PORT'])
        assert port not in FORBIDDEN_PORTS
        if auth:
            # read_config reads os.environ, not the supplied child environment.
            with pytest.MonkeyPatch.context() as patch:
                patch.setenv('MVHUB_SERVER_TLS_DIR', env['MVHUB_SERVER_TLS_DIR'])
                config = server_tls.read_config()
                assert config.state != 'error'
                if config.state == 'on':
                    cert, key = server_tls.server_files(config)
                    ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER).load_cert_chain(cert, key, password='')
                    env['CONTENT_HUB_SSL_CERTFILE'] = cert
                    env['CONTENT_HUB_SSL_KEYFILE'] = key
        log = self.root / (Path(env['CONTENT_HUB_DATA']).parent.name + '.log')
        process = self.spawn([sys.executable, '-B', str(self.backend / 'serve.py')], env, log)

        def ready():
            if process.poll() is not None:
                output = log.read_text('utf-8', errors='replace')
                if 'WinError 10048' in output:
                    raise PortCollision('temporary listener port was claimed')
                pytest.fail(f'serve.py exited {process.returncode}; log: {log}')
            if auth:
                probe = subprocess.run([sys.executable, '-B', str(ROOT / 'tools/server_tls.py'),
                                        '--probe', str(port)], env=env, capture_output=True,
                                       timeout=self.remaining(5), creationflags=subprocess.CREATE_NO_WINDOW)
                return probe.returncode == 0
            try:
                return self.request(f'http://127.0.0.1:{port}', '/api/ready')[0] == 200
            except (OSError, ValueError):
                return False
        self.wait(ready, seconds=45)
        return process

    def stop(self, process, port):
        self.kill(process)
        def closed():
            with socket.socket() as sock:
                sock.settimeout(.2)
                return sock.connect_ex(('127.0.0.1', port)) != 0
        self.wait(closed, seconds=5)

    def close(self):
        print(f'TLS_REHEARSAL execution_seconds={time.monotonic() - self.started:.3f}', flush=True)
        cleanup_end = min(self.started + 238, time.monotonic() + 25)
        errors = []

        def budget(limit):
            return max(.1, min(limit, cleanup_end - time.monotonic()))

        self.done.set()
        self.monitor.join(2)
        try:
            for process in reversed(self.processes):
                if process.poll() is not None:
                    continue
                try:
                    current = psutil.Process(process.pid)
                    if current.create_time() != self.owned.get(process.pid):
                        continue
                    killed = subprocess.run(['taskkill.exe', '/PID', str(process.pid), '/T', '/F'],
                                            capture_output=True, timeout=budget(4),
                                            creationflags=subprocess.CREATE_NO_WINDOW)
                    if killed.returncode and self.owned_alive(process.pid):
                        errors.append('taskkill: ' + killed.stderr.decode(errors='replace'))
                except psutil.NoSuchProcess:
                    pass
                except subprocess.TimeoutExpired:
                    errors.append('taskkill timeout')
        finally:
            # Always release owned processes even when taskkill is unavailable; do not pass the test.
            self.kill_all()
        for pid, created in self.owned.items():
            try:
                process = psutil.Process(pid)
                if process.create_time() == created:
                    process.wait(timeout=budget(2))
            except psutil.NoSuchProcess:
                pass
            except psutil.TimeoutExpired:
                errors.append('owned process survived cleanup')
        survivors = [pid for pid in self.owned if self.owned_alive(pid)]
        if survivors:
            errors.append(f'tracked child/root PIDs survived cleanup: {survivors}')
        env = dict(os.environ, MVHUB_REHEARSAL_COPY=str(self.backend.parent))
        try:
            check = subprocess.run(['powershell.exe', '-NoProfile', '-NonInteractive', '-Command',
                                    "@(Get-CimInstance Win32_Process -ErrorAction Stop | Where-Object {"
                                    "$_.CommandLine -and $_.CommandLine.Contains($env:MVHUB_REHEARSAL_COPY)}).Count"],
                                   env=env, capture_output=True, text=True, timeout=budget(8),
                                   creationflags=subprocess.CREATE_NO_WINDOW)
            if check.returncode or check.stdout.strip() != '0':
                errors.append('Win32_Process cleanup query failed or found survivors: ' + check.stderr)
        except subprocess.TimeoutExpired:
            errors.append('Win32_Process cleanup query timeout')
        elapsed = time.monotonic() - self.started
        print(f'TLS_REHEARSAL elapsed_seconds={elapsed:.3f}', flush=True)
        assert not errors, '\n'.join(errors)
        assert not self.expired and elapsed < 240


class PortCollision(RuntimeError):
    pass


@pytest.mark.parametrize('alive', [False, True])
def test_taskkill_exit_race(monkeypatch, alive):
    from unittest.mock import Mock

    run = object.__new__(Rehearsal)
    process = Mock(pid=123)
    run.owned = {123: 456}
    current = Mock()
    current.create_time.return_value = 456
    monkeypatch.setattr(psutil, 'Process', lambda pid: current)
    monkeypatch.setattr(run, 'owned_alive', lambda pid: alive)
    monkeypatch.setattr(subprocess, 'run', lambda *a, **kw: subprocess.CompletedProcess(
        a[0], 1, stdout=b'', stderr=b'process not found or access denied'))
    if alive:
        with pytest.raises(AssertionError, match='taskkill'):
            run.kill(process)
        process.wait.assert_not_called()
    else:
        run.kill(process)
        process.wait.assert_called_once_with(timeout=5)


def _copy_backend(destination):
    # Copy only executable app sources/resources, never the backend's runtime directories.
    def excluded(directory, names):
        return [name for name in names if name in {'tests', '.venv', '__pycache__', 'logs', 'backups'}
                or '.log' in name or 'cache' in name.lower() and Path(directory, name).is_dir()
                or name.startswith('data') and Path(directory, name).is_dir()
                or Path(directory, name).is_symlink() or Path(directory, name).is_junction()
                or name.endswith(('.pyc', '.pyo'))]
    destination.mkdir(parents=True)
    shutil.copytree(ROOT / 'backend/app', destination / 'app', ignore=excluded)
    shutil.copyfile(ROOT / 'backend/serve.py', destination / 'serve.py')
    shutil.copyfile(ROOT / 'backend/schema.sql', destination / 'schema.sql')
    shutil.copyfile(ROOT / 'hf_cli_version.txt', destination.parent / 'hf_cli_version.txt')
    transport = destination / 'app/services/shared_transport.py'
    source, count = re.subn(r'^TLS_REQUIRED = False[^\r\n]*$', 'TLS_REQUIRED = True',
                           transport.read_text('utf-8'), flags=re.M)
    assert count == 1
    transport.write_text(source, encoding='utf-8')


def _certificate(run, folder):
    # A separately owned process bounds OpenSSL/self_check as well as server execution.
    script = '''
import sys
from unittest.mock import patch
sys.path.insert(0, sys.argv[1])
import server_tls_cert as cert
with patch.object(cert, '_require_admin', lambda: None), \\
     patch.object(cert, '_check_directory_access', lambda path: None), \\
     patch.object(cert, 'set_acl', lambda *a, **kw: None), \\
     patch.object(cert, '_create_key', lambda path: path.open('xb')):
    cert.create(ip='192.0.2.10')
'''
    port = _port()
    env = run.environment(folder.name + '-create', port, f'http://127.0.0.1:{port}', folder, auth=True)
    process = run.spawn([sys.executable, '-B', '-c', script, str(ROOT / 'tools')],
                        env, run.root / (folder.name + '-create.log'))
    assert process.wait(timeout=run.remaining(40)) == 0, 'D2 create/self_check failed; see certificate creation log'
    for extension in ('pem', 'key'):
        (folder / ('next.' + extension)).rename(folder / ('server.' + extension))
    context = ssl.create_default_context(cafile=str(folder / 'server.pem'))
    context.verify_flags |= ssl.VERIFY_X509_STRICT | ssl.VERIFY_X509_PARTIAL_CHAIN
    return context


def test_shared_tls_rehearsal(tmp_path, monkeypatch):
    assert os.name == 'nt', 'Windows rehearsal is required, not skipped'
    assert sys.version_info[:2] == (3, 14), 'release Python 3.14 is required'
    assert tmp_path.resolve().is_relative_to(Path(tempfile.gettempdir()).resolve())
    monkeypatch.syspath_prepend(str(ROOT / 'tools'))
    run = Rehearsal(tmp_path)
    front = None
    unused = socket.socket()
    try:
        # Reserve (without listening) a separate destination for server outbound defaults.
        unused.bind(('127.0.0.1', 0))
        server_shared = _loopback(f'http://127.0.0.1:{unused.getsockname()[1]}')
        _copy_backend(run.backend)
        cert_a, cert_b, tls_off = (tmp_path / name for name in ('cert-a', 'cert-b', 'tls-off'))
        context_a = _certificate(run, cert_a)
        context_b = _certificate(run, cert_b)
        bundle = run.backend / 'app/resources/tls/shared_server.pem'
        bundle.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(cert_a / 'server.pem', bundle)
        server_port, hub_port = _port(), _port()
        assert server_port != hub_port
        front = RecordingFront(server_port)
        shared = f'http://127.0.0.1:{front.port}'
        assert server_shared != shared
        server_env = run.environment('server-a', server_port, server_shared, cert_a, auth=True)
        server = run.start(server_env, auth=True)
        server_port = front.target = int(server_env['CONTENT_HUB_PORT'])
        direct = f'https://127.0.0.1:{server_port}'
        hub_env = run.environment('hub', hub_port, shared, tls_off, auth=False)
        run.start(hub_env, auth=False)
        hub = f"http://127.0.0.1:{hub_env['CONTENT_HUB_PORT']}"
        credentials = {'email': 'rehearsal@example.invalid', 'password': 'Synthetic-TLS-2026!'}
        status, registered = run.request(hub, '/api/shared-server/register', body={**credentials, 'url': shared})
        assert status == 200 and registered['pending']
        # AUTH startup creates a bootstrap admin; exercise its real approval API.
        status, admin = run.request(direct, '/api/auth/login', body=ADMIN, context=context_a)
        assert status == 200
        for suffix, body in [('status', {'status': 'approved'}),
                             ('global-roles', {'global_roles': ['admin', 'product_manager']})]:
            status, _ = run.request(direct, '/api/auth/accounts/' + credentials['email'] + '/' + suffix,
                                    body=body, method='PATCH', context=context_a, token=admin['token'])
            assert status == 200
        status, logged_in = run.request(hub, '/api/shared-server/login', body={**credentials, 'url': shared})
        assert status == 200 and logged_in['ok']
        status, connection = run.request(hub, '/api/shared-server/status')
        assert status == 200 and connection['url'] == shared and connection['proxying'] is True
        status, direct_login = run.request(direct, '/api/auth/login', body=credentials, context=context_a)
        assert status == 200
        status, project = run.request(direct, '/api/projects', body={'name': 'TLS server-only project'},
                                      token=direct_login['token'], context=context_a)
        assert status == 200, 'synthetic server project creation failed'
        status, projects = run.request(hub, '/api/projects?tab=team')
        assert status == 200 and any(p['id'] == project['id'] and p['name'] == 'TLS server-only project'
                                    for p in projects['projects'])
        run.wait(lambda: run.request(hub, '/api/health')[1]['remote_realtime']['connected'])
        assert run.request(hub, '/api/health')[1]['remote_realtime']['state'] == 'connected'

        backup_status, backup_result = run.request(hub, '/api/db/server-backup', body={}, maximum=35)
        assert backup_status == 200 and backup_result.get('state') == 'success', (
            f'Actual /api/db/server-backup: HTTP {backup_status}, {backup_result}; '
            'closest faithful alternative: create one synthetic personal record, then call the same API; no mocks')
        assert run.backup_children, 'process monitor did not observe a real worker_backup --drain-one child'
        status, backups = run.request(direct, '/api/db-backup', context=context_a, token=direct_login['token'])
        assert status == 200 and any(b.get('backup_set_id') and b.get('kind') == 'set'
                                    for b in backups['backups']), 'receiver must retain the acknowledged set'
        print('TLS_REHEARSAL register_login=passed proxy_read=passed wss=connected backup=success '
              f'receiver_set=present backup_child_observed={len(run.backup_children)}', flush=True)

        for name, folder, context in [('wrong-cert', cert_b, context_b), ('plain', tls_off, None)]:
            run.stop(server, server_port)
            env = run.environment(name, server_port, server_shared, folder, auth=True)
            server = run.start(env, auth=True)
            server_port = front.target = int(env['CONTENT_HUB_PORT'])
            scheme = 'https' if context else 'http'
            assert run.request(f'{scheme}://127.0.0.1:{server_port}', '/api/ready', context=context)[0] == 200
            baseline = len(front.first_bytes)
            status, state = run.request(hub, '/api/shared-server/status')
            assert status == 200 and state['url'] == shared
            status, _ = run.request(hub, '/api/shared-server/login', body=credentials)
            assert status >= 400
            status, _ = run.request(hub, '/api/projects?tab=team')
            assert status >= 400
            if context:
                run.wait(lambda: run.request(hub, '/api/health')[1]['remote_realtime']['last_error']
                         == 'SSLCertVerificationError', seconds=25)
            observed = front.first_bytes[baseline:]
            assert observed and all(first == b'\x16' for first in observed), 'HTTP fallback or no observed hub traffic'
            print(f'TLS_REHEARSAL {name} TLS_connections={len(observed)} '
                  f'source_ports={front.peer_ports[baseline:]} plaintext=0', flush=True)
            with closing(sqlite3.connect(env['CONTENT_HUB_DB'])) as connection:
                # The normal AUTH bootstrap admin exists even without client traffic.
                assert connection.execute('SELECT count(*) FROM account WHERE email != ?',
                                          (ADMIN['email'],)).fetchone()[0] == 0
    finally:
        try:
            if front:
                front.close()
        finally:
            try:
                run.close()
            finally:
                unused.close()

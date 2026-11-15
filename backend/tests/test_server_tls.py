"""Real loopback TLS with disposable keys; never reads the machine TLS directory."""
import io
import json
import os
from pathlib import Path
import shutil
import socket
import ssl
import subprocess
import sys
import threading
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest.mock import Mock

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'tools'))
import server_tls


@pytest.fixture(autouse=True)
def tls_dir(tmp_path, monkeypatch):
    directory = tmp_path / 'server-tls'
    directory.mkdir(exist_ok=True)
    monkeypatch.setenv('MVHUB_SERVER_TLS_DIR', str(directory))
    return directory


@pytest.fixture
def certificates(tmp_path):
    openssl = shutil.which('openssl') or r'C:\Program Files\Git\usr\bin\openssl.exe'
    if not Path(openssl).is_file():
        pytest.skip('OpenSSL is required to generate disposable D2 test certificates')

    def run(*args):
        result = subprocess.run([openssl, *map(str, args)], cwd=tmp_path, capture_output=True, timeout=20)
        assert result.returncode == 0, 'OpenSSL certificate generation failed'

    def leaf(name, san='IP:127.0.0.1,DNS:localhost', signer=None):
        key, cert = tmp_path / (name + '.key'), tmp_path / (name + '.pem')
        ext = tmp_path / (name + '.ext')
        ext.write_text('basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\n'
                       'extendedKeyUsage=serverAuth\nsubjectAltName=' + san + '\n'
                       'subjectKeyIdentifier=hash\nauthorityKeyIdentifier=keyid\n', encoding='ascii')
        run('ecparam', '-name', 'prime256v1', '-genkey', '-noout', '-out', key)
        if signer:
            csr = tmp_path / (name + '.csr')
            run('req', '-new', '-key', key, '-out', csr, '-subj', '/CN=mvhub-shared-server')
            run('x509', '-req', '-in', csr, '-CA', signer[1], '-CAkey', signer[0], '-CAcreateserial',
                '-out', cert, '-days', '2', '-extfile', ext)
        else:
            cfg = tmp_path / (name + '.cnf')
            cfg.write_text('[req]\ndistinguished_name=dn\n[dn]\n[v3]\n' + ext.read_text(), encoding='ascii')
            run('req', '-new', '-x509', '-key', key, '-out', cert, '-days', '2',
                '-subj', '/CN=mvhub-shared-server', '-extensions', 'v3', '-config', cfg)
        return key, cert

    return leaf


def install_certificate(tls_dir, pair):
    shutil.copyfile(pair[0], tls_dir / 'server.key')
    shutil.copyfile(pair[1], tls_dir / 'server.pem')


@contextmanager
def tls_server(pair=None):
    seen = []

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            seen.append((self.path, self.headers.get('Authorization')))
            if self.path == '/redirect':
                self.send_response(302)
                self.send_header('Location', '/unexpected')
                self.end_headers()
                return
            payload = {'status': 'ready', 'checks': {'content': 'ok', 'trash': 'ok', 'manage': 'ok'}}
            if self.path == '/api/auth/login':
                payload = {'token': 'test-token', 'account': {'email': 'admin@test', 'status': 'approved', 'global_roles': ['admin']}}
            raw = json.dumps(payload).encode()
            self.send_response(200)
            self.send_header('Content-Length', str(len(raw)))
            self.end_headers()
            self.wfile.write(raw)

        def do_POST(self):
            self.rfile.read(int(self.headers.get('Content-Length', '0')))
            self.do_GET()

        def log_message(self, *args):
            pass

    server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    if pair:
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        context.load_cert_chain(str(pair[1]), str(pair[0]))
        server.socket = context.wrap_socket(server.socket, server_side=True)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield server.server_port, seen
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)


@pytest.mark.parametrize('kind', ['self', 'other', 'signed', 'san'])
def test_d2_real_handshake(certificates, tls_dir, kind):
    trusted = certificates('trusted')
    peer = trusted
    if kind == 'other':
        peer = certificates('other')
    elif kind == 'signed':
        peer = certificates('signed', signer=trusted)
    elif kind == 'san':
        trusted = peer = certificates('wrong-name', san='DNS:mvhub-only')
    install_certificate(tls_dir, trusted)
    context = server_tls.client_context()
    assert context.verify_mode == ssl.CERT_REQUIRED and context.check_hostname
    assert context.verify_flags & ssl.VERIFY_X509_STRICT
    assert context.verify_flags & ssl.VERIFY_X509_PARTIAL_CHAIN
    with tls_server(peer) as (port, _):
        def connect():
            with socket.create_connection(('127.0.0.1', port), timeout=3) as raw:
                with context.wrap_socket(raw, server_hostname='127.0.0.1'):
                    pass
        if kind == 'self':
            connect()
        else:
            with pytest.raises(ssl.SSLCertVerificationError):
                connect()


@pytest.mark.parametrize('files', [(), ('server.pem',), ('server.key',), ('server.pem', 'server.key')])
def test_configuration_states_and_error_probe(tls_dir, files, capsys, monkeypatch):
    monkeypatch.setattr(server_tls, '_override_logged', False)
    for name in files:
        (tls_dir / name).write_text('invalid test material')
    config = server_tls.read_config()
    assert config.state == ('error' if files else 'off')
    assert 'MVHUB_SERVER_TLS_DIR' in capsys.readouterr().err
    if files:
        with pytest.raises(server_tls.TLSConfigError):
            server_tls.client_context(config)
        assert server_tls.main(['--probe', '1']) == 3  # configuration fails before any socket


def test_readers_do_not_open_private_key(certificates, tls_dir, monkeypatch):
    install_certificate(tls_dir, certificates('trusted'))
    real_open = io.open
    real_builtin = open
    real_context = ssl.create_default_context
    opened = []

    def guarded_open(file, *args, **kwargs):
        assert str(file) != str(tls_dir / 'server.key')
        return real_open(file, *args, **kwargs)

    def builtin_open(file, *args, **kwargs):
        assert str(file) != str(tls_dir / 'server.key')
        return real_builtin(file, *args, **kwargs)

    def context(*args, **kwargs):
        opened.append(kwargs)
        assert kwargs == {'cafile': str(tls_dir / 'server.pem')}
        return real_context(*args, **kwargs)

    monkeypatch.setattr(io, 'open', guarded_open)
    monkeypatch.setattr('builtins.open', builtin_open)
    monkeypatch.setattr(ssl, 'create_default_context', context)
    monkeypatch.setattr(ssl.SSLContext, 'load_cert_chain', Mock(side_effect=AssertionError('reader loaded a private key')))
    assert server_tls.read_config().state == 'on'
    assert server_tls.client_context().check_hostname
    assert opened


@pytest.mark.parametrize('secure', [False, True])
def test_probe_exit_codes_and_no_redirect(certificates, tls_dir, secure):
    pair = certificates('probe') if secure else None
    if pair:
        install_certificate(tls_dir, pair)
    with tls_server(pair) as (port, seen):
        assert server_tls.main(['--probe', str(port)]) == 0
        result = subprocess.run([sys.executable, '-B', str(Path(server_tls.__file__)), '--probe', str(port)],
                                capture_output=True, timeout=10)
        assert result.returncode == 0
        config = server_tls.read_config()
        import urllib.error
        with pytest.raises(urllib.error.HTTPError) as caught:
            server_tls.opener(config).open(f'{config.scheme}://127.0.0.1:{port}/redirect')
        assert caught.value.code == 302
        assert not any(path == '/unexpected' for path, _ in seen)


def test_probe_rejects_wrong_certificate(certificates, tls_dir):
    install_certificate(tls_dir, certificates('trusted'))
    with tls_server(certificates('other')) as (port, _):
        assert server_tls.main(['--probe', str(port)]) == 3


def test_override_logged_once(tls_dir, monkeypatch, capsys):
    monkeypatch.setattr(server_tls, '_override_logged', False)
    server_tls.read_config()
    server_tls.read_config()
    assert capsys.readouterr().err.count('override active') == 1


def test_missing_programdata_is_error_without_filesystem_access(monkeypatch):
    monkeypatch.delenv('MVHUB_SERVER_TLS_DIR')
    monkeypatch.delenv('PROGRAMDATA', raising=False)
    monkeypatch.setattr(Path, 'stat', Mock(side_effect=AssertionError('must not guess a directory')))
    assert server_tls.read_config().error == 'server_tls_directory_unknown'
    assert server_tls.main(['--scheme']) == 3


def test_programdata_resolution_uses_only_temp_directory(tmp_path, monkeypatch):
    monkeypatch.delenv('MVHUB_SERVER_TLS_DIR')
    monkeypatch.setenv('PROGRAMDATA', str(tmp_path))
    config = server_tls.read_config()
    assert config.state == 'off'
    assert config.cert == tmp_path / 'MVHub/server-tls/server.pem'


@pytest.mark.parametrize('arguments', [['--probe', '0'], ['--probe', 'invalid'], []])
def test_argument_errors_are_distinct_from_tls_errors(arguments):
    with pytest.raises(SystemExit) as caught:
        server_tls.main(arguments)
    assert caught.value.code == 2

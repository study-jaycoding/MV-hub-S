"""공유 전송 경계: 임시 D2 인증서와 loopback 임의 포트만 사용한다."""
import json
import logging
import ssl
import threading
import urllib.error
import urllib.request
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest

from app.services import shared_transport as transport
from test_server_tls import certificates  # 기존 D2 생성기; 개인키는 tmp_path 안에만 생성


@contextmanager
def transport_server(pair=None, *, status=200, location='/target', body=b'{}'):
    seen = []

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            payload = self.rfile.read(int(self.headers.get('Content-Length', '0')))
            seen.append((self.path, dict(self.headers), payload))
            self.send_response(status)
            if status in (301, 302, 303, 307, 308):
                self.send_header('Location', location)
            self.send_header('ETag', '"test-etag"')
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(body) if status != 304 else 0))
            self.end_headers()
            if self.command != 'HEAD' and status != 304:
                self.wfile.write(body)

        do_HEAD = do_POST = do_PUT = do_GET

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
        yield f'http://127.0.0.1:{server.server_port}', seen
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)


@pytest.fixture
def required_tls(certificates, monkeypatch):
    pair = certificates('trusted')
    monkeypatch.setattr(transport, 'TLS_REQUIRED', True)
    monkeypatch.setattr(transport, 'BUNDLE_PATH', pair[1])
    return pair


@pytest.mark.parametrize('kind', ['self', 'other', 'signed', 'san', 'default-only'])
def test_real_trust_boundary(required_tls, certificates, monkeypatch, kind):
    peer = required_tls
    if kind in ('other', 'default-only'):
        peer = certificates('other')
    elif kind == 'signed':
        peer = certificates('signed', signer=required_tls)
    elif kind == 'san':
        peer = certificates('wrong-name', san='DNS:unrelated.invalid')
        monkeypatch.setattr(transport, 'BUNDLE_PATH', peer[1])
    if kind == 'default-only':
        monkeypatch.setenv('SSL_CERT_FILE', str(peer[1]))
    context = transport.ssl_context()
    assert context.cert_store_stats() == {'x509': 1, 'x509_ca': 0, 'crl': 0}
    assert context.verify_mode == ssl.CERT_REQUIRED and context.check_hostname
    assert context.verify_flags & ssl.VERIFY_X509_STRICT
    assert context.verify_flags & ssl.VERIFY_X509_PARTIAL_CHAIN
    with transport_server(peer) as (base, seen):
        url = transport.transport_url(base + '/check?q=1')
        if kind == 'self':
            with transport.opener(proxy=False).open(url, timeout=3) as response:
                assert response.read() == b'{}'
        else:
            with pytest.raises(urllib.error.URLError) as caught:
                transport.opener(proxy=False).open(url, timeout=3)
            assert isinstance(caught.value.reason, ssl.SSLCertVerificationError)
            assert seen == []
        if kind == 'default-only':
            # 기본 신뢰 경로가 실제로 유효해도 제품 컨텍스트는 섞지 않는다.
            with urllib.request.build_opener(urllib.request.ProxyHandler({})).open(url, timeout=3) as response:
                assert response.status == 200


@pytest.mark.parametrize('present', [False, True])
def test_error_never_sends_http(tmp_path, monkeypatch, present):
    bundle = tmp_path / 'broken.pem'
    if present:
        bundle.write_text('not a certificate')
    monkeypatch.setattr(transport, 'BUNDLE_PATH', bundle)
    monkeypatch.setattr(transport, 'TLS_REQUIRED', True)
    with transport_server() as (base, seen):
        with pytest.raises(transport.TLSConfigError):
            transport.transport_url(base)
        with pytest.raises(transport.TLSConfigError):
            transport.ssl_context()
        assert not seen


def test_off_ignores_bundle_and_logs_once(tmp_path, monkeypatch, caplog):
    bundle = tmp_path / 'broken.pem'
    bundle.write_text('broken')
    monkeypatch.setattr(transport, 'BUNDLE_PATH', bundle)
    monkeypatch.setattr(transport, 'TLS_REQUIRED', False)
    monkeypatch.setattr(transport, '_logged', set())
    with caplog.at_level(logging.INFO, logger=transport._log.name):
        assert transport.transport_url('http://host:123/a%2Fb?q=1') == 'http://host:123/a%2Fb?q=1'
        assert transport.transport_url('https://host:123/a') == 'https://host:123/a'
        context = transport.ssl_context()
    assert context.verify_mode == ssl.CERT_REQUIRED and context.check_hostname
    assert [r.event_fields for r in caplog.records if r.name == transport._log.name] == [
        {'event': 'shared_transport_state', 'state': 'off'}]


def test_on_preserves_url_and_logs_once(required_tls, monkeypatch, caplog):
    monkeypatch.setattr(transport, '_logged', set())
    with caplog.at_level(logging.INFO, logger=transport._log.name):
        assert transport.transport_url('http://host:123/a%2Fb?q=1') == 'https://host:123/a%2Fb?q=1'
        transport.ssl_context()
    assert [r.event_fields for r in caplog.records if r.name == transport._log.name] == [
        {'event': 'shared_transport_state', 'state': 'on'}]


@pytest.mark.parametrize('secure', [False, True])
@pytest.mark.parametrize('status', [301, 302, 303, 307, 308])
@pytest.mark.parametrize('destination', ['same', 'other', 'downgrade'])
def test_redirect_never_forwards_credentials(required_tls, monkeypatch, secure, status, destination):
    monkeypatch.setattr(transport, 'TLS_REQUIRED', secure)
    with transport_server() as (target, leaked):
        location = '/target' if destination == 'same' else target.replace('127.0.0.1', 'localhost') + '/target'
        if destination == 'downgrade':
            location = target + '/target'  # 같은 호스트의 HTTPS → HTTP도 자격 증명을 보내지 않는다.
        with transport_server(required_tls if secure else None, status=status, location=location) as (base, seen):
            req = urllib.request.Request(transport.transport_url(base + '/start'),
                                         headers={'Authorization': 'Bearer test', 'Cookie': 'ch_session=test'})
            with pytest.raises(urllib.error.HTTPError) as caught:
                transport.opener(proxy=False).open(req, timeout=3)
            assert caught.value.code == status
            caught.value.close()
            assert [r[0] for r in seen] == ['/start']
            assert seen[0][1]['Authorization'] == 'Bearer test'
            assert not leaked


def test_proxy_policy(monkeypatch):
    monkeypatch.setattr(urllib.request, 'getproxies', lambda: {'http': 'http://proxy.invalid:4321'})
    handlers = transport.opener().handlers
    assert any(isinstance(h, urllib.request.ProxyHandler) and h.proxies.get('http') == 'http://proxy.invalid:4321'
               for h in handlers)
    assert not any(isinstance(h, urllib.request.ProxyHandler) for h in transport.opener(proxy=False).handlers)


@pytest.mark.parametrize('broken', [False, True])
def test_opener_refuses_plain_http_without_url_rewrite(required_tls, monkeypatch, tmp_path, broken):
    if broken:
        monkeypatch.setattr(transport, 'BUNDLE_PATH', tmp_path / 'missing.pem')
    with transport_server() as (base, seen):
        with pytest.raises(transport.TLSConfigError):
            transport.opener(proxy=False).open(base, timeout=3)
        assert not seen


@pytest.mark.parametrize('url', ['ftp://host/a', 'file:///a', 'data:text/plain,a', 'host/a'])
def test_on_rejects_unsupported_schemes(required_tls, url):
    with pytest.raises(transport.TLSConfigError):
        transport.transport_url(url)


def test_context_cache_rechecks_bundle(required_tls, monkeypatch, tmp_path):
    context = transport.ssl_context()
    assert transport.ssl_context() is context
    bundle = tmp_path / 'copy.pem'
    bundle.write_bytes(required_tls[1].read_bytes())
    monkeypatch.setattr(transport, 'BUNDLE_PATH', bundle)
    replacement = transport.ssl_context()
    assert replacement is not context
    bundle.write_bytes(bundle.read_bytes() + b'\n')
    assert transport.ssl_context() is not replacement
    bundle.write_text('broken')
    with pytest.raises(transport.TLSConfigError):
        transport.ssl_context()


def test_error_state_logged_once_at_warning(monkeypatch, tmp_path, caplog):
    monkeypatch.setattr(transport, 'TLS_REQUIRED', True)
    monkeypatch.setattr(transport, 'BUNDLE_PATH', tmp_path / 'missing.pem')
    monkeypatch.setattr(transport, '_logged', {'on'})
    for _ in range(2):
        with pytest.raises(transport.TLSConfigError):
            transport.ssl_context()
    records = [r for r in caplog.records if r.name == transport._log.name]
    assert len(records) == 1 and records[0].levelno >= logging.WARNING
    assert records[0].event_fields['state'] == 'error'


def test_connect_limit_and_response_timeout(monkeypatch):
    from unittest.mock import Mock
    sock = Mock()
    connect = Mock(return_value=sock)
    monkeypatch.setattr(transport.socket, 'create_connection', connect)
    assert transport._fast_connect(('127.0.0.1', 12345), 60) is sock
    connect.assert_called_once_with(('127.0.0.1', 12345), 3.0, None)
    sock.settimeout.assert_called_once_with(60)


def test_cached_openers_preserve_proxy_policy():
    default, direct = transport.cached_opener(), transport.cached_opener(proxy=False)
    assert default is not direct
    for _ in range(4):
        assert transport.cached_opener() is default
        assert transport.cached_opener(proxy=True) is default
        assert transport.cached_opener(proxy=False) is direct
    assert not any(isinstance(h, urllib.request.ProxyHandler)
                   for h in transport.cached_opener(proxy=False).handlers)


@pytest.mark.parametrize('scheme,expected', [('http', 'https'), ('https', 'https'), ('ws', 'wss'), ('wss', 'wss')])
def test_transport_schemes(required_tls, monkeypatch, scheme, expected):
    url = scheme + '://host/a%2Fb?q=1'
    assert transport.transport_url(url) == expected + '://host/a%2Fb?q=1'
    monkeypatch.setattr(transport, 'TLS_REQUIRED', False)
    assert transport.transport_url(url) == url


def test_off_https_keeps_stdlib_context(certificates, monkeypatch):
    pair = certificates('default-trust')
    monkeypatch.setenv('SSL_CERT_FILE', str(pair[1]))
    monkeypatch.setattr(transport, 'TLS_REQUIRED', False)
    opener = transport.opener(proxy=False)
    handler = next(h for h in opener.handlers if isinstance(h, transport._FastConnectHTTPSHandler))
    original = handler.do_open
    def checked(connection, request, **kwargs):
        assert kwargs['context'] is handler._context  # 기본 신뢰·ALPN 등 stdlib 설정 보존
        return original(connection, request, **kwargs)
    monkeypatch.setattr(handler, 'do_open', checked)
    with transport_server(pair) as (base, seen):
        with opener.open(base.replace('http:', 'https:') + '/off', timeout=3) as response:
            assert response.status == 200
        assert len(seen) == 1

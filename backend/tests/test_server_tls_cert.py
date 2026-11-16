"""Certificate admin command, isolated in TEMP; never changes the machine TLS directory."""
import json
import os
from pathlib import Path
import socket
import ssl
import subprocess
import sys

import pytest

from test_server_tls import certificates, tls_dir, tls_server  # noqa: F401

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'tools'))
import server_tls
import server_tls_cert as command


@pytest.fixture
def admin(monkeypatch, tls_dir):
    monkeypatch.setattr(command, '_is_admin', lambda: True)
    calls = []

    def acl(path, **kwargs):
        calls.append((path.name, path.stat().st_size if path.is_file() else None, kwargs))
    monkeypatch.setattr(command, 'set_acl', acl)
    def prepare(path, *, create=False):
        if create:
            path.mkdir(parents=True, exist_ok=True)
            command.set_acl(path, directory=True)
    monkeypatch.setattr(command, '_prepare_directory', prepare)
    monkeypatch.setattr(command, '_create_key', lambda path: path.open('xb'))
    return calls


@pytest.fixture
def created(admin):
    return command.create('192.0.2.10', 'mvhub.example')


def test_create_real_profile_and_output(admin, tls_dir, capsys):
    assert command.main(['create', '--ip', '192.0.2.10', '--dns', 'mvhub.example']) == 0
    cert, key = tls_dir / 'next.pem', tls_dir / 'next.key'
    decoded = ssl._ssl._test_decode_cert(str(cert))
    assert ssl.cert_time_to_seconds(decoded['notAfter']) - ssl.cert_time_to_seconds(decoded['notBefore']) == 825 * 86400
    assert command.self_check(cert, key, command.trusted_openssl()) == ['192.0.2.10', '127.0.0.1', 'localhost', 'mvhub.example']
    assert not (tls_dir / 'server.pem').exists() and not (tls_dir / 'server.key').exists()
    assert ('next.key', 0, {}) in admin
    assert ('next.pem', 0, {'public': True}) in admin
    assert any(kwargs == {'directory': True} for _, _, kwargs in admin)
    out = capsys.readouterr()
    assert 'SHA-256:' in out.out and '만료(UTC):' in out.out
    assert 'PRIVATE KEY' not in out.out + out.err
    assert key.read_text().strip() not in out.out + out.err


def test_create_specified_days_and_ipv6(admin, tls_dir):
    cert = command.create('2001:db8::10', days=30)
    info = ssl._ssl._test_decode_cert(str(cert))
    assert ssl.cert_time_to_seconds(info['notAfter']) - ssl.cert_time_to_seconds(info['notBefore']) == 30 * 86400
    assert '2001:db8::10' in command.self_check(cert, tls_dir / 'next.key', command.trusted_openssl())


@pytest.mark.parametrize('ip', ['bad', '127.0.0.1', '::1', '0.0.0.0', '::', '224.0.0.1', 'ff02::1', 'fe80::1%12'])
def test_create_rejects_ip(admin, ip, tls_dir):
    with pytest.raises(command.CertificateError):
        command.create(ip)
    assert not list(tls_dir.iterdir())


@pytest.mark.parametrize('dns', ['x\n[evil]', 'x,y', 'x;evil', '', 'a' * 64, 'x\rDNS:evil'])
def test_create_rejects_dns(admin, dns):
    with pytest.raises(command.CertificateError):
        command.create('192.0.2.10', dns)


@pytest.mark.parametrize('days', [0, 29, 3651, -1, 30.5, True])
def test_create_rejects_days(admin, days):
    with pytest.raises(command.CertificateError):
        command.create('192.0.2.10', days=days)


@pytest.mark.parametrize('name', ['next.pem', 'next.key', 'promote.pending'])
def test_create_preserves_existing(admin, tls_dir, name):
    path = tls_dir / name
    path.write_text('existing')
    with pytest.raises(command.CertificateError):
        command.create('192.0.2.10')
    assert path.read_text() == 'existing'
    assert len(list(tls_dir.iterdir())) == 1


def test_create_does_not_touch_active_pair(admin, tls_dir):
    for name in ('server.pem', 'server.key'):
        (tls_dir / name).write_text('existing')
    command.create('192.0.2.10')
    assert (tls_dir / 'server.pem').read_text() == 'existing'
    assert (tls_dir / 'server.key').read_text() == 'existing'


def test_create_requires_admin_even_override(monkeypatch, tls_dir):
    monkeypatch.setattr(command, '_is_admin', lambda: False)
    with pytest.raises(command.CertificateError, match='관리자'):
        command.create('192.0.2.10')
    assert not list(tls_dir.iterdir())


@pytest.mark.parametrize('version', [b'OpenSSL 1.1.1', b'LibreSSL 3.0.0'])
def test_old_openssl_rejected(monkeypatch, version):
    monkeypatch.setattr(command, '_run', lambda *a, **kw: version)
    with pytest.raises(command.CertificateError, match='3.0'):
        command.trusted_openssl()


def test_only_trusted_git_openssl(monkeypatch, tmp_path):
    monkeypatch.setenv('PATH', str(tmp_path))
    monkeypatch.setattr(command.install, 'trusted_git', lambda: None)
    with pytest.raises(command.CertificateError, match='Git'):
        command.trusted_openssl()


def test_openssl_environment_and_key_stream(admin, monkeypatch):
    original = subprocess.run
    calls = []
    for name in ('OPENSSL_CONF', 'OPENSSL_MODULES', 'OPENSSL_ENGINES', 'OPENSSL_FUTURE'):
        monkeypatch.setenv(name, 'must-not-use')

    def run(argv, **kwargs):
        assert not any(k.upper().startswith('OPENSSL_') for k in kwargs['env'])
        calls.append(argv)
        if 'genpkey' in argv:
            assert '-out' not in argv
            assert kwargs['stdout'].tell() == 0
            assert os.fstat(kwargs['stdout'].fileno()).st_size == 0
        return original(argv, **kwargs)
    monkeypatch.setattr(command.subprocess, 'run', run)
    command.create('192.0.2.10')
    request = next(call for call in calls if 'req' in call)
    assert '-config' in request


@pytest.mark.parametrize('phase', ['acl', 'genpkey', 'req', 'handshake'])
def test_create_cleanup(admin, monkeypatch, tls_dir, phase, capsys):
    old = tls_dir / 'server.key'
    old.write_text('keep')
    real_run = command._run
    real_acl = command.set_acl

    def fail():
        raise command.CertificateError('test failure')

    def acl(path, **kwargs):
        if phase == 'acl' and path.name == 'next.key':
            fail()
        return real_acl(path, **kwargs)

    def run(argv, **kwargs):
        if phase in argv:
            fail()
        return real_run(argv, **kwargs)
    monkeypatch.setattr(command, 'set_acl', acl)
    monkeypatch.setattr(command, '_run', run)
    if phase == 'handshake':
        monkeypatch.setattr(command, 'self_check', lambda *a: fail())
    assert command.main(['create', '--ip', '192.0.2.10']) == 1
    assert {p.name for p in tls_dir.iterdir()} == {'server.key'}
    assert old.read_text() == 'keep'
    output = capsys.readouterr()
    assert 'PRIVATE KEY' not in output.out + output.err


def test_create_cleanup_failure_is_failure(admin, monkeypatch, tls_dir):
    monkeypatch.setattr(command, 'self_check', lambda *a: (_ for _ in ()).throw(ValueError('fail')))
    unlink = Path.unlink

    def denied(path, *args, **kwargs):
        if path.name == 'next.key':
            raise PermissionError('denied')
        return unlink(path, *args, **kwargs)
    monkeypatch.setattr(Path, 'unlink', denied)
    with pytest.raises(command.CertificateError, match='정리 실패'):
        command.create('192.0.2.10')
    assert (tls_dir / 'next.key').exists()


def test_create_d2_trust_rejects_other_and_signed_leaf(created, tls_dir, certificates):
    trusted = (tls_dir / 'next.key', created)
    context = ssl.create_default_context(cafile=str(created))
    context.verify_flags |= ssl.VERIFY_X509_STRICT | ssl.VERIFY_X509_PARTIAL_CHAIN
    other = certificates('other')
    assert ssl._ssl._test_decode_cert(str(other[1]))['subject'] == ssl._ssl._test_decode_cert(str(created))['subject']
    for pair in (other, certificates('signed', signer=trusted)):
        with tls_server(pair) as (port, _):
            with socket.create_connection(('127.0.0.1', port), timeout=3) as raw:
                with pytest.raises(ssl.SSLCertVerificationError):
                    context.wrap_socket(raw, server_hostname='127.0.0.1')


def test_create_acl_failure_stops_before_key_bytes(monkeypatch, tmp_path):
    path = tmp_path / 'empty.key'
    path.touch()
    calls = []
    monkeypatch.setattr(command, '_run', lambda argv, **kw: calls.append(argv))
    monkeypatch.setattr(command, '_acl_info', lambda p: {'protected': False, 'rules': []})
    with pytest.raises(command.CertificateError, match='권한'):
        command.set_acl(path)
    assert path.stat().st_size == 0
    assert '/inheritance:r' in calls[0]
    assert '*S-1-5-18:F' in calls[0] and '*S-1-5-32-544:F' in calls[0]


def test_real_acl_protection_and_cleanup(tmp_path, monkeypatch):
    # Exercise actual DACLs as the TEMP owner; changing owner requires elevation.
    original_info = command._acl_info
    monkeypatch.setattr(command, '_set_owner', lambda path: None)
    monkeypatch.setattr(command, '_acl_info', lambda path: dict(original_info(path), owner='S-1-5-32-544'))
    folder = tmp_path / 'acl'
    folder.mkdir()
    key, cert = folder / 'empty.key', folder / 'public.pem'
    key.touch()
    cert.touch()
    paths = (folder, key, cert)
    try:
        command.set_acl(folder, directory=True)
        inherited = command._acl_info(cert)['rules']
        assert not any(r['sid'] == 'S-1-5-32-545' for r in inherited)
        command.set_acl(key)
        command.set_acl(cert, public=True)
        assert command._acl_info(key)['protected']
        assert {r['sid'] for r in command._acl_info(key)['rules']} == {'S-1-5-18', 'S-1-5-32-544'}
        assert any(r['sid'] == 'S-1-5-32-545' and r['inheritance'] == 0 for r in command._acl_info(folder)['rules'])
    finally:
        for path in paths:
            # Empty disposable files only: restore inherited TEMP rights, not owner/SACL.
            command._run([command.install.windows_dir() / 'System32/icacls.exe', path, '/reset'])
        key.unlink()
        cert.unlink()
        folder.rmdir()
    assert not folder.exists()


def test_key_protected_at_birth(tmp_path, monkeypatch):
    key = tmp_path / 'birth.key'
    try:
        with command._create_key(key) as handle:
            assert os.fstat(handle.fileno()).st_size == 0
            info = command._acl_info(key)
            assert info['protected']
            assert {r['sid'] for r in info['rules']} == {'S-1-5-18', 'S-1-5-32-544'}
            assert all(not r['inherited'] for r in info['rules'])
            with pytest.raises(PermissionError):
                key.open('rb')
            # Real ACL tools and OpenSSL must work with the exclusive writer still open.
            original_info = command._acl_info
            monkeypatch.setattr(command, '_set_owner', lambda path: None)
            monkeypatch.setattr(command, '_acl_info', lambda path: dict(original_info(path), owner='S-1-5-32-544'))
            command.set_acl(key)
            command._run([command.trusted_openssl(), 'genpkey', '-algorithm', 'EC',
                          '-pkeyopt', 'ec_paramgen_curve:P-256'], stdout=handle)
            assert os.fstat(handle.fileno()).st_size > 0
        if not command._is_admin():
            with pytest.raises(PermissionError):
                key.open('rb')
    finally:
        if key.exists():
            command._run([command.install.windows_dir() / 'System32/icacls.exe', key, '/reset'])
            key.unlink()


def test_acl_path_is_data(monkeypatch, tmp_path):
    path = tmp_path / "smart‘quote’name"
    def run(script, **kwargs):
        assert str(path) not in script
        assert '-LiteralPath $env:MVHUB_ACL_PATH' in script
        assert kwargs['extra_env']['MVHUB_ACL_PATH'] == str(path)
        return b'{}'
    monkeypatch.setattr(command, '_powershell', run)
    command._acl_info(path)


def test_set_acl_sets_and_checks_owner(monkeypatch, tmp_path):
    calls = []
    monkeypatch.setattr(command, '_run', lambda argv, **kwargs: calls.append(argv))
    info = {'owner': 'S-1-5-21-123', 'protected': True, 'rules': [
        {'sid': sid, 'rights': 2032127, 'type': 0, 'inherited': False, 'inheritance': 0, 'propagation': 0}
        for sid in ('S-1-5-18', 'S-1-5-32-544')]}
    monkeypatch.setattr(command, '_acl_info', lambda path: info)
    with pytest.raises(command.CertificateError, match='권한'):
        command.set_acl(tmp_path / 'key')
    assert any(argv[-2:] == ['/setowner', '*S-1-5-32-544'] for argv in calls)
    info['owner'] = 'S-1-5-32-544'
    command.set_acl(tmp_path / 'key')


def test_new_folder_acl_precedes_openssl(admin, tls_dir, monkeypatch):
    def openssl():
        assert any(kwargs == {'directory': True} for _, _, kwargs in admin)
        raise command.CertificateError('version')
    monkeypatch.setattr(command, 'trusted_openssl', openssl)
    with pytest.raises(command.CertificateError, match='version'):
        command.create('192.0.2.10')


def test_plain_path_checks_lstat_without_exists(monkeypatch, tmp_path):
    from types import SimpleNamespace
    monkeypatch.setattr(command.os, 'lstat', lambda path: SimpleNamespace(st_file_attributes=0x400))
    with pytest.raises(command.CertificateError, match='연결 지점'):
        command._plain_path(tmp_path / 'dangling')


@pytest.mark.parametrize('bad', ['parent_owner', 'parent_rights', 'folder_owner', 'folder_rights', 'entry_owner', 'unexpected', 'key_acl'])
@pytest.mark.parametrize('rights', [0x40000, 0x10000000, 0x40000000])
def test_directory_security_rejects_before_mutation(tmp_path, monkeypatch, bad, rights):
    folder = tmp_path / 'tls'
    folder.mkdir()
    key = folder / ('unknown' if bad == 'unexpected' else 'next.key')
    key.touch()
    def info(path):
        owner = 'S-1-5-32-544'
        if ((bad == 'parent_owner' and path == tmp_path)
                or (bad == 'folder_owner' and path == folder)
                or (bad == 'entry_owner' and path == key)):
            owner = 'S-1-5-21-123'
        unsafe = (bad == 'parent_rights' and path == tmp_path) or (bad == 'folder_rights' and path == folder)
        rules = [{'type': 0, 'sid': 'S-1-5-32-545', 'rights': rights, 'propagation': 2}] if unsafe else []
        return {'owner': owner, 'rules': rules}
    monkeypatch.setattr(command, '_acl_info', info)
    monkeypatch.setattr(command, 'set_acl', lambda *a, **k: pytest.fail('must reject before mutation'))
    def verify(path, **kwargs):
        if path == key:
            raise command.CertificateError('key ACL')
    monkeypatch.setattr(command, 'verify_acl', verify)
    with pytest.raises(command.CertificateError):
        command._prepare_directory(folder)


def test_create_keyboard_interrupt_cleans_own_files(admin, tls_dir, monkeypatch):
    monkeypatch.setattr(command, 'self_check', lambda *a: (_ for _ in ()).throw(KeyboardInterrupt()))
    with pytest.raises(KeyboardInterrupt):
        command.create('192.0.2.10')
    assert not list(tls_dir.iterdir())


def test_promote_info_failure_is_success(monkeypatch, tmp_path, capsys):
    monkeypatch.setattr(command, 'promote', lambda: (tmp_path / 'missing.pem', False))
    assert command.main(['promote']) == 0
    captured = capsys.readouterr()
    assert 'promote 성공' in captured.out
    assert 'promote.pending' not in captured.err


def _rotation(admin, tls_dir):
    command.create('192.0.2.10')
    command.promote()
    old = command.fingerprint(tls_dir / 'server.pem')
    command.create('192.0.2.10')
    target = command.fingerprint(tls_dir / 'next.pem')
    return old, target


def _stale(tls_dir):
    marker = tls_dir / 'promote.pending'
    state = json.loads(marker.read_text())
    state['created'] = 0  # same PID but different process creation time = dead predecessor
    marker.write_text(json.dumps(state))


def test_promote_first_and_rotation(admin, tls_dir):
    old, target = _rotation(admin, tls_dir)
    path, first = command.promote()
    assert not first and command.fingerprint(path) == target
    assert server_tls.read_config().state == 'on'
    assert command.fingerprint(tls_dir / 'previous.pem') == old
    assert not (tls_dir / 'promote.pending').exists()
    assert not (tls_dir / 'next.key').exists()


def test_promote_refuses_previous(admin, tls_dir):
    (tls_dir / 'previous.key').write_text('keep')
    with pytest.raises(command.CertificateError, match='previous'):
        command.promote()
    assert (tls_dir / 'previous.key').read_text() == 'keep'


def test_promote_only_requires_new_pair_to_pass_current_profile(admin, tls_dir, certificates, monkeypatch):
    # Old deployments need rotation even if the old certificate no longer passes D2/time validation.
    old_key, old_cert = certificates('old')
    (tls_dir / 'server.pem').write_bytes(old_cert.read_bytes())
    (tls_dir / 'server.key').write_bytes(old_key.read_bytes())
    old = command.fingerprint(tls_dir / 'server.pem')
    command.create('192.0.2.10')
    target = command.fingerprint(tls_dir / 'next.pem')
    original_check = command.self_check
    def check(cert, key, exe):
        assert command.fingerprint(cert) != old, 'Do not require the retired certificate to be currently valid'
        return original_check(cert, key, exe)
    monkeypatch.setattr(command, 'self_check', check)
    path, first = command.promote()
    assert not first and command.fingerprint(path) == target


def test_promote_mismatched_next_is_untouched(admin, tls_dir, certificates):
    command.create('192.0.2.10')
    (tls_dir / 'next.key').write_bytes(certificates('other')[0].read_bytes())
    before = (tls_dir / 'next.key').read_bytes()
    with pytest.raises(ssl.SSLError):
        command.promote()
    assert not (tls_dir / 'promote.pending').exists()
    assert (tls_dir / 'next.key').read_bytes() == before


@pytest.mark.parametrize('first,step', [(first, step) for first in (True, False)
                         for step in ('link-pem', 'link-key', 'replace-pem', 'replace-key', 'final-check')
                         if not (first and step.startswith('link'))])
def test_promote_failure_rolls_back(admin, tls_dir, monkeypatch, first, step):
    if first:
        command.create('192.0.2.10')
        old = None
    else:
        old, _ = _rotation(admin, tls_dir)
    original_link, original_replace, original_check = os.link, os.replace, command.self_check
    triggered = False

    def inject(where):
        nonlocal triggered
        if where == step and not triggered:
            triggered = True
            raise OSError('injected')

    def link(src, dst):
        inject('link-' + Path(src).suffix[1:])
        return original_link(src, dst)

    def replace(src, dst):
        if Path(src).name.startswith('next.'):
            inject('replace-' + Path(src).suffix[1:])
        return original_replace(src, dst)

    def check(cert, key, exe):
        if cert.name == 'server.pem' and (tls_dir / 'promote.pending').exists() and not (tls_dir / 'next.key').exists():
            inject('final-check')
        return original_check(cert, key, exe)
    monkeypatch.setattr(command.os, 'link', link)
    monkeypatch.setattr(command.os, 'replace', replace)
    monkeypatch.setattr(command, 'self_check', check)
    with pytest.raises(OSError, match='injected'):
        command.promote()
    assert triggered
    assert not (tls_dir / 'promote.pending').exists()
    assert server_tls.read_config().state == ('off' if first else 'on')
    if old:
        assert command.fingerprint(tls_dir / 'server.pem') == old
    assert (tls_dir / 'next.pem').exists() and (tls_dir / 'next.key').exists()
    assert not (tls_dir / 'previous.pem').exists() and not (tls_dir / 'previous.key').exists()
    command.promote()  # restored state can actually be retried, not just displayed as on/off


@pytest.mark.parametrize('step', ['marker', 'link-pem', 'link-key', 'replace-pem', 'replace-key', 'final-check'])
def test_promote_crash_recovery_including_mixed_pair(admin, tls_dir, monkeypatch, step):
    old, target = _rotation(admin, tls_dir)
    original_link, original_replace = os.link, os.replace
    original_write, original_check = command._write_marker, command.self_check

    def crash(where):
        assert server_tls.read_config().state == 'error'
        if where == step:
            raise KeyboardInterrupt('forced kill')

    def link(src, dst):
        result = original_link(src, dst)
        assert os.path.samefile(src, dst)
        crash('link-' + Path(src).suffix[1:])
        return result

    def replace(src, dst):
        result = original_replace(src, dst)
        if Path(src).name.startswith('next.'):
            crash('replace-' + Path(src).suffix[1:])
        return result

    def write(handle, state):
        original_write(handle, state)
        crash('marker')

    def check(cert, key, exe):
        result = original_check(cert, key, exe)
        if cert.name == 'server.pem' and (tls_dir / 'promote.pending').exists() and not (tls_dir / 'next.key').exists():
            crash('final-check')
        return result
    with monkeypatch.context() as m:
        m.setattr(command.os, 'link', link)
        m.setattr(command.os, 'replace', replace)
        m.setattr(command, '_write_marker', write)
        m.setattr(command, 'self_check', check)
        with pytest.raises(KeyboardInterrupt):
            command.promote()
    assert server_tls.read_config().state == 'error'
    if step == 'replace-pem':
        assert command.fingerprint(tls_dir / 'server.pem') == target
        assert os.path.samefile(tls_dir / 'server.key', tls_dir / 'previous.key')
        assert (tls_dir / 'next.key').exists()
    with pytest.raises(command.CertificateError, match='다른 promote'):
        command.promote()
    _stale(tls_dir)
    command.promote()
    assert command.fingerprint(tls_dir / 'server.pem') == target
    assert command.fingerprint(tls_dir / 'previous.pem') == old
    assert server_tls.read_config().state == 'on'


def test_promote_rollback_failure_keeps_marker(admin, tls_dir, monkeypatch):
    _rotation(admin, tls_dir)
    def fail(*args):
        raise OSError('fail')
    monkeypatch.setattr(command, '_finish', fail)
    monkeypatch.setattr(command, '_rollback', fail)
    with pytest.raises(command.CertificateError, match='되돌림 실패'):
        command.promote()
    assert server_tls.read_config().state == 'error'


def test_promote_bad_marker_is_preserved(admin, tls_dir):
    marker = tls_dir / 'promote.pending'
    marker.write_text('{')
    with pytest.raises(command.CertificateError, match='손상'):
        command.promote()
    assert marker.read_text() == '{'


@pytest.mark.parametrize('step', ['marker', 'replace-pem', 'replace-key', 'remove-marker'])
def test_promote_first_cutover_crash_recovery(admin, tls_dir, monkeypatch, step):
    command.create('192.0.2.10')
    target = command.fingerprint(tls_dir / 'next.pem')
    original_write, original_replace, original_unlink = command._write_marker, os.replace, Path.unlink

    def write(handle, state):
        original_write(handle, state)
        if step == 'marker':
            raise KeyboardInterrupt()

    def replace(src, dst):
        original_replace(src, dst)
        if step == 'replace-' + Path(src).suffix[1:]:
            raise KeyboardInterrupt()

    def unlink(path, *args, **kwargs):
        if step == 'remove-marker' and path.name == 'promote.pending':
            raise KeyboardInterrupt()
        return original_unlink(path, *args, **kwargs)
    with monkeypatch.context() as m:
        m.setattr(command, '_write_marker', write)
        m.setattr(command.os, 'replace', replace)
        m.setattr(Path, 'unlink', unlink)
        with pytest.raises(KeyboardInterrupt):
            command.promote()
    assert server_tls.read_config().state == 'error'
    _stale(tls_dir)
    path, first = command.promote()
    assert first and command.fingerprint(path) == target
    assert server_tls.read_config().state == 'on'


def test_promote_incomplete_marker_write_stops_safely(admin, tls_dir, monkeypatch):
    command.create('192.0.2.10')
    def write(handle, state):
        handle.write(b'{')
        handle.flush()
        raise OSError('disk full')
    with monkeypatch.context() as m:
        m.setattr(command, '_write_marker', write)
        with pytest.raises(OSError, match='disk full'):
            command.promote()
    assert server_tls.read_config().state == 'error'
    with pytest.raises(command.CertificateError, match='손상'):
        command.promote()


def test_promote_recovery_cannot_finish_keeps_marker(admin, tls_dir, monkeypatch):
    _rotation(admin, tls_dir)
    with monkeypatch.context() as m:
        m.setattr(command, '_finish', lambda *a: (_ for _ in ()).throw(KeyboardInterrupt()))
        with pytest.raises(KeyboardInterrupt):
            command.promote()
    _stale(tls_dir)
    (tls_dir / 'next.key').unlink()
    with pytest.raises(command.CertificateError, match='복구 중단'):
        command.promote()
    assert server_tls.read_config().state == 'error'


def test_promote_live_marker_reports_running(admin, tls_dir, monkeypatch, capsys):
    command.create('192.0.2.10')
    with monkeypatch.context() as m:
        m.setattr(command, '_finish', lambda *a: (_ for _ in ()).throw(KeyboardInterrupt()))
        with pytest.raises(KeyboardInterrupt):
            command.promote()
    assert command.main(['promote']) == 1
    assert '다른 promote 실행 중' in capsys.readouterr().err


def test_promote_restart_guidance(admin, tls_dir, capsys):
    command.create('192.0.2.10')
    assert command.main(['promote']) == 0
    assert 'dead' in capsys.readouterr().out
    command.create('192.0.2.10')
    assert command.main(['promote']) == 0
    out = capsys.readouterr().out
    assert 'tls_error' in out and 'PRIVATE KEY' not in out


def test_rotation_trust_bundle_and_revocation(admin, tls_dir, monkeypatch, tmp_path):
    from app.services import shared_transport
    _rotation(admin, tls_dir)
    old_pair = (tls_dir / 'server.key', tls_dir / 'server.pem')
    new_pair = (tls_dir / 'next.key', tls_dir / 'next.pem')
    bundle = tmp_path / 'bundle.pem'
    bundle.write_bytes(old_pair[1].read_bytes() + new_pair[1].read_bytes())
    monkeypatch.setattr(shared_transport, 'BUNDLE_PATH', bundle)
    monkeypatch.setattr(shared_transport, 'TLS_REQUIRED', True)
    for pair in (old_pair, new_pair):
        with tls_server(pair) as (port, _):
            assert shared_transport.opener(proxy=False).open(f'https://127.0.0.1:{port}/api/ready', timeout=3).status == 200
    bundle.write_bytes(new_pair[1].read_bytes())
    with tls_server(old_pair) as (port, _):
        import urllib.error
        with pytest.raises(urllib.error.URLError):
            shared_transport.opener(proxy=False).open(f'https://127.0.0.1:{port}/api/ready', timeout=3)


@pytest.mark.parametrize('profile', ['ca_true', 'rsa', 'missing_san'])
def test_promote_matching_key_invalid_profile_leaves_active_pair(admin, tls_dir, tmp_path, profile):
    import hashlib

    _rotation(admin, tls_dir)
    exe = command.trusted_openssl()
    cert, key = tls_dir / 'next.pem', tls_dir / 'next.key'
    if profile == 'rsa':
        with key.open('wb') as handle:
            command._run([exe, 'genpkey', '-algorithm', 'RSA', '-pkeyopt', 'rsa_keygen_bits:2048'], stdout=handle)
    config = tmp_path / 'invalid-profile.cnf'
    config.write_text(
        '[req]\ndistinguished_name=dn\n[dn]\n[v3]\n'
        + 'basicConstraints=critical,CA:' + ('TRUE' if profile == 'ca_true' else 'FALSE') + '\n'
        + 'keyUsage=critical,digitalSignature\nextendedKeyUsage=serverAuth\n'
        + 'subjectKeyIdentifier=hash\nauthorityKeyIdentifier=keyid:always\n'
        + ('' if profile == 'missing_san' else 'subjectAltName=IP:192.0.2.10,IP:127.0.0.1,DNS:localhost\n'),
        encoding='ascii',
    )
    command._run([exe, 'req', '-new', '-x509', '-key', key, '-out', cert, '-days', '30',
                  '-subj', '/CN=mvhub-shared-server', '-extensions', 'v3', '-config', config])
    # A real matching key isolates profile rejection from the mismatched-key test.
    ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER).load_cert_chain(str(cert), str(key))
    before = {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in tls_dir.iterdir()}
    with pytest.raises(command.CertificateError):
        command.promote()
    assert {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in tls_dir.iterdir()} == before
    assert server_tls.read_config().state == 'on'

"""Run only the ZIP validation function, never the release script body."""
from __future__ import annotations

import base64
import os
from pathlib import Path
import subprocess
import time

import pytest

from test_release_frontend_build import _archive_probe

pytestmark = pytest.mark.skipif(os.name != 'nt', reason='Windows PowerShell 5.1 validator')
TRANSPORT = 'backend/app/services/shared_transport.py'
BUNDLE = 'backend/app/resources/tls/shared_server.pem'
OPENSSL = Path(r'C:\Program Files\Git\usr\bin\openssl.exe')


def probe(tmp_path, contents=None, **kwargs):
    return _archive_probe(tmp_path, ['index-test.js'], contents=contents, **kwargs)


@pytest.mark.parametrize('source,valid', [
    ('TLS_REQUIRED = False\n', True),
    ('TLS_REQUIRED = False # staged\n', True),
    ('TLS_REQUIRED = False\r\nif TLS_REQUIRED == True: pass\r\n', True),
    ('TLS_REQUIRED = True\n', False),
    ('TLS_REQUIRED = False or True\n', False),
    ('TLS_REQUIRED = False; TLS_REQUIRED = True\n', False),
    ('TLS_REQUIRED = False\nTLS_REQUIRED=True\n', False),
    ('TLS_REQUIRED = False\nTLS_REQUIRED |= True\n', False),
    ('TLS_REQUIRED = False\nTLS_REQUIRED: bool = True\n', False),
    ('TLS_REQUIRED = False\nif True: TLS_REQUIRED = True\n', False),
    ('TLS_REQUIRED = False\nlabel = "#"; TLS_REQUIRED = True\n', False),
    ('# TLS_REQUIRED = False\n', False),
])
def test_declaration(tmp_path, source, valid):
    result = probe(tmp_path, {TRANSPORT: source})
    assert (result.returncode == 0) == valid, result.stderr


@pytest.mark.parametrize('binding', [
    'TLS_REQUIRED, other = True, 1',
    'other, TLS_REQUIRED = 1, True',
    '(TLS_REQUIRED, other) = (True, 1)',
    '(other, TLS_REQUIRED) = (1, True)',
    '(other,\n TLS_REQUIRED) = (1, True)',
    '[TLS_REQUIRED, other] = (True, 1)',
    '[other,\n TLS_REQUIRED] = (1, True)',
    'for TLS_REQUIRED in values: pass',
    'for other, TLS_REQUIRED in values: pass',
    'with context() as TLS_REQUIRED: pass',
    'try: pass\nexcept Exception as TLS_REQUIRED: pass',
    'del TLS_REQUIRED',
    'del other, TLS_REQUIRED',
    'if (TLS_REQUIRED := True): pass',
    'del d[k], TLS_REQUIRED',
    'x[0], TLS_REQUIRED = 1, True',
    'for d[k], TLS_REQUIRED in v: pass',
    'f(a), TLS_REQUIRED = 1, True',
    'for(TLS_REQUIRED, x) in v: pass',
    'del(TLS_REQUIRED)',
    'f(TLS_REQUIRED := True)',
    'd[(TLS_REQUIRED := True)]',
    'f(TLS_REQUIRED\n:= True)',
    'f(TLS_REQUIRED',
    'from m import TLS_REQUIRED',
    'from m import (x,\n TLS_REQUIRED)',
    'import x as TLS_REQUIRED',
    'def TLS_REQUIRED(): pass',
    'class TLS_REQUIRED: pass',
    'with c as (TLS_REQUIRED): pass',
    'print (TLS_REQUIRED, x=1)',  # Documented conservative limit for spaced calls.
])
def test_additional_bindings_rejected(tmp_path, binding):
    result = probe(tmp_path, {TRANSPORT: 'TLS_REQUIRED = False\n' + binding + '\n'})
    assert result.returncode != 0 and 'Invalid TLS_REQUIRED' in result.stderr


@pytest.mark.parametrize('newline', ['\n', '\r\n'])
@pytest.mark.parametrize('binding', [
    'import ssl\n(TLS_REQUIRED, other) = True, 1',
    'x = f()\n(TLS_REQUIRED, y) = 1, 2',
])
def test_column_zero_binding_rejected(tmp_path, newline, binding):
    source = ('TLS_REQUIRED = False\n' + binding + '\n').replace('\n', newline)
    result = probe(tmp_path, {TRANSPORT: source})
    assert result.returncode != 0 and 'Invalid TLS_REQUIRED' in result.stderr


def test_comparisons_still_allowed(tmp_path):
    result = probe(tmp_path, {TRANSPORT: 'TLS_REQUIRED = False\nif TLS_REQUIRED == True: pass\nif TLS_REQUIRED != False: pass\n'})
    assert result.returncode == 0, result.stderr


@pytest.mark.parametrize('reference', [
    'build(TLS_REQUIRED, proxy=proxy)',
    'print(TLS_REQUIRED, file=output)',
    'build(TLS_REQUIRED=True)',
    'build(\n TLS_REQUIRED,\n proxy=proxy\n)\ncache[key] = value',
    'print(TLS_REQUIRED, file=output)\ncache[key] = value',
    'del d[TLS_REQUIRED]',
    'del d[\n TLS_REQUIRED\n]',
    'del d[TLS_REQUIRED], other',
    'factory()(TLS_REQUIRED, flag=True)',
    'handlers[key](TLS_REQUIRED, flag=True)',
    'label = "bracket ( and TLS_REQUIRED := True"',
    'x = delay * 2 if TLS_REQUIRED else delay',
    'delete_backup(p) if TLS_REQUIRED else None',
])
def test_call_and_subscript_references_allowed(tmp_path, reference):
    result = probe(tmp_path, {TRANSPORT: 'TLS_REQUIRED = False\n' + reference + '\n'})
    assert result.returncode == 0, result.stderr


@pytest.mark.parametrize('enabled', ['False', 'True'])
@pytest.mark.parametrize('source', [
    'from ssl import SSLContext, create_default_context\n\nTLS_REQUIRED = {enabled}\n',
    '# 공유 서버 전환: 공개 인증서, 서버 TLS 함께\nTLS_REQUIRED = {enabled}\n',
    'TLS_REQUIRED = {enabled}\ndel x\nif TLS_REQUIRED: pass\n',
    'TLS_REQUIRED = {enabled}\n# another comment: TLS_REQUIRED = True\n',
    'TLS_REQUIRED = {enabled}\nlabel = "#" # TLS_REQUIRED = True\n',
])
def test_unrelated_lines_and_comments_allowed(tmp_path, certificates, source, enabled):
    result = probe(tmp_path, {TRANSPORT: source.format(enabled=enabled), BUNDLE: certificates['valid']})
    assert result.returncode == 0, result.stderr


def test_rsa_key_in_top_level_file_rejected_before_allowlist(tmp_path):
    result = probe(tmp_path, {'notes.txt': '-----BEGIN RSA PRIVATE KEY-----\nfixture\n-----END RSA PRIVATE KEY-----'})
    assert result.returncode != 0
    assert 'contains a private key: notes.txt' in result.stderr
    assert 'outside the allowlist' not in result.stderr


@pytest.mark.parametrize('path,data,valid', [
    ('backend/app/a.py', 'PRIVATE KEY is explanatory prose', True),
    ('backend/app/a.bin', b'\xff-----BEGIN PRIVATE KEY-----', False),
    ('frontend/dist/assets/a.svg', '-----BEGIN EC PRIVATE KEY-----', False),
    ('backend/app/a.py', '-----BEGIN ENCRYPTED PRIVATE KEY-----', False),
    ('runtime/a.bin', '-----BEGIN PRIVATE KEY-----', True),
    ('tools/mcp_adapter/site-packages/a.py', '-----BEGIN PRIVATE KEY-----', True),
    ('backend/app/resources/tls/other.pem', 'unused', False),
    (BUNDLE, 'not PEM', False),
    (BUNDLE, '-----BEGIN PUBLIC KEY-----\nAA==\n-----END PUBLIC KEY-----', False),
])
def test_contents(tmp_path, path, data, valid):
    result = probe(tmp_path, {path: data})
    assert (result.returncode == 0) == valid, result.stderr


def test_directories_duplicates_and_missing(tmp_path):
    assert probe(tmp_path, extra=('backend/', 'tools/', 'backend/app/resources/tls/')).returncode == 0
    duplicate = probe(tmp_path, extra=('backend/app/main.py',))
    assert duplicate.returncode != 0 and 'duplicate path' in duplicate.stderr
    missing = probe(tmp_path, missing=TRANSPORT)
    assert missing.returncode != 0


def openssl(folder, *args):
    assert OPENSSL.is_file(), 'Required trusted Git OpenSSL missing; this is not a skip'
    env = {k: v for k, v in os.environ.items() if not k.upper().startswith('OPENSSL_')}
    result = subprocess.run([str(OPENSSL), *map(str, args)], cwd=folder, env=env, capture_output=True, timeout=20)
    assert result.returncode == 0, 'Fixture OpenSSL failed (output withheld to avoid key logging)'
    return result.stdout


@pytest.fixture(scope='module')
def certificates(tmp_path_factory):
    folder = tmp_path_factory.mktemp('release-certs')
    key = folder / 'key.pem'
    openssl(folder, 'genpkey', '-algorithm', 'EC', '-pkeyopt', 'ec_paramgen_curve:P-256', '-out', key)
    certs = {}
    for name, ext, start, end in [
        ('valid', 'basicConstraints=critical,CA:FALSE\nextendedKeyUsage=serverAuth', '20200101000000Z', '20400101000000Z'),
        ('ca', 'basicConstraints=critical,CA:TRUE\nextendedKeyUsage=serverAuth', '20200101000000Z', '20400101000000Z'),
        ('no_bc', 'extendedKeyUsage=serverAuth', '20200101000000Z', '20400101000000Z'),
        ('no_eku', 'basicConstraints=CA:FALSE', '20200101000000Z', '20400101000000Z'),
        ('client', 'basicConstraints=CA:FALSE\nextendedKeyUsage=clientAuth', '20200101000000Z', '20400101000000Z'),
        ('expired', 'basicConstraints=CA:FALSE\nextendedKeyUsage=serverAuth', '20200101000000Z', '20210101000000Z'),
        ('future', 'basicConstraints=CA:FALSE\nextendedKeyUsage=serverAuth', '20400101000000Z', '20410101000000Z'),
    ]:
        (folder / 'index').write_text('')
        (folder / 'serial').write_text('01\n')
        config = folder / 'openssl.cnf'
        config.write_text('[req]\ndistinguished_name=dn\nprompt=no\n[dn]\nCN=test\n[ca]\ndefault_ca=local\n[local]\ndatabase=index\nserial=serial\nnew_certs_dir=.\ndefault_md=sha256\npolicy=policy\nx509_extensions=ext\n[policy]\ncommonName=supplied\n[ext]\n' + ext + '\n')
        openssl(folder, 'req', '-new', '-key', key, '-config', config, '-out', 'req.pem')
        openssl(folder, 'ca', '-batch', '-selfsign', '-keyfile', key, '-in', 'req.pem', '-out', f'{name}.pem', '-config', config, '-startdate', start, '-enddate', end, '-notext')
        certs[name] = (folder / f'{name}.pem').read_bytes()
    for kind, args in [('pfx', ('pkcs12', '-export', '-inkey', key, '-in', 'valid.pem', '-passout', 'pass:', '-out', 'pfx.der')), ('pkcs7', ('crl2pkcs7', '-nocrl', '-certfile', 'valid.pem', '-outform', 'DER', '-out', 'pkcs7.der'))]:
        openssl(folder, *args)
        certs[kind] = b'-----BEGIN CERTIFICATE-----\n' + base64.b64encode((folder / f'{kind}.der').read_bytes()) + b'\n-----END CERTIFICATE-----\n'
    return certs


@pytest.mark.parametrize('profile', ['valid', 'ca', 'no_bc', 'no_eku', 'client', 'expired', 'future', 'pfx', 'pkcs7'])
def test_certificate_profiles(tmp_path, certificates, profile):
    result = probe(tmp_path, {BUNDLE: certificates[profile], TRANSPORT: 'TLS_REQUIRED = True\n'})
    assert (result.returncode == 0) == (profile == 'valid'), result.stderr


def test_bundle_multiple_and_trailing_data(tmp_path, certificates):
    assert probe(tmp_path, {BUNDLE: certificates['valid'] * 2}).returncode == 0
    assert probe(tmp_path, {BUNDLE: certificates['valid'] + certificates['ca']}).returncode != 0
    assert probe(tmp_path, {BUNDLE: certificates['valid'] + b'extra'}).returncode != 0
    der = base64.b64decode(b''.join(certificates['valid'].splitlines()[1:-1]))
    wrapped = b'-----BEGIN CERTIFICATE-----\n' + base64.b64encode(der + b'extra') + b'\n-----END CERTIFICATE-----\n'
    assert probe(tmp_path, {BUNDLE: wrapped}).returncode != 0


def test_current_payload_scan_timing(tmp_path):
    root = Path(__file__).resolve().parents[2]
    contents = {}
    for directory in ('backend/app', 'frontend/dist'):
        for path in (root / directory).rglob('*'):
            if path.is_file() and '__pycache__' not in path.parts and path.suffix not in ('.pyc', '.map', '.tsbuildinfo'):
                contents[path.relative_to(root).as_posix()] = path.read_bytes()
    start = time.perf_counter()
    result = probe(tmp_path, contents)
    elapsed = time.perf_counter() - start
    print(f'RELEASE_SCAN files={len(contents)} bytes={sum(map(len, contents.values()))} elapsed_seconds={elapsed:.3f} (ZIP creation + PowerShell startup + full validator)')
    print(result.stdout.strip())
    assert result.returncode == 0, result.stderr

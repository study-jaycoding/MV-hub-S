from __future__ import annotations

import hashlib
import io
import json
import threading
from concurrent.futures import ThreadPoolExecutor

import pytest
from fastapi import FastAPI, HTTPException, Request
from fastapi.testclient import TestClient

from app import db
from app.repo import asset_sync as ledger
from app.routers import asset_sync as api
from app.services import asset_sync_cache as cache


PNG = b'\x89PNG\r\n\x1a\ncache test bytes'
DIGEST = hashlib.sha256(PNG).hexdigest()
LOCATION = 'a' * 32
ORIGIN = 'http://cache-test.invalid'


def metadata():
    return dict(asset_content_id='sha256:' + DIGEST, sha256=DIGEST, bytes=len(PNG),
        location_id=LOCATION, owner_uid='source_owner', project_id='project', storage_id='storage',
        root_revision='root', state='ready', file_path='asset-sync:' + LOCATION,
        url='/api/asset-sync/files/' + LOCATION, name=DIGEST + '.png')


def get_cached(info=None, **changes):
    arguments = dict(account_key='account_a', owner_uid='user_a', server_origin=ORIGIN,
        download=lambda url, path, **kwargs: path.write_bytes(PNG), check_context=lambda: None)
    arguments.update(changes)
    return cache.cached_file(metadata() if info is None else info, **arguments)


@pytest.fixture
def isolated_cache(tmp_path, monkeypatch):
    monkeypatch.setattr(cache.config, 'DATA_DIR', tmp_path)
    return tmp_path


def test_repeated_reads_and_concurrent_first_reads_download_once(isolated_cache):
    started = threading.Event()
    release = threading.Event()
    count = []
    def download(url, path, **kwargs):
        count.append(url)
        assert kwargs['max_bytes'] == len(PNG)
        started.set()
        assert release.wait(5)
        path.write_bytes(PNG)
    with ThreadPoolExecutor(max_workers=4) as pool:
        first = pool.submit(get_cached, download=download)
        assert started.wait(5)
        waiting = [pool.submit(get_cached, download=download) for _ in range(3)]
        release.set()
        paths = [future.result() for future in [first, *waiting]]
    assert len(set(paths)) == 1
    assert count == ['/api/asset-sync/files/' + LOCATION]
    assert get_cached(download=lambda *args, **kwargs: pytest.fail('cache miss')) == paths[0]
    assert paths[0].name == DIGEST + '.png' and paths[0].read_bytes() == PNG
    assert not list(isolated_cache.rglob('*.part'))


def test_cache_is_separated_by_account_owner_and_server(isolated_cache):
    first = get_cached()
    paths = [first, get_cached(account_key='account_b'), get_cached(owner_uid='user_b'),
        get_cached(server_origin='http://other-server.invalid')]
    assert len(set(paths)) == 4
    assert len(list(isolated_cache.rglob('*.png'))) == 4


def test_local_cache_reuses_hash_and_rechecks_changed_file(isolated_cache, monkeypatch):
    import os

    original = cache.asset_io.sha256_file
    hashes = []
    def tracked(path):
        hashes.append(path)
        return original(path)
    monkeypatch.setattr(cache.asset_io, 'sha256_file', tracked)
    path = get_cached()
    assert get_cached() == path
    assert len(hashes) == 1
    previous = path.stat()
    path.write_bytes(b'x' * len(PNG))
    os.utime(path, ns=(previous.st_atime_ns, previous.st_mtime_ns + 1_000_000))
    assert get_cached().read_bytes() == PNG
    assert len(hashes) == 3  # Changed cache and replacement download are both verified.


def test_file_changed_during_hash_is_not_cached(isolated_cache, monkeypatch):
    import os

    path = isolated_cache / 'changing.png'
    path.write_bytes(PNG)
    original = cache.asset_io.sha256_file
    def change_while_hashing(file):
        digest = original(file)
        before = file.stat()
        file.write_bytes(b'x' * len(PNG))
        os.utime(file, ns=(before.st_atime_ns, before.st_mtime_ns + 1_000_000))
        return digest
    monkeypatch.setattr(cache.asset_io, 'sha256_file', change_while_hashing)
    assert cache.file_digest(path) is None
    monkeypatch.setattr(cache.asset_io, 'sha256_file', original)
    assert cache.file_digest(path) != DIGEST


def test_corrupted_cache_is_not_returned_and_download_failure_is_cleaned(isolated_cache):
    path = get_cached()
    path.write_bytes(b'x' * len(PNG))
    assert get_cached() == path and path.read_bytes() == PNG
    def broken(url, temporary, **kwargs):
        temporary.write_bytes(b'partial')
        raise HTTPException(status_code=502, detail='test_failure')
    path.unlink()
    with pytest.raises(HTTPException) as raised:
        get_cached(download=broken)
    assert raised.value.status_code == 502
    assert not path.exists() and not list(isolated_cache.rglob('*.part'))
    assert get_cached().read_bytes() == PNG


def test_wrong_download_never_becomes_cached_file(isolated_cache):
    with pytest.raises(HTTPException) as raised:
        get_cached(download=lambda url, path, **kwargs: path.write_bytes(b'x' * len(PNG)))
    assert raised.value.detail == 'asset_download_mismatch'
    assert not list(isolated_cache.rglob('*.png'))
    assert not list(isolated_cache.rglob('*.part'))


@pytest.mark.parametrize('field,value', [
    ('asset_content_id', 'sha256:' + '0' * 64), ('sha256', 'bad'), ('bytes', True), ('bytes', 0),
    ('location_id', '../secret'), ('file_path', 'https://untrusted.invalid/image.png'),
    ('url', 'https://untrusted.invalid/image.png'), ('owner_uid', ''), ('project_id', ''),
    ('state', 'pending'), ('name', '../private.png'), ('name', 'private\\file.png'), ('name', 'file.html'),
])
def test_invalid_metadata_is_rejected_before_download(isolated_cache, field, value):
    info = metadata()
    info[field] = value
    with pytest.raises(HTTPException):
        get_cached(info, download=lambda *args, **kwargs: pytest.fail('invalid metadata downloaded'))
    assert not list(isolated_cache.rglob('*.png'))


def test_context_change_during_download_does_not_promote_or_return(isolated_cache):
    changed = []
    def check():
        if changed:
            raise HTTPException(status_code=409, detail='asset_connection_changed')
    def download(url, path, **kwargs):
        path.write_bytes(PNG)
        changed.append(True)
    with pytest.raises(HTTPException) as raised:
        get_cached(download=download, check_context=check)
    assert raised.value.status_code == 409
    assert not list(isolated_cache.rglob('*.png'))
    assert not list(isolated_cache.rglob('*.part'))
    get_cached()
    with pytest.raises(HTTPException):
        get_cached(check_context=check, download=lambda *args, **kwargs: pytest.fail('cached context bypass'))


@pytest.fixture
def proxy_app(isolated_cache, monkeypatch):
    database = db.init_db(isolated_cache / 'content.db')
    monkeypatch.setenv('CONTENT_HUB_DB', str(database))
    monkeypatch.setattr(api._proxy, 'proxying', lambda: True)
    monkeypatch.setattr(api._proxy, 'base_url', lambda: ORIGIN)
    monkeypatch.setattr(api._proxy, 'token', lambda: 'test-only')
    monkeypatch.setattr(api.shared_connection, 'base_url', lambda: ORIGIN)
    monkeypatch.setattr(api.shared_connection, 'token', lambda: 'test-only')
    monkeypatch.setattr(api.active_account, 'account_key', lambda: '')
    monkeypatch.setattr(api.active_account, 'active_uid', lambda: 'user_a')
    metadata_calls, downloads = [], []
    def remote_info(method, url):
        assert method == 'GET' and url == '/api/asset-sync/locations/' + LOCATION
        metadata_calls.append(url)
        return metadata()
    class Body(io.BytesIO):
        headers = {'Content-Length': str(len(PNG))}
    def remote_open(request, *, timeout):
        assert request.full_url == ORIGIN + '/api/asset-sync/files/' + LOCATION
        downloads.append(request.full_url)
        return Body(PNG)
    monkeypatch.setattr(api._proxy, 'proxy_json', remote_info)
    monkeypatch.setattr(api._proxy, '_open', remote_open)
    app = FastAPI()
    app.include_router(api.router)
    return app, metadata_calls, downloads


def test_proxy_checks_acl_on_every_read_but_keeps_downloaded_bytes(proxy_app, monkeypatch):
    app, metadata_calls, downloads = proxy_app
    with TestClient(app, base_url='http://127.0.0.1', client=('127.0.0.1', 5000)) as client:
        for _ in range(2):
            response = client.get('/api/asset-sync/files/' + LOCATION)
            assert response.status_code == 200 and response.content == PNG
        def forbidden(*args, **kwargs):
            raise HTTPException(status_code=403, detail='project_access_revoked')
        monkeypatch.setattr(api._proxy, 'proxy_json', forbidden)
        assert client.get('/api/asset-sync/files/' + LOCATION).status_code == 403
    assert len(metadata_calls) == 2 and len(downloads) == 1
    assert len(list(cache.config.DATA_DIR.rglob('*.png'))) == 1


def test_registration_reuses_persistent_cache_without_cleanup(proxy_app):
    app, metadata_calls, downloads = proxy_app
    request = Request({'type': 'http', 'method': 'POST', 'path': '/', 'headers': [], 'client': ('127.0.0.1', 5000)})
    with TestClient(app, base_url='http://127.0.0.1', client=('127.0.0.1', 5000)) as client:
        assert client.get('/api/asset-sync/files/' + LOCATION).content == PNG
    with db.pinned_share_operation(api.capture_local_operation(request)):
        with api._proxy.pinned_connection((ORIGIN, 'test-only')):
            path, cleanup = api._registration_source('asset-sync:' + LOCATION, request)
    assert path.read_bytes() == PNG and not cleanup
    assert len(metadata_calls) == 2 and len(downloads) == 1


def test_original_owner_copy_stays_offline_fast_path(proxy_app, monkeypatch):
    app, metadata_calls, downloads = proxy_app
    local = cache.config.DATA_DIR / 'original.png'
    local.write_bytes(PNG)
    with db.get_connection() as connection:
        result = ledger.register_local(connection, path=local, file_path='/media/original.png', digest=DIGEST,
            size=len(PNG), media_type='image', owner_uid='user_a', project_id='project', server_origin=ORIGIN)
        connection.execute('UPDATE asset_sync_outbox SET receipt_json=? WHERE asset_content_id=?',
            (json.dumps(metadata()), result['asset_content_id']))
    monkeypatch.setattr(api._proxy, 'proxy_json', lambda *args, **kwargs: pytest.fail('owner cache needs network'))
    with TestClient(app, base_url='http://127.0.0.1', client=('127.0.0.1', 5000)) as client:
        response = client.get('/api/asset-sync/files/' + LOCATION)
        assert response.status_code == 200 and response.content == PNG
    assert not metadata_calls and not downloads


def test_proxy_connection_change_rejects_cached_bytes(proxy_app, monkeypatch):
    app, metadata_calls, downloads = proxy_app
    with TestClient(app, base_url='http://127.0.0.1', client=('127.0.0.1', 5000)) as client:
        assert client.get('/api/asset-sync/files/' + LOCATION).status_code == 200
        monkeypatch.setattr(api.shared_connection, 'token', lambda: 'different-test-token')
        response = client.get('/api/asset-sync/files/' + LOCATION)
        assert response.status_code == 409
    assert len(metadata_calls) == 1 and len(downloads) == 1


def test_proxy_account_change_after_metadata_never_downloads_or_returns(proxy_app, monkeypatch):
    app, metadata_calls, downloads = proxy_app
    original_info = api._proxy.proxy_json
    def changed(*args, **kwargs):
        info = original_info(*args, **kwargs)
        monkeypatch.setattr(api.active_account, 'active_uid', lambda: 'user_b')
        return info
    monkeypatch.setattr(api._proxy, 'proxy_json', changed)
    with TestClient(app, base_url='http://127.0.0.1', client=('127.0.0.1', 5000)) as client:
        response = client.get('/api/asset-sync/files/' + LOCATION)
        assert response.status_code == 409
    assert len(metadata_calls) == 1 and not downloads
    assert not list(cache.config.DATA_DIR.rglob('*.png'))


def test_proxy_connection_change_during_stream_cleans_partial(proxy_app, monkeypatch):
    app, metadata_calls, downloads = proxy_app
    original_open = api._proxy._open
    def changed(*args, **kwargs):
        body = original_open(*args, **kwargs)
        monkeypatch.setattr(api.shared_connection, 'base_url', lambda: 'http://changed.invalid')
        return body
    monkeypatch.setattr(api._proxy, '_open', changed)
    with TestClient(app, base_url='http://127.0.0.1', client=('127.0.0.1', 5000)) as client:
        response = client.get('/api/asset-sync/files/' + LOCATION)
        assert response.status_code == 409
    assert len(metadata_calls) == 1 and len(downloads) == 1
    assert not list(cache.config.DATA_DIR.rglob('*.png'))
    assert not list(cache.config.DATA_DIR.rglob('*.part'))

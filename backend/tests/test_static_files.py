from __future__ import annotations

import gzip

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.static_files import ImmutableStaticFiles


@pytest.fixture
def static_client(tmp_path):
    app = FastAPI()
    app.mount("/assets", ImmutableStaticFiles(directory=str(tmp_path)))
    with TestClient(app) as client:
        # httpx normally adds Accept-Encoding itself; test absent headers explicitly.
        client.headers.pop("accept-encoding", None)
        yield client


@pytest.fixture
def compressed_asset(tmp_path):
    content = b"console.log('static gzip');\n" * 100
    asset = tmp_path / "index-abc123.js"
    asset.write_bytes(content)
    compressed = gzip.compress(content, mtime=0)
    (tmp_path / (asset.name + ".gz")).write_bytes(compressed)
    return content, compressed


def test_hashed_frontend_asset_uses_immutable_cache(tmp_path) -> None:
    asset = tmp_path / "index-abc123.js"
    asset.write_text("console.log('ok')", encoding="utf-8")
    app = FastAPI()
    app.mount("/assets", ImmutableStaticFiles(directory=str(tmp_path)))

    response = TestClient(app).get("/assets/index-abc123.js")

    assert response.status_code == 200
    assert response.headers["cache-control"] == "public, max-age=31536000, immutable"


def test_missing_frontend_asset_is_not_cached(tmp_path) -> None:
    app = FastAPI()
    app.mount("/assets", ImmutableStaticFiles(directory=str(tmp_path)))

    response = TestClient(app).get("/assets/missing.js")

    assert response.status_code == 404
    assert "cache-control" not in response.headers


@pytest.mark.parametrize("extension", ["js", "css"])
def test_precompressed_asset_serves_exact_gzip_bytes(static_client, tmp_path, extension) -> None:
    content = b"/* original asset */\n" * 100
    compressed = gzip.compress(content, mtime=0)
    path = tmp_path / ("asset." + extension)
    path.write_bytes(content)
    (tmp_path / (path.name + ".gz")).write_bytes(compressed)
    identity = static_client.get("/assets/" + path.name)

    with static_client.stream("GET", "/assets/" + path.name, headers={"Accept-Encoding": "gzip"}) as response:
        wire_bytes = b"".join(response.iter_raw())

    assert response.status_code == 200
    assert wire_bytes == compressed
    assert gzip.decompress(wire_bytes) == content
    assert response.headers["content-type"] == identity.headers["content-type"]
    assert response.headers["content-length"] == str(len(compressed))
    assert response.headers["content-encoding"] == "gzip"
    assert response.headers["vary"] == "Accept-Encoding"
    assert response.headers["cache-control"] == "public, max-age=31536000, immutable"


def test_head_uses_selected_representation_headers(static_client, compressed_asset) -> None:
    content, compressed = compressed_asset
    for encoding, length in [(None, len(content)), ("gzip", len(compressed))]:
        headers = {"Accept-Encoding": encoding} if encoding else {}
        head = static_client.head("/assets/index-abc123.js", headers=headers)
        get = static_client.get("/assets/index-abc123.js", headers=headers)
        assert head.status_code == 200
        assert head.content == b""
        assert head.headers["content-length"] == str(length)
        assert head.headers == get.headers


@pytest.mark.parametrize("encoding", [None, "identity", "gzip;q=0", "*;q=0", "gzip;q=0, *;q=1"])
def test_identity_negotiation(static_client, compressed_asset, encoding) -> None:
    content, _ = compressed_asset
    headers = {"Accept-Encoding": encoding} if encoding else {}
    response = static_client.get("/assets/index-abc123.js", headers=headers)
    assert response.status_code == 200
    assert response.content == content
    assert "content-encoding" not in response.headers
    assert response.headers["vary"] == "Accept-Encoding"


@pytest.mark.parametrize("encoding", ["gzip", "*", "br, gzip;q=0.5", "gzip;q=1, *;q=0"])
def test_gzip_negotiation(static_client, compressed_asset, encoding) -> None:
    content, compressed = compressed_asset
    response = static_client.get("/assets/index-abc123.js", headers={"Accept-Encoding": encoding})
    assert response.status_code == 200
    assert response.content == content
    assert response.headers["content-encoding"] == "gzip"
    assert response.headers["content-length"] == str(len(compressed))


def test_etag_is_specific_to_selected_representation(static_client, compressed_asset) -> None:
    path = "/assets/index-abc123.js"
    identity = static_client.get(path)
    compressed = static_client.get(path, headers={"Accept-Encoding": "gzip"})
    assert identity.headers["etag"] != compressed.headers["etag"]
    for source, encoding in [(identity, "identity"), (compressed, "gzip")]:
        response = static_client.get(path, headers={"Accept-Encoding": encoding, "If-None-Match": source.headers["etag"]})
        assert response.status_code == 304
        assert response.content == b""
        assert response.headers["vary"] == "Accept-Encoding"
        assert response.headers["etag"] == source.headers["etag"]
        assert response.headers["cache-control"] == "public, max-age=31536000, immutable"
        assert response.headers.get("content-encoding") == ("gzip" if encoding == "gzip" else None)
        cross = static_client.get(path, headers={"Accept-Encoding": "gzip" if encoding == "identity" else "identity", "If-None-Match": source.headers["etag"]})
        assert cross.status_code == 200


def test_range_and_if_range_use_original_file(static_client, compressed_asset) -> None:
    content, _ = compressed_asset
    path = "/assets/index-abc123.js"
    identity = static_client.get(path)
    for if_range, expected_status, expected_content in [
        (None, 206, content[:10]),
        (identity.headers["etag"], 206, content[:10]),
        ('"different-etag"', 200, content),
    ]:
        headers = {"Accept-Encoding": "gzip", "Range": "bytes=0-9"}
        if if_range:
            headers["If-Range"] = if_range
        response = static_client.get(path, headers=headers)
        assert response.status_code == expected_status
        assert response.content == expected_content
        assert "content-encoding" not in response.headers
        assert response.headers["vary"] == "Accept-Encoding"
        if expected_status == 206:
            assert response.headers["content-range"] == f"bytes 0-9/{len(content)}"


def test_missing_original_and_directory_cannot_serve_gzip(static_client, tmp_path) -> None:
    (tmp_path / "orphan.js.gz").write_bytes(gzip.compress(b"orphan"))
    (tmp_path / "directory.js").mkdir()
    (tmp_path / "directory.js.gz").write_bytes(gzip.compress(b"directory"))
    for path in ["missing.js", "orphan.js", "directory.js", "..%2Foutside.js"]:
        response = static_client.get("/assets/" + path, headers={"Accept-Encoding": "gzip"})
        assert response.status_code == 404
        assert "cache-control" not in response.headers


def test_missing_or_nonregular_gzip_falls_back_to_original(static_client, tmp_path) -> None:
    for name in ["legacy.js", "directory.css"]:
        (tmp_path / name).write_bytes(b"original")
    (tmp_path / "directory.css.gz").mkdir()
    for name in ["legacy.js", "directory.css"]:
        response = static_client.get("/assets/" + name, headers={"Accept-Encoding": "gzip"})
        assert response.status_code == 200
        assert response.content == b"original"
        assert "content-encoding" not in response.headers
        assert response.headers["vary"] == "Accept-Encoding"


def test_image_and_direct_gzip_urls_keep_existing_policy(static_client, tmp_path) -> None:
    image = b"uncompressed image"
    compressed = gzip.compress(image)
    (tmp_path / "image.png").write_bytes(image)
    (tmp_path / "image.png.gz").write_bytes(compressed)
    response = static_client.get("/assets/image.png", headers={"Accept-Encoding": "gzip"})
    assert response.content == image
    assert "content-encoding" not in response.headers
    assert "vary" not in response.headers
    direct = static_client.get("/assets/image.png.gz", headers={"Accept-Encoding": "gzip"})
    assert direct.status_code == 200
    assert direct.content == compressed
    assert "content-encoding" not in direct.headers


def test_unsupported_method_keeps_405(static_client, compressed_asset) -> None:
    response = static_client.post("/assets/index-abc123.js", headers={"Accept-Encoding": "gzip"})
    assert response.status_code == 405


def test_existing_files_outside_asset_directory_are_not_served(tmp_path) -> None:
    assets = tmp_path / "assets"
    assets.mkdir()
    (tmp_path / "outside.js").write_bytes(b"outside")
    (tmp_path / "outside.js.gz").write_bytes(gzip.compress(b"outside"))
    app = FastAPI()
    app.mount("/assets", ImmutableStaticFiles(directory=str(assets)))
    response = TestClient(app).get("/assets/..%2Foutside.js", headers={"Accept-Encoding": "gzip"})
    assert response.status_code == 404


def test_unreadable_gzip_falls_back_to_original(tmp_path, monkeypatch) -> None:
    (tmp_path / "asset.js").write_bytes(b"original")
    static_files = ImmutableStaticFiles(directory=str(tmp_path))
    lookup_path = static_files.lookup_path

    def lookup_with_denied_gzip(path):
        if path.endswith(".gz"):
            raise PermissionError("unreadable gzip")
        return lookup_path(path)

    monkeypatch.setattr(static_files, "lookup_path", lookup_with_denied_gzip)
    app = FastAPI()
    app.mount("/assets", static_files)
    response = TestClient(app).get("/assets/asset.js", headers={"Accept-Encoding": "gzip"})
    assert response.status_code == 200
    assert response.content == b"original"
    assert "content-encoding" not in response.headers

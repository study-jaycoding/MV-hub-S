"""Actual SPA routes, isolated before app import so no built dist or startup is required."""
from __future__ import annotations

import os
from pathlib import Path
import subprocess
import sys


def test_spa_entry_cache_and_static_boundaries(tmp_path: Path) -> None:
    dist = tmp_path / "dist"
    assets = dist / "assets"
    assets.mkdir(parents=True)
    (dist / "index.html").write_text("<html>cache regression</html>", encoding="utf-8")
    (dist / "favicon.ico").write_bytes(b"icon fixture")
    (assets / "app-abc123.js").write_bytes(b"console.log('fixture')")
    (tmp_path / "outside.txt").write_text("must not escape", encoding="utf-8")
    env = {key: value for key, value in os.environ.items() if not key.upper().startswith("CONTENT_HUB_")}
    env.update(CONTENT_HUB_DATA=str(tmp_path / "data"), CONTENT_HUB_FRONTEND_DIST=str(dist),
               CONTENT_HUB_NO_PROXY="1", CONTENT_HUB_EXTERNAL_RECOVERY="0", CONTENT_HUB_AUTH="0",
               CONTENT_HUB_READ_ONLY="1", CONTENT_HUB_DB_POOL="0", PYTHONDONTWRITEBYTECODE="1")
    # Separate interpreter makes import-time route registration independent of test collection order.
    result = subprocess.run([sys.executable, "-c", r'''
import socket
import sys
from unittest.mock import patch

original_connect = socket.socket.connect
socketpair_code = getattr(socket.socketpair, "__code__", None)
def deny(*args, **kwargs):
    raise AssertionError("External network forbidden in SPA cache test")
def guard(sock, address):
    if sys._getframe(1).f_code is socketpair_code and address[0] in ("127.0.0.1", "::1"):
        return original_connect(sock, address)
    return deny()

with patch.object(socket.socket, "connect", guard), patch.object(socket.socket, "connect_ex", deny), patch.object(socket, "create_connection", deny):
    from app.main import app
    from fastapi.testclient import TestClient
    client = TestClient(app, client=("127.0.0.1", 50000))
    try:
        for url in ("/", "/index.html", "/scene/cache-regression"):
            response = client.get(url)
            assert response.status_code == 200, (url, response.status_code)
            assert response.text == "<html>cache regression</html>"
            assert response.headers.get("cache-control") == "no-cache, must-revalidate", (url, dict(response.headers))
        icon = client.get("/favicon.ico")
        assert icon.status_code == 200 and icon.content == b"icon fixture"
        assert "cache-control" not in icon.headers
        asset = client.get("/assets/app-abc123.js")
        assert asset.status_code == 200 and asset.content == b"console.log('fixture')"
        assert asset.headers["cache-control"] == "public, max-age=31536000, immutable"
        for url in ("/api/cache-regression-missing", "/media/cache-regression-missing", "/ws-missing", "/assets/%2e%2e/outside.txt"):
            response = client.get(url)
            assert response.status_code == 404, (url, response.status_code)
            assert b"must not escape" not in response.content
    finally:
        client.close()
'''], cwd=Path(__file__).resolve().parents[1], env=env, capture_output=True, text=True, timeout=30)
    assert result.returncode == 0, result.stdout + result.stderr

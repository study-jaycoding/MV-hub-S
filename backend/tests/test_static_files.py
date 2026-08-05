from __future__ import annotations

from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.static_files import ImmutableStaticFiles


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

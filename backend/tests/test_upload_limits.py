from __future__ import annotations

import asyncio
import io
import json
import tempfile
from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi import FastAPI, File, HTTPException, UploadFile as FastApiUploadFile
from fastapi.testclient import TestClient
from starlette.datastructures import UploadFile

from app.routers import assets, comfy, db_transfer
from app.services import upload_limits


async def _call_middleware(
    *,
    path: str = "/api/assets/upload",
    method: str = "POST",
    body_chunks: tuple[bytes, ...] = (b"",),
    content_lengths: tuple[str, ...] = (),
    limit: int = 10,
    limited_path: str | None = None,
) -> tuple[list[dict], list[int]]:
    consumed: list[int] = []

    async def inner(scope, receive, send):
        total = 0
        while True:
            message = await receive()
            if message["type"] != "http.request":
                break
            total += len(message.get("body", b""))
            if not message.get("more_body", False):
                break
        consumed.append(total)
        payload = json.dumps({"size": total}).encode()
        await send(
            {
                "type": "http.response.start",
                "status": 200,
                "headers": [(b"content-type", b"application/json")],
            }
        )
        await send({"type": "http.response.body", "body": payload})

    messages = [
        {
            "type": "http.request",
            "body": chunk,
            "more_body": index < len(body_chunks) - 1,
        }
        for index, chunk in enumerate(body_chunks)
    ]
    if not messages:
        messages = [{"type": "http.request", "body": b"", "more_body": False}]

    async def receive():
        if messages:
            return messages.pop(0)
        return {"type": "http.disconnect"}

    sent: list[dict] = []

    async def send(message):
        sent.append(message)

    scope = {
        "type": "http",
        "asgi": {"version": "3.0"},
        "http_version": "1.1",
        "method": method,
        "scheme": "http",
        "path": path,
        "raw_path": path.encode(),
        "query_string": b"",
        "headers": [(b"content-length", value.encode()) for value in content_lengths],
        "client": ("127.0.0.1", 50000),
        "server": ("127.0.0.1", 8010),
    }
    selected = limited_path or path.rstrip("/")
    middleware = upload_limits.UploadBodyLimitMiddleware(inner, limits={selected: limit})
    await middleware(scope, receive, send)
    return sent, consumed


def _status(messages: list[dict]) -> int:
    return next(message["status"] for message in messages if message["type"] == "http.response.start")


def _json_body(messages: list[dict]) -> dict:
    data = b"".join(
        message.get("body", b"")
        for message in messages
        if message["type"] == "http.response.body"
    )
    return json.loads(data)


def test_declared_oversize_is_rejected_before_downstream_reads() -> None:
    sent, consumed = asyncio.run(
        _call_middleware(body_chunks=(b"small",), content_lengths=("11",), limit=10)
    )
    assert _status(sent) == 413
    assert consumed == []
    assert "너무 큽니다" in _json_body(sent)["detail"]


@pytest.mark.parametrize("content_lengths", [(("oops",)), (("-1",)), (("4", "5"))])
def test_invalid_or_ambiguous_content_length_is_rejected(content_lengths: tuple[str, ...]) -> None:
    sent, consumed = asyncio.run(
        _call_middleware(body_chunks=(b"data",), content_lengths=content_lengths, limit=10)
    )
    assert _status(sent) == 400
    assert consumed == []


def test_streamed_body_without_content_length_is_counted() -> None:
    sent, consumed = asyncio.run(
        _call_middleware(body_chunks=(b"123456", b"78901"), limit=10)
    )
    assert _status(sent) == 413
    assert consumed == []


def test_false_small_content_length_cannot_bypass_stream_counter() -> None:
    sent, consumed = asyncio.run(
        _call_middleware(
            body_chunks=(b"123456", b"78901"),
            content_lengths=("5",),
            limit=10,
        )
    )
    assert _status(sent) == 413
    assert consumed == []


def test_fastapi_multipart_parser_cannot_hide_stream_overflow_as_400() -> None:
    app = FastAPI()

    @app.post("/upload")
    async def receive_upload(file: FastApiUploadFile = File(...)):
        return {"size": len(await file.read())}

    app.add_middleware(
        upload_limits.UploadBodyLimitMiddleware,
        limits={"/upload": 64},
    )
    client = TestClient(app, client=("127.0.0.1", 50000))
    response = client.post(
        "/upload",
        files={"file": ("large.bin", b"x" * 100, "application/octet-stream")},
        # 실제 본문보다 작은 거짓 헤더 — 원시 바이트 카운터가 최종 방어선이어야 한다.
        headers={"Content-Length": "1"},
    )

    assert response.status_code == 413
    assert response.headers["X-MVHub-Upload-Limit"] == "64"
    assert "너무 큽니다" in response.json()["detail"]


def test_exact_limit_and_trailing_slash_are_allowed() -> None:
    sent, consumed = asyncio.run(
        _call_middleware(
            path="/api/assets/upload/",
            body_chunks=(b"12345", b"67890"),
            content_lengths=("10",),
            limit=10,
        )
    )
    assert _status(sent) == 200
    assert consumed == [10]


def test_unselected_path_is_not_limited() -> None:
    sent, consumed = asyncio.run(
        _call_middleware(
            path="/api/other",
            body_chunks=(b"x" * 100,),
            content_lengths=("100",),
            limit=10,
            limited_path="/api/assets/upload",
        )
    )
    assert _status(sent) == 200
    assert consumed == [100]


def test_upload_batch_uses_actual_sizes_and_preserves_stream_position() -> None:
    first_stream = io.BytesIO(b"1234")
    first_stream.seek(2)
    files = [
        UploadFile(first_stream, filename="one.bin"),
        UploadFile(io.BytesIO(b"56789"), size=5, filename="two.bin"),
    ]
    assert upload_limits.validate_upload_batch(
        files,
        max_files=2,
        max_file_bytes=6,
        max_total_bytes=9,
    ) == 9
    assert first_stream.tell() == 2


@pytest.mark.parametrize(
    ("files", "kwargs", "kind"),
    [
        ([UploadFile(io.BytesIO(b"a")), UploadFile(io.BytesIO(b"b"))], {"max_files": 1, "max_file_bytes": 9, "max_total_bytes": 9}, "file_count"),
        ([UploadFile(io.BytesIO(b"1234"))], {"max_files": 1, "max_file_bytes": 3, "max_total_bytes": 9}, "file_size"),
        ([UploadFile(io.BytesIO(b"123")), UploadFile(io.BytesIO(b"456"))], {"max_files": 2, "max_file_bytes": 4, "max_total_bytes": 5}, "total_size"),
    ],
)
def test_upload_batch_rejects_each_policy_boundary(files, kwargs, kind: str) -> None:
    with pytest.raises(upload_limits.UploadLimitExceeded) as caught:
        upload_limits.validate_upload_batch(files, **kwargs)
    assert caught.value.kind == kind


def test_copy_stream_limited_never_writes_beyond_limit() -> None:
    target = io.BytesIO()
    with pytest.raises(upload_limits.UploadLimitExceeded):
        upload_limits.copy_stream_limited(
            io.BytesIO(b"123456"),
            target,
            max_bytes=5,
            chunk_bytes=3,
        )
    assert target.getvalue() == b"123"


@pytest.mark.parametrize(
    ("value", "display"),
    [(512, "512바이트"), (1024, "1KB"), (1536, "1.5KB"), (2 * 1024 * 1024, "2MB")],
)
def test_byte_limit_display_never_rounds_small_values_to_zero(value: int, display: str) -> None:
    assert upload_limits.format_byte_limit(value) == display


def test_every_upload_route_has_a_positive_request_limit() -> None:
    assert set(upload_limits.UPLOAD_REQUEST_LIMITS) == {
        "/api/assets/upload",
        "/api/assets/capture",
        "/api/assets/reference-import",
        "/api/comfy/run",
        "/api/db/import",
        "/api/db-backup",
        "/api/db-backup/sets",
    }
    assert all(value > 0 for value in upload_limits.UPLOAD_REQUEST_LIMITS.values())


def test_main_middleware_limits_before_proxy_and_inside_observation() -> None:
    from app.main import app

    classes = [item.cls for item in app.user_middleware]
    limit_index = classes.index(upload_limits.UploadBodyLimitMiddleware)
    assert limit_index == 2
    assert app.user_middleware[0].kwargs["dispatch"].__name__ == "runtime_observation"
    assert app.user_middleware[1].kwargs["dispatch"].__name__ == "auth_off_remote_guard"
    assert app.user_middleware[limit_index + 1].kwargs["dispatch"].__name__ == "data_proxy"


def test_assets_total_limit_rejects_before_any_file_is_saved(monkeypatch) -> None:
    with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp_dir:
        root = Path(tmp_dir)
        monkeypatch.setattr(assets, "_safe_project_dir", lambda *_args: root)
        monkeypatch.setattr(assets, "_UPLOAD_TOTAL_MAX_BYTES", 5)
        files = [
            UploadFile(io.BytesIO(b"123"), filename="one.png"),
            UploadFile(io.BytesIO(b"456"), filename="two.png"),
        ]

        with pytest.raises(HTTPException) as caught:
            asyncio.run(
                assets.upload_assets(
                    SimpleNamespace(), project="demo", dir="", files=files
                )
            )

        assert caught.value.status_code == 413
        assert caught.value.headers == upload_limits.limit_headers(5)
        assert list(root.glob("*.png")) == []
        assert list(root.glob(".upload-*.part")) == []


def test_comfy_limits_are_checked_before_media_is_copied(monkeypatch) -> None:
    monkeypatch.setattr(upload_limits, "COMFY_UPLOAD_MAX_FILES", 2)
    monkeypatch.setattr(upload_limits, "COMFY_UPLOAD_FILE_MAX_BYTES", 4)
    monkeypatch.setattr(upload_limits, "COMFY_UPLOAD_TOTAL_MAX_BYTES", 5)
    first = UploadFile(io.BytesIO(b"123"), filename="one.png")
    second = UploadFile(io.BytesIO(b"456"), filename="two.png")

    with pytest.raises(HTTPException) as caught:
        comfy._stage_media_uploads([first, second])

    assert caught.value.status_code == 413
    assert caught.value.headers == upload_limits.limit_headers(5)
    assert first.file.tell() == 0
    assert second.file.tell() == 0


def test_db_import_streams_to_temp_and_always_removes_it(monkeypatch) -> None:
    with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp_dir:
        root = Path(tmp_dir)
        seen: dict[str, object] = {}

        monkeypatch.setattr(db_transfer, "require_admin", lambda _request: None)
        monkeypatch.setattr(db_transfer, "_require_local_when_open", lambda _request: None)
        monkeypatch.setattr(db_transfer.tempfile, "gettempdir", lambda: str(root))
        monkeypatch.setattr(db_transfer, "validate_hub_db", lambda path: seen.update(validated=path.read_bytes()))

        def install(path: Path) -> dict:
            seen["install_path"] = path
            seen["installed"] = path.read_bytes()
            return {"ok": True}

        monkeypatch.setattr(db_transfer, "_install_db", install)
        result = asyncio.run(
            db_transfer.import_db(
                SimpleNamespace(),
                UploadFile(io.BytesIO(b"sqlite-data"), filename="hub.db"),
            )
        )

        assert result == {"ok": True}
        assert seen["validated"] == b"sqlite-data"
        assert seen["installed"] == b"sqlite-data"
        assert not Path(seen["install_path"]).exists()
        assert list(root.glob("mvhub-import-*.db")) == []


def test_db_import_rejects_known_oversize_without_temp_file(monkeypatch) -> None:
    with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp_dir:
        root = Path(tmp_dir)
        monkeypatch.setattr(db_transfer, "require_admin", lambda _request: None)
        monkeypatch.setattr(db_transfer, "_require_local_when_open", lambda _request: None)
        monkeypatch.setattr(db_transfer.tempfile, "gettempdir", lambda: str(root))
        monkeypatch.setattr(upload_limits, "DB_UPLOAD_FILE_MAX_BYTES", 3)

        with pytest.raises(HTTPException) as caught:
            asyncio.run(
                db_transfer.import_db(
                    SimpleNamespace(),
                    UploadFile(io.BytesIO(b"1234"), filename="hub.db"),
                )
            )

        assert caught.value.status_code == 413
        assert caught.value.headers == upload_limits.limit_headers(3)
        assert list(root.glob("mvhub-import-*.db")) == []

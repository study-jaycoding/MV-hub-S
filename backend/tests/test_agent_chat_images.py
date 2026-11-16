"""그림 입력 경계·CLI 전달·임시 파일 수명 — 격리 DB와 가짜 CLI만 쓴다."""
import asyncio
import base64
import io
import json
import os
import threading
import time
from pathlib import Path
from uuid import uuid4

import pytest
from fastapi import HTTPException
from PIL import Image
from starlette.requests import Request

from app import config
from app.repo import agent_chat as store
from app.routers import agent_chat as router
from app.services import agent_chat as chat
from app.services import agent_chat_process as process
from test_agent_chat_api import hub, panel_headers, start_turn, wait_status  # noqa: F401
from test_agent_chat_attach import CONTEXT, ITEMS, PERSONAL
from test_agent_chat_runtime import runtime, finish  # noqa: F401


def picture(fmt="PNG", size=(8, 8)):
    stream = io.BytesIO()
    Image.new("RGB", size, "red").save(stream, format=fmt)
    return stream.getvalue()


def encoded(index=0, media="image/png", raw=None, **extra):
    return {"index": index, "media_type": media,
            "data": base64.b64encode(picture() if raw is None else raw).decode("ascii"), **extra}


def attachments(count=8):
    return [router.AttachGeneration(kind="generation", id=f"g{i}") for i in range(count)]


@pytest.mark.parametrize("fmt,media", [("PNG", "image/png"), ("JPEG", "image/jpeg"), ("WEBP", "image/webp"), ("GIF", "image/gif")])
def test_valid_images(fmt, media):
    raw = picture(fmt)
    assert router._checked_images([encoded(2, media, raw)], attachments()) == [(2, media, raw)]


@pytest.mark.parametrize("images,items", [
    (None, attachments()), ({}, attachments()), ([encoded()] * 9, attachments()),
    ([encoded(unknown=True)], attachments()), ([{}], attachments()), (["wrong"], attachments()),
    ([encoded(index=True)], attachments()), ([encoded(index="0")], attachments()),
    ([encoded(index=-1)], attachments()), ([encoded(index=8)], attachments()),
    ([encoded(index=1)], attachments(1)), ([encoded(), encoded()], attachments()),
    ([encoded()], []), ([encoded()], [router.AttachFolder(**ITEMS[2])]),
    ([encoded(data="not base64")], attachments()), ([encoded(data="a" * 2_000_005)], attachments()),
    ([encoded(raw=b"\x89PNG\r\n\x1a\ntrash")], attachments()),
    ([encoded(raw=b"not an image")], attachments()), ([encoded(raw=picture("JPEG"))], attachments()),
    ([encoded(media="image/svg+xml")], attachments()), ([encoded(media=[])], attachments()),
    ([encoded(raw=picture(size=(2049, 1)))], attachments()), ([encoded(raw=picture(size=(1, 2049)))], attachments()),
    ([encoded(raw=picture() + b"x" * 1_500_000)], attachments()),
])
def test_bad_images_are_short_and_do_not_echo_input(images, items):
    with pytest.raises(HTTPException) as caught:
        router._checked_images(images, items)
    assert caught.value.status_code == 422
    assert "번 그림을 보낼 수 없어요" in caught.value.detail
    assert len(caught.value.detail) < 30


def test_total_limit_and_boundary():
    raw = picture()
    raw += b"x" * (1_500_000 - len(raw))
    assert len(router._checked_images([encoded(i, raw=raw) for i in range(4)], attachments())) == 4
    with pytest.raises(HTTPException) as caught:
        router._checked_images([encoded(i, raw=raw) for i in range(5)], attachments())
    assert caught.value.detail == "5번 그림을 보낼 수 없어요"


def test_verify_reopen_and_actual_format_must_match(monkeypatch):
    real, opened = Image.open, []

    def open_image(*args, **kwargs):
        image = real(*args, **kwargs)
        opened.append(image)
        if len(opened) == 2:
            image.format = "JPEG"
        return image

    monkeypatch.setattr(Image, "open", open_image)
    with pytest.raises(HTTPException) as caught:
        router._checked_images([encoded()], attachments())
    assert len(opened) == 2 and caught.value.status_code == 422


def test_corrupt_pixels_pass_verify_but_fail_load():
    """독립 리뷰 2 — 머리·청크(CRC 포함)는 멀쩡하고 압축된 픽셀만 깨진 PNG 는 verify() 를 지나지만 load() 에서 걸린다."""
    import zlib
    raw = bytearray(picture())
    at = raw.index(b"IDAT")
    length = int.from_bytes(raw[at - 4:at], "big")
    raw[at + 4:at + 4 + length] = b"\x00" * length  # 압축 자료만 망가뜨림
    raw[at + 4 + length:at + 8 + length] = zlib.crc32(bytes(raw[at:at + 4 + length])).to_bytes(4, "big")  # CRC 는 맞춤
    with Image.open(io.BytesIO(bytes(raw))) as image:
        image.verify()  # 이 단계는 통과한다 — load() 가 있어야 막힌다
    with pytest.raises(HTTPException) as caught:
        router._checked_images([encoded(raw=bytes(raw))], attachments())
    assert caught.value.detail == "1번 그림을 보낼 수 없어요"


@pytest.mark.parametrize("headers", [[], [(b"content-length", b"1")]])
def test_body_limit_counts_chunks_without_trusting_length(headers):
    async def run():
        chunks = iter([b" " * 4_200_000, b" " * 4_200_000, b"x"])
        calls = []

        async def receive():
            calls.append(1)
            return {"type": "http.request", "body": next(chunks), "more_body": True}

        request = Request({"type": "http", "headers": headers}, receive)
        with pytest.raises(HTTPException) as caught:
            await router._read_turn(request)
        assert caught.value.status_code == 413 and len(calls) == 3
        assert len(str(caught.value.detail)) < 40
    asyncio.run(run())


def test_pillow_runs_in_worker_thread(monkeypatch):
    owner = threading.get_ident()
    real = router._checked_images
    threads = []

    def check(*args):
        threads.append(threading.get_ident())
        return real(*args)

    monkeypatch.setattr(router, "_checked_images", check)
    payload = {"idempotency_key": "test-key", "engine": "claude", "model": "haiku", "effort": "low", "text": "말"}

    async def receive():
        return {"type": "http.request", "body": json.dumps(payload).encode(), "more_body": False}

    asyncio.run(router._read_turn(Request({"type": "http", "headers": []}, receive)))
    assert threads and threads[0] != owner


@pytest.mark.parametrize("change", [
    {"attach_workspace": {"scope": "team", "id": "elsewhere"}},
    {"attachments": [{"kind": "generation", "id": f"g{i}"} for i in range(9)]},
    {"engine": "unknown"}, {"extra": "unknown"},
])
def test_turn_validation_never_echoes_images(hub, change):  # noqa: F811
    client, _, _ = hub
    payload = {"images": [encoded()], "attachments": ITEMS[:1], "attach_workspace": PERSONAL, "context": CONTEXT, **change}
    response = start_turn(client, panel_headers(client), **payload)
    assert response.status_code == 422
    assert encoded()["data"] not in response.text
    assert all(set(error) == {"loc", "msg", "type"} for error in response.json()["detail"])


def test_auth_precedes_broken_json_and_picture_error_is_sanitized(hub):  # noqa: F811
    client, _, _ = hub
    assert client.post("/api/agent-chat/turns", content=b"{").status_code == 401
    headers = panel_headers(client)
    assert client.post("/api/agent-chat/turns", headers=headers, content=b"{").status_code == 422
    response = start_turn(client, headers, images=[encoded(raw=b"bad")], attachments=ITEMS[:1], attach_workspace=PERSONAL)
    assert response.json() == {"detail": "1번 그림을 보낼 수 없어요"}


def test_claude_stream_order_eof_resume_fork_and_no_persistence(hub, monkeypatch, tmp_path):  # noqa: F811
    client, _, service = hub
    capture = tmp_path / "input.json"
    monkeypatch.setenv("FAKE_AGENT_INPUT_FILE", str(capture))
    monkeypatch.setenv("FAKE_AGENT_SCENARIO", "claude_ok")
    headers = panel_headers(client)
    key = uuid4().hex
    kwargs = {"images": [encoded(1), encoded(0)], "attachments": ITEMS[:2], "attach_workspace": PERSONAL, "context": CONTEXT}
    first = start_turn(client, headers, idempotency_key=key, **kwargs).json()
    wait_status(client, headers, first["turn_id"], {"done"})
    data = json.loads(capture.read_text(encoding="utf-8"))
    assert data["args"][data["args"].index("--input-format") + 1] == "stream-json"
    assert data["stdin"].endswith("\n") and len(data["stdin"].splitlines()) == 1
    content = json.loads(data["stdin"])["message"]["content"]
    assert [item["type"] for item in content] == ["text", "text", "image", "text", "image"]
    assert content[1]["text"] == "붙인 자료 2번 그림" and content[3]["text"] == "붙인 자료 1번 그림"
    assert base64.b64decode(content[2]["source"]["data"]) == picture()
    assert "[함께 보낸 그림]" in content[0]["text"]
    restored = client.get(f"/api/agent-chat/conversations/{first['conversation_id']}", headers=headers).json()
    assert encoded()["data"] not in json.dumps(restored)
    assert restored["turns"][0]["attachments"]["items"] == ITEMS[:2]
    replay = start_turn(client, headers, idempotency_key=key, **kwargs).json()
    assert replay["turn_id"] == first["turn_id"]
    resumed = start_turn(client, headers, conversation_id=first["conversation_id"], **kwargs).json()
    wait_status(client, headers, resumed["turn_id"], {"done"})
    assert "--resume" in json.loads(capture.read_text())["args"]
    fork = client.post(f"/api/agent-chat/conversations/{first['conversation_id']}/fork", headers=headers,
                       json={"request_id": str(uuid4())}).json()["conversation"]
    monkeypatch.setenv("FAKE_AGENT_SESSION", "S-fork-images")
    forked = start_turn(client, headers, conversation_id=fork["id"], **kwargs).json()
    wait_status(client, headers, forked["turn_id"], {"done"})
    args = json.loads(capture.read_text())["args"]
    assert "--fork-session" in args and "--resume" in args and "--input-format" in args


def launch(runtime, monkeypatch, *, engine="codex", scenario="codex_ok", resume=None):
    service, identity, _ = runtime
    monkeypatch.setenv("FAKE_AGENT_SCENARIO", scenario)
    path = identity.db_file()
    conv = store.create_conversation(path, engine=engine, model="haiku", effort="low", client_id=uuid4().hex,
                                     mcp_entry={"command": "python", "args": ["adapter.py"]}, title="t")
    if resume:
        store.update_conversation(path, conv["id"], cli_session_id=resume)
        conv = store.get_conversation(path, conv["id"])
    turn, _ = store.claim_turn(path, conversation_id=conv["id"], idempotency_key=uuid4().hex, text="말", context={})
    service.start_turn(identity, conversation=conv, turn=turn, model="haiku" if engine == "claude" else "gpt-6-astra",
                       effort="low", text="말", context={}, still_current=lambda: None,
                       images=[(1, "image/png", picture())])
    return path, turn


@pytest.mark.parametrize("resume", [None, "T-codex-1"])
def test_codex_files_arguments_and_cleanup(runtime, monkeypatch, resume):  # noqa: F811
    service, _, tmp = runtime
    capture = tmp / "capture.json"
    monkeypatch.setenv("FAKE_AGENT_INPUT_FILE", str(capture))
    path, turn = launch(runtime, monkeypatch, resume=resume)
    assert finish(path, turn["id"])["status"] == "done"
    data = json.loads(capture.read_text())
    args = data["args"]
    image = Path(data["images"][0]["path"])
    assert image.name == "2.png" and data["images"][0]["size"] == len(picture())
    assert "첨부 그림 순서 = 붙인 자료 2번" in data["stdin"]
    if resume:
        assert args[args.index("resume"):] == ["resume", "--image", str(image), "--", resume, "-"]
    else:
        assert args.index("--image") < args.index("-C")
    assert not image.parent.exists()


@pytest.mark.parametrize("mode", ["failure", "cancel", "timeout", "spawn", "thread", "partial", "handoff"])
def test_codex_files_removed_on_every_failure(runtime, monkeypatch, mode):  # noqa: F811
    service, identity, tmp = runtime
    if mode == "timeout":
        monkeypatch.setattr(chat, "TURN_TIMEOUT", 0.5)
    if mode == "spawn":
        monkeypatch.setattr(process.JobProcess, "start", lambda *args: (_ for _ in ()).throw(OSError("spawn")))
    if mode == "thread":
        real = threading.Thread.start

        def fail(thread):
            if thread.name.startswith("agent-chat-"):
                raise RuntimeError("thread")
            return real(thread)
        monkeypatch.setattr(threading.Thread, "start", fail)
    if mode == "partial":
        real = Path.write_bytes

        def fail(target, raw):
            if target.suffix == ".png":
                real(target, raw[:10])
                raise OSError("partial")
            return real(target, raw)
        monkeypatch.setattr(Path, "write_bytes", fail)
    if mode == "handoff":
        monkeypatch.setattr(process, "build_command", lambda *args, **kwargs: (_ for _ in ()).throw(RuntimeError("handoff")))
    if mode in {"thread", "partial", "handoff"}:
        with pytest.raises((RuntimeError, OSError)):
            launch(runtime, monkeypatch)
        assert not service._runtimes
    else:
        path, turn = launch(runtime, monkeypatch, scenario="codex_fail" if mode == "failure" else "codex_slow")
        if mode == "cancel":
            service.cancel(identity, turn["id"])
        result = finish(path, turn["id"])
        assert result["status"] == ("cancelled" if mode == "cancel" else "failed")
        if mode == "timeout":
            assert result["reason"] == "timeout"
    assert not list((config.AGENT_CHAT_DIR / "images").iterdir())


def test_cleanup_start_repeat_timer_shutdown_and_age(runtime, monkeypatch):  # noqa: F811
    service, _, _ = runtime
    root = config.AGENT_CHAT_DIR / "images"

    def directory(name, age):
        path = root / name
        path.mkdir(parents=True)
        (path / "1.png").write_bytes(picture())
        stamp = time.time() - age
        os.utime(path, (stamp, stamp))
        return path

    old = directory("old", 3601)
    young = directory("young", 3599)
    active = directory("other-hub-active", 10)
    assert old.exists()  # 생성자에서는 정리하지 않는다
    monkeypatch.setattr(chat, "_IMAGE_CLEANUP_DELAY", 0.15)
    service.start_image_cleanup()
    first = service._image_timer
    assert not old.exists() and young.exists() and active.exists() and first.daemon
    os.utime(young, (time.time() - 3601, time.time() - 3601))
    assert first.finished.wait(3)
    assert not young.exists() and active.exists()
    service.start_image_cleanup()
    second = service._image_timer
    service.start_image_cleanup()
    assert second.finished.is_set()
    last = service._image_timer
    service.shutdown()
    assert last.finished.is_set()


def test_image_turn_cleans_old_directories(runtime, monkeypatch):  # noqa: F811
    old = config.AGENT_CHAT_DIR / "images" / "old"
    old.mkdir(parents=True)
    os.utime(old, (time.time() - 3601, time.time() - 3601))
    path, turn = launch(runtime, monkeypatch)
    assert finish(path, turn["id"])["status"] == "done" and not old.exists()


def test_no_image_command_and_stdin_are_unchanged(runtime, monkeypatch):  # noqa: F811
    service, identity, tmp = runtime
    capture = tmp / "capture.json"
    monkeypatch.setenv("FAKE_AGENT_INPUT_FILE", str(capture))
    from test_agent_chat_runtime import start
    path, _, turn = start(service, identity, monkeypatch, "claude_ok", text="그림 없는 말")
    assert finish(path, turn["id"])["status"] == "done"
    data = json.loads(capture.read_text())
    assert "--input-format" not in data["args"] and "--image" not in data["args"]
    assert data["stdin"].encode() == chat.build_prompt("그림 없는 말", {"tab": "my"}).encode()

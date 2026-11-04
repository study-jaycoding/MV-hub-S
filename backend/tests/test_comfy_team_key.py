"""팀 Comfy 키 — 서버 보관(DPAPI)·관리자/팀원 끝점·허브 캐시·실행 지문 v2. 실사용 서버·실사용 DB·comfy.org 호출 없음.

계약: docs/status/Comfy팀키_서버배포_2026-11-04.md.
"""
from __future__ import annotations

import contextlib
import json
import logging
import os
import threading
import time

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient

from app import db, deps, main, manage_db, repo
from app.routers import _proxy, comfy, comfy_team_key as router
from app.services import auth, comfy_client, comfy_team_key as svc, shared_connection
from test_comfy_run_journal import h  # noqa: F401

ORIGINAL_RAW_SETTINGS = comfy._raw_settings  # h 가 가짜로 바꾸므로 진짜를 미리 잡아 둔다
ADMIN, MEMBER, PENDING = "boss@x.test", "mate@x.test", "wait@x.test"
PASSWORD = "secret123"
KEY = "comfyui-team-key-0123456789abcdef"
windows_only = pytest.mark.skipif(os.name != "nt", reason="DPAPI 는 Windows 에서만")


# ── 공통 ───────────────────────────────────────────────────────────────────────
@pytest.fixture
def memory_store(monkeypatch):
    values: dict = {}
    monkeypatch.setattr(repo, "get_setting", lambda key, default=None: values.get(key, default))
    monkeypatch.setattr(repo, "set_setting", lambda key, value: values.__setitem__(key, value) if value is not None else values.pop(key, None))
    return values


@pytest.fixture
def hub(monkeypatch):
    """AUTH off 허브 — 서버 위임 조건(토큰 있음·NO_PROXY 꺼짐), 가짜 시계·가짜 HTTP."""
    state = {"base": "http://server.invalid:8010", "token": "tok-A", "clock": 1000.0, "answers": [], "calls": []}
    monkeypatch.delenv("CONTENT_HUB_NO_PROXY", raising=False)
    monkeypatch.setattr(svc, "AUTH_ENABLED", False)
    monkeypatch.setattr(shared_connection, "base_url", lambda: state["base"])
    monkeypatch.setattr(shared_connection, "token", lambda: state["token"])
    monkeypatch.setattr(svc.time, "monotonic", lambda: state["clock"])

    def http(url, token, timeout=5.0):
        state["calls"].append((url, token))
        answer = state["answers"].pop(0) if state["answers"] else (None, b"")
        return answer(url, token) if callable(answer) else answer

    monkeypatch.setattr(svc, "_http_get", http)
    svc.forget()
    yield state
    svc.forget()


def ok_body(key=KEY, revision=1):
    return (200, json.dumps({"api_key": key, "revision": revision, "updated_at": "2026-11-04T05:00:00Z"}).encode())


# ── team-key-store ─────────────────────────────────────────────────────────────
@windows_only
def test_store_roundtrip_without_plaintext_and_with_revisions(memory_store):
    meta = svc.save_store(KEY, ADMIN)
    assert meta["has_key"] is True and meta["state"] == "ok" and meta["revision"] == 1 and meta["updated_by"] == ADMIN
    assert "api_key" not in meta
    raw = memory_store[svc.SETTING_KEY]
    assert KEY not in raw and json.loads(raw)["enc"] == "dpapi-machine"
    assert svc.read_store()["api_key"] == KEY
    assert svc.save_store("comfyui-second", ADMIN)["revision"] == 2
    assert svc.read_store()["api_key"] == "comfyui-second"
    assert svc.clear_store(ADMIN)["state"] == "none"
    assert svc.SETTING_KEY not in memory_store and svc.read_store()["state"] == "none"


@windows_only
def test_store_marks_undecryptable_and_keeps_the_original(memory_store):
    broken = json.dumps({"v": 1, "enc": "dpapi-machine", "data": "QUFBQQ==", "revision": 7, "updated_at": "2026-11-04T05:00:00Z", "updated_by": ADMIN})
    memory_store[svc.SETTING_KEY] = broken
    item = svc.read_store()
    assert item["state"] == "undecryptable" and item["api_key"] is None and item["revision"] == 7
    assert memory_store[svc.SETTING_KEY] == broken  # 원본 보존
    memory_store[svc.SETTING_KEY] = "not json"
    assert svc.read_store()["state"] == "undecryptable"
    assert svc.public_meta(svc.read_store())["has_key"] is False


@windows_only
def test_store_serializes_concurrent_saves(memory_store, monkeypatch):
    """판을 읽은 뒤 쓰기 직전에 멈춰 두 등록을 겹치게 한다 — 잠금이 있으면 1·2, 잠금을 빼면 같은 판을 쓴다(시험이 결함을 본다는 증거)."""
    real_read = svc.read_store

    def read_then_stall():
        item = real_read()
        time.sleep(0.1)  # 읽기 → 쓰기 사이
        return item

    monkeypatch.setattr(svc, "read_store", read_then_stall)

    def race() -> list[int]:
        memory_store.pop(svc.SETTING_KEY, None)
        got: list[int] = []
        threads = [threading.Thread(target=lambda i=i: got.append(svc.save_store(f"comfyui-{i}", ADMIN)["revision"])) for i in range(2)]
        for t in threads:
            t.start()
        for t in threads:
            t.join(5)
        assert not any(t.is_alive() for t in threads)
        return sorted(got)

    assert race() == [1, 2] and real_read()["revision"] == 2
    monkeypatch.setattr(svc, "_store_lock", contextlib.nullcontext())  # 잠금을 빼면 두 등록이 같은 판을 쓴다
    assert race() == [1, 1]


def test_store_refuses_to_save_when_encryption_fails(memory_store, monkeypatch):
    def boom(_secret):
        raise svc.ProtectError("synthetic")

    monkeypatch.setattr(svc, "protect", boom)
    with pytest.raises(svc.ProtectError):
        svc.save_store(KEY, ADMIN)
    assert svc.SETTING_KEY not in memory_store
    with pytest.raises(ValueError):
        svc.save_store("   ", ADMIN)


# ── admin-endpoints · member-endpoint ──────────────────────────────────────────
@pytest.fixture
def server(tmp_path, monkeypatch):
    monkeypatch.setenv("CONTENT_HUB_DB", str(tmp_path / "content_hub.db"))
    monkeypatch.setattr(manage_db, "MANAGE_DB_PATH", tmp_path / "manage_hub.db")
    db.flush_pool()
    for module in (main, deps, router, svc):
        monkeypatch.setattr(module, "AUTH_ENABLED", True)
    db.init_db()
    repo.ensure_default_worker()
    repo.register(ADMIN, PASSWORD, "관리자")
    repo.register(MEMBER, PASSWORD, "팀원")
    repo.set_account_status(MEMBER, "approved")
    repo.register(PENDING, PASSWORD, "대기")
    yield
    db.flush_pool()


def client(ip="127.0.0.1"):
    return TestClient(main.app, base_url="http://127.0.0.1:8010", client=(ip, 50000))


def bearer(email):
    token = auth.make_token(email, pwd_stamp=repo.get_account(email)["password_changed_at"])
    return {"Authorization": f"Bearer {token}"}


def test_hub_answers_404_itself_and_never_relays(monkeypatch):
    assert _proxy.is_local_path(router.ADMIN_PATH) and _proxy.is_local_path(router.TEAM_PATH)
    for module in (main, deps, router):
        monkeypatch.setattr(module, "AUTH_ENABLED", False)
    web = client()
    assert web.get(router.ADMIN_PATH).status_code == 404
    assert web.put(router.ADMIN_PATH, json={"api_key": KEY}).status_code == 404
    assert web.get(router.TEAM_PATH).status_code == 404


def test_hub_with_delegation_on_does_not_forward_the_team_key_path(monkeypatch):
    for module in (main, deps, router):
        monkeypatch.setattr(module, "AUTH_ENABLED", False)
    monkeypatch.delenv("CONTENT_HUB_NO_PROXY", raising=False)
    monkeypatch.setattr(_proxy, "token", lambda: "stored-admin-token")
    assert _proxy.proxying()

    async def forbidden(_request):
        raise AssertionError("허브가 팀 키 경로를 서버로 중계했다")

    monkeypatch.setattr(_proxy, "_forward", forbidden)
    web = client()
    assert web.get(router.TEAM_PATH, headers={"Authorization": "Bearer anything"}).status_code == 404
    assert web.get(router.ADMIN_PATH).status_code == 404


@windows_only
def test_admin_endpoints_gate_and_mask(server, caplog):
    web = client()
    assert web.get(router.ADMIN_PATH, headers=bearer(MEMBER)).status_code == 403  # 관리자 아님
    assert client("192.168.1.50").get(router.ADMIN_PATH, headers=bearer(ADMIN)).status_code == 403  # 서버 PC 밖
    empty = web.get(router.ADMIN_PATH, headers=bearer(ADMIN))
    assert empty.status_code == 200 and empty.json()["has_key"] is False and empty.json()["state"] == "none"
    assert web.put(router.ADMIN_PATH, json={"api_key": ""}, headers=bearer(ADMIN)).status_code == 400
    assert web.put(router.ADMIN_PATH, json={"api_key": "   "}, headers=bearer(ADMIN)).status_code == 400
    for payload in ({"api_key": "x" * 513}, {"api_key": 12345}, {"nope": "y" * 40}):  # 거절 응답이 입력값을 되돌려 주지 않는다(422 echo 방지)
        rejected = web.put(router.ADMIN_PATH, json=payload, headers=bearer(ADMIN))
        assert rejected.status_code == 400 and "x" * 20 not in rejected.text and "y" * 20 not in rejected.text and "12345" not in rejected.text
    bare = web.put(router.ADMIN_PATH, content=b'"' + b"z" * 600 + b'"', headers={**bearer(ADMIN), "Content-Type": "application/json"})
    assert bare.status_code == 400 and "z" * 20 not in bare.text
    with caplog.at_level(logging.INFO, logger="comfy.team_key"):
        saved = web.put(router.ADMIN_PATH, json={"api_key": KEY}, headers=bearer(ADMIN)).json()
    assert saved["has_key"] is True and saved["revision"] == 1 and saved["updated_by"] == ADMIN and saved["state"] == "ok"
    body = web.get(router.ADMIN_PATH, headers=bearer(ADMIN)).json()
    assert KEY not in json.dumps(body) and "api_key" not in body
    assert KEY not in caplog.text and ADMIN in caplog.text
    assert web.delete(router.ADMIN_PATH, headers=bearer(ADMIN)).json()["has_key"] is False
    assert web.get(router.ADMIN_PATH, headers=bearer(ADMIN)).json()["state"] == "none"


@windows_only
def test_member_endpoint_requires_approved_account_and_never_caches(server, caplog):
    web = client("192.168.1.77")  # 팀원 PC 의 허브가 LAN 으로 묻는다
    assert web.get(router.TEAM_PATH).status_code == 401
    assert web.get(router.TEAM_PATH, headers=bearer(PENDING)).status_code == 401
    assert web.get(router.TEAM_PATH, headers=bearer(MEMBER)).status_code == 404  # 키 없음
    client().put(router.ADMIN_PATH, json={"api_key": KEY}, headers=bearer(ADMIN))
    with caplog.at_level(logging.INFO, logger="comfy.team_key"):
        got = web.get(router.TEAM_PATH, headers=bearer(MEMBER))
    assert got.status_code == 200 and got.headers["cache-control"] == "no-store"
    assert got.json()["api_key"] == KEY and got.json()["revision"] == 1 and got.json()["updated_at"]
    assert MEMBER in caplog.text and KEY not in caplog.text
    repo.set_account_status(MEMBER, "rejected")
    assert web.get(router.TEAM_PATH, headers=bearer(MEMBER)).status_code == 401
    repo.set_account_status(MEMBER, "approved")
    repo.set_setting(svc.SETTING_KEY, json.dumps({"v": 1, "enc": "dpapi-machine", "data": "QUFBQQ==", "revision": 2}))
    assert web.get(router.TEAM_PATH, headers=bearer(MEMBER)).status_code == 409
    assert client().get(router.ADMIN_PATH, headers=bearer(ADMIN)).json()["state"] == "undecryptable"


# ── hub-team-key(캐시) ──────────────────────────────────────────────────────────
def test_hub_fetches_once_per_ttl_and_retries_failures_after_15s(hub):
    hub["answers"] = [ok_body(), (None, b""), (None, b""), ok_body("comfyui-new", 2)]
    assert svc.resolve()["api_key"] == KEY and svc.resolve()["state"] == "available"
    assert len(hub["calls"]) == 1 and hub["calls"][0] == (f"{hub['base']}{svc.TEAM_KEY_PATH}", "tok-A")
    hub["clock"] += svc.TTL_OK_SEC - 1
    svc.resolve()
    assert len(hub["calls"]) == 1  # 60초 안 — 묻지 않는다
    hub["clock"] += 2
    assert svc.resolve()["state"] == "stale" and len(hub["calls"]) == 2  # 통신 장애 — 마지막 키 유지
    hub["clock"] += svc.TTL_FAIL_SEC - 1
    svc.resolve()
    assert len(hub["calls"]) == 2  # 실패 뒤 15초 안 — 묻지 않는다
    hub["clock"] += 2
    assert svc.resolve()["state"] == "stale" and len(hub["calls"]) == 3
    hub["clock"] += svc.TTL_FAIL_SEC + 1
    assert svc.resolve()["api_key"] == "comfyui-new" and len(hub["calls"]) == 4


def test_hub_grace_counts_from_last_success_and_is_not_extended(hub):
    hub["answers"] = [ok_body()] + [(None, b"")] * 10
    svc.resolve()
    hub["clock"] += svc.GRACE_SEC - 5
    assert svc.resolve()["state"] == "stale"
    hub["clock"] += 10  # 실패가 반복돼도 마지막 성공부터 센다
    assert svc.resolve()["state"] == "unreachable" and svc.resolve()["api_key"] is None


@pytest.mark.parametrize("status,state", [(401, "off"), (403, "off"), (404, "none"), (409, "undecryptable")])
def test_hub_discards_the_key_on_server_verdicts(hub, status, state):
    hub["answers"] = [ok_body(), (status, b"{}")]
    assert svc.resolve()["api_key"] == KEY
    hub["clock"] += svc.TTL_OK_SEC + 1
    out = svc.resolve()
    assert out["state"] == state and out["api_key"] is None


def test_hub_keeps_the_key_on_402_and_5xx(hub):
    hub["answers"] = [ok_body(), (402, b"{}"), (503, b"")]
    svc.resolve()
    for _ in range(2):
        hub["clock"] += svc.TTL_OK_SEC + 1
        out = svc.resolve()
        assert out["api_key"] == KEY and out["state"] == "stale"


def test_hub_cache_is_bound_to_the_server_and_token_pair(hub):
    hub["answers"] = [ok_body(), (404, b"{}")]
    assert svc.resolve()["api_key"] == KEY
    hub["token"] = "tok-B"  # 계정 전환
    out = svc.resolve()
    assert out["state"] == "none" and out["api_key"] is None and hub["calls"][-1][1] == "tok-B"
    hub["token"] = "tok-A"  # 다시 돌아와도 옛 칸은 없다 — 새로 받는다
    hub["answers"] = [ok_body("comfyui-again", 3)]
    assert svc.resolve()["api_key"] == "comfyui-again"


def test_hub_drops_a_late_response_from_the_previous_account(hub):
    def late(_url, _token):
        hub["token"] = "tok-B"  # 기다리는 사이 로그아웃·전환
        return ok_body("comfyui-of-A")

    hub["answers"] = [late, (404, b"{}")]
    assert svc.resolve()["state"] == "off" and svc.resolve.__name__ == "resolve"
    out = svc.resolve()  # tok-B 로 새로 묻는다 — A 의 키가 보이면 안 된다
    assert out["api_key"] is None and out["state"] == "none" and hub["calls"][-1][1] == "tok-B"


def test_hub_forgets_the_key_on_logout(hub):
    hub["answers"] = [ok_body(), ok_body("comfyui-after-relogin", 2)]
    assert svc.resolve()["api_key"] == KEY
    hub["token"] = ""  # 로그아웃
    assert svc.resolve()["state"] == "off" and svc.resolve()["api_key"] is None
    hub["token"] = "tok-A"  # 같은 토큰으로 다시 로그인해도 옛 키를 되살리지 않고 새로 받는다
    assert svc.resolve()["api_key"] == "comfyui-after-relogin" and len(hub["calls"]) == 2


def test_hub_merges_concurrent_refreshes_into_one_call(hub):
    gate, inside = threading.Event(), threading.Event()
    ready = threading.Barrier(2, timeout=5)  # 두 요청이 같이 출발한다

    def slow(_url, _token):
        inside.set()  # 첫 요청이 서버를 두드리는 중 — 둘째는 _fetch_lock 에서 기다려야 한다
        gate.wait(5)
        return ok_body()

    hub["answers"] = [slow]
    out: dict[int, dict] = {}
    errors: list[BaseException] = []

    def worker(i: int) -> None:
        try:
            ready.wait()
            out[i] = svc.resolve()
        except BaseException as error:  # noqa: BLE001 — 스레드 안 예외를 시험 실패로
            errors.append(error)

    threads = [threading.Thread(target=worker, args=(i,)) for i in range(2)]
    for t in threads:
        t.start()
    assert inside.wait(5) and len(hub["calls"]) == 1
    gate.set()
    for t in threads:
        t.join(5)
    assert not any(t.is_alive() for t in threads) and not errors
    assert len(out) == 2 and len(hub["calls"]) == 1 and all(v["api_key"] == KEY and v["state"] == "available" for v in out.values())


def test_hub_drops_a_late_thread_answer_after_switching_accounts(hub):
    """A 갱신 대기(실제 스레드가 _fetch_lock 을 쥔 채) → B 로 전환·B 요청 → A 응답 도착: A 는 버려지고 B 는 자기 키를 받는다."""
    gate, started = threading.Event(), threading.Event()

    def slow(_url, token):
        started.set()
        gate.wait(5)
        return ok_body("key-of-" + token)

    hub["answers"] = [slow, ok_body("key-of-tok-B", 2)]
    results: dict[str, dict] = {}
    ta = threading.Thread(target=lambda: results.__setitem__("A", svc.resolve()))
    ta.start()
    assert started.wait(5)
    hub["token"] = "tok-B"
    tb = threading.Thread(target=lambda: results.__setitem__("B", svc.resolve()))
    tb.start()
    time.sleep(0.1)
    assert "B" not in results  # 동시 갱신은 하나 — B 는 A 의 갱신이 끝날 때까지 기다린다
    gate.set()
    ta.join(5)
    tb.join(5)
    assert results["A"]["state"] == "off" and results["A"]["api_key"] is None  # 늦게 온 A 응답은 캐시에 들어가지 않았다
    assert results["B"]["api_key"] == "key-of-tok-B" and [t for _, t in hub["calls"]] == ["tok-A", "tok-B"]


def test_boot_recovery_does_not_ask_the_server(h, hub, monkeypatch):  # noqa: F811
    seen: list[dict] = []
    monkeypatch.setattr(comfy, "_raw_settings", lambda **kw: seen.append(dict(kw)) or ORIGINAL_RAW_SETTINGS(**kw))  # 진짜를 감싸 도달을 본다
    monkeypatch.setattr(comfy, "EXTERNAL_RECOVERY_ENABLED", True)
    repo.set_setting("comfy_key_source", "team")
    row = {"job_id": "old-job", "owner": "a@example.invalid", "device_id": h.device["device_id"], "target_fp": "stale", "prompt_id": "p"}
    monkeypatch.setattr(comfy.run_journal, "bootstrap", lambda owner, auth: [row])
    calls: list = []
    monkeypatch.setattr(svc, "_http_get", lambda *a, **k: calls.append(a) or (None, b""))
    comfy.recover_interrupted_run_jobs()
    assert seen == [{"fetch_team": False}]  # 조기 반환·삼킨 예외가 아니라 설정 읽기까지 실제로 갔다
    assert calls == []  # 부팅 복구는 팀 키 캐시 값만 — 서버에 묻지 않는다


def test_hub_does_not_ask_without_token_or_with_no_proxy(hub, monkeypatch):
    hub["token"] = ""
    assert svc.resolve()["state"] == "off" and not hub["calls"]
    hub["token"] = "tok-A"
    monkeypatch.setenv("CONTENT_HUB_NO_PROXY", "1")
    assert svc.resolve()["state"] == "off" and not hub["calls"]


@windows_only
def test_auth_on_reads_the_same_db_even_with_no_proxy(hub, memory_store, monkeypatch):
    monkeypatch.setattr(svc, "AUTH_ENABLED", True)
    monkeypatch.setenv("CONTENT_HUB_NO_PROXY", "1")
    assert svc.resolve()["state"] == "none"
    svc.save_store(KEY, ADMIN)
    out = svc.resolve()
    assert out["state"] == "available" and out["api_key"] == KEY and not hub["calls"]
    memory_store[svc.SETTING_KEY] = json.dumps({"v": 1, "enc": "dpapi-machine", "data": "QUFBQQ=="})
    assert svc.resolve()["state"] == "undecryptable"


def test_raw_settings_key_source_defaults_and_modes(hub, memory_store):
    hub["answers"] = [ok_body()]
    s = comfy._raw_settings()
    assert s["comfy_key_source"] == "team" and s["comfy_api_key"] == KEY and s["team_key"]["state"] == "available"
    memory_store["comfy_api_key"] = "personal-key"
    svc.forget()
    s = comfy._raw_settings()
    assert s["comfy_key_source"] == "personal" and s["comfy_api_key"] == "personal-key" and s["team_key"] is None
    memory_store["comfy_key_source"] = "team"
    hub["answers"] = [ok_body()]
    s = comfy._raw_settings()
    assert s["comfy_api_key"] == KEY and s["has_personal_key"] is True
    public = comfy.get_settings()
    assert public["comfy_key_source"] == "team" and public["team_key"]["state"] == "available" and public["comfy_api_key"] == "***"
    assert KEY not in json.dumps(public)
    assert comfy.put_settings(comfy.SettingsPatch(comfy_key_source="personal"))["comfy_key_source"] == "personal"
    with pytest.raises(HTTPException) as denied:
        comfy.put_settings(comfy.SettingsPatch(comfy_key_source="nope"))
    assert denied.value.status_code == 400
    assert svc.SETTING_KEY not in memory_store  # 로컬 DB 에 팀 키를 쓰지 않는다


def test_boot_and_parse_use_the_cache_only(hub, memory_store, monkeypatch):
    def forbidden(*_a, **_k):
        raise AssertionError("부팅·파싱이 서버에 물었다")

    monkeypatch.setattr(svc, "_http_get", forbidden)
    assert comfy._raw_settings(fetch_team=False)["comfy_api_key"] == ""
    seen = []
    monkeypatch.setattr(comfy, "_raw_settings", lambda **kw: seen.append(kw) or {"comfy_target": "local", "comfy_url": "http://x", "comfy_api_key": ""})
    monkeypatch.setattr(comfy.comfy_client, "get_object_info", lambda target, **kw: {})
    comfy._enrich_choices([{"class_type": "X", "field": "f", "type": "text", "choices": None}])
    assert seen == [{"fetch_team": False}]


def test_run_refuses_without_a_usable_team_key(h, monkeypatch):  # noqa: F811
    settings = {**h.settings, "comfy_key_source": "team", "comfy_api_key": "", "team_key": {"state": "none", "updated_at": None}}
    monkeypatch.setattr(comfy, "_raw_settings", lambda **_kw: dict(settings))
    with pytest.raises(HTTPException) as refused:
        h.start()
    assert refused.value.status_code == 409 and "팀 키 없음" in refused.value.detail
    h.mocks["submit"].assert_not_called()


def test_run_submits_with_the_team_key(h, monkeypatch):  # noqa: F811
    settings = {**h.settings, "comfy_key_source": "team", "comfy_api_key": "team-k", "team_key": {"state": "stale", "updated_at": None}}
    monkeypatch.setattr(comfy, "_raw_settings", lambda **_kw: dict(settings))
    h.successful()
    h.start()
    h.drain()
    assert h.mocks["submit"].call_args.args[2] == "team-k"


# ── fingerprint-v2 ─────────────────────────────────────────────────────────────
def local(key, base="http://127.0.0.1:8188"):
    return {"comfy_target": "local", "comfy_url": base, "comfy_api_key": key, "comfy_input_dir": "", "comfy_concurrency": 3}


def cloud(key):
    return {"comfy_target": "cloud", "comfy_url": "", "comfy_api_key": key, "comfy_input_dir": "", "comfy_concurrency": 3}


def test_local_fingerprint_ignores_the_key_and_cloud_keeps_it():
    assert comfy._target_fingerprint(local("k1")) == comfy._target_fingerprint(local("k2"))
    assert comfy._target_fingerprint(local("k1")) != comfy._target_fingerprint_v1(local("k1"))
    assert comfy._target_fingerprint(local("k1", "http://127.0.0.1:8188/a")) != comfy._target_fingerprint(local("k1", "http://127.0.0.1:8188/b"))
    assert comfy._target_fingerprint(cloud("k1")) != comfy._target_fingerprint(cloud("k2"))
    assert comfy._target_fingerprint(cloud("k1")) == comfy._target_fingerprint_v1(cloud("k1"))


def test_new_records_carry_the_full_base_and_survive_key_rotation():
    identity = comfy._ComfyIdentity(("a@example.invalid", None), "a@example.invalid", None, "1" * 32, "scope", local("k1", "http://127.0.0.1:8188/a"), False)
    row = comfy._new_run_record("job", identity)
    assert row["target_base"] == "http://127.0.0.1:8188/a" and row["target_fp"] == comfy._target_fingerprint(identity.settings)
    assert comfy._same_target(row, local("k2", "http://127.0.0.1:8188/a"))  # 키 교체 뒤에도 같은 대상
    assert not comfy._same_target(row, local("k2", "http://127.0.0.1:8188/b"))  # 경로만 달라도 다른 대상
    assert not comfy._same_target(row, cloud("k2"))


def test_old_v1_local_records_match_only_with_the_current_key():
    v1 = {"target_fp": comfy._target_fingerprint_v1(local("k1")), "target_kind": "local", "base_host": "127.0.0.1:8188"}
    assert comfy._same_target(v1, local("k1"))
    assert not comfy._same_target(v1, local("k2"))  # 교체 전 v1 의 자동 회수는 보장하지 않는다
    v1_cloud = {"target_fp": comfy._target_fingerprint_v1(cloud("k1")), "target_kind": "cloud"}
    assert comfy._same_target(v1_cloud, cloud("k1")) and not comfy._same_target(v1_cloud, cloud("k2"))

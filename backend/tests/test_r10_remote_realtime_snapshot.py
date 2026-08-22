import asyncio
import json
import threading
import time

from app import active_account
from app import main as app_main
from app.services.remote_realtime import RemoteRealtimeBridge


class _FakeSocket:
    def __init__(self):
        self._sent_event = False

    async def recv(self):
        if not self._sent_event:
            self._sent_event = True
            return json.dumps({"type": "synced"})
        await asyncio.Future()


class _FakeConnection:
    def __init__(self):
        self.socket = _FakeSocket()

    async def __aenter__(self):
        return self.socket

    async def __aexit__(self, exc_type, exc, tb):
        return False


def test_remote_config_snapshot_never_mixes_token_and_url_across_switch(monkeypatch):
    state = {"url": "https://a.test", "token": "token-a"}
    token_read = threading.Event()
    switch_probe_done = threading.Event()
    switch_finished = threading.Event()
    thread_errors = []

    monkeypatch.setattr(app_main._proxy, "is_worker_hub", lambda: True)

    def read_token():
        value = state["token"]
        token_read.set()
        assert switch_probe_done.wait(1), "계정 전환 스레드가 token 읽기 뒤에 도달하지 못했습니다"
        return value

    monkeypatch.setattr(app_main._proxy, "token", read_token)
    monkeypatch.setattr(app_main._proxy, "base_url", lambda: state["url"])

    def switch_account():
        if not token_read.wait(1):
            thread_errors.append("provider가 token을 읽지 않았습니다")
            switch_probe_done.set()
            return

        acquired = active_account.transition_lock.acquire(blocking=False)
        if acquired:
            try:
                state.update(url="https://b.test", token="token-b")
            finally:
                active_account.transition_lock.release()
            switch_probe_done.set()
        else:
            # provider가 스냅샷 lock을 보유한 사실을 먼저 알린 뒤, 해제 후 B로 전환한다.
            switch_probe_done.set()
            with active_account.transition_lock:
                state.update(url="https://b.test", token="token-b")
        switch_finished.set()

    switch_thread = threading.Thread(target=switch_account)
    switch_thread.start()
    first = app_main._remote_realtime_config()
    assert switch_finished.wait(1)
    switch_thread.join(timeout=1)
    second = app_main._remote_realtime_config()

    assert not switch_thread.is_alive()
    assert thread_errors == []
    assert first == ("https://a.test", "token-a")
    assert second == ("https://b.test", "token-b")
    assert {first, second} <= {
        ("https://a.test", "token-a"),
        ("https://b.test", "token-b"),
    }


def test_remote_config_returns_none_immediately_during_transition(monkeypatch):
    lock_held = threading.Event()
    release_lock = threading.Event()
    reads = []

    monkeypatch.setattr(app_main._proxy, "is_worker_hub", lambda: True)
    monkeypatch.setattr(
        app_main._proxy,
        "token",
        lambda: reads.append("token") or "token-a",
    )
    monkeypatch.setattr(
        app_main._proxy,
        "base_url",
        lambda: reads.append("url") or "https://a.test",
    )

    def hold_transition_lock():
        with active_account.transition_lock:
            lock_held.set()
            release_lock.wait(2)

    holder = threading.Thread(target=hold_transition_lock)
    holder.start()
    assert lock_held.wait(1)

    started = time.perf_counter()
    config = app_main._remote_realtime_config()
    elapsed = time.perf_counter() - started

    release_lock.set()
    holder.join(timeout=1)

    assert config is None
    assert elapsed < 0.2
    assert reads == []
    assert not holder.is_alive()


def test_bridge_recovers_on_next_poll_after_transition_none(monkeypatch):
    config = ("https://a.test", "token-a")
    lock_held = threading.Event()
    release_lock = threading.Event()
    first_provider_call = threading.Event()
    provider_results = []
    connect_calls = []

    monkeypatch.setattr(app_main._proxy, "is_worker_hub", lambda: True)
    monkeypatch.setattr(app_main._proxy, "token", lambda: config[1])
    monkeypatch.setattr(app_main._proxy, "base_url", lambda: config[0])

    def hold_transition_lock():
        with active_account.transition_lock:
            lock_held.set()
            release_lock.wait(2)

    holder = threading.Thread(target=hold_transition_lock)
    holder.start()
    assert lock_held.wait(1)

    def config_provider():
        result = app_main._remote_realtime_config()
        provider_results.append(result)
        first_provider_call.set()
        return result

    def connect(uri, **kwargs):
        connect_calls.append((uri, kwargs))
        return _FakeConnection()

    async def scenario():
        delivered = asyncio.Event()
        bridge = RemoteRealtimeBridge(
            config_provider,
            lambda event: delivered.set(),
            connect_factory=connect,
            config_poll_seconds=0.01,
            connected_config_poll_seconds=0.01,
        )
        bridge.start()
        try:
            for _ in range(100):
                if first_provider_call.is_set():
                    break
                await asyncio.sleep(0.005)
            assert first_provider_call.is_set()
            release_lock.set()
            await asyncio.wait_for(delivered.wait(), timeout=1)
        finally:
            await bridge.stop()
        return bridge.stats()

    stats = asyncio.run(scenario())
    release_lock.set()
    holder.join(timeout=1)

    assert provider_results[0] is None
    assert config in provider_results[1:]
    assert len(connect_calls) == 1
    assert connect_calls[0][0] == "wss://a.test/ws"
    assert connect_calls[0][1]["additional_headers"]["Authorization"] == "Bearer token-a"
    assert stats["relayed_events"] == 1
    assert stats["state"] == "stopped"
    assert not holder.is_alive()


def test_remote_config_keeps_account_key_override_priority(monkeypatch):
    monkeypatch.setattr(app_main._proxy, "is_worker_hub", lambda: True)
    monkeypatch.setattr(
        app_main._proxy,
        "token",
        lambda: f"token:{active_account.account_key()}",
    )
    monkeypatch.setattr(
        app_main._proxy,
        "base_url",
        lambda: f"https://{active_account.account_key()}",
    )

    override_token = active_account.set_override("override.test")
    try:
        assert app_main._remote_realtime_config() == (
            "https://override.test",
            "token:override.test",
        )
    finally:
        active_account.reset_override(override_token)

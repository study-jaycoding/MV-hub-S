import asyncio
import json
from types import SimpleNamespace

from app.main import _websocket_session_token
from app.services.remote_realtime import (
    RemoteRealtimeBridge,
    RemoteRealtimeEvent,
    decode_event,
    relay_event,
    websocket_uri,
)


class FakeNotifier:
    def __init__(self):
        self.library = []
        self.domains = []

    def notify_mutation(self, account_uid=None, origin=None, source="local"):
        self.library.append((account_uid, origin, source))

    def notify_domain(self, event_type, origin=None, source="local"):
        self.domains.append((event_type, origin, source))


class FakeSocket:
    def __init__(self, messages):
        self.messages = list(messages)

    async def recv(self):
        if self.messages:
            return self.messages.pop(0)
        await asyncio.Future()


class FakeConnection:
    def __init__(self, socket=None, error=None):
        self.socket = socket
        self.error = error

    async def __aenter__(self):
        if self.error:
            raise self.error
        return self.socket

    async def __aexit__(self, exc_type, exc, tb):
        return False


def test_websocket_uri_never_contains_token_and_preserves_base_path():
    assert websocket_uri("http://server.test:8010") == "ws://server.test:8010/ws"
    assert websocket_uri("https://hub.test/base/") == "wss://hub.test/base/ws"
    assert "secret" not in websocket_uri("https://hub.test")


def test_decode_allows_only_data_less_change_events_and_validates_origins():
    raw = json.dumps(
        {
            "type": "synced",
            "origins": [
                {"client_id": "client_test_123", "mutation_id": "mutation_test_123"}
            ],
        }
    )
    assert decode_event(raw) == RemoteRealtimeEvent(
        "synced", (("client_test_123", "mutation_test_123"),)
    )
    assert decode_event(json.dumps({"type": "progress", "result_url": "secret"})) is None
    assert decode_event(json.dumps({"type": "queued", "id": "private"})) is None
    assert decode_event("not-json") is None

    # 허용된 신호라도 출처가 손상되면 일부만 믿지 않고 안전한 전체 reload로 바꾼다.
    malformed = decode_event(
        json.dumps(
            {
                "type": "assets_changed",
                "origins": [{"client_id": "bad", "mutation_id": "also-bad"}],
            }
        )
    )
    assert malformed == RemoteRealtimeEvent("assets_changed", None)


def test_relay_maps_remote_domains_to_local_manager_contract():
    notifier = FakeNotifier()
    origin = ("client_test_123", "mutation_test_123")
    relay_event(RemoteRealtimeEvent("synced", (origin,)), notifier)
    relay_event(RemoteRealtimeEvent("assets_changed", None), notifier)
    relay_event(RemoteRealtimeEvent("manage_changed", (origin,)), notifier)
    assert notifier.library == [(None, origin, "remote")]
    assert notifier.domains == [
        ("assets_changed", None, "remote"),
        ("manage_changed", origin, "remote"),
    ]


def test_websocket_auth_prefers_bearer_without_putting_token_in_query():
    ws = SimpleNamespace(
        headers={"authorization": "Bearer bridge-token"},
        cookies={"ch_session": "cookie-token"},
        query_params={"token": "query-token"},
    )
    assert _websocket_session_token(ws, "ch_session") == "bridge-token"


def test_bridge_sends_secret_only_in_headers_and_reacts_to_config_change():
    async def scenario():
        current = [("https://hub.test", "test.jwt.token")]
        calls = []
        received = []

        def connect(uri, **kwargs):
            calls.append((uri, kwargs))
            payload = json.dumps({"type": "manage_changed"})
            return FakeConnection(FakeSocket([payload]))

        def handle(event):
            received.append(event)
            current[0] = None

        bridge = RemoteRealtimeBridge(
            lambda: current[0],
            handle,
            connect_factory=connect,
            config_poll_seconds=0.01,
            connected_config_poll_seconds=0.01,
        )
        await bridge._consume(("https://hub.test", "test.jwt.token"))
        return bridge.stats(), calls, received

    stats, calls, received = asyncio.run(scenario())
    uri, kwargs = calls[0]
    assert uri == "wss://hub.test/ws"
    assert "test.jwt.token" not in uri
    assert kwargs["additional_headers"]["Authorization"] == "Bearer test.jwt.token"
    assert kwargs["additional_headers"]["Cookie"] == "ch_session=test.jwt.token"
    assert received == [RemoteRealtimeEvent("manage_changed", None)]
    assert stats["relayed_events"] == 1
    assert stats["connected"] is False


def test_bridge_reconnects_after_failure_and_stop_cleans_task():
    async def scenario():
        current = [("http://hub.test", "token")]
        delivered = asyncio.Event()
        calls = 0

        def connect(uri, **kwargs):
            nonlocal calls
            calls += 1
            if calls == 1:
                return FakeConnection(error=OSError("offline"))
            return FakeConnection(FakeSocket([json.dumps({"type": "synced"})]))

        def handle(event):
            current[0] = None
            delivered.set()

        bridge = RemoteRealtimeBridge(
            lambda: current[0],
            handle,
            connect_factory=connect,
            config_poll_seconds=0.01,
            connected_config_poll_seconds=0.01,
            min_backoff_seconds=0,
            max_backoff_seconds=0,
        )
        bridge.start()
        bridge.start()  # 중복 start가 연결을 두 개 만들면 안 된다.
        await asyncio.wait_for(delivered.wait(), timeout=1)
        await bridge.stop()
        return bridge.stats(), calls

    stats, calls = asyncio.run(scenario())
    assert calls == 2
    assert stats["reconnect_attempts"] == 1
    assert stats["relayed_events"] == 1
    assert stats["state"] == "stopped"
    assert stats["connected"] is False


def test_bridge_does_not_retry_same_token_after_policy_rejection():
    class PolicyRejected(Exception):
        code = 1008

    async def scenario():
        current = [("http://hub.test", "expired-token")]
        delivered = asyncio.Event()
        calls = []

        def connect(uri, **kwargs):
            calls.append(current[0][1])
            if current[0][1] == "expired-token":
                return FakeConnection(error=PolicyRejected())
            return FakeConnection(FakeSocket([json.dumps({"type": "synced"})]))

        def handle(event):
            current[0] = None
            delivered.set()

        bridge = RemoteRealtimeBridge(
            lambda: current[0],
            handle,
            connect_factory=connect,
            config_poll_seconds=0.01,
            connected_config_poll_seconds=0.01,
            min_backoff_seconds=0,
            max_backoff_seconds=0,
        )
        bridge.start()
        await asyncio.sleep(0.06)
        calls_before_login = list(calls)
        state_before_login = bridge.stats()["state"]
        current[0] = ("http://hub.test", "fresh-token")
        await asyncio.wait_for(delivered.wait(), timeout=1)
        await bridge.stop()
        return calls_before_login, state_before_login, calls, bridge.stats()

    calls_before_login, state_before_login, calls, stats = asyncio.run(scenario())
    assert calls_before_login == ["expired-token"]
    assert state_before_login == "auth_required"
    assert calls == ["expired-token", "fresh-token"]
    assert stats["reconnect_attempts"] == 1


def test_bridge_sends_app_level_text_heartbeat(monkeypatch):
    # 서버 유령 수거(90초 무수신 1001)는 텍스트 수신만 살아있음으로 치므로, 브리지는
    # 프로토콜 ping 과 별개로 브라우저와 같은 텍스트 "ping" 하트비트를 보내야 한다.
    from app.services import remote_realtime as rr

    monkeypatch.setattr(rr, "_HEARTBEAT_SECONDS", 0.02)

    async def scenario():
        current = [("https://hub.test", "tok")]
        sent = []

        class HeartbeatSocket(FakeSocket):
            async def send(self, data):
                sent.append(data)
                if len(sent) >= 2:
                    current[0] = None  # 두 번 확인했으면 설정 변경으로 종료시킨다

        def connect(uri, **kwargs):
            return FakeConnection(HeartbeatSocket([]))

        bridge = RemoteRealtimeBridge(
            lambda: current[0],
            lambda event: None,
            connect_factory=connect,
            config_poll_seconds=0.01,
            connected_config_poll_seconds=0.01,
        )
        await bridge._consume(("https://hub.test", "tok"))
        return sent

    sent = asyncio.run(scenario())
    assert len(sent) >= 2
    assert all(message == "ping" for message in sent)

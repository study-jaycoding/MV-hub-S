"""R13-AUTH-1 — 인증 거부의 '원인'을 검증한 그 순간에 확정한다.

R12 는 유지보수 거부를 401 대신 503/1013 으로 바꿨지만, 판정 근거가 **판정 시점의**
maintenance_active() 재표본이었다. 시크릿을 못 읽은 뒤(=검증 불가) 판정 전에 게이트가
내려가면(복원 중단·롤백 직후) 재표본은 False 가 되어 멀쩡한 토큰이 401 로 지워졌다.

계약: verify_token/token_password_stamp 가 '무효'와 '시크릿 사용 불가'를 구분해 돌려주고,
미들웨어·WS 는 그 원인만 보고 분기한다 — 게이트는 두 번 표본하지 않는다.
  · 시크릿 사용 불가 → 게이트가 이미 내려갔어도 503 / 1013 (세션 보존).
  · 진짜 무효 토큰 → 게이트가 올라가 있어도 401 / 1008 (종전 계약).
  · 비번 스탬프 조회(두 번째 서명)에서 처음 막혀도 같은 판정이다.
"""

from __future__ import annotations

import asyncio
from types import SimpleNamespace

import pytest

from app import db
from app.services import auth as auth_svc


_WS_REASON_AUTH_REQUIRED = "authentication required"
EMAIL = "r13-auth@example.com"


@pytest.fixture
def api_client(monkeypatch, tmp_path):
    """AUTH on 으로 본 미들웨어만 통과시키는 임시 DB 클라이언트(R12 계약 테스트와 같은 형태)."""
    monkeypatch.setenv("CONTENT_HUB_DB", str(tmp_path / "content_hub.db"))
    monkeypatch.setenv("CONTENT_HUB_NO_PROXY", "1")
    monkeypatch.delenv("CONTENT_HUB_AUTH_SECRET", raising=False)
    db.flush_pool()
    db.init_db()

    from fastapi.testclient import TestClient

    import app.main as main_module

    monkeypatch.setattr(main_module, "AUTH_ENABLED", True)
    client = TestClient(main_module.app, client=("127.0.0.1", 50000))
    try:
        yield client, main_module
    finally:
        client.close()
        db.flush_pool()


class _FakeWebSocket:
    """websocket_endpoint 가 쓰는 표면만 흉내낸다(accept/close/토큰 소스)."""

    def __init__(self, token: str | None = None) -> None:
        self.headers: dict[str, str] = {}
        self.cookies: dict[str, str] = {"ch_session": token} if token else {}
        self.query_params: dict[str, str] = {}
        self.client = SimpleNamespace(host="127.0.0.1")
        self.accepted = False
        self.closed: tuple[int, str] | None = None

    async def accept(self) -> None:
        self.accepted = True

    async def close(self, code: int = 1000, reason: str = "") -> None:
        self.closed = (code, reason)


def _forbid_gate_sampling(monkeypatch, main_module) -> list[int]:
    """인증 판정이 게이트를 다시 표본하면 즉시 드러나게 센다(호출 자체가 회귀)."""
    calls: list[int] = []

    def counting_maintenance_active() -> bool:
        calls.append(1)
        return False  # ★'게이트는 이미 내려갔다' — 재표본에 의존하면 401 로 오판한다

    monkeypatch.setattr(main_module, "maintenance_active", counting_maintenance_active)
    return calls


def _secret_is_unavailable(monkeypatch) -> None:
    """게이트와 무관하게 '지금 시크릿을 읽을 수 없음'만 재현한다(복원 롤백 직후 상황)."""

    def refuse() -> str:
        raise auth_svc.AuthSecretUnavailable("테스트: 검증 불가")

    monkeypatch.setattr(auth_svc, "get_secret", refuse)


# ── 서비스 계층: 원인 보존 API ────────────────────────────────────────────────
def test_verify_token_reports_the_cause_only_when_asked(monkeypatch):
    """기본 호출은 종전 그대로 None, 표식을 준 호출부만 원인을 돌려받는다."""
    _secret_is_unavailable(monkeypatch)

    assert auth_svc.verify_token("payload.signature") is None  # 기존 계약 불변
    assert (
        auth_svc.verify_token("payload.signature", unavailable=auth_svc.SECRET_UNAVAILABLE)
        is auth_svc.SECRET_UNAVAILABLE
    )
    assert (
        auth_svc.token_password_stamp(
            "payload.signature", unavailable=auth_svc.SECRET_UNAVAILABLE
        )
        is auth_svc.SECRET_UNAVAILABLE
    )


def test_malformed_token_is_invalid_not_unverifiable(monkeypatch):
    """점 없는 토큰은 시크릿과 무관한 형식오류 = 진짜 무효(일시 거부로 뭉개지 않는다)."""
    _secret_is_unavailable(monkeypatch)

    assert (
        auth_svc.verify_token("no-dot-here", unavailable=auth_svc.SECRET_UNAVAILABLE)
        is None
    )


# ── HTTP 미들웨어 ────────────────────────────────────────────────────────────
def test_unverifiable_token_answers_503_even_after_the_gate_dropped(
    api_client, monkeypatch
):
    """★핵심 회귀: 시크릿을 못 읽은 뒤 게이트가 내려가도 503 이다(재표본 의존 제거 증명)."""
    client, main_module = api_client
    gate_calls = _forbid_gate_sampling(monkeypatch, main_module)
    _secret_is_unavailable(monkeypatch)
    client.cookies.set("ch_session", "payload.signature")

    response = client.get("/api/generations")

    assert response.status_code == 503, "게이트 재표본이 아니라 검증 순간의 원인으로 판정"
    assert response.headers.get("Retry-After") == "5"
    assert main_module._proxy.AUTH_STATE_HEADER not in response.headers
    assert gate_calls == [], "판정에 게이트를 다시 표본하면 안 된다"


def test_truly_invalid_token_answers_401_even_while_the_gate_is_up(api_client):
    """진짜 무효 토큰은 게이트와 무관하게 401 — 시크릿이 캐시에 있으면 판정이 가능하다."""
    client, main_module = api_client
    auth_svc.get_secret()  # 캐시 워밍(R11 A1: 게이트 중에도 DB 없이 검증)
    client.cookies.set("ch_session", "payload.deadbeef")

    with db.maintenance_gate():
        response = client.get("/api/generations")

    assert response.status_code == 401
    assert (
        response.headers.get(main_module._proxy.AUTH_STATE_HEADER)
        == main_module._proxy.AUTH_STATE_INVALID
    )


def test_password_stamp_lookup_blocked_mid_request_also_answers_503(
    api_client, monkeypatch
):
    """서명 검증은 통과했는데 스탬프 조회에서 막히면(요청 도중 교체 시작) 401 이 아니라 503."""
    client, main_module = api_client
    gate_calls = _forbid_gate_sampling(monkeypatch, main_module)
    token = auth_svc.make_token(EMAIL, pwd_stamp="2026-01-01T00:00:00")
    secret = auth_svc.get_secret()
    calls = {"n": 0}

    def flaky_secret() -> str:
        calls["n"] += 1
        if calls["n"] > 1:  # 첫 서명(=verify_token)만 통과, 두 번째부터 교체가 시작됐다
            raise auth_svc.AuthSecretUnavailable("테스트: 요청 도중 교체 시작")
        return secret

    monkeypatch.setattr(auth_svc, "get_secret", flaky_secret)
    monkeypatch.setattr(
        main_module.repo,
        "get_account",
        lambda email: {
            "email": email,
            "status": "approved",
            "password_changed_at": "2026-01-01T00:00:00",
        },
    )
    client.cookies.set("ch_session", token)

    response = client.get("/api/generations")

    assert response.status_code == 503, "스탬프만 못 읽은 것을 '비번 바뀐 옛 토큰'으로 보면 안 된다"
    assert gate_calls == []


# ── WebSocket ────────────────────────────────────────────────────────────────
def test_websocket_uses_1013_even_after_the_gate_dropped(api_client, monkeypatch):
    """WS 도 같은 규칙 — 검증 불가면 게이트가 내려간 뒤에도 1013(백오프 재연결)."""
    _client, main_module = api_client
    gate_calls = _forbid_gate_sampling(monkeypatch, main_module)
    _secret_is_unavailable(monkeypatch)
    ws = _FakeWebSocket(token="payload.signature")

    asyncio.run(main_module.websocket_endpoint(ws))

    assert ws.closed == (1013, "maintenance")
    assert gate_calls == []


def test_websocket_keeps_1008_for_a_truly_invalid_token_under_the_gate(api_client):
    """게이트가 올라가 있어도 판정 가능한 무효 토큰은 1008 + 기존 사유 문자열 그대로."""
    _client, main_module = api_client
    auth_svc.get_secret()  # 캐시 워밍 — 게이트 중에도 서명 검증이 된다
    ws = _FakeWebSocket(token="payload.deadbeef")

    with db.maintenance_gate():
        asyncio.run(main_module.websocket_endpoint(ws))

    assert ws.closed == (1008, _WS_REASON_AUTH_REQUIRED)

"""R12-1 — DB 유지보수(파일 교체) 중의 인증 거부는 401 이 아니라 503/1013 이다.

배경: 복원은 auth 시크릿 캐시를 fail-closed 로 닫는다(get_secret). 그래서 게이트가 올라간 몇 초
동안은 **멀쩡한 토큰도** verify_token 이 None 을 돌려준다. 복원이 성공하면 시크릿이 회전하므로
로그아웃이 정답이지만, 드레인 타임아웃 등으로 중단·롤백되면 옛 토큰은 그대로 유효하다 —
그 사이 요청·WS 를 친 브라우저만 401/1008 을 받고 토큰을 지워 팀 전원이 재로그인하게 된다.

계약 3개를 고정한다.
  · 보호 API: 토큰이 있는데 검증 불가 + 유지보수 중 → 503 + Retry-After(세션 보존).
  · 평시 무효 토큰 → 종전 401 + X-MVHub-Auth-State: invalid(그대로).
  · ★핫패스(정상 인증 요청)는 maintenance_active() 를 부르지 않는다
    (R13-AUTH-1 이후엔 인증 경로 전체가 게이트를 표본하지 않는다 — 원인은 검증 순간에 확정).
  · WS: 유지보수 중이면 1013(일시 거부, 백오프 재연결), 평시엔 1008 + 기존 사유 문자열.
"""

from __future__ import annotations

import asyncio
from types import SimpleNamespace

import pytest

from app import db
from app.services import auth as auth_svc


_WS_REASON_AUTH_REQUIRED = "authentication required"  # 프론트가 파싱하는 계약 문자열

# ★형식이 온전한(payload.signature) 토큰이어야 검증이 '서명' 단계까지 가서 시크릿 사용 불가를
# 만난다. 점 없는 문자열은 시크릿과 무관한 형식오류 = 진짜 무효라 유지보수 중에도 401 이 맞다
# (R13-AUTH-1 로 판정 근거가 '게이트 재표본'에서 '검증 순간의 원인'으로 바뀐 뒤의 계약).
_UNVERIFIABLE_TOKEN = "payload.signature"


@pytest.fixture
def api_client(monkeypatch, tmp_path):
    """AUTH on 으로 본 미들웨어만 통과시키는 임시 DB 클라이언트(실제 계정 DB 미사용)."""
    monkeypatch.setenv("CONTENT_HUB_DB", str(tmp_path / "content_hub.db"))
    monkeypatch.setenv("CONTENT_HUB_NO_PROXY", "1")
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


# ── HTTP 미들웨어 ────────────────────────────────────────────────────────────
def test_protected_api_during_maintenance_answers_503_with_retry_after(api_client):
    """게이트가 올라간 동안의 보호 API 요청은 세션을 지키는 503 이다."""
    client, main_module = api_client
    client.cookies.set("ch_session", _UNVERIFIABLE_TOKEN)

    with db.maintenance_gate():
        response = client.get("/api/generations")

    assert response.status_code == 503
    assert response.headers.get("Retry-After") == "5"
    # 토큰 삭제 트리거(401 + invalid 헤더)가 절대 나가면 안 된다.
    assert main_module._proxy.AUTH_STATE_HEADER not in response.headers


def test_invalid_token_without_maintenance_still_answers_401(api_client):
    """평시의 무효 토큰은 종전 그대로 401 + invalid — 로그아웃 계약 불변."""
    client, main_module = api_client
    client.cookies.set("ch_session", "definitely-invalid")

    response = client.get("/api/generations")

    assert response.status_code == 401
    assert (
        response.headers.get(main_module._proxy.AUTH_STATE_HEADER)
        == main_module._proxy.AUTH_STATE_INVALID
    )


def test_no_token_during_maintenance_still_answers_401(api_client):
    """토큰조차 없는 요청은 유지보수와 무관한 '미로그인'이다 — 503 으로 뭉개지 않는다."""
    client, _main_module = api_client

    with db.maintenance_gate():
        response = client.get("/api/generations")

    assert response.status_code == 401


def test_authenticated_hot_path_never_calls_maintenance_active(api_client, monkeypatch):
    """★정상 요청 경로에는 게이트 확인(락 획득)이 추가되지 않는다.

    R13-AUTH-1 이후 인증 경로는 게이트를 아예 표본하지 않는다(원인은 검증 순간에 확정) —
    핫패스에 락이 끼지 않는다는 이 계약은 그대로 유지되고 더 강해졌다."""
    client, main_module = api_client
    calls: list[int] = []

    def counting_maintenance_active() -> bool:
        calls.append(1)
        return False

    monkeypatch.setattr(main_module, "maintenance_active", counting_maintenance_active)
    monkeypatch.setattr(
        main_module.auth_svc, "verify_token", lambda token, **_kw: "u@x.com"
    )
    monkeypatch.setattr(
        main_module.repo,
        "get_account",
        lambda email: {"email": email, "status": "approved"},
    )
    client.cookies.set("ch_session", "tok")

    response = client.get("/api/health")

    assert response.status_code == 200
    assert calls == [], "인증에 성공한 요청은 유지보수 상태를 조회하지 않아야 한다"


# ── WebSocket ────────────────────────────────────────────────────────────────
def test_websocket_rejected_during_maintenance_uses_1013(api_client):
    """유지보수 중 WS 거부는 일시 거부(1013) — 프론트는 재로그인 대신 백오프 재연결."""
    _client, main_module = api_client
    ws = _FakeWebSocket(token=_UNVERIFIABLE_TOKEN)

    with db.maintenance_gate():
        asyncio.run(main_module.websocket_endpoint(ws))

    assert ws.accepted is True
    assert ws.closed == (1013, "maintenance")


def test_websocket_rejected_normally_keeps_1008_reason_contract(api_client):
    """평시 무효 토큰은 1008 + 기존 사유 문자열 그대로(프론트 파싱 계약 불변)."""
    _client, main_module = api_client
    ws = _FakeWebSocket(token="definitely-invalid")

    asyncio.run(main_module.websocket_endpoint(ws))

    assert ws.closed == (1008, _WS_REASON_AUTH_REQUIRED)


# ── 근본 원인(왜 'token 있고 email 없음'이 유지보수 서명인가) ────────────────
def test_signing_secret_is_fail_closed_while_the_gate_is_up(monkeypatch):
    """게이트 중에는 시크릿을 못 읽어 모든 토큰 검증이 None 이 된다 — 오탐 401 의 출처."""
    monkeypatch.delenv("CONTENT_HUB_AUTH_SECRET", raising=False)
    monkeypatch.setattr(auth_svc, "_secret_cache", None)

    with db.maintenance_gate():
        with pytest.raises(auth_svc.AuthSecretUnavailable):
            auth_svc.get_secret()
        assert auth_svc.verify_token("payload.signature") is None

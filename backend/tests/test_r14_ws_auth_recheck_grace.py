"""R14 P2-5 — WS 주기 재검증(45초)의 '시크릿 사용 불가' 유예 분기.

연결 시점 인증만으로는 정지·비번 리셋이 열린 소켓에 반영되지 않아 45초마다 재검증한다.
그 재검증의 두 번째 서명(token_password_stamp)이 DB 교체 중이면 '판정 불가'로 돌아온다 —
이때 소켓을 끊으면 멀쩡한 세션이 교체·롤백 때마다 재로그인으로 튕긴다(R13-AUTH-1 과 같은
원인 보존 규칙). 계약: 판정 불가면 끊지 않고 다음 주기로 유예하되, 사면이 아니다 —
시크릿이 돌아오면 그 주기에 정상 판정이 재개되고, 계정 정지는 유예와 무관하게 즉시 끊는다.

★결정적 실행: 주기를 벽시계로 기다리지 않는다. _WS_AUTH_RECHECK_SECONDS=0 으로 두면
수신 루프의 매 반복이 곧 한 재검증 주기라, '몇 번째 주기'가 대본대로 재현된다.
"""

from __future__ import annotations

import asyncio
from types import SimpleNamespace

import pytest
from starlette.websockets import WebSocketDisconnect

import app.main as main_module
from app.services import auth as auth_svc


EMAIL = "r14-ws@example.com"
PCAT = "2026-08-23T00:00:00"  # 계정에 기록된 비번 변경 시각 = 토큰 스탬프의 정답
ROTATED = "2026-08-23T09:00:00"  # 그 뒤 비번이 바뀐 상태(=옛 토큰)
_AUTH_REQUIRED = (1008, "authentication required")


class _ScriptedWebSocket:
    """websocket_endpoint 가 쓰는 표면만 흉내내는 소켓(test_r13_auth_cause_preserving 과 같은 방식).

    receive_text() 가 즉시 하트비트를 돌려주므로 루프가 대본 횟수만큼 정확히 돈다.
    대본이 끝나면 WebSocketDisconnect — 브라우저가 정상 종료한 것과 같다."""

    def __init__(self, token: str, rounds: int) -> None:
        self.headers: dict[str, str] = {}
        self.cookies = {"ch_session": token}
        self.query_params: dict[str, str] = {}
        self.client = SimpleNamespace(host="127.0.0.1")
        self.accepted = False
        self.closed: tuple[int, str] | None = None
        self.rounds_left = rounds

    async def accept(self) -> None:
        self.accepted = True

    async def close(self, code: int = 1000, reason: str = "") -> None:
        self.closed = (code, reason)

    async def receive_text(self) -> str:
        if self.rounds_left <= 0:
            raise WebSocketDisconnect(1000)
        self.rounds_left -= 1
        return "ping"


@pytest.fixture
def ws_auth(monkeypatch):
    """AUTH on · 매 반복이 재검증 주기 · DB 접근은 전부 대역으로 대체한 WS 환경."""
    monkeypatch.setattr(main_module, "AUTH_ENABLED", True)
    monkeypatch.setattr(main_module, "_WS_AUTH_RECHECK_SECONDS", 0.0)
    monkeypatch.setattr(main_module, "_WS_GHOST_SECONDS", 10_000.0)
    monkeypatch.setattr(auth_svc, "verify_token", lambda _token, **_kw: EMAIL)
    return monkeypatch


def _account_source(monkeypatch, statuses: list[str], calls: list[str]):
    """재검증마다 다음 status 를 돌려준다(마지막 값은 계속 반복). 호출 순서를 calls 에 남긴다."""

    def get_account(email):
        calls.append(email)
        status = statuses[min(len(calls) - 1, len(statuses) - 1)]
        return {"email": email, "status": status, "password_changed_at": PCAT}

    monkeypatch.setattr(main_module.repo, "get_account", get_account)


def _stamp_source(monkeypatch, script: list, seen: list):
    """대본대로 스탬프를 돌려준다. 원소가 UNAVAILABLE 이면 그 주기는 '판정 불가'다."""

    def token_password_stamp(_token, *, unavailable=None):
        value = script[min(len(seen), len(script) - 1)]
        seen.append(value)
        return unavailable if value is _UNAVAILABLE else value

    monkeypatch.setattr(auth_svc, "token_password_stamp", token_password_stamp)


_UNAVAILABLE = object()  # 대본 안에서 '시크릿 사용 불가'를 뜻하는 표식


def test_recheck_defers_while_the_secret_is_unavailable(ws_auth):
    """판정 불가가 이어지는 동안 소켓은 끊기지 않고 주기마다 다시 본다."""
    accounts: list[str] = []
    stamps: list = []
    _account_source(ws_auth, ["approved"], accounts)
    # 최초 수락은 정상 판정(스탬프 일치), 그 뒤 3주기 내내 판정 불가.
    _stamp_source(ws_auth, [PCAT, _UNAVAILABLE], stamps)
    ws = _ScriptedWebSocket("payload.signature", rounds=3)

    asyncio.run(main_module.websocket_endpoint(ws))

    assert ws.accepted
    assert ws.closed is None, "판정 불가는 인증 실패가 아니다 — 끊지 않고 다음 주기로 유예"
    # 1(수락) + 3(재검증) — 끊었다면 재검증이 더 돌지 않아 호출 수가 모자란다.
    assert len(accounts) == 4 and len(stamps) == 4
    assert stamps[1:] == [_UNAVAILABLE, _UNAVAILABLE, _UNAVAILABLE]


def test_recheck_resumes_normal_verdict_once_the_secret_returns(ws_auth):
    """유예는 사면이 아니다 — 시크릿이 돌아온 주기에 옛 토큰이 정상 판정으로 끊긴다."""
    accounts: list[str] = []
    stamps: list = []
    _account_source(ws_auth, ["approved"], accounts)
    # 수락 → 2주기 판정 불가(유예) → 시크릿 복귀, 스탬프가 안 맞음(비번 바뀐 옛 토큰).
    _stamp_source(ws_auth, [PCAT, _UNAVAILABLE, _UNAVAILABLE, ROTATED], stamps)
    ws = _ScriptedWebSocket("payload.signature", rounds=10)

    asyncio.run(main_module.websocket_endpoint(ws))

    assert ws.closed == _AUTH_REQUIRED, "복귀 후엔 최초 거부와 같은 사유로 끊는다"
    assert stamps == [PCAT, _UNAVAILABLE, _UNAVAILABLE, ROTATED]
    assert ws.rounds_left == 7, "판정이 선 주기에서 바로 끊긴다(대본이 남아도 더 돌지 않음)"


def test_recheck_keeps_the_socket_when_the_secret_returns_matching(ws_auth):
    """복귀 판정이 '일치'면 그대로 유지된다 — 유예 뒤 정상 판정 재개의 통과 쪽."""
    accounts: list[str] = []
    stamps: list = []
    _account_source(ws_auth, ["approved"], accounts)
    _stamp_source(ws_auth, [PCAT, _UNAVAILABLE, PCAT], stamps)
    ws = _ScriptedWebSocket("payload.signature", rounds=3)

    asyncio.run(main_module.websocket_endpoint(ws))

    assert ws.closed is None
    assert stamps == [PCAT, _UNAVAILABLE, PCAT, PCAT]


def test_suspended_account_still_closes_during_the_grace_window(ws_auth):
    """유예 대상은 스탬프 '판정 불가'뿐 — 정지된 계정은 그 창 안에서도 즉시 끊는다."""
    accounts: list[str] = []
    stamps: list = []
    _account_source(ws_auth, ["approved", "approved", "rejected"], accounts)
    _stamp_source(ws_auth, [PCAT, _UNAVAILABLE], stamps)
    ws = _ScriptedWebSocket("payload.signature", rounds=10)

    asyncio.run(main_module.websocket_endpoint(ws))

    assert ws.closed == _AUTH_REQUIRED
    assert len(accounts) == 3  # 수락 + 유예 1주기 + 정지 확인
    assert stamps == [PCAT, _UNAVAILABLE], "정지 판정은 스탬프를 보기 전에 끝난다"


def test_recheck_expires_token_for_legacy_account_without_password_stamp(ws_auth):
    """password_changed_at=NULL 계정도 열린 소켓의 토큰 만료를 놓치지 않는다."""
    verdict_calls = 0

    def verify_token(_token, *, unavailable=None):
        nonlocal verdict_calls
        verdict_calls += 1
        return EMAIL if verdict_calls == 1 else None

    ws_auth.setattr(auth_svc, "verify_token", verify_token)
    ws_auth.setattr(
        main_module.repo,
        "get_account",
        lambda email: {
            "email": email,
            "status": "approved",
            "password_changed_at": None,
        },
    )
    ws_auth.setattr(
        auth_svc,
        "token_password_stamp",
        lambda *_args, **_kwargs: pytest.fail("NULL 계정은 비밀번호 스탬프를 조회하지 않는다"),
    )
    ws = _ScriptedWebSocket("payload.signature", rounds=10)

    asyncio.run(main_module.websocket_endpoint(ws))

    assert ws.closed == _AUTH_REQUIRED
    assert verdict_calls == 2  # 최초 수락 + 첫 주기 재검증
    assert ws.rounds_left == 9

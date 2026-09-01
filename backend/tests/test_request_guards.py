"""로컬 전용 가드의 브라우저 문맥 검사 — CSRF·DNS 리바인딩 방어 계약.

require_local_machine_request 는 접속 IP 만으로는 브라우저 경유 공격을 못 막는다:
악성 페이지가 127.0.0.1 로 폼 POST 를 보내면 출발지가 loopback 이고(CSRF),
공격자 도메인을 로컬 IP 로 재해석하면 Host 에만 흔적이 남는다(DNS 리바인딩).
Host·Sec-Fetch-Site·Origin·Referer 까지 로컬 머신인지 검사하는 계약을 고정한다.
"""

from __future__ import annotations

import pytest
from fastapi import HTTPException
from starlette.requests import Request

from app.services import request_guards as rg


def _request(host: str = "127.0.0.1", headers: dict[str, str] | None = None) -> Request:
    encoded = [
        (k.lower().encode(), v.encode("latin-1")) for k, v in (headers or {}).items()
    ]
    return Request(
        {"type": "http", "method": "POST", "path": "/", "headers": encoded, "client": (host, 5000)}
    )


@pytest.fixture(autouse=True)
def _fixed_local_hosts(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setattr(
        rg,
        "local_machine_hosts",
        lambda: frozenset({"127.0.0.1", "192.168.10.5", "desktop-x"}),
    )


def _local_ok(headers: dict[str, str]) -> None:
    rg.require_local_machine_request(_request(headers=headers), "no")


def _local_403(headers: dict[str, str], host: str = "127.0.0.1") -> None:
    with pytest.raises(HTTPException) as exc:
        rg.require_local_machine_request(_request(host, headers), "no")
    assert exc.value.status_code == 403


def test_non_browser_clients_without_context_headers_pass():
    _local_ok({})  # curl·urllib·Resolve 스크립트 — Host 조차 없는 요청
    _local_ok({"host": "127.0.0.1:8010"})  # urllib 기본형


def test_local_host_header_forms_pass():
    for host in ("localhost:8010", "127.0.0.1:8010", "192.168.10.5:8010", "DESKTOP-X:8010"):
        _local_ok({"host": host})


def test_dns_rebinding_host_header_is_rejected():
    _local_403({"host": "attacker.example:8010"})
    _local_403({"host": "attacker.example"})


def test_malformed_host_headers_are_rejected():
    for host in ("127.0.0.1/evil", "a@127.0.0.1", "127.0.0.1:99999", "127.0.0.1:80?x", "evil\\path"):
        _local_403({"host": host})


def test_cross_site_form_post_origins_are_rejected():
    _local_403({"host": "127.0.0.1:8010", "origin": "https://evil.example"})
    _local_403({"host": "127.0.0.1:8010", "origin": "null"})  # 샌드박스 iframe
    _local_403({"host": "127.0.0.1:8010", "origin": "file:///C:/x.html"})


def test_same_origin_browser_requests_pass():
    _local_ok(
        {
            "host": "127.0.0.1:8010",
            "origin": "http://127.0.0.1:8010",
            "sec-fetch-site": "same-origin",
            "referer": "http://127.0.0.1:8010/app",
        }
    )
    _local_ok({"host": "192.168.10.5:8010", "origin": "http://192.168.10.5:8010"})


def test_sec_fetch_site_cross_site_is_rejected_even_without_origin():
    _local_403({"host": "127.0.0.1:8010", "sec-fetch-site": "cross-site"})


def test_foreign_referer_is_rejected():
    _local_403({"host": "127.0.0.1:8010", "referer": "https://evil.example/attack.html"})


def test_remote_client_ip_is_still_rejected_first():
    _local_403({}, host="192.168.1.50")


def test_loopback_browser_guard_requires_loopback_origin_not_just_local():
    ok = _request(headers={"host": "127.0.0.1:8010", "origin": "http://localhost:8010"})
    rg.require_loopback_browser_request(ok, "no")
    lan_origin = _request(
        headers={"host": "127.0.0.1:8010", "origin": "http://192.168.10.5:8010"}
    )
    with pytest.raises(HTTPException):  # 같은 머신 IP 여도 loopback 가드는 더 엄격
        rg.require_loopback_browser_request(lan_origin, "no")


def test_duplicate_security_headers_are_rejected_as_ambiguous():
    """같은 헤더 2회는 정상 브라우저가 만들지 않는다 — 첫 값만 보고 통과시키지 않는다."""
    scope_headers = [
        (b"host", b"127.0.0.1:8010"),
        (b"origin", b"http://127.0.0.1:8010"),
        (b"origin", b"https://evil.example"),
    ]
    request = Request(
        {"type": "http", "method": "POST", "path": "/", "headers": scope_headers, "client": ("127.0.0.1", 5000)}
    )
    with pytest.raises(HTTPException) as exc:
        rg.require_local_machine_request(request, "no")
    assert exc.value.status_code == 403


def test_origin_with_path_is_rejected_but_referer_path_is_fine():
    _local_403({"host": "127.0.0.1:8010", "origin": "http://127.0.0.1:8010/path"})
    _local_ok({"host": "127.0.0.1:8010", "referer": "http://127.0.0.1:8010/deep/path?q=1"})


def test_authority_and_origin_parsers_reject_ambiguous_forms():
    assert rg._authority_hostname("127.0.0.1:8010") == "127.0.0.1"
    assert rg._authority_hostname("[::1]:8010") == "::1"
    assert rg._authority_hostname("host/path") == ""
    assert rg._authority_hostname("a@b") == ""
    assert rg._authority_hostname("h#f") == ""
    assert rg._authority_hostname("bad port:80a") == ""
    assert rg._origin_hostname("http://127.0.0.1:8010") == "127.0.0.1"
    assert rg._origin_hostname("null") == ""
    assert rg._origin_hostname("chrome-extension://abc") == ""
    assert rg._origin_hostname("http://user@evil") == ""

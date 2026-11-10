from decimal import Decimal
import urllib.request
import urllib.parse

import pytest

from app.services import hf_org_usage_client as client
from app.services.hf_org_usage_key import UsageError
from hf_org_usage_fake import FAKE_KEY, ORG, api_error, fake_server, report_page, wire_row

START = 1793491200000  # 2026-11-01T00:00:00Z
END = START + 86_400_000


@pytest.mark.parametrize("value,expected", [("1.25", 125), ("-0.01", -1), (0, 0), (Decimal("12.00"), 1200),
                                          ("92233720368547758.07", 2**63-1)])
def test_exact_cents(value, expected):
    assert client.parse_cents(value) == expected


@pytest.mark.parametrize("value", [True, 1.25, "NaN", "Infinity", "0.001", "92233720368547758.08", "1e100", "1e-999999999", None])
def test_invalid_amount_is_fixed_error(value):
    with pytest.raises(UsageError, match="^invalid_amount$"):
        client.parse_cents(value)


@pytest.mark.parametrize("status,expected", [(401,"http_401"), (403,"http_403"), (410,"http_410"), (429,"http_429"), (503,"http_503")])
def test_error_body_never_escapes(status, expected):
    with fake_server([(status, {"Retry-After": "2"}, {"error": FAKE_KEY})]) as (url, _):
        with pytest.raises(UsageError) as caught:
            client._request_json(urllib.request.Request(url), FAKE_KEY)
        assert str(caught.value) == expected
        assert FAKE_KEY not in str(caught.value)


def test_no_redirect_and_oversize(monkeypatch):
    with fake_server([(302, {"Location": "http://127.0.0.1:1/forbidden"}, {})]) as (url, _):
        with pytest.raises(UsageError, match="redirect_refused"):
            client._request_json(urllib.request.Request(url), FAKE_KEY)
    monkeypatch.setattr(client, "MAX_RESPONSE_BYTES", 32)
    with fake_server([(200, {}, b" " * 33)]) as (url, _):
        with pytest.raises(UsageError, match="response_too_large"):
            client._request_json(urllib.request.Request(url), FAKE_KEY)


def test_success_response_cannot_echo_key():
    with fake_server([(200, {}, {"message": FAKE_KEY})]) as (url, _):
        with pytest.raises(UsageError, match="invalid_response"):
            client._request_json(urllib.request.Request(url), FAKE_KEY)


def test_official_envelope_header_pagination_and_metadata_allowlist(monkeypatch):
    cursor = "opaque + / ? &=page"
    replies = [(200, {}, report_page(START, END, [], next_page=cursor)),
               (200, {}, report_page(START, END, [wire_row()]))]
    with fake_server(replies, organization=True) as (url, calls):
        monkeypatch.setattr(client, "ENDPOINT", url)
        first = client.fetch_page(FAKE_KEY, START, END, expected_org=ORG)
        assert first["rows"] == [] and first["next_cursor"] == cursor
        second = client.fetch_page(FAKE_KEY, START, END, first["next_cursor"], expected_org=ORG)
        assert second["next_cursor"] is None
        queries = [urllib.parse.parse_qs(urllib.parse.urlsplit(call).query) for call in calls]
        assert queries[0] == dict(starting_at=["2026-11-01T00:00:00.000Z"], ending_at=["2026-11-02T00:00:00.000Z"], limit=["1000"])
        assert queries[1] == dict(queries[0], page=[cursor])
    normalized = second["rows"][0]
    assert (normalized["credits_c"], normalized["charged_c"], normalized["refunded_c"]) == (15,800,785)
    assert normalized["actor_email"] == "fixture@example.test"
    assert normalized["state"] == "future_state" and normalized["surface"] == "future_surface"
    assert normalized["error_code"] == "future_error" and normalized["output_type"] == "future_output"
    assert not {"parameters", "projects", "name", "error_message", "chat_id", "client_name", "cli_version"} & normalized.keys()


@pytest.mark.parametrize("kind", ["generation", "charge", "future_type"])
def test_zero_unknown_types_and_nullable_optional_fields(kind):
    normalized = client.normalize_row(wire_row(type=kind, credits="0", credits_charged="8.00", credits_refunded="8.00",
                    actor=None, source=None, error=None, generation_id=None), start=START, end=END)
    assert normalized["type"] == kind and normalized["credits_c"] == 0
    assert normalized["actor_user_id"] is None and normalized["surface"] is None


@pytest.mark.parametrize("change", [{"id": None}, {"type": ""}, {"type": 3}, {"credits": "0.001"},
                                    {"created_at": "2026-11-01T00:00:00"}, {"created_at": "2026-11-02T00:00:00Z"}])
def test_broken_core_row_fails_whole_page(monkeypatch, change):
    with fake_server([(200, {}, report_page(START, END, [wire_row(**change)]))], organization=True) as (url, _):
        monkeypatch.setattr(client, "ENDPOINT", url)
        with pytest.raises(UsageError):
            client.fetch_page(FAKE_KEY, START, END)


@pytest.mark.parametrize("change,code", [({"has_more": True, "next_page": None}, "invalid_pagination"),
    ({"has_more": False, "next_page": "extra"}, "invalid_pagination"), ({"has_more": 1}, "invalid_pagination"),
    ({"starting_at": "2026-11-01T00:00:00.000001Z"}, "response_range_mismatch"),
    ({"ending_at": "2026-11-03T00:00:00Z"}, "response_range_mismatch"),
    ({"organization_id": "bad"}, "invalid_organization"),
    ({"organization_id": "00000000-0000-0000-0000-000000000099"}, "organization_conflict")])
def test_invalid_page_metadata_is_not_published(monkeypatch, change, code):
    payload = dict(report_page(START, END), **change)
    with fake_server([(200, {}, payload)], organization=True) as (url, _):
        monkeypatch.setattr(client, "ENDPOINT", url)
        with pytest.raises(UsageError, match=code):
            client.fetch_page(FAKE_KEY, START, END, expected_org=ORG)


@pytest.mark.parametrize("status,code,expected", [(500,"report_limit_exceeded","report_limit_exceeded"),
    (500,"internal_error","http_5xx"), (504,"timeout","http_5xx"), (503,"overloaded","http_503"),
    (400,"invalid_page","invalid_page"), (400,"unknown_future_error","http_error")])
def test_official_error_envelope_codes_only(monkeypatch, status, code, expected):
    with fake_server([(status, {"Retry-After": "7"}, api_error(code, message=FAKE_KEY))], organization=True) as (url, _):
        monkeypatch.setattr(client, "ENDPOINT", url)
        with pytest.raises(UsageError) as caught:
            client.fetch_page(FAKE_KEY, START, END)
        safe = str(caught.value)
        assert safe == expected
        assert caught.value.retry_after == (7000 if status == 503 else 0)


def test_non_json_error_is_fixed_and_bad_range_never_calls(monkeypatch):
    with fake_server([(500, {}, b"not json")], organization=True) as (url, calls):
        monkeypatch.setattr(client, "ENDPOINT", url)
        with pytest.raises(UsageError, match="http_5xx"):
            client.fetch_page(FAKE_KEY, START, END)
        for start, end in ((client.DATA_START_MS-1, client.DATA_START_MS+1), (START, START+32*86400000)):
            with pytest.raises(UsageError, match="invalid_range"):
                client.fetch_page(FAKE_KEY, start, end)
        assert len(calls) == 1

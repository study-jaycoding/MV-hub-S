"""Bounded organization Usage API transport. No raw response or exception is propagated."""
from __future__ import annotations

import json
import re
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from datetime import datetime, timezone
from decimal import Decimal, InvalidOperation, localcontext
from email.utils import parsedate_to_datetime

from .hf_org_usage_key import UsageError

ENDPOINT = "https://fnf-api-gw.higgsfield.ai/fnf/v1/organization/generation_usage_report"
MAX_RESPONSE_BYTES = 8_000_000
HTTP_SECONDS = 25
DATA_START_MS = int(datetime(2026, 2, 1, tzinfo=timezone.utc).timestamp()) * 1000
_RFC3339 = re.compile(r"[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]{1,6})?(?:Z|[+-][0-9]{2}:[0-9]{2})\Z")


def fetch_page(key: str, start: int, end: int, cursor=None, *, expected_org=None, limit=1000) -> dict:
    if (type(start) is not int or type(end) is not int or start < DATA_START_MS
            or not start < end <= start + 31 * 86_400_000 or start > time.time_ns() // 1_000_000
            or type(limit) is not int or not 1 <= limit <= 1000):
        raise UsageError("invalid_range")
    if not isinstance(key, str) or not key or any(ord(c) < 33 or ord(c) > 126 for c in key):
        raise UsageError("invalid_key")
    query = {"starting_at": iso_ms(start), "ending_at": iso_ms(end), "limit": limit}
    if cursor is not None:
        if not isinstance(cursor, str) or not cursor:
            raise UsageError("invalid_cursor")
        query["page"] = cursor
    request = urllib.request.Request(ENDPOINT + "?" + urllib.parse.urlencode(query), headers={
        "x-api-key": key, "User-Agent": "mvhub-org-usage/1.0", "Accept": "application/json"}, method="GET")
    payload = _request_json(request, key)
    org_id = payload.get("organization_id")
    try:
        if not isinstance(org_id, str) or len(org_id) != 36:
            raise ValueError()
        org_id = str(uuid.UUID(org_id))
    except ValueError:
        raise UsageError("invalid_organization") from None
    if expected_org is not None and org_id != expected_org:
        raise UsageError("organization_conflict")
    if (timestamp_us(payload.get("starting_at")) != start * 1000
            or timestamp_us(payload.get("ending_at")) != end * 1000):
        raise UsageError("response_range_mismatch")
    timestamp_us(payload.get("generated_at"))
    more, cursor = payload.get("has_more"), payload.get("next_page")
    if (type(more) is not bool or "next_page" not in payload
            or (more and (not isinstance(cursor, str) or not cursor)) or (not more and cursor is not None)):
        raise UsageError("invalid_pagination")
    data = payload.get("data")
    if not isinstance(data, list) or len(data) > limit:
        raise UsageError("invalid_response")
    rows = [normalize_row(row, start=start, end=end) for row in data]
    if len({row["row_id"] for row in rows}) != len(rows):
        raise UsageError("duplicate_row")
    return dict(org_id=org_id, rows=rows, next_cursor=cursor, actual_start_ms=start, actual_end_ms=end)


def normalize_row(value, *, start: int, end: int) -> dict:
    if not isinstance(value, dict) or any(not isinstance(value.get(key), str) or not value[key].strip() for key in ("id", "type")):
        raise UsageError("invalid_row")
    created = timestamp_us(value.get("created_at"))
    if created % 1000 or not start * 1000 <= created < end * 1000:
        raise UsageError("row_outside_window")
    result = dict(row_id=value["id"], type=value["type"], created_at=created // 1000)
    for source, target in (("credits", "credits_c"), ("credits_charged", "charged_c"), ("credits_refunded", "refunded_c")):
        result[target] = parse_cents(value.get(source))
    # Optional metadata is allowlisted; unknown string values are preserved, never enum-rejected.
    for field in ("workspace_id", "workspace_name", "model", "model_name", "status", "state",
                  "generation_id", "original_generation_id", "output_type"):
        result[field] = value.get(field) if isinstance(value.get(field), str) else None
    actor = value.get("actor") if isinstance(value.get("actor"), dict) else {}
    error = value.get("error") if isinstance(value.get("error"), dict) else {}
    source = value.get("source") if isinstance(value.get("source"), dict) else {}
    for container, field, target in ((actor, "user_id", "actor_user_id"), (actor, "email_address", "actor_email"),
                                     (error, "code", "error_code"), (source, "surface", "surface")):
        result[target] = container.get(field) if isinstance(container.get(field), str) else None
    return result


def parse_cents(value) -> int:
    if isinstance(value, (bool, float)) or not isinstance(value, (str, int, Decimal)):
        raise UsageError("invalid_amount")
    try:
        text = str(value)
        if len(text) > 128:
            raise ValueError()
        decimal = Decimal(text)
        if not decimal.is_finite():
            raise ValueError()
        if decimal == 0:
            return 0
        if not -2 <= decimal.adjusted() <= 16:
            raise ValueError()  # Reject extremes before Decimal's context could underflow to zero.
        with localcontext() as context:
            context.prec = 140
            amount = decimal * 100
            if not amount.is_finite() or amount != amount.to_integral_value() or abs(amount) > 2**63 - 1:
                raise ValueError()
            return int(amount)
    except (ValueError, InvalidOperation, OverflowError):
        raise UsageError("invalid_amount") from None


def timestamp_us(value) -> int:
    if not isinstance(value, str) or not _RFC3339.fullmatch(value):
        raise UsageError("invalid_timestamp")
    try:
        dt = datetime.fromisoformat(value.replace("Z", "+00:00"))
        if dt.tzinfo is None:
            raise ValueError()
        delta = dt.astimezone(timezone.utc) - datetime(1970, 1, 1, tzinfo=timezone.utc)
        return delta.days * 86_400_000_000 + delta.seconds * 1_000_000 + delta.microseconds
    except (ValueError, OverflowError):
        raise UsageError("invalid_timestamp") from None


def timestamp_ms(value) -> int:
    return timestamp_us(value) // 1000


def iso_ms(value: int) -> str:
    return datetime.fromtimestamp(value // 1000, timezone.utc).replace(microsecond=(value % 1000) * 1000).isoformat(timespec="milliseconds").replace("+00:00", "Z")


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise UsageError("redirect_refused")


def retry_delay(value: str | None) -> int:
    try:
        if value is not None and value.isascii() and value.isdecimal():
            return max(1000, min(int(value), 86_400) * 1000)
        target = parsedate_to_datetime(value or "")
        return max(1000, min(86_400_000, int((target - datetime.now(timezone.utc)).total_seconds() * 1000)))
    except (ValueError, TypeError, OverflowError):
        return 60_000


def _contains_key(value, key: str) -> bool:
    if isinstance(value, str):
        return key in value
    if isinstance(value, list):
        return any(_contains_key(item, key) for item in value)
    if isinstance(value, dict):
        return any(_contains_key(k, key) or _contains_key(v, key) for k, v in value.items())
    return False


def _request_json(request, key: str) -> dict:
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), _NoRedirect())
    started = time.monotonic()
    try:
        with opener.open(request, timeout=HTTP_SECONDS) as response:
            payload = json.loads(_read_bytes(response, started, MAX_RESPONSE_BYTES), parse_float=Decimal,
                                 parse_constant=lambda _: (_ for _ in ()).throw(ValueError()))
            if not isinstance(payload, dict) or _contains_key(payload, key):
                raise UsageError("invalid_response")
            return payload
    except urllib.error.HTTPError as exc:
        code = exc.code
        retry = retry_delay(exc.headers.get("Retry-After")) if code in (429, 503) else 0
        safe_code = _error_code(exc, started)
        exc.close()
        if code == 500 and safe_code == "report_limit_exceeded":
            result = "report_limit_exceeded"
        elif code == 400:
            result = safe_code or "http_error"
        elif code in (401, 403, 410, 429, 503):
            result = f"http_{code}"
        else:
            result = "http_5xx" if 500 <= code <= 599 else "http_error"
        raise UsageError(result, retry_after=retry) from None
    except UsageError:
        raise
    except TimeoutError:
        raise UsageError("http_timeout") from None
    except (OSError, urllib.error.URLError):
        raise UsageError("http_unavailable") from None
    except Exception:
        raise UsageError("invalid_response") from None


def _read_bytes(response, started: float, cap: int) -> bytes:
    chunks, size = [], 0
    while True:
        remaining = HTTP_SECONDS - (time.monotonic() - started)
        if remaining <= 0:
            raise UsageError("http_timeout")
        # HTTPError wraps HTTPResponse; the latter owns the socket and buffered stream.
        stream = response.fp if isinstance(response, urllib.error.HTTPError) else response
        if stream.isclosed():
            break
        stream.fp.raw._sock.settimeout(remaining)
        chunk = stream.read1(min(65536, cap + 1 - size))
        size += len(chunk)
        if size > cap:
            raise UsageError("response_too_large")
        if time.monotonic() - started > HTTP_SECONDS:
            raise UsageError("http_timeout")
        if not chunk:
            break
        chunks.append(chunk)
    return b"".join(chunks)


def _error_code(response, started: float) -> str | None:
    # Read only to distinguish report-limit from retryable 500. Never return message/param/request_id.
    allowed = {"invalid_parameter", "missing_parameter", "unknown_parameter", "duplicate_parameter",
               "invalid_range", "before_data_start", "invalid_page", "api_key_in_url", "report_limit_exceeded"}
    try:
        payload = json.loads(_read_bytes(response, started, 65536))
        error = payload.get("error") if isinstance(payload, dict) and payload.get("type") == "error" else None
        code = error.get("code") if isinstance(error, dict) else None
        return code if isinstance(code, str) and code in allowed else None
    except Exception:
        return None

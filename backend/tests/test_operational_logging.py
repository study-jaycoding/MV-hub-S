from __future__ import annotations

import json
import logging

from app.services.operational_logging import JsonLineFormatter, log_event


def _record(message: str, fields: dict | None = None) -> logging.LogRecord:
    record = logging.LogRecord("test", logging.INFO, __file__, 1, message, (), None)
    if fields is not None:
        record.event_fields = fields
    return record


def test_formatter_adds_correlation_fields_and_redacts_sensitive_values():
    formatter = JsonLineFormatter()
    payload = json.loads(
        formatter.format(
            _record(
                "login person@example.com Bearer abc.def.ghi from https://private.example/item",
                {
                    "event": "auth_test",
                    "token": "top-secret",
                    "nested": {"password": "pw", "owner": "person@example.com"},
                    "url": "https://example.test/callback?token=secret&ok=1",
                    "result_url": "https://cdn.example.test/result",
                    "prompt": "private generation description",
                },
            )
        )
    )

    assert payload["run_id"]
    assert payload["pid"] > 0
    assert payload["service"] == "mvhub-backend"
    serialized = json.dumps(payload)
    assert "person@example.com" not in serialized
    assert "top-secret" not in serialized
    assert '"pw"' not in serialized
    assert "abc.def.ghi" not in serialized
    assert "token=secret" not in serialized
    assert "private.example" not in serialized
    assert "cdn.example.test" not in serialized
    assert "private generation description" not in serialized
    assert payload["token"] == "<redacted>"


def test_log_event_uses_requested_severity(caplog):
    logger = logging.getLogger("test.operational")
    with caplog.at_level(logging.WARNING, logger=logger.name):
        log_event(logger, "warning_event", level=logging.WARNING, count=2)

    assert len(caplog.records) == 1
    assert caplog.records[0].levelno == logging.WARNING
    assert caplog.records[0].event_fields == {"event": "warning_event", "count": 2}


def test_event_fields_cannot_override_log_identity_fields():
    payload = json.loads(
        JsonLineFormatter().format(
            _record(
                "real-message",
                {"event": "identity_test", "level": "FAKE", "run_id": "fake", "pid": -1},
            )
        )
    )
    assert payload["level"] == "INFO"
    assert payload["run_id"] != "fake"
    assert payload["pid"] > 0

"""운영용 JSON 회전 로그."""

from __future__ import annotations

import json
import logging
import os
from datetime import datetime, timezone
from logging.handlers import RotatingFileHandler
from pathlib import Path
from typing import Any

from ..config import DATA_DIR

_HANDLER_MARK = "_mvhub_operational_handler"


class JsonLineFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        payload: dict[str, Any] = {
            "ts": datetime.now(timezone.utc).isoformat(),
            "level": record.levelname,
            "logger": record.name,
            "message": record.getMessage(),
        }
        fields = getattr(record, "event_fields", None)
        if isinstance(fields, dict):
            payload.update(fields)
        if record.exc_info:
            payload["exception"] = self.formatException(record.exc_info)
        return json.dumps(payload, ensure_ascii=False, default=str)


def configure_operational_logging() -> Path:
    log_dir = Path(os.environ.get("CONTENT_HUB_LOG_DIR", DATA_DIR / "logs")).resolve()
    log_dir.mkdir(parents=True, exist_ok=True)
    path = log_dir / "mvhub-runtime.jsonl"
    root = logging.getLogger()
    if not any(getattr(handler, _HANDLER_MARK, False) for handler in root.handlers):
        handler = RotatingFileHandler(
            path,
            maxBytes=int(os.environ.get("CONTENT_HUB_LOG_MAX_BYTES", str(10 * 1024 * 1024))),
            backupCount=int(os.environ.get("CONTENT_HUB_LOG_KEEP", "5")),
            encoding="utf-8",
        )
        setattr(handler, _HANDLER_MARK, True)
        handler.setFormatter(JsonLineFormatter())
        root.addHandler(handler)
        root.setLevel(logging.INFO)
    return path


def log_event(logger: logging.Logger, event: str, **fields: Any) -> None:
    logger.info(event, extra={"event_fields": {"event": event, **fields}})


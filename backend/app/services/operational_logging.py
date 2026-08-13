"""운영용 JSON 회전 로그."""

from __future__ import annotations

import json
import logging
import os
import re
import uuid
from datetime import datetime, timezone
from logging.handlers import RotatingFileHandler
from pathlib import Path
from typing import Any

from ..config import DATA_DIR

_HANDLER_MARK = "_mvhub_operational_handler"
_RUN_ID = uuid.uuid4().hex[:12]
_SENSITIVE_KEYS = {
    "authorization",
    "cookie",
    "password",
    "prompt",
    "secret",
    "session",
    "session_token",
    "token",
    "url",
}
_EMAIL_RE = re.compile(r"(?i)\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b")
_BEARER_RE = re.compile(r"(?i)\bBearer\s+[A-Za-z0-9._~+/=-]+")
_URL_RE = re.compile(r"(?i)\b(?:https?|wss?|ftp)://[^\s<>\"']+")
_QUERY_SECRET_RE = re.compile(
    r"(?i)([?&](?:access_token|api_key|key|password|secret|token)=)[^&#\s]+"
)
_RESERVED_FIELDS = {"ts", "level", "logger", "service", "run_id", "pid", "message"}


def _redact(value: Any, *, key: str = "") -> Any:
    """운영 로그에서 인증정보·개인 식별정보를 제거한다.

    호출부가 실수로 원문을 넘겨도 공통 formatter가 마지막 방어선이 된다.
    """
    normalized_key = key.lower().replace("-", "_")
    if normalized_key in _SENSITIVE_KEYS or normalized_key.endswith(
        ("_token", "_password", "_prompt", "_url")
    ):
        return "<redacted>"
    if isinstance(value, dict):
        return {str(k): _redact(v, key=str(k)) for k, v in value.items()}
    if isinstance(value, (list, tuple, set)):
        return [_redact(item) for item in value]
    if isinstance(value, str):
        text = _BEARER_RE.sub("Bearer <redacted>", value)
        text = _QUERY_SECRET_RE.sub(r"\1<redacted>", text)
        text = _EMAIL_RE.sub("<email>", text)
        text = _URL_RE.sub("<url>", text)
        # 예외 메시지나 외부 응답이 통째로 들어와 로그 파일이 비대해지는 것도 방지한다.
        return text if len(text) <= 2000 else f"{text[:2000]}…<truncated>"
    return value


class JsonLineFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        payload: dict[str, Any] = {
            "ts": datetime.now(timezone.utc).isoformat(),
            "level": record.levelname,
            "logger": record.name,
            "service": os.environ.get("CONTENT_HUB_SERVICE_NAME", "mvhub-backend"),
            "run_id": _RUN_ID,
            "pid": os.getpid(),
            "message": _redact(record.getMessage()),
        }
        fields = getattr(record, "event_fields", None)
        if isinstance(fields, dict):
            payload.update(
                _redact({key: value for key, value in fields.items() if key not in _RESERVED_FIELDS})
            )
        if record.exc_info:
            payload["exception"] = _redact(self.formatException(record.exc_info))
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


def log_event(
    logger: logging.Logger,
    event: str,
    *,
    level: int = logging.INFO,
    exc_info: Any = None,
    **fields: Any,
) -> None:
    """구조화 이벤트 기록. 일반 상태=INFO, 이상 징후=WARNING, 장애=ERROR로 구분한다."""
    logger.log(
        level,
        event,
        extra={"event_fields": {"event": event, **fields}},
        exc_info=exc_info,
    )

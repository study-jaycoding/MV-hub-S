"""장기 보관용 생성 상태 이력·감사 기록.

회전 JSON 로그는 현장 확인용이고, 이 테이블은 장애가 지난 뒤에도 흐름을 재구성하기 위한
append-only 기록이다. 사용자 콘텐츠(프롬프트·결과 URL)와 인증정보는 받지도 저장하지도 않는다.
"""

from __future__ import annotations

import hashlib
import json
import re
from typing import Any, Optional

from ..db import get_connection
from ._common import new_id

_SENSITIVE_PARTS = ("authorization", "cookie", "email", "password", "prompt", "secret", "token", "url")
_EMAIL_RE = re.compile(r"(?i)\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b")
_URL_RE = re.compile(r"(?i)\b(?:https?|ftp)://\S+")
_CODE_RE = re.compile(r"^[A-Za-z0-9_.: -]{1,200}$")


def safe_identity(value: Optional[str]) -> Optional[str]:
    """creator uid는 그대로, 이메일 기반 임시 uid는 복구 불가능한 짧은 지문으로 보관한다."""
    text = str(value or "").strip()
    if not text:
        return None
    if "@" in text or _URL_RE.search(text):
        digest = hashlib.sha256(text.lower().encode("utf-8")).hexdigest()[:20]
        return f"account:{digest}"
    return text[:200]


def account_target(email: str) -> str:
    """감사 기록에서 계정 이메일 원문 대신 사용할 안정 지문."""
    return safe_identity(email) or "account:unknown"


def _safe_code(value: Any) -> Optional[str]:
    text = str(value or "").strip()
    if not text or not _CODE_RE.fullmatch(text) or text.lower().startswith(("http:", "https:")):
        return None
    return text


def _safe_scalar(value: Any) -> Any:
    if isinstance(value, bool) or value is None or isinstance(value, (int, float)):
        return value
    # 감사 details는 의도적으로 한 단계의 작은 메타만 허용한다. 중첩 객체를 문자열로
    # 바꾸면 그 안의 password/prompt 같은 키를 공통 필터가 놓칠 수 있으므로 저장하지 않는다.
    if isinstance(value, (dict, list, tuple, set)):
        return "<redacted>"
    text = str(value)
    if _EMAIL_RE.search(text) or _URL_RE.search(text):
        return "<redacted>"
    return text[:200]


def _safe_details(details: Optional[dict[str, Any]]) -> dict[str, Any]:
    """감사 세부정보를 작은 허용형 데이터로 제한하고 민감 키·원문을 제거한다."""
    clean: dict[str, Any] = {}
    for raw_key, raw_value in (details or {}).items():
        key = str(raw_key)[:80]
        normalized = key.lower().replace("-", "_")
        if any(part in normalized for part in _SENSITIVE_PARTS):
            clean[key] = "<redacted>"
            continue
        if isinstance(raw_value, (list, tuple, set)):
            clean[key] = [_safe_scalar(item) for item in list(raw_value)[:50]]
        else:
            clean[key] = _safe_scalar(raw_value)
    return clean


def record_generation_event(
    generation_id: str,
    event: str,
    *,
    request_id: Optional[str] = None,
    job_id: Optional[str] = None,
    from_phase: Optional[str] = None,
    to_phase: Optional[str] = None,
    provider_status: Optional[str] = None,
    reason_code: Optional[str] = None,
    actor_uid: Optional[str] = None,
) -> str:
    event_id = new_id()
    with get_connection() as conn:
        conn.execute(
            "INSERT INTO generation_event"
            "(id,generation_id,request_id,job_id,event,from_phase,to_phase,"
            "provider_status,reason_code,actor_uid) VALUES(?,?,?,?,?,?,?,?,?,?)",
            (
                event_id,
                str(generation_id),
                request_id,
                _safe_code(job_id),
                _safe_code(event) or "unrecognized_event",
                _safe_code(from_phase),
                _safe_code(to_phase),
                _safe_code(provider_status),
                _safe_code(reason_code),
                safe_identity(actor_uid),
            ),
        )
    return event_id


def list_generation_events(
    *, generation_id: Optional[str] = None, request_id: Optional[str] = None, limit: int = 200
) -> list[dict[str, Any]]:
    where: list[str] = []
    args: list[Any] = []
    if generation_id:
        where.append("generation_id=?")
        args.append(generation_id)
    if request_id:
        where.append("request_id=?")
        args.append(request_id)
    sql = "SELECT * FROM generation_event"
    if where:
        sql += " WHERE " + " AND ".join(where)
    sql += " ORDER BY created_at DESC, id DESC LIMIT ?"
    args.append(max(1, min(int(limit), 1000)))
    with get_connection() as conn:
        return [dict(row) for row in conn.execute(sql, args).fetchall()]


def record_audit_event(
    action: str,
    *,
    actor_uid: Optional[str],
    target_type: str,
    target_id: Optional[str] = None,
    project_id: Optional[str] = None,
    fields: Optional[list[str]] = None,
    details: Optional[dict[str, Any]] = None,
) -> str:
    event_id = new_id()
    safe_fields = sorted({str(field)[:80] for field in (fields or []) if field})[:100]
    with get_connection() as conn:
        conn.execute(
            "INSERT INTO audit_event"
            "(id,action,actor_uid,target_type,target_id,project_id,fields,details) "
            "VALUES(?,?,?,?,?,?,?,?)",
            (
                event_id,
                str(action)[:100],
                safe_identity(actor_uid),
                str(target_type)[:80],
                safe_identity(target_id),
                safe_identity(project_id),
                json.dumps(safe_fields, ensure_ascii=False),
                json.dumps(_safe_details(details), ensure_ascii=False),
            ),
        )
    return event_id


def list_audit_events(*, project_id: Optional[str] = None, limit: int = 200) -> list[dict[str, Any]]:
    sql = "SELECT * FROM audit_event"
    args: list[Any] = []
    if project_id:
        sql += " WHERE project_id=?"
        args.append(project_id)
    sql += " ORDER BY created_at DESC, id DESC LIMIT ?"
    args.append(max(1, min(int(limit), 1000)))
    with get_connection() as conn:
        rows = [dict(row) for row in conn.execute(sql, args).fetchall()]
    for row in rows:
        for key, fallback in (("fields", []), ("details", {})):
            try:
                row[key] = json.loads(row[key])
            except (TypeError, ValueError):
                row[key] = fallback
    return rows

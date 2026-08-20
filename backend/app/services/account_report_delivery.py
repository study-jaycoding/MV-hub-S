"""계정 상태·크레딧 거래 outbox의 원격 전송과 정산."""

from __future__ import annotations

import json
from typing import Any, Callable

from fastapi import HTTPException

from ..repo import manage as repo_manage


def _error_text(exc: BaseException) -> str:
    if isinstance(exc, HTTPException):
        detail = exc.detail
        if isinstance(detail, str) and detail.strip():
            return detail.strip()
    text = str(exc).strip()
    return text or type(exc).__name__


def _decode_row(row: dict[str, Any]) -> dict[str, Any] | None:
    try:
        payload = json.loads(row.get("payload_json") or "")
    except (TypeError, ValueError):
        return None
    return payload if isinstance(payload, dict) else None


def drain_remote_account_reports(
    push: Callable[[dict[str, Any]], Any],
    *,
    creator_uid: str | None,
    limit: int = 100,
) -> dict[str, Any]:
    """전송 가능한 보고를 행별로 보내고 명시적 ACK를 받은 revision만 성공 처리한다."""
    rows = repo_manage.list_due_account_reports(limit)
    if not rows:
        return {"target": "remote", "pushed": 0, "failed": 0}

    valid_items: list[tuple[dict[str, Any], dict[str, Any]]] = []
    invalid_rows: list[dict[str, Any]] = []
    status_payload: dict[str, Any] | None = None
    for row in rows:
        payload = _decode_row(row)
        report_type = row.get("report_type")
        if payload is None or report_type not in {"status", "transaction"}:
            invalid_rows.append(row)
            continue
        valid_items.append((row, payload))
        if report_type == "status":
            status_payload = payload

    valid_rows = [row for row, _payload in valid_items]

    if invalid_rows:
        repo_manage.mark_account_reports_dead_lettered(
            invalid_rows, "invalid queued report payload"
        )

    # 상태 행이 이미 성공한 뒤 거래만 남은 경우에도 최신 상태를 신원 검증 문맥으로 함께 보낸다.
    if status_payload is None:
        status_payload = repo_manage.latest_account_status_payload()
    reported_email = str((status_payload or {}).get("email") or "").strip()
    if not valid_rows:
        return {
            "target": "remote",
            "pushed": 0,
            "failed": len(invalid_rows),
            "error": "invalid queued report payload",
        }
    if not reported_email:
        error = "account status email unavailable"
        repo_manage.mark_account_reports_failed(valid_rows, error)
        return {
            "target": "remote",
            "pushed": 0,
            "failed": len(valid_rows) + len(invalid_rows),
            "error": error,
        }

    pushed = 0
    failed = len(invalid_rows)
    last_error: str | None = None
    for row, payload in valid_items:
        transaction_payloads = (
            [payload] if row.get("report_type") == "transaction" else []
        )
        try:
            response = push(
                {
                    "account_status": status_payload,
                    "account_transactions": transaction_payloads,
                    "creator_uid": creator_uid,
                }
            )
            if not isinstance(response, dict) or response.get("accepted") is not True:
                raise RuntimeError("account report server acknowledgement missing")
            pushed += repo_manage.mark_account_reports_pushed([row])
        except Exception as exc:  # noqa: BLE001 - 실패한 행만 다음 주기에 재시도
            last_error = _error_text(exc)
            repo_manage.mark_account_reports_failed([row], last_error)
            failed += 1

    result = {"target": "remote", "pushed": pushed, "failed": failed}
    if last_error:
        result["error"] = last_error
    return result

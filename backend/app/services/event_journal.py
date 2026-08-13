"""핵심 업무를 막지 않는 장기 이력 기록 어댑터."""

from __future__ import annotations

import logging
from typing import Any

from ..repo import event_journal as journal_repo
from .operational_logging import log_event

_log = logging.getLogger("mvhub.journal")


def journal_generation_event(event: str, generation_id: str, **fields: Any) -> bool:
    try:
        journal_repo.record_generation_event(generation_id, event, **fields)
        return True
    except Exception:  # noqa: BLE001 — 관측 저장 실패가 생성 자체를 실패시키면 안 된다.
        log_event(
            _log,
            "generation_journal_write_failed",
            level=logging.ERROR,
            generation_id=generation_id,
            journal_event=event,
            exc_info=True,
        )
        return False


def journal_audit_event(action: str, **fields: Any) -> bool:
    try:
        journal_repo.record_audit_event(action, **fields)
    except Exception:  # noqa: BLE001 — 변경은 이미 성공했으므로 감사 실패를 별도 장애로 크게 남긴다.
        log_event(
            _log,
            "audit_journal_write_failed",
            level=logging.ERROR,
            audit_action=action,
            target_type=fields.get("target_type"),
            project_id=journal_repo.safe_identity(fields.get("project_id")),
            exc_info=True,
        )
        return False
    log_event(
        _log,
        "audit_change",
        audit_action=action,
        target_type=fields.get("target_type"),
        target_id=journal_repo.safe_identity(fields.get("target_id")),
        project_id=journal_repo.safe_identity(fields.get("project_id")),
        changed_fields=fields.get("fields") or [],
    )
    return True

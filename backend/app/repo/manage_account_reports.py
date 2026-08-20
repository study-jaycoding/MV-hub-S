"""계정 상태·크레딧 거래 보고의 내구성 outbox.

생성물 텔레메트리와 성공 판정은 분리하되 같은 계정 DB와 백그라운드 실행기를 사용한다.
상태는 최신 스냅샷 한 건, 거래는 내용 해시별 한 건으로 보존한다.
"""

from __future__ import annotations

import hashlib
import json
from typing import Any, Optional

from ..db import get_connection
from .manage_schema import _ensure_schema

_STATUS_KEY = "status"


def _payload_json(payload: dict[str, Any]) -> str:
    return json.dumps(
        payload,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
        allow_nan=False,
    )


def _queue_row(
    conn,
    report_key: str,
    report_type: str,
    payload: dict[str, Any],
) -> int:
    serialized = _payload_json(payload)
    payload_hash = hashlib.sha256(serialized.encode("utf-8")).hexdigest()
    cursor = conn.execute(
        "INSERT INTO account_report_outbox"
        "(report_key, report_type, payload_json, payload_hash) VALUES(?,?,?,?) "
        "ON CONFLICT(report_key) DO UPDATE SET "
        "report_type=excluded.report_type, payload_json=excluded.payload_json, "
        "payload_hash=excluded.payload_hash, "
        "dirty_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'), "
        "dirty_rev=account_report_outbox.dirty_rev+1, pushed_at=NULL, "
        "last_error=NULL, fail_streak=0, next_retry_at=NULL, dead_lettered_at=NULL "
        "WHERE account_report_outbox.payload_hash<>excluded.payload_hash",
        (report_key, report_type, serialized, payload_hash),
    )
    return max(0, int(cursor.rowcount or 0))


def _transaction_key(transaction: dict[str, Any]) -> str:
    # 서버 credit_txn의 멱등 기준과 같은 네 필드를 쓴다. model 같은 보강값은 같은 거래의
    # 새 revision으로 반영해야지 별도 거래로 늘어나면 안 된다.
    identity = {
        "created_at": transaction.get("created_at"),
        "credits": transaction.get("credits"),
        "action": transaction.get("action"),
        "display_name": transaction.get("display_name"),
    }
    serialized = _payload_json(identity)
    return "transaction:" + hashlib.sha256(serialized.encode("utf-8")).hexdigest()


def queue_account_reports(
    account_status: Optional[dict[str, Any]],
    transactions: Optional[list[dict[str, Any]]],
) -> dict[str, int]:
    """최신 계정 상태와 고유 거래를 네트워크 호출 전에 내구성 큐에 기록한다.

    같은 상태·거래가 반복 보고되면 기존 성공/실패 상태를 건드리지 않는다. 특히 실패한 행의
    백오프가 에이전트 주기 보고마다 초기화되지 않게 하는 것이 중요하다.
    """
    queued_status = 0
    queued_transactions = 0
    with get_connection() as conn:
        _ensure_schema(conn)
        conn.execute("BEGIN IMMEDIATE")
        try:
            if isinstance(account_status, dict) and account_status:
                queued_status = _queue_row(
                    conn, _STATUS_KEY, "status", account_status
                )
            for transaction in transactions or []:
                if not isinstance(transaction, dict) or not transaction:
                    continue
                queued_transactions += _queue_row(
                    conn, _transaction_key(transaction), "transaction", transaction
                )
            conn.execute("COMMIT")
        except Exception:
            conn.execute("ROLLBACK")
            raise
    return {
        "status": queued_status,
        "transactions": queued_transactions,
    }


def list_due_account_reports(limit: int = 100) -> list[dict[str, Any]]:
    """재시도 시각이 된 미전송 보고를 오래된 순서로 반환한다."""
    with get_connection() as conn:
        _ensure_schema(conn)
        rows = conn.execute(
            "SELECT report_key, report_type, payload_json, dirty_at, dirty_rev, fail_streak "
            "FROM account_report_outbox WHERE pushed_at IS NULL "
            "AND dead_lettered_at IS NULL "
            "AND (next_retry_at IS NULL OR "
            "next_retry_at<=strftime('%Y-%m-%dT%H:%M:%fZ','now')) "
            "ORDER BY dirty_at ASC LIMIT ?",
            (max(1, int(limit)),),
        ).fetchall()
    return [dict(row) for row in rows]


def latest_account_status_payload() -> Optional[dict[str, Any]]:
    """거래만 재시도할 때도 서버가 보고 계정을 검증할 수 있도록 최신 상태를 읽는다."""
    with get_connection() as conn:
        _ensure_schema(conn)
        row = conn.execute(
            "SELECT payload_json FROM account_report_outbox "
            "WHERE report_key=? AND dead_lettered_at IS NULL",
            (_STATUS_KEY,),
        ).fetchone()
    if not row:
        return None
    try:
        payload = json.loads(row["payload_json"])
    except (TypeError, ValueError):
        return None
    return payload if isinstance(payload, dict) else None


def mark_account_reports_pushed(items: list[dict[str, Any]]) -> int:
    """전송한 스냅샷과 현재 revision이 같을 때만 성공 처리한다."""
    updated_count = 0
    with get_connection() as conn:
        _ensure_schema(conn)
        for item in items or []:
            report_key = item.get("report_key")
            dirty_rev = item.get("dirty_rev")
            if not report_key or dirty_rev is None:
                continue
            cursor = conn.execute(
                "UPDATE account_report_outbox SET "
                "pushed_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'), "
                "attempts=attempts+1, last_error=NULL, fail_streak=0, next_retry_at=NULL "
                "WHERE report_key=? AND dirty_rev=? AND pushed_at IS NULL "
                "AND dead_lettered_at IS NULL",
                (report_key, dirty_rev),
            )
            updated_count += max(0, int(cursor.rowcount or 0))
        if updated_count:
            conn.execute(
                "INSERT INTO account_report_delivery_state(id, last_success_at) "
                "VALUES(1, strftime('%Y-%m-%dT%H:%M:%fZ','now')) "
                "ON CONFLICT(id) DO UPDATE SET last_success_at=excluded.last_success_at"
            )
    return updated_count


def mark_account_reports_failed(items: list[dict[str, Any]], error: str) -> int:
    """현재 revision에만 실패와 제곱 백오프를 적용한다."""
    updated_count = 0
    with get_connection() as conn:
        _ensure_schema(conn)
        for item in items or []:
            report_key = item.get("report_key")
            dirty_rev = item.get("dirty_rev")
            if not report_key or dirty_rev is None:
                continue
            cursor = conn.execute(
                "UPDATE account_report_outbox SET attempts=attempts+1, last_error=?, "
                "fail_streak=fail_streak+1, "
                "next_retry_at=strftime('%Y-%m-%dT%H:%M:%fZ','now', "
                "printf('+%d seconds', MIN(3600, 60*(fail_streak+1)*(fail_streak+1)))) "
                "WHERE report_key=? AND dirty_rev=? AND pushed_at IS NULL "
                "AND dead_lettered_at IS NULL",
                (str(error)[:500], report_key, dirty_rev),
            )
            updated_count += max(0, int(cursor.rowcount or 0))
    return updated_count


def mark_account_reports_conflicted(
    items: list[dict[str, Any]], error: str, *, dead_letter_after: int
) -> int:
    """같은 revision의 반복 409를 행별로 세고 임계치에 닿은 행만 격리한다."""
    updated_count = 0
    threshold = max(1, int(dead_letter_after))
    with get_connection() as conn:
        _ensure_schema(conn)
        for item in items or []:
            report_key = item.get("report_key")
            dirty_rev = item.get("dirty_rev")
            if not report_key or dirty_rev is None:
                continue
            cursor = conn.execute(
                "UPDATE account_report_outbox SET attempts=attempts+1, last_error=?, "
                "fail_streak=fail_streak+1, "
                "next_retry_at=CASE WHEN fail_streak+1>=? THEN NULL ELSE "
                "strftime('%Y-%m-%dT%H:%M:%fZ','now', "
                "printf('+%d seconds', MIN(3600, 60*(fail_streak+1)*(fail_streak+1)))) END, "
                "dead_lettered_at=CASE WHEN fail_streak+1>=? "
                "THEN strftime('%Y-%m-%dT%H:%M:%fZ','now') ELSE NULL END "
                "WHERE report_key=? AND dirty_rev=? AND pushed_at IS NULL "
                "AND dead_lettered_at IS NULL",
                (str(error)[:500], threshold, threshold, report_key, dirty_rev),
            )
            updated_count += max(0, int(cursor.rowcount or 0))
    return updated_count


def mark_account_reports_dead_lettered(
    items: list[dict[str, Any]], error: str
) -> int:
    """현재 revision의 로컬 영구 오류를 삭제하지 않고 재시도 대상에서 격리한다."""
    updated_count = 0
    with get_connection() as conn:
        _ensure_schema(conn)
        for item in items or []:
            report_key = item.get("report_key")
            dirty_rev = item.get("dirty_rev")
            if not report_key or dirty_rev is None:
                continue
            cursor = conn.execute(
                "UPDATE account_report_outbox SET attempts=attempts+1, last_error=?, "
                "fail_streak=fail_streak+1, next_retry_at=NULL, "
                "dead_lettered_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') "
                "WHERE report_key=? AND dirty_rev=? AND pushed_at IS NULL "
                "AND dead_lettered_at IS NULL",
                (str(error)[:500], report_key, dirty_rev),
            )
            updated_count += max(0, int(cursor.rowcount or 0))
    return updated_count


def account_report_outbox_status() -> dict[str, Any]:
    """스키마 생성 없이 계정 보고 큐 상태를 읽는다."""
    empty = {
        "account_report_pending": 0,
        "account_report_failed": 0,
        "account_report_dead": 0,
        "account_report_last_error": None,
        "account_report_oldest_dirty": None,
        "account_report_last_success_at": None,
    }
    with get_connection() as conn:
        table_exists = conn.execute(
            "SELECT 1 FROM sqlite_master "
            "WHERE type='table' AND name='account_report_outbox'"
        ).fetchone()
        if not table_exists:
            return empty
        columns = {
            item[1] for item in conn.execute("PRAGMA table_info(account_report_outbox)")
        }
        # 관측 API는 스키마를 만들지 않는다. 아직 write 경로가 새 컬럼을 보장하지 않은 구 DB도
        # 읽을 수 있도록 없는 컬럼은 dead-letter 0건으로 취급한다.
        active_sql = "dead_lettered_at IS NULL" if "dead_lettered_at" in columns else "1=1"
        dead_sql = "dead_lettered_at IS NOT NULL" if "dead_lettered_at" in columns else "0"
        row = conn.execute(
            "SELECT "
            f"SUM(CASE WHEN pushed_at IS NULL AND {active_sql} THEN 1 ELSE 0 END) AS pending, "
            f"SUM(CASE WHEN pushed_at IS NULL AND {active_sql} "
            "AND last_error IS NOT NULL THEN 1 ELSE 0 END) "
            "AS failed, "
            f"SUM(CASE WHEN pushed_at IS NULL AND {dead_sql} THEN 1 ELSE 0 END) AS dead, "
            f"MIN(CASE WHEN pushed_at IS NULL AND {active_sql} THEN dirty_at END) AS oldest_dirty "
            "FROM account_report_outbox"
        ).fetchone()
        error_row = conn.execute(
            "SELECT last_error FROM account_report_outbox "
            "WHERE pushed_at IS NULL AND last_error IS NOT NULL "
            "ORDER BY dirty_at DESC LIMIT 1"
        ).fetchone()
        state_exists = conn.execute(
            "SELECT 1 FROM sqlite_master "
            "WHERE type='table' AND name='account_report_delivery_state'"
        ).fetchone()
        success_row = None
        if state_exists:
            success_row = conn.execute(
                "SELECT last_success_at FROM account_report_delivery_state WHERE id=1"
            ).fetchone()
    return {
        "account_report_pending": (row["pending"] if row else 0) or 0,
        "account_report_failed": (row["failed"] if row else 0) or 0,
        "account_report_dead": (row["dead"] if row else 0) or 0,
        "account_report_last_error": error_row["last_error"] if error_row else None,
        "account_report_oldest_dirty": row["oldest_dirty"] if row else None,
        "account_report_last_success_at": (
            success_row["last_success_at"] if success_row else None
        ),
    }

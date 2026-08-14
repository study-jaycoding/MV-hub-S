"""로컬 PM 텔레메트리 outbox 저장·조회·전송 정산."""

from __future__ import annotations

import json
from typing import Any, Optional

from ..db import get_connection
from ..emailnorm import norm_email
from .manage_schema import _ensure_schema


def mark_telemetry_dirty(gen_ids: list[str]) -> None:
    """변경된 내 생성물을 outbox에 다시 전송할 항목으로 표시한다."""
    ids = [gen_id for gen_id in (gen_ids or []) if gen_id]
    if not ids:
        return
    with get_connection() as conn:
        _ensure_schema(conn)
        for gen_id in ids:
            conn.execute(
                "INSERT INTO telemetry_outbox(local_gen_id, dirty_at) "
                "VALUES(?, strftime('%Y-%m-%dT%H:%M:%fZ','now')) "
                "ON CONFLICT(local_gen_id) DO UPDATE SET "
                "dirty_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'), "
                "pushed_at=NULL, is_tombstone=0, fail_streak=0, next_retry_at=NULL",
                (gen_id,),
            )


def mark_telemetry_tombstone(gen_id: str, snapshot: dict[str, Any]) -> None:
    """삭제된 생성물의 마지막 팩트를 보존해 서버에 삭제 상태를 전달한다."""
    if not gen_id:
        return
    with get_connection() as conn:
        _ensure_schema(conn)
        conn.execute(
            "INSERT INTO telemetry_outbox"
            "(local_gen_id, dirty_at, is_tombstone, tomb_job_id, tomb_creator_uid, tomb_snapshot) "
            "VALUES(?, strftime('%Y-%m-%dT%H:%M:%fZ','now'), 1, ?, ?, ?) "
            "ON CONFLICT(local_gen_id) DO UPDATE SET "
            "dirty_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'), pushed_at=NULL, is_tombstone=1, "
            "tomb_job_id=excluded.tomb_job_id, tomb_creator_uid=excluded.tomb_creator_uid, "
            "tomb_snapshot=excluded.tomb_snapshot, fail_streak=0, next_retry_at=NULL",
            (
                gen_id,
                snapshot.get("job_id"),
                snapshot.get("creator_uid"),
                json.dumps(snapshot, ensure_ascii=False),
            ),
        )


def mark_ingested_dirty(job_ids: list[str], my_uid: Optional[str]) -> int:
    """적재된 외부 job id를 로컬 generation id로 바꿔 outbox에 표시한다."""
    ids = [job_id for job_id in (job_ids or []) if job_id]
    if not ids:
        return 0
    placeholders = ",".join("?" for _ in ids)
    where = f"(id IN ({placeholders}) OR job_id IN ({placeholders}))"
    args: list[Any] = ids + ids
    if my_uid:
        where += " AND creator_uid = ?"
        args.append(my_uid)
    with get_connection() as conn:
        _ensure_schema(conn)
        rows = conn.execute(
            f"SELECT id FROM generation WHERE {where} AND deleted_at IS NULL", args
        ).fetchall()
        local_ids = [row["id"] for row in rows]
        for gen_id in local_ids:
            conn.execute(
                "INSERT INTO telemetry_outbox(local_gen_id, dirty_at) "
                "VALUES(?, strftime('%Y-%m-%dT%H:%M:%fZ','now')) "
                "ON CONFLICT(local_gen_id) DO UPDATE SET "
                "dirty_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'), "
                "pushed_at=NULL, is_tombstone=0, fail_streak=0, next_retry_at=NULL",
                (gen_id,),
            )
    return len(local_ids)


def telemetry_outbox_status() -> dict[str, Any]:
    """스키마를 만들지 않는 읽기 전용 outbox 상태를 반환한다."""
    empty = {"pending": 0, "failed": 0, "last_error": None, "oldest_dirty": None}
    with get_connection() as conn:
        if not conn.execute(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='telemetry_outbox'"
        ).fetchone():
            return empty
        row = conn.execute(
            "SELECT "
            "SUM(CASE WHEN pushed_at IS NULL THEN 1 ELSE 0 END) AS pending, "
            "SUM(CASE WHEN pushed_at IS NULL AND last_error IS NOT NULL THEN 1 ELSE 0 END) "
            "AS failed, "
            "MIN(CASE WHEN pushed_at IS NULL THEN dirty_at END) AS oldest_dirty "
            "FROM telemetry_outbox"
        ).fetchone()
        error_row = conn.execute(
            "SELECT last_error FROM telemetry_outbox "
            "WHERE pushed_at IS NULL AND last_error IS NOT NULL "
            "ORDER BY dirty_at DESC LIMIT 1"
        ).fetchone()
    return {
        "pending": (row["pending"] if row else 0) or 0,
        "failed": (row["failed"] if row else 0) or 0,
        "last_error": error_row["last_error"] if error_row else None,
        "oldest_dirty": row["oldest_dirty"] if row else None,
    }


def list_dirty_telemetry(limit: int = 200) -> list[dict[str, Any]]:
    """아직 전송되지 않은 항목을 오래된 순서로 반환한다.

    ★백오프 게이트: 실패한 항목은 next_retry_at 전까지 제외한다. 이게 없으면
    ①영구 실패 항목(서버 미링크 계정 등)이 드레인 주기(≈30초)마다 그대로 재전송돼
    폭주하고 ②오래된 실패 500행이 LIMIT 창을 선점해 그 뒤의 새 변경이 영원히
    선택되지 않았다(head-of-line blocking).
    """
    with get_connection() as conn:
        _ensure_schema(conn)
        rows = conn.execute(
            "SELECT local_gen_id, dirty_at, is_tombstone, tomb_job_id, "
            "tomb_creator_uid, tomb_snapshot FROM telemetry_outbox "
            "WHERE pushed_at IS NULL "
            "AND (next_retry_at IS NULL OR next_retry_at <= strftime('%Y-%m-%dT%H:%M:%fZ','now')) "
            "ORDER BY dirty_at ASC LIMIT ?",
            (limit,),
        ).fetchall()
        return [dict(row) for row in rows]


def account_emails_by_creator_uids(creator_uids: list[str]) -> dict[str, str]:
    """생성자 uid별 승인 계정 이메일을 반환한다.

    격리 개발 모드는 서버 인증 세션 하나에 의존하지 않고, 스냅샷 안의 여러 작성자 팩트를
    로컬 manage_hub.db로 복원해야 한다. 같은 uid에 서로 다른 이메일이 둘 이상 연결된 비정상
    상태는 임의 선택하지 않고 결과에서 제외해 오귀속을 막는다.
    """
    uids = sorted({uid.strip() for uid in (creator_uids or []) if uid and uid.strip()})
    if not uids:
        return {}
    placeholders = ",".join("?" for _ in uids)
    with get_connection() as conn:
        _ensure_schema(conn)
        rows = conn.execute(
            f"SELECT creator_uid, email FROM account "
            f"WHERE creator_uid IN ({placeholders}) AND status='approved'",
            uids,
        ).fetchall()
    grouped: dict[str, set[str]] = {}
    for row in rows:
        uid = (row["creator_uid"] or "").strip()
        email = norm_email(row["email"])
        if uid and email:
            grouped.setdefault(uid, set()).add(email)
    return {uid: next(iter(emails)) for uid, emails in grouped.items() if len(emails) == 1}


def build_telemetry_facts(
    gen_ids: Optional[list[str]] = None,
    my_uid: Optional[str] = None,
) -> list[dict[str, Any]]:
    """프롬프트·미디어를 제외한 관리용 생성 팩트를 만든다."""
    where = ["g.deleted_at IS NULL"]
    args: list[Any] = []
    if my_uid:
        where.append("g.creator_uid = ?")
        args.append(my_uid)
    if gen_ids is not None:
        ids = [gen_id for gen_id in gen_ids if gen_id]
        if not ids:
            return []
        where.append(f"g.id IN ({','.join('?' for _ in ids)})")
        args.extend(ids)
    sql = (
        "SELECT g.id AS local_gen_id, g.job_id, g.creator_uid, c.name AS creator_name, "
        "g.workspace_scope, g.workspace_id, g.workspace_name, "
        "g.project_id, p.name AS project_name, g.folder_path, g.model, "
        "(SELECT a.type FROM asset a WHERE a.generation_id=g.id LIMIT 1) AS output_type, "
        "g.status, g.created_at, g.sort_ts, g.is_final, "
        "(CASE WHEN EXISTS(SELECT 1 FROM share s WHERE s.generation_id=g.id) "
        "THEN 1 ELSE 0 END) AS is_shared, "
        "m.real_credits, m.est_credits, m.credit_source, m.elapsed_seconds, "
        "m.started_at, m.completed_at "
        "FROM generation g "
        "LEFT JOIN generation_metrics m ON m.gen_id=g.id "
        "LEFT JOIN creator c ON c.uid=g.creator_uid "
        "LEFT JOIN project p ON p.id=g.project_id "
        f"WHERE {' AND '.join(where)}"
    )
    with get_connection() as conn:
        _ensure_schema(conn)
        rows = conn.execute(sql, args).fetchall()
    facts: list[dict[str, Any]] = []
    for row in rows:
        fact = dict(row)
        fact["is_final"] = bool(fact.get("is_final"))
        fact["is_shared"] = bool(fact.get("is_shared"))
        fact["is_deleted"] = False
        fact["deleted_at"] = None
        facts.append(fact)
    return facts


def mark_telemetry_pushed(items: list[dict[str, Any]]) -> None:
    """전송 성공 시 dirty_at CAS로 그 사이 생긴 새 변경을 보존하며 완료 처리한다."""
    with get_connection() as conn:
        _ensure_schema(conn)
        for item in items or []:
            gen_id = item.get("local_gen_id")
            if not gen_id:
                continue
            conn.execute(
                "UPDATE telemetry_outbox SET pushed_at=datetime('now'), "
                "attempts=attempts+1, last_error=NULL, fail_streak=0, next_retry_at=NULL "
                "WHERE local_gen_id=? AND dirty_at=? AND pushed_at IS NULL",
                (gen_id, item.get("dirty_at")),
            )


def mark_telemetry_failed(items: list[dict[str, Any]], error: str) -> None:
    """전송 실패를 기록하고 다음 재시도 시각을 뒤로 민다(백오프).

    지연 = min(1시간, 60초 × 연속실패수²) — 1회 60s, 2회 4분, 3회 9분, … 8회부터 1시간.
    일시 장애는 금방 복귀하고, 영구 실패(서버 미링크 등)는 시간당 1회로 수렴해
    폭주하지 않는다. attempts 는 누적 전송수(성공 포함)라 백오프에 못 쓴다 — fail_streak 사용.
    ★성공 처리(mark_telemetry_pushed)와 같은 dirty_at CAS — 전송 중 그 항목이 다시
    dirty 됐다면 옛 전송의 실패가 새 변경에 백오프를 걸면 안 된다(새 변경은 즉시 재시도).
    """
    with get_connection() as conn:
        _ensure_schema(conn)
        for item in items or []:
            gen_id = item.get("local_gen_id") if isinstance(item, dict) else item
            dirty_at = item.get("dirty_at") if isinstance(item, dict) else None
            if not gen_id:
                continue
            where = "WHERE local_gen_id=?"
            args: list[Any] = [error[:500], gen_id]
            if dirty_at is not None:
                where += " AND dirty_at=?"
                args.append(dirty_at)
            conn.execute(
                "UPDATE telemetry_outbox SET attempts=attempts+1, last_error=?, "
                "fail_streak=fail_streak+1, "
                "next_retry_at=strftime('%Y-%m-%dT%H:%M:%fZ','now', "
                "  printf('+%d seconds', MIN(3600, 60*(fail_streak+1)*(fail_streak+1)))) "
                + where,
                args,
            )

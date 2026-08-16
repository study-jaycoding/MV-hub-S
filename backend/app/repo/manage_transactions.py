"""계정 크레딧 거래 적재와 생성물 근접 매칭."""

from __future__ import annotations

import bisect
import hashlib
from datetime import datetime
from typing import Optional

from ..db import get_connection
from .manage_schema import _ensure_schema
from .manage_telemetry import mark_telemetry_dirty

_MATCH_WINDOW = 60.0


def _epoch(iso: Optional[str]) -> Optional[float]:
    if not iso:
        return None
    try:
        return datetime.fromisoformat(iso.replace("Z", "+00:00")).timestamp()
    except (ValueError, TypeError):
        return None


def record_transactions(
    owner_uid: Optional[str],
    account_email: Optional[str],
    transactions: list[dict],
) -> dict[str, int]:
    """거래를 멱등 적재하고 소유자·모델·시각이 맞는 생성물에 실제값을 기록한다."""
    if not transactions:
        return {"inserted": 0, "matched": 0}
    inserted = 0
    with get_connection() as conn:
        _ensure_schema(conn)
        conn.execute("BEGIN IMMEDIATE")
        try:
            for transaction in transactions:
                if not isinstance(transaction, dict):
                    continue
                created_at = transaction.get("created_at")
                credits = transaction.get("credits")
                action = transaction.get("action")
                display_name = transaction.get("display_name")
                model = transaction.get("model")
                raw = (
                    f"{owner_uid}|{created_at}|{credits}|{action}|{display_name}"
                )
                transaction_id = hashlib.sha1(raw.encode("utf-8")).hexdigest()
                cursor = conn.execute(
                    "INSERT OR IGNORE INTO credit_txn"
                    "(id, owner_uid, account_email, display_name, credits, action, created_at, model) "
                    "VALUES(?,?,?,?,?,?,?,?)",
                    (
                        transaction_id,
                        owner_uid,
                        account_email,
                        display_name,
                        credits,
                        action,
                        created_at,
                        model,
                    ),
                )
                inserted += cursor.rowcount
                # CLI 모델 목록 조회가 늦게 성공하면 같은 거래에 model 정보가 뒤늦게 붙을 수 있다.
                # 거래 자체는 중복 삽입하지 않고, 비어 있던 모델 키만 안전하게 보강한다.
                if model:
                    conn.execute(
                        "UPDATE credit_txn SET model=? WHERE id=? "
                        "AND (model IS NULL OR TRIM(model)='')",
                        (model, transaction_id),
                    )
            matched_ids = _match_transactions(conn, owner_uid)
            conn.execute("COMMIT")
        except Exception:
            conn.execute("ROLLBACK")
            raise
    if matched_ids:
        try:
            mark_telemetry_dirty(matched_ids)
        except Exception:  # noqa: BLE001
            pass
    return {
        "inserted": inserted,
        "matched": len(matched_ids),
        "matched_ids": matched_ids,
    }


def _match_transactions(conn, owner_uid: Optional[str]) -> list[str]:
    """BEGIN IMMEDIATE 안에서 미매칭 거래와 생성물을 1:1로 확정한다."""
    transactions = conn.execute(
        "SELECT id, credits, created_at, owner_uid, model FROM credit_txn "
        "WHERE action='spend' AND matched_gen_id IS NULL "
        "AND (owner_uid IS ? OR ? IS NULL)",
        (owner_uid, owner_uid),
    ).fetchall()
    if not transactions:
        return []
    generations = conn.execute(
        "SELECT g.id AS id, g.sort_ts AS sort_ts, g.creator_uid AS creator_uid, "
        "g.model AS model FROM generation g "
        "LEFT JOIN generation_metrics m ON m.gen_id = g.id "
        "WHERE g.sort_ts IS NOT NULL AND g.deleted_at IS NULL "
        "AND (g.creator_uid = ? OR ? IS NULL) "
        "AND m.real_credits IS NULL",
        (owner_uid, owner_uid),
    ).fetchall()
    if not generations:
        return []

    order = sorted(range(len(generations)), key=lambda index: generations[index]["sort_ts"])
    generation_timestamps = [generations[index]["sort_ts"] for index in order]
    pairs: list[tuple[float, int, int]] = []
    transaction_timestamps = [_epoch(row["created_at"]) for row in transactions]
    for transaction_index, transaction_epoch in enumerate(transaction_timestamps):
        if transaction_epoch is None:
            continue
        transaction = transactions[transaction_index]
        lower = bisect.bisect_left(
            generation_timestamps, transaction_epoch - _MATCH_WINDOW
        )
        upper = bisect.bisect_right(
            generation_timestamps, transaction_epoch + _MATCH_WINDOW
        )
        for ordered_index in range(lower, upper):
            generation_index = order[ordered_index]
            generation = generations[generation_index]
            if (
                transaction["owner_uid"]
                and generation["creator_uid"]
                and transaction["owner_uid"] != generation["creator_uid"]
            ):
                continue
            transaction_model = transaction["model"]
            generation_model = generation["model"]
            if transaction_model and generation_model and transaction_model != generation_model:
                continue
            pairs.append(
                (
                    abs(generation["sort_ts"] - transaction_epoch),
                    transaction_index,
                    generation_index,
                )
            )
    pairs.sort()

    used_transactions: set[int] = set()
    used_generations: set[int] = set()
    matched_ids: list[str] = []
    for _, transaction_index, generation_index in pairs:
        if transaction_index in used_transactions or generation_index in used_generations:
            continue
        transaction = transactions[transaction_index]
        generation = generations[generation_index]
        credits = transaction["credits"]
        real_credits = round(abs(credits)) if credits is not None else None
        conn.execute("SAVEPOINT match_pair")
        transaction_cursor = conn.execute(
            "UPDATE credit_txn SET matched_gen_id=? "
            "WHERE id=? AND matched_gen_id IS NULL",
            (generation["id"], transaction["id"]),
        )
        if transaction_cursor.rowcount != 1:
            conn.execute("ROLLBACK TO match_pair")
            conn.execute("RELEASE match_pair")
            continue
        metrics_cursor = conn.execute(
            "INSERT INTO generation_metrics(gen_id, real_credits, credit_source, matched) "
            "VALUES(?,?, 'transaction', 1) "
            "ON CONFLICT(gen_id) DO UPDATE SET "
            "real_credits=excluded.real_credits, credit_source='transaction', matched=1 "
            "WHERE generation_metrics.real_credits IS NULL",
            (generation["id"], real_credits),
        )
        if metrics_cursor.rowcount != 1:
            conn.execute("ROLLBACK TO match_pair")
            conn.execute("RELEASE match_pair")
            continue
        conn.execute("RELEASE match_pair")
        used_transactions.add(transaction_index)
        used_generations.add(generation_index)
        matched_ids.append(generation["id"])
    return matched_ids

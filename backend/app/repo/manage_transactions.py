"""계정 크레딧 거래 적재와 생성물 근접 매칭."""

from __future__ import annotations

import bisect
import hashlib
import math
from collections import deque
from datetime import datetime
from typing import Any, Optional

from ..db import get_connection
from .manage_schema import _ensure_schema
from .manage_telemetry import mark_telemetry_dirty_in_connection

_MATCH_WINDOW = 60.0
_MAX_COMPONENT_VERTICES = 512
_MAX_COMPONENT_EDGES = 65536
_PENDING_SOURCES = (
    "transaction_pending_ambiguous",
    "transaction_pending_incomplete",
    "transaction_pending_limit",
)


def _spend_amount(credits: Any) -> Optional[float]:
    """거래의 지출 금액 — **소수를 그대로 살린다**. 부호만 뗀다(spend 는 음수로 들어온다).

    ★2026-09-11 실측: 힉스필드 거래 금액은 소수다. `Nano Banana 2` = −1.5, `Higgsfield Soul V2`
     = −0.12, `Seedance 2.5` 기본 = −32.5. MILLION VOLT 최근 100건 중 **58건**이 소수였다.
     종전 `round(abs(credits))` 는 −1.5 를 2 로 적어 **건당 33% 과대**, −0.12 는 0 으로 적어
     **전액 소실**시켰다. `credit_txn.credits` 도 `team_generation_fact.real_credits` 도 이미
     REAL 이라 스키마는 그대로 두고 코드만 고치면 된다.
    금액을 읽을 수 없는 거래(bool·NaN·무한대·비수치)는 None 을 돌려 **매칭에서 제외**한다 —
    0 으로 확정하면 유료 생성이 장부에 무료로 남는다."""
    if isinstance(credits, bool) or not isinstance(credits, (int, float)):
        return None
    number = float(credits)
    if not math.isfinite(number):
        return None
    return abs(number)


def _epoch(iso: Optional[str]) -> Optional[float]:
    if not iso:
        return None
    try:
        return datetime.fromisoformat(iso.replace("Z", "+00:00")).timestamp()
    except (ValueError, TypeError):
        return None


def _stable_transaction_id(
    account_email: str,
    created_at,
    credits,
    action,
    display_name,
) -> str:
    """owner_uid remap과 무관한 서버 계정 키로 새 거래 ID를 만든다."""
    raw = f"account:{account_email}|{created_at}|{credits}|{action}|{display_name}"
    return hashlib.sha1(raw.encode("utf-8")).hexdigest()


def record_transactions(
    owner_uid: Optional[str],
    account_email: Optional[str],
    transactions: list[dict],
) -> dict[str, Any]:
    """거래를 멱등 적재하고 소유자·모델·시각이 맞는 생성물에 실제값을 기록한다."""
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
                # SQLite REAL affinity는 bool/숫자문자열도 숫자로 바꾼다. 타입을 잃기 전에
                # 검사해야 잘못된 입력이 다음 빈 사이클에서 유효 금액으로 되살아나지 않는다.
                if action == "spend" and _spend_amount(credits) is None:
                    continue
                display_name = transaction.get("display_name")
                model = transaction.get("model")
                # 어느 공간에서 빠진 돈인지 — 거래 응답에는 없고 에이전트가 붙여 보낸다.
                # 거래 신원에는 넣지 않는다(manage_schema 의 ALTER 주석 참조).
                workspace_id = str(transaction.get("workspace_id") or "").strip() or None
                account_key = str(account_email or "").strip().lower()
                existing = None
                if account_key:
                    # 배포 전 owner 기반 ID 행도 안정 필드로 찾아 그 PK를 그대로 재사용한다.
                    # 따라서 remap 사이 재전송과 새 ID 산식 전환 모두 별도 행을 만들지 않는다.
                    existing = conn.execute(
                        "SELECT id FROM credit_txn WHERE LOWER(TRIM(account_email))=? "
                        "AND created_at IS ? AND credits IS ? AND action IS ? "
                        "AND display_name IS ? LIMIT 1",
                        (account_key, created_at, credits, action, display_name),
                    ).fetchone()
                if existing is not None:
                    transaction_id = existing["id"]
                elif account_key:
                    transaction_id = _stable_transaction_id(
                        account_key, created_at, credits, action, display_name
                    )
                else:
                    # 이메일이 없는 레거시 내부 호출은 서로 다른 계정을 합치지 않도록 옛 산식을 유지한다.
                    raw = f"{owner_uid}|{created_at}|{credits}|{action}|{display_name}"
                    transaction_id = hashlib.sha1(raw.encode("utf-8")).hexdigest()
                cursor = conn.execute(
                    "INSERT OR IGNORE INTO credit_txn"
                    "(id, owner_uid, account_email, display_name, credits, action, created_at, "
                    "model, workspace_id) VALUES(?,?,?,?,?,?,?,?,?)",
                    (
                        transaction_id,
                        owner_uid,
                        account_key or account_email,
                        display_name,
                        credits,
                        action,
                        created_at,
                        model,
                        workspace_id,
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
                # 공간도 같은 규칙으로 보강한다 — 옛 에이전트가 올린 행(NULL)이 뒤늦게 채워지고,
                # 이미 채워진 값은 덮지 않는다(다른 공간 값으로 조용히 바뀌면 진단이 어긋난다).
                if workspace_id:
                    conn.execute(
                        "UPDATE credit_txn SET workspace_id=? WHERE id=? "
                        "AND (workspace_id IS NULL OR TRIM(workspace_id)='')",
                        (workspace_id, transaction_id),
                    )
            matched_ids = _match_transactions(conn, owner_uid)
            conn.execute("COMMIT")
        except Exception:
            conn.execute("ROLLBACK")
            raise
    return {
        "inserted": inserted,
        "matched": len(matched_ids),
        "matched_ids": matched_ids,
    }


def _augment(
    start: int,
    edges: dict[int, list[int]],
    by_generation: dict[int, int],
    by_transaction: dict[int, int],
    spend_amounts: list[Optional[float]],
    forbidden_amount: Optional[float] = None,
) -> bool:
    """반복형 BFS 증가경로. 성공한 경로만 배정을 옮긴다."""
    queue = deque([start])
    parents: dict[int, int] = {}  # 거래를 처음 방문한 생성물
    while queue:
        generation_index = queue.popleft()
        for transaction_index in edges[generation_index]:
            if transaction_index in parents:
                continue
            if (
                generation_index == start
                and forbidden_amount is not None
                and spend_amounts[transaction_index] == forbidden_amount
            ):
                continue
            parents[transaction_index] = generation_index
            assigned = by_transaction.get(transaction_index)
            if assigned is not None:
                queue.append(assigned)
                continue
            # 빈 거래에서 시작점까지 거꾸로 이동하며 경로를 뒤집는다.
            while True:
                generation_index = parents[transaction_index]
                previous = by_generation.get(generation_index)
                by_generation[generation_index] = transaction_index
                by_transaction[transaction_index] = generation_index
                if previous is None:
                    return True
                transaction_index = previous
    return False


def _component_matching(
    generation_indices: list[int],
    transaction_indices: set[int],
    edges: dict[int, list[int]],
    spend_amounts: list[Optional[float]],
) -> tuple[Optional[str], dict[int, int]]:
    """모든 최대 매칭에서 생성물별 금액이 같을 때만 기준 매칭을 반환한다."""
    if (
        len(generation_indices) + len(transaction_indices) > _MAX_COMPONENT_VERTICES
        or sum(len(edges[g]) for g in generation_indices) > _MAX_COMPONENT_EDGES
    ):
        return "limit", {}
    by_generation: dict[int, int] = {}
    by_transaction: dict[int, int] = {}
    for generation_index in generation_indices:
        _augment(generation_index, edges, by_generation, by_transaction, spend_amounts)
    if len(by_generation) < len(generation_indices):
        return "incomplete", {}
    if len({spend_amounts[t] for t in transaction_indices}) == 1:
        return None, by_generation
    for generation_index in generation_indices:
        # 각 검사는 같은 기준 매칭에서 독립적으로 수행한다.
        alternate_generations = by_generation.copy()
        alternate_transactions = by_transaction.copy()
        transaction_index = alternate_generations.pop(generation_index)
        del alternate_transactions[transaction_index]
        if _augment(
            generation_index, edges, alternate_generations, alternate_transactions,
            spend_amounts, forbidden_amount=spend_amounts[transaction_index],
        ):
            return "ambiguous", {}
    return None, by_generation


def _set_credit_source(conn, generation, source: str) -> bool:
    """보류/해제 상태가 실제 바뀔 때만 저장한다. 견적은 보존한다."""
    if generation["credit_source"] == source and generation["matched"] == 0:
        return False
    cursor = conn.execute(
        "INSERT INTO generation_metrics(gen_id, credit_source, matched) VALUES(?,?,0) "
        "ON CONFLICT(gen_id) DO UPDATE SET credit_source=excluded.credit_source, matched=0 "
        "WHERE generation_metrics.real_credits IS NULL",
        (generation["id"], source),
    )
    if cursor.rowcount != 1:
        raise RuntimeError("Credit component state changed during matching")
    return True


def _match_transactions(conn, owner_uid: Optional[str]) -> list[str]:
    """BEGIN IMMEDIATE 안에서 요소 전체를 확정하거나 보류하고 dirty도 함께 저장한다."""
    # 빈 계정 사이클이 전체 사용자 재평가로 확대되면 안 된다. 신원 없는 기존 호출도
    # 거래 적재는 보존하되, 생성물 배정은 소유자를 확인한 호출에서만 수행한다.
    if not owner_uid or not owner_uid.strip():
        return []
    transactions = conn.execute(
        "SELECT id, credits, created_at, owner_uid, model FROM credit_txn "
        "WHERE action='spend' AND matched_gen_id IS NULL AND owner_uid=? ORDER BY id",
        (owner_uid,),
    ).fetchall()
    # 모델/시각/생성기 변경으로 후보가 사라진 생성물도 읽어 오래된 보류를 해제한다.
    # 삭제된 생성물은 기존처럼 제외한다. 일반 dirty로 삭제 전송 표시를 덮으면 안 된다.
    generations = conn.execute(
        "SELECT g.id, g.sort_ts, g.creator_uid, g.model, g.generator, "
        "m.est_credits, m.credit_source, m.matched FROM generation g "
        "LEFT JOIN generation_metrics m ON m.gen_id = g.id "
        "WHERE g.creator_uid=? AND g.deleted_at IS NULL AND m.real_credits IS NULL ORDER BY g.id",
        (owner_uid,),
    ).fetchall()
    order = sorted(
        (i for i, g in enumerate(generations)
         if g["sort_ts"] is not None and g["generator"] != "comfy"),
        key=lambda i: (generations[i]["sort_ts"], generations[i]["id"]),
    )
    generation_timestamps = [generations[i]["sort_ts"] for i in order]
    edges: dict[int, list[int]] = {}
    reverse_edges: dict[int, list[int]] = {}
    transaction_timestamps = [_epoch(row["created_at"]) for row in transactions]
    spend_amounts = [_spend_amount(row["credits"]) for row in transactions]
    for transaction_index, transaction_epoch in enumerate(transaction_timestamps):
        if transaction_epoch is None or spend_amounts[transaction_index] is None:
            continue
        transaction = transactions[transaction_index]
        lower = bisect.bisect_left(generation_timestamps, transaction_epoch - _MATCH_WINDOW)
        upper = bisect.bisect_right(generation_timestamps, transaction_epoch + _MATCH_WINDOW)
        for ordered_index in range(lower, upper):
            generation_index = order[ordered_index]
            generation = generations[generation_index]
            if (
                transaction["owner_uid"] and generation["creator_uid"]
                and transaction["owner_uid"] != generation["creator_uid"]
            ):
                continue
            transaction_model = transaction["model"]
            generation_model = generation["model"]
            if transaction_model and generation_model and transaction_model != generation_model:
                continue
            edges.setdefault(generation_index, []).append(transaction_index)
            reverse_edges.setdefault(transaction_index, []).append(generation_index)

    matched_ids: list[str] = []
    dirty_ids: list[str] = []
    visited: set[int] = set()
    for start in sorted(edges):
        if start in visited:
            continue
        visited.add(start)
        queue = deque([start])
        component_generations: list[int] = []
        component_transactions: set[int] = set()
        while queue:
            generation_index = queue.popleft()
            component_generations.append(generation_index)
            for transaction_index in edges[generation_index]:
                if transaction_index in component_transactions:
                    continue
                component_transactions.add(transaction_index)
                for neighbor in reverse_edges[transaction_index]:
                    if neighbor not in visited:
                        visited.add(neighbor)
                        queue.append(neighbor)
        reason, matching = _component_matching(
            component_generations, component_transactions, edges, spend_amounts,
        )
        if reason is not None:
            for generation_index in component_generations:
                generation = generations[generation_index]
                if _set_credit_source(conn, generation, f"transaction_pending_{reason}"):
                    dirty_ids.append(generation["id"])
            continue
        for generation_index, transaction_index in matching.items():
            generation = generations[generation_index]
            transaction_cursor = conn.execute(
                "UPDATE credit_txn SET matched_gen_id=? WHERE id=? AND matched_gen_id IS NULL",
                (generation["id"], transactions[transaction_index]["id"]),
            )
            if transaction_cursor.rowcount != 1:
                raise RuntimeError("Credit component transaction changed during matching")
            metrics_cursor = conn.execute(
                "INSERT INTO generation_metrics(gen_id, real_credits, credit_source, matched) "
                "VALUES(?,?, 'transaction', 1) "
                "ON CONFLICT(gen_id) DO UPDATE SET "
                "real_credits=excluded.real_credits, credit_source='transaction', matched=1 "
                "WHERE generation_metrics.real_credits IS NULL",
                (generation["id"], spend_amounts[transaction_index]),
            )
            if metrics_cursor.rowcount != 1:
                raise RuntimeError("Credit component generation changed during matching")
            matched_ids.append(generation["id"])
            dirty_ids.append(generation["id"])
    for generation_index, generation in enumerate(generations):
        if generation_index not in edges and generation["credit_source"] in _PENDING_SOURCES:
            source = "estimate" if generation["est_credits"] is not None else "unknown"
            if _set_credit_source(conn, generation, source):
                dirty_ids.append(generation["id"])
    # 오류를 삼키거나 COMMIT 뒤 별도 연결을 열면 장부와 전송 revision이 갈라진다.
    mark_telemetry_dirty_in_connection(conn, dirty_ids)
    return matched_ids

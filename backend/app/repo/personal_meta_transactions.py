"""생성물 개인 메타의 로컬 행과 팀 shadow를 함께 저장하는 트랜잭션 경계."""

from __future__ import annotations

from contextvars import ContextVar
import sqlite3
from typing import Any, Callable

from ..db import get_connection


PersonalMetaBatchWriter = Callable[[list[Any]], Any]
_personal_meta_batch_conn: ContextVar[sqlite3.Connection | None] = ContextVar(
    "personal_meta_batch_conn", default=None
)


def _current_personal_meta_batch_connection() -> sqlite3.Connection | None:
    """transaction-root가 넘긴 연결. 일반 단건/배치 호출에서는 ``None``이다."""
    return _personal_meta_batch_conn.get()


def apply_generation_personal_meta_writes(
    local_items: list[Any],
    shadow_items: list[Any],
    *,
    local_writer: PersonalMetaBatchWriter,
    shadow_writer: PersonalMetaBatchWriter,
) -> None:
    """로컬 메타와 팀 shadow를 한 ``BEGIN IMMEDIATE``로 반영한다.

    ★transaction-root 전용(바깥 트랜잭션 안 호출 금지). 실제로 두 종류의 쓰기가 모두
    있을 때만 공통 트랜잭션을 열고, 한쪽뿐이면 기존 공개 setter의 트랜잭션 계약을 유지한다.
    배치 연결은 ContextVar로 전달하므로 공개 setter 시그니처도 바뀌지 않는다.
    """
    if not local_items or not shadow_items:
        local_writer(local_items)
        shadow_writer(shadow_items)
        return

    with get_connection() as conn:
        conn.execute("BEGIN IMMEDIATE")
        token = _personal_meta_batch_conn.set(conn)
        try:
            local_writer(local_items)
            shadow_writer(shadow_items)
            conn.execute("COMMIT")
        except Exception:
            if conn.in_transaction:
                conn.execute("ROLLBACK")
            raise
        finally:
            _personal_meta_batch_conn.reset(token)

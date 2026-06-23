"""태그 / 자동 태그 (별도 네임스페이스)."""

from __future__ import annotations

import sqlite3
from typing import Iterable, Optional

from ..db import get_connection
from ._common import new_id


# ── 태그 / 레퍼런스 get-or-create ────────────────────────────────────────
def _get_or_create_tag(conn: sqlite3.Connection, name: str) -> str:
    name = name.strip()
    row = conn.execute("SELECT id FROM tag WHERE name = ?", (name,)).fetchone()
    if row:
        return row["id"]
    tid = new_id()
    conn.execute("INSERT INTO tag(id, name) VALUES(?,?)", (tid, name))
    return tid


def _set_tags(conn: sqlite3.Connection, gen_id: str, tags: Iterable[str]) -> None:
    """태그를 정확히 이 집합으로 교체(기존 제거 후 추가). 추가 로직은 _add_tags 와 공유."""
    conn.execute("DELETE FROM gen_tag WHERE generation_id = ?", (gen_id,))
    _add_tags(conn, gen_id, tags)


# ── 자동 태그(전역 태그, 계정별 네임스페이스) ────────────────────────────────
# auto_tag 는 owner_uid(계정 creator_uid)별로 분리된다 — 같은 이름이라도 계정마다 따로 가진다.
# 그래서 모든 조회/생성/삭제는 owner 로 스코프하고, 매칭은 NULL(레거시/단독)도 되도록 `IS ?` 를 쓴다.
def _get_or_create_auto_tag(
    conn: sqlite3.Connection, name: str, owner_uid: Optional[str]
) -> str:
    name = name.strip()
    row = conn.execute(
        "SELECT id FROM auto_tag WHERE name = ? AND owner_uid IS ?", (name, owner_uid)
    ).fetchone()
    if row:
        return row["id"]
    aid = new_id()
    conn.execute(
        "INSERT INTO auto_tag(id, name, owner_uid) VALUES(?,?,?)", (aid, name, owner_uid)
    )
    return aid


def _set_auto_tags(conn: sqlite3.Connection, gen_id: str, names: Iterable[str]) -> None:
    """생성 시 무장된 자동 태그를 결과물에 연결(일반 태그와 완전 분리).
    소유자는 그 결과물의 작성자(generation.creator_uid) — 작성자 본인의 전역 태그로 귀속된다."""
    row = conn.execute(
        "SELECT creator_uid FROM generation WHERE id=?", (gen_id,)
    ).fetchone()
    owner_uid = row["creator_uid"] if row else None
    for name in {t.strip() for t in names if t and t.strip()}:
        aid = _get_or_create_auto_tag(conn, name, owner_uid)
        conn.execute(
            "INSERT OR IGNORE INTO gen_auto_tag(generation_id, auto_tag_id) VALUES(?,?)",
            (gen_id, aid),
        )


def list_auto_tags(owner_uid: Optional[str] = None) -> list[str]:
    """그 계정(owner_uid)이 소유한 전역 태그 이름들. owner 가 다르면 안 보인다(계정별 격리)."""
    with get_connection() as conn:
        return [
            r["name"]
            for r in conn.execute(
                "SELECT name FROM auto_tag WHERE owner_uid IS ? ORDER BY name", (owner_uid,)
            )
        ]


def add_auto_tags(gen_id: str, names: Iterable[str]) -> None:
    """기존 자동태그를 유지한 채 추가(재생성 시 armed 자동태그 적용). 소유자는 결과물 작성자."""
    with get_connection() as conn:
        _set_auto_tags(conn, gen_id, names)


def create_auto_tag(name: str, owner_uid: Optional[str] = None) -> bool:
    """전역 태그 추가(+버튼) — 그 계정(owner_uid) 네임스페이스에. 같은 계정에 이미 있으면 False.
    다른 계정이 같은 이름을 갖고 있어도 충돌하지 않는다(계정별 소유)."""
    name = (name or "").strip()
    if not name:
        return False
    with get_connection() as conn:
        exists = conn.execute(
            "SELECT 1 FROM auto_tag WHERE name=? AND owner_uid IS ?", (name, owner_uid)
        ).fetchone()
        if exists:
            return False
        conn.execute(
            "INSERT INTO auto_tag(id, name, owner_uid) VALUES(?,?,?)",
            (new_id(), name, owner_uid),
        )
        return True


def delete_auto_tag(name: str, owner_uid: Optional[str] = None) -> int:
    """그 계정 소유의 전역 태그 삭제(연결 + 태그 행). 제거된 연결 수 반환. 남의 태그는 못 지운다."""
    with get_connection() as conn:
        row = conn.execute(
            "SELECT id FROM auto_tag WHERE name=? AND owner_uid IS ?", (name, owner_uid)
        ).fetchone()
        if not row:
            return 0
        aid = row["id"]
        cur = conn.execute("DELETE FROM gen_auto_tag WHERE auto_tag_id=?", (aid,))
        conn.execute("DELETE FROM auto_tag WHERE id=?", (aid,))
        return cur.rowcount


def set_tags(gen_id: str, tags: Iterable[str]) -> None:
    with get_connection() as conn:
        _set_tags(conn, gen_id, tags)


def delete_tag_everywhere(name: str) -> int:
    """태그를 모든 generation 에서 제거(전역 삭제) + 고아 태그 행 정리. 제거된 링크 수 반환.
    에셋 파트 T 패널의 '모든 파일에서 삭제'와 동일한 동작을 생성 파트에 제공."""
    with get_connection() as conn:
        row = conn.execute("SELECT id FROM tag WHERE name=?", (name,)).fetchone()
        if not row:
            return 0
        tid = row["id"]
        cur = conn.execute("DELETE FROM gen_tag WHERE tag_id=?", (tid,))
        conn.execute("DELETE FROM tag WHERE id=?", (tid,))
        return cur.rowcount


def _add_tags(conn: sqlite3.Connection, gen_id: str, tags: Iterable[str]) -> None:
    """태그 union 추가(기존 유지). 번들 병합은 덮어쓰기 아니라 합집합."""
    for name in {t.strip() for t in tags if t and t.strip()}:
        tid = _get_or_create_tag(conn, name)
        conn.execute(
            "INSERT OR IGNORE INTO gen_tag(generation_id, tag_id) VALUES(?,?)",
            (gen_id, tid),
        )

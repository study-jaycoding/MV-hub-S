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


def set_gen_auto_tags(gen_id: str, names: Iterable[str]) -> None:
    """이 결과물의 전역(auto) 태그를 정확히 이 집합으로 교체(기존 제거 후 부여). 카드의 # 피커가
    호출 — 작성자(creator_uid)가 '이미 가진' 전역 태그만 부여하고, 모르는 이름은 조용히 무시한다
    (전역 태그 '생성'은 사이드바 전용 — 여기서 새 auto_tag 를 만들지 않는다)."""
    set_generation_auto_tags_batch([(gen_id, list(names))])


def set_generation_auto_tags_batch(items: list[tuple[str, list[str]]]) -> int:
    """여러 생성물의 자동 태그를 한 트랜잭션으로 교체한다.

    같은 생성물 id가 여러 번 오면 단건 호출 순서와 동일하게 마지막 값이 이긴다. 자동 태그는
    생성하지 않고 각 생성물 작성자가 이미 가진 태그만 연결한다.
    """
    final_by_id: dict[str, list[str]] = {}
    for gen_id, names in items or []:
        if gen_id:
            final_by_id[gen_id] = list(names or [])
    if not final_by_id:
        return 0

    with get_connection() as conn:
        conn.execute("BEGIN IMMEDIATE")
        gen_ids = list(final_by_id)
        owners: dict[str, Optional[str]] = {}
        for offset in range(0, len(gen_ids), 900):
            batch = gen_ids[offset:offset + 900]
            placeholders = ",".join("?" * len(batch))
            for row in conn.execute(
                f"SELECT id, creator_uid FROM generation WHERE id IN ({placeholders})",
                batch,
            ).fetchall():
                owners[row["id"]] = row["creator_uid"]

        # (owner,name) 단건 SELECT 반복 → owner 별 chunked IN 배치(R6 2-I).
        # owner_uid NULL 은 IS 비교 의미를 유지하려고 owner 단위로 나눠 조회한다.
        # 없는 태그는 cache 미존재로 자연 제외(자동 태그 미생성 계약 그대로).
        wanted: dict[Optional[str], set[str]] = {}
        for gen_id, names in final_by_id.items():
            if gen_id not in owners:
                continue
            owner_uid = owners[gen_id]
            for name in {tag.strip() for tag in names if tag and tag.strip()}:
                wanted.setdefault(owner_uid, set()).add(name)
        tag_cache: dict[tuple[Optional[str], str], str] = {}
        for owner_uid, names_set in wanted.items():
            name_list = sorted(names_set)
            for offset in range(0, len(name_list), 900):
                batch = name_list[offset:offset + 900]
                placeholders = ",".join("?" * len(batch))
                for row in conn.execute(
                    f"SELECT id, name FROM auto_tag WHERE owner_uid IS ? "
                    f"AND name IN ({placeholders})",
                    (owner_uid, *batch),
                ).fetchall():
                    # setdefault — NULL owner 는 UNIQUE 가 중복을 허용하므로 종전
                    # fetchone(첫 행) 의미를 보존한다(코덱스 P2 — 마지막 행 덮어쓰기 금지).
                    tag_cache.setdefault((owner_uid, row["name"]), row["id"])
        links: list[tuple[str, str]] = []
        for gen_id, names in final_by_id.items():
            if gen_id not in owners:
                continue
            owner_uid = owners[gen_id]
            for name in {tag.strip() for tag in names if tag and tag.strip()}:
                tag_id = tag_cache.get((owner_uid, name))
                if tag_id:
                    links.append((gen_id, tag_id))

        conn.executemany(
            "DELETE FROM gen_auto_tag WHERE generation_id=?",
            [(gen_id,) for gen_id in owners],
        )
        if links:
            conn.executemany(
                "INSERT OR IGNORE INTO gen_auto_tag(generation_id, auto_tag_id) VALUES(?,?)",
                links,
            )
    return len(owners)


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
    set_generation_tags_batch([(gen_id, list(tags))])


def set_generation_tags_batch(items: list[tuple[str, list[str]]]) -> int:
    """여러 생성물의 일반 태그를 한 트랜잭션으로 전체 교체한다.

    공통 태그 id는 배치 안에서 한 번만 조회·생성하고, 같은 생성물 id가 반복되면 마지막 값이 이긴다.
    """
    final_by_id: dict[str, list[str]] = {}
    for gen_id, names in items or []:
        if gen_id:
            final_by_id[gen_id] = list(names or [])
    if not final_by_id:
        return 0

    with get_connection() as conn:
        conn.execute("BEGIN IMMEDIATE")
        tag_ids: dict[str, str] = {}
        all_names = {
            name.strip()
            for names in final_by_id.values()
            for name in names
            if name and name.strip()
        }
        for name in all_names:
            tag_ids[name] = _get_or_create_tag(conn, name)

        conn.executemany(
            "DELETE FROM gen_tag WHERE generation_id=?",
            [(gen_id,) for gen_id in final_by_id],
        )
        links = [
            (gen_id, tag_ids[name])
            for gen_id, names in final_by_id.items()
            for name in {tag.strip() for tag in names if tag and tag.strip()}
        ]
        if links:
            conn.executemany(
                "INSERT OR IGNORE INTO gen_tag(generation_id, tag_id) VALUES(?,?)",
                links,
            )
    return len(final_by_id)


def delete_tag_everywhere(name: str, account_uid: Optional[str] = None) -> int:
    """태그를 generation 에서 제거 + 고아 태그 행 정리. 제거된 링크 수 반환.
    account_uid=None(단독/AUTH off): 전역 삭제(기존 동작). account_uid 지정(AUTH on): 내 생성물의
    링크만 제거하고 남의 링크는 보존 — 공유 DB 에서 한 사용자가 모두의 태그를 지우는 사고를 막는다.
    내 링크 제거 후 그 태그를 쓰는 링크가 하나도 안 남으면 태그 행도 정리."""
    with get_connection() as conn:
        removed = 0
        row = conn.execute("SELECT id FROM tag WHERE name=?", (name,)).fetchone()
        if row:
            tid = row["id"]
            if account_uid is not None:
                cur = conn.execute(
                    "DELETE FROM gen_tag WHERE tag_id=? AND generation_id IN "
                    "(SELECT id FROM generation WHERE creator_uid=?)",
                    (tid, account_uid),
                )
                removed += cur.rowcount
                if not conn.execute(
                    "SELECT 1 FROM gen_tag WHERE tag_id=? LIMIT 1", (tid,)
                ).fetchone():
                    conn.execute("DELETE FROM tag WHERE id=?", (tid,))
            else:
                cur = conn.execute("DELETE FROM gen_tag WHERE tag_id=?", (tid,))
                removed += cur.rowcount
                conn.execute("DELETE FROM tag WHERE id=?", (tid,))
        # 남의 카드에 단 내 로컬 태그(shadow, gen_tag_overlay)도 함께 제거 — '등록된 태그' 통합 삭제.
        # ★조기반환 제거 필수 — 태그가 tag 테이블엔 없고 shadow 로만 있는 경우(남 카드에만 단 태그)도
        #   지워져야 하므로. 안 그러면 레지스트리엔 뜨는데 삭제가 안 먹는 버그.
        if conn.execute(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='gen_tag_overlay'"
        ).fetchone():
            removed += conn.execute("DELETE FROM gen_tag_overlay WHERE tag=?", (name,)).rowcount
        return removed


def _add_tags(conn: sqlite3.Connection, gen_id: str, tags: Iterable[str]) -> None:
    """태그 union 추가(기존 유지). 번들 병합은 덮어쓰기 아니라 합집합."""
    for name in {t.strip() for t in tags if t and t.strip()}:
        tid = _get_or_create_tag(conn, name)
        conn.execute(
            "INSERT OR IGNORE INTO gen_tag(generation_id, tag_id) VALUES(?,?)",
            (gen_id, tid),
        )

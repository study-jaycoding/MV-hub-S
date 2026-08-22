"""생성본 id 해석 — 로컬 id ↔ 서버 앵커(job_id) 정규화.

공유 번들은 job_id 를 앵커 id 로 쓴다(repo/share.py export_bundle) → 서버의 generation id = job_id,
로컬 id = 별도 uuid 라 서로 다르다. 팀 탭 카드는 서버 앵커(job_id)로 표시돼 로컬 id 와 다르므로,
로컬에서 직접 처리하는 핸들러(color/tags/source/comment/delete/history/cache 등)는 진입부에서
이 해석기를 불러 정규화한다. generations.py 에서 분리(순수 재조직 — 동작 변경 없음).
"""

from __future__ import annotations

import sqlite3
from typing import Any, Optional

from ..db import get_connection
from .generation_rows import _fetch_generation, _fetch_gens  # 단방향 import (id_resolve → generation_rows)
from .personal_meta_transactions import _current_personal_meta_batch_connection


_SQLITE_PAIRED_IN_BATCH = 400  # id/job_id 두 IN 목록을 합쳐도 오래된 SQLite 변수 상한(999) 미만.


def finalize_id_map(any_id: str) -> tuple[Optional[str], str]:
    """(local_id, server_id) 해석.

    공유 번들은 job_id 를 앵커 id 로 쓴다([repo/share.py] export_bundle) → 서버의 generation id =
    job_id, 로컬 id = 별도 uuid 라 서로 다르다. 그래서 finalize/unfinalize 위임 시 변환이 필요:
      · server_id = 그 로컬 행의 job_id(없으면 로컬 id) — 서버가 아는 id.
      · local_id  = 로컬 generation.id — 골드 미러용.
    any_id 가 로컬 id 든(내 작업·히스토리) 서버 job_id 든(팀 탭) 모두 같은 행을 찾는다.
    로컬에 없으면 (None, any_id) — 서버 위임은 받은 id 그대로."""
    with get_connection() as conn:
        row = conn.execute(
            # 중복(레이스 잔재)이 잠시 있어도 결정적으로: id 직접 일치 > 로컬본 > 그 외. (P1-D)
            "SELECT id, job_id FROM generation WHERE id=? OR job_id=? "
            "ORDER BY (id=?) DESC, (origin='local') DESC LIMIT 1",
            (any_id, any_id, any_id),
        ).fetchone()
    if not row:
        return None, any_id
    return row["id"], (row["job_id"] or row["id"])


def resolve_local_id(any_id: str) -> str:
    """any_id(로컬 id 또는 서버 job_id) → 로컬 generation.id. 로컬에 없으면 그대로.

    팀 탭 카드는 서버 번들 앵커(job_id)로 표시돼 로컬 id 와 다르다. 로컬에서 직접 처리하는
    핸들러(color/tags/source/comment/delete/history/cache 등)가 진입부에서 이걸 불러 정규화하면,
    내 카드는 올바른 로컬 행에 적용되고(404 해소), 남의 팀 카드(로컬 행 없음)는 원본 id 그대로 둬
    이어지는 require_edit_generation 이 정상 차단한다.

    ※ 행 데이터까지 필요하면 resolve_and_get 을 써라 — 해석+조회를 단일 커넥션으로 합친다."""
    return finalize_id_map(any_id)[0] or any_id


def resolve_and_get(
    any_id: str, account_uid: Optional[str] = None
) -> tuple[Optional[dict[str, Any]], Optional[str], str]:
    """(gen, local_id, server_id) 를 단일 커넥션·단일 해석으로 반환.

    any_id 가 로컬 id 든 서버 job_id(팀 탭 카드)든 같은 행을 찾는다.
      · gen       = 직렬화된 generation(없으면 None)
      · local_id  = 로컬 generation.id(없으면 None — 남의 팀 카드)
      · server_id = 그 행의 job_id(없으면 로컬 id; 행 자체가 없으면 any_id 그대로)
    로컬에서 직접 처리하는 핸들러가 진입부에서 한 번 부르면 — resolve_local_id + get_generation +
    (미러용) finalize_id_map 을 따로 호출하며 커넥션을 3~5번 열던 중복을 1번으로 합친다."""
    with get_connection() as conn:
        idrow = conn.execute(
            # 결정적 선택: id 직접 일치 > 로컬본 > 그 외(중복 잔재 시 권위 행에 적용). (P1-D)
            "SELECT id, job_id FROM generation WHERE id=? OR job_id=? "
            "ORDER BY (id=?) DESC, (origin='local') DESC LIMIT 1",
            (any_id, any_id, any_id),
        ).fetchone()
        if not idrow:
            return None, None, any_id
        local_id = idrow["id"]
        server_id = idrow["job_id"] or local_id
        return _fetch_generation(conn, local_id, account_uid), local_id, server_id


def resolve_generation_meta_batch(any_ids: list[str]) -> dict[str, dict[str, Any]]:
    """여러 로컬 id/서버 job_id를 개인 메타 저장에 필요한 최소 행으로 일괄 해석한다.

    반환 키는 요청 id 그대로이며 값은 ``id``(로컬 PK), ``job_id``, ``creator_uid``다.
    단건 ``resolve_and_get``처럼 직접 id 일치를 최우선, 그다음 ``origin='local'`` 행을 선택한다.
    개인 메타 배치는 응답 전체를 만들 필요가 없으므로 asset/history/comment 보강 쿼리는 실행하지 않는다.
    """
    requested_ids = list(dict.fromkeys(any_id for any_id in (any_ids or []) if any_id))
    if not requested_ids:
        return {}

    resolved: dict[str, dict[str, Any]] = {}
    ranks: dict[str, tuple[bool, bool]] = {}
    with get_connection() as conn:
        for offset in range(0, len(requested_ids), _SQLITE_PAIRED_IN_BATCH):
            batch = requested_ids[offset:offset + _SQLITE_PAIRED_IN_BATCH]
            placeholders = ",".join("?" * len(batch))
            rows = conn.execute(
                "SELECT id, job_id, creator_uid, origin FROM generation "
                f"WHERE id IN ({placeholders}) OR job_id IN ({placeholders})",
                [*batch, *batch],
            ).fetchall()
            wanted = set(batch)
            for row in rows:
                candidates = {row["id"]}
                if row["job_id"]:
                    candidates.add(row["job_id"])
                value = dict(row)
                for requested in candidates & wanted:
                    rank = (
                        row["id"] == requested,
                        (row["origin"] or "local") == "local",
                    )
                    if requested not in ranks or rank > ranks[requested]:
                        ranks[requested] = rank
                        resolved[requested] = value
    return resolved


def personal_meta_by_anchor(
    anchor_ids: list[str], owner_uid: str
) -> dict[str, dict[str, Any]]:
    """앵커 id(로컬 id 또는 서버 job_id) → 내 로컬 개인메타({color, tags, auto_tags}).

    color/tags 는 작성자 전용(마스킹 대상)이라 서버에 미러하지 않고 로컬에만 둔다. 그래서 팀 탭은
    서버 데이터를 그리지만 '내 카드'의 개인 색·태그는 안 실린다 → 로컬 허브가 이 함수로 자기 DB에서
    가져와 프록시 응답에 덧입힌다(오버레이). id·job_id 양쪽 키로 매핑해 서버 앵커가 어느 쪽이든 잡힌다.
    owner_uid 가 작성자인 행만(남의 카드는 건드리지 않음)."""
    if not anchor_ids or not owner_uid:
        return {}
    with get_connection() as conn:
        ph = ",".join("?" * len(anchor_ids))
        idrows = conn.execute(
            f"SELECT id, job_id FROM generation "
            f"WHERE creator_uid=? AND (id IN ({ph}) OR job_id IN ({ph}))",
            [owner_uid, *anchor_ids, *anchor_ids],
        ).fetchall()
        if not idrows:
            return {}
        full = _fetch_gens(conn, [r["id"] for r in idrows], viewer_uid=owner_uid)
    out: dict[str, dict[str, Any]] = {}
    for r in idrows:
        g = full.get(r["id"])
        if not g:
            continue
        meta = {
            "color": g.get("color"),
            "tags": g.get("tags", []),
            "auto_tags": g.get("auto_tags", []),
        }
        out[r["id"]] = meta
        if r["job_id"]:
            out[r["job_id"]] = meta
    return out


# ── 남의 팀 카드 색 오버레이(gen_color_overlay) ──────────────────────────────
# 팀 탭은 순수 프록시라 '남이 만든' 카드는 로컬 generation 행이 없다. 그런 카드에 다는 '내 로컬 색'은
# generation.color 에 못 넣으므로 이 계정별 전용 테이블에 anchor(job_id 우선, 없으면 서버 id)로 담는다.
# 내 카드 색은 지금처럼 generation.color 가 진실 — 여긴 남의 카드 전용(overlay 가 내 카드는 건너뜀).
def _ensure_color_overlay(conn) -> None:
    # 자가치유 — 비활성 계정DB 로 전환 시 ensure_account_db 가 init_db 를 건너뛰어(경로 존재하면)
    # 마이그레이션이 빠질 수 있어, 접근 시점에 테이블을 보장한다(schema.sql 에도 있음).
    conn.execute(
        "CREATE TABLE IF NOT EXISTS gen_color_overlay (anchor TEXT PRIMARY KEY, color TEXT)"
    )


def set_color_overlay(anchor: str, color: Optional[str]) -> None:
    """남의 팀 카드 '내 로컬 색' 저장(계정DB 전용). color=None 이면 해제(행 삭제)."""
    set_color_overlays_batch([(anchor, color)])


def set_color_overlays_batch(items: list[tuple[str, Optional[str]]]) -> int:
    """여러 팀 카드 색 shadow를 한 트랜잭션으로 저장한다. 같은 anchor는 마지막 값이 이긴다."""
    final_by_anchor: dict[str, Optional[str]] = {}
    for anchor, color in items or []:
        if anchor:
            final_by_anchor[anchor] = color
    if not final_by_anchor:
        return 0

    def apply(conn: sqlite3.Connection) -> None:
        _ensure_color_overlay(conn)
        clear = [(anchor,) for anchor, color in final_by_anchor.items() if color is None]
        if clear:
            conn.executemany("DELETE FROM gen_color_overlay WHERE anchor=?", clear)
        colors = [
            (anchor, color)
            for anchor, color in final_by_anchor.items()
            if color is not None
        ]
        if colors:
            conn.executemany(
                "INSERT INTO gen_color_overlay(anchor, color) VALUES(?,?) "
                "ON CONFLICT(anchor) DO UPDATE SET color=excluded.color",
                colors,
            )

    batch_conn = _current_personal_meta_batch_connection()
    if batch_conn is not None:
        apply(batch_conn)
    else:
        with get_connection() as conn:
            conn.execute("BEGIN IMMEDIATE")
            apply(conn)
    return len(final_by_anchor)


def color_overlay_by_anchors(anchor_ids: list[str]) -> dict[str, str]:
    """앵커(id/job_id) → 내 로컬 색. 팀 탭 overlay 가 남의 카드에 색을 덧입힐 때 쓴다."""
    ids = [a for a in (anchor_ids or []) if a]
    if not ids:
        return {}
    with get_connection() as conn:
        _ensure_color_overlay(conn)
        ph = ",".join("?" * len(ids))
        rows = conn.execute(
            f"SELECT anchor, color FROM gen_color_overlay WHERE anchor IN ({ph})", ids
        ).fetchall()
    return {r["anchor"]: r["color"] for r in rows}


# ── 남의 팀 카드 태그 오버레이(gen_tag_overlay) ──────────────────────────────
# 색과 동형이되 태그는 리스트라 (anchor, tag) 다중행. 레지스트리("등록된 태그")는 DISTINCT tag 로 뽑는다.
def _ensure_tag_overlay(conn) -> None:
    conn.execute(
        "CREATE TABLE IF NOT EXISTS gen_tag_overlay "
        "(anchor TEXT NOT NULL, tag TEXT NOT NULL, PRIMARY KEY(anchor, tag))"
    )


def set_tags_overlay(anchor: str, tags: list[str]) -> None:
    """남의 팀 카드 '내 로컬 태그' 저장(계정DB 전용, 전체 교체). 빈 리스트면 해제."""
    set_tag_overlays_batch([(anchor, tags)])


def set_tag_overlays_batch(items: list[tuple[str, list[str]]]) -> int:
    """여러 팀 카드 태그 shadow를 한 트랜잭션으로 전체 교체한다. 같은 anchor는 마지막 값이 이긴다."""
    final_by_anchor: dict[str, list[str]] = {}
    for anchor, names in items or []:
        if anchor:
            final_by_anchor[anchor] = [
                name.strip() for name in (names or []) if name and name.strip()
            ]
    if not final_by_anchor:
        return 0

    def apply(conn: sqlite3.Connection) -> None:
        _ensure_tag_overlay(conn)
        conn.executemany(
            "DELETE FROM gen_tag_overlay WHERE anchor=?",
            [(anchor,) for anchor in final_by_anchor],
        )
        links = [
            (anchor, tag)
            for anchor, names in final_by_anchor.items()
            for tag in names
        ]
        if links:
            conn.executemany(
                "INSERT OR IGNORE INTO gen_tag_overlay(anchor, tag) VALUES(?,?)",
                links,
            )

    batch_conn = _current_personal_meta_batch_connection()
    if batch_conn is not None:
        apply(batch_conn)
    else:
        with get_connection() as conn:
            conn.execute("BEGIN IMMEDIATE")
            apply(conn)
    return len(final_by_anchor)


def tags_overlay_by_anchors(anchor_ids: list[str]) -> dict[str, list[str]]:
    """앵커(id/job_id) → 내 로컬 태그 목록. 팀 탭 overlay 가 남의 카드에 태그를 덧입힐 때 쓴다."""
    ids = [a for a in (anchor_ids or []) if a]
    if not ids:
        return {}
    with get_connection() as conn:
        _ensure_tag_overlay(conn)
        ph = ",".join("?" * len(ids))
        rows = conn.execute(
            f"SELECT anchor, tag FROM gen_tag_overlay WHERE anchor IN ({ph}) ORDER BY tag", ids
        ).fetchall()
    out: dict[str, list[str]] = {}
    for r in rows:
        out.setdefault(r["anchor"], []).append(r["tag"])
    return out

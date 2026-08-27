"""히스토리 계보(lineage) — 부모/자식 엣지 기록·제거, 전이축소, 파생깊이, 방향성 라인집합, 노드 가시성.

generations.py 에서 분리(관심사 분리). 여기의 순수/mutation 헬퍼를 generations·history 가 import 해서 쓴다
(단방향: generations → lineage, history → lineage). 공개 조회 함수 get_history/get_history_graph 는
history.py 에 있고, 여기의 _derived_depth_batch/_gen_row_visible 를 가져다 쓴다.
"""
from __future__ import annotations

import sqlite3
from typing import Any, Optional

from ..db import get_connection
from ._common import new_id


def _record_history(
    conn: sqlite3.Connection, parent_gen_id: str, child_gen_id: str, relation: str
) -> bool:
    """히스토리 엣지 1개 기록(멱등) — (parent,child,relation) 유니크. 부모가 실재할 때만.
    relation: 'derived'(재생성/가져오기) | 'reference'(@소스로 생성)."""
    if not parent_gen_id or parent_gen_id == child_gen_id:
        return False
    if not conn.execute(
        "SELECT 1 FROM generation WHERE id=?", (parent_gen_id,)
    ).fetchone():
        return False  # 소스가 우리 DB에 없으면(외부 등) 엣지 생략 — FK 위반 방지
    conn.execute(
        "INSERT OR IGNORE INTO history(id, parent_gen_id, child_gen_id, relation) "
        "VALUES(?,?,?,?)",
        (new_id(), parent_gen_id, child_gen_id, relation),
    )
    return True


def _descendants(conn: sqlite3.Connection, root: str) -> set[str]:
    """root 의 모든 자손 id(모든 relation). 순환 검사·전이 축소용.

    ``UNION``(not ``UNION ALL``)이 이미 본 id를 재귀 큐에 다시 넣지 않으므로 순환·자기참조도
    종료한다. frontier 크기만큼 SQL 변수를 만들던 Python BFS와 달리 변수는 root 하나뿐이다.
    """
    return {
        r["id"]
        for r in conn.execute(
            "WITH RECURSIVE descendants(id) AS ("
            "  SELECT child_gen_id FROM history WHERE parent_gen_id=? "
            "  UNION "
            "  SELECT h.child_gen_id FROM history h "
            "  JOIN descendants d ON h.parent_gen_id=d.id"
            ") SELECT id FROM descendants",
            (root,),
        ).fetchall()
    }


def _limited_ids(rows: list[sqlite3.Row], limit: int) -> tuple[set[str], bool]:
    """limit+1 행을 정확한 상한 집합과 실제 절단 여부로 바꾼다."""
    if limit < 1:
        raise ValueError("lineage limit은 1 이상이어야 합니다.")
    return {r["id"] for r in rows[:limit]}, len(rows) > limit


def _connected_lineage(
    conn: sqlite3.Connection, gen_id: str, limit: int = 300
) -> tuple[set[str], bool]:
    """양방향 연결 컴포넌트를 ``(최대 limit개, 실제 절단 여부)``로 반환한다.

    limit 계약: 양수이며 focus 자신도 1개로 센다. SQLite 재귀 CTE의 기본 FIFO 큐를 써서
    graph hop이 가까운 노드를 먼저 고르고, 같은 hop 안의 선택 순서는 DB 탐색 순서다. 반환 API의
    노드 순서는 이 탐색 순서가 아니라 기존처럼 ``sort_ts``가 결정한다.

    CTE 행은 id 하나라 ``UNION`` 중복 제거가 순환·자기참조를 끝낸다. limit+1개만 읽어
    상한을 넘기지 않으면서 실제로 생략된 노드가 있는지도 구분한다.
    """
    if limit < 1:
        raise ValueError("lineage limit은 1 이상이어야 합니다.")
    rows = conn.execute(
        "WITH RECURSIVE connected(id) AS ("
        "  VALUES(?) "
        "  UNION "
        "  SELECT h.child_gen_id FROM history h "
        "  JOIN connected c ON h.parent_gen_id=c.id "
        "  UNION "
        "  SELECT h.parent_gen_id FROM history h "
        "  JOIN connected c ON h.child_gen_id=c.id"
        ") SELECT id FROM connected LIMIT ?",
        (gen_id, limit + 1),
    ).fetchall()
    return _limited_ids(rows, limit)


def _directed_lineage_window(
    conn: sqlite3.Connection, gen_id: str, limit: int = 300
) -> tuple[set[str], bool]:
    """곁가지를 제외한 조상+자손 라인을 정확한 상한과 함께 반환한다.

    기존 비소유 공유물 계약을 보존해 focus에서 가까운 조상을 먼저, 남은 자리에 가까운 자손을
    넣는다. 각 CTE는 id만 ``UNION``하므로 손상 DB의 순환·자기참조에서도 종료한다.
    """
    if limit < 1:
        raise ValueError("lineage limit은 1 이상이어야 합니다.")
    rows = conn.execute(
        "WITH RECURSIVE "
        "ancestors(id) AS ("
        "  VALUES(?) "
        "  UNION "
        "  SELECT h.parent_gen_id FROM history h "
        "  JOIN ancestors a ON h.child_gen_id=a.id"
        "), "
        "descendants(id) AS ("
        "  VALUES(?) "
        "  UNION "
        "  SELECT h.child_gen_id FROM history h "
        "  JOIN descendants d ON h.parent_gen_id=d.id"
        ") "
        "SELECT id FROM ancestors "
        "UNION ALL "
        "SELECT id FROM descendants WHERE id NOT IN (SELECT id FROM ancestors) "
        "LIMIT ?",
        (gen_id, gen_id, limit + 1),
    ).fetchall()
    return _limited_ids(rows, limit)


def _derived_depth_batch(
    conn: sqlite3.Connection, ids: list[str]
) -> dict[str, int]:
    """각 id 의 'derived' 조상 수(자기 버전 체인 깊이, 루트=0)를 **레벨별 일괄 조회**로 계산.
    예전엔 id 마다 체인을 따로 while-조회(N+1)했으나, 같은 깊이의 커서를 한 번의 IN 쿼리로
    묶어 올려 조회 수를 체인 길이(보통 1~5회)로 줄인다. id 별 방문집합으로 순환 방어."""
    depth = {i: 0 for i in ids}
    cursor = {i: i for i in ids}  # 각 시작 노드의 현재 체인 끝
    seen = {i: {i} for i in ids}  # 시작 노드별 방문집합(순환 방어)
    active = list(dict.fromkeys(ids))  # 중복 제거, 순서 보존
    while active:
        cur_ids = list({cursor[i] for i in active})
        ph = ",".join("?" * len(cur_ids))
        parent_of = {
            r["child_gen_id"]: r["parent_gen_id"]
            for r in conn.execute(
                f"SELECT child_gen_id, parent_gen_id FROM history "
                f"WHERE relation='derived' AND child_gen_id IN ({ph})",
                cur_ids,
            ).fetchall()
        }
        nxt: list[str] = []
        for i in active:
            p = parent_of.get(cursor[i])
            if not p or p in seen[i]:
                continue
            cursor[i] = p
            seen[i].add(p)
            depth[i] += 1
            nxt.append(i)
        active = nxt
    return depth


def add_history_edge(
    parent_gen_id: str, child_gen_id: str, relation: str = "derived"
) -> bool:
    """수동 히스토리 연결(동기화 잡 등 자동 히스토리가 없는 결과물을 손으로 묶기). 멱등.
    순환(부모가 자식의 자손)·자기참조·없는 부모는 거부(ValueError/False)."""
    if relation not in ("derived", "reference"):
        relation = "derived"
    if not parent_gen_id or parent_gen_id == child_gen_id:
        raise ValueError("자기 자신을 부모로 지정할 수 없습니다.")
    with get_connection() as conn:
        # 순환 검사(자손 조회)와 엣지 삽입을 한 트랜잭션으로 — 그 사이 다른 요청이 반대 방향
        # 엣지를 넣어 사이클이 생기는 경쟁을 IMMEDIATE(즉시 쓰기락)로 막는다.
        conn.execute("BEGIN IMMEDIATE")
        try:
            if not conn.execute(
                "SELECT 1 FROM generation WHERE id=?", (child_gen_id,)
            ).fetchone():
                raise ValueError(f"없는 generation: {child_gen_id}")
            if not conn.execute(
                "SELECT 1 FROM generation WHERE id=?", (parent_gen_id,)
            ).fetchone():
                raise ValueError(f"없는 부모 generation: {parent_gen_id}")
            if parent_gen_id in _descendants(conn, child_gen_id):
                raise ValueError("순환이 생깁니다(그 부모는 이 결과물의 자손입니다).")
            ok = _record_history(conn, parent_gen_id, child_gen_id, relation)
            conn.execute("COMMIT")
            return ok
        except Exception:
            conn.execute("ROLLBACK")
            raise


def record_derived_parents(child_id: str, parent_ids: list[str]) -> list[str]:
    """파생 부모(들)를 'derived' 엣지로 기록하되 **전이 축소**한다.

    후보 중 다른 후보(또는 child)의 **조상**인 것은 잉여(그 자손을 거쳐 이미 도달 가능) → 기록 안 함.
    가장 가까운 부모만 남겨 계보 그래프가 평탄해지지 않게 한다(원본→중간→자식 체인 보존).
    드래그 부모 + 보드 포커스/선택이 합쳐져 들어와도 항상 깔끔한 체인. 기록한 부모 목록 반환."""
    # 중복·자기참조 제거(입력 순서 보존)
    cands = [p for p in dict.fromkeys(parent_ids or []) if p and p != child_id]
    if not cands:
        return []
    with get_connection() as conn:
        # 실재하는 후보만(없는 부모는 조상 판정에서도 제외)
        cands = [
            p
            for p in cands
            if conn.execute("SELECT 1 FROM generation WHERE id=?", (p,)).fetchone()
        ]
        if not cands:
            return []
        # 각 후보의 자손 집합으로 'p 가 다른 후보/child 의 조상인지' 판정 → 그러면 p 는 잉여.
        targets = set(cands) | {child_id}
        kept = [
            p
            for p in cands
            if not (_descendants(conn, p) & (targets - {p}))
        ]
        for p in kept:
            _record_history(conn, p, child_id, "derived")
        return kept


def remove_history_edge(parent_gen_id: str, child_gen_id: str) -> bool:
    """히스토리 엣지 제거(잘못 묶인 것 풀기). 멱등."""
    with get_connection() as conn:
        cur = conn.execute(
            "DELETE FROM history WHERE parent_gen_id=? AND child_gen_id=?",
            (parent_gen_id, child_gen_id),
        )
        return cur.rowcount > 0


def _gen_row_visible(
    g: Optional[dict[str, Any]], viewer_uid: Optional[str], read_all: bool
) -> bool:
    """계보(history) 노드 가시성 — 공유된 것/내 것/전역 read_all 만 노출.
    원칙: 내가 볼 수 없는 남의 비공개 생성물은 계보에서도 빼서 프롬프트·파라미터 유출을 막는다."""
    if not g:
        return False
    if read_all or g.get("shared"):
        return True
    return bool(viewer_uid) and g.get("creator_uid") == viewer_uid

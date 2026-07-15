"""생성본 가계(히스토리) 조회 — 공개 조회 API.

get_history: 한 결과물 기준 relation 별 분리(조상/재료/자식/사용처/약한형제).
get_history_graph: 연결된 가계 전체(노드+엣지+루트) — 구성탭 히스토리 트리용.
둘 다 read-only 조회. generations.py 에서 분리(순수 재조직 — 동작 변경 없음).
private edge-recording/traversal 헬퍼는 lineage.py 에 있고, 여기서 import 해서 쓴다(단방향).
"""

from __future__ import annotations

from typing import Any, Optional

from ..db import get_connection
from .generation_rows import _fetch_gens  # 완전 직렬화 행 페치(단방향 import)
from .lineage import (  # history 조회가 쓰는 lineage private helper (단방향: history → lineage)
    _derived_depth_batch,
    _directed_lineage,
    _gen_row_visible,
)


def get_history(
    gen_id: str, viewer_uid: Optional[str] = None, read_all: bool = True
) -> Optional[dict[str, Any]]:
    """한 결과물의 가계(히스토리) — relation 별로 분리:
        {ancestors:[파생 부모→…→루트], materials:[쓴 @소스], target,
         children:[파생 버전], used_by:[이걸 @소스로 쓴 것]}.

    - ancestors: 'derived' 부모를 위로 따라간 버전 체인(루트가 마지막).
    - materials: 이 결과물이 @소스로 쓴 'reference' 부모들(재료 ⬆).
    - children: 이 결과물을 부모로 한 'derived' 파생 버전(최신순).
    - used_by: 이 결과물을 @소스로 쓴 'reference' 자식들(사용처, 최신순).
    모두 완전 직렬화된 generation. 순환·중복은 방문집합으로 방어. 없는 id 면 None."""
    with get_connection() as conn:
        if not conn.execute("SELECT 1 FROM generation WHERE id=?", (gen_id,)).fetchone():
            return None
        # 조상 체인: 'derived' 부모만 위로 따라간다(버전 히스토리).
        anc_ids: list[str] = []
        seen = {gen_id}
        cur = gen_id
        while True:
            row = conn.execute(
                "SELECT parent_gen_id FROM history WHERE child_gen_id=? AND relation='derived' LIMIT 1",
                (cur,),
            ).fetchone()
            if not row or row["parent_gen_id"] in seen:
                break
            pid = row["parent_gen_id"]
            anc_ids.append(pid)
            seen.add(pid)
            cur = pid
        material_ids = [
            r["parent_gen_id"]
            for r in conn.execute(
                "SELECT parent_gen_id FROM history WHERE child_gen_id=? AND relation='reference'",
                (gen_id,),
            ).fetchall()
        ]
        child_ids = [
            r["child_gen_id"]
            for r in conn.execute(
                "SELECT child_gen_id FROM history WHERE parent_gen_id=? AND relation='derived'",
                (gen_id,),
            ).fetchall()
        ]
        used_by_ids = [
            r["child_gen_id"]
            for r in conn.execute(
                "SELECT child_gen_id FROM history WHERE parent_gen_id=? AND relation='reference'",
                (gen_id,),
            ).fetchall()
        ]
        # 약한 형제(Phase C) — 같은 입력 소스(레퍼런스 URL)를 공유한 다른 결과물.
        # 동기화 잡은 자동 히스토리가 없으므로(힉스필드 원본에 부모 없음) 입력 소스 동일성으로 묶는다.
        ref_keys = [
            r["k"]
            for r in conn.execute(
                "SELECT DISTINCT COALESCE(r.source_url, r.file_path) k FROM gen_reference gr "
                "JOIN reference r ON r.id = gr.reference_id WHERE gr.generation_id = ?",
                (gen_id,),
            ).fetchall()
            if r["k"]
        ]
        sibling_ids: list[str] = []
        if ref_keys:
            exclude = {gen_id, *anc_ids, *material_ids, *child_ids, *used_by_ids}
            kph = ",".join("?" * len(ref_keys))
            for r in conn.execute(
                f"SELECT DISTINCT gr.generation_id gid FROM gen_reference gr "
                f"JOIN reference r ON r.id = gr.reference_id "
                f"JOIN generation g ON g.id = gr.generation_id "
                f"WHERE COALESCE(r.source_url, r.file_path) IN ({kph}) "
                f"AND g.deleted_at IS NULL",
                ref_keys,
            ).fetchall():
                if r["gid"] not in exclude:
                    sibling_ids.append(r["gid"])
                    exclude.add(r["gid"])
            sibling_ids = sibling_ids[:24]  # 과도한 목록 방지(상한)
        # 형제를 깊이별로 묶어 보여주기 위한 각 형제의 'derived' 체인 깊이(일괄 조회).
        sib_depth = _derived_depth_batch(conn, sibling_ids)
        gens = _fetch_gens(
            conn,
            [gen_id, *anc_ids, *material_ids, *child_ids, *used_by_ids, *sibling_ids],
            viewer_uid=viewer_uid,
        )
    me = gens.get(gen_id)
    if not me:
        return None
    # 가시성 정책: **공유된(=내가 볼 수 있는) 결과물의 계보는 전부 노출**한다 — 다른 작업자도 이
    # 결과물이 어떻게 만들어졌는지(조상·재료, 연결된 라인)를 확인할 수 있어야 하기 때문. 라우터가
    # 포커스 가시성을 이미 보장하므로, 포커스가 보이면 중간에 공유 안 된 노드라도 계보 안에선 보인다.
    # (포커스를 못 보는 방어적 경우에만 노드별로 거른다 — 보통 라우터가 먼저 404.)
    focus_visible = _gen_row_visible(me, viewer_uid, read_all)

    def _vis(i: str) -> bool:
        return focus_visible or _gen_row_visible(gens.get(i), viewer_uid, read_all)

    anc_ids = [i for i in anc_ids if _vis(i)]
    material_ids = [i for i in material_ids if _vis(i)]
    child_ids = [i for i in child_ids if _vis(i)]
    used_by_ids = [i for i in used_by_ids if _vis(i)]
    sibling_ids = [i for i in sibling_ids if _vis(i)]

    def _newest(ids: list[str]) -> list[dict[str, Any]]:
        return sorted(
            (gens[i] for i in ids if i in gens),
            key=lambda g: g.get("sort_ts") or 0,
            reverse=True,
        )

    return {
        "ancestors": [gens[i] for i in anc_ids if i in gens],  # 부모 → 루트 순
        "materials": _newest(material_ids),
        "target": me,
        "children": _newest(child_ids),
        "used_by": _newest(used_by_ids),
        # 형제엔 깊이를 실어 보낸다(프론트에서 깊이별 그룹화 + 깊이로 연결 방향 결정).
        "siblings": [{**s, "depth": sib_depth.get(s["id"], 0)} for s in _newest(sibling_ids)],
    }


def get_history_graph(
    gen_id: str, limit: int = 300, viewer_uid: Optional[str] = None, read_all: bool = True
) -> Optional[dict[str, Any]]:
    """gen_id 가 속한 **연결된 가계 전체**(노드+엣지+루트) — 구성탭 히스토리 트리용.

    history 엣지를 양방향으로 따라 연결 컴포넌트를 모으고(약한형제는 제외 — 명시 엣지만),
    그 안의 모든 엣지(relation 포함)와 완전 직렬화된 generation 을 돌려준다.
    roots = 컴포넌트 안에서 들어오는 엣지가 없는 노드(원본). 없는 id 면 None.
    limit: 안전 상한(폭주 방지) — BFS 가 이 수에 닿으면 멈춘다."""
    with get_connection() as conn:
        if not conn.execute("SELECT 1 FROM generation WHERE id=?", (gen_id,)).fetchone():
            return None
        # 가시 범위 결정: 내 작업(또는 read_all)이면 연결된 가계 **전체**(형제·곁가지 포함),
        # 남의 공유물을 보는 타 작업자에겐 이 결과물의 **연결된 라인만**(조상+자손, 형제·곁가지 제외).
        frow = conn.execute(
            "SELECT creator_uid FROM generation WHERE id=?", (gen_id,)
        ).fetchone()
        focus_owned = bool(viewer_uid) and frow and frow["creator_uid"] == viewer_uid
        truncated = False
        if read_all or focus_owned:
            # 연결 컴포넌트 BFS(부모·자식 양방향). 명시 history 엣지만(약한형제 제외).
            node_ids: set[str] = {gen_id}
            frontier = [gen_id]
            while frontier and len(node_ids) < limit:
                ph = ",".join("?" * len(frontier))
                neigh = [
                    r["x"]
                    for r in conn.execute(
                        f"SELECT child_gen_id x FROM history WHERE parent_gen_id IN ({ph}) "
                        f"UNION SELECT parent_gen_id x FROM history WHERE child_gen_id IN ({ph})",
                        [*frontier, *frontier],
                    ).fetchall()
                ]
                frontier = [n for n in neigh if n not in node_ids]
                node_ids.update(frontier)
            truncated = bool(frontier)  # 확장할 이웃이 남았는데 limit 에서 멈췄다 → 일부 생략됨
        else:
            node_ids = _directed_lineage(conn, gen_id, limit)
            truncated = len(node_ids) >= limit
        ids = list(node_ids)
        iph = ",".join("?" * len(ids))
        # 절단 경계 가짜 루트 방지: '전체 history 기준 부모 엣지가 있는' 노드 집합. BFS 가 limit 에서
        # 잘리면 경계 노드의 실제 부모가 ids 밖에 있어 안쪽 엣지엔 안 잡혀 가짜 '원본'으로 표시됐다.
        # 전체 history 로 부모 유무를 판정해 루트에서 제외(부모가 마스킹/절단으로 안 보여도 원본 아님).
        parented = {
            r["c"]
            for r in conn.execute(
                f"SELECT DISTINCT child_gen_id c FROM history WHERE child_gen_id IN ({iph})", ids
            ).fetchall()
        }
        edges = [
            {"parent_gen_id": r["parent_gen_id"], "child_gen_id": r["child_gen_id"], "relation": r["relation"]}
            for r in conn.execute(
                f"SELECT parent_gen_id, child_gen_id, relation FROM history "
                f"WHERE parent_gen_id IN ({iph}) AND child_gen_id IN ({iph})",
                [*ids, *ids],
            ).fetchall()
        ]
        gens = _fetch_gens(conn, ids, viewer_uid=viewer_uid)
    if gen_id not in gens:
        return None
    # 가시성 정책: 포커스(공유물)가 보이면 **연결된 가계 전체를 노출**한다 — 중간에 공유 안 된
    # 노드가 있어도 계보 라인이 끊기지 않게(다른 작업자도 이 결과물의 연결 라인을 본다). 포커스를
    # 못 보는 방어적 경우에만 노드별로 거르고, 그 노드에 닿는 엣지도 끊는다(라우터가 보통 먼저 404).
    if not _gen_row_visible(gens.get(gen_id), viewer_uid, read_all):
        gens = {
            i: g for i, g in gens.items() if _gen_row_visible(g, viewer_uid, read_all)
        }
        if gen_id not in gens:
            return None
    edges = [
        e
        for e in edges
        if e["parent_gen_id"] in gens and e["child_gen_id"] in gens
    ]
    ids = list(gens.keys())
    # 루트 = 전체 history 에 부모가 없는 진짜 원본. 안쪽 엣지 유무가 아니라 parented(전체 기준)로
    # 판정 → 절단/마스킹으로 부모가 안 보이는 경계 노드가 가짜 원본으로 표시되지 않는다.
    roots = [
        gens[i]
        for i in sorted(ids, key=lambda x: gens[x].get("sort_ts") or 0)
        if i not in parented
    ]
    nodes = sorted(gens.values(), key=lambda g: g.get("sort_ts") or 0)
    return {
        "nodes": nodes,
        "edges": edges,
        "root_ids": [r["id"] for r in roots],
        "focus_id": gen_id,
        "truncated": truncated,
    }

"""generation 행 보강(row enrichment) — 조회 결과 dict 목록에 assets/references/tags/auto_tags/
shared/parent·child·source 계보요약/코멘트뱃지/프로젝트이름/개인화마스킹을 붙인다.

generations.py 에서 분리. list_generations/get_history/get_history_graph/search_sources 가 공통으로
쓰는 '조회 응답 보강' 헬퍼라 별도 모듈로 뺐다(단방향: 이 모듈은 generations 를 import 하지 않는다 —
SQL + identity/_common 헬퍼만 쓴다). 순환 방지의 핵심.
"""
from __future__ import annotations

import json
import sqlite3
from typing import Any, Optional

from ..config import DEFAULT_WORKER_ID
from ._common import ALERT_COMMENT_JOINS, ALERT_COMMENT_PREDICATE
from .identity import get_my_uid, resolve_display_names


def _attach_children(
    conn: sqlite3.Connection,
    gens: list[dict[str, Any]],
    viewer_id: str = DEFAULT_WORKER_ID,
    viewer_uid: Optional[str] = None,
) -> list[dict[str, Any]]:
    """generation dict 목록에 assets/references/tags/shared/parent 를 채운다.
    viewer_uid(로그인 계정 creator_uid)가 있으면 프로젝트 이름을 채우고(uuid 노출 금지),
    남의 공유물은 작성자 개인설정(컬러·태그)을 숨긴다(프롬프트·소스·공유여부만 공유)."""
    if not gens:
        return gens
    ids = [g["id"] for g in gens]
    placeholders = ",".join("?" * len(ids))
    by_id = {g["id"]: g for g in gens}
    for g in gens:
        g["assets"] = []
        g["references"] = []
        g["tags"] = []
        g["auto_tags"] = []  # 별도 네임스페이스 — 필터 사이드바 전용(카드·# 피커엔 안 씀)
        g["shared"] = False
        g["parent_gen_id"] = None
        g["child_count"] = 0  # 이 결과물을 부모로 한 파생/사용 수(히스토리 뱃지 ⑂N)
        g["source_count"] = 0  # 이 결과물이 @소스로 쓴 재료(reference 부모) 수
        g["params"] = json.loads(g["params"]) if g.get("params") else None
        g["deleted"] = bool(g.get("deleted_at"))  # 휴지통 여부(카드 흐림·복구 버튼용)
        if "is_source" in g:
            g["is_source"] = bool(g["is_source"])
        if "is_final" in g:
            g["is_final"] = bool(g["is_final"])  # v02 CMS 최종(골드) 여부

    # 생성자(creator_uid) → is_mine + 사용자 지정 이름.
    # is_mine 기준은 '보고 있는 로그인 계정'(viewer_uid)이 우선 — house 가 아닌 계정도 자기 작업이
    # is_mine=true 가 되게 한다. viewer_uid 없으면(단독/AUTH off) 서버 제공자 신원으로 폴백.
    # uid 없을 때: 신원이 정해지기 전(단일 사용자)이면 내 것 취급(옛 데이터 보존), 정해진 팀 모드면 단정 안 함.
    my_uid = viewer_uid or get_my_uid()
    cuids = {g.get("creator_uid") for g in gens if g.get("creator_uid")}
    # 작성자 표시이름 — 사이드바·멤버·코멘트와 동일한 단일 해석기(creator.name → account.name →
    # 이메일 로컬파트). 읽기 시점 해석이라 표시이름 변경이 즉시 전파된다.
    cnames = resolve_display_names(conn, cuids)
    for g in gens:
        cu = g.get("creator_uid")
        g["is_mine"] = (cu == my_uid) if cu else (my_uid is None)
        g["creator_name"] = cnames.get(cu)

    for r in conn.execute(
        f"SELECT id, generation_id, type, file_path, thumbnail_path, source_url "
        f"FROM asset WHERE generation_id IN ({placeholders})",
        ids,
    ).fetchall():
        d = dict(r)
        d["cached"] = bool(d.get("file_path", "").startswith("/media/"))
        by_id[d["generation_id"]]["assets"].append(d)

    for r in conn.execute(
        f"SELECT gr.generation_id, r.id, r.type, r.file_path, r.thumbnail_path, "
        f"r.source, r.source_url, gr.role FROM gen_reference gr "
        f"JOIN reference r ON r.id = gr.reference_id "
        f"WHERE gr.generation_id IN ({placeholders}) "
        f"ORDER BY gr.rowid",  # 삽입(=제출) 순서 보장 → 인라인 칩 위치 매칭
        ids,
    ).fetchall():
        d = dict(r)
        gid = d.pop("generation_id")
        d["cached"] = bool(d.get("file_path", "").startswith("/media/"))
        by_id[gid]["references"].append(d)

    for r in conn.execute(
        f"SELECT gt.generation_id, t.name FROM gen_tag gt "
        f"JOIN tag t ON t.id = gt.tag_id "
        f"WHERE gt.generation_id IN ({placeholders})",
        ids,
    ).fetchall():
        by_id[r["generation_id"]]["tags"].append(r["name"])

    # 자동 태그(별도 네임스페이스) — 사이드바 필터 전용. 카드/# 피커는 gen.tags 만 읽으므로 누출 없음.
    for r in conn.execute(
        f"SELECT gat.generation_id, a.name FROM gen_auto_tag gat "
        f"JOIN auto_tag a ON a.id = gat.auto_tag_id "
        f"WHERE gat.generation_id IN ({placeholders})",
        ids,
    ).fetchall():
        by_id[r["generation_id"]]["auto_tags"].append(r["name"])

    for r in conn.execute(
        f"SELECT DISTINCT generation_id FROM share "
        f"WHERE generation_id IN ({placeholders})",
        ids,
    ).fetchall():
        by_id[r["generation_id"]]["shared"] = True

    # 파생 부모(강한 — derived만): 카드 ↻ 뱃지·버전 체인. reference 부모는 source_count 로 따로.
    for r in conn.execute(
        f"SELECT child_gen_id, parent_gen_id FROM history "
        f"WHERE child_gen_id IN ({placeholders}) AND relation='derived'",
        ids,
    ).fetchall():
        by_id[r["child_gen_id"]]["parent_gen_id"] = r["parent_gen_id"]

    # 파생/사용 수(이 결과물이 부모 — 모든 relation): 카드 ⑂N 뱃지용. 배치로 N+1 회피.
    for r in conn.execute(
        f"SELECT parent_gen_id, COUNT(*) AS c FROM history "
        f"WHERE parent_gen_id IN ({placeholders}) GROUP BY parent_gen_id",
        ids,
    ).fetchall():
        if r["parent_gen_id"] in by_id:
            by_id[r["parent_gen_id"]]["child_count"] = r["c"]

    # 재료 수(이 결과물이 @소스로 쓴 reference 부모 개수) — 뱃지 표시 조건 보강(소스만 있어도 표시).
    for r in conn.execute(
        f"SELECT child_gen_id, COUNT(*) AS c FROM history "
        f"WHERE child_gen_id IN ({placeholders}) AND relation='reference' GROUP BY child_gen_id",
        ids,
    ).fetchall():
        if r["child_gen_id"] in by_id:
            by_id[r["child_gen_id"]]["source_count"] = r["c"]

    # 공유 코멘트 스레드 메타: 글 수 + 미확인 여부(뷰어=로그인 viewer_uid, 내 글 제외).
    # 그리드 C 뱃지가 카드마다 떠야 하므로 list 경로에서 배치로 계산(N+1 회피).
    for g in gens:
        g["comment_count"] = 0
        g["has_unread"] = False
    for r in conn.execute(
        f"SELECT gen_id, COUNT(*) AS cnt FROM generation_comment "
        f"WHERE gen_id IN ({placeholders}) GROUP BY gen_id",
        ids,
    ).fetchall():
        by_id[r["gen_id"]]["comment_count"] = r["cnt"]
    # 코멘트 단위 미확인(seen 행 없음) + 알림 정책. 패널에서 개별 코멘트를 클릭해 확인하면 그 행이
    # seen 에 들어가고, 그 gen 의 알림 대상 코멘트가 모두 seen 이면 C 뱃지가 꺼진다.
    # ★ 뷰어는 로그인 계정(viewer_uid) — 패널 seen 기록과 동일 신원이어야 뱃지가 꺼진다.
    #   비로그인(AUTH off)이면 viewer_id('me') 로 폴백.
    # ★ 알림 정책: ① 내가 만든 생성물에 달린 코멘트(g.creator_uid=뷰어), 또는 ② 내 코멘트에 달린
    #   답글(부모 코멘트 author=뷰어)만 알림. 내가 쓴 코멘트는 제외(author<>뷰어). 그 외는 패널에서
    #   볼 수 있어도 알림(뱃지·NEW)은 울리지 않는다 — _alert_comments_sql 로 list/stats 와 규칙 통일.
    cviewer = viewer_uid if viewer_uid is not None else viewer_id
    for r in conn.execute(
        f"SELECT DISTINCT c.gen_id FROM generation_comment c "
        f"{ALERT_COMMENT_JOINS} "
        f"WHERE c.gen_id IN ({placeholders}) AND {ALERT_COMMENT_PREDICATE}",
        [cviewer, *ids, cviewer, cviewer, cviewer],
    ).fetchall():
        by_id[r["gen_id"]]["has_unread"] = True

    # 프로젝트 이름(코드 인식용 uuid 를 사용자에게 노출하지 않는다 — 브라우저 표기는 항상 이름).
    pids = {g["project_id"] for g in gens if g.get("project_id")}
    if pids:
        ph2 = ",".join("?" * len(pids))
        pnames = {
            r["id"]: r["name"]
            for r in conn.execute(
                f"SELECT id, name FROM project WHERE id IN ({ph2})", list(pids)
            ).fetchall()
        }
    else:
        pnames = {}
    for g in gens:
        g["project_name"] = pnames.get(g.get("project_id"))
        # 남의 공유물을 볼 때: 작성자 개인설정(컬러·태그)은 공유하지 않는다.
        # 공유되는 것은 프롬프트·소스(레퍼런스)·공유여부까지. 본인·단독(viewer_uid 없음)은 그대로.
        if viewer_uid and g.get("creator_uid") and g["creator_uid"] != viewer_uid:
            g["color"] = None
            g["tags"] = []
            g["auto_tags"] = []

    return gens


_GEN_SELECT_COLS = (
    "g.id, g.worker_id, w.name AS worker_name, g.prompt, g.display_prompt, g.model, "
    "g.params, g.color, g.status, g.created_at, g.sort_ts, g.is_source, g.source_name, "
    "g.comment, g.error, g.creator_uid, g.project_id, g.folder_path, g.deleted_at, g.is_final, g.final_by, "
    # 이 컬럼셋은 단건 조회(_fetch_generation)·_fetch_gens 가 공유한다. job_id 필드를 가진 응답 모델은
    # GenerationOut(단건 액션 응답)뿐이라 API 노출은 단건에 그친다(목록 SELECT·HistoryOut 엔 job_id 없음).
    # 로컬↔서버 미러가 이 앵커로 팀 카드(서버 UUID)↔로컬 행을 잇는다.
    "g.job_id, "
    "(g.job_id IS NULL OR g.job_id='' OR g.hf_missing=1) AS local_only "
    "FROM generation g LEFT JOIN worker w ON w.id = g.worker_id"
)


def _fetch_generation(
    conn: sqlite3.Connection, gen_id: str, account_uid: Optional[str] = None
) -> Optional[dict[str, Any]]:
    """주어진 커넥션에서 generation 한 건 직렬화(자식 첨부 포함). 없으면 None.
    get_generation / resolve_and_get 가 공유 — 같은 요청에서 커넥션을 재사용해 중복 오픈을 막는다."""
    row = conn.execute(
        f"SELECT {_GEN_SELECT_COLS} WHERE g.id = ?", (gen_id,)
    ).fetchone()
    if not row:
        return None
    return _attach_children(conn, [dict(row)], viewer_uid=account_uid)[0]


def _fetch_gens(
    conn: sqlite3.Connection, ids: list[str], viewer_uid: Optional[str] = None
) -> dict[str, dict[str, Any]]:
    """id 목록 → {id: 직렬화된 generation dict}. 순서 보존 안 함(호출부가 id 순서로 재구성).
    viewer_uid 가 있으면 남의 공유물 색/태그를 가린다(_attach_children 규칙)."""
    if not ids:
        return {}
    ph = ",".join("?" * len(ids))
    rows = [
        dict(r)
        for r in conn.execute(
            f"SELECT {_GEN_SELECT_COLS} WHERE g.id IN ({ph})", ids
        ).fetchall()
    ]
    return {g["id"]: g for g in _attach_children(conn, rows, viewer_uid=viewer_uid)}

"""공유 / 가져오기 (Phase 5, 로컬) — publish·번들 export/import·share 파일."""

from __future__ import annotations

import json
import sqlite3
from typing import Any, Iterable, Optional

from ..config import DEFAULT_WORKER_ID
from ..db import get_connection
from . import generations, identity, tags
from ._common import (
    BUNDLE_FORMAT,
    BUNDLE_VERSION,
    _remote_url,
    clean_folder_path,
    new_id,
)


# ── 공유 / 가져오기 (Phase 5, 로컬) ──────────────────────────────────────
def publish(gen_id: str, shared_by: str, visibility: str = "team") -> str:
    # UNIQUE(generation_id) + ON CONFLICT 로 동시 publish 중복을 막는다(예전 SELECT-후-INSERT 는
    # 두 요청이 같은 gen 을 동시에 보고 share 를 2개 만들 수 있었다). 삽입 후 실제 행 id 를 되읽어,
    # 내가 넣었든 남이 먼저 넣었든 항상 하나의 share id 를 돌려준다.
    with get_connection() as conn:
        sid = new_id()
        conn.execute(
            "INSERT INTO share(id, generation_id, shared_by, visibility) VALUES(?,?,?,?) "
            "ON CONFLICT(generation_id) DO NOTHING",
            (sid, gen_id, shared_by, visibility),
        )
        row = conn.execute(
            "SELECT id FROM share WHERE generation_id=?", (gen_id,)
        ).fetchone()
    return row["id"] if row else sid


def unpublish(gen_id: str) -> int:
    """팀 공유 해제 — 해당 generation 의 share 행 제거. 제거된 행 수 반환."""
    with get_connection() as conn:
        cur = conn.execute("DELETE FROM share WHERE generation_id=?", (gen_id,))
        return cur.rowcount


def _bridge_derived_edges(
    conn: sqlite3.Connection, shared_ids: list[str], shared_set: set[str], limit: int = 60
) -> list[tuple[str, str]]:
    """공유물 사이에 '비공유' 파생(derived) 단계가 끼어 있으면, 그 비공유를 건너뛰어 공유 child 를
    가장 가까운 '공유' derived 조상과 직접 잇는 (parent_id, child_id) 목록을 만든다(브리지=간접).
    수신측엔 양끝이 모두 공유(존재)라 import 때 엣지가 드롭되지 않아 계보가 끊기지 않는다.
    비공유 중간노드의 내용(프롬프트·이미지)은 전송하지 않으므로 프라이버시는 유지된다."""
    bridges: list[tuple[str, str]] = []

    def _dparents(node: str) -> list[str]:
        return [
            r["p"]
            for r in conn.execute(
                "SELECT parent_gen_id p FROM history WHERE child_gen_id=? AND relation='derived'",
                (node,),
            ).fetchall()
        ]

    for child in shared_ids:
        seen: set[str] = set()
        stack = [(p, False) for p in _dparents(child)]  # (노드, 비공유를 거쳤나)
        while stack and len(seen) < limit:
            node, crossed = stack.pop()
            if node in seen:
                continue
            seen.add(node)
            if node in shared_set:
                if crossed:  # 비공유를 거쳐 도달한 공유 조상 → 간접 직접엣지로 잇는다
                    bridges.append((node, child))
                continue  # 공유 조상에서 멈춤(직접 부모면 일반 export 가 이미 처리)
            for p in _dparents(node):  # 비공유 → 위로 계속(이 노드를 거치므로 crossed=True)
                stack.append((p, True))
    return bridges


def export_bundle(
    creator_uid: Optional[str] = None,
    gen_ids: Optional[list[str]] = None,
) -> dict[str, Any]:
    """로컬 DB 의 생성본을 '사실 + 오버레이' 번들(JSON)로 내보낸다(팀 공유 입구).

    creator_uid 를 주면 그 생성자 것만. gen_ids 를 주면 그 생성본만(선택 공유 = share-set).
    둘 다 없으면 전체. uuid 가 절대 앵커. provider 블록으로 누가 만든 덤프인지 실어 보낸다.
    """
    provider = identity.get_provider()
    with get_connection() as conn:
        where: list[str] = []
        args: list[Any] = []
        if creator_uid:
            where.append("g.creator_uid = ?")
            args.append(creator_uid)
        if gen_ids is not None:
            if not gen_ids:  # 빈 share-set → 빈 번들(전체 export 로 새지 않게)
                return {
                    "format": BUNDLE_FORMAT,
                    "version": BUNDLE_VERSION,
                    "provider": provider,
                    "generations": [],
                }
            where.append(
                "(g.id IN (%s) OR g.job_id IN (%s))"
                % (",".join("?" * len(gen_ids)), ",".join("?" * len(gen_ids)))
            )
            args.extend(gen_ids)
            args.extend(gen_ids)
        clause = (" WHERE " + " AND ".join(where)) if where else ""
        grows = conn.execute(
            "SELECT g.id, g.job_id, g.prompt, g.display_prompt, g.model, g.params, "
            "g.status, g.created_at, g.sort_ts, g.creator_uid, g.project_id, g.folder_path "
            f"FROM generation g{clause} ORDER BY g.sort_ts DESC, g.created_at DESC",
            args,
        ).fetchall()
        gens = [dict(r) for r in grows]
        if not gens:
            return {
                "format": BUNDLE_FORMAT,
                "version": BUNDLE_VERSION,
                "provider": provider,
                "generations": [],
            }

        ids = [g["id"] for g in gens]
        ph = ",".join("?" * len(ids))
        by_id = {g["id"]: g for g in gens}
        for g in gens:
            g["_asset"] = None
            g["_references"] = []
            g["_tags"] = []
            g["_auto_tags"] = []
            g["_comments"] = []

        # 결과물(asset) — generation 당 1개. 원격 URL 보존.
        for r in conn.execute(
            f"SELECT generation_id, type, file_path, source_url FROM asset "
            f"WHERE generation_id IN ({ph})",
            ids,
        ).fetchall():
            url = _remote_url(r["file_path"], r["source_url"])
            if url and by_id[r["generation_id"]]["_asset"] is None:
                by_id[r["generation_id"]]["_asset"] = {"type": r["type"], "file_path": url}

        # 레퍼런스 위치(role = @Image1/@Video 슬롯) — 프롬프트 내 레퍼런스 위치 필터정보의 핵심.
        for r in conn.execute(
            f"SELECT gr.generation_id, gr.role, r.id, r.type, r.file_path, r.source, "
            f"r.source_url, r.share_url "
            f"FROM gen_reference gr JOIN reference r ON r.id = gr.reference_id "
            f"WHERE gr.generation_id IN ({ph}) ORDER BY gr.rowid",
            ids,
        ).fetchall():
            by_id[r["generation_id"]]["_references"].append(
                {
                    "id": r["id"],
                    "type": r["type"],
                    # ★공유 전용 힉스필드 공개 URL(share_url) 우선 — 로컬 캡쳐 토큰(asset:...)도 받는 쪽이
                    # 원본을 받을 수 있게. 없으면 기존 규칙(source_url 우선, 그다음 http file_path).
                    "file_path": r["share_url"] or _remote_url(r["file_path"], r["source_url"]),
                    "role": r["role"],
                    # @소스명(칩 이름) — 받는 쪽 buildPromptParts 가 display_prompt 토큰과
                    # 매칭해 인라인 소스 위치를 복원하는 키. 누락 시 'uploaded' 로 떨어져 위치 손실.
                    "source": r["source"],
                }
            )

        for r in conn.execute(
            f"SELECT gt.generation_id, t.name FROM gen_tag gt JOIN tag t ON t.id=gt.tag_id "
            f"WHERE gt.generation_id IN ({ph})",
            ids,
        ).fetchall():
            by_id[r["generation_id"]]["_tags"].append(r["name"])

        for r in conn.execute(
            f"SELECT gat.generation_id, a.name FROM gen_auto_tag gat "
            f"JOIN auto_tag a ON a.id=gat.auto_tag_id WHERE gat.generation_id IN ({ph})",
            ids,
        ).fetchall():
            by_id[r["generation_id"]]["_auto_tags"].append(r["name"])

        # 코멘트(작성자 표기 포함) — 작성자 이름까지 실어 받는 쪽에서 표시되게.
        crows = conn.execute(
            f"SELECT c.gen_id, c.id, c.author, w.name AS worker_name, c.text, "
            f"c.created_at, c.parent_id, c.muted FROM generation_comment c "
            f"LEFT JOIN worker w ON w.id=c.author WHERE c.gen_id IN ({ph}) "
            f"ORDER BY c.created_at ASC, c.id ASC",
            ids,
        ).fetchall()
        # 작성자명은 단일 해석기(creator.name→account.name→이메일)로 — 받는 쪽이 보내는 사람의
        # 표시이름 그대로 보게 한다. 옛 worker(author='me')는 worker.name 으로 폴백.
        cmt_names = identity.resolve_display_names(conn, [r["author"] for r in crows])
        for r in crows:
            by_id[r["gen_id"]]["_comments"].append(
                {
                    "id": r["id"],
                    "author": r["author"],
                    "author_name": cmt_names.get(r["author"]) or r["worker_name"],
                    "text": r["text"],
                    "created_at": r["created_at"],
                    "parent_id": r["parent_id"],
                    "muted": bool(r["muted"]),
                }
            )

        # 작성자 이름 맵(user_<id> → 이름) — 같은 커넥션에서 한 번에 조회(두 번째 연결 제거).
        creator_names: dict[str, str] = {}
        present = {g["creator_uid"] for g in gens if g.get("creator_uid")}
        if present:
            cph = ",".join("?" * len(present))
            for r in conn.execute(
                f"SELECT uid, name FROM creator WHERE uid IN ({cph}) AND name IS NOT NULL",
                list(present),
            ).fetchall():
                creator_names[r["uid"]] = r["name"]

        # 계보(history) 엣지 — 받는 쪽(서버)이 공유물 사이 계보를 보이게. 엣지 양끝을 서버 앵커(job_id)로
        # 변환한다(번들 밖 부모/자식도 그 job_id 로). 서버는 양끝이 다 있을 때만 넣는다(import 쪽 FK 보호).
        history_edges: list[dict[str, Any]] = []
        job_map = {g["id"]: (g["job_id"] or g["id"]) for g in gens}
        erows = conn.execute(
            f"SELECT parent_gen_id, child_gen_id, relation FROM history "
            f"WHERE child_gen_id IN ({ph}) OR parent_gen_id IN ({ph})",
            [*ids, *ids],
        ).fetchall()
        need = {
            x
            for e in erows
            for x in (e["parent_gen_id"], e["child_gen_id"])
            if x not in job_map
        }
        if need:
            nph = ",".join("?" * len(need))
            for r in conn.execute(
                f"SELECT id, job_id FROM generation WHERE id IN ({nph})", list(need)
            ).fetchall():
                job_map[r["id"]] = r["job_id"] or r["id"]
        for e in erows:
            history_edges.append(
                {
                    "parent": job_map.get(e["parent_gen_id"], e["parent_gen_id"]),
                    "child": job_map.get(e["child_gen_id"], e["child_gen_id"]),
                    "relation": e["relation"],
                }
            )
        # ★브리지(간접) 엣지 — 공유물 사이에 '비공유' 파생 단계가 끼어 직접 엣지가 import 때 드롭되면
        # 계보가 끊긴다(공유본 히스토리가 비어 보이던 문제). 비공유를 건너뛰어 가장 가까운 '공유' derived
        # 조상과 직접 잇는다. 양끝 모두 공유(job_map 에 있음)라 수신측에 살아남는다.
        # 단 그 쌍을 잇는 실엣지가 이미 있으면(예: reference) 브리지 derived 를 더하지 않는다 —
        # 같은 (parent,child)에 relation 만 다른 두 엣지가 공존해 '이중 표기'되던 모순을 막는다.
        existing_pairs = {(e["parent"], e["child"]) for e in history_edges}
        for parent_id, child_id in _bridge_derived_edges(conn, ids, set(ids)):
            p = job_map.get(parent_id, parent_id)
            c = job_map.get(child_id, child_id)
            if (p, c) in existing_pairs:
                continue
            existing_pairs.add((p, c))
            history_edges.append({"parent": p, "child": c, "relation": "derived"})

    items: list[dict[str, Any]] = []
    for g in gens:
        items.append(
            {
                "generation": {
                    "id": g["job_id"] or g["id"],  # uuid 앵커: 힉스필드 잡 id 우선
                    "prompt": g["prompt"],
                    "display_prompt": g["display_prompt"],
                    "model": g["model"],
                    "params": json.loads(g["params"]) if g["params"] else {},
                    "status": g["status"],
                    "created_at": g["created_at"],
                    "sort_ts": g["sort_ts"],
                    "creator_uid": g["creator_uid"],
                    # 프로젝트 귀속 — 서버 finalize 가 require_project_role(검수 게이트)를 적용하려면
                    # 서버 사본도 project_id 를 알아야 한다(누락 시 소유자 체크로 떨어져 게이트 우회).
                    "project_id": g["project_id"],
                    # 폴더 경로 — 받는 쪽 관리탭 자동 작업/시퀀스 파생·완료본 저장 경로에 필요.
                    "folder_path": g["folder_path"],
                },
                "asset": g["_asset"],
                "references": g["_references"],
                "tags": g["_tags"],
                "auto_tags": g["_auto_tags"],
                "comments": g["_comments"],
            }
        )

    # 내 작업은 내 표시이름으로(이름 라벨을 따로 안 붙였어도 제공자 이름으로 채움).
    my_uid = identity.get_my_uid()
    if my_uid and my_uid in present and provider.get("name"):
        creator_names.setdefault(my_uid, provider["name"])

    return {
        "format": BUNDLE_FORMAT,
        "version": BUNDLE_VERSION,
        "provider": provider,
        "creators": creator_names,
        "generations": items,
        "history": history_edges,  # 공유물 사이 계보 엣지(job_id 앵커) — 받는 쪽이 계보 표시
    }


def _find_id_by_job(conn: sqlite3.Connection, job_id: str) -> Optional[str]:
    row = conn.execute(
        "SELECT id FROM generation WHERE id=? OR job_id=? LIMIT 1", (job_id, job_id)
    ).fetchone()
    return row["id"] if row else None


def _merge_comments(
    conn: sqlite3.Connection, gen_id: str, comments: Iterable[dict[str, Any]]
) -> None:
    """코멘트 id 로 dedup append(작성자 표기 보존). 같은 id 는 무시(중복 방지).
    작성자 이름이 함께 오면 worker 행을 보장해 목록 join 에서 이름이 뜨게 한다."""
    for c in comments:
        cid = c.get("id")
        text = (c.get("text") or "").strip()
        if not cid or not text:
            continue
        author = c.get("author") or DEFAULT_WORKER_ID
        aname = c.get("author_name")
        if aname:
            identity.ensure_worker(conn, author, aname, "team")
        conn.execute(
            "INSERT OR IGNORE INTO generation_comment"
            "(id, gen_id, author, text, created_at, parent_id, muted) "
            "VALUES(?,?,?,?, COALESCE(?, datetime('now')), ?, ?)",
            (cid, gen_id, author, text, c.get("created_at"),
             c.get("parent_id"), 1 if c.get("muted") else 0),
        )


def import_bundle_item(
    item: dict[str, Any], worker_id: str, shared_by: Optional[str] = None
) -> str:
    """번들 항목 1건을 병합. 사실은 upsert(uuid 멱등), 오버레이는 union/append.
    shared_by(제공자 worker id)가 오면 '받은 공유' 표식으로 share 행을 1개 기록한다 —
    received 필터(shared_by <> 'me')가 가져온 작업물을 사이드바에 띄울 수 있게.
    반환: 'inserted'|'updated'|'unchanged'|'skipped'."""
    g = item.get("generation") or {}
    job_id = g.get("id")
    if not job_id:
        return "skipped"
    # 공유 import 도 로컬 생성과 같은 정규화 적용 — 안 하면 ep001\c0010·ep001//c0010/ 같은
    # 값이 그대로 저장돼 자동작업/카운트/필터가 갈라진다(생성은 이미 clean_folder_path 적용).
    folder_path = clean_folder_path(g.get("folder_path"))
    parsed = {
        "generation": {
            "id": job_id,
            "prompt": g.get("prompt") or "",
            "model": g.get("model"),
            "params": g.get("params") or {},
            "status": g.get("status") or "done",
            "created_at": g.get("created_at") or "",
            "sort_ts": g.get("sort_ts"),
            # ★생성자 없으면 공유자(shared_by)로 귀속 — 공유에선 '누가 만들었나'가 핵심이라,
            # creator_uid 가 비면(예: user_<id> 없는 영상) 받는 쪽 화면에 '나'로 오표시되지 않게
            # 발신자(공유한 사람)를 생성자로 넣는다. resolve_display_names 가 그 사람 이름으로 표시.
            "creator_uid": g.get("creator_uid") or shared_by,
            "project_id": g.get("project_id"),
            "folder_path": folder_path,
        },
        "asset": item.get("asset"),
        "references": item.get("references") or [],
    }
    # item 전체(fact upsert + overlay 병합)를 한 트랜잭션으로 — upsert 성공 후 overlay 중 실패해도
    # 반쪽(fact 만 있고 overlay 빠짐)이 남지 않게. 내부 함수라 wrapper 가 아닌 _upsert_synced(conn)
    # 를 직접 호출해 중첩 BEGIN 을 피한다(오버레이 헬퍼는 모두 conn 참여형).
    with get_connection() as conn:
        conn.execute("BEGIN IMMEDIATE")
        try:
            result = generations._upsert_synced(conn, parsed, worker_id)
            # 오버레이 병합 — display_prompt(레퍼런스 위치)·태그(union)·코멘트(append).
            gid = _find_id_by_job(conn, job_id)
            if gid:
                dp = g.get("display_prompt")
                if dp:
                    conn.execute(
                        "UPDATE generation SET display_prompt=COALESCE(display_prompt, ?) WHERE id=?",
                        (dp, gid),
                    )
                pid = g.get("project_id")
                if pid:  # 프로젝트 귀속 보존 — 기존 배정은 침범 않게 COALESCE(서버 finalize 게이트용)
                    conn.execute(
                        "UPDATE generation SET project_id=COALESCE(project_id, ?) WHERE id=?",
                        (pid, gid),
                    )
                if folder_path:  # 폴더 경로 보존 — 관리탭 자동 파생·완료본 저장 경로(기존값 침범 않게 COALESCE)
                    conn.execute(
                        "UPDATE generation SET folder_path=COALESCE(folder_path, ?) WHERE id=?",
                        (folder_path, gid),
                    )
                tags._add_tags(conn, gid, item.get("tags") or [])
                tags._set_auto_tags(conn, gid, item.get("auto_tags") or [])
                _merge_comments(conn, gid, item.get("comments") or [])
                # 받은 공유 표식 — 제공자를 발신자로 한 share 행 1개(멱등·race-safe: UNIQUE(generation_id)
                # + ON CONFLICT DO NOTHING. 동시 import 두 개가 같은 gid 를 처리해도 IntegrityError 없이 통과).
                if shared_by and shared_by != DEFAULT_WORKER_ID:
                    conn.execute(
                        "INSERT INTO share(id, generation_id, shared_by, visibility) "
                        "VALUES(?,?,?,?) ON CONFLICT(generation_id) DO NOTHING",
                        (new_id(), gid, shared_by, "team"),
                    )
            conn.execute("COMMIT")
            return result
        except Exception:
            conn.execute("ROLLBACK")
            raise


def import_bundle_payload(
    bundle: dict[str, Any], worker_id: str = DEFAULT_WORKER_ID
) -> dict[str, int]:
    """번들 1개(provider + generations)를 통째로 병합. 항목별 결과를 카운트로 집계.
    provider.name 이 있으면 그 uid 의 creator 이름을 보강해 받은 작업물의 작성자가 표시되게."""
    # 작성자 이름 맵 적용 — 각 작업의 creator_uid(user_<id>) 가 'user_xxx' 아닌 사람 이름으로 뜨게.
    # overwrite=False: 이미 이름이 있는 작성자(특히 내 신원·내가 라벨링한 팀원)는 보존 → 받은 이름이
    # 내 로컬 명명을 침범하지 않는다(get_my_uid 가 아직 None 이어도 안전. provider 블록은 이메일 키라
    # 어떤 작업과도 안 이어져 무의미 → 제거하고, user_<id> 키인 creators 맵만 사용).
    for uid, name in (bundle.get("creators") or {}).items():
        if uid and name:
            identity.set_creator_name(uid, name, overwrite=False)
    # 제공자를 발신자로 한 '받은 공유' 표식용 worker 보장. provider.uid(이메일) 를 worker id 로
    # 쓰고(없으면 표식 생략), share.shared_by FK 가 가리킬 수 있게 한다. 내 신원이면 표식 안 함.
    prov = bundle.get("provider") or {}
    shared_by = prov.get("uid") or None
    if shared_by and shared_by != worker_id:
        with get_connection() as conn:
            identity.ensure_worker(conn, shared_by, prov.get("name") or shared_by, "team")
        # creator_uid 가 shared_by 로 폴백된 항목(user_<id> 없는 영상 등)이 받는 쪽에서 '팀원' 대신
        # 공유자 이름으로 뜨도록 creator 이름도 보강한다 — resolve_display_names 는 worker 가 아니라
        # creator/account 테이블을 보므로 ensure_worker 만으론 부족했다(overwrite=False: 내 명명 보존).
        if prov.get("name"):
            identity.set_creator_name(shared_by, prov["name"], overwrite=False)
    else:
        shared_by = None
    counts = {"inserted": 0, "updated": 0, "unchanged": 0, "skipped": 0}
    for it in bundle.get("generations") or []:
        if not isinstance(it, dict):
            counts["skipped"] += 1
            continue
        counts[import_bundle_item(it, worker_id, shared_by)] += 1
    # 계보 엣지 — 생성물 import 후에 넣는다. 양끝(parent·child)이 모두 서버에 실재할 때만(FK 보호,
    # 멱등). 공유된 조상끼리만 연결돼 팀원이 공유물 사이 계보를 본다(미공유 조상은 자동 생략).
    for e in bundle.get("history") or []:
        if not isinstance(e, dict):
            continue
        p, c, rel = e.get("parent"), e.get("child"), e.get("relation") or "derived"
        if not p or not c or p == c:
            continue
        with get_connection() as conn:
            # 양끝을 실제 로컬 행 id 로 해석(id OR job_id) — sync 서버처럼 id≠job_id 인 행이어도
            # 엣지가 누락되지 않게. 둘 다 실재할 때만 넣는다(FK 보호, 멱등).
            pid = _find_id_by_job(conn, p)
            cid = _find_id_by_job(conn, c)
            if pid and cid and pid != cid:
                conn.execute(
                    "INSERT OR IGNORE INTO history(id, parent_gen_id, child_gen_id, relation) "
                    "VALUES(?,?,?,?)",
                    (new_id(), pid, cid, rel),
                )
    return counts

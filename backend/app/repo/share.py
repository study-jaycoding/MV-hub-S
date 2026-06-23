"""공유 / 가져오기 (Phase 5, 로컬) — publish·번들 export/import·share 파일."""

from __future__ import annotations

import json
import sqlite3
from pathlib import Path
from typing import Any, Iterable, Optional

from ..config import DEFAULT_WORKER_ID, SHARED_DIR
from ..db import get_connection
from . import generations, identity, tags
from ._common import (
    BUNDLE_FORMAT,
    BUNDLE_VERSION,
    _remote_url,
    _sanitize_filename,
    new_id,
)


# ── 공유 / 가져오기 (Phase 5, 로컬) ──────────────────────────────────────
def publish(gen_id: str, shared_by: str, visibility: str = "team") -> str:
    with get_connection() as conn:
        row = conn.execute(
            "SELECT id FROM share WHERE generation_id=?", (gen_id,)
        ).fetchone()
        if row:
            return row["id"]
        sid = new_id()
        conn.execute(
            "INSERT INTO share(id, generation_id, shared_by, visibility) "
            "VALUES(?,?,?,?)",
            (sid, gen_id, shared_by, visibility),
        )
    return sid


def unpublish(gen_id: str) -> int:
    """팀 공유 해제 — 해당 generation 의 share 행 제거. 제거된 행 수 반환."""
    with get_connection() as conn:
        cur = conn.execute("DELETE FROM share WHERE generation_id=?", (gen_id,))
        return cur.rowcount


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
            "g.status, g.created_at, g.sort_ts, g.creator_uid "
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
            f"SELECT gr.generation_id, gr.role, r.id, r.type, r.file_path, r.source, r.source_url "
            f"FROM gen_reference gr JOIN reference r ON r.id = gr.reference_id "
            f"WHERE gr.generation_id IN ({ph}) ORDER BY gr.rowid",
            ids,
        ).fetchall():
            by_id[r["generation_id"]]["_references"].append(
                {
                    "id": r["id"],
                    "type": r["type"],
                    "file_path": _remote_url(r["file_path"], r["source_url"]),
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
    parsed = {
        "generation": {
            "id": job_id,
            "prompt": g.get("prompt") or "",
            "model": g.get("model"),
            "params": g.get("params") or {},
            "status": g.get("status") or "done",
            "created_at": g.get("created_at") or "",
            "sort_ts": g.get("sort_ts"),
            "creator_uid": g.get("creator_uid"),
        },
        "asset": item.get("asset"),
        "references": item.get("references") or [],
    }
    result = generations.upsert_synced_generation(parsed, worker_id)
    # 오버레이 병합 — display_prompt(레퍼런스 위치)·태그(union)·코멘트(append).
    with get_connection() as conn:
        gid = _find_id_by_job(conn, job_id)
        if gid:
            dp = g.get("display_prompt")
            if dp:
                conn.execute(
                    "UPDATE generation SET display_prompt=COALESCE(display_prompt, ?) WHERE id=?",
                    (dp, gid),
                )
            tags._add_tags(conn, gid, item.get("tags") or [])
            tags._set_auto_tags(conn, gid, item.get("auto_tags") or [])
            _merge_comments(conn, gid, item.get("comments") or [])
            # 받은 공유 표식 — 제공자를 발신자로 한 share 행 1개(멱등: 이미 있으면 건너뜀).
            if shared_by and shared_by != DEFAULT_WORKER_ID:
                if not conn.execute(
                    "SELECT 1 FROM share WHERE generation_id=? LIMIT 1", (gid,)
                ).fetchone():
                    conn.execute(
                        "INSERT INTO share(id, generation_id, shared_by, visibility) "
                        "VALUES(?,?,?,?)",
                        (new_id(), gid, shared_by, "team"),
                    )
    return result


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
    else:
        shared_by = None
    counts = {"inserted": 0, "updated": 0, "unchanged": 0, "skipped": 0}
    for it in bundle.get("generations") or []:
        if not isinstance(it, dict):
            counts["skipped"] += 1
            continue
        counts[import_bundle_item(it, worker_id, shared_by)] += 1
    return counts


# ── 팀 공유 파일(data/shared 폴더) ────────────────────────────────────────
# 한 사람이 만드는 산출물은 딱 하나 = 자기 share 파일(제공자명 태그). "받은 것"은 따로
# 만드는 게 아니라 남의 share 파일을 가져온 것일 뿐. 그래서 파일은 share_<제공자>.json 하나뿐이고,
# 내 신원과 일치하는 파일 = 내가 만든 것(편집·재push 대상), 나머지 = 받은 것(읽기).
def list_my_share_gen_ids() -> list[str]:
    """공유 표시(share-set)된 생성본 id 목록. share 테이블이 진실원천(추가=publish/제거=unpublish)."""
    with get_connection() as conn:
        rows = conn.execute(
            "SELECT DISTINCT generation_id FROM share"
        ).fetchall()
    return [r["generation_id"] for r in rows]


def my_share_path() -> Path:
    """내 share 파일 경로 — share_<제공자명>.json. 제공자명은 사람이 읽을 라벨(불변 앵커는 번들 내부 uid)."""
    name = _sanitize_filename(identity.get_provider().get("name") or "me")
    return SHARED_DIR / f"share_{name}.json"


def export_my_share_bundle() -> dict[str, Any]:
    """내 share-set(공유 표시된 것들)만 추출한 번들 — 사실+오버레이+provider."""
    return export_bundle(gen_ids=list_my_share_gen_ids())


def write_my_share_file() -> dict[str, Any]:
    """현재 share-set 을 share_<제공자>.json 으로 디스크에 기록(추가/제거 시마다 호출 → 재push 원본).
    share-set 이 비면 파일을 제거(공유 0건이면 서버에 빈 파일 안 남김). 반환: {path, count, error?}.

    ⚠️ best-effort: 파일 쓰기/삭제 실패(잠김·권한·디스크)는 호출자(publish/unpublish)의 DB 커밋을
    되돌리지 않는다. 디스크 I/O 실패가 발행/해제 자체를 500 으로 깨지 않게 예외를 삼키고 error 로 반환.
    파일은 share-set 의 투영일 뿐이라 /share/rebuild 로 언제든 재생성 가능."""
    try:
        SHARED_DIR.mkdir(parents=True, exist_ok=True)
        bundle = export_my_share_bundle()
        path = my_share_path()
        count = len(bundle.get("generations") or [])
        if count == 0:
            if path.exists():
                path.unlink()
            return {"path": None, "count": 0}
        path.write_text(json.dumps(bundle, ensure_ascii=False, indent=2), encoding="utf-8")
        return {"path": str(path), "count": count}
    except OSError as e:
        print(f"[share] share 파일 쓰기 실패(무시, /share/rebuild 로 재시도 가능): {e}")
        return {"path": None, "count": -1, "error": str(e)}


def _read_share_file(path: Path) -> Optional[dict[str, Any]]:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    if not isinstance(data, dict) or data.get("format") != BUNDLE_FORMAT:
        return None
    return data


def list_received_shares() -> list[dict[str, Any]]:
    """shared 폴더의 받은 share 파일 요약 목록(내 신원 파일은 제외).
    [{filename, provider, count, mine}]. 내것 판정은 파일명이 아니라 번들 내부 provider.uid 로."""
    me = identity.get_provider()
    my_uid = me.get("uid")
    out: list[dict[str, Any]] = []
    if not SHARED_DIR.exists():
        return out
    for path in sorted(SHARED_DIR.glob("*.json")):
        data = _read_share_file(path)
        if data is None:
            continue
        prov = data.get("provider") or {}
        is_mine = bool(my_uid and prov.get("uid") == my_uid)
        if is_mine:
            continue  # 내가 만든 share 파일은 받은 목록에 안 보임
        out.append(
            {
                "filename": path.name,
                "provider": prov,
                "count": len(data.get("generations") or []),
            }
        )
    return out


def import_share_file(filename: str, worker_id: str = DEFAULT_WORKER_ID) -> dict[str, int]:
    """shared 폴더의 특정 share 파일을 내 라이브러리로 병합(받기). 경로 탈출 방지."""
    safe = Path(filename).name  # 디렉터리 성분 제거(../ 차단)
    path = SHARED_DIR / safe
    data = _read_share_file(path)
    if data is None:
        return {"inserted": 0, "updated": 0, "unchanged": 0, "skipped": 0, "error": 1}
    return import_bundle_payload(data, worker_id)

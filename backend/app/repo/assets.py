"""분리 창(Assets 파일 브라우저) 메타데이터 + 파일/생성본 코멘트 스레드."""

from __future__ import annotations

import json
import sqlite3
from typing import Any, Optional

from ..db import get_connection
from ._common import ALERT_COMMENT_JOINS, ALERT_COMMENT_PREDICATE, new_id
from .identity import resolve_display_names


def _name_comments(
    conn: sqlite3.Connection, rows: list[sqlite3.Row]
) -> list[dict[str, Any]]:
    """코멘트 행에 author_name 을 채운다 — 단일 해석기(creator.name → account.name →
    이메일 로컬파트)로 작성자(creator_uid) 표시이름을 읽기 시점에 해석. 표시이름을 바꾸면
    과거 코멘트 작성자명까지 함께 바뀐다. 합성 uid 가 아닌 옛 worker(author='me') 는 worker.name 으로 폴백."""
    out = [dict(r) for r in rows]
    names = resolve_display_names(conn, [r["author"] for r in out])
    for c in out:
        worker_name = c.pop("worker_name", None)
        c["author_name"] = names.get(c["author"]) or worker_name
    return out


def _empty_asset_meta() -> dict[str, Any]:
    return {
        "is_source": False,
        "source_name": None,
        "tags": [],
        "comment": None,
        "color": None,
        "comment_count": 0,
        "has_unread": False,
    }


# ── 분리 창(Assets 파일 브라우저) 파일별 메타데이터 ───────────────────────
def get_asset_meta(
    project: str, viewer_uid: str = ""
) -> dict[str, dict[str, Any]]:
    """파일별 메타 { path: {is_source, source_name, tags, comment, color,
    comment_count, has_unread} }. 메타(소스/태그/컬러/노트)는 **viewer_uid 개인 것만**
    보인다(계정별 개인화 — 남의 설정 안 섞임). comment_count 는 공유 스레드(모두의 글) 기준,
    has_unread 는 viewer_uid 기준 미확인. 내가 쓴 muted=1 코멘트만 내 알림에서 제외."""
    out: dict[str, dict[str, Any]] = {}
    worker_id = viewer_uid
    with get_connection() as conn:
        for r in conn.execute(
            "SELECT path, is_source, source_name, tags, comment, color "
            "FROM asset_meta WHERE project=? AND owner_uid=?",
            (project, viewer_uid),
        ):
            out[r["path"]] = {
                "is_source": bool(r["is_source"]),
                "source_name": r["source_name"],
                "tags": json.loads(r["tags"]) if r["tags"] else [],
                "comment": r["comment"],
                "color": r["color"],
                "comment_count": 0,
                "has_unread": False,
            }
        # 코멘트 개수
        for r in conn.execute(
            "SELECT path, COUNT(*) AS cnt FROM asset_comment WHERE project=? GROUP BY path",
            (project,),
        ):
            out.setdefault(r["path"], _empty_asset_meta())["comment_count"] = r["cnt"]
        # 미확인 여부(read_at 보다 나중에 달린 코멘트 존재).
        # 내 코멘트라도 작성 시점 muted=1 인 것만 내 알림에서 제외(코멘트별).
        # muted 는 "작성자 본인 알림만 억제" → 팀원에겐 그대로 알림(author=viewer 일 때만 적용).
        for r in conn.execute(
            "SELECT DISTINCT c.path FROM asset_comment c "
            "LEFT JOIN asset_comment_read rd "
            "ON rd.worker_id=? AND rd.project=c.project AND rd.path=c.path "
            "WHERE c.project=? AND (rd.read_at IS NULL OR c.created_at > rd.read_at) "
            "AND NOT (c.author=? AND c.muted=1)",
            (worker_id, project, worker_id),
        ):
            out.setdefault(r["path"], _empty_asset_meta())["has_unread"] = True
    return out


# ── 파일 코멘트 스레드(공유) ──────────────────────────────────────────────
def list_asset_comments(project: str, path: str) -> list[dict[str, Any]]:
    with get_connection() as conn:
        rows = conn.execute(
            "SELECT c.id, c.author, w.name AS worker_name, c.text, c.created_at, c.parent_id "
            "FROM asset_comment c LEFT JOIN worker w ON w.id = c.author "
            "WHERE c.project=? AND c.path=? ORDER BY c.created_at ASC, c.id ASC",
            (project, path),
        ).fetchall()
        return _name_comments(conn, rows)


def add_asset_comment(
    project: str,
    path: str,
    author: str,
    text: str,
    parent_id: Optional[str] = None,
    muted: bool = False,
) -> str:
    cid = new_id()
    with get_connection() as conn:
        conn.execute(
            "INSERT INTO asset_comment(id, project, path, author, text, parent_id, muted) "
            "VALUES(?,?,?,?,?,?,?)",
            (cid, project, path, author, text, parent_id, 1 if muted else 0),
        )
    return cid


def _comment_owner_locked(
    conn: sqlite3.Connection,
    comment_id: str,
    worker_id: str,
    table: str = "asset_comment",
) -> tuple[Optional[bool], bool]:
    """(is_owner, locked) 반환. locked = 다른 사람이 단 답글이 있으면 True.
    에셋·생성본 코멘트가 같은 락 규칙을 쓰므로 테이블명만 바꿔 공용화한다.
    table 은 'asset_comment' | 'generation_comment' 리터럴만(내부 호출 — 사용자 입력 아님)."""
    row = conn.execute(
        f"SELECT author FROM {table} WHERE id=?", (comment_id,)
    ).fetchone()
    if not row:
        return (None, False)
    is_owner = row["author"] == worker_id
    locked = (
        conn.execute(
            f"SELECT 1 FROM {table} WHERE parent_id=? AND author<>? LIMIT 1",
            (comment_id, worker_id),
        ).fetchone()
        is not None
    )
    return (is_owner, locked)


def edit_asset_comment(comment_id: str, worker_id: str, text: str) -> None:
    with get_connection() as conn:
        owner, locked = _comment_owner_locked(conn, comment_id, worker_id)
        if owner is None:
            raise ValueError("코멘트 없음")
        if not owner:
            raise PermissionError("내 코멘트만 수정할 수 있습니다")
        if locked:
            raise PermissionError("답글이 달려 수정할 수 없습니다")
        conn.execute("UPDATE asset_comment SET text=? WHERE id=?", (text, comment_id))


def delete_asset_comment(comment_id: str, worker_id: str) -> None:
    with get_connection() as conn:
        owner, locked = _comment_owner_locked(conn, comment_id, worker_id)
        if owner is None:
            return
        if not owner:
            raise PermissionError("내 코멘트만 삭제할 수 있습니다")
        if locked:
            raise PermissionError("답글이 달려 삭제할 수 없습니다")
        # 내가 단 답글(자식)은 함께 삭제
        conn.execute(
            "DELETE FROM asset_comment WHERE id=? OR parent_id=?", (comment_id, comment_id)
        )


def mark_asset_comments_read(worker_id: str, project: str, path: str) -> None:
    with get_connection() as conn:
        conn.execute(
            "INSERT INTO asset_comment_read(worker_id, project, path, read_at) "
            "VALUES(?,?,?, datetime('now')) "
            "ON CONFLICT(worker_id, project, path) DO UPDATE SET read_at=datetime('now')",
            (worker_id, project, path),
        )


# ── 생성본 코멘트 스레드(공유, 에셋과 별개) ──────────────────────────────
def list_generation_comments(gen_id: str, viewer_uid: str = "") -> list[dict[str, Any]]:
    """스레드(작성자·시각 + viewer_uid 기준 unread 플래그). unread(=NEW 알림)는 '내가 아직 확인
    안 한 코멘트'(seen 행 없음) 중 **알림 대상**만: ① 내가 만든 생성물에 달린 코멘트(creator_uid=뷰어)
    또는 ② 내 코멘트에 달린 답글(부모 author=뷰어). 내가 쓴 코멘트는 제외(author<>뷰어). 그 외 코멘트는
    스레드에 보이되 unread=false(알림 안 울림). 카드 C 뱃지(has_unread)와 동일 규칙이라 항상 일치한다."""
    with get_connection() as conn:
        rows = conn.execute(
            f"SELECT c.id, c.author, w.name AS worker_name, c.text, c.created_at, c.parent_id, "
            f"CASE WHEN {ALERT_COMMENT_PREDICATE} THEN 1 ELSE 0 END AS unread "
            f"FROM generation_comment c "
            f"{ALERT_COMMENT_JOINS} "
            f"LEFT JOIN worker w ON w.id = c.author "
            f"WHERE c.gen_id=? ORDER BY c.created_at ASC, c.id ASC",
            (viewer_uid, viewer_uid, viewer_uid, viewer_uid, gen_id),
        ).fetchall()
        out = _name_comments(conn, rows)
        for c in out:
            c["unread"] = bool(c.get("unread"))
        return out


def add_generation_comment(
    gen_id: str,
    author: str,
    text: str,
    parent_id: Optional[str] = None,
    muted: bool = False,
) -> str:
    cid = new_id()
    with get_connection() as conn:
        conn.execute(
            "INSERT INTO generation_comment(id, gen_id, author, text, parent_id, muted) "
            "VALUES(?,?,?,?,?,?)",
            (cid, gen_id, author, text, parent_id, 1 if muted else 0),
        )
        # 답글을 달면 그 부모 코멘트를 확인한 것으로 간주(작성자 본인 기준 seen 처리).
        if parent_id:
            conn.execute(
                "INSERT OR IGNORE INTO generation_comment_seen(worker_id, comment_id) "
                "VALUES(?, ?)",
                (author, parent_id),
            )
    return cid


def edit_generation_comment(comment_id: str, worker_id: str, text: str) -> None:
    with get_connection() as conn:
        owner, locked = _comment_owner_locked(
            conn, comment_id, worker_id, "generation_comment"
        )
        if owner is None:
            raise ValueError("코멘트 없음")
        if not owner:
            raise PermissionError("내 코멘트만 수정할 수 있습니다")
        if locked:
            raise PermissionError("답글이 달려 수정할 수 없습니다")
        conn.execute(
            "UPDATE generation_comment SET text=? WHERE id=?", (text, comment_id)
        )


def delete_generation_comment(comment_id: str, worker_id: str) -> None:
    with get_connection() as conn:
        owner, locked = _comment_owner_locked(
            conn, comment_id, worker_id, "generation_comment"
        )
        if owner is None:
            return
        if not owner:
            raise PermissionError("내 코멘트만 삭제할 수 있습니다")
        if locked:
            raise PermissionError("답글이 달려 삭제할 수 없습니다")
        conn.execute(
            "DELETE FROM generation_comment WHERE id=? OR parent_id=?",
            (comment_id, comment_id),
        )


def mark_generation_comments_read(worker_id: str, gen_id: str) -> None:
    """그 gen 의 모든 코멘트를 한 번에 확인 처리('전체 확인'). 레거시 read_at 갱신 +
    코멘트 단위 seen 일괄 삽입(개별 모델과 정합)."""
    with get_connection() as conn:
        conn.execute(
            "INSERT INTO generation_comment_read(worker_id, gen_id, read_at) "
            "VALUES(?,?, datetime('now')) "
            "ON CONFLICT(worker_id, gen_id) DO UPDATE SET read_at=datetime('now')",
            (worker_id, gen_id),
        )
        conn.execute(
            "INSERT OR IGNORE INTO generation_comment_seen(worker_id, comment_id) "
            "SELECT ?, id FROM generation_comment WHERE gen_id=?",
            (worker_id, gen_id),
        )


def generation_comment_exists(comment_id: str) -> bool:
    """이 코멘트가 로컬 DB에 있나 — 로컬우선에서 by-id 코멘트 연산(수정/삭제/확인)을
    로컬에서 처리할지(내 비공개 작업) 서버로 위임할지(공유본) 가르는 데 쓴다."""
    with get_connection() as conn:
        return (
            conn.execute(
                "SELECT 1 FROM generation_comment WHERE id=?", (comment_id,)
            ).fetchone()
            is not None
        )


def comment_gen_shared(comment_id: str) -> Optional[bool]:
    """이 코멘트가 달린 generation 의 공유 여부. None = 로컬에 그 코멘트가 없음(=서버 전용 공유본).
    로컬우선 by-id 코멘트 라우팅용: 발행 시 번들이 코멘트를 '같은 id'로 서버에도 심으므로,
    공유본에 달린 코멘트는 로컬에도 같은 id 가 있어도 서버 단일 스레드가 정답 → 서버로 보내야 한다.
    (id 존재만 보면 공유본 수정이 로컬로 새고, 패널이 보는 서버본은 안 바뀐다.)"""
    with get_connection() as conn:
        row = conn.execute(
            "SELECT EXISTS(SELECT 1 FROM share s WHERE s.generation_id=c.gen_id) AS shared "
            "FROM generation_comment c WHERE c.id=?",
            (comment_id,),
        ).fetchone()
    return bool(row["shared"]) if row else None


def mark_generation_comment_seen(worker_id: str, comment_id: str) -> None:
    """코멘트 한 건을 확인 처리(패널에서 NEW 코멘트를 클릭). 멱등."""
    with get_connection() as conn:
        conn.execute(
            "INSERT OR IGNORE INTO generation_comment_seen(worker_id, comment_id) "
            "VALUES(?, ?)",
            (worker_id, comment_id),
        )


def _ensure_asset_meta(
    conn: sqlite3.Connection, project: str, path: str, owner_uid: str
) -> None:
    conn.execute(
        "INSERT OR IGNORE INTO asset_meta(project, path, owner_uid) VALUES(?, ?, ?)",
        (project, path, owner_uid),
    )


def set_asset_source(
    project: str, path: str, name: Optional[str], is_source: bool, owner_uid: str = ""
) -> None:
    with get_connection() as conn:
        _ensure_asset_meta(conn, project, path, owner_uid)
        conn.execute(
            "UPDATE asset_meta SET is_source=?, source_name=? "
            "WHERE project=? AND path=? AND owner_uid=?",
            (1 if is_source else 0, (name or None) if is_source else None, project, path, owner_uid),
        )


def set_asset_tags(project: str, path: str, tags: list[str], owner_uid: str = "") -> None:
    with get_connection() as conn:
        _ensure_asset_meta(conn, project, path, owner_uid)
        conn.execute(
            "UPDATE asset_meta SET tags=? WHERE project=? AND path=? AND owner_uid=?",
            (json.dumps(tags, ensure_ascii=False) if tags else None, project, path, owner_uid),
        )


def set_asset_comment(
    project: str, path: str, comment: Optional[str], owner_uid: str = ""
) -> None:
    with get_connection() as conn:
        _ensure_asset_meta(conn, project, path, owner_uid)
        conn.execute(
            "UPDATE asset_meta SET comment=? WHERE project=? AND path=? AND owner_uid=?",
            (comment or None, project, path, owner_uid),
        )


def set_asset_color(project: str, path: str, color: Optional[str], owner_uid: str = "") -> None:
    with get_connection() as conn:
        _ensure_asset_meta(conn, project, path, owner_uid)
        conn.execute(
            "UPDATE asset_meta SET color=? WHERE project=? AND path=? AND owner_uid=?",
            (color or None, project, path, owner_uid),
        )

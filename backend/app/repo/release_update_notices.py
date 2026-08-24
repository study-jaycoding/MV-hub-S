"""공유 서버 릴리스 업데이트 공지와 사용자별 읽음 상태 저장소."""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from ..db import get_connection

VISIBLE_LIMIT = 5
# 최근 업데이트가 항상 한 자리에는 보여야 관리자가 새 릴리스를 공지할 수 있다.
# 5개를 전부 고정하면 새 항목이 등록돼도 목록 밖에 갇히므로 고정은 4개까지만 허용한다.
PINNED_LIMIT = VISIBLE_LIMIT - 1


class ReleaseNoticeNotFoundError(LookupError):
    pass


class ReleaseNoticePinnedLimitError(ValueError):
    pass


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _row(row: Any) -> dict[str, Any]:
    value = dict(row)
    value["pinned"] = bool(value.get("pinned"))
    value["unread"] = bool(value.get("unread")) if "unread" in value else False
    return value


def upsert_release_update_notice(
    *,
    notice_id: str,
    version: str,
    file_name: str,
    sha256: str,
    size_bytes: int,
    released_at: str,
) -> tuple[dict[str, Any], bool]:
    """검증된 릴리스 메타데이터를 멱등 등록한다. 관리자 상태는 덮어쓰지 않는다."""
    now = _utc_now()
    with get_connection() as conn:
        conn.execute("BEGIN IMMEDIATE")
        try:
            existing = conn.execute(
                "SELECT id FROM release_update_notice WHERE sha256=?", (sha256,)
            ).fetchone()
            created = existing is None
            if created:
                conn.execute(
                    "INSERT INTO release_update_notice"
                    "(id,version,file_name,sha256,size_bytes,released_at,created_at,updated_at) "
                    "VALUES(?,?,?,?,?,?,?,?)",
                    (
                        notice_id,
                        version,
                        file_name,
                        sha256,
                        int(size_bytes),
                        released_at,
                        now,
                        now,
                    ),
                )
            else:
                notice_id = str(existing["id"])
                conn.execute(
                    "UPDATE release_update_notice SET version=?,file_name=?,size_bytes=?,"
                    "released_at=?,updated_at=? WHERE id=?",
                    (version, file_name, int(size_bytes), released_at, now, notice_id),
                )
            row = conn.execute(
                "SELECT * FROM release_update_notice WHERE id=?", (notice_id,)
            ).fetchone()
            conn.execute("COMMIT")
        except Exception:
            conn.execute("ROLLBACK")
            raise
    return _row(row), created


def list_release_update_notices_admin(limit: int = VISIBLE_LIMIT) -> list[dict[str, Any]]:
    """고정 항목 우선, 나머지는 최신순으로 관리 목록을 채운다."""
    safe_limit = max(1, min(int(limit), VISIBLE_LIMIT))
    with get_connection() as conn:
        rows = conn.execute(
            "SELECT * FROM release_update_notice "
            "ORDER BY pinned DESC,released_at DESC,created_at DESC,id DESC LIMIT ?",
            (safe_limit,),
        ).fetchall()
    return [_row(row) for row in rows]


def set_release_update_notice_pinned(notice_id: str, pinned: bool) -> dict[str, Any]:
    now = _utc_now()
    with get_connection() as conn:
        conn.execute("BEGIN IMMEDIATE")
        try:
            row = conn.execute(
                "SELECT pinned FROM release_update_notice WHERE id=?", (notice_id,)
            ).fetchone()
            if not row:
                raise ReleaseNoticeNotFoundError(notice_id)
            if pinned and not bool(row["pinned"]):
                count = int(
                    conn.execute(
                        "SELECT COUNT(*) AS n FROM release_update_notice WHERE pinned=1"
                    ).fetchone()["n"]
                )
                if count >= PINNED_LIMIT:
                    raise ReleaseNoticePinnedLimitError(
                        f"고정은 최대 {PINNED_LIMIT}개까지 가능합니다"
                    )
            conn.execute(
                "UPDATE release_update_notice SET pinned=?,updated_at=? WHERE id=?",
                (1 if pinned else 0, now, notice_id),
            )
            updated = conn.execute(
                "SELECT * FROM release_update_notice WHERE id=?", (notice_id,)
            ).fetchone()
            conn.execute("COMMIT")
        except Exception:
            conn.execute("ROLLBACK")
            raise
    return _row(updated)


def announce_release_update_notice(notice_id: str, actor_uid: str) -> dict[str, Any]:
    """재공지는 revision을 올려 모든 사용자에게 다시 안읽음으로 보이게 한다."""
    now = _utc_now()
    with get_connection() as conn:
        conn.execute("BEGIN IMMEDIATE")
        try:
            row = conn.execute(
                "SELECT announcement_revision FROM release_update_notice WHERE id=?",
                (notice_id,),
            ).fetchone()
            if not row:
                raise ReleaseNoticeNotFoundError(notice_id)
            revision = int(row["announcement_revision"] or 0) + 1
            conn.execute(
                "UPDATE release_update_notice SET announcement_revision=?,announced_at=?,"
                "announced_by=?,updated_at=? WHERE id=?",
                (revision, now, actor_uid, now, notice_id),
            )
            updated = conn.execute(
                "SELECT * FROM release_update_notice WHERE id=?", (notice_id,)
            ).fetchone()
            conn.execute("COMMIT")
        except Exception:
            conn.execute("ROLLBACK")
            raise
    return _row(updated)


def list_announced_release_updates(
    actor_uid: str, limit: int = VISIBLE_LIMIT
) -> list[dict[str, Any]]:
    safe_limit = max(1, min(int(limit), VISIBLE_LIMIT))
    with get_connection() as conn:
        rows = conn.execute(
            "SELECT n.*,CASE WHEN s.notice_id IS NULL THEN 1 ELSE 0 END AS unread "
            "FROM release_update_notice n "
            "LEFT JOIN release_update_notice_seen s "
            "ON s.notice_id=n.id AND s.revision=n.announcement_revision AND s.actor_uid=? "
            "WHERE n.announcement_revision>0 AND n.announced_at IS NOT NULL "
            "ORDER BY n.pinned DESC,n.announced_at DESC,n.released_at DESC,n.id DESC LIMIT ?",
            (actor_uid, safe_limit),
        ).fetchall()
    return [_row(row) for row in rows]


def mark_release_update_notice_seen(notice_id: str, revision: int, actor_uid: str) -> bool:
    with get_connection() as conn:
        current = conn.execute(
            "SELECT announcement_revision FROM release_update_notice WHERE id=?",
            (notice_id,),
        ).fetchone()
        if not current or int(current["announcement_revision"] or 0) != int(revision):
            return False
        conn.execute(
            "INSERT OR IGNORE INTO release_update_notice_seen(notice_id,revision,actor_uid) "
            "VALUES(?,?,?)",
            (notice_id, int(revision), actor_uid),
        )
        # 같은 알림을 다시 눌러도 성공해야 한다. False는 공지가 실제로 바뀐 경우에만 쓴다.
        return True


def mark_all_release_update_notices_seen(actor_uid: str) -> int:
    with get_connection() as conn:
        before = conn.total_changes
        conn.execute(
            "INSERT OR IGNORE INTO release_update_notice_seen(notice_id,revision,actor_uid) "
            "SELECT id,announcement_revision,? FROM release_update_notice "
            "WHERE announcement_revision>0 AND announced_at IS NOT NULL",
            (actor_uid,),
        )
        return conn.total_changes - before

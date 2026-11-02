"""서버 관리 창 '계정 정리' — 이력 없는 차단·숨김 계정을 되돌릴 수 없게 지운다.

설계·합의: docs/status/계정정리_서버관리창_2026-11-02.md.
이력 = 계정을 지우면 주인을 잃는 기록. 칸 분류는 tests/test_account_cleanup.py 가 스키마 전체와 대조해 강제한다
(test_identity_registry 는 *_uid·*_by·author·worker_id 만 봐서 이메일·소유자 칸을 강제하지 못한다).
승인 상태 계정은 지우지 않는다 — 미들웨어가 approved 만 통과시키니 차단하면 새 쓰기가 끊겨 접속 여부를 재지 않아도 된다.
휴지통 payload 해석은 느려서 쓰기 잠금 밖에서 하고, 잠금 안에서 data_version 으로 그사이 바뀌지 않았는지 본다.
"""
from __future__ import annotations

import json
import os
import sqlite3
from typing import Any, Iterator, Optional

from .. import manage_db, rbac
from ..emailnorm import norm_email
from ..services import trash_transfer
from .event_journal import _record_audit_event, account_target
from .identity import _REMAP_PLAN, _col_exists
from .last_admin import last_admin_guard
from .manage_member_table import _SYSTEM_EMAILS
from .trash import _with_trash

# 계정과 함께 지우는 칸 — 그 사람의 소속과 읽음 표시다. 나머지 _REMAP_PLAN 칸은 전부 이력이다.
REMOVED_WITH_ACCOUNT = frozenset({
    ("project_member", "creator_uid"),
    ("generation_view", "owner_uid"),
    ("release_update_notice_seen", "actor_uid"),
    ("asset_comment_read", "worker_id"),
    ("generation_comment_read", "worker_id"),
    ("generation_comment_seen", "worker_id"),
})
# _REMAP_PLAN 밖의 이력 칸 — 이메일로 저장한다(정규화해 비교).
EMAIL_HISTORY = (
    ("gen_request", "account_email"),
    ("credit_txn", "account_email"),
    ("mcp_client", "account_email"),
    ("mcp_generation_plan", "account_email"),
    ("mcp_canvas_task", "account_email"),
    ("workspace_member", "account_email"),
    ("workspace_credit_group_member", "account_email"),
    ("history_import_audit", "account_email"),
    ("super_admin_session", "subject_email"),
    ("edit_doc_head", "owner"),
    ("edit_doc_copy", "owner"),
    ("edit_share", "owner"),
    ("comfy_canvas_run", "owner"),
    ("scene_keep", "owner"),
    ("asset_sync_outbox", "account_key"),
    ("asset_destination_outbox", "account_key"),
)
# _REMAP_PLAN 밖의 이력 칸 — uid 모양으로 저장한다(그대로 비교).
UID_HISTORY = (
    ("generation", "worker_id"),
    ("share_command_receipt", "actor_id"),
)
_KINDS = {
    "생성물": ("generation", "gen_request", "ai_generation_batch", "telemetry_outbox"),
    "공유": ("share", "share_state_intent", "share_command_receipt"),
    "댓글": ("generation_comment", "asset_comment"),
    "크레딧": ("credit_txn", "workspace_credit_group_member"),
    "워크스페이스": ("workspace_member",),
    "프로젝트": ("project", "project_member_removed", "project_task", "task_planned_creator",
              "task_assignment", "folder_cover"),
    "에셋": ("asset_meta", "asset_location", "asset_sync_outbox", "asset_destination_outbox",
           "asset_owner_folder", "asset_upload_token"),
    "캔버스": ("scene_backup", "scene_card_generation", "scene_keep", "comfy_canvas_run"),
    "편집": ("edit_doc_head", "edit_doc_copy", "edit_share"),
    "MCP": ("mcp_client", "mcp_generation_plan", "mcp_canvas_task"),
    "이력 가져오기": ("history_import_audit",),
    "슈퍼 관리자": ("super_admin_session",),
}
_KIND_OF = {table: kind for kind, tables in _KINDS.items() for table in tables}
_COLUMNS = "email, name, status, creator_uid, created_at, COALESCE(hidden,0) AS hidden"


class CleanupRefused(Exception):
    """지우지 않았다 — 라우터가 409 로 바꾸고 화면이 이유를 그대로 보인다."""


def uid_history_columns() -> tuple[tuple[str, str], ...]:
    return tuple((t, c) for t, c, _ in _REMAP_PLAN if (t, c) not in REMOVED_WITH_ACCOUNT) + UID_HISTORY


def _uids(row) -> list[str]:
    """이 계정의 신원 값. 옛 표기는 이메일 자체를 uid 자리에 쓴다(deps.account_author_uids)."""
    return sorted({row["email"], f"acct:{row['email']}", row["creator_uid"] or f"acct:{row['email']}"})


def _in(values: list[str]) -> str:
    return ",".join("?" * len(values))


def _count(conn, table: str, where: str, args: list[str]) -> int:
    return conn.execute(f'SELECT COUNT(*) FROM "{table}" WHERE {where}', args).fetchone()[0]  # noqa: S608 — 상수 칸 목록


def _content_history(conn, row) -> dict[str, int]:
    uids = _uids(row)
    found: dict[str, int] = {}

    def add(table: str, count: int) -> None:
        if count:
            kind = _KIND_OF.get(table, "그 밖의 기록")
            found[kind] = found.get(kind, 0) + count

    for table, col in uid_history_columns():
        if _col_exists(conn, table, col):
            add(table, _count(conn, table, f'"{col}" IN ({_in(uids)})', uids))
    for table, col in EMAIL_HISTORY:
        if _col_exists(conn, table, col):
            add(table, _count(conn, table, f'LOWER(TRIM("{col}"))=?', [row["email"]]))
    return found


def _setting(conn, key: str) -> Optional[str]:
    # get_setting 은 별도 연결을 여는 공개 함수라 삭제 트랜잭션을 일찍 커밋할 수 있다 — 같은 conn 으로 읽는다.
    found = conn.execute("SELECT value FROM app_setting WHERE key=?", (key,)).fetchone()
    return found["value"] if found else None


def _system_emails() -> set[str]:
    configured = norm_email(os.environ.get("CONTENT_HUB_ADMIN_EMAIL") or "")
    return set(_SYSTEM_EMAILS) | ({configured} if configured else set())


def _protection(conn, row, actor_email: str) -> Optional[str]:
    """이력과 무관하게 지우면 안 되는 계정이면 그 이유."""
    email, uid = row["email"], row["creator_uid"]
    if email == actor_email:
        return "자기 계정"
    if email in _system_emails():
        return "시스템 계정"
    if email == norm_email(_setting(conn, "provider_email") or ""):
        return "서버 힉스필드 계정"
    if uid and uid == _setting(conn, "my_creator_uid"):
        return "서버 힉스필드 계정"
    if uid and not uid.startswith("acct:"):
        return "힉스필드 연결"
    if uid and conn.execute("SELECT 1 FROM account WHERE creator_uid=? AND email<>? LIMIT 1", (uid, email)).fetchone():
        return "같은 이름표를 쓰는 계정"
    return None


def _judge(conn, row, actor_email: str, outside: dict[str, int]) -> dict[str, Any]:
    """판정 하나 — 목록과 삭제 잠금 안이 같은 규칙을 쓴다."""
    blocks = {**_content_history(conn, row), **outside}
    protection = _protection(conn, row, actor_email)
    reasons = [{"kind": kind, "count": count} for kind, count in sorted(blocks.items())]
    if protection:
        reasons.insert(0, {"kind": protection, "count": 0})
    if reasons:
        verdict = "blocked"
    elif row["status"] == "approved":
        verdict = "block_first"
    elif row["status"] == "rejected" or row["hidden"]:
        verdict = "deletable"
    else:
        verdict = "blocked"
        reasons = [{"kind": "차단·숨김 계정이 아님", "count": 0}]
    return {"verdict": verdict, "reasons": reasons}


def _strings(value: Any) -> Iterator[str]:
    if isinstance(value, str):
        yield value
    elif isinstance(value, dict):
        for item in value.values():
            yield from _strings(item)
    elif isinstance(value, list):
        for item in value:
            yield from _strings(item)


def _trash_history(conn, rows: list) -> dict[str, int]:
    """휴지통 안 생성물의 계정 흔적 수 {email: 건수}. 다른 사람 생성물의 댓글·공유·최종 지정도 payload 안에 있어
    문자열을 전부 훑는다. JSON 을 해석하고 찾아야 이스케이프된 이메일을 놓치지 않는다. 부분 문자열 오탐은 막는 쪽이라 받아들인다."""
    wanted = {row["email"]: _uids(row) for row in rows}
    hits = dict.fromkeys(wanted, 0)
    if not wanted:
        return hits
    for trashed in conn.execute("SELECT creator_uid, payload FROM trash.trashed"):
        try:
            text = "\0".join(_strings(json.loads(trashed["payload"]))).lower()
        except (TypeError, ValueError) as exc:
            raise CleanupRefused("휴지통 기록을 읽지 못해 이력을 확인할 수 없습니다") from exc
        outer = (trashed["creator_uid"] or "").lower()
        for email, needles in wanted.items():
            if any(needle.lower() in text or needle.lower() == outer for needle in needles):
                hits[email] += 1
    return hits


def _fact_history(rows: list) -> dict[str, int]:
    """manage_hub.db 의 생성 보고 수 {email: 건수}. get_connection 은 파일이 없으면 빈 파일을 만들어서 먼저 본다."""
    hits = {row["email"]: 0 for row in rows}
    if not rows or not manage_db.MANAGE_DB_PATH.is_file():
        return hits
    with manage_db.get_connection() as conn:
        if not _col_exists(conn, "team_generation_fact", "account_email"):
            return hits
        for row in rows:
            uids = _uids(row)
            hits[row["email"]] = _count(
                conn, "team_generation_fact",
                f'LOWER(TRIM(account_email))=? OR creator_uid IN ({_in(uids)})', [row["email"], *uids],
            )
    return hits


def _outside(email: str, trash: dict[str, int], facts: dict[str, int]) -> dict[str, int]:
    found: dict[str, int] = {}
    if trash.get(email):
        found["휴지통"] = trash[email]
    if facts.get(email):
        found["생성 보고"] = facts[email]
    return found


def _project_memberships(conn, row) -> int:
    uids = _uids(row)
    return _count(conn, "project_member", f"creator_uid IN ({_in(uids)})", uids)


def list_cleanup_accounts(actor_email: str) -> list[dict[str, Any]]:
    """차단했거나 숨긴 계정과 판정. 승인 대기 중이고 숨기지 않은 계정은 나오지 않는다."""
    actor_email = norm_email(actor_email)
    with _with_trash() as conn:
        rows = conn.execute(
            f"SELECT {_COLUMNS} FROM account WHERE status='rejected' OR COALESCE(hidden,0)=1 "  # noqa: S608 — 상수
            "ORDER BY created_at DESC, email"
        ).fetchall()
        trash, facts = _trash_history(conn, rows), _fact_history(rows)
        return [{
            "email": row["email"], "name": row["name"], "status": row["status"], "hidden": bool(row["hidden"]),
            "created_at": row["created_at"], "project_memberships": _project_memberships(conn, row),
            **_judge(conn, row, actor_email, _outside(row["email"], trash, facts)),
        } for row in rows]


def _assert_no_pending_transfer(conn) -> None:
    try:
        trash_transfer.assert_no_pending(conn)
        pending = trash_transfer.enabled(conn) and conn.execute(
            "SELECT 1 FROM trash.move_operation WHERE phase='prepared' LIMIT 1").fetchone()
    except trash_transfer.TransferRecoveryRequired as exc:
        raise CleanupRefused("휴지통 이동 복구가 끝나지 않아 지금은 지울 수 없습니다") from exc
    if pending:
        raise CleanupRefused("휴지통 이동 복구가 끝나지 않아 지금은 지울 수 없습니다")


def _trash_version(conn) -> int:
    return conn.execute("PRAGMA trash.data_version").fetchone()[0]


def _account(conn, email: str) -> Optional[sqlite3.Row]:
    return conn.execute(f"SELECT {_COLUMNS} FROM account WHERE email=?", (email,)).fetchone()  # noqa: S608 — 상수


def delete_cleanup_account(
    email: str,
    *,
    status: str,
    hidden: bool,
    created_at: str,
    actor_email: str,
    actor_uid: Optional[str],
) -> dict[str, Any]:
    """확인 창에서 본 값(status·hidden·created_at)이 그대로일 때만 지운다. 지우지 않으면 CleanupRefused."""
    email, actor_email = norm_email(email), norm_email(actor_email)
    with _with_trash() as conn:
        version = _trash_version(conn)
        seen = _account(conn, email)
        if seen is None:
            raise CleanupRefused("이미 없는 계정입니다")
        trash = _trash_history(conn, [seen])
        conn.execute("BEGIN IMMEDIATE")  # 휴지통도 붙어 있어 여기서부터 둘 다 잠긴다. ★transaction-root 전용
        if _trash_version(conn) != version:
            raise CleanupRefused("확인하는 사이 휴지통이 바뀌었습니다 — 다시 눌러 주세요")
        _assert_no_pending_transfer(conn)
        actor = conn.execute("SELECT status, global_role FROM account WHERE email=?", (actor_email,)).fetchone()
        if not actor or actor["status"] != "approved" or rbac.ADMIN not in rbac.parse_roles(actor["global_role"]):
            raise CleanupRefused("관리자 권한을 다시 확인하지 못했습니다")
        row = _account(conn, email)
        if row is None:
            raise CleanupRefused("이미 없는 계정입니다")
        if (row["status"], bool(row["hidden"]), row["created_at"]) != (status, bool(hidden), created_at):
            raise CleanupRefused("확인하는 사이 계정이 바뀌었습니다 — 목록을 다시 읽어 주세요")
        # manage DB 는 별도 파일이라 이 잠금에 안 묶인다 — 지우기 바로 앞에서 읽어 틈을 '재확인을 이미 지난 요청'으로 좁힌다.
        judged = _judge(conn, row, actor_email, _outside(email, trash, _fact_history([row])))
        if judged["verdict"] != "deletable":
            kinds = ", ".join(reason["kind"] for reason in judged["reasons"]) or "먼저 차단"
            raise CleanupRefused(f"지울 수 없는 계정입니다: {kinds}")
        uids = _uids(row)
        memberships = _project_memberships(conn, row)
        with last_admin_guard(conn):
            for table, col in sorted(REMOVED_WITH_ACCOUNT):
                if _col_exists(conn, table, col):
                    conn.execute(f'DELETE FROM "{table}" WHERE "{col}" IN ({_in(uids)})', uids)  # noqa: S608 — 상수
            conn.execute("DELETE FROM app_setting WHERE key=?", (f"hf_status:{email}",))
            conn.execute(f"DELETE FROM creator WHERE uid IN ({_in(uids)})", uids)  # noqa: S608 — 상수
            conn.execute(f"DELETE FROM worker WHERE id IN ({_in(uids)})", uids)  # noqa: S608 — 상수
            conn.execute("DELETE FROM account WHERE email=?", (email,))
        _record_audit_event(
            conn, "account.deleted", actor_uid=actor_uid, target_type="account",
            target_id=account_target(email), fields=["account"], details={"project_memberships": memberships},
        )
        conn.execute("COMMIT")
    return {"email": email, "project_memberships": memberships}

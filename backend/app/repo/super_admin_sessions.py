"""10분 슈퍼 관리자 세션 저장소.

일반 로그인 세션과 분리하며 원문 권한 토큰은 DB에 저장하지 않는다. 서버가 서명·만료를
검증한 뒤 이 저장소에서 수동 해제/재발급 여부를 한 번 더 확인한다.
"""

from __future__ import annotations

import hashlib
import time
from typing import Any, Optional

from ..db import get_connection
from ..emailnorm import norm_email


def _token_hash(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def issue_super_admin_session(
    *,
    jti: str,
    subject_email: str,
    subject_uid: str,
    token: str,
    scope: str,
    issued_at: int,
    expires_at: int,
) -> None:
    """같은 계정의 기존 활성 세션을 해제하고 새 세션 하나를 발급한다."""
    email = norm_email(subject_email)
    with get_connection() as conn:
        conn.execute("BEGIN IMMEDIATE")
        try:
            conn.execute(
                "UPDATE super_admin_session SET revoked_at=? "
                "WHERE subject_email=? AND revoked_at IS NULL AND expires_at>?",
                (issued_at, email, issued_at),
            )
            conn.execute(
                "INSERT INTO super_admin_session"
                "(jti,subject_email,subject_uid,token_hash,scope,issued_at,expires_at) "
                "VALUES(?,?,?,?,?,?,?)",
                (
                    jti,
                    email,
                    subject_uid,
                    _token_hash(token),
                    scope,
                    int(issued_at),
                    int(expires_at),
                ),
            )
            # 만료·해제 후 30일이 지난 행은 감사 원장(audit_event)에 이미 남으므로 정리한다.
            conn.execute(
                "DELETE FROM super_admin_session WHERE expires_at<?",
                (int(issued_at) - 30 * 24 * 3600,),
            )
            conn.execute("COMMIT")
        except Exception:
            conn.execute("ROLLBACK")
            raise


def active_super_admin_session(
    *,
    jti: str,
    subject_email: str,
    subject_uid: str,
    token: str,
    scope: str,
    now: Optional[int] = None,
) -> Optional[dict[str, Any]]:
    """서명 검증을 마친 토큰이 아직 서버에서 활성인지 확인한다."""
    current = int(time.time()) if now is None else int(now)
    with get_connection() as conn:
        row = conn.execute(
            "SELECT jti,subject_email,subject_uid,scope,issued_at,expires_at,revoked_at,token_hash "
            "FROM super_admin_session WHERE jti=?",
            (jti,),
        ).fetchone()
    if not row:
        return None
    data = dict(row)
    if (
        data.get("revoked_at") is not None
        or int(data.get("expires_at") or 0) <= current
        or norm_email(data.get("subject_email")) != norm_email(subject_email)
        or str(data.get("subject_uid") or "") != str(subject_uid or "")
        or str(data.get("scope") or "") != scope
        or data.get("token_hash") != _token_hash(token)
    ):
        return None
    data.pop("token_hash", None)
    return data


def revoke_super_admin_session(jti: str, *, now: Optional[int] = None) -> bool:
    current = int(time.time()) if now is None else int(now)
    with get_connection() as conn:
        cursor = conn.execute(
            "UPDATE super_admin_session SET revoked_at=? WHERE jti=? AND revoked_at IS NULL",
            (current, jti),
        )
    return bool(cursor.rowcount)

"""로그인 계정 데이터 접근 (보안) — 로드맵 §4-1/§4-2.

계정 = '로그인하는 사람'. 멤버(creator, 생성물 작성자)와 별개 축이지만 creator_uid 로 연결 가능.
자동 등록(pending) → 관리자 승인(approved). **첫 계정은 부트스트랩 관리자(C0/approved)** —
서버를 처음 띄운 사람이 자동으로 관리자가 되어 이후 가입자를 승인한다.
비밀번호 해시·토큰은 services/auth.py(stdlib). 여기선 password_hash 를 절대 밖으로 내보내지 않는다.
"""

from __future__ import annotations

from typing import Any, Optional

from .. import rbac
from ..db import get_connection
from ..services import auth

_PUBLIC = "email, name, status, global_role, creator_uid, created_at, approved_at, password_changed_at, COALESCE(hidden,0) AS hidden"


def _row(conn, email: str) -> Optional[dict[str, Any]]:
    r = conn.execute(
        f"SELECT {_PUBLIC} FROM account WHERE email=?", (email.lower(),)
    ).fetchone()
    if not r:
        return None
    d = dict(r)
    # global_role 은 CSV(복수). 응답엔 리스트(global_roles)도 함께 실어 프론트가 바로 쓰게.
    d["global_roles"] = rbac.effective_roles(d.get("global_role"))
    # 하우스 계정 = 서버 힉스필드(my_creator_uid)에 연결된 계정 = 워크스페이스 전환·생성 등
    # '서버 CLI 행위'의 주체. 프론트가 이 플래그로 워크스페이스 스위처 노출을 가린다.
    myrow = conn.execute(
        "SELECT value FROM app_setting WHERE key='my_creator_uid'"
    ).fetchone()
    my_uid = myrow["value"] if myrow else None
    d["is_house"] = bool(d.get("creator_uid")) and d["creator_uid"] == my_uid
    d["hidden"] = bool(d.get("hidden"))
    return d


def count_accounts() -> int:
    with get_connection() as conn:
        return conn.execute("SELECT COUNT(*) c FROM account").fetchone()["c"]


def register(email: str, password: str, name: Optional[str] = None) -> dict[str, Any]:
    """신규 계정 등록. 첫 계정 → 부트스트랩 관리자(admin/approved), 그 외 → member/pending.
    이미 있는 이메일이면 ValueError. password 는 해시로만 저장."""
    email = (email or "").strip().lower()
    if not email or "@" not in email:
        raise ValueError("올바른 이메일이 필요합니다")
    if not password or len(password) < 6:
        raise ValueError("비밀번호는 6자 이상이어야 합니다")
    with get_connection() as conn:
        if conn.execute("SELECT 1 FROM account WHERE email=?", (email,)).fetchone():
            raise ValueError("이미 등록된 이메일입니다")
        first = conn.execute("SELECT COUNT(*) c FROM account").fetchone()["c"] == 0
        status = "approved" if first else "pending"  # 첫 계정 = 부트스트랩 관리자
        # 첫 계정(소유자)은 admin + product_manager 둘 다 — 사람 관리와 프로젝트 생성·관리를
        # 처음부터 할 수 있게(둘을 분리해 둔 탓에 admin 단독이면 프로젝트를 못 만드는 데드락 방지).
        global_role = f"{rbac.ADMIN},{rbac.PRODUCT_MANAGER}" if first else rbac.MEMBER
        conn.execute(
            "INSERT INTO account(email, name, password_hash, status, global_role) VALUES(?,?,?,?,?)",
            (email, (name or "").strip() or None, auth.hash_password(password), status, global_role),
        )
        if first:
            conn.execute(
                "UPDATE account SET approved_at=datetime('now') WHERE email=?", (email,)
            )
        return _row(conn, email)


def ensure_admin_account(email: str, password: str) -> bool:
    """부트스트랩 관리자 계정 보장 — 없으면 생성(admin+product_manager·approved). 멱등.
    이미 있으면 절대 건드리지 않는다(비밀번호·역할 보존). 서버(AUTH on) 시작 시 호출해서
    '관리자 계정을 따로 안 만들어도 처음부터 있게' 한다. True=새로 만듦."""
    email = (email or "").strip().lower()
    if not email or "@" not in email or not password or len(password) < 6:
        return False
    with get_connection() as conn:
        if conn.execute("SELECT 1 FROM account WHERE email=?", (email,)).fetchone():
            return False  # 이미 있음 — 보존
        conn.execute(
            "INSERT INTO account(email, name, password_hash, status, global_role, approved_at) "
            "VALUES(?,?,?,?,?,datetime('now'))",
            (
                email,
                "admin",
                auth.hash_password(password),
                "approved",
                f"{rbac.ADMIN},{rbac.PRODUCT_MANAGER}",
            ),
        )
    return True


def authenticate(email: str, password: str) -> Optional[dict[str, Any]]:
    """이메일+비밀번호 검증. 성공 시 계정(공개필드) 반환, 실패 시 None.
    status 와 무관하게 비밀번호만 검증(승인 여부는 호출측에서 판단)."""
    email = (email or "").strip().lower()
    with get_connection() as conn:
        row = conn.execute(
            "SELECT password_hash FROM account WHERE email=?", (email,)
        ).fetchone()
        if not row or not auth.verify_password(password, row["password_hash"]):
            return None
        return _row(conn, email)


def get_account(email: str) -> Optional[dict[str, Any]]:
    with get_connection() as conn:
        return _row(conn, (email or "").strip().lower())


def list_accounts(
    status: Optional[str] = None, include_hidden: bool = False
) -> list[dict[str, Any]]:
    """계정 목록(관리자용). status 로 필터(pending/approved/rejected). 해시 제외.
    기본은 숨김 계정 제외 — include_hidden=True('숨긴 계정 보기')면 함께 반환."""
    conds: list[str] = []
    args: list[Any] = []
    if status:
        conds.append("status=?")
        args.append(status)
    if not include_hidden:
        conds.append("COALESCE(hidden,0)=0")
    clause = (" WHERE " + " AND ".join(conds)) if conds else ""
    with get_connection() as conn:
        rows = conn.execute(
            f"SELECT {_PUBLIC} FROM account{clause} "
            "ORDER BY CASE status WHEN 'pending' THEN 0 WHEN 'approved' THEN 1 ELSE 2 END, "
            "created_at DESC",
            tuple(args),
        ).fetchall()
        return [dict(r) for r in rows]


def set_password(email: str, new_password: str) -> Optional[dict[str, Any]]:
    """비밀번호 변경(본인 또는 관리자 초기화). 해시로만 저장. 없는 계정이면 None."""
    email = (email or "").strip().lower()
    if not new_password or len(new_password) < 6:
        raise ValueError("비밀번호는 6자 이상이어야 합니다")
    with get_connection() as conn:
        if not conn.execute("SELECT 1 FROM account WHERE email=?", (email,)).fetchone():
            return None
        # password_changed_at 갱신 → 이 변경 이전에 발급된 토큰은 전부 무효(탈취/공유 대응).
        conn.execute(
            "UPDATE account SET password_hash=?, password_changed_at=datetime('now') WHERE email=?",
            (auth.hash_password(new_password), email),
        )
        return _row(conn, email)


def set_account_hidden(email: str, hidden: bool) -> Optional[dict[str, Any]]:
    """계정 숨김/표시 토글(관리자). 숨기면 멤버·승인 목록에서 가려진다. 없는 계정이면 None."""
    email = (email or "").strip().lower()
    with get_connection() as conn:
        if not conn.execute("SELECT 1 FROM account WHERE email=?", (email,)).fetchone():
            return None
        conn.execute(
            "UPDATE account SET hidden=? WHERE email=?", (1 if hidden else 0, email)
        )
        return _row(conn, email)


def set_account_status(email: str, status: str) -> Optional[dict[str, Any]]:
    """승인/거부/대기 전환. approved 면 approved_at 기록."""
    if status not in ("pending", "approved", "rejected"):
        raise ValueError(f"잘못된 상태: {status}")
    email = (email or "").strip().lower()
    with get_connection() as conn:
        if not conn.execute("SELECT 1 FROM account WHERE email=?", (email,)).fetchone():
            return None
        if status == "approved":
            # 승인 시 전역 역할이 비어 있으면 기본 member 로 보장(승인된 계정의 기본 역할=member).
            conn.execute(
                "UPDATE account SET status='approved', "
                "approved_at=COALESCE(approved_at, datetime('now')), "
                "global_role=CASE WHEN global_role IS NULL OR global_role='' "
                "THEN 'member' ELSE global_role END WHERE email=?",
                (email,),
            )
        else:
            conn.execute("UPDATE account SET status=? WHERE email=?", (status, email))
        return _row(conn, email)


def set_account_name(email: str, name: Optional[str]) -> Optional[dict[str, Any]]:
    """계정 표시이름 변경(계정별 — 전역 provider 와 무관). creator_uid 가 연결돼 있으면
    creator.name 에도 미러한다 → 멤버 목록·작성자 표기를 표시이름으로 일관(UI 는 uid 를 보이지 않음)."""
    name = (name or "").strip() or None
    email = (email or "").strip().lower()
    with get_connection() as conn:
        row = conn.execute(
            "SELECT creator_uid FROM account WHERE email=?", (email,)
        ).fetchone()
        if not row:
            return None
        conn.execute("UPDATE account SET name=? WHERE email=?", (name, email))
        uid = row["creator_uid"]
        if uid and name:
            conn.execute(
                "INSERT INTO creator(uid, name) VALUES(?,?) "
                "ON CONFLICT(uid) DO UPDATE SET name=excluded.name",
                (uid, name),
            )
        return _row(conn, email)


def set_account_global_roles(
    email: str, global_roles: rbac.RolesInput
) -> Optional[dict[str, Any]]:
    """v02 전역 역할(복수) 부여 — 리스트/CSV 입력을 CSV 로 저장. 빈 입력이면 member 로.
    creator_uid 가 연결돼 있으면 creator.global_role 에도 미러 — 멤버 목록 표기 일관."""
    csv = rbac.roles_to_str(global_roles) or rbac.MEMBER
    email = (email or "").strip().lower()
    with get_connection() as conn:
        cur = conn.execute(
            "UPDATE account SET global_role=? WHERE email=?", (csv, email)
        )
        if not cur.rowcount:
            return None
        row = conn.execute(
            "SELECT creator_uid FROM account WHERE email=?", (email,)
        ).fetchone()
        if row and row["creator_uid"]:
            conn.execute(
                "INSERT INTO creator(uid, global_role) VALUES(?,?) "
                "ON CONFLICT(uid) DO UPDATE SET global_role=excluded.global_role",
                (row["creator_uid"], csv),
            )
        return _row(conn, email)

"""DB 내보내기 비밀값 정제 — 전송용/테스트 스냅샷용 프로파일을 한곳에서 관리한다.

두 프로파일은 목적이 달라 강도가 다르다(합치면 전송·복원 의미가 깨진다):
- 전송(transfer): 개인 DB를 다른 PC/서버로 옮길 때 세션·서명키만 제거.
  계정·비밀번호 해시는 보존한다 — 받는 쪽 ``_install_db`` 가 재로그인을 강제한다.
- 테스트 스냅샷(test snapshot): 운영 DB 사본을 테스트 서버용으로 만들 때
  운영 서명키·세션은 물론 운영 비밀번호 해시까지 무력화하고, 알려진 테스트
  관리자 1명만 로그인 가능하게 한다. 스냅샷 ZIP 이 유출돼도 운영 토큰 위조
  (auth_secret)·운영 비밀번호 크래킹 재료가 남지 않는다.
"""

from __future__ import annotations

import sqlite3
from contextlib import closing
from pathlib import Path

# 업로드 전/복원 후 비울 세션·보안·신원 키. 가져온 DB 가 남의 토큰으로 서버에 proxy 하거나 위장
# 로그인되는 것을 막고, 남의 .db 를 파일 가져오기 했을 때 그 사람의 로그인 신원·역할(admin 뱃지)이
# 남지 않게 한다(서버 주소 shared_server_url 만 무해해 남긴다). ★email/name/roles 도 비운다 —
# 안 그러면 가져온 DB 주인이 admin 이었으면 가져온 사람 화면에 admin 탭이 (재로그인 전까지) 뜬다.
SESSION_KEYS = (
    "shared_server_token",
    "shared_server_email",
    "shared_server_name",
    "shared_server_roles",
    "shared_server_elev_token",
    "shared_server_elev_email",
    "shared_server_elev_name",
    "auth_secret",
    # Comfy Cloud API 키 — 자격증명은 각 PC 밖으로 내보내지 않는다는 원칙(HF 토큰과 동일).
    # 서버 백업·테스트 스냅샷 어디에도 남기지 않으며, 복원/가져오기 후에는 재입력한다.
    "comfy_api_key",
)

# 테스트 스냅샷 전용 고정 계정 — 정제된 스냅샷에서 유일하게 로그인 가능한 계정.
TEST_ADMIN_EMAIL = "test-admin@mvhub.local"
TEST_ADMIN_PASSWORD = "mvhub-test-1234"

# pbkdf2_sha256$iter$salt$hash 형식이 아니므로 verify_password 가 항상 False — 로그인 불가 마커.
DISABLED_PASSWORD_HASH = "disabled$test-snapshot"


def _table_exists(conn: sqlite3.Connection, name: str) -> bool:
    row = conn.execute(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (name,)
    ).fetchone()
    return row is not None


def strip_transfer_secrets(db_path: Path) -> None:
    """전송 프로파일: 주어진 .db 의 세션·보안 설정만 비운다(업로드 사본/복원 대상에 적용)."""
    c = sqlite3.connect(str(db_path))
    try:
        c.execute("BEGIN")
        for k in SESSION_KEYS:
            c.execute("DELETE FROM app_setting WHERE key=?", (k,))
        c.execute("COMMIT")
    except sqlite3.DatabaseError:
        pass
    finally:
        c.close()


def scrub_test_snapshot_db(db_path: Path, *, create_test_admin: bool) -> None:
    """테스트 스냅샷 프로파일: 임시 사본(원본 아님)에서 운영 비밀값을 전부 무력화한다.

    - 세션 키·auth_secret 삭제 → 테스트 서버가 부팅 시 자기 서명키를 새로 생성한다.
    - 운영 계정 비밀번호 해시를 로그인 불가 마커로 치환(+password_changed_at 갱신으로
      혹시 남은 옛 토큰도 무효화). 운영 해시 자체가 번들에 남지 않는다.
    - 기본 DB(``create_test_admin=True``)에만 테스트 관리자 1명을 만든다.

    전송 프로파일과 달리 실패를 삼키지 않는다 — 정제 안 된 스냅샷이 조용히
    나가는 것이 곧 비밀값 유출이므로, sqlite 오류는 호출자가 중단 처리한다.
    """
    with closing(sqlite3.connect(str(db_path))) as conn:
        conn.execute("BEGIN")
        if _table_exists(conn, "app_setting"):
            for k in SESSION_KEYS:
                conn.execute("DELETE FROM app_setting WHERE key=?", (k,))
        if _table_exists(conn, "account"):
            conn.execute(
                "UPDATE account SET password_hash=?, password_changed_at=datetime('now')",
                (DISABLED_PASSWORD_HASH,),
            )
            if create_test_admin:
                from .auth import hash_password  # 순수 함수(DB 미사용) — 해시 형식 단일 출처

                conn.execute(
                    "INSERT INTO account(email, name, password_hash, status, global_role, approved_at) "
                    "VALUES(?,?,?,?,?,datetime('now')) "
                    "ON CONFLICT(email) DO UPDATE SET "
                    "password_hash=excluded.password_hash, status=excluded.status, "
                    "global_role=excluded.global_role, approved_at=excluded.approved_at",
                    (
                        TEST_ADMIN_EMAIL,
                        "테스트 관리자",
                        hash_password(TEST_ADMIN_PASSWORD),
                        "approved",
                        "admin,product_manager",
                    ),
                )
        conn.execute("COMMIT")

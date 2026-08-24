"""인증 서비스 — 비밀번호 해시 + 서명 세션 토큰 (로드맵 §4-2).

stdlib 만 사용한다(새 의존성 0 — 팀원 fresh install 안전):
- 비밀번호: hashlib.pbkdf2_hmac (sha256, 솔트+반복). 저장형식 pbkdf2_sha256$iter$salt$hash.
- 세션 토큰: hmac-sha256 서명. payload(email·만료) + 서명 → 위조 불가(서버 시크릿 모르면).
  서버 시크릿은 app_setting 에 1회 생성·영속(secrets.token_hex). 토큰 무상태(서버 저장 불필요).
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import secrets
import threading
import time
from typing import Any, Optional

from .. import db
from ..db import get_connection

_PBKDF2_ITERS = 200_000
_TOKEN_TTL = 14 * 24 * 3600  # 2주
SUPER_ADMIN_TTL = 10 * 60
SUPER_ADMIN_SCOPE = "superadmin_workspace"
SUPER_ADMIN_HEADER = "X-MVHub-Super-Session"


# ── 서버 시크릿(app_setting 'auth_secret') ───────────────────────────────────
# 서명 경로(_sign)는 토큰이 달린 '모든' 요청에서 이벤트 루프 위에 돈다. 여기서 SQLite 를 열면
# 요청마다 DB 왕복이 생길 뿐 아니라, DB 파일 교체(복원) 게이트에 무제한으로 걸려 이벤트 루프
# 전체(HTTP·WS)가 멈춘다. 그래서 시크릿은 프로세스 캐시에 한 번만 읽어 둔다(R11 A1).
#
# ★캐시 키 = (현재 DB 경로, db.pool_epoch()).
#   - 경로: 계정 전환(active.json)으로 다른 DB 를 보게 되면 시크릿도 그 DB 것이어야 한다.
#   - 에폭: 같은 경로에 파일을 통째 교체하는 복원은 경로가 안 바뀐다. db_transfer._install_db 가
#     유지보수 게이트 안에서 flush_pool()(=에폭 +1)을 먼저 하고, 그 뒤에야 파일 교체와
#     _post_install_security_init(auth_secret 회전)을 한다 — 즉 '에폭 변화가 회전보다 항상
#     먼저'라 옛 시크릿이 캐시에 살아남을 수 없다(R7 0-B: 복원 후 옛 토큰은 반드시 거부).
#     실패 롤백 경로도 flush_pool 을 한 번 더 하므로 같은 규칙으로 무효화된다.
#   - 키 스냅샷은 반드시 DB 를 읽기 '전'에 뜬다. 읽는 도중 회전이 끼면 옛 값이 옛 키로만 박히고,
#     현재 에폭으로 조회하는 다음 요청은 미스가 나 새 시크릿을 읽는다.
_secret_lock = threading.Lock()
_secret_cache: tuple[tuple[str, int], str] | None = None


class AuthSecretUnavailable(RuntimeError):
    """DB 교체(유지보수) 중이라 서명 시크릿을 읽을 수 없다 — 서명 경로는 닫는다."""


def _secret_cache_key() -> tuple[str, int]:
    return (str(db.get_db_path()), db.pool_epoch())


_SECRET_SELECT = "SELECT value FROM app_setting WHERE key='auth_secret'"


def _load_secret() -> str:
    """auth_secret 을 읽고, 없으면 만든다(멱등).

    ★생성은 INSERT ... ON CONFLICT DO NOTHING + 재-SELECT 다. 종전 read-generate-write 는
    동시 진입 시 '나중 쓰기'가 이겨, 앞선 시크릿으로 방금 발급된 토큰이 즉시 401 이 됐다(A2).
    커넥션은 autocommit(isolation_level=None)이라 세 문장이 각각 독립 트랜잭션 —
    먼저 넣은 쪽 값이 남고 모두가 그 값을 돌려받는다.
    """
    with get_connection() as conn:
        row = conn.execute(_SECRET_SELECT).fetchone()
        if not (row and row["value"]):
            conn.execute(
                "INSERT INTO app_setting(key, value) VALUES('auth_secret', ?) "
                "ON CONFLICT(key) DO NOTHING",
                (secrets.token_hex(32),),
            )
            row = conn.execute(_SECRET_SELECT).fetchone()
    if not (row and row["value"]):
        raise AuthSecretUnavailable("auth_secret 을 읽지 못했습니다")
    return row["value"]


def get_secret() -> str:
    """서명용 서버 시크릿. env CONTENT_HUB_AUTH_SECRET 우선, 그 외엔 프로세스 캐시(DB 1회)."""
    global _secret_cache

    env = os.environ.get("CONTENT_HUB_AUTH_SECRET")
    if env:
        return env
    cached = _secret_cache
    if cached is not None and cached[0] == _secret_cache_key():
        return cached[1]
    with _secret_lock:
        # 락을 기다리는 사이 에폭이 바뀌었을 수 있으니 키를 다시 뜬다(항상 DB 읽기 직전).
        key = _secret_cache_key()
        cached = _secret_cache
        if cached is not None and cached[0] == key:
            return cached[1]
        if db.maintenance_active():
            # DB 파일 교체 중 — 여기서 커넥션을 열면 게이트가 풀릴 때까지 무제한 대기이고,
            # 그 대기가 이벤트 루프에서 일어난다. 교체가 끝나면 시크릿·비번 스탬프가 모두
            # 회전해 어차피 전 토큰이 무효이므로, 열지 않고 실패로 닫는다(fail-closed).
            raise AuthSecretUnavailable("DB 유지보수 중에는 세션을 검증할 수 없습니다")
        secret = _load_secret()
        _secret_cache = (key, secret)
        return secret


# ── 비밀번호 해시 ────────────────────────────────────────────────────────────
def hash_password(password: str) -> str:
    salt = secrets.token_bytes(16)
    dk = hashlib.pbkdf2_hmac("sha256", password.encode(), salt, _PBKDF2_ITERS)
    return f"pbkdf2_sha256${_PBKDF2_ITERS}${salt.hex()}${dk.hex()}"


def verify_password(password: str, stored: str) -> bool:
    try:
        algo, iters, salt_hex, hash_hex = stored.split("$")
        if algo != "pbkdf2_sha256":
            return False
        dk = hashlib.pbkdf2_hmac(
            "sha256", password.encode(), bytes.fromhex(salt_hex), int(iters)
        )
        return hmac.compare_digest(dk.hex(), hash_hex)
    except (ValueError, AttributeError):
        return False


# ── 서명 세션 토큰(무상태) ───────────────────────────────────────────────────
def _b64e(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).decode().rstrip("=")


def _b64d(s: str) -> bytes:
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


def _sign(payload_b64: str) -> str:
    return hmac.new(
        get_secret().encode(), payload_b64.encode(), hashlib.sha256
    ).hexdigest()


def make_token(email: str, ttl: int = _TOKEN_TTL, pwd_stamp: Optional[str] = None) -> str:
    body = {"k": "session", "e": email, "x": int(time.time()) + ttl}
    if pwd_stamp:
        body["p"] = pwd_stamp  # 발급 시점의 account.password_changed_at — 비번 변경 후 옛 토큰 거부에 사용
    payload = _b64e(json.dumps(body).encode())
    return f"{payload}.{_sign(payload)}"


class _SecretUnavailable:
    """'토큰이 무효'와 '지금은 검증할 수 없음'을 구분하는 표식(opt-in 반환값).

    둘 다 "인증 안 됨"이지만 원인이 다르다 — 무효 토큰은 로그아웃(401/1008)이 맞고,
    DB 파일 교체 중이라 서명 시크릿을 못 읽은 것은 일시 거부(503/1013)여야 한다. 검증한
    바로 그 순간의 원인을 호출부가 그대로 받아야, 판정 시점에 유지보수 게이트를 다시
    표본해 '그 사이 게이트가 내려가서 401 오판'하는 창이 사라진다(R13-AUTH-1).
    """

    __slots__ = ()

    def __repr__(self) -> str:  # 로그에서 None 과 헷갈리지 않게
        return "<SECRET_UNAVAILABLE>"


SECRET_UNAVAILABLE = _SecretUnavailable()


def _decode_verified(token: Optional[str], unavailable=None):
    """서명·만료 검증을 통과한 payload dict 반환, 아니면 None.

    ★unavailable 을 준 호출부에만 '시크릿 사용 불가'를 그 표식으로 돌려준다. 기본값(None)은
    종전과 완전히 같은 동작이라 기존 호출부·계약은 그대로다(무효와 합쳐 None).
    """
    if not token or "." not in token:
        return None  # 형식오류 = 진짜 무효(시크릿과 무관) → 유지보수 중이어도 401 이 맞다
    payload_b64, sig = token.rsplit(".", 1)
    try:
        expected = _sign(payload_b64)
    except AuthSecretUnavailable:
        return unavailable  # 유지보수 중 = 검증 불가(루프를 막고 기다리지 않는다)
    if not hmac.compare_digest(sig, expected):
        return None
    try:
        data = json.loads(_b64d(payload_b64))
    except (ValueError, json.JSONDecodeError):
        return None
    if int(data.get("x", 0)) < int(time.time()):
        return None  # 만료
    return data


def verify_token(token: Optional[str], *, unavailable=None):
    """유효하면 email 반환, 아니면 None(서명 불일치·만료·형식오류).

    unavailable 을 주면 '시크릿 사용 불가(유지보수)'일 때만 None 대신 그 값을 돌려준다 —
    원인 구분이 필요한 호출부(미들웨어·WS)만 쓰고, 정상 인증 경로에 드는 비용은 0 이다.
    """
    data = _decode_verified(token, unavailable)
    if not isinstance(data, dict):
        return data  # None(무효) 또는 호출부가 건넨 '검증 불가' 표식
    # 예전 일반 토큰(k 없음)은 계속 허용하되, 슈퍼 관리자 같은 다른 용도의 서명 토큰을
    # Authorization에 넣어 일반 로그인으로 승격시키는 교차 사용은 거부한다.
    if data.get("k") not in (None, "session"):
        return None
    return data.get("e")


def token_password_stamp(token: Optional[str], *, unavailable=None):
    """토큰에 박힌 비번-스탬프(발급 시점의 password_changed_at). 구버전 토큰이면 None.

    ★이건 verify_token 과 별개의 두 번째 서명이다 — 그 사이에 교체가 시작되면 스탬프만
    None 이 돼 '비번 바뀐 옛 토큰'으로 오인된다. unavailable 로 그 경우를 구분한다.
    """
    data = _decode_verified(token, unavailable)
    if not isinstance(data, dict):
        return data
    if data.get("k") not in (None, "session"):
        return None
    return data.get("p")


def make_super_admin_token(
    email: str,
    subject_uid: str,
    jti: str,
    *,
    ttl: int = SUPER_ADMIN_TTL,
    now: Optional[int] = None,
) -> tuple[str, int]:
    """일반 로그인과 교차 사용할 수 없는 workspace 변경 전용 토큰을 만든다."""
    issued_at = int(time.time()) if now is None else int(now)
    expires_at = issued_at + max(1, min(int(ttl), SUPER_ADMIN_TTL))
    body = {
        "k": "super_admin",
        "s": SUPER_ADMIN_SCOPE,
        "e": email,
        "sub": subject_uid,
        "j": jti,
        "i": issued_at,
        "x": expires_at,
    }
    payload = _b64e(json.dumps(body).encode())
    return f"{payload}.{_sign(payload)}", expires_at


def verify_super_admin_token(token: Optional[str], *, unavailable=None) -> Optional[dict[str, Any]]:
    """유효한 10분 workspace 전용 토큰의 claim을 반환한다."""
    data = _decode_verified(token, unavailable)
    if not isinstance(data, dict):
        return data
    if data.get("k") != "super_admin" or data.get("s") != SUPER_ADMIN_SCOPE:
        return None
    if not all(str(data.get(key) or "").strip() for key in ("e", "sub", "j")):
        return None
    return data

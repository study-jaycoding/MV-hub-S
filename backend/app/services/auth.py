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
import secrets
import time
from typing import Optional

from ..db import get_connection

_PBKDF2_ITERS = 200_000
_TOKEN_TTL = 14 * 24 * 3600  # 2주


# ── 서버 시크릿(app_setting 'auth_secret') ───────────────────────────────────
def _get_setting(key: str) -> Optional[str]:
    with get_connection() as conn:
        row = conn.execute("SELECT value FROM app_setting WHERE key=?", (key,)).fetchone()
    return row["value"] if row and row["value"] is not None else None


def _set_setting(key: str, value: str) -> None:
    with get_connection() as conn:
        conn.execute(
            "INSERT INTO app_setting(key, value) VALUES(?,?) "
            "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            (key, value),
        )


def get_secret() -> str:
    """서명용 서버 시크릿. 없으면 생성·영속(멱등). env CONTENT_HUB_AUTH_SECRET 우선."""
    import os

    env = os.environ.get("CONTENT_HUB_AUTH_SECRET")
    if env:
        return env
    sec = _get_setting("auth_secret")
    if not sec:
        sec = secrets.token_hex(32)
        _set_setting("auth_secret", sec)
    return sec


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
    body = {"e": email, "x": int(time.time()) + ttl}
    if pwd_stamp:
        body["p"] = pwd_stamp  # 발급 시점의 account.password_changed_at — 비번 변경 후 옛 토큰 거부에 사용
    payload = _b64e(json.dumps(body).encode())
    return f"{payload}.{_sign(payload)}"


def _decode_verified(token: Optional[str]) -> Optional[dict]:
    """서명·만료 검증을 통과한 payload dict 반환, 아니면 None."""
    if not token or "." not in token:
        return None
    payload_b64, sig = token.rsplit(".", 1)
    if not hmac.compare_digest(sig, _sign(payload_b64)):
        return None
    try:
        data = json.loads(_b64d(payload_b64))
    except (ValueError, json.JSONDecodeError):
        return None
    if int(data.get("x", 0)) < int(time.time()):
        return None  # 만료
    return data


def verify_token(token: Optional[str]) -> Optional[str]:
    """유효하면 email 반환, 아니면 None(서명 불일치·만료·형식오류)."""
    data = _decode_verified(token)
    return data.get("e") if data else None


def token_password_stamp(token: Optional[str]) -> Optional[str]:
    """토큰에 박힌 비번-스탬프(발급 시점의 password_changed_at). 구버전 토큰이면 None."""
    data = _decode_verified(token)
    return data.get("p") if data else None

"""계정별 로컬 DB — '활성 계정' 포인터(머신 레벨, DB 바깥).

로컬 허브는 머신당 한 사람이 한 번에 한 계정으로 작업한다(local-first). 어떤 계정으로
로그인했는지를 **DB 바깥**(data/active.json)에 둬야 그 포인터를 보고 '그 계정 DB'를 연다
— 닭-달걀 회피(DB 를 열기 전에 어떤 DB 인지 알아야 함). 미로그인이면 None → 레거시 단일 DB.

DB 폴더 키는 **이메일**(로그인 식별자 = 안정적)을 쓴다. creator_uid 는 첫 생성 전엔 NULL 일 수
있어 키로 부적합하고 나중에 바뀌면 폴더가 갈려 데이터가 미아가 된다. uid 는 레거시 이관 매칭·
표시에만 보관한다.

★공유 서버(AUTH on)는 active.json 을 절대 쓰지 않는다(set_active 는 로컬 프록시 로그인에서만
호출). 그래서 서버는 account_key()=None → 기존 단일 DB 그대로다(이 메커니즘은 로컬 전용).
"""

from __future__ import annotations

import hashlib
import json
import re
from contextvars import ContextVar
from pathlib import Path
from typing import Optional

from . import config

_POINTER = config.DATA_DIR / "active.json"
_SAFE = re.compile(r"[^A-Za-z0-9_-]")

# 요청별 오버라이드(향후 동시 다계정/테스트용). 기본 None → 머신 포인터 사용.
# 빈 문자열("")은 '명시적 미로그인'(레거시 DB 강제)을 뜻한다.
_override: ContextVar[Optional[str]] = ContextVar("active_key_override", default=None)

# 단일 프로세스 내 포인터 캐시 — active.json 은 이 프로세스만 쓰므로 안전. [loaded, value]
_cache: list = [False, None]


def _slug(email: str) -> str:
    """이메일 → 폴더 안전 슬러그. 가독성(치환) + 충돌 방지(짧은 해시) 둘 다."""
    base = _SAFE.sub("_", (email or "").strip().lower())[:40]
    h = hashlib.sha1((email or "").strip().lower().encode("utf-8")).hexdigest()[:8]
    return f"{base}-{h}"


def _read_pointer() -> Optional[dict]:
    if _cache[0]:
        return _cache[1]
    try:
        v = json.loads(_POINTER.read_text("utf-8"))
        if not isinstance(v, dict):
            v = None
    except (FileNotFoundError, ValueError, OSError):
        v = None
    _cache[0], _cache[1] = True, v
    return v


def account_key() -> Optional[str]:
    """현재 활성 계정의 DB 폴더 키(이메일). 오버라이드 > 머신 포인터 > None(레거시 DB)."""
    ov = _override.get()
    if ov is not None:
        return ov or None  # "" = 명시적 미로그인
    p = _read_pointer()
    return (p or {}).get("email") or None


def active_uid() -> Optional[str]:
    """활성 계정의 creator_uid(있으면) — 표시·이관 매칭용. 키가 아님."""
    p = _read_pointer()
    return (p or {}).get("uid") if p else None


def active_email() -> Optional[str]:
    return account_key()


def account_db_path(email: str) -> Path:
    """그 계정 전용 DB 경로 — data/db/acct/<slug>/content_hub.db.
    휴지통(content_hub_trash.db)·마운트(asset_mounts.json)는 같은 폴더를 자동으로 따라간다."""
    return account_dir(email) / "content_hub.db"


def account_dir(email: str) -> Path:
    return config.DATA_DIR / "db" / "acct" / _slug(email)


def set_active(email: str, uid: Optional[str] = None) -> None:
    """활성 계정 포인터 기록 — 로컬 프록시 로그인/전환 시 호출."""
    config.DATA_DIR.mkdir(parents=True, exist_ok=True)
    payload = {"email": email, "uid": uid}
    _POINTER.write_text(json.dumps(payload, ensure_ascii=False), "utf-8")
    _cache[0], _cache[1] = True, payload


def clear_active() -> None:
    """로그아웃 — 포인터 제거(이후 get_db_path 는 레거시 단일 DB)."""
    try:
        _POINTER.unlink()
    except OSError:
        pass
    _cache[0], _cache[1] = True, None


def set_override(key: Optional[str]):
    """요청/테스트 단위 활성 계정 오버라이드. 반환 토큰을 reset 에 쓴다."""
    return _override.set(key)


def reset_override(token) -> None:
    _override.reset(token)

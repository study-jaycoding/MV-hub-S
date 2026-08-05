"""개발용 브라우저 세션 ↔ 로컬 생성 에이전트 연결 상태.

`test_dev.bat`은 운영 DB 사본을 AUTH-on으로 띄우므로 브라우저와 에이전트가 같은 계정
세션을 써야 한다. 브라우저 로그인 때 계정 이메일만 메모리에 기억하고, 같은 런처가 만든
일회성 비밀키를 가진 loopback 에이전트에만 새 세션 발급을 허용한다.

비밀키가 설정되지 않은 운영/일반 실행에서는 모든 함수가 비활성(no-op)이다.
"""

from __future__ import annotations

import hmac
import threading
from typing import Optional

from fastapi import Request

from ..config import LOCAL_AGENT_PAIR_SECRET
from ..emailnorm import norm_email
from .request_guards import is_loopback_request

_lock = threading.Lock()
_active_email: Optional[str] = None


def enabled() -> bool:
    return bool(LOCAL_AGENT_PAIR_SECRET)


def activate(request: Request, email: str) -> Optional[str]:
    """로컬 브라우저가 인증한 계정을 활성화하고 이전 계정을 반환한다."""
    if not enabled() or not is_loopback_request(request):
        return None
    normalized = norm_email(email)
    if not normalized:
        return None
    global _active_email
    with _lock:
        previous = _active_email
        _active_email = normalized
    return previous


def clear(request: Request, email: Optional[str] = None) -> Optional[str]:
    """로컬 브라우저 로그아웃 시 활성 계정을 비우고 이전 계정을 반환한다."""
    if not enabled() or not is_loopback_request(request):
        return None
    normalized = norm_email(email) if email else None
    global _active_email
    with _lock:
        previous = _active_email
        if normalized is None or previous == normalized:
            _active_email = None
            return previous
    return None


def paired_email(request: Request, secret: str) -> Optional[str]:
    """올바른 런처 키를 가진 loopback 요청에만 현재 브라우저 계정을 돌려준다."""
    if not enabled() or not is_loopback_request(request):
        return None
    if not hmac.compare_digest(secret or "", LOCAL_AGENT_PAIR_SECRET):
        return None
    with _lock:
        return _active_email

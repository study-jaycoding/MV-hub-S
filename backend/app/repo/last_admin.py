"""마지막 관리자 보호 — 승인된 admin 이 0명이 되는 쓰기를 막는다.

0명이 되면 아무도 전역 역할을 주거나 가입을 승인할 수 없다(그 API 들이 admin 전용이다). 일반
API 로는 빠져나올 수 없고 부트스트랩·DB 작업으로만 되돌린다. 그래서 쓰기 단계에서 막는다.

계정 역할(`accounts`)과 멤버 uid 역할(`identity`) **양쪽이** 쓰므로 둘 다 의존할 수 있는 이
모듈에 둔다 — 한쪽에 두고 다른 쪽이 가져다 쓰면 repo 안에 import 순환이 생긴다
(`tests/test_architecture_boundaries.py` 가 지역 import 까지 세어 막는다).
설계: docs/MEMBER_TABLE_DESIGN.md §5-1.
"""
from __future__ import annotations

from contextlib import contextmanager

from .. import rbac


class LastAdminError(Exception):
    """이 쓰기를 적용하면 승인된 관리자가 한 명도 남지 않는다(라우터가 409 로 바꾼다)."""


def approved_admin_count(conn) -> int:
    """권한이 실제로 도는 관리자 수 — 승인된 계정 중 전역 역할에 admin 이 있는 것.
    · status: 미들웨어·로그인이 approved 만 통과시키므로(main.py·auth.py) 그 기준을 그대로 쓴다.
    · hidden: 목록에서 가릴 뿐 로그인·권한은 그대로다 → 숨긴 관리자도 센다.
    · 역할은 CSV 라 LIKE 로 세지 않고 권한 판정과 같은 파서로 읽는다."""
    return sum(
        1
        for r in conn.execute("SELECT global_role FROM account WHERE status='approved'")
        if rbac.ADMIN in rbac.parse_roles(r["global_role"])
    )


@contextmanager
def last_admin_guard(conn):
    """쓰기를 이 블록 안에서 한다 — 관리자가 있었는데 0이 되면 LastAdminError.

    쓰기 결과를 미리 계산하지 않고 **쓴 뒤에 세는** 이유: 한 uid 가 여러 account 를 한 번에
    바꾸는 경로가 있어(identity.set_member_global_roles) 사전 계산은 실제 결과와 어긋날 수 있다.
    '재기 전/후'를 한 이름으로 묶어 뒤쪽 확인을 빠뜨릴 수 없게 한다. 되돌리기는 부르는 쪽의
    ROLLBACK 이 한다(이 블록은 판정만) — 부르는 쪽은 같은 커넥션에서 BEGIN IMMEDIATE 로
    검사~쓰기를 직렬화해야 한다(관리자 둘이 동시에 서로를 내리는 경합).
    이미 0명이면 통과시킨다 — 그 상태를 고치려는 쓰기까지 막지 않는다.
    """
    before = approved_admin_count(conn)
    yield
    if before and not approved_admin_count(conn):
        raise LastAdminError("마지막 관리자입니다 — 다른 계정에 admin 을 먼저 준 뒤에 바꾸세요")

"""이메일(계정 신원 키) 표준화 단일 정의.

계정 이메일은 여러 곳에서 비교·키 생성에 쓰이는데, 사이트마다 (x or "").strip().lower() 를 각자
재구현하면 한 곳이라도 어긋날 때 신원 불일치(멤버 중복·가시성 상실)가 난다 — 반복 이력이 있는 버그.
모든 이메일 정규화가 이 한 함수를 거치게 해 드리프트를 원천 차단한다.

★기존 각 사이트의 (x or "").strip().lower() 와 바이트 동일 — 동작 보존(순수 리팩터).
이 모듈은 내부 의존이 전혀 없다(leaf) — 어디서 import 해도 순환 없음.
"""

from typing import Optional


def norm_email(value: Optional[str]) -> str:
    """앞뒤 공백 제거 + 소문자. None/빈값은 빈 문자열."""
    return (value or "").strip().lower()

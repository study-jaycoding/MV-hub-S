"""RBAC 역할 모델 (v02 로드맵 PART 1) — 전역 4역할 + 프로젝트 3역할의 단일 진실 원천.

설계 근거(RBAC_CMS_DAM_통합로드맵 §1):
- **전역 역할**(사람 단위, account/creator.global_role): admin / product_director /
  production_director / member. "시스템·가입·전역 인사·전 프로젝트 읽기·프로젝트 생성"을 가른다.
- **프로젝트 역할**(project_member.project_role): project_manager / supervisor / creator.
  "그 프로젝트 안에서 멤버관리·작업·검수(=CMS 최종선택)"를 가른다.

핵심 원칙(§1-6):
- 권한 체크는 **서버에서**(deps.require_global/require_project_role). 버튼 숨김은 UX 보조일 뿐.
- 두 층 충돌(§5-3)은 **관대한 합집합**: 전역 또는 프로젝트 중 한쪽이 허용하면 통과.
  (예: 전역 read_all 보유자[admin·두 director]는 모든 프로젝트를 읽을 수 있다.)
- **복수 전역 역할**: 한 사람이 여러 전역 역할을 동시에 보유할 수 있다(예: Product Director +
  Production Director = 운영도 하고 제작도). 보유 역할들의 역량을 합집합(union)으로 본다.
  저장은 CSV 문자열(`global_role` 칸), API 는 리스트(`global_roles`)로 주고받는다.

이 모듈은 순수 상수·매핑이라 DB·요청에 의존하지 않는다 — 어디서든 import 가능.
"""

from __future__ import annotations

from typing import Iterable, Optional, Union

# ── 전역 역할 (Global) ────────────────────────────────────────────────────
ADMIN = "admin"
PRODUCT_MANAGER = "product_manager"  # (구 product_director — 표시·코드값 변경)
PRODUCTION_DIRECTOR = "production_director"
MEMBER = "member"
GLOBAL_ROLES = (ADMIN, PRODUCT_MANAGER, PRODUCTION_DIRECTOR, MEMBER)
DEFAULT_GLOBAL_ROLE = MEMBER

# 권한 상승 방지는 별도 RANK 표가 아니라 '부여' 자체의 역량 게이트로 한다:
#   전역 역할 부여 = grant_global(admin 전용), 프로젝트 역할 부여 = manage_members(project_manager).
# 부여 주체가 이미 각 축의 최상위라서 동급/하위만 줄 수 있어 별도 서열 비교가 불필요하다.

# ── 프로젝트 역할 (Project) ───────────────────────────────────────────────
PROJECT_MANAGER = "project_manager"
SUPERVISOR = "supervisor"
CREATOR = "creator"  # (구 'editor' — 작업자)
PROJECT_ROLES = (PROJECT_MANAGER, SUPERVISOR, CREATOR)
DEFAULT_PROJECT_ROLE = CREATOR

# ── 역량(capability) 매트릭스 ─────────────────────────────────────────────
# 서버 enforcement 는 역할명(require_global/require_project_role)으로 하지만,
# 프론트가 버튼을 회색처리할 때 이 표를 같은 진실로 참조한다(/api/auth/me 가 노출).
GLOBAL_CAPS: dict[str, set[str]] = {
    ADMIN: {"system", "approve_signup", "grant_global", "read_all"},
    PRODUCT_MANAGER: {"grant_project_role", "create_project", "read_all"},
    PRODUCTION_DIRECTOR: {"create_work", "read_all"},
    MEMBER: {"create_work"},
}
PROJECT_CAPS: dict[str, set[str]] = {
    PROJECT_MANAGER: {"manage_members", "schedule", "read", "create_project"},
    SUPERVISOR: {"create_work", "review", "read"},  # review = CMS 최종 선택
    CREATOR: {"create_work", "read"},
}

# ── 프로젝트 배치 시 자동 기본 역할 ────────────────────────────────────────
# 프로젝트에 멤버로 배치하면 전역 역할에 따라 기본 프로젝트 역할이 자동 부여된다(이후 수동 조정 가능).
# 복수 전역역할이면 합집합. (표시명: manager=product_manager, director=production_director, pm=project_manager)
GLOBAL_TO_PROJECT_DEFAULT: dict[str, set[str]] = {
    ADMIN: {PROJECT_MANAGER, SUPERVISOR, CREATOR},   # 모두 활성화
    PRODUCT_MANAGER: {PROJECT_MANAGER},              # manager → pm
    PRODUCTION_DIRECTOR: {SUPERVISOR, CREATOR},      # director → supervisor + creator
    MEMBER: {CREATOR},                               # member → creator
}


def default_project_roles(global_value: RolesInput) -> list[str]:
    """전역 역할(복수 가능)로부터 배치 시 기본 프로젝트 역할(합집합, PROJECT_ROLES 순서)."""
    acc: set[str] = set()
    for r in effective_roles(global_value):
        acc |= GLOBAL_TO_PROJECT_DEFAULT.get(r, {CREATOR})
    return [r for r in PROJECT_ROLES if r in acc]

# ── 복수 전역 역할 — CSV 문자열 ↔ 리스트 ───────────────────────────────────
# 사람의 전역 역할은 0개 이상. 저장은 "product_director,production_director" 같은 CSV.
RolesInput = Union[str, Iterable[str], None]


def parse_roles(value: RolesInput) -> list[str]:
    """입력(CSV 문자열 또는 리스트)을 유효 전역 역할 리스트로 정규화(순서 보존·중복 제거)."""
    if not value:
        return []
    items = value.split(",") if isinstance(value, str) else list(value)
    out: list[str] = []
    for r in items:
        r = (r or "").strip()
        if r in GLOBAL_ROLES and r not in out:
            out.append(r)
    return out


def roles_to_str(value: RolesInput) -> str:
    """전역 역할 리스트 → 저장용 CSV(유효 역할만)."""
    return ",".join(parse_roles(value))


def effective_roles(value: RolesInput) -> list[str]:
    """비어 있으면 기본 member 1개로 간주(승인된 사람은 최소 기본 작업자)."""
    return parse_roles(value) or [DEFAULT_GLOBAL_ROLE]


def global_caps(value: RolesInput) -> set[str]:
    """보유한 전역 역할들의 역량 합집합(union)."""
    caps: set[str] = set()
    for r in effective_roles(value):
        caps |= GLOBAL_CAPS.get(r, set())
    return caps


def has_global_cap(value: RolesInput, cap: str) -> bool:
    """보유 역할 중 하나라도 이 역량을 가지면 True."""
    return cap in global_caps(value)


def has_any_global_role(value: RolesInput, *roles: str) -> bool:
    """보유 역할 중 roles 와 겹치는 게 있으면 True."""
    held = set(parse_roles(value))
    return any(r in held for r in roles)


# ── 복수 프로젝트 역할 — CSV 문자열 ↔ 리스트 ───────────────────────────────
# 한 사람이 한 프로젝트 안에서 여러 역할 보유 가능(예: Supervisor + Creator). 저장은 CSV.
def parse_project_roles(value: RolesInput) -> list[str]:
    if not value:
        return []
    items = value.split(",") if isinstance(value, str) else list(value)
    out: list[str] = []
    for r in items:
        r = (r or "").strip()
        if r in PROJECT_ROLES and r not in out:
            out.append(r)
    return out


def project_roles_to_str(value: RolesInput) -> str:
    return ",".join(parse_project_roles(value))


def project_caps(value: RolesInput) -> set[str]:
    """보유한 프로젝트 역할들의 역량 합집합."""
    caps: set[str] = set()
    for r in parse_project_roles(value):
        caps |= PROJECT_CAPS.get(r, set())
    return caps


def has_project_cap(value: RolesInput, cap: str) -> bool:
    """보유 프로젝트 역할(복수 가능) 중 하나라도 이 역량을 가지면 True."""
    return cap in project_caps(value)


def has_any_project_role(value: RolesInput, *roles: str) -> bool:
    held = set(parse_project_roles(value))
    return any(r in held for r in roles)

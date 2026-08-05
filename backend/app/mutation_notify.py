"""데이터 영역별 변경 알림의 HTTP 계약.

본 서버 미들웨어와 로컬 데이터 프록시가 같은 판정·요청 출처 규칙을 써야 한다. 이 규칙이
갈라지면 조회형 POST가 프록시에서만 ``synced``를 방송하거나 독립 창 갱신이 누락된다.
"""

from __future__ import annotations

import re
from typing import Optional

MutationOrigin = tuple[str, str]

CLIENT_ID_HEADER = "X-MVHub-Client-Id"
MUTATION_ID_HEADER = "X-MVHub-Mutation-Id"
MUTATION_DOMAINS_HEADER = "X-MVHub-Mutation-Domains"

DOMAIN_LIBRARY = "library"
DOMAIN_ASSETS = "assets"
DOMAIN_MANAGE = "manage"

_NOTIFY_EXCLUDE = ("/api/auth/", "/api/health", "/api/backup", "/api/merge")
_NOTIFY_METHODS = ("POST", "PUT", "PATCH", "DELETE")
# HTTP 쓰기 메서드를 쓰지만 라이브러리 DB를 바꾸지 않는 계약. 주기 조회·씬 백업 경로를 빠뜨리면
# 조회/백업→synced→전체 reload의 순환이 생기므로 본 서버와 프록시가 이 집합을 공유한다.
_NOTIFY_NO_LIBRARY_CHANGE_PATHS = frozenset(
    {
        "/api/agent/reinspect",
        "/api/agent/sync",
        "/api/cost",
        "/api/comfy/settings",
        "/api/generations/batch",
        "/api/generations/comment-counts",
        "/api/ingest/known-jobs",
        "/api/projects/folder-counts/batch",
        "/api/scenes/backup",
        "/api/comfy/parse",
        "/api/comfy/run",
    }
)
_NOTIFY_NO_LIBRARY_CHANGE_PREFIXES = (
    "/api/assets/",  # Assets는 별도 assets_changed/BroadcastChannel 갱신 영역
    "/api/manage/",  # PM 집계·작업 DB는 manage_changed로 분리
)
_ASSET_NO_CHANGE_PATHS = frozenset(
    {
        "/api/assets/reveal",
        "/api/assets/clipboard-copy",
    }
)
_MANAGE_ALSO_LIBRARY_PATHS = frozenset(
    {
        "/api/manage/hf-missing-apply",  # 서버 generation을 휴지통 이동/복구 표시
    }
)

_ORIGIN_PART = re.compile(r"^[A-Za-z0-9_-]{8,80}$")


def _is_successful_write(method: str, path: str, status_code: int) -> bool:
    return (
        method in _NOTIFY_METHODS
        and path.startswith("/api/")
        and not path.startswith(_NOTIFY_EXCLUDE)
        # 리다이렉트(307 등)는 실제 변경 완료가 아니므로 최종 2xx 응답만 알린다.
        and 200 <= status_code < 300
    )


def should_notify_mutation(method: str, path: str, status_code: int) -> bool:
    if not _is_successful_write(method, path, status_code):
        return False
    if path in _MANAGE_ALSO_LIBRARY_PATHS:
        return True
    return path not in _NOTIFY_NO_LIBRARY_CHANGE_PATHS and not path.startswith(
        _NOTIFY_NO_LIBRARY_CHANGE_PREFIXES
    )


def should_notify_assets(method: str, path: str, status_code: int) -> bool:
    return (
        _is_successful_write(method, path, status_code)
        and path.startswith("/api/assets/")
        and path not in _ASSET_NO_CHANGE_PATHS
    )


def should_notify_manage(method: str, path: str, status_code: int) -> bool:
    return _is_successful_write(method, path, status_code) and path.startswith("/api/manage/")


def notification_domains(method: str, path: str, status_code: int) -> tuple[str, ...]:
    domains: list[str] = []
    if should_notify_mutation(method, path, status_code):
        domains.append(DOMAIN_LIBRARY)
    if should_notify_assets(method, path, status_code):
        domains.append(DOMAIN_ASSETS)
    if should_notify_manage(method, path, status_code):
        domains.append(DOMAIN_MANAGE)
    return tuple(domains)


def parse_mutation_origin(
    client_id: Optional[str], mutation_id: Optional[str]
) -> Optional[MutationOrigin]:
    """신뢰할 수 없는 요청 헤더를 알림 병합에 써도 되는 짧은 식별자로 제한한다."""
    if not client_id or not mutation_id:
        return None
    if not _ORIGIN_PART.fullmatch(client_id) or not _ORIGIN_PART.fullmatch(mutation_id):
        return None
    return client_id, mutation_id

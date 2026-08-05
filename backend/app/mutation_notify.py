"""라이브러리 변경 알림의 HTTP 계약.

본 서버 미들웨어와 로컬 데이터 프록시가 같은 판정·요청 출처 규칙을 써야 한다. 이 규칙이
갈라지면 조회형 POST가 프록시에서만 ``synced``를 방송해 전체 reload 순환을 다시 만든다.
"""

from __future__ import annotations

import re
from typing import Optional

MutationOrigin = tuple[str, str]

CLIENT_ID_HEADER = "X-MVHub-Client-Id"
MUTATION_ID_HEADER = "X-MVHub-Mutation-Id"

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
    "/api/manage/telemetry/",  # PM 집계 DB 전용; generation 라이브러리와 무관
)

_ORIGIN_PART = re.compile(r"^[A-Za-z0-9_-]{8,80}$")


def should_notify_mutation(method: str, path: str, status_code: int) -> bool:
    return (
        method in _NOTIFY_METHODS
        and path.startswith("/api/")
        and not path.startswith(_NOTIFY_EXCLUDE)
        and path not in _NOTIFY_NO_LIBRARY_CHANGE_PATHS
        and not path.startswith(_NOTIFY_NO_LIBRARY_CHANGE_PREFIXES)
        # 리다이렉트(307 등)는 실제 변경 완료가 아니므로 최종 2xx 응답만 알린다.
        and 200 <= status_code < 300
    )


def parse_mutation_origin(
    client_id: Optional[str], mutation_id: Optional[str]
) -> Optional[MutationOrigin]:
    """신뢰할 수 없는 요청 헤더를 알림 병합에 써도 되는 짧은 식별자로 제한한다."""
    if not client_id or not mutation_id:
        return None
    if not _ORIGIN_PART.fullmatch(client_id) or not _ORIGIN_PART.fullmatch(mutation_id):
        return None
    return client_id, mutation_id

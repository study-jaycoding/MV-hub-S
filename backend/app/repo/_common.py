"""데이터 접근 계층 (Phase 2/3) — 공용 헬퍼·상수.

라우터·잡 큐·동기화가 공유하는 SQLite 읽기/쓰기. 직렬화(Row → API dict)도 여기서.
모든 ID 는 UUID 문자열(CLAUDE.md 컨벤션). 단, 동기화로 들어온 generation 은
higgsfield job id 를 그대로 PK 로 써서 재동기 시 멱등하게 한다.
"""

from __future__ import annotations

import re
import uuid
from typing import Optional

from ..config import DEFAULT_WORKER_ID, DEFAULT_WORKER_NAME, SHARED_DIR
from ..db import get_connection
from ..services import media_cache


def new_id() -> str:
    return str(uuid.uuid4())


def clean_folder_path(path: Optional[str]) -> Optional[str]:
    """폴더 경로를 저장용으로 정규화 — 백슬래시→슬래시, 앞뒤/중복 슬래시 제거, '.'/'..'·빈 조각 제거.
    빈 값이면 None(미지정). 저장 시점의 가벼운 정리이며, 물리 저장의 트래버설 검증은 별도."""
    if not path:
        return None
    parts = [seg.strip() for seg in str(path).replace("\\", "/").split("/")]
    parts = [seg for seg in parts if seg and seg not in (".", "..")]
    return "/".join(parts) or None


# ── 생성본 코멘트 '미확인 알림' 공통 SQL 조각 ─────────────────────────────
# 카드 C 뱃지(_attach_children)·전역 통계(generation_stats)·패널 NEW(list_generation_comments)가
# 똑같은 알림 규칙을 쓰도록 한곳에서 관리한다. 규칙을 바꾸면 세 경로가 자동으로 일치한다.
# 별칭 전제: c=generation_comment, g=generation, p=부모 코멘트, s=seen.
#   ALERT_COMMENT_JOINS     : c 뒤에 붙이는 JOIN 3종. ? 1개(s.worker_id=뷰어).
#   ALERT_COMMENT_PREDICATE : 알림 대상 판정. ? 3개(c.author<>뷰어, g.creator_uid=뷰어, p.author=뷰어).
# 바인딩은 위치식(?)이라 최종 SQL 에서 ? 가 나타나는 텍스트 순서대로 인자를 넘겨야 한다
# (예: WHERE 경로는 JOIN ? → 예측부 3?, SELECT-CASE 경로는 예측부 3? → JOIN ?).
ALERT_COMMENT_JOINS = (
    "JOIN generation g ON g.id = c.gen_id "
    "LEFT JOIN generation_comment p ON p.id = c.parent_id "
    "LEFT JOIN generation_comment_seen s ON s.worker_id=? AND s.comment_id=c.id"
)
ALERT_COMMENT_PREDICATE = (
    "s.comment_id IS NULL AND c.author <> ? AND (g.creator_uid = ? OR p.author = ?)"
)


# ── 생성자(팀 워크스페이스 작성자) ────────────────────────────────────────
_UID_RE = re.compile(r"(user_[A-Za-z0-9]+)")


def _email_localpart(email: Optional[str]) -> Optional[str]:
    if email and "@" in email:
        return email.split("@", 1)[0] or None
    return email or None


def _cached_or_remote(url: str, is_image: bool) -> tuple[str, Optional[str], Optional[str]]:
    """원격 URL 이 이미 로컬에 보관돼 있으면 (로컬경로, 썸네일, 원본URL) 을,
    아니면 (원격URL, 원격썸네일, None) 을 반환. 재동기 시 캐시 보존용."""
    if media_cache.is_cached(url):
        local = media_cache.local_rel_for(url)
        return local, (local if is_image else None), url
    return url, (url if is_image else None), None


# ── 번들 export / import (팀 공유: 사실 + 오버레이) ───────────────────────
# 공유 단위 설계(사용자 합의):
#   · 사실(facts)        = 결과물 URL · params · 생성자(creator_uid) — uuid 로 누가 봐도 동일, 충돌 없음
#   · 오버레이(overlay)  = 프롬프트 내 레퍼런스 위치(display_prompt + 레퍼런스 role) · 태그 · 코멘트
# 병합 규칙: 사실은 uuid 일치 시 그대로(upsert), 태그는 union, 코멘트는 id 로 dedup append.
# 개인 분류(컬러·즐겨찾기)는 공유하지 않으므로 충돌 해소 로직이 필요 없다.
BUNDLE_FORMAT = "content-hub-bundle"
BUNDLE_VERSION = 1


def _remote_url(file_path: Optional[str], source_url: Optional[str]) -> Optional[str]:
    """공유용 URL — 원본 원격 URL(source_url) 우선. 없으면 http 경로인 file_path.
    로컬 캐시(/media/...)만 있고 원격이 없으면 받는 쪽이 못 여므로 그대로 둔다(한계)."""
    if source_url and source_url.startswith("http"):
        return source_url
    if file_path and file_path.startswith("http"):
        return file_path
    return source_url or file_path

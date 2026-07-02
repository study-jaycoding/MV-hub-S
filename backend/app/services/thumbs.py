"""생성 미디어 썸네일 — 공용 생성·캐시 (그리드 즉시 표시).

엔드포인트(/api/media-thumb)와 백그라운드 사전 생성(pre-warm)이 **같은 캐시 키**를 쓰도록
여기로 단일화한다(키가 어긋나면 미리 만든 썸네일을 엔드포인트가 못 읽어 무의미해진다).
"""

from __future__ import annotations

import asyncio
import hashlib
import time
from pathlib import Path
from typing import Optional

from ..config import MEDIA_DIR
from .media_types import IMAGE_EXTENSIONS
from .path_safety import safe_join

THUMB_DIR = MEDIA_DIR / ".thumbs"  # 에셋 썸네일과 같은 디스크 캐시 폴더


def cache_path(target: Path, w: int) -> Path:
    """target 파일(+mtime+폭)에 대응하는 썸네일 캐시 경로."""
    mtime = int(target.stat().st_mtime)
    key = hashlib.sha1(f"{target}|{mtime}|{w}".encode("utf-8")).hexdigest()
    return THUMB_DIR / f"{key}.jpg"


def ensure_thumb(target: Path, w: int) -> Optional[Path]:
    """target 의 w 폭 썸네일을 보장(없으면 생성). 이미지가 아니거나 실패면 None."""
    if target.suffix.lower() not in IMAGE_EXTENSIONS or not target.is_file():
        return None
    THUMB_DIR.mkdir(parents=True, exist_ok=True)
    cache = cache_path(target, w)
    if cache.exists():
        return cache
    from PIL import Image  # 지연 import

    try:
        with Image.open(target) as im:
            im = im.convert("RGB")  # JPEG: 알파 제거(어두운 카드 배경이라 무방)
            im.thumbnail((w, w), Image.LANCZOS)
            im.save(cache, "JPEG", quality=82)
        return cache
    except Exception:
        return None


def _media_target(rel_or_media_path: str) -> Optional[Path]:
    """'/media/<2>/<sha>.ext' → 안전한 절대경로(경로 이탈 차단). 아니면 None."""
    if not rel_or_media_path.startswith("/media/") or "\\" in rel_or_media_path:
        return None
    return safe_join(MEDIA_DIR, rel_or_media_path[len("/media/"):])


def prewarm_generation_thumbs(width: int = 512, throttle: float = 0.0) -> int:
    """모든 로컬 /media 이미지의 썸네일을 미리 생성(없는 것만). 시작 후 백그라운드 데몬에서 호출.
    → 첫 프로젝트 선택·스크롤에서도 생성 지연 없이 즉시 표시된다. 생성 개수를 반환."""
    from ..db import get_connection

    with get_connection() as conn:
        rows = conn.execute(
            "SELECT DISTINCT file_path FROM asset WHERE file_path LIKE '/media/%'"
        ).fetchall()
    made = 0
    for r in rows:
        target = _media_target(r["file_path"] or "")
        if target and not cache_path(target, width).exists():
            if ensure_thumb(target, width):
                made += 1
            if throttle:
                time.sleep(throttle)
    return made


async def prewarm_remote_thumbs(urls: list[str], width: int = 512, concurrency: int = 4) -> int:
    """원격 미디어 URL 목록을 로컬 캐시 + 썸네일로 미리 구워둔다(team 목록 응답 직후 백그라운드).

    공유받은(team) 항목은 미디어가 원격 URL(Higgsfield cloudfront)이라, 첫 표시 때마다 보는 PC가
    원본을 받아 리사이즈한다 → 첫 스크롤이 느리다. 목록을 받자마자 뒤에서 미리 받아 캐시해 두면
    실제 표시 시점엔 디스크 캐시 히트로 즉시 뜬다. 이미 캐시된 건 즉시 통과(멱등) → 매 스크롤
    재호출이 싸다. 동시 다운로드는 cloudfront 부하·메모리 스파이크 방지로 제한한다. 생성 수 반환."""
    from . import media_cache  # 지연 import(순환 방지)

    sem = asyncio.Semaphore(concurrency)
    made = 0

    async def _one(url: str) -> None:
        nonlocal made
        async with sem:
            rel = await media_cache.cache_url(url)  # 이미 캐시면 즉시 반환
            if not rel:
                return
            target = _media_target(rel)
            if not target:
                return
            cache = await asyncio.to_thread(ensure_thumb, target, width)  # PIL=동기 → 스레드로
            if cache:
                made += 1

    await asyncio.gather(*(_one(u) for u in urls), return_exceptions=True)
    return made

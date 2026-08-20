"""생성 미디어 썸네일 — 공용 생성·캐시 (그리드 즉시 표시).

엔드포인트(/api/media-thumb)와 백그라운드 사전 생성(pre-warm)이 **같은 캐시 키**를 쓰도록
여기로 단일화한다(키가 어긋나면 미리 만든 썸네일을 엔드포인트가 못 읽어 무의미해진다).
"""

from __future__ import annotations

import asyncio
import hashlib
import os
import shutil
import subprocess
import threading
import time
import uuid
from pathlib import Path
from typing import Optional

from ..config import MEDIA_DIR
from .media_types import IMAGE_EXTENSIONS, VIDEO_EXTENSIONS
from .path_safety import safe_join

THUMB_DIR = MEDIA_DIR / ".thumbs"  # 에셋 썸네일과 같은 디스크 캐시 폴더

# 프론트 그리드가 실제로 요청하는 두 버킷(표시크기×DPR ≤ 256 → 256, 아니면 512).
# ★프리워밍은 반드시 이 두 폭을 모두 구워야 한다 — 512 만 구우면 100% 배율 모니터(256 요청)에서
#   전부 캐시 미스라 "미리 구웠는데 열 때마다 새로 굽는" 문제가 재현된다.
THUMB_WIDTHS: tuple[int, ...] = (256, 512)

# 썸네일 캐시(.thumbs) 총 용량 상한. 넘으면 오래된 것부터 삭제(LRU). 썸네일은 원본 URL 로 언제든 다시
# 구울 수 있어 삭제해도 안전하다 — 이 상한은 .thumbs(재생성 가능 캐시)에만 적용하고 MEDIA_DIR 의
# 원본(특히 최종본 보존본)은 절대 건드리지 않는다. 기본 1GB(≈ 3만 장), 런처 환경변수로 조절.
THUMB_CACHE_MAX_BYTES = int(os.environ.get("CONTENT_HUB_THUMB_CACHE_MAX_BYTES", str(1024 * 1024 * 1024)))
REMOTE_THUMB_CONCURRENCY = max(
    1, int(os.environ.get("CONTENT_HUB_REMOTE_THUMB_CONCURRENCY", "4"))
)
# 요청마다 Semaphore를 만들면 100명이 동시에 팀 목록을 열 때 4×100개까지 늘어난다. 프로세스
# 전체가 하나를 공유해 원격 다운로드+PIL 작업의 실제 동시 실행을 설정값 이하로 고정한다.
_REMOTE_PREWARM_SEM = asyncio.Semaphore(REMOTE_THUMB_CONCURRENCY)
_THUMB_LOCKS: dict[str, threading.Lock] = {}
_THUMB_LOCK_REFS: dict[str, int] = {}
_THUMB_LOCKS_GUARD = threading.Lock()


def _is_complete_file(path: Path) -> bool:
    try:
        return path.is_file() and path.stat().st_size > 0
    except OSError:
        return False


def _acquire_thumb_lock(cache: Path) -> tuple[str, threading.Lock]:
    key = str(cache)
    with _THUMB_LOCKS_GUARD:
        lock = _THUMB_LOCKS.get(key)
        if lock is None:
            lock = threading.Lock()
            _THUMB_LOCKS[key] = lock
        _THUMB_LOCK_REFS[key] = _THUMB_LOCK_REFS.get(key, 0) + 1
        return key, lock


def _release_thumb_lock(key: str) -> None:
    with _THUMB_LOCKS_GUARD:
        remaining = _THUMB_LOCK_REFS.get(key, 0) - 1
        if remaining <= 0:
            _THUMB_LOCK_REFS.pop(key, None)
            _THUMB_LOCKS.pop(key, None)
        else:
            _THUMB_LOCK_REFS[key] = remaining


def cache_path(target: Path, w: int) -> Path:
    """target 파일(+수정시각+크기+폭)에 대응하는 썸네일 캐시 경로.
    초 단위 mtime 은 같은 1초 안에 덮어쓴 변경을 놓친다 → 나노초+파일크기로 키를 잡아 확실히 구분한다
    (원본을 같은 이름으로 덮어쓰면 새 썸네일이 새 키로 구워져 옛 캐시와 섞이지 않는다)."""
    st = target.stat()
    key = hashlib.sha1(f"{target}|{st.st_mtime_ns}-{st.st_size}|{w}".encode("utf-8")).hexdigest()
    return THUMB_DIR / f"{key}.jpg"


def ensure_thumb(target: Path, w: int) -> Optional[Path]:
    """target 의 w 폭 썸네일을 보장(없으면 생성). 이미지가 아니거나 실패면 None."""
    if target.suffix.lower() not in IMAGE_EXTENSIONS or not target.is_file():
        return None
    THUMB_DIR.mkdir(parents=True, exist_ok=True)
    try:
        cache = cache_path(target, w)
    except OSError:
        # is_file 확인 직후 원본이 교체·삭제되는 경합은 깨진 이미지와 같은 404(None)로 처리한다.
        return None
    if _is_complete_file(cache):
        return cache
    lock_key, lock = _acquire_thumb_lock(cache)
    try:
        with lock:
            if _is_complete_file(cache):
                return cache
            from PIL import Image  # 지연 import

            # 임시파일 → 원자적 교체: 같은 캐시 미스가 동시에 들어와도(요청 스레드 + prewarm)
            # 반쯤 쓰인 .jpg 를 다른 쪽이 읽는 일이 없다. 파일명에 고유 접미사.
            tmp = cache.with_suffix(f".{threading.get_ident()}.{uuid.uuid4().hex}.tmp")
            try:
                with Image.open(target) as im:
                    im = im.convert("RGB")  # JPEG: 알파 제거(어두운 카드 배경이라 무방)
                    im.thumbnail((w, w), Image.LANCZOS)
                    im.save(tmp, "JPEG", quality=82)
                tmp.replace(cache)
                return cache
            except Exception:
                if _is_complete_file(cache):
                    return cache
                try:
                    tmp.unlink(missing_ok=True)  # 실패 잔재 정리(없으면 무시)
                except OSError:
                    pass
                return None
    finally:
        _release_thumb_lock(lock_key)


_FFMPEG_BIN: Optional[str] = None
_FFMPEG_LOOKED = False
# ffmpeg 는 CPU 무거워 동시 실행을 제한한다 — 서로 다른 영상이 콜드로 몰려도(파일별 락은 같은 파일만
# 직렬화하므로 다른 영상은 못 막음) 프로세스 폭주·CPU 스파이크를 막는다. 런처 환경변수로 조절.
_FFMPEG_SEM = threading.Semaphore(int(os.environ.get("CONTENT_HUB_FFMPEG_CONCURRENCY", "3")))


def _ffmpeg_bin() -> Optional[str]:
    """ffmpeg 실행 경로(1회 조회 캐시). 없으면 None → 비디오 포스터 생성 불가."""
    global _FFMPEG_BIN, _FFMPEG_LOOKED
    if not _FFMPEG_LOOKED:
        _FFMPEG_BIN = shutil.which("ffmpeg")
        _FFMPEG_LOOKED = True
    return _FFMPEG_BIN


def ensure_video_poster(target: Path, w: int) -> Optional[Path]:
    """비디오 target 의 첫 프레임을 w 폭 포스터(JPEG)로 보장(없으면 생성).
    이미지 썸네일과 같은 .thumbs 디스크 캐시·락·완결성 검사를 재사용한다.
    ffmpeg 가 없거나 추출 실패면 None → 라우터가 404. (첫 프레임 폴백은 없다 — preload=none 이라
    포스터만 비게 되는데, <video> 첫 프레임 표시가 원래 불안정해서 포스터를 도입한 것이다.)"""
    if target.suffix.lower() not in VIDEO_EXTENSIONS or not target.is_file():
        return None
    ff = _ffmpeg_bin()
    if not ff:
        return None
    THUMB_DIR.mkdir(parents=True, exist_ok=True)
    try:
        cache = cache_path(target, w)  # 키=경로+mtime+폭 (이미지와 동일 규칙, 경로가 달라 충돌 없음)
    except OSError:
        return None  # is_file 뒤 교체·삭제 경합
    if _is_complete_file(cache):
        return cache
    lock_key, lock = _acquire_thumb_lock(cache)
    try:
        with lock:
            if _is_complete_file(cache):
                return cache
            # tmp 는 .jpg 로 끝내 ffmpeg 가 형식을 인식하게(+ image2 명시). 고유 접미사로 동시성 충돌 방지.
            tmp = cache.parent / f"{cache.stem}.{threading.get_ident()}.{uuid.uuid4().hex}.tmp.jpg"
            try:
                with _FFMPEG_SEM:  # 동시 ffmpeg 프로세스 수 제한(CPU 스파이크 방지)
                    subprocess.run(
                        [ff, "-y", "-loglevel", "error", "-ss", "0", "-i", str(target),
                         "-frames:v", "1", "-vf", f"scale='min({w},iw)':-2", "-q:v", "3",
                         "-f", "image2", str(tmp)],
                        check=True, capture_output=True, timeout=30,
                    )
                if not _is_complete_file(tmp):
                    raise RuntimeError("ffmpeg produced empty output")
                tmp.replace(cache)
                return cache
            except Exception:
                if _is_complete_file(cache):
                    return cache
                try:
                    tmp.unlink(missing_ok=True)
                except OSError:
                    pass
                return None
    finally:
        _release_thumb_lock(lock_key)


_TOUCH_MIN_AGE = 86400.0  # 초 — 서빙 히트 시 mtime 이 이보다 묵었을 때만 touch(파일당 하루 1회 쓰기)
_EVICT_SCAN_INTERVAL = max(
    0.0, float(os.environ.get("CONTENT_HUB_THUMB_EVICT_SCAN_INTERVAL", "60"))
)
_EVICT_SCAN_GUARD = threading.Lock()
_EVICT_LAST_SCAN: dict[tuple[str, int], float] = {}


def mark_thumb_used(cache: Optional[Path]) -> None:
    """서빙 캐시 히트의 '최근 사용' 신호 — mtime 을 지금으로 touch 해, evict(mtime 순 삭제)가
    '안 본 지 오래된 것부터'(LRU)가 되게 한다. 하루 이상 묵은 파일만 touch(쓰기 증폭 방지).
    ★프리워밍 경로에선 부르지 않는다 — 전량 스윕이 touch 하면 '최근 사용' 신호가 무의미해진다.
    실패(잠금·권한)는 무시 — 기존 생성시각 순서로 자연 폴백."""
    if cache is None:
        return
    try:
        if time.time() - cache.stat().st_mtime > _TOUCH_MIN_AGE:
            os.utime(cache)
    except OSError:
        pass


def evict_thumb_cache(
    max_bytes: int = THUMB_CACHE_MAX_BYTES, *, force: bool = False
) -> int:
    """.thumbs 총 용량이 max_bytes 를 넘으면 mtime 오래된 것부터 삭제해 상한 이하로.
    서빙 히트가 mark_thumb_used 로 mtime 을 갱신하므로 사실상 '안 본 지 오래된 것부터'(LRU).
    지워져도 원본에서 즉시 다시 굽는다(무해).
    ★.thumbs(재생성 가능한 리사이즈 캐시)만 대상 — MEDIA_DIR 의 원본·최종 보존본은 안 건드린다.
    쓰는 중(.tmp)이나 .jpg 아닌 파일은 건너뛴다(반쯤 쓰인 파일 삭제 방지). 삭제 개수를 반환."""
    if not THUMB_DIR.exists() or THUMB_DIR.is_symlink():  # 심링크/정션이면 원본 밖을 지울 위험 → 거부
        return 0
    # 한 번의 프리워밍이 여러 경로에서 끝나도 매번 평면 폴더 전체를 stat+정렬하지 않는다.
    # 일일 sweeper는 force=True로 호출해, 마지막 생성 뒤 추가 호출이 없어도 상한을 다시 확인한다.
    scan_key = (str(THUMB_DIR), int(max_bytes))
    now = time.monotonic()
    with _EVICT_SCAN_GUARD:
        last_scan = _EVICT_LAST_SCAN.get(scan_key)
        if (
            not force
            and last_scan is not None
            and now - last_scan < _EVICT_SCAN_INTERVAL
        ):
            return 0
        _EVICT_LAST_SCAN[scan_key] = now
    try:
        entries: list[tuple[float, int, Path]] = []
        total = 0
        for p in THUMB_DIR.iterdir():
            if p.suffix != ".jpg" or not p.is_file():  # .tmp(생성 중)·기타 제외
                continue
            try:
                st = p.stat()
            except OSError:
                continue
            entries.append((st.st_mtime, st.st_size, p))
            total += st.st_size
        if total <= max_bytes:
            return 0
        entries.sort(key=lambda e: e[0])  # 오래된 것(작은 mtime) 먼저
        removed = 0
        for _mtime, size, p in entries:
            if total <= max_bytes:
                break
            try:
                p.unlink()
                total -= size
                removed += 1
            except OSError:
                continue  # 다른 스레드가 방금 지웠거나 잠김 — 건너뜀
        if removed:
            # 상한 발동 가시화 — 이 로그가 자주 보이면 상한(CONTENT_HUB_THUMB_CACHE_MAX_BYTES) 상향 신호.
            print(f"[thumbs] 캐시 상한({max_bytes // (1024 * 1024)}MB) 도달 — 오래 안 본 썸네일 {removed}개 삭제")
        return removed
    except OSError:
        return 0


# 같은 폴더 프리워밍 백그라운드 잡의 단기 반복 큐잉 방지 — 창 포커스 fresh 재조회·/projects 주기
# 프리워밍이 겹치면 트리 전체 stat 순회가 계속 돈다. 새 파일 썸네일은 어차피 요청 시점(ensure_thumb)에
# 즉시 생성되므로, 백그라운드 워밍이 몇 분 늦어도 무해하다.
_PREWARM_RECENT: dict[str, float] = {}
_PREWARM_RECENT_GUARD = threading.Lock()
PREWARM_RECENT_TTL = 300.0


def prewarm_recently(key: str) -> bool:
    """이 key(폴더)로 최근 TTL 내 프리워밍을 걸었으면 True(=스킵). 아니면 지금을 기록하고 False."""
    now = time.monotonic()
    with _PREWARM_RECENT_GUARD:
        last = _PREWARM_RECENT.get(key)
        if last is not None and now - last < PREWARM_RECENT_TTL:
            return True
        _PREWARM_RECENT[key] = now
        return False


def _media_target(rel_or_media_path: str) -> Optional[Path]:
    """'/media/<2>/<sha>.ext' → 안전한 절대경로(경로 이탈 차단). 아니면 None."""
    if not rel_or_media_path.startswith("/media/") or "\\" in rel_or_media_path:
        return None
    return safe_join(MEDIA_DIR, rel_or_media_path[len("/media/"):])


def prewarm_generation_thumbs(
    widths: tuple[int, ...] = THUMB_WIDTHS, throttle: float = 0.0
) -> int:
    """모든 로컬 /media 이미지의 썸네일을 미리 생성(없는 것만). 시작 후 백그라운드 데몬에서 호출.
    → 첫 프로젝트 선택·스크롤에서도 생성 지연 없이 즉시 표시된다. 생성 개수를 반환.
    ★파일 하나당 두 버킷(256/512)을 '함께' 굽는다(인터리브) — 폭별로 전체를 두 번 돌면 용량 상한
    eviction(생성시각 순 삭제)이 먼저 구운 폭 전체를 통째로 밀어내 한 버킷이 항상 콜드가 된다."""
    from ..db import get_connection

    with get_connection() as conn:
        rows = conn.execute(
            "SELECT DISTINCT file_path FROM asset WHERE file_path LIKE '/media/%'"
        ).fetchall()
    made = 0
    for r in rows:
        target = _media_target(r["file_path"] or "")
        if not target:
            continue
        for width in widths:
            if not cache_path(target, width).exists():
                if ensure_thumb(target, width):
                    made += 1
                if throttle:
                    time.sleep(throttle)
    if made:
        evict_thumb_cache()  # 새로 구운 만큼 상한 점검(초과 시 오래된 것부터 삭제)
    return made


async def prewarm_remote_thumbs(
    urls: list[str], widths: tuple[int, ...] = THUMB_WIDTHS
) -> int:
    """원격 미디어 URL 목록을 로컬 캐시 + 썸네일로 미리 구워둔다(team 목록 응답 직후 백그라운드).

    공유받은(team) 항목은 미디어가 원격 URL(Higgsfield cloudfront)이라, 첫 표시 때마다 보는 PC가
    원본을 받아 리사이즈한다 → 첫 스크롤이 느리다. 목록을 받자마자 뒤에서 미리 받아 캐시해 두면
    실제 표시 시점엔 디스크 캐시 히트로 즉시 뜬다. 이미 캐시된 건 즉시 통과(멱등) → 매 스크롤
    재호출이 싸다. 동시 다운로드는 cloudfront 부하·메모리 스파이크 방지로 제한한다. 생성 수 반환."""
    from . import media_cache  # 지연 import(순환 방지)

    made = 0

    async def _one(url: str) -> None:
        nonlocal made
        async with _REMOTE_PREWARM_SEM:
            # 썸네일 최적화용 원본은 영구 MEDIA와 분리된 bounded LRU 캐시에 둔다. 목록만 본 원격
            # 이미지가 실제 작업 원본처럼 무기한 쌓여 디스크를 채우지 않게 한다.
            rel = await media_cache.cache_thumb_source(url)  # 이미 캐시면 즉시 반환
            if not rel:
                return
            target = _media_target(rel)
            if not target:
                return
            for width in widths:  # 그리드가 쓰는 두 버킷 모두 — 어느 배율에서도 캐시 히트
                existed = cache_path(target, width).exists()  # 이미 있으면 새로 만든 게 아님
                cache = await asyncio.to_thread(ensure_thumb, target, width)  # PIL=동기 → 스레드로
                if cache and not existed:  # 실제로 새로 구운 경우만 카운트(멱등 재호출로 매번 evict 도는 것 방지)
                    made += 1

    # URL마다 대기 Task를 만들면 100명×페이지 2,000건에서 실행은 4개뿐이어도 Task가 20만 개
    # 생길 수 있다. 고정 수 worker가 iterator를 나눠 소비해 실제 실행과 대기 객체를 모두 제한한다.
    unique_urls = list(dict.fromkeys(urls))
    url_iter = iter(unique_urls)

    async def _worker() -> None:
        for url in url_iter:
            try:
                await _one(url)
            except Exception:  # noqa: BLE001 — 한 URL 실패가 같은 페이지의 나머지 워밍을 막지 않게 격리
                continue

    worker_count = min(REMOTE_THUMB_CONCURRENCY, len(unique_urls))
    if worker_count:
        await asyncio.gather(*(_worker() for _ in range(worker_count)))
    if made:
        await asyncio.to_thread(evict_thumb_cache)  # 새로 구운 만큼 상한 점검(디스크 IO → 스레드)
    return made


def prewarm_asset_thumbs(
    files: list[tuple[Path, str]], widths: tuple[int, ...] = THUMB_WIDTHS
) -> int:
    """로컬 Assets 미디어의 썸네일/포스터를 미리 구워둔다(폴더 트리 로드 직후 백그라운드).
    이미지=ensure_thumb, 비디오=ensure_video_poster. 이미 캐시면 즉시 통과(멱등)라 재호출이 싸다 →
    스크롤 시점엔 디스크 캐시 히트로 즉시 뜬다. files=[(디스크경로, 'image'|'video')].
    ★파일 하나당 두 버킷(256/512)을 '함께' 굽는다(인터리브) — eviction 이 생성시각 순이라
    폭별 일괄 굽기는 먼저 구운 폭부터 통째로 밀려난다. 비디오 ffmpeg 는 _FFMPEG_SEM 이 제한."""
    from concurrent.futures import ThreadPoolExecutor

    made = 0

    def _one(item: tuple[Path, str]) -> int:
        path, mt = item
        new = 0
        for width in widths:
            try:
                existed = _is_complete_file(cache_path(path, width)) if path.is_file() else False
            except OSError:
                existed = False
            if mt == "image":
                result = ensure_thumb(path, width)
            elif mt == "video":
                result = ensure_video_poster(path, width)
            else:
                result = None
            if result and not existed:  # 새로 구운 것만 카운트
                new += 1
        return new

    with ThreadPoolExecutor(max_workers=4) as ex:
        for new in ex.map(_one, files):
            made += new
    if made:
        evict_thumb_cache()  # 새로 구운 만큼 상한 점검
    return made

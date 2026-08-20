"""오래 묵은 임시파일 청소기 (주기 실행).

크래시·중단이 남긴 임시 잔재는 만든 주체가 사라져 아무도 안 지웠다:
  · media_cache `.thumb-sources` 의 `.part`(다운로드 중단) — LRU 총량 계산이 `.part` 를
    건너뛰어 2GB 상한을 우회해 무한 증가했다.
  · thumbs `.thumbs` 의 `*.tmp`(생성 중단) — eviction 이 `.jpg` 외엔 안 지웠다.
  · ComfyUI input `mvhub/` 업로드 원본 — 실행이 끝나도 삭제 주체가 없었다(잡별 유일
    이름이라 겹치지도 않아 영구 누적).
  · %TEMP% 의 `mvhub-export-*.db`(DB 내보내기)·`mvhub-update-bootstrap-*.bat` — 클라이언트
    중단 시 BackgroundTask 가 못 돌아 잔류.
  · %TEMP% 의 `mvhub-comfy-input-*.part`·`mvhub-comfy-converted-*.mp4` — Comfy 백그라운드
    작업 전에 프로세스가 비정상 종료되면 정상 finally가 실행되지 못해 잔류.

전부 '다시 만들 수 있는 것'만, 그리고 우리가 만든 이름 패턴만 지운다. 진행 중 파일을
지우지 않도록 24시간 이상 묵은 것만 대상(가장 긴 정상 작업도 시간 단위를 넘지 않는다).
겸사겸사 썸네일 캐시 eviction 도 여기서 주기 실행한다 — 예전엔 프리워밍 경로에서만
돌아서 "/thumb 온디맨드만 쓰는 상태"에선 상한이 영영 안 지켜졌다.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import re
import tempfile
import time
from pathlib import Path
from typing import Callable, Optional

from ..config import MEDIA_DIR
from .operational_logging import log_event

_log = logging.getLogger("mvhub.sweeper")

_SWEEP_INTERVAL_SECONDS = 24 * 3600.0
_STARTUP_DELAY_SECONDS = 300.0  # 부팅 직후(마이그레이션·프리워밍)와 IO 경쟁하지 않게
_MIN_AGE_SECONDS = 24 * 3600.0


def _comfy_input_mvhub_dir() -> Optional[Path]:
    """ComfyUI 경로형 입력이 쓰는 mvhub 폴더(설정에서). 미설정이면 None."""
    try:
        from .. import repo

        raw = (repo.get_setting("comfy_input_dir") or "").strip()
        return (Path(raw) / "mvhub") if raw else None
    except Exception:  # noqa: BLE001 — 설정 조회 실패는 청소 생략일 뿐
        return None


# 우리가 만든 comfy 업로드 이름만(잡uuid 12자리-순번-원본명) — 사용자가 mvhub 폴더에
# 직접 넣어 둔 파일이나 접두 없는 구버전 업로드는 절대 지우지 않는다(코덱스 리뷰 P1).
_COMFY_UPLOAD_RE = re.compile(r"^[0-9a-f]{12}-\d+-")


def _sweep_dir(
    directory: Optional[Path],
    patterns: tuple[str, ...],
    cutoff: float,
    *,
    recursive: bool = True,
    name_filter: Optional[Callable[[str], bool]] = None,
) -> int:
    if not directory or not directory.is_dir():
        return 0
    removed = 0
    for pattern in patterns:
        matches = directory.rglob(pattern) if recursive else directory.glob(pattern)
        for p in matches:
            if name_filter and not name_filter(p.name):
                continue
            with contextlib.suppress(OSError):  # 사용 중(잠김)이면 다음 주기에
                if p.is_file() and p.stat().st_mtime < cutoff:
                    p.unlink()
                    removed += 1
    return removed


def sweep_once(now: Optional[float] = None) -> dict[str, int]:
    """묵은 임시파일 1회 청소 + 캐시 eviction. 삭제 수를 항목별로 반환(관측용)."""
    cutoff = (now if now is not None else time.time()) - _MIN_AGE_SECONDS
    result = {
        "thumb_source_parts": _sweep_dir(MEDIA_DIR / ".thumb-sources", ("*.part",), cutoff),
        "thumb_tmps": _sweep_dir(MEDIA_DIR / ".thumbs", ("*.tmp",), cutoff),
        # 앱 생성 파일만(접두 검사), 하위 폴더는 안 만드니 비재귀.
        "comfy_inputs": _sweep_dir(
            _comfy_input_mvhub_dir(), ("*",), cutoff,
            recursive=False, name_filter=lambda n: bool(_COMFY_UPLOAD_RE.match(n)),
        ),
        # %TEMP% 는 루트에만 만들므로 비재귀 — 다른 프로그램 하위 폴더를 훑지 않는다.
        "temp_exports": _sweep_dir(
            Path(tempfile.gettempdir()),
            (
                "mvhub-export-*.db",
                "mvhub-import-*.db",
                "mvhub-update-bootstrap-*.bat",
                "mvhub-update-*.ps1",
            ),
            cutoff,
            recursive=False,
        ),
        "comfy_staging": _sweep_dir(
            Path(tempfile.gettempdir()),
            ("mvhub-comfy-input-*.part", "mvhub-comfy-converted-*.mp4"),
            cutoff,
            recursive=False,
        ),
    }
    try:
        from . import media_cache, thumbs

        result["thumb_evicted"] = thumbs.evict_thumb_cache(force=True)
        result["thumb_source_evicted"] = media_cache.evict_thumb_source_cache()
    except Exception:  # noqa: BLE001 — eviction 실패가 청소 자체를 막지 않게
        pass
    return result


class PeriodicSweeper:
    """PeriodicBackup 과 동일한 수명주기 패턴의 백그라운드 청소기."""

    def __init__(self, interval: float = _SWEEP_INTERVAL_SECONDS) -> None:
        self._interval = interval
        self._task: Optional[asyncio.Task] = None

    def start(self) -> None:
        if self._interval <= 0:
            return
        if self._task is None or self._task.done():
            self._task = asyncio.create_task(self._run(), name="temp-sweeper")

    async def stop(self) -> None:
        if self._task:
            self._task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._task
            self._task = None

    async def _run(self) -> None:
        await asyncio.sleep(_STARTUP_DELAY_SECONDS)
        while True:
            try:
                stats = await asyncio.to_thread(sweep_once)
                if any(stats.values()):
                    log_event(_log, "temp_sweep_completed", **stats)
            except asyncio.CancelledError:
                raise
            except Exception:  # noqa: BLE001 — 청소 실패가 워커를 죽이지 않게
                log_event(_log, "temp_sweep_failed", level=logging.WARNING, exc_info=True)
            await asyncio.sleep(self._interval)


periodic_sweeper = PeriodicSweeper()

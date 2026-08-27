"""영상 포스터 재조정 — MCP 이력 보충이 '입력 이미지'를 영상 포스터로 저장한 행을 로컬 허브 기동 때 고친다.

배경(2026-08-27 실측): 힉스필드 MCP show_generations 의 영상 항목 results.thumbnailUrl 은 첫 입력 이미지
(params.medias[0])와 같다. 기동 시 이력 보충(history_autofill)이 이를 asset.thumbnail_path 로 저장해 라이브러리·
캔버스 팝업에 레퍼런스 시트가 영상 포스터로 떴다. CLI generate get 은 진짜 포스터(…_thumbnail.webp)를 준다.
주기 동기화는 최신 100건만 다시 쓰므로 창 밖 옛 잡은 스스로 안 고쳐진다 → 기동 후 1회 이 재조정이 고친다.

규칙:
· 로컬 허브 전용 — history_autofill 과 같은 게이트(공유 서버 AUTH on·pairing 없음, 복원 드릴에선 실행 안 함).
  CLI 로그인 이메일이 로컬 계정 키와 같아야 한다. 계정 DB 스코프는 워커 스레드에서 캡처해 override 한다.
  활성 계정 키가 없는 레거시 단일 DB 는 건너뛴다(계정 일치를 확인할 수 없음).
· 후보 = 포스터가 있는 영상 asset 중 thumbnail_path 가 그 잡의 입력 URL(params medias/input_images, 레퍼런스)
  과 같은 것(same_media_url: 정확 일치 또는 host+path 일치).
· 후보마다 CLI generate get 1회 → parse_job → 검증 전부 통과해야 쓴다: 반환 잡 id == 후보 job_id · asset 있음 ·
  영상 · 결과 URL 이 현재 행의 원본(source_url or file_path)과 동일. 진짜 포스터면 교체, 포스터가 없거나 또
  입력이면 NULL(프론트가 첫 프레임으로 폴백), 확인불가(None)·검증 실패면 무변경.
· 쓰기는 CAS(지금 값이 후보 조회 때 값일 때만) + to_thread_non_abandon(종료 중 반쪽 쓰기 금지). 시간 예산·
  개별 timeout·순차 — 예산이 남지 않으면 나머지는 다음 기동에서(후보 조회가 다시 잡는다).
"""

from __future__ import annotations

import asyncio
import logging
import os
import time
from typing import Any, Optional

from .. import active_account, repo
from ..config import AUTH_ENABLED, EXTERNAL_RECOVERY_ENABLED, LOCAL_AGENT_PAIR_SECRET
from ..emailnorm import norm_email
from ..ws import manager
from . import cli_bridge
from .async_tools import to_thread_non_abandon
from .media_types import same_media_url

_logger = logging.getLogger("mvhub.thumbnail_repair")

# 허브가 먼저 응답하도록 기동 뒤 잠시 기다린다. 예산을 넘긴 후보는 다음 기동에서 이어서 처리한다.
REPAIR_STARTUP_DELAY_SECONDS = float(os.environ.get("CONTENT_HUB_THUMB_REPAIR_DELAY", "20"))
REPAIR_TIME_BUDGET_SECONDS = float(os.environ.get("CONTENT_HUB_THUMB_REPAIR_BUDGET", "120"))
REPAIR_CALL_TIMEOUT_SECONDS = 15.0


def _forbidden() -> bool:
    return (AUTH_ENABLED and not LOCAL_AGENT_PAIR_SECRET) or not EXTERNAL_RECOVERY_ENABLED


def _capture_scope() -> Optional[str]:
    """현재 계정 DB 키를 전환 락 아래 캡처한다(느린 작업은 락 밖에서)."""
    with active_account.transition_lock:
        return active_account.account_key()


def is_input_thumbnail(thumbnail: Optional[str], input_urls: list[str]) -> bool:
    return any(same_media_url(thumbnail, url) for url in input_urls)


def find_candidates(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """repo 원자료 → 포스터가 입력 이미지인 영상 asset 만(asset 중복 제거, 조회 순서 유지)."""
    seen: set[str] = set()
    out: list[dict[str, Any]] = []
    for row in rows:
        asset_id = row.get("asset_id")
        if not asset_id or asset_id in seen:
            continue
        if is_input_thumbnail(row.get("thumbnail_path"), list(row.get("input_urls") or [])):
            seen.add(asset_id)
            out.append(row)
    return out


def decide(candidate: dict[str, Any], parsed: Optional[dict[str, Any]]) -> tuple[str, Optional[str]]:
    """CLI 응답으로 무엇을 할지 — ("replace", 포스터URL) | ("clear", None) | ("skip", None).

    skip = 무변경: 응답 없음/파싱 실패, 잡 id 불일치(다른 잡 응답), asset 없음(미완료·실패), 영상 아님,
    결과 URL 이 현재 행과 다름(다른 결과물). clear = 진짜 포스터가 없거나 또 입력 이미지 → NULL."""
    if not parsed:
        return ("skip", None)
    generation = parsed.get("generation") or {}
    if str(generation.get("id") or "") != str(candidate.get("job_id") or ""):
        return ("skip", None)
    asset = parsed.get("asset")
    if not isinstance(asset, dict) or asset.get("type") != "video":
        return ("skip", None)
    current_key = candidate.get("source_url") or candidate.get("file_path")
    if not current_key or asset.get("file_path") != current_key:
        return ("skip", None)
    poster = asset.get("thumbnail_url")
    if (
        isinstance(poster, str)
        and poster.startswith(("http://", "https://"))
        and not is_input_thumbnail(poster, list(candidate.get("input_urls") or []))
    ):
        return ("replace", poster)
    return ("clear", None)


async def repair_once() -> dict[str, int]:
    counts = {"candidates": 0, "replaced": 0, "cleared": 0, "skipped": 0, "stale": 0, "deferred": 0}
    if _forbidden():
        return counts
    scope = await asyncio.to_thread(_capture_scope)
    if not scope:
        _logger.info("thumbnail_repair_skipped reason=legacy_single_db")
        return counts
    override = active_account.set_override(scope)
    try:
        try:
            status = await cli_bridge.get_account_status(timeout=10.0)
        except Exception as exc:  # noqa: BLE001 — CLI 불가는 다음 기동 기회로
            _logger.warning(
                "thumbnail_repair_skipped reason=cli_unavailable error_type=%s", type(exc).__name__
            )
            return counts
        email = norm_email((status or {}).get("email"))
        if not (status or {}).get("connected") or not email:
            _logger.warning("thumbnail_repair_skipped reason=cli_not_logged_in")
            return counts
        if email != norm_email(scope):
            _logger.warning("thumbnail_repair_skipped reason=account_mismatch")
            return counts
        rows = await asyncio.to_thread(repo.list_video_assets_with_input_thumbnail)
        candidates = find_candidates(rows)
        counts["candidates"] = len(candidates)
        if not candidates:
            return counts
        started = time.monotonic()
        try:
            for index, candidate in enumerate(candidates):
                remaining = REPAIR_TIME_BUDGET_SECONDS - (time.monotonic() - started)
                if remaining <= 1.0:
                    counts["deferred"] = len(candidates) - index
                    break
                try:
                    raw = await cli_bridge.get_job_raw(
                        candidate["job_id"], timeout=min(REPAIR_CALL_TIMEOUT_SECONDS, remaining)
                    )
                except asyncio.CancelledError:
                    raise
                except Exception as exc:  # noqa: BLE001 — 한 후보의 예상 밖 오류가 나머지를 막지 않게
                    _logger.warning(
                        "thumbnail_repair_candidate_failed error_type=%s", type(exc).__name__
                    )
                    counts["skipped"] += 1
                    continue
                parsed: Optional[dict[str, Any]] = None
                if isinstance(raw, dict):
                    try:
                        parsed = cli_bridge.parse_job(raw)
                    except Exception:  # noqa: BLE001 — 이상 응답은 무변경
                        parsed = None
                action, value = decide(candidate, parsed)
                if action == "skip":
                    counts["skipped"] += 1
                    continue
                changed = await to_thread_non_abandon(
                    repo.set_asset_thumbnail_if_current,
                    candidate["asset_id"],
                    candidate["thumbnail_path"],
                    value,
                )
                if not changed:
                    counts["stale"] += 1
                    continue
                counts["replaced" if action == "replace" else "cleared"] += 1
        finally:
            # 일부만 고치고 예외·취소로 빠져도 이미 바뀐 행은 브라우저에 알린다(부분 성공 후 신호 누락 방지).
            if counts["replaced"] or counts["cleared"]:
                await manager.broadcast_all({"type": "synced"})
        return counts
    finally:
        active_account.reset_override(override)


async def startup_thumbnail_repair() -> dict[str, int]:
    """로컬 허브 기동 후 한 번. 예외는 여기서 삼키고 타입만 기록한다(백그라운드 task 예외 유실 방지)."""
    try:
        if REPAIR_STARTUP_DELAY_SECONDS > 0:
            await asyncio.sleep(REPAIR_STARTUP_DELAY_SECONDS)
        counts = await repair_once()
        if counts.get("candidates"):
            _logger.info(
                "thumbnail_repair_done %s", " ".join(f"{k}={v}" for k, v in counts.items())
            )
        return counts
    except asyncio.CancelledError:
        raise
    except Exception as exc:  # noqa: BLE001
        _logger.warning("thumbnail_repair_failed error_type=%s", type(exc).__name__)
        return {}

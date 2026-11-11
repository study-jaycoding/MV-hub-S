"""DaVinci Resolve Media Pool 선택을 읽는 장기 실행 자식 프로세스.

fusionscript는 ABI 불일치가 부모 서버까지 죽일 수 있어 이 프로세스 안에서만 불러온다.
선택이 실제로 바뀔 때만 stdout JSONL 한 줄을 내보내고, UI나 별도 창은 만들지 않는다.
"""

from __future__ import annotations

import json
import os
import sys
import threading
import time
from typing import Any

from .resolve_bridge import (
    MVHUB_METADATA_KEY,
    _clip_file_path,
    _connect_resolve,
    parse_mvhub_clip_metadata,
)


RESULT_PREFIX = "MVHUB_RESOLVE_SELECTION="
MAX_SELECTIONS = 200
MAX_LINE_BYTES = 900 * 1024
POLL_SECONDS = max(
    0.05, float(os.environ.get("CONTENT_HUB_RESOLVE_SELECTION_POLL_SECONDS", "0.05"))
)


def _media_id(clip: Any) -> str:
    getter = getattr(clip, "GetMediaId", None)
    if not callable(getter):
        return ""
    try:
        return str(getter() or "")
    except Exception:  # noqa: BLE001 - Resolve 버전별 미지원은 경로 식별로 폴백한다.
        return ""


def _metadata(clip: Any) -> dict[str, str] | None:
    getter = getattr(clip, "GetThirdPartyMetadata", None)
    if not callable(getter):
        return None
    try:
        return parse_mvhub_clip_metadata(getter(MVHUB_METADATA_KEY))
    except Exception:  # noqa: BLE001 - 선택 감시는 보조 기능이라 메타데이터 오류를 격리한다.
        return None


def selected_snapshot(
    resolve: Any, previous: tuple[str, ...] | None = None
) -> tuple[tuple[str, ...], dict[str, Any]]:
    """선택 식별자는 매번 읽되, 변경된 선택만 상세 정보를 조회한다."""
    manager = resolve.GetProjectManager()
    if not manager:
        return ("no_manager",), {
            "selected_count": 0,
            "connection_state": "no_manager",
        }
    project = manager.GetCurrentProject()
    if not project:
        return ("no_project",), {
            "selected_count": 0,
            "connection_state": "no_project",
        }
    media_pool = project.GetMediaPool()
    clips = list(media_pool.GetSelectedClips() or []) if media_pool else []
    project_uid_getter = getattr(project, "GetUniqueId", None)
    try:
        resolve_project_id = (
            str(project_uid_getter() or "") if callable(project_uid_getter) else ""
        )
    except Exception:  # noqa: BLE001
        resolve_project_id = ""
    selected_count = len(clips)
    clips = clips[:MAX_SELECTIONS]
    media_ids = [_media_id(clip) for clip in clips]
    fallback_paths = [
        _clip_file_path(clip) if not media_id else ""
        for clip, media_id in zip(clips, media_ids)
    ]
    identities = tuple(sorted(
        media_id or path for media_id, path in zip(media_ids, fallback_paths)
    ))
    fingerprint = (resolve_project_id, str(selected_count), *identities)
    if fingerprint == previous:
        return fingerprint, {"selected_count": selected_count}
    selections = []
    for clip, media_id, fallback_path in zip(clips, media_ids, fallback_paths):
        item: dict[str, Any] = {
            "media_id": media_id,
            "file_path": _clip_file_path(clip) if media_id else fallback_path,
            "resolve_project_id": resolve_project_id,
        }
        if metadata := _metadata(clip):
            item.update(metadata)
        selections.append(item)
    if selected_count == 1:
        # 예전 단일 선택 포맷도 그대로 읽을 수 있게 유지한다.
        payload = {"selected_count": 1, **selections[0]}
    else:
        payload = {"selected_count": selected_count, "selections": selections}
        if selected_count > MAX_SELECTIONS:
            payload["truncated"] = True
    return fingerprint, payload


def serialize_selection(payload: dict[str, Any]) -> str:
    """긴 UNC/한글 경로도 로컬 파이프 상한을 넘지 않게 부분 선택으로 표시한다."""
    bounded = dict(payload)
    while True:
        line = RESULT_PREFIX + json.dumps(bounded, ensure_ascii=True, separators=(",", ":"))
        if len(line) <= MAX_LINE_BYTES:
            return line
        items = bounded.get("selections")
        if isinstance(items, list) and items:
            bounded["selections"] = items[: len(items) // 2]
            bounded["truncated"] = True
        else:
            bounded = {"selected_count": payload.get("selected_count", 0), "selections": [], "truncated": True}


def main() -> int:
    try:
        resolve = _connect_resolve()
    except Exception:  # noqa: BLE001 - 부모가 백오프 후 새 호환 자식을 띄운다.
        return 2
    previous: tuple[str, ...] | None = None
    no_manager_count = 0
    while True:
        try:
            fingerprint, payload = selected_snapshot(resolve, previous=previous)
        except Exception:  # noqa: BLE001 - 연결이 끊기면 부모가 새로 probe한다.
            return 3
        if fingerprint != previous:
            print(
                serialize_selection(payload),
                flush=True,
            )
            previous = fingerprint
        if payload.get("connection_state") == "no_manager":
            no_manager_count += 1
            if no_manager_count >= 20:
                return 4
        else:
            no_manager_count = 0
        # 연결/프로젝트가 없을 때는 기존 0.5초 대기와 약 10초 재연결 허용을 보존한다.
        time.sleep(max(0.5, POLL_SECONDS) if payload.get("connection_state") else POLL_SECONDS)


def _exit_when_stdin_closes(stream: Any = None, leave: Any = os._exit) -> threading.Thread | None:
    """부모(허브)가 쥔 stdin 파이프가 닫히면 바로 끝낸다 — 허브가 강제 종료돼 terminate 를 못 보내도 고아로 남아 Resolve 를 계속 읽지 않게.

    선택이 안 바뀌면 stdout 에 쓰지 않아 부모가 죽은 것을 달리 알 길이 없다. 읽기 전용 자식이라 os._exit 로 끊는다(지금도 부모가 terminate 로 끊는다).
    """
    source = stream if stream is not None else getattr(sys.stdin, "buffer", None)
    if source is None:
        return None  # stdin 없이 띄운 실행 — 닫힘 신호가 없으니 감시하지 않는다(바로 끝내면 작업자가 아예 못 돈다)

    def watch() -> None:
        try:
            while source.read(4096):
                pass
        except (OSError, ValueError):
            pass
        leave(0)

    thread = threading.Thread(target=watch, name="parent-stdin-watch", daemon=True)
    thread.start()
    return thread


if __name__ == "__main__":
    _exit_when_stdin_closes()  # Resolve 연결보다 먼저 — 연결이 오래 걸리는 사이 부모가 죽어도 끝난다
    raise SystemExit(main())

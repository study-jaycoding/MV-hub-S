"""어셋 폴더 실시간 감시 → WebSocket 변경 알림 (로컬 허브 전용).

watchdog Observer 로 '트리를 조회한(=지금 보고 있는) 프로젝트 폴더'만 감시한다(요청 시 lazy 등록,
전체 마운트 상시 스캔은 안 함). 파일이 추가·변경·삭제되면 미디어 파일만 필터하고, 저장 중 연속 이벤트를
짧게 디바운스한 뒤 ① 백엔드 트리 캐시를 무효화하고 ② 이벤트 루프로
manager.broadcast_all({"type": "assets_changed", "projects": [...]}) 를 보낸다.
→ 프론트가 새로고침·포커스 없이 어셋 패널·캔버스를 자동 최신화한다(Phase 2 실시간).

watchdog 미설치 환경에서도 앱이 뜨도록 import 를 방어한다(그 경우 실시간 감시만 비활성 —
Phase 1 의 '창 포커스 시 갱신'은 그대로 동작).

★로컬 허브 전용: 공유 서버(AUTH on)에서는 LAN 사용자가 어셋 파일 I/O 를 못 하므로(=require_local_assets)
감시할 이유가 없다. main.lifespan 이 `if not AUTH_ENABLED:` 로 start 를 게이트한다.
"""

from __future__ import annotations

import asyncio
import threading
from pathlib import Path
from typing import Callable, Optional

from . import asset_tree
from .media_types import AUDIO_EXTENSIONS, IMAGE_EXTENSIONS, VIDEO_EXTENSIONS

try:
    from watchdog.events import FileSystemEventHandler
    from watchdog.observers import Observer

    _HAS_WATCHDOG = True
except ImportError:  # watchdog 미설치 — 실시간 감시 비활성(포커스 갱신으로 폴백)
    _HAS_WATCHDOG = False
    FileSystemEventHandler = object  # type: ignore[assignment,misc]

_MEDIA_EXT = set(IMAGE_EXTENSIONS) | set(VIDEO_EXTENSIONS) | set(AUDIO_EXTENSIONS)
_DEBOUNCE = 0.6  # 초 — 저장 중 쏟아지는 연속 이벤트를 한 번의 알림으로 묶는다


def _is_media(path: str) -> bool:
    return Path(path).suffix.lower() in _MEDIA_EXT


def _is_temp(path: str) -> bool:
    """저장 중 임시파일·부분 다운로드는 무시(완성 파일이 곧 별도 이벤트로 온다)."""
    name = Path(path).name.lower()
    return (
        name.startswith(".")
        or name.endswith(".tmp")
        or name.endswith(".part")
        or name.endswith(".crdownload")
    )


def _under_render(dir_key: str, path: str) -> bool:
    """감시 루트(dir_key) 기준 최상위가 'render' 폴더인가 — 자동 PM 프로젝트에서 트리가 숨기는 폴더.
    트리에 안 보이는 render 산출물 대량 생성이 assets_changed 를 헛되이 쏘지 않도록 필터에 쓴다."""
    try:
        rel = Path(path).relative_to(dir_key)
    except ValueError:
        return False
    return bool(rel.parts) and rel.parts[0] == "render"


def _log_future_exception(fut) -> None:
    try:
        exc = fut.exception()
    except Exception:  # noqa: BLE001 — cancelled 등
        return
    if exc:
        print(f"[asset-watcher] 브로드캐스트 예외: {exc}")


class _AssetChangeHandler(FileSystemEventHandler):
    def __init__(self, on_change, dir_key: str, hide_render_for: Callable[[str], bool]) -> None:
        self._on_change = on_change
        self._dir_key = dir_key
        # ★hide_render 를 고정값이 아니라 조회 콜백으로 받는다 — 같은 폴더가 여러 alias 로 등록될 때
        #   'alias 중 하나라도 render 를 보고 싶어하면 통과' 를 이벤트 시점에 동적으로 판정하기 위함.
        self._hide_render_for = hide_render_for

    def on_any_event(self, event) -> None:  # created/modified/moved/deleted 공통
        if getattr(event, "is_directory", False):
            return
        src = getattr(event, "src_path", "") or ""
        dest = getattr(event, "dest_path", "") or ""  # moved 는 dest 로 온다
        cand = dest or src
        if not (_is_media(cand) or _is_media(src)):
            return  # 미디어 파일이 아니면(설정·임시파일 등) 무시
        if _is_temp(cand):
            return
        if self._hide_render_for(self._dir_key) and (
            _under_render(self._dir_key, cand) or _under_render(self._dir_key, src)
        ):
            return  # 숨김 render 폴더 변경은 트리에 안 보이므로 알리지 않음
        self._on_change(self._dir_key)


class _Watcher:
    def __init__(self) -> None:
        self._observer = None  # Observer | None
        self._loop: Optional[asyncio.AbstractEventLoop] = None
        self._watches: dict[str, object] = {}  # dir_key -> watch handle(중복 등록 방지)
        self._dir_projects: dict[str, set[str]] = {}  # dir_key -> {project 이름들}(같은 폴더 다중 이름)
        # dir_key -> {project: hide_render} — alias 별 render 숨김 의사. 하나라도 False 면 render 알림을 통과시킨다.
        self._dir_hide_by_project: dict[str, dict[str, bool]] = {}
        self._lock = threading.Lock()
        self._pending: set[str] = set()  # 디바운스 윈도우에 모인 변경 폴더(dir_key)
        self._timer: Optional[threading.Timer] = None

    def start(self, loop: asyncio.AbstractEventLoop) -> None:
        if not _HAS_WATCHDOG:
            print(
                "[asset-watcher] watchdog 미설치 — 실시간 감시 비활성(포커스 갱신으로 동작). "
                "pip install watchdog 로 활성화"
            )
            return
        self._loop = loop
        self._observer = Observer()
        self._observer.daemon = True
        self._observer.start()
        print("[asset-watcher] 어셋 실시간 감시 시작")

    def stop(self) -> None:
        obs = self._observer
        self._observer = None
        if obs:
            try:
                obs.stop()
                obs.join(timeout=5)
            except Exception:  # noqa: BLE001 — 종료 정리 실패가 shutdown 을 막지 않게
                pass
        with self._lock:
            self._watches.clear()
            self._dir_projects.clear()
            self._dir_hide_by_project.clear()
            if self._timer:
                self._timer.cancel()
                self._timer = None

    def watch(self, proj_dir: Path, project: str, hide_render: bool = False) -> None:
        """이 프로젝트 폴더를 감시 등록(이미 감시 중이면 이름만 추가). tree 조회 시점에 호출된다.
        같은 실제 폴더가 여러 project 이름으로 열릴 수 있으므로 dir_key→이름 집합으로 관리한다."""
        if not self._observer:
            return  # watchdog 없음 or 서버 모드(start 안 함)
        key = str(proj_dir)
        with self._lock:
            self._dir_projects.setdefault(key, set()).add(project)
            # 이 alias 의 render 숨김 의사를 기록(같은 project 재등록 시 최신값으로 갱신).
            self._dir_hide_by_project.setdefault(key, {})[project] = hide_render
            if key in self._watches:
                return  # 이미 감시 중 — 위 맵만 갱신하면 핸들러가 동적으로 최신 판정을 읽는다
            if not proj_dir.is_dir():
                return
            try:
                handle = self._observer.schedule(
                    _AssetChangeHandler(self._on_change, key, self._hide_render_for), key, recursive=True
                )
            except Exception as e:  # noqa: BLE001 — 감시 등록 실패는 무해(포커스 갱신 폴백)
                print(f"[asset-watcher] 감시 등록 실패({project}): {e}")
                return
            self._watches[key] = handle

    def _hide_render_for(self, dir_key: str) -> bool:
        """이 폴더의 render 변경을 숨길지 — 등록된 모든 alias 가 hide_render=True 일 때만 숨긴다.
        하나라도 render 를 보고 싶어하면(False) 알림을 통과시킨다. (감시 스레드에서 호출 → 락 짧게)"""
        with self._lock:
            by_project = self._dir_hide_by_project.get(dir_key)
            return bool(by_project) and all(by_project.values())

    def _start_timer_locked(self) -> None:
        # ★_lock 을 잡은 상태에서만 호출. 새 타이머로 교체(직전 타이머는 곧 종료됨).
        self._timer = threading.Timer(_DEBOUNCE, self._flush)
        self._timer.daemon = True
        self._timer.start()

    def _on_change(self, dir_key: str) -> None:
        # ★감시 스레드에서 호출됨 — 디바운스 후 _flush 로 넘긴다.
        with self._lock:
            self._pending.add(dir_key)
            if self._timer and self._timer.is_alive():
                return  # 이미 예약됨 → 위 set 에 합쳐졌다(_flush 가 재예약으로 마저 처리)
            self._start_timer_locked()

    def _flush(self) -> None:
        with self._lock:
            dirs = list(self._pending)
            self._pending.clear()
            projects = sorted({p for d in dirs for p in self._dir_projects.get(d, ())})
            loop = self._loop
        if dirs and loop is not None:
            # ① 백엔드 트리 캐시 무효화 — 재조회가 최신을 보게.
            for directory in dirs:
                asset_tree.invalidate_project_tree(Path(directory))
            # ② 이벤트 루프로 넘겨 WS 브로드캐스트(감시 스레드 → 루프 스레드 브리지).
            if projects:
                from ..ws import manager

                try:
                    fut = asyncio.run_coroutine_threadsafe(
                        manager.broadcast_all(
                            {"type": "assets_changed", "projects": projects}
                        ),
                        loop,
                    )
                    fut.add_done_callback(_log_future_exception)
                except Exception as e:  # noqa: BLE001 — 알림 실패가 감시를 멈추지 않게
                    print(f"[asset-watcher] 알림 전송 실패: {e}")
        # ★경합 유실 방지 — flush 도는 동안 새로 쌓인 pending 이 있으면 다시 예약한다.
        # (디바운스 윈도우 종료~flush 사이에 온 이벤트가 다음 이벤트까지 묻히던 문제 방지.)
        with self._lock:
            if self._pending:
                self._start_timer_locked()


_watcher = _Watcher()


def start(loop: asyncio.AbstractEventLoop) -> None:
    _watcher.start(loop)


def stop() -> None:
    _watcher.stop()


def watch(proj_dir: Path, project: str, hide_render: bool = False) -> None:
    _watcher.watch(proj_dir, project, hide_render)
